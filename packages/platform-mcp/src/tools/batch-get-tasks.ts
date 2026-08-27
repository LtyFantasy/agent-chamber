/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-experience-topic-board.md §5 Batch E1 ⑧
 *   - 补充: 看板任务 fdc1851b（Batch F：紧凑序列化）
 *   - 补充: plan forge-jubilee-robin（WS-C2' C3：slim 默认投影，descriptionSnippet 复用 truncateField）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { PlatformApiClient } from '../platform-client';
import { SNIPPET_MAX_CHARS, truncateField } from './project';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 宽松 UUID v4 形状校验（只检格式，不做 validated UUID） */
function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * 分批执行 Promise（手写并发上限）
 */
async function batchWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        const value = await fn(items[idx], idx);
        results[idx] = { status: 'fulfilled', value };
      } catch (err: unknown) {
        results[idx] = {
          status: 'rejected',
          reason: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

interface TaskItem {
  id: string;
  ok: boolean;
  task?: Record<string, unknown>;
  error?: { status?: number; code?: number | string; message: string };
}

/** slim 投影保留的字段白名单（默认形状，剔除 description 全文等大字段） */
const TASK_SLIM_KEPT_FIELDS = [
  'id',
  'title',
  'status',
  'priority',
  'labels',
  'boardId',
  'listId',
  'assigneeName',
  'assigneeDeletedAt',
  'dueDate',
  'updatedAt',
] as const;

/**
 * 投影单条任务为 slim 形状（batch_get_tasks 默认，plan forge-jubilee-robin C3）。
 *
 * - 按白名单拷贝字段（仅拷贝实际存在的字段，避免补出 undefined 键）
 * - description 截断为 descriptionSnippet（≤300 字符，复用 project.ts truncateField；
 *   标记名 = descriptionTruncated，与 truncateField 的 `{field}Truncated` 规则一致）
 * - commentCount 不入投影：findOne 运行时不产出该字段（task.service.ts:473-480）
 *
 * @param task - 后端返回的完整任务对象（原地截断 description，无共享引用）
 * @returns 投影后的 slim 任务对象
 */
function projectTaskSlim(task: Record<string, unknown>): Record<string, unknown> {
  // description 截断（原地，超长打 descriptionTruncated 标记），再改名 descriptionSnippet 输出
  truncateField(task, 'description', SNIPPET_MAX_CHARS);

  const projected: Record<string, unknown> = {};
  for (const field of TASK_SLIM_KEPT_FIELDS) {
    if (task[field] !== undefined) {
      projected[field] = task[field];
    }
  }
  if (task.description !== undefined) {
    projected.descriptionSnippet = task.description;
  }
  if (task.descriptionTruncated === true) {
    projected.descriptionTruncated = true;
  }
  return projected;
}

/**
 * batch_get_tasks — 批量获取任务详情
 *
 * 并发获取 N 个任务详情，单条失败不拖垮整体。
 * 内部并发上限 10（手写分批，不加新依赖）。
 */
export const batchGetTasksTool: CustomTool = {
  tool: {
    name: 'batch_get_tasks',
    description:
      'Batch fetch task details: up to 50 UUIDs, fetched concurrently (internal cap of 10), ' +
      'with per-item errors embedded rather than failing the entire batch. ' +
      'Output preserves input order. Saves Agent-side MCP round trips and tokens. ' +
      'Default slim=true projects each task to {id,title,status,priority,labels,boardId,listId,' +
      'assigneeName,assigneeDeletedAt,dueDate,updatedAt,descriptionSnippet(≤300),descriptionTruncated} ' +
      '— pass slim:false for full task detail, or follow_up_task for a single task deep dive.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of task IDs (UUIDs, 1~50 items)',
        },
        slim: {
          type: 'boolean',
          description:
            'Slim projection (default true): each task carries only core fields + ' +
            'descriptionSnippet (≤300 chars, descriptionTruncated flag when cut). ' +
            'Pass false for full task detail.',
        },
      },
      required: ['ids'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const ids = args.ids as string[];
    // slim 默认 true（breaking 契约收紧，plan forge-jubilee-robin C3）；显式 false 走全文通道
    const slim = args.slim !== false;

    // 参数校验
    if (!Array.isArray(ids) || ids.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: 'ids must be a non-empty array (1~50 UUIDs)',
            }),
          },
        ],
        isError: true,
      };
    }
    if (ids.length > 50) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: `ids count ${ids.length} exceeds limit of 50`,
            }),
          },
        ],
        isError: true,
      };
    }

    // 本地 UUID 形状校验，非法 id 直接失败
    const preflight: TaskItem[] = ids.map((id) => {
      if (!looksLikeUuid(id)) {
        return {
          id,
          ok: false,
          error: { message: `Invalid UUID format: ${id}` },
        };
      }
      return { id, ok: true };
    });

    // 分离合法 id 并发获取
    const validIds = ids.filter((id, i) => preflight[i].ok);
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    if (validIds.length > 0) {
      const settled = await batchWithConcurrency(validIds, 10, async (taskId: string) => {
        return client.request<Record<string, unknown>>('GET', `/tasks/${taskId}`);
      });

      // 将结果合并回 preflight 序
      let settledIdx = 0;
      for (let i = 0; i < preflight.length; i++) {
        if (preflight[i].ok) {
          const result = settled[settledIdx++];
          if (result.status === 'fulfilled') {
            // slim 时投影为白名单形状（description → descriptionSnippet）；slim:false 全文透传
            preflight[i].task = slim ? projectTaskSlim(result.value) : result.value;
          } else {
            const err = result.reason;
            preflight[i] = {
              id: preflight[i].id,
              ok: false,
              error: {
                message: err instanceof Error ? err.message : String(err),
                ...(err && typeof err === 'object' && 'status' in (err as Record<string, unknown>)
                  ? { status: (err as Record<string, unknown>).status as number }
                  : {}),
                ...(err && typeof err === 'object' && 'code' in (err as Record<string, unknown>)
                  ? { code: (err as Record<string, unknown>).code as number | string }
                  : {}),
              },
            };
          }
        }
      }
    }

    const succeeded = preflight.filter((t) => t.ok && t.task).length;
    const failed = preflight.length - succeeded;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ items: preflight, total: preflight.length, succeeded, failed }),
        },
      ],
    };
  },
};

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-experience-topic-board.md §5 Batch E1 ⑧
 *   - 补充: 看板任务 fdc1851b（Batch F：紧凑序列化）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制)
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
      'Output preserves input order. Saves Agent-side MCP round trips and tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of task IDs (UUIDs, 1~50 items)',
        },
      },
      required: ['ids'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const ids = args.ids as string[];

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
            preflight[i].task = result.value;
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

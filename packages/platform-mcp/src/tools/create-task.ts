/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-experience-topic-board.md §5 Batch E1 ⑥
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
import { handlePlatformError } from './get-my-briefing';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface BoardListSummary {
  id: string;
  name: string;
  mappedStatus?: string | null;
  [key: string]: unknown;
}

interface BoardMember {
  id: string;
  name: string;
  type: string;
  avatarUrl?: string | null;
  role: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 三层匹配（大小写不敏感）：
 * ① 精确匹配（ci）
 * ② 前缀匹配（ci）
 * ③ 子串匹配（ci）
 *
 * 取最先产生匹配的那一层。该层内 0 个 → 返回 []，>1 个 → 返回该层全部。
 * 调用方根据返回数组长度决定后续行为。
 */
function matchByLayers<T>(
  needle: string,
  candidates: T[],
  keyFn: (c: T) => string,
): { layer: number; matches: T[] } {
  const lower = needle.toLowerCase();

  // Layer 1: exact match (case-insensitive)
  const exact = candidates.filter((c) => keyFn(c).toLowerCase() === lower);
  if (exact.length > 0) return { layer: 1, matches: exact };

  // Layer 2: prefix match (case-insensitive)
  const prefix = candidates.filter((c) => keyFn(c).toLowerCase().startsWith(lower));
  if (prefix.length > 0) return { layer: 2, matches: prefix };

  // Layer 3: substring match (case-insensitive)
  const substring = candidates.filter((c) => keyFn(c).toLowerCase().includes(lower));
  return { layer: 3, matches: substring };
}

/**
 * 提取解析失败错误的消息与结构化候选信息。
 * resolveList/resolveAssignee 抛出的错误经 Object.assign 挂载
 * candidates/options/availableNames/isAmbiguous/layer 字段；
 * undefined 字段在 JSON 序列化时自动省略。
 */
function resolutionFailureBody(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const failure = err as Error & {
    candidates?: unknown[];
    options?: unknown[];
    availableNames?: string[];
    isAmbiguous?: boolean;
    layer?: string;
  };
  return {
    message: failure.message,
    candidates: failure.candidates,
    options: failure.options,
    availableNames: failure.availableNames,
    isAmbiguous: failure.isAmbiguous,
    layer: failure.layer,
  };
}

/**
 * 根据 status 解析目标列：
 * ① mappedStatus 精确匹配
 * ② 列名精确匹配
 * ③ 列名字串匹配
 *
 * 0 个 → 报错并列出可选项
 * >1 个 → 报错并附候选列表
 * 1 个 → 返回
 */
function resolveList(
  status: string,
  lists: BoardListSummary[],
): { listId: string; listName: string; matchedBy: string; mappedStatus: string | null } {
  const lowerStatus = status.toLowerCase();

  // Layer 1: mappedStatus ci exact match
  const mapped = lists.filter(
    (l) => typeof l.mappedStatus === 'string' && l.mappedStatus.toLowerCase() === lowerStatus,
  );
  if (mapped.length === 1) {
    return {
      listId: mapped[0].id,
      listName: mapped[0].name,
      matchedBy: `mappedStatus=${mapped[0].mappedStatus}`,
      mappedStatus: mapped[0].mappedStatus as string,
    };
  }
  if (mapped.length > 1) {
    const candidates = mapped.map((l) => ({
      id: l.id,
      name: l.name,
      mappedStatus: l.mappedStatus,
    }));
    throw Object.assign(
      new Error(
        `status "${status}" matches ${mapped.length} lists via mappedStatus. ` +
          `Provide a more specific status or use a different status name.`,
      ),
      { candidates, layer: 'mappedStatus', isAmbiguous: true },
    );
  }

  // Layer 2: list name exact match (ci)
  const nameExact = lists.filter((l) => l.name.toLowerCase() === lowerStatus);
  if (nameExact.length === 1) {
    return {
      listId: nameExact[0].id,
      listName: nameExact[0].name,
      matchedBy: `listName exact`,
      mappedStatus: (nameExact[0].mappedStatus as string) ?? null,
    };
  }
  if (nameExact.length > 1) {
    const candidates = nameExact.map((l) => ({
      id: l.id,
      name: l.name,
      mappedStatus: l.mappedStatus,
    }));
    throw Object.assign(
      new Error(
        `status "${status}" matches ${nameExact.length} lists by exact name. ` +
          `Refine the status or provide a different name.`,
      ),
      { candidates, layer: 'listName', isAmbiguous: true },
    );
  }

  // Layer 3: list name substring match (ci)
  const nameSub = lists.filter((l) => l.name.toLowerCase().includes(lowerStatus));
  if (nameSub.length === 1) {
    return {
      listId: nameSub[0].id,
      listName: nameSub[0].name,
      matchedBy: `listName substring`,
      mappedStatus: (nameSub[0].mappedStatus as string) ?? null,
    };
  }
  if (nameSub.length > 1) {
    const candidates = nameSub.map((l) => ({
      id: l.id,
      name: l.name,
      mappedStatus: l.mappedStatus,
    }));
    throw Object.assign(
      new Error(
        `status "${status}" matches ${nameSub.length} lists by name substring. ` +
          `Refine the status or provide a more specific name.`,
      ),
      { candidates, layer: 'listName substring', isAmbiguous: true },
    );
  }

  // 0 matches — list all available options
  const options = lists.map((l) => ({
    id: l.id,
    name: l.name,
    mappedStatus: l.mappedStatus ?? '(none)',
  }));
  throw Object.assign(
    new Error(
      `status "${status}" did not match any list on board. ` +
        `Available lists: ${options.map((o) => `${o.name} (mappedStatus=${o.mappedStatus})`).join(', ')}`,
    ),
    { options, isAmbiguous: false },
  );
}

/**
 * 根据 assigneeName 解析成员：
 * 三层匹配：name 精确(ci) → 前缀(ci) → 子串(ci)
 *
 * 0 个 → 报错列成员名
 * >1 个 → 报错附候选
 * 1 个 → 返回
 */
function resolveAssignee(
  assigneeName: string,
  members: BoardMember[],
): { assigneeId: string; assigneeName: string; matchedBy: string } {
  const { layer, matches } = matchByLayers(assigneeName, members, (m) => m.name);

  if (matches.length === 0) {
    const names = members.map((m) => m.name).join(', ');
    throw Object.assign(
      new Error(
        `assigneeName "${assigneeName}" did not match any board member. ` +
          `Available members: ${names}`,
      ),
      { isAmbiguous: false, availableNames: members.map((m) => m.name) },
    );
  }

  if (matches.length > 1) {
    const candidates = matches.map((m) => ({ id: m.id, name: m.name, type: m.type, role: m.role }));
    const layerLabel = layer === 1 ? 'exact' : layer === 2 ? 'prefix' : 'substring';
    throw Object.assign(
      new Error(
        `assigneeName "${assigneeName}" matched ${matches.length} members (${layerLabel}). ` +
          `Please refine: ${candidates.map((c) => c.name).join(', ')}`,
      ),
      { candidates, layer: layerLabel, isAmbiguous: true },
    );
  }

  const m = matches[0];
  const layerLabel = layer === 1 ? 'exact' : layer === 2 ? 'prefix' : 'substring';
  return { assigneeId: m.id, assigneeName: m.name, matchedBy: `name ${layerLabel}` };
}

/**
 * create_task — 语义化建任务
 *
 * 接收人类友好的 status 名称与 assigneeName，内部自动解析 listId 与 assigneeId，
 * 避免 Agent 手动查 list UUID 与 member UUID。
 */
export const createTaskTool: CustomTool = {
  tool: {
    name: 'create_task',
    description:
      'Semantic task creation: pass human-readable status names (e.g. "todo"/"in_progress") ' +
      'and member names; the tool auto-resolves listId and assigneeId internally before creating the task. ' +
      'Status name → list name via three-layer match (mappedStatus exact → list name exact → substring); ' +
      'member name → assigneeId via three-layer match (exact → prefix → substring, all case-insensitive). ' +
      'Resolution failures (0 candidates or multiple candidates) return isError:true + structured ' +
      'candidate info — never silently picks one.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID (UUID, required)',
        },
        title: {
          type: 'string',
          description: 'Task title (required)',
        },
        status: {
          type: 'string',
          description:
            'Task status name. Default "backlog". ' +
            'Resolved to listId via mappedStatus / list name matching.',
        },
        assigneeName: {
          type: 'string',
          description: 'Assignee name (resolved from board members). Optional.',
        },
        description: {
          type: 'string',
          description: 'Task description (optional)',
        },
        priority: {
          type: 'string',
          enum: ['p0', 'p1', 'p2', 'p3'],
          description: 'Priority (optional)',
        },
        dueDate: {
          type: 'string',
          description: 'Due date in ISO 8601 (optional)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label list (optional)',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Idempotency key (optional, 1~64 characters, UUID not required). ' +
            'When the same actor resubmits with the same clientRequestId, the first created task ' +
            'is returned with an idempotentReplay flag — retry-safe.',
        },
      },
      required: ['boardId', 'title'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const boardId = args.boardId as string;
    const title = args.title as string;
    const status = (args.status as string) ?? 'backlog';
    const assigneeName = args.assigneeName as string | undefined;
    const description = args.description as string | undefined;
    const priority = args.priority as string | undefined;
    const dueDate = args.dueDate as string | undefined;
    const labels = args.labels as string[] | undefined;
    const clientRequestId = args.clientRequestId as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：获取看板列列表
    let lists: BoardListSummary[];
    try {
      lists = await client.request<BoardListSummary[]>('GET', `/boards/${boardId}/lists`);
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_board_lists');
    }

    // 步骤 2：解析 status → listId
    let listId: string;
    let listName: string;
    let matchedBy: string;
    let mappedStatus: string | null;
    try {
      const resolved = resolveList(status, lists);
      listId = resolved.listId;
      listName = resolved.listName;
      matchedBy = resolved.matchedBy;
      mappedStatus = resolved.mappedStatus;
    } catch (err: unknown) {
      // 结构化解析失败（0 候选 / 多候选）
      const body = resolutionFailureBody(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, failedStep: 'resolve_list', ...body }),
          },
        ],
        isError: true,
      };
    }

    // 步骤 3（可选）：解析 assigneeName → assigneeId
    let assigneeId: string | undefined;
    let resolvedName: string | undefined;
    let assigneeMatchedBy: string | undefined;
    if (assigneeName) {
      let members: BoardMember[];
      try {
        const board = await client.request<{ members?: BoardMember[] }>(
          'GET',
          `/boards/${boardId}`,
        );
        members = board.members ?? [];
      } catch (err: unknown) {
        return handlePlatformError(err, 'get_board_members');
      }

      try {
        const resolved = resolveAssignee(assigneeName, members);
        assigneeId = resolved.assigneeId;
        resolvedName = resolved.assigneeName;
        assigneeMatchedBy = resolved.matchedBy;
      } catch (err: unknown) {
        const body = resolutionFailureBody(err);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: true, failedStep: 'resolve_assignee', ...body }),
            },
          ],
          isError: true,
        };
      }
    }

    // 步骤 4：创建任务
    const taskBody: Record<string, unknown> = {
      listId,
      boardId,
      title,
    };
    if (description !== undefined) taskBody.description = description;
    if (priority !== undefined) taskBody.priority = priority;
    if (dueDate !== undefined) taskBody.dueDate = dueDate;
    if (labels !== undefined) taskBody.labels = labels;
    if (assigneeId !== undefined) taskBody.assigneeId = assigneeId;
    if (clientRequestId !== undefined) taskBody.clientRequestId = clientRequestId;
    // 仅当解析到的列 mappedStatus 非 null 时才带 status
    if (mappedStatus !== null && mappedStatus !== undefined) {
      taskBody.status = mappedStatus;
    }

    let task: Record<string, unknown>;
    try {
      task = await client.request<Record<string, unknown>>('POST', '/tasks', { body: taskBody });
    } catch (err: unknown) {
      return handlePlatformError(err, 'create_task');
    }

    const resolution: Record<string, unknown> = {
      listId,
      listName,
      matchedBy,
    };
    if (assigneeId !== undefined) {
      resolution.assigneeId = assigneeId;
      resolution.assigneeName = resolvedName;
      resolution.assigneeMatchedBy = assigneeMatchedBy;
    }

    const responseObj: Record<string, unknown> = {
      task,
      resolution,
    };

    // 幂等键未传 → 提示重试风险
    if (!clientRequestId) {
      responseObj.note =
        'No idempotency key (clientRequestId) provided — retries may create duplicate tasks. ' +
        'Pass a stable idempotency key (e.g. "my-agent-20260726-001") to prevent duplicates on retry.';
    }

    // 后端返回 idempotentReplay → 透传
    if (task.idempotentReplay === true) {
      responseObj.idempotentReplay = true;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(responseObj),
        },
      ],
    };
  },
};

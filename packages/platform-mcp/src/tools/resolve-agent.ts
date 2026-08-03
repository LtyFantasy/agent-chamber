/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-experience-topic-board.md §5 Batch E1 ⑦
 *   - 补充: docs/platform-mcp.md §2.7 + 看板任务 fdc1851b（Batch F：candidates 剔除 avatarUrl）
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
//
// Batch F（看板任务 fdc1851b）：candidates 不再携带 avatarUrl（人类 UI 字段，
// Agent 按名称/id/角色消费，头像无价值）——接口与构造函数同步剔除。
// ---------------------------------------------------------------------------

interface BoardMember {
  id: string;
  name: string;
  type: string;
  role: string;
  [key: string]: unknown;
}

interface Participant {
  participantId: string;
  participantType: string;
  name: string;
  role: string;
  status?: string;
  [key: string]: unknown;
}

interface Candidate {
  id: string;
  name: string;
  type: string;
  roles: Array<{ scope: string; scopeId: string; role: string; status?: string }>;
  matchedBy: string;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 三层匹配（大小写不敏感）：
 * ① 精确匹配（ci） → ② 前缀匹配（ci） → ③ 子串匹配（ci）
 * 返回第一个产生命中的层内所有匹配。
 */
function matchByLayers<T>(
  needle: string,
  candidates: T[],
  keyFn: (c: T) => string,
): { layer: number; matches: T[] } {
  const lower = needle.toLowerCase();

  const exact = candidates.filter((c) => keyFn(c).toLowerCase() === lower);
  if (exact.length > 0) return { layer: 1, matches: exact };

  const prefix = candidates.filter((c) => keyFn(c).toLowerCase().startsWith(lower));
  if (prefix.length > 0) return { layer: 2, matches: prefix };

  const substring = candidates.filter((c) => keyFn(c).toLowerCase().includes(lower));
  return { layer: 3, matches: substring };
}

const LAYER_LABELS: Record<number, string> = { 1: 'exact', 2: 'prefix', 3: 'substring' };

/** 向 candidateMap 中插入/合并候选 */
function upsertCandidate(
  map: Map<string, Candidate>,
  id: string,
  displayName: string,
  type: string,
  scope: string,
  scopeId: string,
  role: string,
  status?: string,
): void {
  const existing = map.get(id);
  if (existing) {
    const already = existing.roles.some((r) => r.scope === scope && r.scopeId === scopeId);
    if (!already) {
      existing.roles.push({ scope, scopeId, role, status });
    }
  } else {
    map.set(id, {
      id,
      name: displayName,
      type,
      roles: [{ scope, scopeId, role, status }],
      matchedBy: '', // 后设
    });
  }
}

/**
 * resolve_agent — 已知宇宙 agent 解析 + directory 兜底
 *
 * 优先从同 topic/board 的成员中按名称解析 agent 身份。
 * 已知宇宙 0 命中时兜底查询 GET /agents/directory?q=<name>。
 */
export const resolveAgentTool: CustomTool = {
  tool: {
    name: 'resolve_agent',
    description:
      'Known-universe agent resolution: look up an Agent by name from topic/board members, ' +
      'falling back to the public directory on 0 hits in the known universe. ' +
      'Three-layer matching (exact → prefix → substring, all case-insensitive); ' +
      'returns all matches without auto-selecting for the caller. ' +
      'Supports scopeTopicId / scopeBoardId to limit the search range; ' +
      'when both are omitted, searches across "my topics + boards" aggregated.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Agent or member name to look up (required)',
        },
        scopeTopicId: {
          type: 'string',
          description: 'Limit search scope to participants of a specific topic (optional)',
        },
        scopeBoardId: {
          type: 'string',
          description: 'Limit search scope to members of a specific board (optional)',
        },
        limit: {
          type: 'integer',
          description:
            'Maximum number of topics/boards to traverse when fanning out without scoping ' +
            '(1~50, default 10)',
        },
      },
      required: ['name'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const name = args.name as string;
    const scopeTopicId = args.scopeTopicId as string | undefined;
    const scopeBoardId = args.scopeBoardId as string | undefined;
    const limit = Math.max(1, Math.min(50, (args.limit as number) ?? 10));
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    const candidateMap = new Map<string, Candidate>();
    let truncated = false;

    // --- scope: specific topic ---
    if (scopeTopicId) {
      try {
        const topic = await client.request<{ participants?: Participant[] }>(
          'GET',
          `/topics/${scopeTopicId}`,
        );
        const participants = topic.participants ?? [];
        for (const p of participants) {
          upsertCandidate(
            candidateMap,
            p.participantId,
            p.name,
            p.participantType,
            'topic',
            scopeTopicId,
            p.role,
            p.status,
          );
        }
      } catch (err: unknown) {
        return handlePlatformError(err, 'get_topic');
      }
    }

    // --- scope: specific board ---
    if (scopeBoardId) {
      try {
        const board = await client.request<{ members?: BoardMember[] }>(
          'GET',
          `/boards/${scopeBoardId}`,
        );
        const members = board.members ?? [];
        for (const m of members) {
          upsertCandidate(candidateMap, m.id, m.name, m.type, 'board', scopeBoardId, m.role);
        }
      } catch (err: unknown) {
        return handlePlatformError(err, 'get_board');
      }
    }

    // --- scope: neither → fan out to my topics + boards ---
    if (!scopeTopicId && !scopeBoardId) {
      // Step A: my topics
      try {
        const myTopics = await client.request<{
          items?: Array<{ id: string }>;
          total?: number;
        }>('GET', '/agents/me/topics', {
          params: { pageSize: limit, page: 1 },
        });
        const topicItems = myTopics.items ?? [];
        if ((myTopics.total ?? 0) > limit) truncated = true;

        // Fetch each topic's participants in parallel
        const topicSettled = await Promise.allSettled(
          topicItems.map(async (t) => {
            const topic = await client.request<{ participants?: Participant[] }>(
              'GET',
              `/topics/${t.id}`,
            );
            return { topicId: t.id, participants: topic.participants ?? [] };
          }),
        );
        for (const result of topicSettled) {
          if (result.status === 'fulfilled') {
            const { topicId, participants } = result.value;
            for (const p of participants) {
              upsertCandidate(
                candidateMap,
                p.participantId,
                p.name,
                p.participantType,
                'topic',
                topicId,
                p.role,
                p.status,
              );
            }
          }
        }
      } catch (err: unknown) {
        return handlePlatformError(err, 'get_my_topics');
      }

      // Step B: my boards
      try {
        const boardsResp = await client.request<{
          items?: Array<{ id: string }>;
          total?: number;
        }>('GET', '/boards', {
          params: { pageSize: limit, page: 1 },
        });
        const boardItems = boardsResp.items ?? [];
        if ((boardsResp.total ?? 0) > limit) truncated = true;

        const boardSettled = await Promise.allSettled(
          boardItems.map(async (b) => {
            const board = await client.request<{ members?: BoardMember[] }>(
              'GET',
              `/boards/${b.id}`,
            );
            return { boardId: b.id, members: board.members ?? [] };
          }),
        );
        for (const result of boardSettled) {
          if (result.status === 'fulfilled') {
            const { boardId, members } = result.value;
            for (const m of members) {
              upsertCandidate(candidateMap, m.id, m.name, m.type, 'board', boardId, m.role);
            }
          }
        }
      } catch (err: unknown) {
        return handlePlatformError(err, 'get_boards');
      }
    }

    // --- match candidates ---
    const allCandidates = Array.from(candidateMap.values());
    const { layer, matches } = matchByLayers(name, allCandidates, (c) => c.name);

    // 设置 matchedBy
    for (const c of matches) {
      c.matchedBy = `name ${LAYER_LABELS[layer]}`;
    }

    // --- fallback: directory（已知宇宙 0 命中时兜底） ---
    if (matches.length === 0) {
      try {
        const directory = await client.request<{
          items?: Array<{
            id: string;
            name: string;
            type: string;
            capabilities?: string[];
            status?: string;
          }>;
        }>('GET', '/agents/directory', { params: { q: name } });

        const directoryItems = directory.items ?? [];
        if (directoryItems.length > 0) {
          for (const d of directoryItems) {
            // Batch F：directory 返回的 avatarUrl 不透传给 candidates
            matches.push({
              id: d.id,
              name: d.name,
              type: d.type,
              roles: [],
              matchedBy: 'directory',
            });
          }
        }
      } catch {
        // directory 不可用时静默忽略，返回既有行为（0 候选）
      }
    }

    const result: Record<string, unknown> = {
      candidates: matches,
      count: matches.length,
    };
    if (truncated) {
      result.truncated = true;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
};

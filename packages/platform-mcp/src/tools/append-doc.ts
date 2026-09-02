/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (POST /docs/:id/append)
 *   - 补充: doc.service.ts appendDoc（追加写原语——服务端内部消化并发冲突，
 *     v1.65.0 消费者反馈批 7601e2f5）
 *
 * [踩坑索引]
 *   - patch_doc MATCH 模式字节一致性（2026-08-17）：本工具不涉及 match 面——
 *     append 是纯追加语义，无 oldString 匹配，天然免疫字节漂移
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
import { APPEND_POSITION_VALUES } from '@agent-chamber/shared';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface DocSpaceListItem {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 工具函数（照抄 read-doc.ts 的 matchByLayers / resolutionFailureBody）
// ---------------------------------------------------------------------------

/**
 * 三层匹配（大小写不敏感）：① 精确 → ② 前缀 → ③ 子串。
 * 取最先产生匹配的那一层；该层 0 个 → []，>1 个 → 该层全部。
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

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * append_doc — 追加写原语（v1.65.0 消费者反馈批 7601e2f5）
 *
 * 定位：spaceName 三层匹配 → path 精确匹配拿 docId（与 read_doc/patch_doc 同款双通道
 * 解析的 path 通道）→ POST /docs/:id/append。
 *
 * 与 patch_doc 的分工：patch_doc 是「改既有内容」（section 替换 / match 精确串替换，
 * 需要先读后写、携带锚点）；append_doc 是「纯追加」——一步把 content 追加到文档
 * 末尾或指定 heading 小节末尾，**无需先读**，服务端内部消化并发冲突（重读重写
 * 自动重试，最多 3 次），调用方永远拿最终一致的结果。日记场景首选。
 */
export const appendDocTool: CustomTool = {
  tool: {
    name: 'append_doc',
    description:
      'Append content to a document — one-step write primitive (wrapper of ' +
      'POST /docs/:id/append). Locates the doc by spaceName (three-layer match) + path (exact). ' +
      'Appends body.content to the document END (position=end, default) or to the end of the ' +
      'target heading subtree (position=under-heading + headingPath exact match — copy it from ' +
      'read_doc outline sections[].headingPath). ' +
      '⚠️ CONCURRENCY-IMMUNE: concurrent modification between the server read and write is ' +
      'retried INTERNALLY (re-read → re-transform → re-write, up to 3 attempts) — you never see ' +
      'DOC_CONTENT_CONFLICT unless 3 attempts are exhausted. Preferred for diary append ' +
      'scenarios; replaces the read → patch match three-step round trip. ' +
      'headingPath semantics: 0 matches → 404 DOC_NOT_FOUND (available headingPaths included); ' +
      'multiple matches → 409 RESOURCE_CONFLICT (candidate positions included, never silently picked). ' +
      'The document is re-chunked after the append (outline/position/contentHash/tokenEstimate/ ' +
      'linkHealth all rebuilt). Returns the upsert result ' +
      '{id, path, sectionCount, tokenEstimate, unchanged?, contentHash} — contentHash can be ' +
      'fed to upsert_doc expectedContentHash for chained writes. ' +
      'Source is fixed to "native"; non-native (ingested) docs reject the append (409 DOC_SOURCE_MISMATCH).',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        path: {
          type: 'string',
          description:
            'Document path within the space (exact match, e.g. "docs/api-definition.md")',
        },
        content: {
          type: 'string',
          description:
            'Markdown content to append (non-empty, must contain non-whitespace characters). ' +
            'May include its own heading lines — the chunker creates new sections from them. ' +
            'Leading/trailing whitespace is trimmed by the server.',
        },
        position: {
          type: 'string',
          // 枚举值从 shared APPEND_POSITION_VALUES 单源取值（防 backend DTO 加值后此处漂移）
          enum: [...APPEND_POSITION_VALUES],
          description:
            "Append position: 'end' (document end, default) | 'under-heading' (end of the " +
            'target heading subtree). Defaults to end.',
        },
        headingPath: {
          type: 'string',
          description:
            "Required when position='under-heading': the target section's heading_path " +
            '(exact match, as shown in read_doc outline sections[].headingPath). ' +
            '0 matches → 404 DOC_NOT_FOUND (available headingPaths included); ' +
            'multiple matches → 409 RESOURCE_CONFLICT (candidate positions included). ' +
            'Ignored when position is end.',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars). RECOMMENDED for writes: on transport ' +
            'error / timeout, retry with the SAME key — the server returns the FIRST response ' +
            'snapshot with idempotentReplay:true (no event, no doc_versions row, no side ' +
            'effects). Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
        },
      },
      required: ['spaceName', 'path', 'content'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const path = args.path as string;
    const content = args.content as string;
    const position = args.position as 'end' | 'under-heading' | undefined;
    const headingPath = args.headingPath as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 0：工具侧快速失败（不发 HTTP；服务端另有双层校验）——
    // under-heading 缺 headingPath 是参数不完整，提前报错比 400 更友好
    if (position === 'under-heading' && (headingPath === undefined || headingPath === '')) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message:
                "position='under-heading' requires headingPath (the target section's heading_path, from read_doc outline sections[].headingPath)",
            }),
          },
        ],
        isError: true,
      };
    }

    // 步骤 1：获取空间列表（候选来源）
    let spaces: DocSpaceListItem[];
    try {
      const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
        params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，空间量级远低于此）
      });
      spaces = resp.items ?? [];
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_doc_spaces');
    }

    // 步骤 2：三层匹配解析 spaceName
    const { layer, matches } = matchByLayers(spaceName, spaces, (s) => s.name);

    if (matches.length === 0) {
      const names = spaces.map((s) => s.name);
      const err = Object.assign(
        new Error(
          `spaceName "${spaceName}" did not match any DocSpace. ` +
            `Available spaces: ${names.length > 0 ? names.join(', ') : '(none)'}`,
        ),
        { isAmbiguous: false, availableNames: names },
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              failedStep: 'resolve_space',
              ...resolutionFailureBody(err),
            }),
          },
        ],
        isError: true,
      };
    }

    if (matches.length > 1) {
      const candidates = matches.map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
      const layerLabel = layer === 1 ? 'exact' : layer === 2 ? 'prefix' : 'substring';
      const err = Object.assign(
        new Error(
          `spaceName "${spaceName}" matched ${matches.length} DocSpaces (${layerLabel}). ` +
            `Please refine: ${candidates.map((c) => c.name).join(', ')}`,
        ),
        { candidates, layer: layerLabel, isAmbiguous: true },
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              failedStep: 'resolve_space',
              ...resolutionFailureBody(err),
            }),
          },
        ],
        isError: true,
      };
    }

    const spaceId = matches[0].id;

    // 步骤 3：path 精确匹配定位 docId（与 read_doc/patch_doc 同款定位通道）
    let resolvedDocId: string;
    try {
      const result = await client.request<{ items: Array<{ id: string }> }>(
        'GET',
        `/doc-spaces/${spaceId}/docs`,
        { params: { path, pageSize: 1 } },
      );
      const docs = result.items ?? [];
      if (docs.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                failedStep: 'locate_doc',
                message: `Document not found at path "${path}" in space "${spaceName}"`,
              }),
            },
          ],
          isError: true,
        };
      }
      resolvedDocId = docs[0].id;
    } catch (err: unknown) {
      return handlePlatformError(err, 'locate_doc');
    }

    // 步骤 4：写（source 服务端缺省 native，工具面不暴露——与 patch_doc 一致）
    // v1.63.0：幂等键透传——transport error 后同 key 重试返回首次快照
    const clientRequestId = args.clientRequestId as string | undefined;
    try {
      const body: Record<string, unknown> = { content };
      if (position !== undefined) body.position = position;
      if (headingPath !== undefined) body.headingPath = headingPath;
      if (clientRequestId !== undefined) body.clientRequestId = clientRequestId;
      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/docs/${resolvedDocId}/append`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'append_doc');
    }
  },
};

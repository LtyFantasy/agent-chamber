/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan §5 W5 (upsert_doc 契约)
 *   - 补充: plan §4.3 (文档写 API), plan §1.1-13 (source 隔离)
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

interface DocSpaceListItem {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 工具函数（照抄 create-task.ts）
// ---------------------------------------------------------------------------

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
 * upsert_doc — 创建或更新文档
 *
 * 解析 spaceName → PUT /doc-spaces/:id/docs。
 * source 固定 native，inputSchema 不暴露 source 参数。
 * 409 DOC_SOURCE_MISMATCH 透传结构化错误。
 */
export const upsertDocTool: CustomTool = {
  tool: {
    name: 'upsert_doc',
    description:
      'Upsert a document in a DocSpace by spaceName + path. ' +
      'Resolves spaceName via three-layer match. ' +
      'Source is fixed to "native" — the tool does not expose a source parameter. ' +
      'Returns {id, path, sectionCount, tokenEstimate, unchanged?}. ' +
      '409 DOC_SOURCE_MISMATCH is passed through as a structured error. ' +
      'Metadata authoring: you are the LLM — curate "summary" yourself instead of relying on ' +
      'auto-derivation. Write it for another agent deciding whether to read this doc: ' +
      '"what is this + when should it be read", with key identifiers verbatim (search anchors). ' +
      'Reuse existing docType vocabulary and categories (check get_docs_overview first).',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        path: {
          type: 'string',
          description: 'Document path within the space (e.g. "docs/architecture.md")',
        },
        content: {
          type: 'string',
          description: 'Markdown content of the document',
        },
        title: {
          type: 'string',
          description: 'Optional: document title (auto-derived from first heading if omitted)',
        },
        summary: {
          type: 'string',
          description:
            'Optional but strongly recommended: 1–2 sentences (≤500 chars) answering ' +
            '"what is this + when to read it" for a retrieving agent. Embed key identifiers ' +
            'verbatim (tool/endpoint/technical names — they are the search anchors); ' +
            'do not restate the title. Auto-derived from first paragraph if omitted (usually inferior).',
        },
        docType: {
          type: 'string',
          description:
            'Optional: prefer controlled vocabulary — ' +
            'guide | reference | api | architecture | operations | index | note | memory. ' +
            'CONVENTION (effective this version): high-frequency auto-produced docs (diaries/snapshots) MUST be ' +
            'tagged docType=memory, otherwise they pollute the default global overview; ' +
            'existing docs are NOT retroactively tagged.',
        },
        category: {
          type: 'string',
          description:
            'Optional: category name (auto-created if not found). ' +
            'Reuse an existing category (see get_docs_overview); avoid near-duplicates.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: 3–5 tags, identifiers/technical terms first (search anchors)',
        },
      },
      required: ['spaceName', 'path', 'content'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const path = args.path as string;
    const content = args.content as string;
    const title = args.title as string | undefined;
    const summary = args.summary as string | undefined;
    const docType = args.docType as string | undefined;
    const category = args.category as string | undefined;
    const tags = args.tags as string[] | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：解析 spaceName
    let spaces: DocSpaceListItem[];
    try {
      const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
        params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，空间量级远低于此）
      });
      spaces = resp.items ?? [];
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_doc_spaces');
    }

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
      const body = resolutionFailureBody(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, failedStep: 'resolve_space', ...body }),
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
      const body = resolutionFailureBody(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, failedStep: 'resolve_space', ...body }),
          },
        ],
        isError: true,
      };
    }

    // 步骤 2：upsert 文档（source 固定 native）
    const spaceId = matches[0].id;
    const body: Record<string, unknown> = {
      path,
      content,
      source: 'native',
    };
    if (title !== undefined) body.title = title;
    if (summary !== undefined) body.summary = summary;
    if (docType !== undefined) body.docType = docType;
    if (category !== undefined) body.category = category;
    if (tags !== undefined) body.tags = tags;

    try {
      const result = await client.request<Record<string, unknown>>(
        'PUT',
        `/doc-spaces/${spaceId}/docs`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'upsert_doc');
    }
  },
};

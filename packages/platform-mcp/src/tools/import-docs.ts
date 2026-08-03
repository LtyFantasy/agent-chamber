/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan §2 D7 (import_docs 契约) + §7 修正案 A2/A3
 *   - 补充: plan §1 (D3 批次范围), plan §2 D5-D6 (DTO 上限 / source 语义)
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
// 工具函数（照抄 upsert-doc.ts）
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
 * import_docs — 批量导入文档到指定 DocSpace
 *
 * 解析 spaceName → PUT /doc-spaces/:id/docs/batch。
 * 单次 ≤50 篇，每文档独立事务，单篇失败不中断。
 * source 固定 native，inputSchema 不暴露 source 参数。
 */
export const importDocsTool: CustomTool = {
  tool: {
    name: 'import_docs',
    description:
      'Batch import documents into a specified DocSpace. ' +
      'Resolves spaceName via three-layer match. ' +
      'Single call ≤50 docs, total content recommended ≤4MB — split into multiple calls if exceeding. ' +
      'Per-document independent transaction; a single failure does not abort the batch. ' +
      'Returns per-document status (created/updated/unchanged/failed) plus summary counts. ' +
      'Source is fixed to "native" — the tool does not expose a source parameter. ' +
      "Author each document's metadata per the same conventions as upsert_doc: " +
      'curate "summary" yourself ("what is this + when to read it", key identifiers verbatim), ' +
      'reuse existing docType vocabulary and categories.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        docs: {
          type: 'array',
          description: 'Array of documents to import (1–50 items)',
          items: {
            type: 'object',
            properties: {
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
                description:
                  'Optional: document title (auto-derived from first heading if omitted)',
              },
              summary: {
                type: 'string',
                description:
                  'Optional but strongly recommended: 1–2 sentences (≤500 chars) answering ' +
                  '"what is this + when to read it" for a retrieving agent; key identifiers verbatim. ' +
                  'Auto-derived from first paragraph if omitted (usually inferior).',
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
                  'Reuse existing categories; avoid near-duplicates.',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Optional: 3–5 tags, identifiers/technical terms first (search anchors)',
              },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['spaceName', 'docs'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const docs = args.docs as Array<Record<string, unknown>> | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：MCP 侧校验 docs 数组
    if (!Array.isArray(docs)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              failedStep: 'validate_docs',
              message: '"docs" must be an array of 1–50 documents.',
            }),
          },
        ],
        isError: true,
      };
    }

    if (docs.length < 1 || docs.length > 50) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              failedStep: 'validate_docs',
              message:
                `"docs" must contain 1–50 items, got ${docs.length}. ` +
                'Split into multiple calls when exceeding the limit.',
            }),
          },
        ],
        isError: true,
      };
    }

    // 步骤 2：解析 spaceName
    let spaces: DocSpaceListItem[];
    try {
      const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
        params: { pageSize: 100 },
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

    // 步骤 3：调用批量端点（source 固定 native，不透传）
    const spaceId = matches[0].id;
    const batchDocs = docs.map((doc) => {
      const item: Record<string, unknown> = {
        path: doc.path,
        content: doc.content,
        source: 'native',
      };
      if (doc.title !== undefined) item.title = doc.title;
      if (doc.summary !== undefined) item.summary = doc.summary;
      if (doc.docType !== undefined) item.docType = doc.docType;
      if (doc.category !== undefined) item.category = doc.category;
      if (doc.tags !== undefined) item.tags = doc.tags;
      return item;
    });

    try {
      const result = await client.request<Record<string, unknown>>(
        'PUT',
        `/doc-spaces/${spaceId}/docs/batch`,
        { body: { docs: batchDocs } },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'import_docs');
    }
  },
};

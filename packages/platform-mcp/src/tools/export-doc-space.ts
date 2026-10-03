/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块) —— 任务 T6（空间级全量导出/回导）
 *   - 补充: docs/platform-mcp.md §2（语义化高层工具契约）
 *   - 补充: v1.62.0（contentHash 读路径透传）——bundle docs[] item 增 docId + contentHash
 *     （原始写入 payload 的 SHA-256 = 权威 revision 标识；content 是重建产物，勿对 content
 *     自算 hash）；import DTO 显式声明该字段防 roundtrip 400
 *   - 补充: v1.75.0（bundle formatVersion 2，P2 批 5）——media 段（附件字节，联合预算 +
 *     skipped 双形态）+ mediaOmitted（topic 绑定断链说明）；描述必须与后端契约同步
 *   - 补充: v1.89.0-dev 批次 A——?pathPrefix= 部分快照（appliedFilters 回声 + routes 按
 *     primary 筛选 + secondaryDocPath 照实输出）；PARTIAL SNAPSHOT WARNING 段是契约的一部分
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
// 工具函数（照抄 import-docs.ts / list-docs.ts）
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
 * export_doc_space — DocSpace 空间级全量导出（formatVersion 2 bundle）
 *
 * 包装 GET /doc-spaces/:id/export：单 JSON bundle = 空间元数据（图例/settings）+
 * categories + doc_routes（含 codeEntryType，文档以 path 引用）+ 每篇完整原文与
 * 策展元数据（summary/docType/tags/category）+ media（doc 绑定附件字节）+ mediaOmitted。
 * 快照可直接落 git 做版本对齐 diff，也是离线灾备；回导走 import_doc_bundle。
 */
export const exportDocSpaceTool: CustomTool = {
  tool: {
    name: 'export_doc_space',
    description:
      'Export an entire DocSpace as a single JSON bundle (formatVersion 2): space legend + ' +
      'settings, categories, intent routes (docs referenced by path, incl. codeEntryType), ' +
      'every doc with its full reconstructed markdown content plus curated metadata ' +
      '(summary/docType/tags/category) and revision fields: each docs[] item carries docId ' +
      '(informational, not the import business key) and contentHash (SHA-256 of the original ' +
      'upsert payload — the authoritative revision identifier for export/import diffing; ' +
      'content is a reconstruction whose own SHA-256 does NOT equal contentHash, never ' +
      'self-compute), and a `media` array with the bytes of attachments bound to docs in this ' +
      'space (original base64 + optional thumbnail) so re-imported docs keep their images. ' +
      'Media is packed under a joint request-body budget (10MiB − docs section − 64KiB margin); ' +
      'items too large (>6MiB) or beyond the remaining budget come back as ' +
      '`{skipped: "too_large"|"budget_exceeded"}` markers in the same array (fetch those ' +
      'separately), and body-referenced attachments bound to a topic are listed in the ' +
      'informational `mediaOmitted` array (their links stay broken after import — no bytes are ' +
      'included). Resolves spaceName via three-layer match ' +
      '(exact → prefix → substring, case-insensitive); 0 or >1 candidates returns ' +
      'isError:true + structured candidate info — never silently picks one. ' +
      'Purpose: version-alignment snapshots (pull into git, diff across releases) and offline ' +
      'backup. CAUTION: large spaces produce large responses (full doc contents, no pagination); ' +
      'bundles with media can approach the 10MiB request/response limit and a multi-MB tool ' +
      'result risks client-side truncation — for very large spaces prefer transferring the ' +
      'bundle as a file (the HTTP endpoint) instead of through this tool. ' +
      'PARTIAL SNAPSHOT WARNING: a bundle fetched with pathPrefix is NOT a full space and must ' +
      'NOT be used as a backup. Docs outside the prefix are dropped, categories no included doc ' +
      'references are dropped, and media is narrowed to the included docs automatically. Routes ' +
      'are kept or dropped by their PRIMARY doc only — a kept route may carry a secondaryDocPath ' +
      'pointing at a doc that is NOT in bundle.docs: re-importing into the SAME space preserves ' +
      'that link, but importing into a DIFFERENT/new space fails those routes per-item (loud, ' +
      'never silent). To seed a new space, export WITHOUT pathPrefix. pathPrefix is a literal, ' +
      'case-sensitive prefix (use a trailing "/" for directory semantics; LIKE wildcards are ' +
      'escaped). A prefix matching nothing returns 200 with an empty bundle (success; import = ' +
      'no-op) — read appliedFilters.matchedDocs === 0 to tell "prefix matched nothing" from ' +
      '"space is empty". appliedFilters is an informational echo; the import side ignores it. ' +
      "For a single doc's full content use read_doc, not this tool. " +
      'The bundle is directly consumable by import_doc_bundle (roundtrip; formatVersion 1 ' +
      'bundles remain importable). ' +
      'Requires read access to the space.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        pathPrefix: {
          type: 'string',
          description:
            'Optional: literal, case-sensitive path prefix (use a trailing "/" for directory ' +
            'semantics; LIKE wildcards are escaped). Exports a PARTIAL snapshot — only docs ' +
            'under the prefix, with categories/routes/media narrowed to that closure and ' +
            'appliedFilters echoed back. NOT a backup; a prefix matching nothing returns 200 ' +
            'with an empty bundle.',
        },
      },
      required: ['spaceName'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：获取空间列表（候选来源）
    let spaces: DocSpaceListItem[];
    try {
      const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
        params: { pageSize: 100 },
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

    // 步骤 3：调用导出端点（bundle 原样透传——调用方落盘/落 git 即得快照）
    // v1.89.0-dev 批次 A：pathPrefix 显式传入时才带 params（缺省保持既有调用形态）
    const spaceId = matches[0].id;
    const pathPrefix = args.pathPrefix as string | undefined;
    try {
      const bundle = await client.request<Record<string, unknown>>(
        'GET',
        `/doc-spaces/${spaceId}/export`,
        pathPrefix ? { params: { pathPrefix } } : undefined,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(bundle) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'export_doc_space');
    }
  },
};

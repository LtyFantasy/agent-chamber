/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块) —— 任务 T6（空间级全量导出/回导）
 *   - 补充: docs/platform-mcp.md §2（语义化高层工具契约）
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
 * import_doc_bundle — DocSpace 回导（吃 export_doc_space 产出的 bundle）
 *
 * 包装 POST /doc-spaces/:id/import-bundle：四阶段有序回导（categories → docs → routes →
 * space meta），per-item 独立事务（单篇失败不中止），重复导入幂等。
 * space meta 默认不回写；overwriteSpaceMeta=true 显式开启。
 */
export const importDocBundleTool: CustomTool = {
  tool: {
    name: 'import_doc_bundle',
    description:
      'Restore a DocSpace from an export bundle (the output of export_doc_space, formatVersion 1). ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive); ' +
      '0 or >1 candidates returns isError:true + structured candidate info — never silently picks one. ' +
      'Four ordered phases: ① categories (idempotent by name) → ② docs (per-doc independent ' +
      'transaction — a single failing doc does not abort the batch) → ③ routes (idempotent by ' +
      'intent + primaryDocPath) → ④ space meta, SKIPPED unless overwriteSpaceMeta=true (explicit ' +
      'opt-in to avoid clobbering the target space curation). formatVersion mismatch → 400 ' +
      'VALIDATION_ERROR. Re-importing the same bundle is fully idempotent (no duplicate rows). ' +
      'Returns per-item statuses (created/updated/unchanged/failed) plus summary counts. ' +
      'Requires write access to the space.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'Target DocSpace name (resolved via three-layer match)',
        },
        bundle: {
          type: 'object',
          description:
            'The export bundle object (formatVersion 1) — pass the result of export_doc_space ' +
            'verbatim, or a previously saved snapshot read back from git/storage.',
        },
        overwriteSpaceMeta: {
          type: 'boolean',
          description:
            'When true, also overwrite target space name/description/settings from the bundle ' +
            '(default false — space meta is never written implicitly).',
        },
      },
      required: ['spaceName', 'bundle'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const bundle = args.bundle;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：MCP 侧预检 bundle 是对象（格式校验主体在后端 DTO/Service 层，
    // 这里只拦「没传对象」这种调用方笔误，避免带病请求）
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              failedStep: 'validate_bundle',
              message: '"bundle" must be an object (the export_doc_space output).',
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

    // 步骤 3：调用回导端点（bundle 作为请求体直接透传；overwriteSpaceMeta 显式透传）
    const spaceId = matches[0].id;
    const params: Record<string, unknown> = {};
    if (args.overwriteSpaceMeta === true) {
      params.overwriteSpaceMeta = 'true';
    }

    try {
      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/doc-spaces/${spaceId}/import-bundle`,
        { params, body: bundle },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'import_doc_bundle');
    }
  },
};

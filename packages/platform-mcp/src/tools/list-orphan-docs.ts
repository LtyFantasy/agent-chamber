/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - orphan 文档诊断清单（DocSpace 元数据治理 3 期，v1.92.0-dev）：未被任何 doc_routes
 *     （primary ∪ secondary）引用的未删文档——**维护者诊断面，不是缺陷判定**。
 *
 * [代码职责]
 *   - 本文件实现 MCP 语义工具 list_orphan_docs：spaceName 三层匹配（或直传 spaceId）→
 *     GET /doc-spaces/:id/docs/orphans → 响应原样透传（含 stats.byTopDir / appliedFilters）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（GET /doc-spaces/:id/docs/orphans 契约：
 *     覆盖口径、overviewFilter 默认排除、byTopDir、pathPrefix、stats）
 *   - 补充: 线上 docs/integrations/platform-mcp.md（list_orphan_docs 工具条目）
 *
 * [关键不变量]
 *   - 响应**原样透传**（含 appliedFilters / stats），工具层不补默认值、不做二次过滤——
 *     「默认排除了什么」是后端契约的一部分，工具层改写会让维护者误判清单完整性；
 *   - 0 或 >1 个 spaceName 候选 → isError:true + 结构化候选，绝不静默挑选（_resolve-space 单源）。
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/_resolve-space.ts — spaceId/spaceName 解析单源
 *   - packages/platform-mcp/src/tools/get-doc-facets.ts — 只读工具模板（原样透传）
 *   - apps/backend/src/modules/docspace/doc.service.ts — findOrphans 实现
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import { resolveSpaceId } from './_resolve-space';

/**
 * list_orphan_docs — orphan 文档诊断清单（v1.92.0-dev 3 期）
 *
 * 只读；`stats.byTopDir` 让维护者一眼分辨「结构性叶子群」vs「可行动孤儿」。
 */
export const listOrphanDocsTool: CustomTool = {
  tool: {
    name: 'list_orphan_docs',
    description:
      'List orphan documents of a DocSpace — wrapper of GET /doc-spaces/:id/docs/orphans. ' +
      'Orphan = a non-deleted doc NOT referenced by any doc_routes row (primary ∪ secondary). ' +
      'A leaf document without a route is NOT an error: this is a maintenance diagnostic list, ' +
      'not a defect verdict. A route pointing at a deleted doc is a different dimension (link ' +
      'health) and is NOT counted here. ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive); ' +
      'pass spaceId (UUID) to skip name resolution. 0 or >1 name candidates returns isError:true ' +
      'with structured candidates — never silently picks one. ' +
      'By default the space overviewFilter (excludeTypes / excludeCategories) is applied — diaries ' +
      'and archived docs are not navigation-surface material and would flood the list; pass ' +
      'includeExcluded=true for the raw set. The response echoes appliedFilters, so you can always ' +
      'tell what was excluded. ' +
      'Response: { items:[{id,path,title,docType,categorySlug,updatedAt}], total, page, pageSize, ' +
      'appliedFilters, stats:{totalDocs, routedDocs, orphanDocs, excludedOrphanDocs, byTopDir} }. ' +
      'stats.byTopDir groups by the first path segment (top-level files fall under "(root)") so a ' +
      'structural leaf cluster (e.g. 190 world leaves) is distinguishable at a glance from ' +
      'actionable orphans. Use pathPrefix to slice one cluster, page/pageSize to page (max 100). ' +
      'Pure read, computed on the fly — there is no stored report and no scheduler; call it when ' +
      'you need the picture. Requires read access to the space.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description:
            'DocSpace name (resolved via three-layer match). Required unless spaceId is given.',
        },
        spaceId: {
          type: 'string',
          description:
            'DocSpace UUID. When provided, spaceName resolution is skipped (takes priority).',
        },
        includeExcluded: {
          type: 'boolean',
          description:
            'Set true to include orphans the space overviewFilter excludes by default ' +
            '(excludeTypes / excludeCategories). Default false.',
        },
        pathPrefix: {
          type: 'string',
          description:
            'Path prefix filter (literal prefix semantics, wildcards escaped) — slice a structural ' +
            'leaf cluster such as "world/".',
        },
        page: {
          type: 'number',
          description: 'Page number (default 1).',
        },
        pageSize: {
          type: 'number',
          description: 'Items per page (default 20, max 100).',
        },
      },
      required: [],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    const resolution = await resolveSpaceId(client, args.spaceName, args.spaceId);
    if (!resolution.ok) return resolution.result;
    const spaceId = resolution.spaceId;

    // query 直透（后端 DTO 负责格式校验；响应原样返回——含 appliedFilters/stats）
    const params: Record<string, unknown> = {};
    if (args.includeExcluded !== undefined) params.includeExcluded = args.includeExcluded;
    if (args.pathPrefix !== undefined) params.pathPrefix = args.pathPrefix;
    if (args.page !== undefined) params.page = args.page;
    if (args.pageSize !== undefined) params.pageSize = args.pageSize;

    try {
      const resp = await client.request<Record<string, unknown>>(
        'GET',
        `/doc-spaces/${spaceId}/docs/orphans`,
        { params },
      );
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_orphan_docs');
    }
  },
};

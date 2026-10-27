/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocCategory merge（DocSpace 元数据治理 3 期，v1.92.0-dev）：把 source 分类下的
 *     文档重指向 target，修正软引用（doc_routes.category / overviewFilter），软删 source。
 *
 * [代码职责]
 *   - 本文件实现 MCP 语义工具 merge_doc_category：直传 categoryId + targetId →
 *     POST /doc-categories/:id/merge → 4xx 结构化透传（铁律 #9）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（POST /doc-categories/:id/merge 契约）
 *   - 补充: 线上 docs/integrations/platform-mcp.md（merge_doc_category 工具条目）
 *
 * [关键不变量]
 *   - **description 必须强引导 dryRun 先行**（plan P3/D12）——与 rename_doc_tags 同款；
 *     注意 merge 的 execute **不接 expectedBatchToken**（plan D2/§3 定形），description 的
 *     引导只到 dryRun，不得杜撰 token 参数；
 *   - **category 无 alias 机制**：merge 后旧 slug 查询即空，description 必须显式告知
 *     （与 tags 的 alias 兼容不对称）；
 *   - body 直透；4xx 结构化透传（含 404 分类不存在 / 422 同源·跨空间·target 已软删）。
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/move-doc.ts — 写工具模板（dryRun + 幂等键透传）
 *   - apps/backend/src/modules/docspace/doc-rename.service.ts — mergeCategory 实现
 *   - apps/backend/src/modules/docspace/doc-category.controller.ts — 路由与权限
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

/**
 * merge_doc_category — DocCategory 合并（v1.92.0-dev 3 期）
 *
 * 直传 categoryId（source，路径参数）+ targetId（body）。dryRun 预演受影响文档与软引用
 * 影响面；execute 重指向 + 软引用修正 + 软删 source。
 */
export const mergeDocCategoryTool: CustomTool = {
  tool: {
    name: 'merge_doc_category',
    description:
      'Merge one DocCategory into another — wrapper of POST /doc-categories/:id/merge. ' +
      'Docs under the source category are repointed to the target in one transaction, soft ' +
      'references are fixed (doc_routes.category rewritten from the old slug to the new one, ' +
      'settings.overviewFilter.excludeCategories adjusted), and the source category is ' +
      'soft-deleted (its slug is released). Category rename is already covered by ' +
      'PATCH /doc-categories/:id — this tool only adds merge. ' +
      '⚠️ Always run with dryRun=true first: it returns the affected docs (total + sample ≤50), ' +
      'the soft-reference impact and a batchToken, with ZERO side effects (no write, no audit, no ' +
      'idempotency record). Then re-submit without dryRun to execute (merge takes no ' +
      'expectedBatchToken — the batchToken is for your own cross-check). ' +
      '⚠️ Categories have NO alias mechanism (only the tag vocabulary carries aliases): after the ' +
      'merge, queries by the OLD slug return nothing — unlike tags, which stay reachable through ' +
      'the alias layer. ' +
      'Fail-closed: 404 when the source or target category does not exist; 422 when target === ' +
      'source, the target belongs to another space, or the target is soft-deleted. ' +
      'ingest documents are repointed too and listed in ingestAffected. After commit one summary ' +
      'audit row is written on the source category (oldData carries the per-doc pre-image, so a ' +
      'rollback is a reverse repoint). Requires write access (creator or editor).',
    inputSchema: {
      type: 'object',
      properties: {
        categoryId: {
          type: 'string',
          description:
            'Source category ID (UUID) — the category to merge FROM. Must exist and not be ' +
            'soft-deleted.',
        },
        targetId: {
          type: 'string',
          description:
            'Target category ID (UUID) — the category to merge INTO. Must be in the same space, ' +
            'not soft-deleted, and different from categoryId.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'true = preview only (affected docs + soft-reference impact + batchToken), zero side ' +
            'effects. Always run this first.',
        },
        idempotencyKey: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars). Retry with the SAME key after a transport error ' +
            'returns the FIRST response snapshot with idempotentReplay:true (no second write).',
        },
      },
      required: ['categoryId', 'targetId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    const categoryId = args.categoryId as string;
    const targetId = args.targetId as string;
    if (typeof categoryId !== 'string' || typeof targetId !== 'string') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: "'categoryId' and 'targetId' (UUID strings) are required",
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      // body 直透（服务端 fail-closed 校验链与错误码是唯一事实来源；铁律 #9）
      const body: Record<string, unknown> = { targetId };
      if (args.dryRun !== undefined) body.dryRun = args.dryRun;
      if (args.idempotencyKey !== undefined) body.idempotencyKey = args.idempotencyKey;

      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/doc-categories/${categoryId}/merge`,
        { body },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, 'merge_doc_category');
    }
  },
};

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 空间体检面（v1.92.0-dev，DocSpace 元数据治理 1 期）：一词调用返回
 *     声明词表（vocabulary）+ 实际分布（types/tags/categories 聚合计数）+ 逐项词表
 *     状态（vocabStatus / canonicalValue）——写文档前查词表复用既有值的入口。
 *     2 期起 `vocabulary` 增带 `hintToggles`（六族 hint 开关现状），故本工具同时是
 *     族开关配置的读回面（写通道 = update_doc_space_vocabulary）。
 *
 * [代码职责]
 *   - 本文件实现 MCP 语义工具 get_doc_facets：spaceName 三层匹配解析（或直传
 *     spaceId）→ GET /doc-spaces/:id/docs/facets → 结构化错误透传。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16.9b（GET /doc-spaces/:id/docs/facets
 *     ——响应结构 / 词表状态与 vocabulary 回显契约）
 *   - 补充: 线上 docs/integrations/platform-mcp.md（get_doc_facets 工具条目）
 *
 * [关键不变量]
 *   - 0 或 >1 个 spaceName 候选 → isError:true + 结构化候选，绝不静默挑选；
 *   - spaceId 直传优先于 spaceName 解析（省一次空间列表拉取）；
 *   - 响应原样透传（含 vocabulary / vocabStatus / canonicalValue），不做投影——
 *     词表未配置时这些字段整段省略是后端契约，工具层不得补默认值。
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/_resolve-space.ts — 三层匹配 / 失败信封构造单源
 *     （本文件与 list-docs / list-doc-tree 共用，勿再复制本地拷贝）
 *   - apps/backend/src/modules/docspace/doc.controller.ts — findFacets 路由
 *     （权限 ensureCan(space, actor, 'read')，透传 space.settings）
 *   - apps/backend/src/modules/docspace/doc.service.ts — findFacets 实现
 *     （聚合 SQL + 词表状态计算 + vocabulary 回显）
 *   - apps/backend/src/modules/docspace/doc-vocabulary.helper.ts — 词表读侧形状闸门
 *     （脏 jsonb 不抛；facets 状态由该闸门过滤后的形态计算）
 *   - packages/shared/src/dto/docspace-response.dto.ts — DocFacetsResponse /
 *     DocFacetCount / DocFacetsVocabulary 契约类型（**shared 单一事实来源**，本文件
 *     2 期起不再持有本地拷贝——本地拷贝会漏 hintToggles 这类新增字段）
 *   - packages/platform-mcp/src/tools/update-doc-space-vocabulary.ts — 四键的写通道
 *     （本工具是读回校验的对应面：读 get_doc_facets → 合并 → 写 → 再读回）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
// v1.92.0-dev：facets 契约类型收敛到 shared 单一事实来源（本文件原先有三份本地拷贝
// ——DocSpaceCanonicalTag / DocSpacePathType / DocFacetsVocabulary——缺 hintToggles
// 字段，2 期加族开关后本地副本必然与后端漂移，故整体删除改 import）
import type { DocFacetsResponse } from '@agent-chamber/shared';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
// v1.92.0-dev：三层匹配与失败信封构造收敛到单源（同目录 _resolve-space.ts）
import { matchByLayers, resolutionFailureBody, type DocSpaceListItem } from './_resolve-space';

// ---------------------------------------------------------------------------
// 工具函数：三层匹配 / 失败信封构造（v1.92.0-dev 起单源 = ./_resolve-space.ts）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * get_doc_facets — DocSpace 空间体检面（v1.92.0-dev）
 *
 * 按 spaceId（直传）或 spaceName（三层匹配）解析 DocSpace → 包装
 * GET /doc-spaces/:id/docs/facets。返回声明词表 + 实际分布 + 逐项词表状态。
 * 空间声明 canonicalTags 时，写文档前先调用本工具复用既有 canonical 值——
 * 写入侧归一只是兜底纠偏。
 */
export const getDocFacetsTool: CustomTool = {
  tool: {
    name: 'get_doc_facets',
    description:
      'Space-wide facet counts + declared vocabulary status for a DocSpace (wrapper of ' +
      'GET /doc-spaces/:id/docs/facets). ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, ' +
      'case-insensitive); pass spaceId (UUID) to skip name resolution entirely. ' +
      '0 or >1 name candidates returns isError:true + structured candidate info — never ' +
      'silently picks one. ' +
      'Response: { types, tags, categories, vocabulary? } — types = GROUP BY doc_type, ' +
      'tags = unnest(tags), categories = JOIN doc_categories (all non-deleted docs only). ' +
      'When the space declares a vocabulary (settings.docTypes / canonicalTags / ' +
      'pathTypes), each item carries vocabStatus (types: declared|undeclared; tags: ' +
      'canonical|alias|undeclared) and tags may carry canonicalValue (status=alias). ' +
      'Tags semantics: `canonical` means the stored value EXACTLY equals a declared ' +
      'canonical value; any non-declared form that case-insensitively hits a value or ' +
      'alias is `alias` with canonicalValue pointing at the declared value (the signal ' +
      'for same-meaning tag splits). The declared vocabulary is echoed under `vocabulary`. ' +
      'Unconfigured families omit these fields entirely — ' +
      'the absence means "no vocabulary configured", not "out of vocabulary". ' +
      '`vocabulary` also carries `hintToggles` (the per-family hint switches, one of ' +
      'metadata / tags / categories / pathType / routes / read), so this is the read-back ' +
      'side of the hint configuration. ' +
      'USE THIS BEFORE WRITING DOCS OR THE VOCABULARY: if the space declares canonicalTags, ' +
      'read the vocabulary here and reuse an existing canonical value instead of inventing a ' +
      'new tag (write-path normalization is only a fallback correction). To CHANGE the ' +
      'vocabulary, call update_doc_space_vocabulary — but pass its four keys FLAT, not as this ' +
      "reply's nested `vocabulary` object, and merge what you read here first (that tool " +
      'replaces each key wholesale).',
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
      },
      required: [],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：解析 spaceId——直传优先，省一次空间列表拉取
    let spaceId =
      typeof args.spaceId === 'string' && args.spaceId.trim() !== '' ? args.spaceId.trim() : null;

    if (!spaceId) {
      const spaceName = args.spaceName as string | undefined;
      if (!spaceName || String(spaceName).trim() === '') {
        const err = Object.assign(new Error('Either spaceName or spaceId must be provided'), {
          isAmbiguous: false,
        });
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

      // 获取空间列表（候选来源）
      let spaces: DocSpaceListItem[];
      try {
        const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
          params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍）
        });
        spaces = resp.items ?? [];
      } catch (err: unknown) {
        return handlePlatformError(err, 'list_doc_spaces');
      }

      // 三层匹配解析 spaceName
      const { layer, matches } = matchByLayers(String(spaceName), spaces, (s) => s.name);

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

      spaceId = matches[0].id;
    }

    // 步骤 2：拉取 facets（响应原样透传，含 vocabulary / vocabStatus / canonicalValue）
    try {
      const resp = await client.request<DocFacetsResponse>(
        'GET',
        `/doc-spaces/${spaceId}/docs/facets`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_doc_facets');
    }
  },
};

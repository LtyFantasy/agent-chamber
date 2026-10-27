/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 存量 tag rename/merge（DocSpace 元数据治理 3 期，v1.92.0-dev）：全空间把
 *     `from[]` 的旧 tag 值批量替换为 `to`，同事务生成 alias 声明（旧值查询仍命中）。
 *
 * [代码职责]
 *   - 本文件实现 MCP 语义工具 rename_doc_tags：spaceName 三层匹配（或直传 spaceId）→
 *     POST /doc-spaces/:id/tags/rename → 4xx 结构化透传（铁律 #9）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（POST /doc-spaces/:id/tags/rename 契约：
 *     dryRun/execute 信封、409 DOC_BATCH_CONFLICT、幂等重放、审计载荷）
 *   - 补充: 线上 docs/integrations/platform-mcp.md（rename_doc_tags 工具条目）
 *
 * [关键不变量]
 *   - **description 必须强引导 dryRun 先行**（plan P3）：LLM 消费者按 description 行动，
 *     「Always run with dryRun=true first, then execute with expectedBatchToken」不可删；
 *   - body 直透（dryRun / expectedBatchToken / idempotencyKey 逐字透传），工具层不做业务
 *     判断——服务端 fail-closed 校验链与错误码是唯一事实来源；
 *   - 0 或 >1 个 spaceName 候选 → isError:true + 结构化候选，绝不静默挑选（_resolve-space 单源）。
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/_resolve-space.ts — spaceId/spaceName 解析单源
 *   - packages/platform-mcp/src/tools/move-doc.ts — 写工具模板（dryRun + 幂等键透传）
 *   - apps/backend/src/modules/docspace/doc-rename.service.ts — 服务端实现
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
 * rename_doc_tags — 存量 tag rename/merge（v1.92.0-dev 3 期）
 *
 * 双通道定位：spaceId 直传（优先）或 spaceName 三层匹配。rename = from 单元素；
 * merge = from 多元素。服务端自动生成 alias 声明（词表未声明则创建），读侧（per-space
 * 搜索/列表）经 alias 集合展开，rename 后旧值仍搜得到。
 */
export const renameDocTagsTool: CustomTool = {
  tool: {
    name: 'rename_doc_tags',
    description:
      'Rename or merge tags across a whole DocSpace — wrapper of ' +
      'POST /doc-spaces/:id/tags/rename. rename = one value in `from`; merge = several values ' +
      '(the storage semantics are the same: every `from` value is replaced by `to`). ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive); ' +
      'pass spaceId (UUID) to skip name resolution. 0 or >1 name candidates returns isError:true ' +
      'with structured candidates — never silently picks one. ' +
      '⚠️ Always run with dryRun=true first, then execute with expectedBatchToken. ' +
      'dryRun=true returns the affected list (total + sample ≤50), per-value hit counts, trgm ' +
      'near-synonym candidates (similarNotAffected — values you may want to add to `from`), the ' +
      'vocabulary change plan and a batchToken, with ZERO side effects (no write, no audit, no ' +
      'idempotency record). Then execute with the returned expectedBatchToken: if a concurrent ' +
      'write changed the affected set, you get 409 DOC_BATCH_CONFLICT (abort-all, zero side ' +
      'effects) with data.diff.currentAffectedDocIds — batchToken is a one-way hash, so the ' +
      'server cannot reconstruct your dryRun snapshot; compare the current set with your dryRun ' +
      'result and re-run dryRun for a fresh token. Omitting expectedBatchToken = blind execute ' +
      '(unverified). ' +
      'Alias declaration is generated unconditionally (the space vocabulary settings.canonicalTags ' +
      'is created when absent), so reads by the OLD value keep matching after the rename — per-space ' +
      'search and list expand the query value to [canonical, ...aliases]. ' +
      'Documents are rewritten by SQL: docId, content and updatedAt are untouched (governance ' +
      'metadata writes must not flood the updatedAt_desc ordering). ingest documents are rewritten ' +
      'too and listed in ingestAffected (sync the repository frontmatter). ' +
      'After commit one summary audit row is written (oldData carries the per-doc pre-image, so a ' +
      'rollback is a reverse rename). ' +
      'Vocabulary aliases are capped at 20 per canonical: a single call adds at most 20 (from ≤20) ' +
      'so it cannot overflow on its own, but accumulation across repeated renames can — the tail ' +
      'is then truncated (oldest aliases kept) and reported in `vocabulary.truncatedAliases` / ' +
      '`vocabularyPlan.truncatedAliases`, so the space stays PATCH-able. ' +
      'Requires write access (creator or editor).',
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
        from: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Old tag values to replace (1–20 items, each ≤50 chars). Multiple values = merge ' +
            '(e.g. ["NPC","npc "] → "npc" collects both variants in one pass).',
        },
        to: {
          type: 'string',
          description:
            'Target tag value (trimmed, non-empty, ≤50 chars). Becomes the canonical value in the ' +
            'space vocabulary.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'true = preview only (affected docs + vocabulary plan + batchToken), zero side effects. ' +
            'Always run this first, then execute with expectedBatchToken.',
        },
        expectedBatchToken: {
          type: 'string',
          description:
            'batchToken returned by dryRun — the optimistic precondition for execute. Mismatch → ' +
            '409 DOC_BATCH_CONFLICT with the current affected docIds, zero side effects.',
        },
        idempotencyKey: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars). Retry with the SAME key after a transport error ' +
            'returns the FIRST response snapshot with idempotentReplay:true (no second write). ' +
            'Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
        },
      },
      required: ['from', 'to'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    const resolution = await resolveSpaceId(client, args.spaceName, args.spaceId);
    if (!resolution.ok) return resolution.result;
    const spaceId = resolution.spaceId;

    const from = args.from as string[];
    const to = args.to as string;
    if (!Array.isArray(from) || from.length === 0 || typeof to !== 'string') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              status: 400,
              failedStep: 'validate_args',
              message: "'from' (non-empty array of strings) and 'to' (string) are required",
            }),
          },
        ],
        isError: true,
      };
    }
    // `to` trim 后为空 → 400 结构化错误（评审 B1；服务端 DTO/Service 双层也拦，这里让
    // LLM 消费者拿到明确指引而不是一个空 tag 的静默改写或 500）
    if (to.trim() === '') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              status: 400,
              failedStep: 'validate_args',
              message:
                "'to' must be a non-empty tag value (trimmed) — a blank target would write an " +
                'empty tag; pass the canonical value you want the old tags rewritten into',
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      // body 直透（服务端 fail-closed 校验链与错误码是唯一事实来源；铁律 #9）
      const body: Record<string, unknown> = { from, to };
      if (args.dryRun !== undefined) body.dryRun = args.dryRun;
      if (args.expectedBatchToken !== undefined) body.expectedBatchToken = args.expectedBatchToken;
      if (args.idempotencyKey !== undefined) body.idempotencyKey = args.idempotencyKey;

      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/doc-spaces/${spaceId}/tags/rename`,
        { body },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, 'rename_doc_tags');
    }
  },
};

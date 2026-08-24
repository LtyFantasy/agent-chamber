/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (PATCH /docs/:id/sections/:position)
 *   - 补充: 任务 T3（section 级写——大文档局部修改，免整篇 read-modify-write）
 *
 * [踩坑索引]
 *   - patch_doc MATCH 模式字节一致性（2026-08-17）：oldString 匹配面 = full=true 保真全文，
 *     read_doc 全文与每节 markdown 均为其字节级保真片段（BYTE-IDENTITY）——从默认 web
 *     渲染（去首标题）或降级本地渲染（续 chunk 幻影标题）复制 oldString 必 0 命中
 *   - Hument 事故（topic msg 6dbc4da3）：stale position fail-open → fail-closed
 *     （2026-08-16）：双模式改造（section / match 互斥），section 模式劝退缺省、
 *     引导 expectedSectionHash（取数通道 = read_doc positions:[n] 的 sectionHash）
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
 * patch_doc — section 级 / match 模式文档写（v1.55 任务 T3；v1.57 fail-closed 改造）
 *
 * 定位：spaceName 三层匹配 → path 精确匹配拿 docId（与 read_doc/delete_doc 同款双通道
 * 解析的 path 通道）→ 两种互斥写模式：
 *   - section 模式（position + content [+ expectedSectionHash]）→ PATCH /docs/:docId/sections/:position
 *   - match 模式（oldString + newString）→ PATCH /docs/:docId/content
 *
 * section 模式 content 契约与读侧对称：read_doc section 模式返回「标题行 + 正文」的
 * 保真渲染片段（含 run-dedup 语义），content 必须是同形片段（含标题行）——后端替换整节
 * 后重跑 chunk/重建管线。空串 = 删除该节。
 * match 模式 oldString 的匹配面 = full=true 保真全文（GET /docs/:id/content?full=true）；
 * read_doc 全文与每节 markdown 都是该文本的字节级保真片段，可直接复制作 oldString
 * （BYTE-IDENTITY，见 description）。
 * 并发与 position 漂移防护 = 服务端 fail-closed 前提校验（见 description 明文）。
 */
export const patchDocTool: CustomTool = {
  tool: {
    name: 'patch_doc',
    description:
      'Replace part of a document — TWO mutually exclusive write modes (wrapper of ' +
      'PATCH /docs/:id/sections/:position and PATCH /docs/:id/content). ' +
      'Locates the doc by spaceName (three-layer match) + path (exact). ' +
      'SECTION MODE (position + content): replace ONE whole section by position. ' +
      '"content" must be the full rendered section fragment INCLUDING its heading line — ' +
      'exactly the shape read_doc returns in section mode (e.g. "## My Heading\\n\\nnew body..."); ' +
      'empty content deletes the section. ⚠️ FAIL-CLOSED: positions DRIFT after any re-chunk ' +
      '(structural edits re-number sections) and a stale position otherwise writes the WRONG ' +
      'block SILENTLY. Always pass expectedSectionHash — copy it from read_doc positions:[n] ' +
      '(each item carries sectionHash): mismatch → 409 DOC_CONTENT_CONFLICT instead of a ' +
      'silent wrong-block write; re-read the outline and retry on 409. ' +
      'MATCH MODE (oldString + newString): replace an exact substring in the document ' +
      'full content. oldString is matched against the full=true faithful content ' +
      '(== GET /docs/:id/content?full=true). BYTE-IDENTITY: read_doc full text and every ' +
      'section markdown are byte-faithful fragments of this same text — copy any of them ' +
      'verbatim as oldString and it matches (NOT the default web rendering, which drops ' +
      'the first title heading). 0 matches → 404 (re-read first); ' +
      'multiple matches → 409 + matchCount (expand oldString with more surrounding context ' +
      'and retry); exactly 1 match → replaced. ' +
      'Both modes: concurrent modification between your read and the write is detected ' +
      'server-side inside the upsert transaction (409 DOC_CONTENT_CONFLICT); the document is ' +
      "re-chunked after replacement (other sections' positions may drift — re-read the outline). " +
      'Returns the upsert result {id, path, sectionCount, tokenEstimate, unchanged?, contentHash} ' +
      '— contentHash can be fed to upsert_doc expectedContentHash for chained writes. ' +
      'Source is fixed to "native"; non-native (ingested) docs reject the patch (409 DOC_SOURCE_MISMATCH).',
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
        position: {
          type: 'integer',
          description:
            'SECTION MODE: section position (0-based) to replace — from read_doc outline ' +
            'sections[].position. Out-of-range positions fail with 404 DOC_NOT_FOUND. ' +
            'Mutually exclusive with oldString/newString.',
        },
        content: {
          type: 'string',
          description:
            'SECTION MODE: new section content — MUST include the heading line (same shape ' +
            'read_doc section mode returns). Empty string deletes the section. ' +
            'Mutually exclusive with oldString/newString.',
        },
        expectedSectionHash: {
          type: 'string',
          description:
            'SECTION MODE (strongly recommended): write precondition — the sectionHash of the ' +
            'target section captured at read time (read_doc positions:[n] items carry ' +
            'sectionHash). Mismatch → 409 DOC_CONTENT_CONFLICT (fail-closed against stale ' +
            'positions after re-chunk drift). Omit = legacy fail-open (not recommended).',
        },
        oldString: {
          type: 'string',
          description:
            'MATCH MODE: exact substring to replace, matched against the full=true faithful ' +
            'content (== GET /docs/:id/content?full=true). read_doc output is byte-faithful ' +
            'to this text: the full text equals it exactly and each section markdown is an ' +
            'exact substring — both are valid oldString sources (copy verbatim). ' +
            '0 matches → 404; multiple matches → 409 + matchCount (expand context and retry). ' +
            'Must be paired with newString; mutually exclusive with position/content.',
        },
        newString: {
          type: 'string',
          description:
            'MATCH MODE: replacement text (may be an empty string = delete the matched ' +
            'fragment). Must be paired with oldString.',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars, applies to BOTH modes). RECOMMENDED for ' +
            'writes: on transport error / timeout, retry with the SAME key — the server ' +
            'returns the FIRST response snapshot with idempotentReplay:true (no event, no ' +
            'doc_versions row, no side effects). Same key with a different payload → 409 ' +
            'IDEMPOTENCY_KEY_CONFLICT.',
        },
      },
      required: ['spaceName', 'path'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const path = args.path as string;
    const position = args.position as number | undefined;
    const content = args.content as string | undefined;
    const expectedSectionHash = args.expectedSectionHash as string | undefined;
    const oldString = args.oldString as string | undefined;
    const newString = args.newString as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 0：双模式互斥/成对校验（工具侧快速失败，不发 HTTP；服务端另有双层校验）
    const hasPosition = position !== undefined;
    const hasContent = content !== undefined;
    const hasOld = oldString !== undefined;
    const hasNew = newString !== undefined;
    const modeError = (message: string): ToolCallResult => ({
      content: [{ type: 'text', text: JSON.stringify({ error: true, message }) }],
      isError: true,
    });

    if ((hasPosition || hasContent) && (hasOld || hasNew)) {
      return modeError(
        'Section mode (position + content) and match mode (oldString + newString) are mutually exclusive — pass one pair only',
      );
    }
    if (hasPosition !== hasContent) {
      return modeError(
        'Section mode requires BOTH position and content (position without content or vice versa is incomplete)',
      );
    }
    if (hasOld !== hasNew) {
      return modeError(
        'Match mode requires BOTH oldString and newString (newString may be an empty string to delete the fragment)',
      );
    }
    if (!hasPosition && !hasOld) {
      return modeError(
        'Provide either section mode (position + content) or match mode (oldString + newString)',
      );
    }
    if (expectedSectionHash !== undefined && hasOld) {
      return modeError(
        'expectedSectionHash only applies to section mode (match mode is guarded by exact-substring uniqueness instead)',
      );
    }

    // section 模式 position 客户端侧快速校验（服务端另有双层校验；此处只为给出更友好的错误）
    if (hasPosition && (!Number.isInteger(position) || (position as number) < 0)) {
      return modeError('position must be a non-negative integer (0-based section index)');
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

    // 步骤 3：path 精确匹配定位 docId（与 read_doc/delete_doc 同款定位通道）
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

    // 步骤 4：写（source 服务端缺省 native，工具面不暴露——与 upsert_doc 一致）
    // v1.63.0：幂等键两种模式均透传（section → PATCH sections/:position body；
    // match → PATCH content body）——transport error 后同 key 重试返回首次快照
    const clientRequestId = args.clientRequestId as string | undefined;
    try {
      if (hasOld) {
        // match 模式：全文精确串替换
        const matchBody: Record<string, unknown> = { oldString, newString };
        if (clientRequestId !== undefined) matchBody.clientRequestId = clientRequestId;
        const result = await client.request<Record<string, unknown>>(
          'PATCH',
          `/docs/${resolvedDocId}/content`,
          { body: matchBody },
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      // section 模式：整节替换（expectedSectionHash 携带时服务端 fail-closed 前提校验）
      const body: Record<string, unknown> = { content };
      if (expectedSectionHash !== undefined) body.expectedSectionHash = expectedSectionHash;
      if (clientRequestId !== undefined) body.clientRequestId = clientRequestId;
      const result = await client.request<Record<string, unknown>>(
        'PATCH',
        `/docs/${resolvedDocId}/sections/${position}`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'patch_doc');
    }
  },
};

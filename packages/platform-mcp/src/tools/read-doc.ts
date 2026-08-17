/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan §5 W5 (read_doc 契约)
 *   - 补充: plan §4.3 (文档读 API), plan §1.1-13 (sectionId 不稳定 + 禁止持久化)
 *   - 本批次（2026-08-08 read_doc 按意图投影）: 三分支投影——outline 精简 JSON /
 *     full 原始 markdown 纯文本 / section 原始 markdown（标题行重建）；砍 section
 *     模式 linkHealth 额外 HTTP 请求；shared 类型接线（DocDetail/DocSectionContent
 *     + extractLastHeadingSegment helper），删除本地重复接口
 *
 * [踩坑索引]
 *   - headingPath-separator-v1.57.2：末段标题必须通过 shared extractLastHeadingSegment() 提取，
 *     仅识别带空格的 ` § ` 结构分隔符，保留标题正文中的 `§3.2`。
 *   - patch_doc MATCH 模式字节一致性（2026-08-17）：「read_doc 返回与 match 匹配面相同」
 *     曾失实——本地渲染无 run-dedup 上下文（续 chunk 幻影标题）+ full 丢首标题 + 空正文
 *     尾部 \n\n 三处字节不一致，复制的 oldString 必 0 命中（Hument 事故在 match 面的同类
 *     场景）。修复：后端 section 读通道新增保真 markdown 字段（renderSectionPart 口径 =
 *     full=true 全文的字节级子串），本工具三条 section 通道优先取用；本地渲染降级为
 *     兼容 fallback（仅在旧服务端无 markdown 字段时生效，勿从降级输出构造 oldString）
 *   - fail-closed 改造（2026-08-16）：positions[] 批量通道每项透传 sectionHash
 *     （patch_doc expectedSectionHash 唯一取数通道——单节通道是纯文本 markdown 挂不了
 *     元数据）；position "stable cross-update" 失实措辞已修正（position 会漂移）
 *   - rundedup-continuation-v1.57.3：fallback 渲染仅在 isContinuation === true 时去掉标题；
 *     老服务端缺字段时保留标题，避免启发式吞掉真实同名 sibling。
 *
 * [铁律关联] #9(代理层透传) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   rundedup-continuation-v1.57.3: 老服务端缺少 isContinuation 时不能启用相邻字段启发式去重。fallback 仅对显式 true 的续 chunk 去掉标题，缺字段保留标题。
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { extractLastHeadingSegment } from '@agent-chamber/shared';
import type { DocDetail, DocSectionContent, DocBatchSectionsResult } from '@agent-chamber/shared';
import { PlatformApiClient, PlatformApiError } from '../platform-client';
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

/**
 * 渲染 section 原始 markdown：把标题行插回（chunker 把标题存进 headingPath/headingLevel，
 * section.content 不含标题行——没有标题正文缺上下文）。
 *
 * ⚠️ **降级渲染（仅兼容用途）**：v1.57.1 起后端 section 读通道返回保真 markdown 字段
 * （renderSectionPart skipDuplicateTitle=false 口径：标题行插回 + run-dedup + 空正文只
 * 插标题行），本函数只在老服务端无 markdown 字段时兜底。它镜像 backend 的标题行重建
 * 规则（headingLevel > 0 且 headingPath 非空时，`'#'.repeat(min(headingLevel, 6)) + ' ' +
 * headingPath 末段`；标题文本为空则不插标题行、只返回 content）。v1.57.3 起仅当
 * isContinuation === true 时跳过标题行；老服务端缺少该字段时为 undefined，保留标题行，
 * 避免在没有事实标记时误吞合法同名 sibling。
 *
 * 参数收窄为定位/正文三元组（Pick）：单节通道的 DocSectionContent 与批量通道的
 * DocSectionItem 都满足——两条通道共用同一降级渲染管线。末段标题统一由 shared
 * extractLastHeadingSegment() 提取，避免与 chunker 的 headingPath 契约漂移。
 */
function renderSectionMarkdown(
  section: Pick<DocSectionContent, 'headingPath' | 'headingLevel' | 'content' | 'isContinuation'>,
): string {
  const headingText = section.headingPath ? extractLastHeadingSegment(section.headingPath) : '';
  if (section.isContinuation === true) {
    return section.content;
  }
  if (section.headingLevel > 0 && headingText) {
    const prefix = '#'.repeat(Math.min(section.headingLevel, 6));
    return `${prefix} ${headingText}\n\n${section.content}`;
  }
  return section.content;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * read_doc — 文档精读（四通道投影）
 *
 * 双通道定位：(spaceName+path) 精确匹配 或 裸 docId。
 * 读取通道（互斥优先级）：
 *   (1) positions[]（v1.55 批量）：一次读多节——GET /docs/:id/sections?positions=1,3,5，
 *       返回 {docId, docPath, sections[{position, headingPath, headingLevel, isContinuation,
 *       tokenEstimate, sectionHash, markdown}], missing[]}；重复 position 去重、越界 position 进 missing 不整体报错
 *       （部分失败友好），sections 按 position ASC；与其他定位参数互斥。sectionHash 是
 *       patch_doc expectedSectionHash 前提校验的取数通道（fail-closed 改造）。
 *   (2) position 或 headingPath：单节 markdown（后端保真渲染片段——标题行插回 + run-dedup；
 *       老服务端无 markdown 字段时降级本地「标题行重建」）。position 优先；
 *       headingPath 无 position 时先取大纲解析 position（必需）。
 *   (3) headingQuery（v1.55 模糊）：对 headingPath 做大小写不敏感子串匹配——
 *       唯一命中返回该节 markdown；多命中 isError + candidates（不静默挑选）；
 *       零命中 isError（提示走 outline 核对 headingPath）。仅当 position/headingPath
 *       均未提供时生效（与后端优先级契约一致）。
 *   (4) 无定位参数 → outline/full 投影：小文档（tokenEstimate ≤ maxFullTokens 阈值，
 *       缺省 2000，0=强制 outline）返 mode:'full' → content 原始 markdown 纯文本（不
 *       JSON 包装）；大文档返 mode:'outline' → 精简 JSON（metadata + summary + sections
 *       带 position；linkHealth 仅此模式返回）。
 * 不收 sectionId（不稳定契约），不走 /content 全文通道（仅 web 渲染用）；full 文本与
 * section markdown 与 match 写面（full=true 全文）逐字节同形（BYTE-IDENTITY GUARANTEE，
 * 见 description）——复制的任何片段都是安全的 patch_doc oldString 来源。
 */
export const readDocTool: CustomTool = {
  tool: {
    name: 'read_doc',
    description:
      'Read a document by dual-channel location: (spaceName + path) via exact path match, ' +
      'or bare docId via direct lookup. ' +
      'Four read channels (priority: positions[] batch > position > headingPath > headingQuery; ' +
      'positions[] is mutually exclusive with all single-section locators): ' +
      '(1) positions=[1,3,5]: BATCH read multiple sections in one round trip — returns ' +
      '{docId, docPath, sections[{position, headingPath, isContinuation, sectionHash, markdown}], missing[]}; duplicates ' +
      'deduped, out-of-range positions go to missing instead of failing the whole request; ' +
      'each section item carries sectionHash — copy it into patch_doc expectedSectionHash ' +
      'for a fail-closed section write (this batch channel is THE way to obtain sectionHash; ' +
      'the single-section channels return raw markdown without metadata); ' +
      "each item's markdown is a byte-faithful fragment of the full text (oldString-safe); " +
      '(2) position or headingPath: returns that section markdown — a byte-faithful fragment ' +
      'of the full-fidelity text (heading line included exactly as in the full text; ' +
      'run-dedup continuation chunks of a >4000-char section carry body only); ' +
      '(3) headingQuery: case-insensitive substring match on headingPath — unique hit returns ' +
      'the section markdown, multiple hits return an error with candidates (never silently ' +
      'picks one), zero hits return an error suggesting the outline channel; ' +
      '(4) neither: small documents (tokenEstimate ≤ maxFullTokens threshold, default 2000) ' +
      'return the full content as raw markdown plain text; large documents return a compact ' +
      'outline JSON — metadata + summary + section map with positions (linkHealth only here). ' +
      'Does NOT accept sectionId (unstable — changes on every content update). ' +
      'Full text and section bodies are raw markdown, never JSON-escaped. ' +
      'BYTE-IDENTITY GUARANTEE: full text and section markdown are byte-faithful fragments ' +
      'of the same full-fidelity text that patch_doc MATCH MODE matches against ' +
      '(== GET /docs/:id/content?full=true) — the full text equals it exactly and each ' +
      'section markdown is an exact substring, so anything copied from read_doc is a safe ' +
      'oldString source.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description:
            'DocSpace name (resolved via three-layer match). Required when using path channel.',
        },
        path: {
          type: 'string',
          description:
            'Document path within the space (exact match). Required when using path channel.',
        },
        docId: {
          type: 'string',
          description: 'Document ID (UUID). Required when using direct docId channel.',
        },
        maxFullTokens: {
          type: 'integer',
          description:
            'Optional. Threshold deciding between outline JSON and inlined full markdown ' +
            'when no position/headingPath is given: documents with tokenEstimate ≤ threshold ' +
            'return the full content as raw markdown, larger ones return outline JSON ' +
            '(default 2000; 0 = force outline; range 0-100000, enforced server-side). ' +
            'Only applies when no position/headingPath is given.',
        },
        positions: {
          type: 'array',
          items: { type: 'integer' },
          description:
            'Optional (batch channel): array of 0-based section positions to read in one ' +
            'round trip, e.g. [1, 3, 5] (max 100). Mutually exclusive with position/headingPath/headingQuery. ' +
            'After fetching the outline, batch the positions of the sections you actually need.',
        },
        position: {
          type: 'integer',
          description:
            'Section position (0-based). ⚠️ NOT stable cross-update: positions drift after ' +
            'any re-chunk — re-read the outline before writing. Returns section body. ' +
            'Takes priority over headingPath if both provided.',
        },
        headingPath: {
          type: 'string',
          description:
            'Section heading path (alternative to position, exact match; nested segments use ' +
            '` § `). If position is not provided, resolves headingPath to position via outline lookup.',
        },
        headingQuery: {
          type: 'string',
          description:
            'Optional (fuzzy locator): case-insensitive substring matched against headingPath. ' +
            'Unique hit → returns that section; multiple hits → error with candidates ' +
            '[{position, headingPath}]; zero hits → error. Only used when neither position ' +
            'nor headingPath is provided.',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const path = args.path as string | undefined;
    const docId = args.docId as string | undefined;
    const position = args.position as number | undefined;
    const headingPath = args.headingPath as string | undefined;
    const headingQuery = args.headingQuery as string | undefined;
    const positionsRaw = args.positions as unknown;
    const maxFullTokens = args.maxFullTokens as number | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 参数校验：至少提供 (spaceName+path) 或 docId
    if (!docId && !(spaceName && path)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: 'Either docId or (spaceName + path) must be provided',
            }),
          },
        ],
        isError: true,
      };
    }

    // ── 批量通道（v1.55 positions[]）格式校验 + 互斥检查 ────────────
    // 语义：positions 是批量定位（响应含 missing 槽位），与单节定位参数
    // （position/headingPath/headingQuery）语义不共存——混传 = 工具调用格式错误，
    // 快速失败不发起 HTTP（后端也会 400，此处给 Agent 更明确的工具侧错误）。
    let positions: number[] | undefined;
    if (positionsRaw !== undefined) {
      const raw = positionsRaw as unknown;
      const isIntArray =
        Array.isArray(raw) && raw.every((p) => typeof p === 'number' && Number.isInteger(p));
      if (!isIntArray || (raw as number[]).length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                message: 'positions must be a non-empty array of integers, e.g. [1, 3, 5]',
              }),
            },
          ],
          isError: true,
        };
      }
      if ((raw as number[]).length > 100) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                message: 'positions list exceeds max 100 entries',
              }),
            },
          ],
          isError: true,
        };
      }
      positions = raw as number[];
      if (position !== undefined || headingPath !== undefined || headingQuery !== undefined) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                message:
                  'positions= (batch) is mutually exclusive with position / headingPath / headingQuery',
              }),
            },
          ],
          isError: true,
        };
      }
    }

    let resolvedDocId: string;

    if (docId) {
      // 通道 2：裸 docId 直接定位
      resolvedDocId = docId;
    } else {
      // 通道 1：spaceName+path 精确匹配
      let spaces: DocSpaceListItem[];
      try {
        const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
          params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，空间量级远低于此）
        });
        spaces = resp.items ?? [];
      } catch (err: unknown) {
        return handlePlatformError(err, 'list_doc_spaces');
      }

      const { layer, matches } = matchByLayers(spaceName!, spaces, (s) => s.name);

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

      const spaceId = matches[0].id;

      // 精确 path 匹配
      try {
        const result = await client.request<{ items: Array<{ id: string }> }>(
          'GET',
          `/doc-spaces/${spaceId}/docs`,
          { params: { path: path!, pageSize: 1 } },
        );
        const docs = result.items ?? [];
        if (docs.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
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
    }

    // ─── 批量通道（v1.55 positions[]）：一次读多节 ──────────────────
    if (positions !== undefined) {
      try {
        const result = await client.request<DocBatchSectionsResult>(
          'GET',
          `/docs/${resolvedDocId}/sections`,
          // 后端契约：逗号分隔字符串（"1,3,5"）——工具层负责数组 → 字符串序列化
          { params: { positions: positions.join(',') } },
        );

        // 投影：sections 每项取后端保真 markdown（renderSectionPart 口径的字节级子串，
        // 与 full=true 全文逐字节一致，可直接作 patch_doc oldString）；老服务端无
        // markdown 字段时按 isContinuation 事实降级本地渲染；缺字段则保留标题行；
        // 附 position/headingPath/headingLevel/isContinuation/tokenEstimate/sectionHash 元数据；
        // missing 透出越界/不存在 position（部分失败友好——调用方自行决定是否重试）
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                docId: result.docId,
                docPath: result.docPath,
                sections: result.sections.map((s) => ({
                  position: s.position,
                  headingPath: s.headingPath ?? null,
                  headingLevel: s.headingLevel,
                  isContinuation: s.isContinuation,
                  tokenEstimate: s.tokenEstimate,
                  sectionHash: s.sectionHash,
                  markdown: s.markdown ?? renderSectionMarkdown(s),
                })),
                missing: result.missing,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        return handlePlatformError(err, 'read_doc_sections_batch');
      }
    }

    // ─── 模糊通道（v1.55 headingQuery）：大小写不敏感子串定位 ───────
    // 命中语义由后端拍板：唯一命中 → 该节；多命中 → 409 + candidates（绝不静默挑选）；
    // 零命中 → 404。409 时把 candidates 从错误 details 提升到响应顶层（Agent 可直接
    // 读候选 position/headingPath 改用精确定位）。
    if (headingQuery !== undefined) {
      try {
        const section = await client.request<DocSectionContent>(
          'GET',
          `/docs/${resolvedDocId}/sections`,
          { params: { headingQuery } },
        );

        // 后端保真 markdown 优先（字节级子串，可直接作 oldString）；老服务端降级本地渲染
        return {
          content: [{ type: 'text', text: section.markdown ?? renderSectionMarkdown(section) }],
        };
      } catch (err: unknown) {
        if (err instanceof PlatformApiError && err.status === 409) {
          const details = (err.details ?? {}) as Record<string, unknown>;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  failedStep: 'read_doc_heading_query',
                  status: 409,
                  code: err.code,
                  message: err.message,
                  candidates: details.candidates,
                }),
              },
            ],
            isError: true,
          };
        }
        return handlePlatformError(err, 'read_doc_heading_query');
      }
    }

    // ─── 读取：无定位参数 → outline/full 投影；有定位 → section 原始 markdown ───
    if (position === undefined && headingPath === undefined) {
      // maxFullTokens 透传到后端覆盖内联阈值（0 = 强制 outline）；
      // 未传时保持原调用形态（无 options），与既有行为一致
      try {
        const options = maxFullTokens !== undefined ? { params: { maxFullTokens } } : undefined;
        const doc = await client.request<DocDetail>('GET', `/docs/${resolvedDocId}`, options);

        // full 模式：小文档内联全文 → content 原始 markdown 纯文本直接作为 text content
        // （不 JSON 包装、不加任何头部——Agent 已定位 docId/path，正文无需元数据信封）
        if (doc.mode === 'full' && doc.content !== undefined) {
          return {
            content: [{ type: 'text', text: doc.content }],
          };
        }

        // outline 模式：投影为精简 JSON——只保留消费价值高的元数据字段，砍掉
        // spaceId/categoryId/source/sourceSha/createdBy/createdAt/mode 等低价值字段
        // （sections 仅含定位元数据，不含 content；linkHealth 是文档级巡检元数据归此处）
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                docId: doc.id,
                path: doc.path,
                title: doc.title,
                summary: doc.summary,
                docType: doc.docType,
                tags: doc.tags,
                tokenEstimate: doc.tokenEstimate,
                sectionCount: doc.sectionCount,
                updatedAt: doc.updatedAt,
                linkHealth: doc.linkHealth,
                sections: doc.sections,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        return handlePlatformError(err, 'read_doc_outline');
      }
    }

    // Section 正文模式：返回该节原始 markdown（标题行重建 + content）
    let resolvedPosition: number | undefined = position;

    if (resolvedPosition === undefined && headingPath) {
      // headingPath 但无 position：先取大纲，按 headingPath 匹配找到 position
      // （大纲请求仅用于解析定位，其 linkHealth 不再透传给 section 响应）
      try {
        const doc = await client.request<DocDetail>('GET', `/docs/${resolvedDocId}`);
        const sections = doc.sections ?? [];
        const matches = sections.filter((s) => s.headingPath === headingPath);
        if (matches.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  message: `Section with headingPath "${headingPath}" not found in document`,
                }),
              },
            ],
            isError: true,
          };
        }
        if (matches.length > 1) {
          // headingPath 链可重复（不同章节下同名子标题）——绝不静默挑选，
          // 返回候选 position 让 Agent 改用 position 精确定位
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  message: `headingPath "${headingPath}" matches ${matches.length} sections; retry with 'position' instead`,
                  candidates: matches.map((m) => ({
                    position: m.position,
                    headingPath: m.headingPath,
                  })),
                }),
              },
            ],
            isError: true,
          };
        }
        resolvedPosition = matches[0].position;
      } catch (err: unknown) {
        return handlePlatformError(err, 'read_doc_outline');
      }
    }

    // 读取 section（position 一旦确定即充分定位，不再附 headingPath query——后端 position 优先会忽略它）
    try {
      const section = await client.request<DocSectionContent>(
        'GET',
        `/docs/${resolvedDocId}/sections/${resolvedPosition}`,
      );

      // 后端保真 markdown 优先（字节级子串，可直接作 oldString）；老服务端降级本地渲染
      return {
        content: [{ type: 'text', text: section.markdown ?? renderSectionMarkdown(section) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'read_doc_section');
    }
  },
};

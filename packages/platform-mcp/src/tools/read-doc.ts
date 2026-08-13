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
 *     + HEADING_PATH_SEPARATOR 常量），删除本地重复接口
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
import { HEADING_PATH_SEPARATOR } from '@agent-chamber/shared';
import type { DocDetail, DocSectionContent } from '@agent-chamber/shared';
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

/**
 * 渲染 section 原始 markdown：把标题行插回（chunker 把标题存进 headingPath/headingLevel，
 * section.content 不含标题行——没有标题正文缺上下文）。
 *
 * 标题行重建规则镜像 backend DocService.reconstructContent：headingLevel > 0 且
 * headingPath 非空时，`'#'.repeat(min(headingLevel, 6)) + ' ' + headingPath 末段`；
 * 标题文本为空则不插标题行，只返回 content。层级分隔符走 shared 常量
 * HEADING_PATH_SEPARATOR（与 chunker 契约同源，避免字面量漂移）。
 */
function renderSectionMarkdown(section: DocSectionContent): string {
  const headingText = section.headingPath
    ? (section.headingPath.split(HEADING_PATH_SEPARATOR).pop()?.trim() ?? '')
    : '';
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
 * read_doc — 文档精读（三分支投影）
 *
 * 双通道定位：(spaceName+path) 精确匹配 或 裸 docId。
 * 无定位参数 → GET /docs/:id：小文档（tokenEstimate ≤ maxFullTokens 阈值，缺省 2000，
 * 0=强制 outline）后端返 mode:'full' → 直接返回 content 原始 markdown 纯文本（不 JSON
 * 包装、不加头部）；大文档返 mode:'outline' → 投影为精简 JSON（metadata + summary +
 * sections 带 position；linkHealth 仅在此模式返回）。
 * 带 position 或 headingPath → GET /docs/:id/sections/:position，返回该节原始 markdown
 * （标题行按 reconstructContent 同规则重建：headingLevel>0 且 headingPath 非空 →
 * '#'.repeat(min(level,6)) + ' ' + headingPath 末段 + 空行 + content）。
 * headingPath 无 position 时先取大纲解析 position（必需）；不再为 section 模式额外
 * 请求 linkHealth（该元数据仅 outline 模式返回）。
 * 不收 sectionId（不稳定契约），不走 /content 全文通道（仅 web 渲染用）。
 */
export const readDocTool: CustomTool = {
  tool: {
    name: 'read_doc',
    description:
      'Read a document by dual-channel location: (spaceName + path) via exact path match, ' +
      'or bare docId via direct lookup. ' +
      'Without position/headingPath: small documents (tokenEstimate ≤ maxFullTokens ' +
      'threshold, default 2000) return the full content as raw markdown plain text; ' +
      'large documents return a compact outline JSON — metadata + summary + section map ' +
      'with positions (linkHealth is only returned in this mode). ' +
      'With position or headingPath: returns that section as raw markdown with its ' +
      'heading line reconstructed. ' +
      'Does NOT accept sectionId (unstable — changes on every content update). ' +
      'Full text and section bodies are raw markdown, never JSON-escaped. ' +
      'Does NOT use the /content full-text channel (web rendering only).',
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
        position: {
          type: 'integer',
          description:
            'Section position (0-based, stable cross-update). Returns section body. ' +
            'Takes priority over headingPath if both provided.',
        },
        headingPath: {
          type: 'string',
          description:
            'Section heading path (alternative to position). ' +
            'If position is not provided, resolves headingPath to position via outline lookup.',
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

      return {
        content: [{ type: 'text', text: renderSectionMarkdown(section) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'read_doc_section');
    }
  },
};

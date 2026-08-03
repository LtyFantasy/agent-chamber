/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan §5 W5 (read_doc 契约)
 *   - 补充: plan §4.3 (文档读 API), plan §1.1-13 (sectionId 不稳定 + 禁止持久化)
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

interface DocOutlineItem {
  position: number;
  headingPath?: string | null;
  headingLevel: number;
  tokenEstimate?: number;
}

/**
 * 链接健康巡检结果（对齐 packages/shared LinkHealth）
 *
 * 写入时机：upsert 事务内 chunking 后顺带计算。
 * NULL 表示尚未检查（兼容旧数据）。
 */
interface LinkHealth {
  /** 检测到的平台内链接总数 */
  total: number;
  /** 断链 href 列表（去重、保持出现顺序），无断链时为空数组 */
  broken: string[];
  /** 检查时间戳 ISO 8601 */
  checkedAt: string;
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

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * read_doc — 文档精读
 *
 * 双通道定位：(spaceName+path) 精确匹配 或 裸 docId。
 * 无定位参数 → GET /docs/:id：小文档（tokenEstimate ≤ 2000，可用 maxFullTokens
 * 覆盖，0=强制 outline）直接内联全文（mode:'full' + content）；大文档返回大纲
 * （mode:'outline'）+ 按 section 精读。
 * 带 position 或 headingPath → 返回对应 section 正文。
 * 不收 sectionId（不稳定契约），不走 /content 全文通道（仅 web 渲染用）。
 */
export const readDocTool: CustomTool = {
  tool: {
    name: 'read_doc',
    description:
      'Read a document by dual-channel location: (spaceName + path) via exact path match, ' +
      'or bare docId via direct lookup. ' +
      'Without position/headingPath: small documents (tokenEstimate ≤ 2000 by default; ' +
      'override with maxFullTokens, 0 = force outline) are inlined with full content ' +
      '(mode:"full" + content); large documents return outline (mode:"outline") for ' +
      'per-section targeted reading. ' +
      'With position or headingPath: returns the matching section body. ' +
      'Does NOT accept sectionId (unstable — changes on every content update). ' +
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
            'Optional. Inline-full-content token threshold override for outline mode ' +
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

    // ─── 读取：无定位参数 → 大纲（小文档内联全文）；有定位 → section 正文 ───
    if (position === undefined && headingPath === undefined) {
      // 大纲模式：maxFullTokens 透传到后端覆盖内联阈值（0 = 强制 outline）；
      // 未传时保持原调用形态（无 options），与既有行为一致
      try {
        const options =
          maxFullTokens !== undefined ? { params: { maxFullTokens } } : undefined;
        const doc = await client.request<Record<string, unknown>>('GET', `/docs/${resolvedDocId}`, options);
        return {
          content: [{ type: 'text', text: JSON.stringify(doc) }],
        };
      } catch (err: unknown) {
        return handlePlatformError(err, 'read_doc_outline');
      }
    }

    // Section 正文模式
    let resolvedPosition: number | undefined = position;
    let docLinkHealth: LinkHealth | null | undefined = undefined;

    if (resolvedPosition === undefined && headingPath) {
      // headingPath 但无 position：先取大纲，按 headingPath 匹配找到 position
      try {
        const doc = await client.request<{
          sections?: DocOutlineItem[];
          linkHealth?: LinkHealth | null;
        }>('GET', `/docs/${resolvedDocId}`);
        docLinkHealth = doc.linkHealth;
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

    // position 直接提供时：先取 doc 元数据获取 linkHealth（不为 section 端点返回体自带）
    if (docLinkHealth === undefined) {
      try {
        const doc = await client.request<{ linkHealth?: LinkHealth | null }>(
          'GET',
          `/docs/${resolvedDocId}`,
        );
        docLinkHealth = doc.linkHealth;
      } catch (err: unknown) {
        return handlePlatformError(err, 'read_doc_outline');
      }
    }

    // 读取 section（position 一旦确定即充分定位，不再附 headingPath query——后端 position 优先会忽略它）
    try {
      const section = await client.request<Record<string, unknown>>(
        'GET',
        `/docs/${resolvedDocId}/sections/${resolvedPosition}`,
      );

      // 透传 linkHealth（从 doc 元数据取，section 端点不返回此字段）
      if (docLinkHealth !== undefined) {
        (section as Record<string, unknown>).linkHealth = docLinkHealth;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(section) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'read_doc_section');
    }
  },
};

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 按名解析的共享底座（v1.92.0-dev 抽取）：`spaceName` 三层匹配
 *     （精确 → 前缀 → 子串，大小写不敏感）+ 解析失败信封构造。
 *
 * [代码职责]
 *   - 本文件只承载「空间名解析」这一横切关注点的**单源实现**，供各 DocSpace
 *     语义工具复用，消除同目录内多份逐字拷贝的漂移风险。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/integrations/platform-mcp.md §3（统一错误语义——failedStep/候选信封）
 *   - 补充: 线上 docs/api-definition.md §16.2（GET /doc-spaces 候选来源）
 *
 * [关键不变量]
 *   - 三层匹配语义**逐字冻结**（层序、层内 0/>1 返回规则）——它是各工具
 *     `isError + candidates` 契约的公共前提，改这里等于同时改所有消费工具；
 *   - 层内多命中**返回该层全部**（由调用方判 >1 → 歧义报错），本文件不替调用方
 *     做「静默挑选」；
 *   - `resolutionFailureBody` 只做字段搬运（candidates/options/availableNames/
 *     isAmbiguous/layer），不新增字段——消费方按这些键读。
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/list-docs.ts — 消费方（清单）
 *   - packages/platform-mcp/src/tools/list-doc-tree.ts — 消费方（目录树）
 *   - packages/platform-mcp/src/tools/get-doc-facets.ts — 消费方（空间体检）
 *   - 同目录其余工具（append-doc / create-task / delete-doc 等）仍有本地拷贝，
 *     未纳入本次抽取——迁移时按本文件口径替换即可（勿反向改本文件迁就旧拷贝）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { ToolCallResult } from '@agent-chamber/automcp';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';

/** DocSpace 列表条目（GET /doc-spaces 的最小可用投影；允许携带额外字段） */
export interface DocSpaceListItem {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

/**
 * 三层匹配（大小写不敏感）：
 * ① 精确匹配（ci）
 * ② 前缀匹配（ci）
 * ③ 子串匹配（ci）
 *
 * 取最先产生匹配的那一层。该层内 0 个 → 返回 []，>1 个 → 返回该层全部。
 */
export function matchByLayers<T>(
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

/**
 * 解析失败信封的字段搬运（把挂在校验 Error 上的结构化候选信息摊平进响应体）。
 *
 * 非 Error 输入降级为 `{ message }`；其余字段仅在存在时出现（undefined 由
 * JSON.stringify 自然丢弃）。
 */
export function resolutionFailureBody(err: unknown): Record<string, unknown> {
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

/** `resolveSpaceId` 的结果：成功给 spaceId，失败给可直接返回的 ToolCallResult */
export type SpaceResolution = { ok: true; spaceId: string } | { ok: false; result: ToolCallResult };

/** 构造解析失败信封（isError:true + 结构化字段，JSON 文本体——与既有工具逐字同形） */
function resolutionFailureResult(body: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

/**
 * 解析目标 DocSpace ID（**spaceId 直传优先，否则 spaceName 三层匹配**）。
 *
 * 单源抽取理由（v1.92.0-dev 3 期）：get_doc_facets 引入本模式后，rename_doc_tags /
 * list_orphan_docs 又要各写一遍同样的 ~60 行（拉列表 → 匹配 → 0/>1 报错信封）——正是
 * 本文件存在要消除的逐字拷贝漂移。调用方拿到 `ok:false` 时直接返回 `result` 即可。
 *
 * 失败语义（与既有工具逐字一致）：0 命中 → isError + availableNames；>1 命中 →
 * isError + candidates/layer，**绝不静默挑选**；拉列表失败 → handlePlatformError
 * （保留平台 status/code 保真度）。
 *
 * @param client 平台 API 客户端（仅用于拉取空间列表候选）
 * @param spaceName spaceName 参数（spaceId 缺省时才用）
 * @param spaceId spaceId 参数（UUID 直传，命中即跳过列表拉取）
 * @returns SpaceResolution
 */
export async function resolveSpaceId(
  client: PlatformApiClient,
  spaceName?: unknown,
  spaceId?: unknown,
): Promise<SpaceResolution> {
  const directId = typeof spaceId === 'string' && spaceId.trim() !== '' ? spaceId.trim() : null;
  if (directId) return { ok: true, spaceId: directId };

  const name = typeof spaceName === 'string' ? spaceName : '';
  if (name.trim() === '') {
    const err = Object.assign(new Error('Either spaceName or spaceId must be provided'), {
      isAmbiguous: false,
    });
    return {
      ok: false,
      result: resolutionFailureResult({
        error: true,
        failedStep: 'resolve_space',
        ...resolutionFailureBody(err),
      }),
    };
  }

  let spaces: DocSpaceListItem[];
  try {
    const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
      params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍）
    });
    spaces = resp.items ?? [];
  } catch (err: unknown) {
    return { ok: false, result: handlePlatformError(err, 'list_doc_spaces') };
  }

  const { layer, matches } = matchByLayers(name, spaces, (s) => s.name);

  if (matches.length === 0) {
    const names = spaces.map((s) => s.name);
    const err = Object.assign(
      new Error(
        `spaceName "${name}" did not match any DocSpace. ` +
          `Available spaces: ${names.length > 0 ? names.join(', ') : '(none)'}`,
      ),
      { isAmbiguous: false, availableNames: names },
    );
    return {
      ok: false,
      result: resolutionFailureResult({
        error: true,
        failedStep: 'resolve_space',
        ...resolutionFailureBody(err),
      }),
    };
  }

  if (matches.length > 1) {
    const candidates = matches.map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
    const layerLabel = layer === 1 ? 'exact' : layer === 2 ? 'prefix' : 'substring';
    const err = Object.assign(
      new Error(
        `spaceName "${name}" matched ${matches.length} DocSpaces (${layerLabel}). ` +
          `Please refine: ${candidates.map((c) => c.name).join(', ')}`,
      ),
      { candidates, layer: layerLabel, isAmbiguous: true },
    );
    return {
      ok: false,
      result: resolutionFailureResult({
        error: true,
        failedStep: 'resolve_space',
        ...resolutionFailureBody(err),
      }),
    };
  }

  return { ok: true, spaceId: matches[0].id };
}

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - MCP invocation 上报通道（usage stats D4b）：每次 tools/call 结束后的一次计数上报
 *
 * [代码职责]
 *   - `POST {baseUrl}/system/usage-events` 的 fire-and-forget 发送（不 await、不阻塞工具响应）
 *   - 上报失败的**本侧可见性**：`console.warn` 一行（后端不可达时后端 warn 不执行，
 *     本侧再静默 = 通道双盲，计数丢失将无从发现）
 *   - 凭据 → 请求头的映射（automcp 侧第三份，前两份在 http-proxy / platform-client）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 上报契约（DTO / 202 / 词表）+ 口径专章
 *   - 补充: docs/database.md §api_usage_stats_hourly — 上报行落成的表结构
 *
 * [关键不变量]
 *   - **本函数从不抛异常、从不返回 Promise**：调用点在 tools/call 的关键路径上，
 *     任何 await/throw 都会污染 MCP 响应（fail-open 是上报通道的生存条件）
 *   - 载荷必须落在 DTO 的严格制内（surface 词表 / toolName ≤128 / latencyMs 为非负整数）：
 *     非法载荷 → 400 → 该次调用永久不计（automcp 侧发出的值恒合法，400 即实现缺陷）
 *   - **非 2xx 也要留痕**：只有 transport error 才 warn 会让 401/400 静默丢计数
 *
 * [关联代码]
 *   - server/mcp-server.ts — 唯一调用点（认证解析、无凭据跳过、viaFallbackAuth 判定）
 *   - server/tool-context.ts — 工具名归一化的定义点
 *   - apps/backend/src/modules/usage-stats/usage-events.controller.ts — 服务端受理方
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（是否仍在关键路径上 fail-open）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import axios from 'axios';
import type { AuthConfig } from '../types';

/** 上报端点路径（相对 serve 的 `--base-url`，即 `…/api/v1`） */
const USAGE_EVENTS_PATH = '/system/usage-events';

/**
 * 上报请求超时（5s）
 *
 * 与工具调用无关（fire-and-forget），此值只决定"一次卡住的上报占用 socket 多久"，
 * 刻意远小于 HttpProxy 的 120s——上报不值得为后端抖动长期占用连接。
 */
const REPORT_TIMEOUT_MS = 5_000;

/** 上报载荷（对应后端 `UsageEventDto`；字段名即 wire 契约，不可自行改名） */
export interface UsageEventPayload {
  /** 工具名（≤128，已归一化） */
  toolName: string;
  /** 暴露面（封闭词表 `mcp` / `mcp-full` / `unknown`） */
  surface: string;
  /** 调用成败（true → 2xx，false → 5xx；上报只有两态，无 HTTP 状态可继承） */
  ok: boolean;
  /** 工具执行耗时（ms，非负整数） */
  latencyMs: number;
  /** 仅当走了共享 `--api-key` fallbackAuth 时出现（后端据此落 actor_type='system'） */
  viaFallbackAuth?: boolean;
}

/** 一次上报所需的全部输入 */
export interface UsageReportOptions {
  /** serve 的 `--base-url`（如 `http://localhost:8743/api/v1`） */
  baseUrl: string;
  /** 生效凭据（clientAuth ?? fallbackAuth；调用点已保证非空，否则不上报） */
  auth: AuthConfig;
  /** 工具名（已归一化） */
  toolName: string;
  /** 本实例暴露面 */
  surface: string;
  /** 调用是否成功 */
  ok: boolean;
  /** 工具执行耗时（ms） */
  latencyMs: number;
  /** 本次调用是否走了 fallbackAuth（clientAuth 缺失且有服务端默认认证） */
  viaFallbackAuth: boolean;
}

/**
 * 组装上报载荷
 *
 * `viaFallbackAuth` 只在为 true 时出现（DTO 里是可选字段）：显式发 `false` 语义相同
 * 但徒增噪音，省略即"非 fallback"，与后端 `@IsOptional()` 的默认语义一致。
 *
 * @param options - 上报输入
 * @returns DTO 严格制内的载荷
 */
function buildPayload(options: UsageReportOptions): UsageEventPayload {
  const payload: UsageEventPayload = {
    toolName: options.toolName,
    surface: options.surface,
    ok: options.ok,
    // 非有限值（NaN/Infinity）归 0：@IsInt 会拒掉它们，一次计数不值得因时钟异常丢掉
    latencyMs: Number.isFinite(options.latencyMs) ? Math.max(0, Math.round(options.latencyMs)) : 0,
  };

  if (options.viaFallbackAuth) {
    payload.viaFallbackAuth = true;
  }

  return payload;
}

/**
 * 由 AuthConfig 构造认证头（对齐 http-proxy.buildHeaders 的映射）
 *
 * @param auth - 生效认证配置
 * @returns 认证头集合（无有效凭据时为空对象）
 */
export function buildAuthHeaders(auth: AuthConfig): Record<string, string> {
  switch (auth.type) {
    case 'apiKey': {
      return auth.apiKey !== undefined ? { 'X-API-Key': auth.apiKey } : {};
    }
    case 'bearer': {
      return auth.bearerToken !== undefined ? { Authorization: `Bearer ${auth.bearerToken}` } : {};
    }
    case 'basic': {
      if (auth.username === undefined || auth.password === undefined) {
        return {};
      }
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    }
  }
}

/**
 * 上报一次 MCP 工具调用（fire-and-forget）
 *
 * 本函数立即返回，工具调用的响应不等待上报结果；任何失败（网络、超时、非 2xx）
 * 都只在本侧 `console.warn` 一行留痕，绝不冒泡。
 *
 * @param options - 上报输入（凭据已解析、工具名已归一化）
 * @returns 无（不返回 Promise，调用点无需 void 处理）
 */
export function reportToolInvocation(options: UsageReportOptions): void {
  const url = `${options.baseUrl.replace(/\/$/u, '')}${USAGE_EVENTS_PATH}`;

  void axios({
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(options.auth),
    },
    data: buildPayload(options),
    timeout: REPORT_TIMEOUT_MS,
    // 非 2xx 不抛：状态判断放在 then 里，才能为 401/400 留下 warn（见 [关键不变量]）
    validateStatus: () => true,
  })
    // 本侧留痕是通道可见性的一半：backend 不可达时后端 warn 不执行，本侧再静默
    // 就是"计数丢了但没人知道"。console 在本仓被 lint 禁用（no-console），此处
    // 是刻意的例外——上报失败必须出现在 systemd journal 里。
    .then((response) => {
      if (response.status >= 300) {
        // eslint-disable-next-line no-console
        console.warn(
          `[automcp] usage event rejected (HTTP ${response.status}) for tool "${options.toolName}"`,
        );
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.warn(
        `[automcp] failed to report usage event for tool "${options.toolName}": ${message}`,
      );
    });
}

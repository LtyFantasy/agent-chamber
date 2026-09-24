/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台后端 REST 客户端（平台语义工具的唯一出口）
 *   - 接口调用频率统计：本层是**语义工具**的 MCP 流量头注入点 ②
 *
 * [代码职责]
 *   - axios 封装：信封剥壳 / 4xx-5xx 与网络错误归一化 / 认证头
 *   - `buildHeaders`：额外注入 ALS 上下文带来的 `X-MCP-Tool` / `X-MCP-Surface`
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 两个头契约 + 统计口径专章
 *   - 补充: docs/architecture.md §platform-mcp — 语义工具在链路中的位置
 *
 * [关键不变量]
 *   - **两头注入必须在 `this.auth === undefined` early return 之前**（与 automcp
 *     `http-proxy.buildHeaders` 同一规则）：无认证头不代表不是 MCP 调用
 *   - **ALS helper 必须经包名 `@agent-chamber/automcp` 运行时 import**：生产中两包
 *     解析到同一份 automcp dist，ALS 才是同一实例（V8）。改成相对路径引 src 副本
 *     会得到第二份实例 → store 恒 undefined → 语义工具的流量标识静默消失
 *     （无报错、无日志，且历史数据不可回填）
 *   - 无 ALS 上下文不注头（CLI / 非 MCP 场景）
 *   - **数组 query 参数必须由调用方显式传 `paramsSerializer`**：axios 默认把数组序列化成
 *     `signals[]=a&signals[]=b`（方括号形态，实证见 spec 的真 http server 用例），而后端
 *     经验库等模块的 query-form 守卫**明确 400 拒绝**该形态（不是静默忽略）。API 契约形态 =
 *     重复参数 `signals=a&signals=b`（`serializeRepeatedParams`）。本类不替调用方决定，
 *     因为既有工具（get_my_briefing 的 `statuses`）用逗号拼接形态，全局改默认会波及它们
 *
 * [关联代码]
 *   - packages/automcp/src/server/tool-context.ts — ALS 与头名常量的定义点（运行时依赖）
 *   - packages/automcp/src/proxy/http-proxy.ts — 注入点 ①（原子映射工具）
 *   - platform-client.spec.ts — V8 同一实例断言与两头两态断言
 *   - tools/search-experiences.ts — `paramsSerializer` 的唯一当前消费方（signals/domains 数组）
 *   - apps/backend/src/modules/experience/experience-query-form.ts — 后端侧同一条守卫
 *     （括号形态 400 的判定点，两端语义必须成对理解）
 *
 * [持久踩坑]
 *   EXPERIENCE-BRACKET-ARRAY-QS(数组序列化形态): axios 默认 `signals[]=` 会被 Express 的
 *     qs 解析器归一成合法数组，后端 DTO 层看不见差异，故后端只能在 controller 拿
 *     `req.originalUrl` 原始串拒绝（400）。安全方向: MCP 侧出口显式用
 *     `serializeRepeatedParams` 生成重复参数形态，并用真实 query 串断言钉住（mock 单测
 *     测不出 axios 序列化）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（early return 之前注入是否仍在）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import axios from 'axios';
import {
  MCP_SURFACE_HEADER,
  MCP_TOOL_HEADER,
  getToolContext,
  type AuthConfig,
} from '@agent-chamber/automcp';

/** 后端统一响应信封：{ code, message, data, timestamp, requestId } */
interface Envelope<T = unknown> {
  code: number;
  message: string;
  data: T;
  timestamp?: string;
  requestId?: string;
}

/**
 * Platform API 错误
 *
 * 归一化上游 HTTP 错误与网络错误，对齐 automcp http-proxy.formatErrorResponse 的
 * 结构化格式：{ status, code?, message, details? }。
 */
export class PlatformApiError extends Error {
  /** HTTP 状态码（网络错误时无此字段） */
  public readonly status?: number;
  /** 业务错误码（来自上游 envelope.code） */
  public readonly code?: number | string;
  /** 额外错误详情（来自上游 envelope.data） */
  public readonly details?: unknown;

  constructor(opts: {
    status?: number;
    code?: number | string;
    message: string;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = 'PlatformApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }
}

/**
 * 重复键形态的 query 参数序列化器签名（axios `paramsSerializer` 的函数形态）。
 *
 * axios 收到函数型 `paramsSerializer` 时**原样采用其返回值**作为 query 串
 * （`buildURL`：`serializeFn(params)` → `url + '?' + serializedParams`），
 * 故本签名的返回值就是最终到达服务端的形态。
 */
export type ParamsSerializer = (params: Record<string, unknown>) => string;

/**
 * 把数组参数序列化成**重复键**形态（`signals=a&signals=b`），而非 axios 默认的
 * 方括号形态（`signals[]=a&signals[]=b`）。
 *
 * rationale（后台契约，两端必须成对理解）：平台后端经验库的数组参数契约是重复 query
 * 参数（plan §2 传参协议）。axios 默认形态经 Express 的 qs 解析器归一后与正确形态
 * 在 `req.query` 里**完全无差别**（都是合法数组），所以后端只能拿 `req.originalUrl`
 * 的原始串拒绝（`experience-query-form.ts` 的 400 守卫）——即写错的代价不是"报错"
 * 而是"看起来生效"（若守卫缺失）或"莫名 400"（守卫在位）。MCP 侧因此显式生成正确形态。
 *
 * 编码：`encodeURIComponent` 逐键逐值编码（数组元素各占一个键值对）；`undefined`/`null`
 * 值跳过（与 axios 默认一致——不产出 `key=undefined` 的噪音参数）。
 *
 * @param params - query 参数对象（数组值展开为多对同名键）
 * @returns 形如 `signals=a&signals=b&q=port%20unreachable` 的 query 串（不含 `?`）
 */
export function serializeRepeatedParams(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const encodedKey = encodeURIComponent(key);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        pairs.push(`${encodedKey}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    pairs.push(`${encodedKey}=${encodeURIComponent(String(value))}`);
  }
  return pairs.join('&');
}

/**
 * 后端 API 客户端（axios 封装）
 *
 * - 构造时注入 baseUrl + 可选 auth（透传给每次请求）
 * - 2xx → 剥壳返回 envelope.data（只取业务 payload）
 * - 非 2xx → 归一化为 PlatformApiError（对齐 http-proxy.formatErrorResponse）
 * - 网络错误 → PlatformApiError（message 为 "Request failed: ..."）
 */
export class PlatformApiClient {
  private readonly axiosInstance;

  constructor(
    private readonly baseUrl: string,
    private readonly auth?: AuthConfig,
  ) {
    this.axiosInstance = axios.create({
      baseURL: baseUrl,
      // 120s：与生产 nginx /mcp 的 proxy_read_timeout 120s 对齐
      // （scripts/nginx/agent-chamber.conf location = /mcp）。客户端超时不得超过
      // nginx 上限——否则大写（如 58k patch 全文重建）服务端事务照常提交而响应无人接收；
      // 对齐后先断的只会是 nginx（504，语义明确）。背景事故：Board 任务 7d918c7b。
      timeout: 120_000,
      // 不抛 axios 异常——所有状态码由本类自行处理
      validateStatus: () => true,
    });
  }

  /**
   * 发起 HTTP 请求
   *
   * @param method  - HTTP 方法（GET / POST / PATCH / DELETE）
   * @param path    - API 路径（如 "/agents/me"）
   * @param options - 可选 query params、body 与 query 序列化器
   * @returns 剥壳后的业务 payload（envelope.data）
   * @throws PlatformApiError 当上游返回非 2xx 或发生网络错误
   */
  async request<T>(
    method: string,
    path: string,
    options?: {
      params?: Record<string, unknown>;
      body?: unknown;
      /**
       * 可选：显式 query 序列化器（axios 原样采用其返回值）。
       *
       * **数组参数必传**（用 `serializeRepeatedParams`）——省缺走 axios 默认的
       * 方括号形态，会被后端数组参数守卫 400。非数组参数的调用方无需传。
       */
      paramsSerializer?: ParamsSerializer;
    },
  ): Promise<T> {
    let response;
    try {
      response = await this.axiosInstance.request<Envelope<T>>({
        method,
        url: path,
        params: options?.params,
        data: options?.body,
        // 仅在调用方显式指定时才注入（缺省保持 axios 默认序列化，不动既有工具口径）
        ...(options?.paramsSerializer !== undefined
          ? { paramsSerializer: options.paramsSerializer }
          : {}),
        headers: this.buildHeaders(options?.body !== undefined),
      });
    } catch (err: unknown) {
      // 网络错误（DNS / 连接拒绝 / 超时等）
      const message = err instanceof Error ? err.message : String(err);
      throw new PlatformApiError({ message: `Request failed: ${message}` });
    }

    const { status, statusText, data: body } = response;

    // 2xx：剥壳返回业务 payload
    if (status >= 200 && status < 300) {
      // body 是后端信封 { code, message, data }
      if (body !== null && typeof body === 'object' && 'data' in body) {
        return (body as Envelope<T>).data as T;
      }
      // 防御性：非标准响应直接返回 body
      return body as unknown as T;
    }

    // 非 2xx：归一化为 PlatformApiError（对齐 http-proxy.formatErrorResponse）
    throw this.normalizeError(status, statusText, body);
  }

  /**
   * 构建请求头（对齐 http-proxy.buildHeaders）
   *
   * 三层：Content-Type（有 body 时）→ MCP 流量标识（有 ALS 上下文时）→ 认证头。
   * 标识头位于认证头与 early return **之前**——无认证头不代表不是 MCP 调用。
   *
   * @param hasBody - 是否包含请求体（决定是否加 Content-Type）
   * @returns HTTP 请求头对象
   */
  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};

    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    // MCP 流量标识（usage stats D4）：仅当处于 tools/call 的 ALS 上下文内。
    // 无上下文 = 非 MCP 场景（如离线脚本直用本 client），此时不注头——
    // 注 'unknown' 会把"没有工具语义的调用"伪造成"暴露面不明"。
    const toolContext = getToolContext();
    if (toolContext !== undefined) {
      headers[MCP_TOOL_HEADER] = toolContext.toolName;
      headers[MCP_SURFACE_HEADER] = toolContext.surface;
    }

    if (this.auth === undefined) {
      return headers;
    }

    switch (this.auth.type) {
      case 'apiKey': {
        if (this.auth.apiKey !== undefined) {
          headers['X-API-Key'] = this.auth.apiKey;
        }
        break;
      }
      case 'bearer': {
        if (this.auth.bearerToken !== undefined) {
          headers['Authorization'] = `Bearer ${this.auth.bearerToken}`;
        }
        break;
      }
      case 'basic': {
        if (this.auth.username !== undefined && this.auth.password !== undefined) {
          const encoded = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString(
            'base64',
          );
          headers['Authorization'] = `Basic ${encoded}`;
        }
        break;
      }
    }

    return headers;
  }

  /**
   * 归一化非 2xx 响应为 PlatformApiError
   *
   * 对齐 http-proxy.formatErrorResponse：
   * - 上游含 `message` 字段的结构化信封 → 提取 code/message/data.details
   * - 非结构化上游（纯文本/HTML/无 message 字段）→ 回退状态行 + 原始 body
   *
   * @param status     - HTTP 状态码
   * @param statusText - HTTP 状态文本
   * @param body       - 上游响应体
   * @returns 始终 throw PlatformApiError
   */
  private normalizeError(status: number, statusText: string, body: unknown): never {
    // 结构化业务错误信封（含 message 字段的对象）
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const obj = body as Record<string, unknown>;
      if (typeof obj.message === 'string') {
        throw new PlatformApiError({
          status,
          message: obj.message,
          code: typeof obj.code === 'number' || typeof obj.code === 'string' ? obj.code : undefined,
          details: obj.data !== undefined && obj.data !== null ? obj.data : undefined,
        });
      }
    }

    // 非结构化上游：回退状态行 + 原始 body
    const rawBody =
      body === null ? 'null' : typeof body === 'object' ? JSON.stringify(body) : String(body);
    throw new PlatformApiError({
      status,
      message: `HTTP ${status}: ${statusText}\n${rawBody}`,
    });
  }
}

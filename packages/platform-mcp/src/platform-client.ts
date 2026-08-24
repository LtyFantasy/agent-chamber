/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.2
 *   - 补充: .kimi/plan-mcp-phase2.md §3.3（工具契约中的 client 使用方式）
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

import axios from 'axios';
import type { AuthConfig } from '@agent-chamber/automcp';

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
   * @param options - 可选 query params 与 body
   * @returns 剥壳后的业务 payload（envelope.data）
   * @throws PlatformApiError 当上游返回非 2xx 或发生网络错误
   */
  async request<T>(
    method: string,
    path: string,
    options?: { params?: Record<string, unknown>; body?: unknown },
  ): Promise<T> {
    let response;
    try {
      response = await this.axiosInstance.request<Envelope<T>>({
        method,
        url: path,
        params: options?.params,
        data: options?.body,
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
   * @param hasBody - 是否包含请求体（决定是否加 Content-Type）
   * @returns HTTP 请求头对象
   */
  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};

    if (hasBody) {
      headers['Content-Type'] = 'application/json';
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

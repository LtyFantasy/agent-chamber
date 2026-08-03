/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 2
 *   - 补充: AGENTS.md §7 (关键数字速查)
 *
 * [踩坑索引] -
 *
 * [铁律关联] #7(编译优先) #11(注释强制)
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

import SwaggerParser from '@apidevtools/swagger-parser';
import axios from 'axios';
import type {
  JSONSchema,
  Parameter,
  ParsedOperation,
  RequestBody,
  Response,
  SecurityRequirement,
} from '../types';
import { convertSchemaToInternal, generateOperationId } from '../utils';

/** 支持解析的 HTTP 方法列表 */
const SUPPORTED_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Swagger 2.0 风格的参数对象（已 dereference） */
interface Swagger2Parameter {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  type?: string;
  format?: string;
  schema?: unknown;
  items?: unknown;
  enum?: unknown[];
  'x-nullable'?: boolean;
  nullable?: boolean;
}

/** OpenAPI 3.0 风格的参数对象（已 dereference） */
interface OpenApi3Parameter {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema?: unknown;
}

/** OpenAPI 3.0 requestBody content 项 */
interface OpenApi3MediaType {
  schema?: unknown;
}

/** OpenAPI 3.0 requestBody */
interface OpenApi3RequestBody {
  required?: boolean;
  content?: Record<string, OpenApi3MediaType>;
}

/** OpenAPI 3.0 response */
interface OpenApi3Response {
  description: string;
  content?: Record<string, OpenApi3MediaType>;
}

/** Swagger 2.0 response */
interface Swagger2Response {
  description: string;
  schema?: unknown;
}

/** 统一的操作对象（已 dereference） */
interface UnifiedOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  security?: SecurityRequirement[];
}

/** 统一的 PathItem 对象 */
interface UnifiedPathItem {
  parameters?: unknown[];
  [method: string]: unknown;
}

/**
 * OpenAPI 规范解析器
 *
 * 负责解析并验证 OpenAPI 2.0/3.0/3.1 规范，统一转换为内部 OpenAPI 3.0 表示。
 * 支持从 URL 或本地文件路径加载，自动递归解析 `$ref` 引用。
 */
export class OpenApiParser {
  private readonly specPath: string;

  /**
   * 创建解析器实例
   * @param specPath - OpenAPI spec 的 URL 或本地文件路径
   */
  constructor(specPath: string) {
    this.specPath = specPath;
  }

  /**
   * 解析 OpenAPI 规范，返回统一格式的 operation 列表
   *
   * @returns 解析后的 operation 数组
   * @throws 当 spec 加载失败时抛出错误
   */
  async parse(): Promise<ParsedOperation[]> {
    let api: unknown;

    try {
      api = await SwaggerParser.dereference(this.specPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to dereference OpenAPI spec at "${this.specPath}": ${message}`);
    }

    if (typeof api !== 'object' || api === null) {
      throw new Error(
        `Invalid OpenAPI spec at "${this.specPath}": expected object, got ${typeof api}`,
      );
    }

    const doc = api as Record<string, unknown>;
    const paths = doc.paths;

    if (typeof paths !== 'object' || paths === null) {
      // 无 paths 返回空数组，不报错
      return [];
    }

    const isOpenApi3 = typeof doc.openapi === 'string';
    const operations: ParsedOperation[] = [];

    for (const [path, pathItemRaw] of Object.entries(paths)) {
      if (typeof pathItemRaw !== 'object' || pathItemRaw === null) {
        continue;
      }

      const pathItem = pathItemRaw as UnifiedPathItem;
      const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

      for (const method of SUPPORTED_METHODS) {
        const opRaw = pathItem[method];
        if (typeof opRaw !== 'object' || opRaw === null) {
          continue;
        }

        const op = opRaw as UnifiedOperation;
        const operationId = this.resolveOperationId(op, method, path);

        // 合并 path-level 和 operation-level 参数
        const parameters = this.extractParameters(pathLevelParams, op.parameters ?? [], isOpenApi3);

        const requestBody = this.extractRequestBody(op, isOpenApi3);
        const responses = this.extractResponses(op, isOpenApi3);
        const security = op.security;

        operations.push({
          operationId,
          method,
          path,
          summary: op.summary,
          description: op.description,
          tags: op.tags,
          parameters,
          requestBody,
          responses,
          security,
        });
      }
    }

    return operations;
  }

  /**
   * 从 URL 加载 OpenAPI 规范（JSON/YAML）
   *
   * 此方法仅在需要预加载 spec 内容时使用（如需要自定义 headers）。
   * SwaggerParser.dereference 本身支持 URL，通常不需要手动调用。
   *
   * @param url - 规范的 URL
   * @returns 规范内容字符串
   * @throws 网络错误、HTTP 非 2xx、超时时抛出错误
   */
  private async loadFromUrl(url: string): Promise<string> {
    try {
      const response = await axios.get<string>(url, {
        timeout: 30_000,
        responseType: 'text',
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new Error(`Timeout loading spec from URL "${url}" after 30s`);
        }
        const status = error.response?.status;
        const statusText = error.response?.statusText;
        if (status) {
          throw new Error(`HTTP ${status} ${statusText ?? ''} loading spec from URL "${url}"`);
        }
        throw new Error(`Network error loading spec from URL "${url}": ${error.message}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load spec from URL "${url}": ${message}`);
    }
  }

  /**
   * 解析 operationId：优先使用已有值，否则自动生成
   */
  private resolveOperationId(op: UnifiedOperation, method: string, path: string): string {
    if (op.operationId && typeof op.operationId === 'string') {
      return op.operationId;
    }
    return generateOperationId(method, path);
  }

  /**
   * 提取并合并参数列表，转换为内部 Parameter 格式
   */
  private extractParameters(
    pathLevelParams: unknown[],
    opLevelParams: unknown[],
    isOpenApi3: boolean,
  ): Parameter[] {
    const merged = [...pathLevelParams, ...opLevelParams];
    const result: Parameter[] = [];

    for (const p of merged) {
      if (typeof p !== 'object' || p === null) {
        continue;
      }

      const param = p as Record<string, unknown>;

      // 跳过 body/formData 参数（它们由 requestBody 处理）
      const paramIn = typeof param.in === 'string' ? param.in : '';
      if (paramIn === 'body' || paramIn === 'formData') {
        continue;
      }

      // 只保留 path/query/header
      if (!['path', 'query', 'header'].includes(paramIn)) {
        continue;
      }

      const name = typeof param.name === 'string' ? param.name : '';
      const required = param.required === true;
      const description = typeof param.description === 'string' ? param.description : undefined;

      let schema: JSONSchema;
      if (isOpenApi3) {
        const oa3Param = param as unknown as OpenApi3Parameter;
        schema = convertSchemaToInternal(oa3Param.schema ?? {});
      } else {
        const sw2Param = param as unknown as Swagger2Parameter;
        // Swagger 2.0 非 body 参数的类型直接挂在 parameter 上
        schema = this.swagger2ParamToSchema(sw2Param);
      }

      result.push({
        name,
        in: paramIn as 'path' | 'query' | 'header',
        required,
        schema,
        description,
      });
    }

    return result;
  }

  /**
   * 将 Swagger 2.0 非 body 参数转换为 JSONSchema
   */
  private swagger2ParamToSchema(param: Swagger2Parameter): JSONSchema {
    const schema: JSONSchema = {
      type: param.type ?? 'string',
    };

    if (param.format) {
      schema.format = param.format;
    }
    if (param['x-nullable'] === true || param.nullable === true) {
      schema.nullable = true;
    }
    if (Array.isArray(param.enum)) {
      schema.enum = param.enum;
    }
    if (param.items !== undefined && param.items !== null) {
      schema.items = convertSchemaToInternal(param.items);
    }
    if (typeof param.description === 'string') {
      schema.description = param.description;
    }

    return schema;
  }

  /**
   * 提取请求体定义（OpenAPI 3.0 的 requestBody 或 Swagger 2.0 的 body 参数）
   */
  private extractRequestBody(op: UnifiedOperation, isOpenApi3: boolean): RequestBody | undefined {
    if (isOpenApi3) {
      return this.extractOpenApi3RequestBody(op);
    }
    return this.extractSwagger2RequestBody(op);
  }

  /**
   * 提取 OpenAPI 3.0 requestBody
   */
  private extractOpenApi3RequestBody(op: UnifiedOperation): RequestBody | undefined {
    if (!op.requestBody || typeof op.requestBody !== 'object') {
      return undefined;
    }

    const rb = op.requestBody as OpenApi3RequestBody;
    const content = rb.content;
    if (typeof content !== 'object' || content === null) {
      return undefined;
    }

    // 优先取 application/json，否则取第一个可用的
    const mediaType = content['application/json'] ?? Object.values(content)[0];
    if (!mediaType) {
      return undefined;
    }

    return {
      required: rb.required === true,
      contentType: 'application/json',
      schema: convertSchemaToInternal(mediaType.schema ?? {}),
    };
  }

  /**
   * 提取 Swagger 2.0 body 参数
   */
  private extractSwagger2RequestBody(op: UnifiedOperation): RequestBody | undefined {
    const params = op.parameters ?? [];
    for (const p of params) {
      if (typeof p !== 'object' || p === null) {
        continue;
      }
      const param = p as Record<string, unknown>;
      if (param.in === 'body') {
        return {
          required: param.required === true,
          contentType: 'application/json',
          schema: convertSchemaToInternal(param.schema ?? {}),
        };
      }
    }
    return undefined;
  }

  /**
   * 提取响应定义，优先保留 2xx 响应或第一个有 schema 的响应
   */
  private extractResponses(op: UnifiedOperation, isOpenApi3: boolean): Record<string, Response> {
    const responses = op.responses ?? {};
    const result: Record<string, Response> = {};

    // 先尝试找 2xx 响应
    let targetCode: string | undefined;
    let targetResponse: unknown;

    for (const [code, resp] of Object.entries(responses)) {
      if (code.startsWith('2')) {
        targetCode = code;
        targetResponse = resp;
        break;
      }
    }

    // 如果没有 2xx，取第一个有 schema/content 的
    if (!targetCode) {
      for (const [code, resp] of Object.entries(responses)) {
        if (typeof resp === 'object' && resp !== null) {
          const r = resp as Record<string, unknown>;
          if (r.schema !== undefined || r.content !== undefined) {
            targetCode = code;
            targetResponse = resp;
            break;
          }
        }
      }
    }

    // 兜底：取第一个任意响应
    if (!targetCode) {
      const entries = Object.entries(responses);
      if (entries.length > 0) {
        [targetCode, targetResponse] = entries[0];
      }
    }

    if (targetCode && targetResponse) {
      if (isOpenApi3) {
        result[targetCode] = this.convertOpenApi3Response(targetResponse);
      } else {
        result[targetCode] = this.convertSwagger2Response(targetResponse);
      }
    }

    return result;
  }

  /**
   * 转换 OpenAPI 3.0 响应为内部 Response
   */
  private convertOpenApi3Response(resp: unknown): Response {
    if (typeof resp !== 'object' || resp === null) {
      return { description: '' };
    }

    const r = resp as OpenApi3Response;
    const result: Response = {
      description: r.description ?? '',
    };

    if (r.content && typeof r.content === 'object') {
      const content = r.content as Record<string, OpenApi3MediaType>;
      const mediaType = content['application/json'] ?? Object.values(content)[0];
      if (mediaType?.schema) {
        result.contentType = 'application/json';
        result.schema = convertSchemaToInternal(mediaType.schema);
      }
    }

    return result;
  }

  /**
   * 转换 Swagger 2.0 响应为内部 Response
   */
  private convertSwagger2Response(resp: unknown): Response {
    if (typeof resp !== 'object' || resp === null) {
      return { description: '' };
    }

    const r = resp as Swagger2Response;
    const result: Response = {
      description: r.description ?? '',
    };

    if (r.schema) {
      result.contentType = 'application/json';
      result.schema = convertSchemaToInternal(r.schema);
    }

    return result;
  }
}

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 3
 *   - 补充: .kimi/plans/miss-martian-polaris-superboy.md §核心映射规则
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

import type {
  JSONSchema,
  ParsedOperation,
  Parameter,
  RequestBody,
  ToolDefinition,
  ToolFilterOptions,
  ToolMapping,
  ParamLocation,
} from '../types';
import { toSnakeCase, toWireSchema } from '../utils';

/** 默认排除的内部模块 tags */
const DEFAULT_EXCLUDED_TAGS = ['admin', 'audit', 'monitoring', 'sse'];

/**
 * OpenAPI Operation → MCP Tool 映射器
 *
 * 将解析后的 OpenAPI operation 映射为 MCP tool 定义。
 * 负责参数扁平化、命名转换（camelCase → snake_case）、JSON Schema 生成。
 */
export class ToolMapper {
  /**
   * 将单个 OpenAPI operation 映射为 ToolMapping
   *
   * @param operation - 解析后的 OpenAPI operation
   * @returns Tool 映射结果（含 tool 定义、原始 operation、参数位置映射）
   */
  mapOperation(operation: ParsedOperation): ToolMapping {
    const toolName = toSnakeCase(operation.operationId);
    const description = this.buildDescription(operation);
    const inputSchema = this.buildInputSchema(operation);

    const tool: ToolDefinition = {
      name: toolName,
      description,
      inputSchema,
    };

    return {
      tool,
      operation,
      paramLocations: inputSchema._paramLocations as Record<string, ParamLocation>,
    };
  }

  /**
   * 批量映射所有 operations，应用过滤规则
   *
   * 过滤规则优先级：exclude > include > tags
   * 如果未提供 exclude，默认排除 admin/audit/monitoring/sse 标签的 operation。
   * 映射后自动解决 tool name 冲突（追加 `_{method}` 后缀）。
   *
   * @param operations - 解析后的 operation 数组
   * @param filter - 过滤选项（可选）
   * @returns 过滤并映射后的 ToolMapping 数组
   */
  mapAll(operations: ParsedOperation[], filter?: ToolFilterOptions): ToolMapping[] {
    const filtered = this.applyFilter(operations, filter);
    const mappings = filtered.map((op) => this.mapOperation(op));

    // 解决 tool name 冲突
    const nameCounts = new Map<string, number>();
    for (const mapping of mappings) {
      const name = mapping.tool.name;
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    const nameSeen = new Map<string, number>();
    for (const mapping of mappings) {
      const name = mapping.tool.name;
      const count = nameCounts.get(name) ?? 1;

      if (count > 1) {
        // 有重名，追加 method 后缀
        const suffix = `_${mapping.operation.method.toLowerCase()}`;
        mapping.tool.name = `${name}${suffix}`;
      }

      // 如果追加后仍有冲突（极端情况：同 method 同名），再加数字后缀
      const currentSeen = (nameSeen.get(mapping.tool.name) ?? 0) + 1;
      nameSeen.set(mapping.tool.name, currentSeen);
      if (currentSeen > 1) {
        mapping.tool.name = `${mapping.tool.name}_${currentSeen}`;
      }
    }

    return mappings;
  }

  /**
   * 构建 tool 描述文本
   *
   * 格式：`[{method}] {path} — {summary}`
   * 追加 description、认证提示、tags（如存在）。
   */
  private buildDescription(operation: ParsedOperation): string {
    const parts: string[] = [];

    // 第一行：[METHOD] /path — summary
    const summary = operation.summary ?? 'No summary';
    parts.push(`[${operation.method.toUpperCase()}] ${operation.path} — ${summary}`);

    // 追加 description
    if (operation.description) {
      parts.push(`\n\n${operation.description}`);
    }

    // 追加认证提示
    if (operation.security && operation.security.length > 0) {
      parts.push('\n认证：此操作需要 API Key 或 Bearer Token。');
    }

    // 追加 tags
    if (operation.tags && operation.tags.length > 0) {
      parts.push(`\nTags: ${operation.tags.join(', ')}`);
    }

    return parts.join('');
  }

  /**
   * 构建 inputSchema（JSON Schema object），同时收集参数位置映射。
   *
   * 参数优先级：body > query > path。header 参数不纳入。
   * 重名处理：body 保持原名，query 加 `query_` 前缀，path 加 `path_` 前缀。
   */
  private buildInputSchema(operation: ParsedOperation): JSONSchema & {
    _paramLocations: Record<string, ParamLocation>;
  } {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    const paramLocations: Record<string, ParamLocation> = {};

    // 用于检测名称冲突的集合
    const usedNames = new Set<string>();

    // ─── 1. Body 参数（优先级最高）───
    if (operation.requestBody) {
      this.mergeBodyParams(operation.requestBody, properties, required, paramLocations, usedNames);
    }

    // ─── 2. Query 参数 ──
    const queryParams = operation.parameters.filter((p) => p.in === 'query');
    for (const param of queryParams) {
      this.mergeParam(param, 'query', properties, required, paramLocations, usedNames);
    }

    // ─── 3. Path 参数 ──
    const pathParams = operation.parameters.filter((p) => p.in === 'path');
    for (const param of pathParams) {
      this.mergeParam(param, 'path', properties, required, paramLocations, usedNames);
    }

    // Header 参数：暂不纳入（由 proxy 层的 auth 处理）

    // 输出前统一转为 wire 格式：nullable（OpenAPI 方言）展开为 type: [t, 'null']，
    // 保证 MCP client 收到的是合法 JSON Schema Draft-07
    const wireProperties: Record<string, JSONSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      wireProperties[key] = toWireSchema(value);
    }

    return {
      type: 'object',
      properties: wireProperties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
      _paramLocations: paramLocations,
    };
  }

  /**
   * 合并 body 参数到 inputSchema
   *
   * - 如果 schema.type === 'object' 且有 properties：展开每个 property
   * - 如果 schema 是 primitive 或 array：用 `body` 包装
   */
  private mergeBodyParams(
    requestBody: RequestBody,
    properties: Record<string, JSONSchema>,
    required: string[],
    paramLocations: Record<string, ParamLocation>,
    usedNames: Set<string>,
  ): void {
    const schema = requestBody.schema;

    if (
      schema.type === 'object' &&
      schema.properties &&
      Object.keys(schema.properties).length > 0
    ) {
      // 展开 body object 的 properties
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        properties[key] = propSchema;
        usedNames.add(key);
        paramLocations[key] = { in: 'body', name: key };
      }

      // required
      if (schema.required) {
        for (const req of schema.required) {
          if (!required.includes(req)) {
            required.push(req);
          }
        }
      }
    } else {
      // primitive 或 array：用 `body` 包装
      properties.body = schema;
      usedNames.add('body');
      paramLocations.body = { in: 'body', name: 'body' };
      if (requestBody.required) {
        required.push('body');
      }
    }
  }

  /**
   * 合并单个 path/query 参数到 inputSchema，处理重名
   *
   * 把 OpenAPI 参数描述（description）注入到 JSON Schema 的 description 字段，
   * 使 MCP client 在调用时能看到每个参数的中文/英文说明。
   */
  private mergeParam(
    param: Parameter,
    location: 'path' | 'query',
    properties: Record<string, JSONSchema>,
    required: string[],
    paramLocations: Record<string, ParamLocation>,
    usedNames: Set<string>,
  ): void {
    let name = param.name;

    // 重名处理
    if (usedNames.has(name)) {
      const prefix = location === 'query' ? 'query_' : 'path_';
      name = `${prefix}${name}`;
    }

    usedNames.add(name);

    // 将 Parameter.description 透传到 schema，优先使用参数自身描述
    const schemaWithDescription: JSONSchema = {
      ...param.schema,
      description: param.description ?? param.schema.description,
    };
    properties[name] = schemaWithDescription;

    paramLocations[name] = { in: location, name: param.name };

    if (param.required) {
      required.push(name);
    }
  }

  /**
   * 应用过滤规则到 operation 列表
   */
  private applyFilter(
    operations: ParsedOperation[],
    filter?: ToolFilterOptions,
  ): ParsedOperation[] {
    return operations.filter((op) => {
      const snakeCaseId = toSnakeCase(op.operationId);

      // 1. exclude（优先级最高）
      const excludePatterns = filter?.exclude;
      if (excludePatterns && excludePatterns.length > 0) {
        if (matchesAnyPattern(snakeCaseId, excludePatterns)) {
          return false;
        }
      }

      // 默认排除内部模块（仅当用户未显式提供 exclude 时）
      if (!excludePatterns || excludePatterns.length === 0) {
        const opTags = (op.tags ?? []).map((t) => t.toLowerCase());
        const hasExcludedTag = DEFAULT_EXCLUDED_TAGS.some((tag) =>
          opTags.includes(tag.toLowerCase()),
        );
        if (hasExcludedTag) {
          return false;
        }
      }

      // 2. include
      if (filter?.include && filter.include.length > 0) {
        if (!matchesAnyPattern(snakeCaseId, filter.include)) {
          return false;
        }
      }

      // 3. tags（大小写不敏感）
      if (filter?.tags && filter.tags.length > 0) {
        const opTags = (op.tags ?? []).map((t) => t.toLowerCase());
        const filterTags = filter.tags.map((t) => t.toLowerCase());
        const hasMatchingTag = filterTags.some((tag) => opTags.includes(tag));
        if (!hasMatchingTag) {
          return false;
        }
      }

      return true;
    });
  }
}

/**
 * 检查字符串是否匹配任一正则 pattern
 *
 * 导出供生产过滤与 profile 防回归 spec（profile-files.spec.ts）共用同一实现，
 * 杜绝 spec 手写匹配逻辑与生产逻辑双实现漂移。
 *
 * @param str - 待匹配字符串（snake_case 工具名/operationId）
 * @param patterns - 正则 pattern 数组
 * @returns 任一 pattern 命中返回 true；非法正则静默视为不匹配
 */
export function matchesAnyPattern(str: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      const regex = new RegExp(pattern);
      return regex.test(str);
    } catch {
      // 无效正则视为不匹配
      return false;
    }
  });
}

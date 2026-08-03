import type { JSONSchema } from './types';

/**
 * 将 camelCase / PascalCase 字符串转换为 snake_case
 *
 * @param str - 原始字符串
 * @returns snake_case 格式字符串
 */
export function toSnakeCase(str: string): string {
  return (
    str
      // 处理大写字母前插入下划线（如 ABCDef → abc_def）
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      // 处理小写后接大写（如 abcDef → abc_def）
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase()
      // 清理连续下划线
      .replace(/_+/g, '_')
      // 去除首尾下划线
      .replace(/^_|_$/g, '')
  );
}

/**
 * 从路径和 HTTP 方法生成 operationId
 *
 * @param method - HTTP 方法（小写）
 * @param path - API 路径
 * @returns 生成的 operationId
 */
export function generateOperationId(method: string, path: string): string {
  // 将路径中的 / 替换为 _，去掉 {} 和参数前缀字符
  const pathSlug = path
    .replace(/^\//, '')
    .replace(/\//g, '_')
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${method}_${pathSlug || 'root'}`;
}

/**
 * 提取 OpenAPI schema 对象中的核心字段，转换为内部 JSONSchema 格式。
 * 已 dereference 的 spec 不应再包含 $ref，因此忽略该字段。
 *
 * @param schema - OpenAPI schema 对象（可能是原始对象或已 dereference）
 * @returns 内部 JSONSchema 表示
 */
export function convertSchemaToInternal(schema: unknown): JSONSchema {
  if (typeof schema !== 'object' || schema === null) {
    // 无法识别的 schema，返回最宽松的 string 类型
    return { type: 'string' };
  }

  const s = schema as Record<string, unknown>;

  // 提取类型：OpenAPI 3.0 可能省略 type（此时默认 object），Swagger 2.0 有 type。
  // 注意：NestJS Swagger 对 TS 联合类型（如 string|null）推导失败时完全不产出 type，
  // 一律回退 object 会把标量字段错误暴露为 object（外部 Agent 无法传参）。
  // 安全网：缺 type 但存在 enum 时，按 enum 值的运行时类型推断（全 string → string 等）。
  let type = typeof s.type === 'string' ? s.type : '';
  if (!type && s.properties) {
    type = 'object';
  }
  if (!type && Array.isArray(s.enum)) {
    const nonNullValue = (s.enum as unknown[]).find((v) => v !== null);
    if (nonNullValue !== undefined) {
      const t = typeof nonNullValue;
      // typeof object 的 enum 值（数组/对象字面量）不推断，保持 object 回退
      if (t === 'string' || t === 'number' || t === 'boolean') {
        type = t;
      }
    }
  }
  if (!type) {
    type = 'object';
  }

  const result: JSONSchema = {
    type,
  };

  if (typeof s.description === 'string') {
    result.description = s.description;
  }
  if (typeof s.format === 'string') {
    result.format = s.format;
  }

  // nullable / x-nullable（内部表示；输出 MCP wire 时由 toWireSchema 展开为 type 数组）
  if (s.nullable === true || s['x-nullable'] === true) {
    result.nullable = true;
  }

  // required
  if (Array.isArray(s.required)) {
    result.required = s.required.filter((r): r is string => typeof r === 'string');
  }

  // enum
  if (Array.isArray(s.enum)) {
    result.enum = s.enum;
    // enum 显式包含 null 等价于 nullable（OpenAPI 3.1 风格）
    if ((s.enum as unknown[]).includes(null)) {
      result.nullable = true;
    }
  }

  // properties — 递归转换
  if (typeof s.properties === 'object' && s.properties !== null) {
    const props: Record<string, JSONSchema> = {};
    for (const [key, value] of Object.entries(s.properties)) {
      props[key] = convertSchemaToInternal(value);
    }
    result.properties = props;
  }

  // items — 递归转换
  if (s.items !== undefined && s.items !== null) {
    result.items = convertSchemaToInternal(s.items);
  }

  // allOf 合并：NestJS Swagger 常见模式——用 allOf 包装 $ref 附加 description。
  // dereference 后 $ref 已展开为内联 schema，此时 allOf 语义等价于属性/约束合并。
  // 选择合并而非透传：LLM client 对扁平 schema 理解更好，不需要解析组合关键字。
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) {
      const converted = convertSchemaToInternal(branch);

      // 合并 properties（浅合并；冲突时后分支覆盖前分支——此策略覆盖 NestJS Swagger 多分支场景）
      if (converted.properties) {
        if (!result.properties) result.properties = {};
        Object.assign(result.properties, converted.properties);
      }

      // 合并 required 去重
      if (converted.required) {
        if (!result.required) result.required = [];
        for (const r of converted.required) {
          if (!result.required.includes(r)) result.required.push(r);
        }
      }

      // type：若原 schema 无显式 type（type 来自回退），采用分支 type
      if (typeof s.type !== 'string' && typeof converted.type === 'string') {
        result.type = converted.type;
      }

      // 以下字段仅在 result 没有时才从分支补（平级显式字段优先于分支）
      if (converted.enum && !result.enum) result.enum = converted.enum;
      if (converted.description && !result.description) result.description = converted.description;
      if (converted.format && !result.format) result.format = converted.format;
      if (converted.nullable && !result.nullable) result.nullable = converted.nullable;

      // oneOf/anyOf 透传合并（分支的 oneOf/anyOf 合并到 result）
      if (converted.oneOf && !result.oneOf) result.oneOf = converted.oneOf;
      if (converted.anyOf && !result.anyOf) result.anyOf = converted.anyOf;
    }
  }

  // oneOf 透传：分支递归转换后保留，框架级支持（当前无实际用例但保持完整）
  if (Array.isArray(s.oneOf)) {
    result.oneOf = s.oneOf.map((b) => convertSchemaToInternal(b));
  }

  // anyOf 透传：同上，分支递归转换后保留
  if (Array.isArray(s.anyOf)) {
    result.anyOf = s.anyOf.map((b) => convertSchemaToInternal(b));
  }

  // additionalProperties boolean 透传：object 形式（如 { type: 'string' }）忽略不透传，
  // 简化为缺省允许——当前业务不需要精确控制额外属性的 schema 定义
  if (typeof s.additionalProperties === 'boolean') {
    result.additionalProperties = s.additionalProperties;
  }

  return result;
}

/**
 * 将内部 JSONSchema 转换为输出给 MCP client 的 wire 格式（合法 JSON Schema Draft-07）。
 *
 * 关键转换：`nullable: true`（OpenAPI 方言，非法 JSON Schema，MCP client 会静默忽略）
 * 展开为 `type: [<原类型>, 'null']`；递归处理 properties / items。
 * 输入对象不被修改，返回新对象。
 *
 * @param schema - 内部 JSONSchema
 * @returns wire 格式 JSONSchema
 */
export function toWireSchema(schema: JSONSchema): JSONSchema {
  const wire: JSONSchema = { ...schema };

  if (wire.nullable) {
    const baseType = Array.isArray(wire.type) ? wire.type : [wire.type];
    wire.type = baseType.includes('null') ? baseType : [...baseType, 'null'];
    delete wire.nullable;
  }

  if (wire.properties) {
    const props: Record<string, JSONSchema> = {};
    for (const [key, value] of Object.entries(wire.properties)) {
      props[key] = toWireSchema(value);
    }
    wire.properties = props;
  }

  if (wire.items) {
    wire.items = toWireSchema(wire.items);
  }

  // oneOf/anyOf 分支递归展开 nullable（与 properties/items 相同处理模式）
  // allOf 不会出现在内部表示中（已在 convertSchemaToInternal 中合并消化），无需处理
  if (wire.oneOf) {
    wire.oneOf = wire.oneOf.map((b) => toWireSchema(b));
  }
  if (wire.anyOf) {
    wire.anyOf = wire.anyOf.map((b) => toWireSchema(b));
  }

  return wire;
}

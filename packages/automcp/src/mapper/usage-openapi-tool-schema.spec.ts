/**
 * Usage MCP 工具面 —— **真实后端 OpenAPI 快照 → 解析 → ToolMapper inputSchema**。
 *
 * 与 `tool-mapper.spec.ts` 的合成 `ParsedOperation` 测试互补：
 * - 合成测试保证 mapper 的映射规则；
 * - 本文件从 `apps/backend/config/openapi-usage.json`（由真实 `MemoryController` +
 *   DTO 生成、并被 backend `memory-usage.openapi.spec.ts` 逐字比对的快照）解析，
 *   保证 **DTO/装饰器 → OpenAPI → MCP inputSchema** 三段不漂移。
 *
 * 断言面：两个工具名、inputSchema 精确属性/类型/limit 1–200/cursor 4096、
 * `additionalProperties:false`、无 `scope`/`workspaceId`/`actorId`/`body`、summary 无分页键。
 */
import path from 'path';
import { OpenApiParser } from '../parser/openapi-parser';
import { ToolMapper } from './tool-mapper';
import type { ParsedOperation } from '../types';

/** 真实后端生成的 usage OpenAPI 快照（只含两条 path） */
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../apps/backend/config/openapi-usage.json'
);

describe('usage MCP inputSchema（真实 OpenAPI 快照）', () => {
  let operations: ParsedOperation[];

  beforeAll(async () => {
    operations = await new OpenApiParser(FIXTURE_PATH).parse();
  });

  /** 按 operationId 取真实解析产物 */
  function operationOf(operationId: string): ParsedOperation {
    const operation = operations.find((entry) => entry.operationId === operationId);
    if (!operation) throw new Error(`operation not found: ${operationId}`);
    return operation;
  }

  it('summary：真实 OpenAPI → memory_controller_get_usage_summary，schema 只有过滤器+时间窗', () => {
    const mapping = new ToolMapper().mapOperation(
      operationOf('MemoryController_getUsageSummary')
    );

    expect(mapping.tool.name).toBe('memory_controller_get_usage_summary');
    const schema = mapping.tool.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ['id', 'model', 'operation', 'providerOperation', 'since', 'until'].sort()
    );
    for (const forbidden of ['scope', 'workspaceId', 'actorId', 'body', 'limit', 'cursor']) {
      expect(Object.keys(schema.properties ?? {})).not.toContain(forbidden);
    }
    const properties = schema.properties as unknown as Record<string, Record<string, unknown>>;
    expect(properties.operation.type).toBe('string');
    expect(properties.providerOperation.type).toBe('string');
    expect(properties.model.type).toBe('string');
    expect(properties.since.type).toBe('string');
    expect(properties.until.type).toBe('string');
  });

  it('trace：真实 OpenAPI → memory_controller_get_usage_trace，limit integer 1–200 / cursor string 4096', () => {
    const mapping = new ToolMapper().mapOperation(
      operationOf('MemoryController_getUsageTrace')
    );

    expect(mapping.tool.name).toBe('memory_controller_get_usage_trace');
    const schema = mapping.tool.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ['cursor', 'id', 'limit', 'model', 'operation', 'providerOperation', 'since', 'until'].sort()
    );
    for (const forbidden of ['scope', 'workspaceId', 'actorId', 'body']) {
      expect(Object.keys(schema.properties ?? {})).not.toContain(forbidden);
    }
    const properties = schema.properties as unknown as Record<string, Record<string, unknown>>;
    expect(properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
    expect(properties.cursor).toMatchObject({ type: 'string', maxLength: 4096 });
  });
});

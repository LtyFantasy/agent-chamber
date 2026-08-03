import { ToolMapper } from './tool-mapper';
import type { ParsedOperation } from '../types';

describe('ToolMapper', () => {
  let mapper: ToolMapper;

  beforeEach(() => {
    mapper = new ToolMapper();
  });

  /**
   * 辅助函数：创建基础 ParsedOperation
   */
  function makeOperation(overrides: Partial<ParsedOperation> = {}): ParsedOperation {
    return {
      operationId: 'testOperation',
      method: 'post',
      path: '/test',
      summary: 'Test summary',
      description: undefined,
      tags: [],
      parameters: [],
      requestBody: undefined,
      responses: {},
      security: undefined,
      ...overrides,
    };
  }

  describe('mapOperation() — 基本映射', () => {
    it('should map a basic operation to tool with correct name/description/inputSchema', () => {
      const op = makeOperation({
        operationId: 'createTopic',
        method: 'post',
        path: '/topics',
        summary: '创建话题',
        description: '创建一个新的话题讨论空间。',
        tags: ['Topics'],
        security: [{ apiKey: [] }],
      });

      const mapping = mapper.mapOperation(op);

      expect(mapping.tool.name).toBe('create_topic');
      expect(mapping.tool.description).toBe(
        '[POST] /topics — 创建话题\n\n创建一个新的话题讨论空间。\n认证：此操作需要 API Key 或 Bearer Token。\nTags: Topics'
      );
      expect(mapping.tool.inputSchema.type).toBe('object');
      expect(mapping.tool.inputSchema.properties).toEqual({});
      expect(mapping.tool.inputSchema.additionalProperties).toBe(false);
      expect(mapping.operation).toBe(op);
      expect(mapping.paramLocations).toEqual({});
    });

    it('should handle operation without summary/description/tags/security', () => {
      const op = makeOperation({
        operationId: 'healthCheck',
        method: 'get',
        path: '/health',
        summary: undefined,
      });

      const mapping = mapper.mapOperation(op);

      expect(mapping.tool.name).toBe('health_check');
      expect(mapping.tool.description).toBe('[GET] /health — No summary');
    });
  });

  describe('mapOperation() — snake_case 转换', () => {
    it('should convert camelCase operationId to snake_case', () => {
      const op = makeOperation({ operationId: 'getUserProfile' });
      const mapping = mapper.mapOperation(op);
      expect(mapping.tool.name).toBe('get_user_profile');
    });

    it('should convert PascalCase operationId to snake_case', () => {
      const op = makeOperation({ operationId: 'AuthController_register' });
      const mapping = mapper.mapOperation(op);
      expect(mapping.tool.name).toBe('auth_controller_register');
    });
  });

  describe('mapOperation() — Body 参数处理', () => {
    it('should expand body object properties into inputSchema', () => {
      const op = makeOperation({
        operationId: 'createUser',
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string', format: 'email' },
              age: { type: 'integer' },
            },
            required: ['name', 'email'],
          },
        },
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      expect(schema.properties).toBeDefined();
      expect(schema.properties!.name).toEqual({ type: 'string' });
      expect(schema.properties!.email).toEqual({ type: 'string', format: 'email' });
      expect(schema.properties!.age).toEqual({ type: 'integer' });
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('email');
      expect(schema.required).not.toContain('age');

      expect(mapping.paramLocations.name).toEqual({ in: 'body', name: 'name' });
      expect(mapping.paramLocations.email).toEqual({ in: 'body', name: 'email' });
    });

    it('should wrap primitive body schema in a "body" property', () => {
      const op = makeOperation({
        operationId: 'echoString',
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: { type: 'string' },
        },
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      expect(schema.properties!.body).toEqual({ type: 'string' });
      expect(schema.required).toContain('body');
      expect(mapping.paramLocations.body).toEqual({ in: 'body', name: 'body' });
    });

    it('should wrap array body schema in a "body" property', () => {
      const op = makeOperation({
        operationId: 'batchCreate',
        requestBody: {
          required: false,
          contentType: 'application/json',
          schema: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      expect(schema.properties!.body).toBeDefined();
      expect(schema.properties!.body.type).toBe('array');
      expect(schema.required).toBeUndefined();
      expect(mapping.paramLocations.body).toEqual({ in: 'body', name: 'body' });
    });

    it('should handle empty body object (no properties) as wrapped body', () => {
      const op = makeOperation({
        operationId: 'emptyBody',
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: { type: 'object' },
        },
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      // type: 'object' 但没有 properties，按 primitive 处理 → 包装为 body
      expect(schema.properties!.body).toEqual({ type: 'object' });
      expect(mapping.paramLocations.body).toEqual({ in: 'body', name: 'body' });
    });
  });

  describe('mapOperation() — Query 参数合并', () => {
    it('should merge query params into inputSchema', () => {
      const op = makeOperation({
        operationId: 'listItems',
        method: 'get',
        parameters: [
          {
            name: 'page',
            in: 'query',
            required: false,
            schema: { type: 'integer' },
          },
          {
            name: 'limit',
            in: 'query',
            required: true,
            schema: { type: 'integer' },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      expect(schema.properties!.page).toEqual({ type: 'integer' });
      expect(schema.properties!.limit).toEqual({ type: 'integer' });
      expect(schema.required).toEqual(['limit']);
      expect(mapping.paramLocations.page).toEqual({ in: 'query', name: 'page' });
      expect(mapping.paramLocations.limit).toEqual({ in: 'query', name: 'limit' });
    });

    it('should preserve query param description in inputSchema', () => {
      const op = makeOperation({
        operationId: 'listItems',
        method: 'get',
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            description: '状态过滤，可选值：active, closed',
            schema: { type: 'string' },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);

      expect(mapping.tool.inputSchema.properties!.status).toEqual({
        type: 'string',
        description: '状态过滤，可选值：active, closed',
      });
    });
  });

  describe('mapOperation() — Path 参数合并', () => {
    it('should merge path params into inputSchema', () => {
      const op = makeOperation({
        operationId: 'getUserById',
        method: 'get',
        path: '/users/{id}',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      expect(schema.properties!.id).toEqual({ type: 'string' });
      expect(schema.required).toEqual(['id']);
      expect(mapping.paramLocations.id).toEqual({ in: 'path', name: 'id' });
    });
  });

  describe('mapOperation() — 重名处理', () => {
    it('should add query_ prefix when query param conflicts with body property', () => {
      const op = makeOperation({
        operationId: 'updateStatus',
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['active', 'inactive'] },
            },
          },
        },
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      // body 的 status 保留原名
      expect(schema.properties!.status).toEqual({
        type: 'string',
        enum: ['active', 'inactive'],
      });
      // query 的 status 加前缀
      expect(schema.properties!.query_status).toEqual({ type: 'string' });

      expect(mapping.paramLocations.status).toEqual({ in: 'body', name: 'status' });
      expect(mapping.paramLocations.query_status).toEqual({ in: 'query', name: 'status' });
    });

    it('should add path_ prefix when path param conflicts with body property', () => {
      const op = makeOperation({
        operationId: 'updateItem',
        path: '/items/{id}',
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      expect(schema.properties!.id).toEqual({ type: 'string' });
      expect(schema.properties!.path_id).toEqual({ type: 'string' });
      expect(schema.required).toContain('path_id');
      expect(mapping.paramLocations.id).toEqual({ in: 'body', name: 'id' });
      expect(mapping.paramLocations.path_id).toEqual({ in: 'path', name: 'id' });
    });

    it('should add path_ prefix when path param conflicts with query param', () => {
      const op = makeOperation({
        operationId: 'getItem',
        method: 'get',
        path: '/items/{id}',
        parameters: [
          {
            name: 'id',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      // query 先处理，保留 id
      expect(schema.properties!.id).toEqual({ type: 'string' });
      expect(schema.properties!.path_id).toEqual({ type: 'string' });
      expect(mapping.paramLocations.id).toEqual({ in: 'query', name: 'id' });
      expect(mapping.paramLocations.path_id).toEqual({ in: 'path', name: 'id' });
    });
  });

  describe('mapOperation() — 无参数 operation', () => {
    it('should produce empty properties when operation has no params', () => {
      const op = makeOperation({
        operationId: 'healthCheck',
        method: 'get',
        path: '/health',
      });

      const mapping = mapper.mapOperation(op);
      const schema = mapping.tool.inputSchema;

      expect(schema.properties).toEqual({});
      expect(schema.required).toBeUndefined();
      expect(schema.additionalProperties).toBe(false);
    });
  });

  describe('mapOperation() — Header 参数', () => {
    it('should skip header parameters in inputSchema', () => {
      const op = makeOperation({
        operationId: 'someOp',
        parameters: [
          {
            name: 'X-Custom-Header',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);
      expect(mapping.tool.inputSchema.properties).toEqual({});
      expect(Object.keys(mapping.paramLocations)).toHaveLength(0);
    });
  });

  describe('mapAll() — 过滤', () => {
    const ops: ParsedOperation[] = [
      makeOperation({ operationId: 'listTopics', method: 'get', tags: ['Topics'] }),
      makeOperation({ operationId: 'createTopic', method: 'post', tags: ['Topics'] }),
      makeOperation({ operationId: 'deleteTopic', method: 'delete', tags: ['Topics', 'Admin'] }),
      makeOperation({ operationId: 'getAuditLog', method: 'get', tags: ['Audit'] }),
      makeOperation({ operationId: 'getHealth', method: 'get', tags: ['Monitoring'] }),
      makeOperation({ operationId: 'subscribeSse', method: 'get', tags: ['SSE'] }),
      makeOperation({ operationId: 'sendMessage', method: 'post', tags: ['Messages'] }),
    ];

    it('should filter by tags (case-insensitive)', () => {
      const mappings = mapper.mapAll(ops, { tags: ['topics'] });
      const names = mappings.map((m) => m.tool.name);
      // delete_topic 因含 Admin tag 被默认排除
      expect(names).toEqual(['list_topics', 'create_topic']);
    });

    it('should filter by include patterns', () => {
      const mappings = mapper.mapAll(ops, { include: ['topic'] });
      const names = mappings.map((m) => m.tool.name);
      expect(names).toContain('list_topics');
      expect(names).toContain('create_topic');
      expect(names).not.toContain('send_message');
    });

    it('should filter by exclude patterns', () => {
      const mappings = mapper.mapAll(ops, { exclude: ['delete'] });
      const names = mappings.map((m) => m.tool.name);
      expect(names).not.toContain('delete_topic');
      expect(names).toContain('list_topics');
    });

    it('should exclude has higher priority than include', () => {
      const mappings = mapper.mapAll(ops, {
        include: ['topic'],
        exclude: ['delete'],
      });
      const names = mappings.map((m) => m.tool.name);
      expect(names).toContain('list_topics');
      expect(names).toContain('create_topic');
      expect(names).not.toContain('delete_topic');
    });

    it('should default exclude admin/audit/monitoring/sse tags', () => {
      const mappings = mapper.mapAll(ops);
      const names = mappings.map((m) => m.tool.name);
      expect(names).not.toContain('get_audit_log');
      expect(names).not.toContain('get_health');
      expect(names).not.toContain('subscribe_sse');
      expect(names).toContain('list_topics');
      expect(names).toContain('send_message');
    });

    it('should not apply default exclusion when user provides explicit exclude', () => {
      const mappings = mapper.mapAll(ops, { exclude: ['nothing_matching'] });
      const names = mappings.map((m) => m.tool.name);
      // 用户显式提供了 exclude，不再默认排除
      expect(names).toContain('get_audit_log');
      expect(names).toContain('get_health');
      expect(names).toContain('subscribe_sse');
    });
  });

  describe('mapAll() — Tool name 冲突解决', () => {
    it('should append method suffix when two operations map to same name', () => {
      const ops: ParsedOperation[] = [
        makeOperation({ operationId: 'doSomething', method: 'get', path: '/a' }),
        makeOperation({ operationId: 'doSomething', method: 'post', path: '/b' }),
      ];

      const mappings = mapper.mapAll(ops);
      const names = mappings.map((m) => m.tool.name).sort();
      expect(names).toEqual(['do_something_get', 'do_something_post']);
    });

    it('should append numeric suffix for extreme same-method-same-name case', () => {
      const ops: ParsedOperation[] = [
        makeOperation({ operationId: 'doSomething', method: 'get', path: '/a' }),
        makeOperation({ operationId: 'doSomething', method: 'get', path: '/b' }),
      ];

      const mappings = mapper.mapAll(ops);
      const names = mappings.map((m) => m.tool.name).sort();
      expect(names).toEqual(['do_something_get', 'do_something_get_2']);
    });
  });

  describe('mapOperation() — 描述构建', () => {
    it('should include auth notice when security is present', () => {
      const op = makeOperation({
        operationId: 'secureOp',
        security: [{ bearerAuth: [] }],
      });
      const mapping = mapper.mapOperation(op);
      expect(mapping.tool.description).toContain('认证：此操作需要 API Key 或 Bearer Token。');
    });

    it('should not include auth notice when security is absent or empty', () => {
      const op1 = makeOperation({ operationId: 'openOp' });
      const op2 = makeOperation({ operationId: 'emptySec', security: [] });

      expect(mapper.mapOperation(op1).tool.description).not.toContain('认证');
      expect(mapper.mapOperation(op2).tool.description).not.toContain('认证');
    });
  });

  describe('mapOperation() — nullable 字段 wire 转换', () => {
    // 回归：nullable 是 OpenAPI 方言，非法 JSON Schema，MCP client 会静默忽略；
    // 输出到 wire 时必须展开为 type: [t, 'null']
    it('should convert nullable body param to type array on the wire', () => {
      const op = makeOperation({
        operationId: 'assignTask',
        requestBody: {
          required: false,
          contentType: 'application/json',
          schema: {
            type: 'object',
            properties: {
              assigneeId: { type: 'string', nullable: true },
              append: { type: 'boolean' },
            },
          },
        },
      });

      const mapping = mapper.mapOperation(op);
      const props = mapping.tool.inputSchema.properties!;
      expect(props.assigneeId.type).toEqual(['string', 'null']);
      expect(props.assigneeId.nullable).toBeUndefined();
      // 非 nullable 字段保持原样
      expect(props.append).toEqual({ type: 'boolean' });
    });

    it('should convert nullable query param to type array on the wire', () => {
      const op = makeOperation({
        operationId: 'listThings',
        method: 'get',
        parameters: [
          {
            name: 'assigneeId',
            in: 'query',
            required: false,
            schema: { type: 'string', nullable: true },
          },
        ],
      });

      const mapping = mapper.mapOperation(op);
      const props = mapping.tool.inputSchema.properties!;
      expect(props.assigneeId.type).toEqual(['string', 'null']);
      expect(props.assigneeId.nullable).toBeUndefined();
    });

    it('should recursively convert nullable inside nested properties/items', () => {
      const op = makeOperation({
        operationId: 'nestedOp',
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: {
            type: 'object',
            properties: {
              config: {
                type: 'object',
                properties: {
                  note: { type: 'string', nullable: true },
                },
              },
              tags: {
                type: 'array',
                items: { type: 'string', nullable: true },
              },
            },
          },
        },
      });

      const mapping = mapper.mapOperation(op);
      const props = mapping.tool.inputSchema.properties!;
      expect(props.config.properties!.note.type).toEqual(['string', 'null']);
      expect(props.tags.items!.type).toEqual(['string', 'null']);
    });
  });
});

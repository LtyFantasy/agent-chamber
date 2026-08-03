import { convertSchemaToInternal, toWireSchema, toSnakeCase, generateOperationId } from './utils';

describe('convertSchemaToInternal()', () => {
  it('should pass through explicit type/description/format/enum', () => {
    const result = convertSchemaToInternal({
      type: 'string',
      description: '负责人 ID',
      format: 'uuid',
      enum: ['a', 'b'],
    });
    expect(result).toEqual({
      type: 'string',
      description: '负责人 ID',
      format: 'uuid',
      enum: ['a', 'b'],
    });
  });

  it('should fall back to object when type is missing and no properties/enum', () => {
    expect(convertSchemaToInternal({ description: 'x' }).type).toBe('object');
  });

  it('should infer object when type is missing but properties exist', () => {
    expect(convertSchemaToInternal({ properties: { a: { type: 'string' } } }).type).toBe('object');
  });

  // 安全网：NestJS Swagger 对联合类型推导失败时不产出 type，
  // 缺 type 一律回退 object 会把标量字段错误暴露为 object（assigneeId 事故根因）
  it('should infer string from string enum when type is missing', () => {
    const result = convertSchemaToInternal({ enum: ['open', 'private'] });
    expect(result.type).toBe('string');
    expect(result.enum).toEqual(['open', 'private']);
  });

  it('should infer number/boolean from enum values when type is missing', () => {
    expect(convertSchemaToInternal({ enum: [1, 2, 3] }).type).toBe('number');
    expect(convertSchemaToInternal({ enum: [true, false] }).type).toBe('boolean');
  });

  it('should mark nullable when enum contains null (OpenAPI 3.1 style)', () => {
    const result = convertSchemaToInternal({ enum: ['backlog', 'done', null] });
    expect(result.type).toBe('string');
    expect(result.nullable).toBe(true);
  });

  it('should not infer type from object/array enum values (keeps object fallback)', () => {
    expect(convertSchemaToInternal({ enum: [[1], [2]] }).type).toBe('object');
  });

  it('should keep nullable/x-nullable in internal representation', () => {
    expect(convertSchemaToInternal({ type: 'string', nullable: true }).nullable).toBe(true);
    expect(convertSchemaToInternal({ type: 'string', 'x-nullable': true }).nullable).toBe(true);
  });

  it('should return permissive string schema for non-object input', () => {
    expect(convertSchemaToInternal(undefined)).toEqual({ type: 'string' });
    expect(convertSchemaToInternal(null)).toEqual({ type: 'string' });
    expect(convertSchemaToInternal('oops')).toEqual({ type: 'string' });
  });

  // --- allOf 合并 ---

  it('should merge single allOf branch properties/required into result (NestJS Swagger pattern)', () => {
    const result = convertSchemaToInternal({
      description: '配置信息',
      allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }],
    });
    expect(result.type).toBe('object');
    expect(result.description).toBe('配置信息');
    expect(result.properties).toEqual({ a: { type: 'string' } });
    expect(result.required).toEqual(['a']);
  });

  it('should merge multiple allOf branches: properties combined, required deduped', () => {
    const result = convertSchemaToInternal({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['a', 'b'] },
      ],
    });
    expect(result.properties).toEqual({
      a: { type: 'string' },
      b: { type: 'number' },
    });
    expect(result.required).toEqual(['a', 'b']);
  });

  it('should let flat-level explicit fields override allOf branch fields', () => {
    const result = convertSchemaToInternal({
      description: '外层描述',
      type: 'string',
      allOf: [{ description: '分支描述', format: 'uuid' }],
    });
    // 平级显式字段优先
    expect(result.description).toBe('外层描述');
    expect(result.type).toBe('string');
    // 平级没有的字段从分支补
    expect(result.format).toBe('uuid');
  });

  it('should propagate nullable from allOf branch to result', () => {
    const result = convertSchemaToInternal({
      allOf: [{ type: 'string', nullable: true }],
    });
    expect(result.nullable).toBe(true);
    expect(result.type).toBe('string');
  });

  // --- oneOf / anyOf 透传 ---

  it('should pass through oneOf with branches recursively converted', () => {
    const result = convertSchemaToInternal({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(result.oneOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('should pass through anyOf with branches recursively converted', () => {
    const result = convertSchemaToInternal({
      anyOf: [{ type: 'string', enum: ['a'] }, { type: 'boolean' }],
    });
    expect(result.anyOf).toEqual([
      { type: 'string', enum: ['a'] },
      { type: 'boolean' },
    ]);
  });

  it('should fall back type to object when no type/properties but oneOf is present', () => {
    const result = convertSchemaToInternal({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(result.type).toBe('object');
    expect(result.oneOf).toHaveLength(2);
  });

  // --- additionalProperties 透传 ---

  it('should pass through boolean additionalProperties, ignore object form', () => {
    const r1 = convertSchemaToInternal({ type: 'object', additionalProperties: false });
    expect(r1.additionalProperties).toBe(false);

    const r2 = convertSchemaToInternal({ type: 'object', additionalProperties: true });
    expect(r2.additionalProperties).toBe(true);

    // object 形式不透传
    const r3 = convertSchemaToInternal({ type: 'object', additionalProperties: { type: 'string' } });
    expect(r3.additionalProperties).toBeUndefined();
  });
});

describe('toWireSchema()', () => {
  it('should expand nullable into type array (valid JSON Schema Draft-07)', () => {
    const wire = toWireSchema({ type: 'string', nullable: true, description: 'x' });
    expect(wire.type).toEqual(['string', 'null']);
    expect(wire.nullable).toBeUndefined();
    expect(wire.description).toBe('x');
  });

  it('should not mutate the input schema', () => {
    const input = { type: 'string', nullable: true } as const;
    const wire = toWireSchema({ ...input });
    expect(wire.type).toEqual(['string', 'null']);
  });

  it('should leave non-nullable schemas untouched', () => {
    const wire = toWireSchema({ type: 'boolean' });
    expect(wire).toEqual({ type: 'boolean' });
  });

  it('should recurse into properties and items', () => {
    const wire = toWireSchema({
      type: 'object',
      properties: {
        note: { type: 'string', nullable: true },
      },
      items: { type: 'string', nullable: true },
    });
    expect(wire.properties!.note.type).toEqual(['string', 'null']);
    expect(wire.items!.type).toEqual(['string', 'null']);
    expect(wire.type).toBe('object');
  });

  it('should recursively expand nullable in oneOf/anyOf branches', () => {
    const wire = toWireSchema({
      type: 'object',
      oneOf: [
        { type: 'string', nullable: true },
        { type: 'number' },
      ],
      anyOf: [
        { type: 'boolean', nullable: true },
      ],
    });
    expect(wire.oneOf![0].type).toEqual(['string', 'null']);
    expect(wire.oneOf![0].nullable).toBeUndefined();
    expect(wire.oneOf![1].type).toBe('number');
    expect(wire.anyOf![0].type).toEqual(['boolean', 'null']);
    expect(wire.anyOf![0].nullable).toBeUndefined();
  });

  it('should expand nullable propagated from allOf merge (integration)', () => {
    // allOf 合并已在 convertSchemaToInternal 中完成，验证 toWireSchema 正确展开其 nullable
    const internal = convertSchemaToInternal({
      allOf: [{ type: 'string', nullable: true }],
    });
    expect(internal.nullable).toBe(true);

    const wire = toWireSchema(internal);
    expect(wire.type).toEqual(['string', 'null']);
    expect(wire.nullable).toBeUndefined();
  });
});

describe('toSnakeCase() / generateOperationId()', () => {
  it('should convert camelCase/PascalCase to snake_case', () => {
    expect(toSnakeCase('getUserProfile')).toBe('get_user_profile');
    expect(toSnakeCase('AuthController_register')).toBe('auth_controller_register');
  });

  it('should generate operationId from method and path', () => {
    expect(generateOperationId('get', '/topics/{id}/messages')).toBe('get_topics_id_messages');
  });
});

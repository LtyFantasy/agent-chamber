import { Controller, Post, Body } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { BatchCreateTasksDto } from './modules/task/dto/batch-create-tasks.dto';
import { UpdateAgendaDto } from './modules/topic/dto/update-agenda.dto';
import { UpdateTaskDto } from './modules/task/dto/update-task.dto';
import { AssignTaskDto } from './modules/task/dto/assign-task.dto';
import { UpdateBoardListDto } from './modules/board/dto/update-board-list.dto';
import { CreateTopicDto } from './modules/topic/dto/create-topic.dto';

/**
 * 轻量 Controller，仅用于触发 Swagger 文档生成并校验 array-of-object DTO 的 schema。
 * 不依赖数据库、Service 或权限守卫。
 */
@Controller('swagger-test')
class SchemaTestController {
  @Post('tasks/batch')
  batchCreate(@Body() dto: BatchCreateTasksDto) {
    return dto;
  }

  @Post('agenda')
  updateAgenda(@Body() dto: UpdateAgendaDto) {
    return dto;
  }

  @Post('tasks/update')
  updateTask(@Body() dto: UpdateTaskDto) {
    return dto;
  }

  @Post('tasks/assign')
  assignTask(@Body() dto: AssignTaskDto) {
    return dto;
  }

  @Post('boards/lists/update')
  updateBoardList(@Body() dto: UpdateBoardListDto) {
    return dto;
  }

  @Post('topics')
  createTopic(@Body() dto: CreateTopicDto) {
    return dto;
  }
}

describe('Swagger Schema — array-of-object DTOs', () => {
  async function buildDocument() {
    const module = await Test.createTestingModule({
      controllers: [SchemaTestController],
    }).compile();

    const app = module.createNestApplication();
    const config = new DocumentBuilder()
      .setTitle('Test')
      .setDescription('Test')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    await app.close();
    return document;
  }

  it('BatchCreateTasksDto.tasks should be an array of objects (CreateTaskDto)', async () => {
    const document = await buildDocument();
    const schemas = document.components?.schemas as
      | Record<string, Record<string, unknown>>
      | undefined;
    const batchSchema = schemas?.BatchCreateTasksDto;

    expect(batchSchema).toBeDefined();
    const properties = batchSchema?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const tasksSchema = properties?.tasks;
    expect(tasksSchema?.type).toBe('array');

    const itemsSchema = tasksSchema?.items as Record<string, unknown> | undefined;
    // NestJS 可能用 $ref 引用 CreateTaskDto，也可能内联；无论哪种，都确保指向 CreateTaskDto schema
    const refName = (itemsSchema?.$ref as string | undefined)?.split('/').pop();
    expect(refName).toBe('CreateTaskDto');
    const createTaskSchema = schemas?.CreateTaskDto;
    expect(createTaskSchema).toBeDefined();
    const createTaskProperties = createTaskSchema?.properties as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(createTaskProperties ?? {})).toContain('listId');
    expect(Object.keys(createTaskProperties ?? {})).toContain('title');
  });

  it('UpdateAgendaDto.agenda should be an array of objects (AgendaItemDto)', async () => {
    const document = await buildDocument();
    const schemas = document.components?.schemas as
      | Record<string, Record<string, unknown>>
      | undefined;
    const agendaSchema = schemas?.UpdateAgendaDto;

    expect(agendaSchema).toBeDefined();
    const properties = agendaSchema?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const agendaPropSchema = properties?.agenda;
    expect(agendaPropSchema?.type).toBe('array');

    const itemsSchema = agendaPropSchema?.items as Record<string, unknown> | undefined;
    const refName = (itemsSchema?.$ref as string | undefined)?.split('/').pop();
    expect(refName).toBe('AgendaItemDto');
    const agendaItemSchema = schemas?.AgendaItemDto;
    expect(agendaItemSchema).toBeDefined();
    const itemProperties = agendaItemSchema?.properties as Record<string, unknown> | undefined;
    expect(Object.keys(itemProperties ?? {})).toContain('title');
    expect(Object.keys(itemProperties ?? {})).toContain('status');
  });
});

describe('Swagger Schema — nullable union DTO 字段', () => {
  async function buildDocument() {
    const module = await Test.createTestingModule({
      controllers: [SchemaTestController],
    }).compile();

    const app = module.createNestApplication();
    const config = new DocumentBuilder()
      .setTitle('Test')
      .setDescription('Test')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    await app.close();
    return document;
  }

  function getProperties(document: unknown, schemaName: string) {
    const schemas = (
      document as { components?: { schemas?: Record<string, Record<string, unknown>> } }
    ).components?.schemas;
    const properties = schemas?.[schemaName]?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(properties).toBeDefined();
    return properties ?? {};
  }

  // 回归：string|null 联合类型若不在 @ApiPropertyOptional 显式声明 type:String + nullable，
  // reflect-metadata 会推导为 Object，automcp 缺 type 回退 object，MCP client 看到 type:object 无法传参
  it('UpdateTaskDto.assigneeId should be string + nullable（而非 object）', async () => {
    const document = await buildDocument();
    const props = getProperties(document, 'UpdateTaskDto');
    expect(props.assigneeId?.type).toBe('string');
    expect(props.assigneeId?.nullable).toBe(true);
  });

  it('UpdateTaskDto.milestoneId is a nullable UUID string, not an object', async () => {
    const document = await buildDocument();
    const props = getProperties(document, 'UpdateTaskDto');
    expect(props.milestoneId?.type).toBe('string');
    expect(props.milestoneId?.nullable).toBe(true);
  });

  it('AssignTaskDto.assigneeId should be string + nullable（而非 object）', async () => {
    const document = await buildDocument();
    const props = getProperties(document, 'AssignTaskDto');
    expect(props.assigneeId?.type).toBe('string');
    expect(props.assigneeId?.nullable).toBe(true);
  });

  it('UpdateBoardListDto.mappedStatus should be string enum + nullable（而非 object）', async () => {
    const document = await buildDocument();
    const props = getProperties(document, 'UpdateBoardListDto');
    expect(props.mappedStatus?.type).toBe('string');
    expect(props.mappedStatus?.nullable).toBe(true);
    expect(Array.isArray(props.mappedStatus?.enum)).toBe(true);
  });
});

/**
 * 回归守卫：扫描 DTO 源码，断言不存在 `example: 'string'` 占位符。
 * 目的：确保所有示例值均为语义化的真实值，MCP tools 的 inputSchema 可被 Agent 正确理解和使用。
 */
describe('Swagger Schema — DTO example 占位符清零', () => {
  const fs = require('fs');
  const path = require('path');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function collectDtoFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectDtoFiles(full));
      } else if (entry.name.endsWith('.dto.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  it("所有 DTO 文件不应存在 example: 'string' 占位符", () => {
    const dtoRoot = path.join(__dirname, 'modules');
    const dtoFiles = collectDtoFiles(dtoRoot);
    const violations: string[] = [];

    for (const file of dtoFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("example: 'string'")) {
          violations.push(`${path.relative(__dirname, file)}:${i + 1}`);
        }
      }
    }

    // 本测试文件自身（spec）不在 modules/ 下，不会被扫描到，勿需过滤。
    expect(violations).toEqual([]);
  });
});

/**
 * 回归守卫：确保所有 @IsEnum 字段的 ApiProperty 透出 `enum` 到 Swagger schema。
 * 目的：MCP tools 的 inputSchema 包含合法枚举值，外部 Agent 可正确传参。
 */
describe('Swagger Schema — @IsEnum 字段 enum 透出', () => {
  async function buildDocument() {
    const module = await Test.createTestingModule({
      controllers: [SchemaTestController],
    }).compile();

    const app = module.createNestApplication();
    const config = new DocumentBuilder()
      .setTitle('Test')
      .setDescription('Test')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    await app.close();
    return document;
  }

  function getProperties(document: unknown, schemaName: string) {
    const schemas = (
      document as { components?: { schemas?: Record<string, Record<string, unknown>> } }
    ).components?.schemas;
    const properties = schemas?.[schemaName]?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(properties).toBeDefined();
    return properties ?? {};
  }

  it('AgendaItemDto.status 应透出 enum: [pending, in_progress, completed]', async () => {
    const document = await buildDocument();
    const props = getProperties(document, 'AgendaItemDto');
    expect(props.status?.type).toBe('string');
    expect(props.status?.enum).toEqual(['pending', 'in_progress', 'completed']);
  });

  it('TopicConfigDto.visibility 应透出 enum: [open, private]', async () => {
    const document = await buildDocument();
    const props = getProperties(document, 'TopicConfigDto');
    expect(props.visibility?.type).toBe('string');
    expect(props.visibility?.enum).toEqual(['open', 'private']);
  });
});

/**
 * 全局守卫：标量可空字段（TS `string | null`）不得在 swagger 里落成 `type: object`。
 *
 * **根因**：本仓未启用 @nestjs/swagger CLI 插件（nest-cli.json 无 plugins），schema 完全来自
 * 显式 decorator + `emitDecoratorMetadata` 的 design:type；TS 对 `string | null` 联合类型发射
 * `Object`，于是 `@ApiPropertyOptional({ description, maxLength })` 落 `"type":"object"`。
 * automcp 忠实透传进 MCP inputSchema → MCP client 按 object 传参 → 后端 `@IsString()` 400
 * （Kairos 实测 memory 建项目/提名全 400，REST 正常；Board 卡 0fa10b3f）。
 * 修复恒为在 decorator 显式声明 `type: 'string'`（null 有语义再补 `nullable: true`）——
 * 只动文档元数据，validator 与字段类型零变化。
 *
 * **两层扫描互补**（缺一不可）：
 *  1. 「object + 标量约束」= 确定性错型（`maxLength`/`pattern` 只有标量才带）；
 *  2. 「object 且无 properties/items/$ref」但没有标量约束的属性 —— 这类只能靠白名单兜底：
 *     `reviewAt`、`avatar`、`description` 这类无约束可空标量错型后，schema 与合法的自由对象
 *     字段在文档里长得一模一样，规则无法区分，故强制每个自由对象字段显式登记。
 *
 * **为什么要 extraModels 灌全量 DTO**：document 只含被路由引用的 schema，本文件的轻量
 * SchemaTestController 仅注册 6 个 DTO；直接扫 `document.components.schemas` 会漏掉其余
 * 100+ 个请求 DTO。extraModels 让每个 DTO 无论是否挂在路由上都生成 schema，守卫才真正覆盖全量。
 */
describe('Swagger Schema — 标量可空字段不得落成 type:object（全局守卫）', () => {
  const fs = require('fs');
  const path = require('path');

  /** 递归收集 src/modules 下全部 *.dto.ts 绝对路径（与 example 占位符守卫同款收集器） */
  function collectDtoFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectDtoFiles(full));
      } else if (entry.name.endsWith('.dto.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  /** 收集 DTO 文件导出的全部运行时类（接口/enum 常量在运行时不是函数，自然被排除） */
  function collectDtoClasses(): Function[] {
    const classes: Function[] = [];
    for (const file of collectDtoFiles(path.join(__dirname, 'modules'))) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(file) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        if (typeof value === 'function' && (value as Function).prototype) {
          classes.push(value as Function);
        }
      }
    }
    return classes;
  }

  /**
   * 一个 property 若带这些键，就说明它确实被声明成了复合/枚举形状（不是缺 type 的错型）。
   * `enum` 也在内：`@ApiPropertyOptional({ enum: X })` 会自行推导标量类型，永不落 object。
   */
  const FREE_FORM_SHAPE_KEYS = [
    'properties',
    'additionalProperties',
    'items',
    '$ref',
    'oneOf',
    'anyOf',
    'allOf',
    'enum',
  ];

  /** 只有标量才带的约束键：出现在 `type: 'object'` 上 = decorator 缺 type 的确定性证据 */
  const SCALAR_ONLY_CONSTRAINT_KEYS = [
    'maxLength',
    'minLength',
    'pattern',
    'format',
    'minimum',
    'maximum',
  ];

  /**
   * 「真·自由形态对象」白名单（键 = `DtoName.field`）。
   *
   * 这些字段**确实**是任意对象（jsonb / Record / IR / 元数据），`type: 'object'` 是正确表示，
   * 且无法用 properties 描述形状（`@IsObject()` 才是它们的校验器）。
   * 新增自由对象字段必须在这里登记并注明理由 —— 忘了登记会让守卫失败，
   * 这正是设计意图：每个 `type: object` 都要一次「是人写的对象，还是漏了 type 的标量」的显式决策。
   */
  const ALLOWED_FREE_FORM_OBJECT_FIELDS = new Set<string>([
    'AgentHeartbeatDto.meta', // 扩展元数据（load/version 折叠共存）
    'AgentConfigDto.customParams', // 引擎自定义参数袋
    'UpdateBoardMetricsDto.metrics', // board.settings.metrics 机器事实快照
    'BundleSpaceMetaDto.settings', // 空间 settings jsonb 原样回写
    'ImportDocBundleDto.appliedFilters', // 导出侧过滤条件回声（刻意只挂 @IsObject）
    'DiagramPatchItemDto.value', // RFC 6902 补丁值：多态（string/number/bool/array/object/null）
    'ValidateDiagramPatchItemDto.value', // 同上（dry-run 校验面）
    'UpsertDiagramDto.ir', // Diagram IR 对象
    'ValidateDiagramDto.ir', // Diagram IR 对象（dry-run）
    'CreateExperienceDto.env', // 环境指纹（受控键、开放值）
    'UpdateExperienceDto.env', // 同上
    'CreateTaskDto.customFields', // 任务自定义字段袋
    'UpdateTaskDto.customFields', // 同上
    'MarkMilestoneDeployedDto.anchors', // 部署锚点对象
    'SendMessageDto.metadata', // 消息元数据袋
    'UpdateProfileDto.preferences', // 用户偏好袋
    'UpdateDocSpaceDto.hintToggles', // settings.hintToggles 六族布尔开关
    'TestWebhookDto.payload', // webhook 测试载荷
  ]);

  /** 遍历 document 全部 schema（含嵌套 properties / items），按判定分两类收集 */
  function scanObjectTypedProperties(document: unknown): {
    scalarConstraintViolations: string[];
    unclassifiedFreeFormObjects: string[];
  } {
    const scalarConstraintViolations: string[] = [];
    const unclassifiedFreeFormObjects: string[] = [];
    const schemas =
      (document as { components?: { schemas?: Record<string, Record<string, unknown>> } })
        .components?.schemas ?? {};

    const walk = (schema: Record<string, unknown>, label: string) => {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (!properties) return;
      for (const [field, propSchema] of Object.entries(properties)) {
        const pointer = `${label}.${field}`;
        const isFreeFormObject =
          propSchema.type === 'object' &&
          !FREE_FORM_SHAPE_KEYS.some((key) => propSchema[key] !== undefined);
        if (isFreeFormObject) {
          const detail = JSON.stringify(propSchema);
          if (SCALAR_ONLY_CONSTRAINT_KEYS.some((key) => propSchema[key] !== undefined)) {
            scalarConstraintViolations.push(`${pointer} :: ${detail}`);
          } else if (!ALLOWED_FREE_FORM_OBJECT_FIELDS.has(pointer)) {
            unclassifiedFreeFormObjects.push(`${pointer} :: ${detail}`);
          }
        }
        walk(propSchema, pointer);
        if (propSchema.items) walk(propSchema.items as Record<string, unknown>, `${pointer}[]`);
      }
    };

    for (const [name, schema] of Object.entries(schemas)) walk(schema, name);
    return { scalarConstraintViolations, unclassifiedFreeFormObjects };
  }

  async function buildFullDocument() {
    const module = await Test.createTestingModule({
      controllers: [SchemaTestController],
    }).compile();

    const app = module.createNestApplication();
    const config = new DocumentBuilder()
      .setTitle('Test')
      .setDescription('Test')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, config, {
      extraModels: collectDtoClasses(),
    });
    await app.close();
    return document;
  }

  it('object 类型属性不得携带 maxLength/minLength/pattern/format/minimum/maximum', async () => {
    const document = await buildFullDocument();
    const { scalarConstraintViolations } = scanObjectTypedProperties(document);
    // 期望为空：任何一条都意味着某字段的 @ApiProperty 缺 type，被推断成了 object
    expect(scalarConstraintViolations).toEqual([]);
  });

  it('无 properties/items/$ref 的 object 属性必须登记在自由对象白名单', async () => {
    const document = await buildFullDocument();
    const { unclassifiedFreeFormObjects } = scanObjectTypedProperties(document);
    // 期望为空：若报出的是标量可空字段（avatar/reviewAt/description 一类），加 type: 'string'
    // + nullable: true；若确实是任意对象，登记进 ALLOWED_FREE_FORM_OBJECT_FIELDS 并注明理由
    expect(unclassifiedFreeFormObjects).toEqual([]);
  });

  it('全量 DTO 面已进 document（守卫覆盖度自检，防"零违例"因扫描面塌缩而假绿）', async () => {
    const document = await buildFullDocument();
    const schemas =
      (document as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ??
      {};
    // 覆盖度锚点：memory / docspace 两个本次修复模块的 DTO 必须在文档里
    for (const name of [
      'CreateMemoryProjectDto',
      'UpdateMemoryProjectDto',
      'NominateMemoryDto',
      'CorrectMemoryDto',
      'ImportDocBundleDto',
      'BundleRouteItemDto',
    ]) {
      expect(Object.keys(schemas)).toContain(name);
    }
    // 轻量 Controller 只注册 6 个 DTO；extraModels 生效后 schema 数应远大于它
    expect(Object.keys(schemas).length).toBeGreaterThan(100);
  });
});

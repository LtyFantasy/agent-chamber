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
    const schemas = document.components?.schemas as Record<string, Record<string, unknown>> | undefined;
    const batchSchema = schemas?.BatchCreateTasksDto;

    expect(batchSchema).toBeDefined();
    const properties = batchSchema?.properties as Record<string, Record<string, unknown>> | undefined;
    const tasksSchema = properties?.tasks;
    expect(tasksSchema?.type).toBe('array');

    const itemsSchema = tasksSchema?.items as Record<string, unknown> | undefined;
    // NestJS 可能用 $ref 引用 CreateTaskDto，也可能内联；无论哪种，都确保指向 CreateTaskDto schema
    const refName = (itemsSchema?.$ref as string | undefined)?.split('/').pop();
    expect(refName).toBe('CreateTaskDto');
    const createTaskSchema = schemas?.CreateTaskDto;
    expect(createTaskSchema).toBeDefined();
    const createTaskProperties = createTaskSchema?.properties as Record<string, unknown> | undefined;
    expect(Object.keys(createTaskProperties ?? {})).toContain('listId');
    expect(Object.keys(createTaskProperties ?? {})).toContain('title');
  });

  it('UpdateAgendaDto.agenda should be an array of objects (AgendaItemDto)', async () => {
    const document = await buildDocument();
    const schemas = document.components?.schemas as Record<string, Record<string, unknown>> | undefined;
    const agendaSchema = schemas?.UpdateAgendaDto;

    expect(agendaSchema).toBeDefined();
    const properties = agendaSchema?.properties as Record<string, Record<string, unknown>> | undefined;
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
    const schemas = (document as { components?: { schemas?: Record<string, Record<string, unknown>> } })
      .components?.schemas;
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

  it('所有 DTO 文件不应存在 example: \'string\' 占位符', () => {
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
    const schemas = (document as { components?: { schemas?: Record<string, Record<string, unknown>> } })
      .components?.schemas;
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

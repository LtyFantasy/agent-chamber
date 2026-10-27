/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Usage 两读面的 **真实 OpenAPI 生成守卫**：从 `MemoryController` 的真实装饰器 +
 *     DTO 生成 OpenAPI 文档，并与 `apps/backend/config/openapi-usage.json`（真实生成快照）
 *     逐字比对；automcp 侧再用同一份快照解析成 MCP inputSchema
 *     （`packages/automcp/src/mapper/usage-openapi-tool-schema.spec.ts`）
 *
 * [代码职责]
 *   - 证明 DTO/controller 的装饰器变更会改变 OpenAPI，从而被快照断言抓住；
 *   - 把"DTO ↔ OpenAPI ↔ MCP inputSchema"三段的漂移面收敛到一份可审查的快照
 *
 * [权威文档]
 *   - Hument 合同：`~/.hument/chamber-dev/upgrade-alpha19/hument-v1.yaml` 的 usage paths
 *   - 计划 `constantine-pantha-lockjaw.md` §2.2 / §3.2.7
 *
 * [关键不变量]
 *   - 快照**只包含两条 usage path**（不是全量 OpenAPI）：全量快照会因无关端点变更而红。
 *   - 快照由真实 `SwaggerModule.createDocument` 生成；**禁止手改**（改 DTO 后重新生成并审查差异）。
 *   - 参数面必须只有：path `id` + 四个开放过滤器 + `since`/`until`（trace 另加 `limit`/`cursor`）；
 *     **没有** `scope` / `workspaceId` / `actorId` / `body`；summary **没有**分页键。
 *
 * [关联代码]
 *   - memory.controller.ts / dto/memory-usage.dto.ts — 快照的生成源
 *   - apps/backend/config/openapi-usage.json — 真实生成快照（automcp 测试共用）
 *   - packages/automcp/src/mapper/usage-openapi-tool-schema.spec.ts — 快照 → MCP inputSchema
 * =============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MemoryController } from './memory.controller';
import { MemoryProjectService } from './memory-project.service';
import { MemoryFormationService } from './memory-formation.service';
import { MemoryRecallService } from './memory-recall.service';
import { MemoryCorrectionService } from './memory-correction.service';
import { MemoryViewsService } from './memory-views.service';
import { MemoryUsageService } from './memory-usage.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ApiKeyAuthService } from '../../common/services/api-key-auth.service';
import { User } from '../../database/entities/user.entity';

const FIXTURE_PATH = path.join(__dirname, '../../../config/openapi-usage.json');

/** 真实生成 OpenAPI 文档（controller 的 service 依赖用空替身；文档生成不调用它们） */
async function generateUsagePaths(): Promise<{
  summary: Record<string, unknown>;
  trace: Record<string, unknown>;
}> {
  const stubs = [
    MemoryProjectService,
    MemoryFormationService,
    MemoryRecallService,
    MemoryCorrectionService,
    MemoryViewsService,
    MemoryUsageService,
  ].map((provide) => ({ provide, useValue: {} }));

  const moduleRef = await Test.createTestingModule({
    controllers: [MemoryController],
    providers: [
      ...stubs,
      // 方法级 `JwtOrApiKeyGuard` 在文档生成时也会被实例化（Nest 解析 guard 依赖）
      { provide: JwtService, useValue: {} },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: getRepositoryToken(User), useValue: {} },
      { provide: ApiKeyAuthService, useValue: {} },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('T').setDescription('T').setVersion('1').build(),
  );
  await app.close();

  const paths = document.paths as unknown as Record<
    string,
    { get: Record<string, unknown> }
  >;
  return {
    summary: paths['/memory/projects/{id}/usage/summary'].get,
    trace: paths['/memory/projects/{id}/usage/trace'].get,
  };
}

/** 从 OpenAPI 参数列表里取 query 参数名（忽略 header/path） */
function queryNames(operation: Record<string, unknown>): string[] {
  const parameters = (operation.parameters ?? []) as Array<{ name: string; in: string }>;
  return parameters.filter((param) => param.in === 'query').map((param) => param.name);
}

describe('Usage OpenAPI 快照（真实 controller + DTO 生成）', () => {
  it('两条 usage path 与快照逐字一致（DTO/装饰器漂移 = 这里红）', async () => {
    const generated = await generateUsagePaths();
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as {
      paths: Record<string, { get: Record<string, unknown> }>;
    };

    expect(generated.summary).toEqual(
      fixture.paths['/memory/projects/{id}/usage/summary'].get,
    );
    expect(generated.trace).toEqual(fixture.paths['/memory/projects/{id}/usage/trace'].get);
  });

  it('参数面闭合：summary 无分页/身份/scope/body；trace 多 limit+cursor', async () => {
    const generated = await generateUsagePaths();
    const summaryQuery = queryNames(generated.summary);
    const traceQuery = queryNames(generated.trace);

    expect(summaryQuery.sort()).toEqual(
      ['model', 'operation', 'providerOperation', 'since', 'until'].sort(),
    );
    for (const forbidden of ['scope', 'workspaceId', 'actorId', 'body']) {
      expect(summaryQuery).not.toContain(forbidden);
      expect(traceQuery).not.toContain(forbidden);
    }
    // summary **没有**分页键；trace 才有
    for (const pagination of ['limit', 'cursor']) {
      expect(summaryQuery).not.toContain(pagination);
      expect(traceQuery).toContain(pagination);
    }
    expect(traceQuery.sort()).toEqual(
      ['cursor', 'limit', 'model', 'operation', 'providerOperation', 'since', 'until'].sort(),
    );

    const traceParams = (generated.trace.parameters ?? []) as Array<{
      name: string;
      schema: Record<string, unknown>;
    }>;
    const limit = traceParams.find((param) => param.name === 'limit')!;
    expect(limit.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
    const cursor = traceParams.find((param) => param.name === 'cursor')!;
    expect(cursor.schema).toMatchObject({ type: 'string', maxLength: 4096 });
  });
});

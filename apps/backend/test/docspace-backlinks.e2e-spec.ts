/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 反向引用（backlinks）端到端契约：GET /docs/:id/backlinks —— 按来源文档
 *     分组的入链视图（人类消费面），以及与 GET /docs/:id/move-impact 的**语义等价性**
 *
 * [代码职责]
 *   - 用**真实 PG + 真实 HTTP**（真 JWT、真 TypeORM repo、真 DocService/DocLinksService/
 *     DocMoveService、真权限策略与守卫）钉死 plan 的 e2e 清单：分组口径 / 自引用过滤 /
 *     软删源排除 / 顺序确定性 / 404 语义 / 与 move-impact 的等价性护栏
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/api-definition.md` §16.21（GET /docs/:id/backlinks）
 *   - 补充: 线上 `docs/api-definition.md` §16.17（GET /docs/:id/move-impact，扁平入链面）
 *
 * [关键不变量]（本套件是这些不变量的守门人，改动断言前先想清楚在防什么）
 *   - **等价性**：`flatten(backlinks.sources[].links 补回组级三键)` 与
 *     `moveImpact.inboundLinks`，**双方各自剔除 sourceDocId === docId 的自引用**后，
 *     按 (sourceDocId, href) 排序再深度相等。flatten 必须补回**全部三个**组级字段
 *     （sourceDocId + sourcePath + sourceTitle，DTO 用 Omit 三键）——只补 sourceDocId
 *     会结构性必红；**禁止通过删减被比较字段让护栏变绿**（plan 定点复核产出）
 *   - **顺序确定性**：同一请求两次，sources 数组全等（候选集 ORDER BY path ASC, id ASC
 *     + 消费面显式排序；PG 无 ORDER BY 时顺序任意 → 本断言会随机翻红）
 *   - **自引用过滤只在消费面**：backlinks 剔除 sourceDocId === docId；move-impact 保留
 *   - **软删源不入列**：来源文档软删后，其 sections 仍在库中，但候选集 `deleted_at IS NULL`
 *     把它排除——若退化成"先查 sections 再过滤"，本断言会漏
 *   - **read 拒绝 = 404 DOC_SPACE_NOT_FOUND**（不是 403）；文档不存在 = 404 DOC_NOT_FOUND
 *
 * [关联代码]
 *   - src/modules/docspace/doc-links.service.ts — 入链内核 + 分组组装（被本套件直接打）
 *   - src/modules/docspace/doc-move.service.ts — computeMoveImpact（等价性对照方）
 *   - test/docspace-move.e2e-spec.ts — move-impact 的真 PG 回归套件（同源种子范式）
 *
 * [持久踩坑]
 *   - BACKLINKS-E2E-HOST（宿主选择）：**禁止**把本套件并进 test/docspace.e2e-spec.ts
 *     ——那个宿主用 createTestingApp()（mockRepos），入链反扫的 SQL 会全部走 mock，
 *     测试会"绿而无证据"。安全方向：真 DataSource + 真 Nest 模块 + supertest
 *     （本文件装配范式，来自 experience.e2e-spec.ts:587-651 + docspace-bundle:331-466）
 *   - BACKLINKS-E2E-UUID（?doc= 形态）：平台链接正则只认 36 位 UUID（docId）；
 *     用 'doc-1' 这类字面量会让 ?doc= 分支静默不命中（doc-links.service.spec 踩过）
 *
 * [铁律关联] #17(测试契约) #22(findOne必须判空) #23(ORM/jsonb 集成覆盖) #9(代理层透传)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 已核对 [关键不变量]（尤其等价性护栏的字段完整性）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * DocSpace backlinks —— 真实 PG + 真实 HTTP 端到端套件（v1.90.0-dev backlinks 批次）
 *
 * 为什么不是 createTestingApp（mock 链）：本功能的全部风险长在 SQL 与接线语义上——
 * 候选集 `ORDER BY path ASC, id ASC` 是否真让数组序确定、批量 `IN (...)` 是否真把
 * 软删文档排除、按 sourceDocId 分组是否与实际 section 定位一致、read 拒绝是否真以
 * 404 透出——mock 仓储对这些一律测不出（铁律 #23）。
 *
 * 环境：本地开发库 chamber-postgres（8744），PG 不可达时整套降级跳过；全部测试数据带
 * RUN 后缀隔离，afterAll 按 id 硬删兜底清理。
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request = require('supertest');
import { API_PREFIX, ActorType, AgentStatus, ErrorCode, UserRole } from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { Board } from '../src/database/entities/board.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { Event } from '../src/database/entities/event.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PermissionService } from '../src/common/services/permission.service';
import { DocSpacePolicy } from '../src/common/policies/doc-space.policy';
import { TopicPolicy } from '../src/common/policies/topic.policy';
import { BoardPolicy } from '../src/common/policies/board.policy';
import { TaskPolicy } from '../src/common/policies/task.policy';
import { AgentPolicy } from '../src/common/policies/agent.policy';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { AuditService } from '../src/modules/audit/audit.service';
import { EventService } from '../src/modules/event/event.service';
import { DocController } from '../src/modules/docspace/doc.controller';
import { DocService } from '../src/modules/docspace/doc.service';
import { DocLinksService } from '../src/modules/docspace/doc-links.service';
import { DocMoveService } from '../src/modules/docspace/doc-move.service';
import { DocSearchService } from '../src/modules/docspace/doc-search.service';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { RouteHealthService } from '../src/modules/docspace/route-health.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import type { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其他套件） */
const JWT_SECRET = 'docspace-backlinks-e2e-secret';

/** 本次运行的唯一后缀：隔离测试数据（path 全带它，断言互不串味） */
const RUN = `bl-${Date.now().toString(36)}`;

/** 响应信封（ResponseInterceptor 产出） */
interface Envelope<T> {
  code: number;
  data: T;
}

/** backlinks 视图（断言用最小形状） */
interface BacklinksBody {
  docId: string;
  path: string;
  docCount: number;
  linkCount: number;
  sources: Array<{
    sourceDocId: string;
    sourcePath: string;
    sourceTitle: string;
    links: Array<{
      href: string;
      isPathBased: boolean;
      sectionPosition?: number;
      headingPath?: string | null;
    }>;
  }>;
}

/** 入链条目（move-impact.inboundLinks / flatten 后的 backlinks 双方共用） */
interface InboundLink {
  sourceDocId: string;
  sourcePath: string;
  sourceTitle: string;
  href: string;
  isPathBased: boolean;
  sectionPosition?: number;
  headingPath?: string | null;
}

/** 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态：方法级 guard 在**声明它的
 *  模块**上下文实例化，其 @InjectRepository 依赖要从那里解析） */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get('jwt.secret'),
        signOptions: { expiresIn: '2h' },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([User, ApiKey, Agent]),
  ],
  providers: [JwtStrategy, ApiKeyAuthService, JwtAuthGuard, JwtOrApiKeyGuard, RolesGuard],
  exports: [
    JwtModule,
    PassportModule,
    TypeOrmModule,
    ApiKeyAuthService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    RolesGuard,
  ],
})
class BacklinksE2eAuthModule {}

/**
 * 测试根模块：真库 + 真认证 + 真 DocController 与其生产依赖链。
 *
 * 桩件仅两处，均为**本端点不触达**的旁路依赖：
 * - `DocSearchService`（检索面，backlinks 不调用）；
 * - `EventService` / `RouteHealthService` / `DiagramRendererService`（写侧/巡检侧
 *   fire-and-forget 依赖，种子 upsert 会调 event.create → 打桩记账，不落事件表）。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: false,
    }),
    TypeOrmModule.forFeature([
      Doc,
      DocSection,
      DocCategory,
      DocVersion,
      DocSpace,
      DocSpaceMember,
      DocRoute,
      TaskDocLink,
      IdempotencyRecord,
      AuditLog,
      Board,
      Topic,
      Agent,
      User,
      ApiKey,
      Actor,
      Event,
    ]),
    BacklinksE2eAuthModule,
  ],
  controllers: [DocController],
  providers: [
    // 生产依赖链（真实现）
    DocService,
    DocLinksService,
    DocMoveService,
    DocSpaceService,
    OwnerProxyService,
    DocSpacePolicy,
    PermissionService,
    ActorProfileService,
    // 与 DocSpace 无关的四个策略桩（PermissionService.can 按资源类型分派，本套件只碰
    // DocSpace 读权限，它们永不被调用——不是"假授权"，见 docspace-bundle 同款处理）
    { provide: TopicPolicy, useValue: { can: () => true } },
    { provide: BoardPolicy, useValue: { can: () => true } },
    { provide: TaskPolicy, useValue: { can: () => true } },
    { provide: AgentPolicy, useValue: { can: () => true } },
    // 旁路依赖桩（本端点不触达；说明见模块注释）
    {
      provide: DocSearchService,
      useValue: { search: () => Promise.resolve({ hits: [], total: 0 }) },
    },
    {
      provide: EventService,
      useValue: { create: () => Promise.resolve({}) },
    },
    {
      provide: RouteHealthService,
      useValue: { recheckSpace: () => Promise.resolve({ rechecked: 0, broken: 0 }) },
    },
    { provide: DiagramRendererService, useValue: { validateAndRender: () => Promise.resolve({}) } },
    { provide: AccessQueryService, useValue: {} },
    { provide: ResourceValidator, useValue: {} },
    { provide: AuditService, useValue: { log: () => Promise.resolve(undefined) } },
    // 与 main.ts 同款：响应信封（断言 res.body.data）+ 异常信封（断言 res.body.code）。
    // 本套件自建 app 不 import AppModule，这两个全局件必须显式注册，否则错误码断言
    // 会拿不到（默认 Nest 异常体无 code 字段）
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class DocSpaceBacklinksE2eModule {}

describe('DocSpace backlinks — 真实 PG + 真实 HTTP 集成（v1.90.0-dev）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwtService: JwtService;
  let docService: DocService;
  let dbAvailable = false;

  /** 身份（RUN 隔离；afterAll 硬删） */
  let ownerUserId: string;
  let ownerToken: string;
  let strangerToken: string;

  let spaceId: string;
  /** 目标文档（被引用者） */
  let targetDoc: Doc;
  /** 来源 B：同源两条 href（相对 .md + 平台 ?doc=） */
  let sourceB: Doc;
  /** 来源 C：一条相对 .md href */
  let sourceC: Doc;
  /** 来源 D：种子后软删（不得进入结果） */
  let sourceD: Doc;
  /** 无关文档：只链其他文档（不得进入结果） */
  let unrelated: Doc;

  /** 清理登记 */
  const createdActorIds: string[] = [];
  const createdDocIds: string[] = [];

  /** 给请求挂上人类 JWT */
  const authed = (req: request.Test, token: string): request.Test =>
    req.set('Authorization', `Bearer ${token}`);

  /** 造人类 actor + user 行（JWT 校验与 created_by 都需要真实行） */
  async function createHuman(
    role: UserRole,
    seq: number,
  ): Promise<{ userId: string; token: string }> {
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Backlinks ${RUN} #${seq}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    createdActorIds.push(actor.id);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        actor,
        username: `backlinks${RUN}${seq}`.slice(0, 50),
        email: `backlinks-${RUN}-${seq}@example.com`,
        authProvider: 'local',
        role,
        preferences: {},
      }),
    );
    return { userId: user.id, token: jwtService.sign({ sub: user.id, role }) };
  }

  /** upsert 一篇文档（真 DocService + 真 chunker，sections 为真实产物） */
  async function seedDoc(path: string, content: string): Promise<Doc> {
    const actor: UnifiedActor = { id: ownerUserId, type: ActorType.HUMAN };
    const result = await docService.upsert(spaceId, { path, content }, actor);
    const doc = await docService.findById(result.id);
    createdDocIds.push(doc.id);
    return doc;
  }

  /** GET /docs/:id/backlinks（默认 owner 身份） */
  const getBacklinks = (docId: string, token?: string): request.Test =>
    authed(
      request(app.getHttpServer()).get(`${API_PREFIX}/docs/${docId}/backlinks`),
      token ?? ownerToken,
    );

  /** GET /docs/:id/move-impact（等价性护栏对照方） */
  const getMoveImpact = (docId: string, token?: string): request.Test =>
    authed(
      request(app.getHttpServer()).get(`${API_PREFIX}/docs/${docId}/move-impact`),
      token ?? ownerToken,
    );

  /**
   * 护栏比较用：把 backlinks.sources 摊平回扁平入链清单。
   *
   * ⚠️ 必须补回**全部三个**组级字段（sourceDocId + sourcePath + sourceTitle）——
   * DTO 用 `Omit<DocInboundLink, 三键>` 表达组级复用，只补一个字段则摊平结果与
   * move-impact.inboundLinks 结构性不等（护栏必红），且**禁止**用删减被比较字段
   * 的方式让护栏变绿（那会让护栏失去意义）。
   */
  function flattenBacklinks(body: BacklinksBody): InboundLink[] {
    return body.sources.flatMap((source) =>
      source.links.map((link) => ({
        ...link,
        sourceDocId: source.sourceDocId,
        sourcePath: source.sourcePath,
        sourceTitle: source.sourceTitle,
      })),
    );
  }

  /** 双方各自的规范化：剔自引用 → 按 (sourceDocId, href) 排序（顺序敏感，禁裸比） */
  function normalizeForGuard(links: InboundLink[], docId: string): InboundLink[] {
    return links
      .filter((link) => link.sourceDocId !== docId)
      .sort((a, b) => {
        if (a.sourceDocId !== b.sourceDocId) return a.sourceDocId < b.sourceDocId ? -1 : 1;
        return a.href < b.href ? -1 : a.href > b.href ? 1 : 0;
      });
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false,
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(
        `[docspace-backlinks e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({
      imports: [DocSpaceBacklinksE2eModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 逐字对齐：校验管道 + 全局前缀（响应信封由 APP_INTERCEPTOR 提供）
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    jwtService = app.get(JwtService);
    docService = app.get(DocService);

    const owner = await createHuman(UserRole.EDITOR, 1);
    ownerUserId = owner.userId;
    ownerToken = owner.token;
    const stranger = await createHuman(UserRole.EDITOR, 2);
    strangerToken = stranger.token;

    // ── 空间：**私有**（非成员 read 拒绝 → 404 DOC_SPACE_NOT_FOUND 的前提）+ owner 成员行 ──
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Backlinks E2E ${RUN}`,
        slug: `backlinks-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: ownerUserId,
        settings: { visibility: 'private' },
      }),
    );
    spaceId = space.id;
    await ds.getRepository(DocSpaceMember).save(
      ds.getRepository(DocSpaceMember).create({
        spaceId,
        actorId: ownerUserId,
        role: 'editor',
        invitedBy: null,
      }),
    );

    // ── 目标文档：自身含自引用（内核保留 / backlinks 过滤的对照物）──
    targetDoc = await seedDoc(
      `tmp/${RUN}/target.md`,
      ['# 目标文档', '', '## 概览', '', '自引用：见 [自己](./target.md)。', ''].join('\n'),
    );

    // ── 来源 B：同源两条 href（相对 .md + 平台 ?doc=）——docCount 与 linkCount 的分母 ──
    sourceB = await seedDoc(
      `tmp/${RUN}/b.md`,
      [
        '# 来源 B',
        '',
        '## 相对引用段',
        '',
        '见 [目标](./target.md)。',
        '',
        '## 平台引用段',
        '',
        `见 [目标平台](/docs/${spaceId}?doc=${targetDoc.id})。`,
        '',
      ].join('\n'),
    );

    // ── 来源 C：一条相对 href ──
    sourceC = await seedDoc(
      `tmp/${RUN}/c.md`,
      ['# 来源 C', '', '## 引用段', '', '见 [目标](./target.md)。', ''].join('\n'),
    );

    // ── 来源 D：先建后软删（其 sections 保留在库 → 只有候选集 deleted_at 过滤能排除它）──
    sourceD = await seedDoc(
      `tmp/${RUN}/d.md`,
      ['# 来源 D（将被软删）', '', '## 引用段', '', '见 [目标](./target.md)。', ''].join('\n'),
    );
    await ds.getRepository(Doc).softDelete({ id: sourceD.id });

    // ── 无关文档：只链别的文档（不入列，防"全命中"假绿）──
    unrelated = await seedDoc(
      `tmp/${RUN}/unrelated.md`,
      ['# 无关文档', '', '## 段', '', '见 [来源 C](./c.md)。', ''].join('\n'),
    );
  }, 60000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // 硬删兜底清理（顺序按 FK 依赖：sections → docs → space → actors）
    if (createdDocIds.length > 0) {
      await ds.getRepository(DocSection).delete({ docId: In(createdDocIds) });
      await ds.getRepository(Doc).delete({ id: In(createdDocIds) });
    }
    if (spaceId) {
      await ds.getRepository(DocSpaceMember).delete({ spaceId });
      await ds.getRepository(DocSpace).delete({ id: spaceId });
    }
    if (createdActorIds.length > 0) {
      await ds.getRepository(User).delete({ id: In(createdActorIds) });
      await ds.getRepository(Actor).delete({ id: In(createdActorIds) });
    }
    await ds.destroy();
  });

  // ─── ① happy path ───────────────────────────────────────────────────

  it('happy path：按来源分组（docCount=2、linkCount=3，同源多 href）', async () => {
    if (!dbAvailable) return;

    const res = await getBacklinks(targetDoc.id).expect(200);
    const body = (res.body as Envelope<BacklinksBody>).data;

    expect(body.docId).toBe(targetDoc.id);
    expect(body.path).toBe(targetDoc.path);
    // 自引用（target 自己）与软删来源 D、无关文档三者都不入列
    expect(body.docCount).toBe(2);
    expect(body.linkCount).toBe(3);
    expect(body.sources.map((s) => s.sourceDocId)).toEqual([sourceB.id, sourceC.id]);

    // 分组口径：组级三键在组上，组内 link 不再重复携带（DTO Omit 三键）
    const groupB = body.sources.find((s) => s.sourceDocId === sourceB.id)!;
    expect(groupB.sourcePath).toBe(sourceB.path);
    expect(groupB.sourceTitle).toBe(sourceB.title);
    expect(groupB.links).toHaveLength(2);
    expect(groupB.links[0]).not.toHaveProperty('sourceDocId');
    expect(groupB.links[0]).not.toHaveProperty('sourcePath');
    expect(groupB.links[0]).not.toHaveProperty('sourceTitle');
    // 两种形态都在：相对 .md（isPathBased=true）与平台 ?doc=（false）
    expect(groupB.links.map((l) => l.isPathBased).sort()).toEqual([false, true]);
    expect(groupB.links.map((l) => l.href).sort()).toEqual(
      [`/docs/${spaceId}?doc=${targetDoc.id}`, './target.md'].sort(),
    );

    const groupC = body.sources.find((s) => s.sourceDocId === sourceC.id)!;
    expect(groupC.links).toHaveLength(1);
    expect(groupC.links[0]).toMatchObject({ href: './target.md', isPathBased: true });
  });

  it('自引用不入列：目标文档自身的链接被消费面过滤（move-impact 保留——见护栏用例）', async () => {
    if (!dbAvailable) return;

    const res = await getBacklinks(targetDoc.id).expect(200);
    const body = (res.body as Envelope<BacklinksBody>).data;

    expect(body.sources.some((s) => s.sourceDocId === targetDoc.id)).toBe(false);

    // 对照：move-impact 的扁平入链保留自引用（内核中性）——证明过滤发生在消费面
    const impactRes = await getMoveImpact(targetDoc.id).expect(200);
    const impact = (impactRes.body as Envelope<{ inboundLinks: InboundLink[] }>).data;
    expect(impact.inboundLinks.some((l) => l.sourceDocId === targetDoc.id)).toBe(true);
  });

  it('软删来源不入列（候选集 deleted_at IS NULL，sections 仍在库）', async () => {
    if (!dbAvailable) return;

    // 前置事实：来源 D 的 sections 真的还在（否则本用例退化为"没数据"）
    const dSections = await ds.getRepository(DocSection).count({ where: { docId: sourceD.id } });
    expect(dSections).toBeGreaterThan(0);

    const res = await getBacklinks(targetDoc.id).expect(200);
    const body = (res.body as Envelope<BacklinksBody>).data;
    expect(body.sources.some((s) => s.sourceDocId === sourceD.id)).toBe(false);
  });

  it('顺序确定性：两次请求 sources/links 数组全等（含组内 position 升序）', async () => {
    if (!dbAvailable) return;

    const first = (await getBacklinks(targetDoc.id).expect(200)).body as Envelope<BacklinksBody>;
    const second = (await getBacklinks(targetDoc.id).expect(200)).body as Envelope<BacklinksBody>;

    expect(second.data.sources).toEqual(first.data.sources);
    // 组级：sourcePath 升序
    const paths = first.data.sources.map((s) => s.sourcePath);
    expect(paths).toEqual([...paths].sort());
    // 组内：sectionPosition 升序（B 的两条链接分别位于「相对引用段」「平台引用段」）
    const groupB = first.data.sources.find((s) => s.sourceDocId === sourceB.id)!;
    const positions = groupB.links.map((l) => l.sectionPosition!);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((p) => typeof p === 'number')).toBe(true);
  });

  // ─── ② 等价性护栏（HTTP 级，本内核的首个 HTTP 覆盖）────────────────────

  it('等价性护栏：flatten(backlinks 补回组级三键) ≡ moveImpact.inboundLinks（双方剔自引用 + 排序）', async () => {
    if (!dbAvailable) return;

    const backlinks = (
      (await getBacklinks(targetDoc.id).expect(200)).body as Envelope<BacklinksBody>
    ).data;
    const impact = (
      (await getMoveImpact(targetDoc.id).expect(200)).body as Envelope<{
        inboundLinks: InboundLink[];
      }>
    ).data;

    const flattened = normalizeForGuard(flattenBacklinks(backlinks), targetDoc.id);
    const flat = normalizeForGuard(impact.inboundLinks, targetDoc.id);

    // 非空前提：双方都至少覆盖了 B/C 两个来源（空数组会让护栏假绿）
    expect(flattened.length).toBeGreaterThanOrEqual(3);
    expect(flattened.length).toBe(flat.length);
    // 深度相等（顺序已规范化，禁止裸数组比较）
    expect(flattened).toEqual(flat);
    expect(flattened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceDocId: sourceB.id,
          sourcePath: sourceB.path,
          sourceTitle: sourceB.title,
          href: './target.md',
          isPathBased: true,
        }),
      ]),
    );
  });

  // ─── ③ 错误语义 ─────────────────────────────────────────────────────

  it('文档不存在 → 404 DOC_NOT_FOUND', async () => {
    if (!dbAvailable) return;

    const ghostId = '00000000-0000-4000-8000-00000000dead';
    const res = await getBacklinks(ghostId).expect(404);
    expect((res.body as Envelope<unknown> & { code: string }).code).toBe(ErrorCode.DOC_NOT_FOUND);
  });

  it('read 权限拒绝 → 404 DOC_SPACE_NOT_FOUND（不是 403，不泄露存在性）', async () => {
    if (!dbAvailable) return;

    const res = await getBacklinks(targetDoc.id, strangerToken).expect(404);
    expect((res.body as Envelope<unknown> & { code: string }).code).toBe(
      ErrorCode.DOC_SPACE_NOT_FOUND,
    );
  });

  it('未认证 → 401（守卫在场）', async () => {
    if (!dbAvailable) return;
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/docs/${targetDoc.id}/backlinks`)
      .expect(401);
  });

  it('空间隔离：无关文档不入列（来源集合恰为 B/C，防"全空间命中"假绿）', async () => {
    if (!dbAvailable) return;

    const res = await getBacklinks(targetDoc.id).expect(200);
    const body = (res.body as Envelope<BacklinksBody>).data;
    expect(body.sources.map((s) => s.sourceDocId).sort()).toEqual([sourceB.id, sourceC.id].sort());
    expect(body.sources.some((s) => s.sourceDocId === unrelated.id)).toBe(false);
    // 每条链接都是指向目标文档的形态（相对 .md 或平台 ?doc=），不掺他文档链接
    const hrefs = body.sources.flatMap((s) => s.links.map((l) => l.href));
    expect(hrefs.sort()).toEqual(
      [`/docs/${spaceId}?doc=${targetDoc.id}`, './target.md', './target.md'].sort(),
    );
  });
});

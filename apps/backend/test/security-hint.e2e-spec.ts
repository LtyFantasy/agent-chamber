/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `sensitive_credential_suspected`（v1.94.0-dev，卡 349d337e）的**端到端契约**：
 *     域侧写路径在真实写入成功后扫描正文 → 命中 ⇒ ① 落**告警行**（`SECURITY_CREDENTIAL_SUSPECTED`）
 *     ② 写领域事实 → 拦截器 provider 挂 `data.hints[]`。**告警与送达解耦**：各自可单独失效。
 *
 * [代码职责]
 *   - 钉住 **11 个挂点**的覆盖矩阵：doc（upsert / batch 逐条 / patchSection / patchContent /
 *     append）、task（create 双返回路径 + replay / update / patchDescription / addComment）、
 *     topic（幂等路径 + 无幂等路径）——**全部经真 HTTP + 真 PG**（不是服务直调）。
 *   - 钉住**门控**：幂等 replay / unchanged / per-item failed **一律不扫**（不产生第二条告警行）。
 *   - 钉住 `patchContent` / `patchDescription` **只扫 newString**（删除凭证片段是修复动作，
 *     不是泄漏 —— 扫 oldString 会把「修复」报成「泄漏」）。
 *   - 钉住**无正文外流**：告警行与 hints 子树的 JSON 里都不出现正文/凭证原文。
 *   - 钉住 **kill switch**（模块加载时读取 ⇒ 重启生效）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.3 / §5（告警埋点与消费方）/ §7（不覆盖清单）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关联代码]
 *   - src/modules/hints/credential-scan.ts — 告警 + 事实（本文件的主要被测对象）
 *   - src/common/utils/sensitive-patterns.ts — 检测器（TP/TN/耗时由它的 spec 覆盖）
 *   - src/modules/hints/security-hint.provider.ts — 事实 → 候选
 *   - src/modules/docspace/doc.controller.ts / doc.service.ts — doc 的五个挂点
 *   - src/modules/task/task.service.ts / src/modules/topic/topic.service.ts — 其余六个挂点
 *   - src/modules/hints/credential-scan.spec.ts — 双 kill switch 与告警行字段封闭的单测（权威）
 *
 * [持久踩坑]
 *   SEC-E2E-DOCSPACE(为什么本套件敢 import DocSpaceModule): 它 `forwardRef` →
 *     AttachmentModule（挂 `ScheduleModule.forRoot()` + MinIO 客户端）。MinIO 自举是
 *     **fail-open**（不可达只记 error、不 rethrow，见 storage.service.ts onModuleInit）
 *     且 cron 只挂日/周频 + 小时级在测试环境 disabled ⇒ 启动安全。代价 = 启动多几秒，
 *     收益 = doc 五个挂点拿到**真 HTTP** 覆盖（服务直调测不出 controller 的门控顺序）。
 *   SEC-E2E-KILLSWITCH(模块加载语义的取证边界): `HINT_CREDENTIAL_SCAN_DISABLED` /
 *     `HINT_CREDENTIAL_PATTERNS_DISABLED` 是**模块加载时读取**的（与 `HINT_PROVIDERS_DISABLED`
 *     的 boot 语义对齐）⇒ e2e 进程里模块早已加载，**无法**用 env 关掉正在运行的应用。
 *     故本文件的停机用例用 `jest.isolateModules` 重新加载模块取证（与单测同款手法，
 *     见 credential-scan.spec.ts）；「停机时 HTTP 响应无 hints」这一条不在 HTTP 层覆盖
 *     —— 开关检查是 helper 的第一行，无路径依赖（如实记账）。
 *   SEC-E2E-SHARED-DB(共享开发库): 全部数据带 RUN 后缀隔离；afterAll 先删子表再删父表
 *     （`doc_sections` / `task_comments` 等有 CASCADE，显式先删只为把意图写清楚）。
 *     events / audit_logs 无 FK，残留行无害、不清理。
 *   SEC-E2E-WINDOW(去重窗口是进程内单例): 同一 `{resourceKind}:{resourceId}` 6h 内只送达一次
 *     ⇒ **每个挂点用各自独立的 doc/task/topic**（否则第二条只落告警行、没有 hint——
 *     那本身是「解耦」的正面证据，但会让「每挂点都有 hint」的矩阵断言变脆）。
 * =============================================================================
 */

/**
 * 凭证扫描 —— 真实 PG + 真实 HTTP 端到端套件（11 个挂点）。
 *
 * ⚠️ fixture 里的凭证**拼装而非字面**（`ask_` 后 20+ 字符由表达式提供）：与计划派发警告
 * 同一条纪律——源码里不出现可直接扫描的字面凭证形态（同理，本文件不写字面 DSN）。
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import request = require('supertest');
import { Logger } from '@nestjs/common';
import { API_PREFIX, ActorType, AgentStatus, UserRole } from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { TaskModule } from '../src/modules/task/task.module';
import { TopicModule } from '../src/modules/topic/topic.module';
import { MemoryModule } from '../src/modules/memory/memory.module';
import { DocSpaceModule } from '../src/modules/docspace/docspace.module';
import { HintsModule } from '../src/modules/hints/hints.module';
import { HINT_FACT_PROVIDERS, HintInterceptor } from '../src/modules/hints/hint.interceptor';
import { HINT_FACT_PROVIDER_CHAIN } from '../src/config/app-hint-provider-chain';
import { SECURITY_HINT } from '../src/modules/hints/security-hint.constants';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其它套件） */
const JWT_SECRET = 'security-hint-e2e-secret';

/** 本次运行的唯一后缀：隔离数据 */
const RUN = `sec-${Date.now().toString(36)}`;

/**
 * 假凭证（**拼装**：源码里不出现可直接扫描的字面 key）。
 * 形态 = `ask_` + 28 位 + `_` + 3 位 = 32 位 base64url 风格的平台 key。
 */
const FAKE_KEY = `ask_${'A'.repeat(28)}_${'Z'.repeat(3)}`;

/** 正文里的一句独特文本（用来断言「正文没进告警行 / hints」） */
const BODY_MARKER = '本段正文只应存在于资源本体不应出现在任何告警行或提示里';

/** 带凭证的正文（每个挂点用它的变体） */
function bodyWithKey(prefix: string): string {
  return `${prefix}\n\n${BODY_MARKER}：${FAKE_KEY}\n`;
}

/** 干净的正文 */
function cleanBody(prefix: string): string {
  return `${prefix}\n\n${BODY_MARKER}（无凭证）。\n`;
}

/** 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态） */
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
class SecurityE2eAuthModule {}

/** 测试根模块：真库 + 真认证 + Task/Topic/DocSpace/Memory（链依赖）+ hint 基建 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: false,
    }),
    SecurityE2eAuthModule,
    CommonModule,
    PermissionModule,
    TaskModule,
    TopicModule,
    DocSpaceModule,
    // 链里有提名 provider ⇒ MemoryModule 必须可解析（见 app-hint-provider-chain）
    MemoryModule,
    HintsModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HintInterceptor },
    {
      provide: HINT_FACT_PROVIDERS,
      useFactory: (...providers: unknown[]) => providers,
      inject: [...HINT_FACT_PROVIDER_CHAIN],
    },
  ],
})
class SecurityE2eModule {}

/** 响应信封 */
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 信封内的 hint 条目 */
interface HintItem {
  code: string;
  status: string;
  message: string;
  data?: Record<string, unknown>;
}

describe('sensitive_credential_suspected（凭证扫描）— 真实 PG + 真实 HTTP 集成', () => {
  let app: INestApplication;
  let ds: DataSource;
  let warnSpy: jest.SpyInstance;
  let dbAvailable = false;

  let agentAId: string;
  let agentAKey: string;
  let spaceId: string;
  let listId: string;
  let topicId: string;

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
    boardIds: [] as string[],
    taskIds: [] as string[],
    topicIds: [] as string[],
    spaceIds: [] as string[],
    docIds: [] as string[],
  };

  /** 带身份的 HTTP 助手 */
  function req() {
    const agent = request(app.getHttpServer());
    return {
      put: (path: string) => agent.put(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
      patch: (path: string) => agent.patch(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
      post: (path: string) => agent.post(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
    };
  }

  /** 取响应里凭证提示的条目（键不出现 → undefined） */
  function credentialHints(body: unknown): HintItem[] | undefined {
    const hints = (body as Envelope<{ hints?: HintItem[] }>).data?.hints;
    const filtered = hints?.filter(
      (hint) => hint.code === SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED,
    );
    return filtered && filtered.length > 0 ? filtered : undefined;
  }

  /** 本进程落下的告警行（**按 tag 过滤**——同进程还有 hint 埋点与 Nest 自身 warn） */
  function suspectLines(): Array<Record<string, unknown>> {
    return warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('SECURITY_CREDENTIAL_SUSPECTED'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** 断言最近一次告警行的字段封闭 + 无正文 */
  function expectLastSuspectLine(over: {
    resourceKind: string;
    resourceId: string;
  }): Record<string, unknown> {
    const lines = suspectLines();
    expect(lines.length).toBeGreaterThan(0);
    const line = lines[lines.length - 1];
    expect(Object.keys(line).sort()).toEqual([
      'actorId',
      'patternIds',
      'resourceId',
      'resourceKind',
      'tag',
      'truncated',
      'ts',
    ]);
    expect(line).toMatchObject({ ...over, actorId: agentAId, patternIds: 'platform_agent_key' });
    // **正文与凭证原文都不进告警行**
    expect(JSON.stringify(line)).not.toContain(BODY_MARKER);
    expect(JSON.stringify(line)).not.toContain(FAKE_KEY);
    return line;
  }

  // ─── 夹具 ─────────────────────────────────────────────────────────

  /** 造一个看板列（`creatorId = agent A` ⇒ 对任务有 write） */
  async function createList(label: string): Promise<string> {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `sec board ${RUN} ${label}`,
        creatorId: agentAId,
        settings: { visibility: 'open' },
        taskCount: 0,
        completedTaskCount: 0,
      }),
    );
    created.boardIds.push(board.id);
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: `sec list ${RUN} ${label}`,
        position: 0,
      }),
    );
    return list.id;
  }

  /** 经 HTTP 造任务并返回 id（描述缺省留空，避免干扰告警计数） */
  async function createTask(label: string, description?: string): Promise<string> {
    const res = await req()
      .post('/tasks')
      .send({
        listId,
        title: `sec task ${RUN} ${label}`,
        ...(description === undefined ? {} : { description }),
      });
    expect(res.status).toBe(201);
    const taskId = (res.body as Envelope<{ id: string }>).data.id;
    created.taskIds.push(taskId);
    return taskId;
  }

  /** 经 HTTP upsert 一个文档并返回 id */
  async function upsertDoc(path: string, content: string): Promise<string> {
    const res = await req().put(`/doc-spaces/${spaceId}/docs`).send({ path, content });
    expect(res.status).toBe(200);
    const docId = (res.body as Envelope<{ id: string }>).data.id;
    created.docIds.push(docId);
    return docId;
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[security-hint e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }

    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('docs','tasks','topics','doc_spaces')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'doc_spaces',
      'docs',
      'tasks',
      'topics',
    ]);
    dbAvailable = true;

    // 告警行 spy 必须**先于应用启动**装好（Nest 自身启动日志也会走 warn，按 tag 过滤即可）
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [SecurityE2eModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: (
          await ds.getRepository(Actor).save(
            ds.getRepository(Actor).create({
              type: ActorType.HUMAN,
              displayName: `Sec Owner ${RUN}`,
              status: AgentStatus.ACTIVE,
            }),
          )
        ).id,
        username: `secowner${RUN}`.slice(0, 50),
        email: `sec-owner-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userIds.push(owner.id);

    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `Sec Agent ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `Sec Agent ${RUN}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);

    const rawKey = `ask_sec${RUN}`;
    const key = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.id,
      }),
    );
    created.keyIds.push(key.id);
    agentAId = agent.id;
    agentAKey = rawKey;

    // 空间 / 列 / 话题（全部 creatorId = agent A ⇒ 有 write）
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `sec space ${RUN}`,
        slug: `sec-space-${RUN}`,
        creatorId: agentAId,
        settings: {},
      }),
    );
    created.spaceIds.push(space.id);
    spaceId = space.id;

    listId = await createList('shared');

    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `sec topic ${RUN}`,
        creatorId: agentAId,
        settings: { visibility: 'open' },
        participantCount: 0,
        messageCount: 0,
      }),
    );
    created.topicIds.push(topic.id);
    topicId = topic.id;
  }, 180000);

  afterAll(async () => {
    warnSpy?.mockRestore();
    if (!dbAvailable) return;
    if (app) await app.close();

    if (created.docIds.length > 0) {
      await ds.query(`DELETE FROM doc_sections WHERE doc_id = ANY($1::uuid[])`, [created.docIds]);
      await ds.query(`DELETE FROM doc_versions WHERE doc_id = ANY($1::uuid[])`, [created.docIds]);
      await ds.query(`DELETE FROM docs WHERE id = ANY($1::uuid[])`, [created.docIds]);
    }
    if (created.taskIds.length > 0) {
      await ds.query(`DELETE FROM task_activities WHERE task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM task_comments WHERE task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [created.taskIds]);
    }
    if (created.topicIds.length > 0) {
      await ds.query(`DELETE FROM messages WHERE topic_id = ANY($1::uuid[])`, [created.topicIds]);
      await ds.query(`DELETE FROM topic_participants WHERE topic_id = ANY($1::uuid[])`, [
        created.topicIds,
      ]);
      await ds.query(`DELETE FROM topics WHERE id = ANY($1::uuid[])`, [created.topicIds]);
    }
    if (created.boardIds.length > 0) {
      await ds.query(`DELETE FROM board_lists WHERE board_id = ANY($1::uuid[])`, [
        created.boardIds,
      ]);
      await ds.query(`DELETE FROM boards WHERE id = ANY($1::uuid[])`, [created.boardIds]);
    }
    if (created.spaceIds.length > 0) {
      await ds.query(`DELETE FROM doc_spaces WHERE id = ANY($1::uuid[])`, [created.spaceIds]);
    }
    if (created.keyIds.length > 0) {
      await ds.query(`DELETE FROM api_keys WHERE id = ANY($1::uuid[])`, [created.keyIds]);
    }
    if (created.agentIds.length > 0) {
      await ds.query(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [created.agentIds]);
    }
    if (created.userIds.length > 0) {
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.userIds]);
    }
    if (created.actorIds.length > 0) {
      await ds.query(`DELETE FROM actors WHERE id = ANY($1::uuid[])`, [created.actorIds]);
    }
    await ds.destroy();
  }, 60000);

  // ─── doc 挂点（5） ────────────────────────────────────────────────

  it('① doc upsert：命中 ⇒ 告警行 + hints（data 键封闭 / 无正文）', async () => {
    if (!dbAvailable) return;
    warnSpy.mockClear();

    const docId = await upsertDoc(`sec/${RUN}/upsert.md`, bodyWithKey('# 标题'));

    expectLastSuspectLine({ resourceKind: 'doc', resourceId: docId });
  });

  it('①b doc upsert 的 hints 子树：data 三键 + matchedPatterns 是 label 数组 + 无正文', async () => {
    if (!dbAvailable) return;
    warnSpy.mockClear();

    const res = await req()
      .put(`/doc-spaces/${spaceId}/docs`)
      .send({ path: `sec/${RUN}/upsert-hint.md`, content: bodyWithKey('# 标题') });
    expect(res.status).toBe(200);
    created.docIds.push((res.body as Envelope<{ id: string }>).data.id);

    const hint = credentialHints(res.body);
    expect(hint).toHaveLength(1);
    expect(Object.keys(hint![0].data ?? {}).sort()).toEqual([
      'matchedPatterns',
      'resourceId',
      'resourceKind',
    ]);
    expect(hint![0].data).toMatchObject({
      resourceKind: 'doc',
      resourceId: (res.body as Envelope<{ id: string }>).data.id,
      matchedPatterns: ['平台 agent key（ask_ 前缀）'],
    });
    expect(hint![0].message).toContain('轮换');
    // **hints 子树无正文**（响应本体当然含正文——文档就该回显它）
    expect(JSON.stringify(hint)).not.toContain(BODY_MARKER);
    expect(JSON.stringify(hint)).not.toContain(FAKE_KEY);
  });

  it('② doc upsert 干净内容（TN）⇒ 无告警、无该码', async () => {
    if (!dbAvailable) return;
    warnSpy.mockClear();

    const res = await req()
      .put(`/doc-spaces/${spaceId}/docs`)
      .send({ path: `sec/${RUN}/clean.md`, content: cleanBody('# 干净标题') });
    expect(res.status).toBe(200);
    created.docIds.push((res.body as Envelope<{ id: string }>).data.id);

    expect(suspectLines()).toHaveLength(0);
    expect(credentialHints(res.body)).toBeUndefined();
  });

  it('③ doc upsert unchanged ⇒ **不重复告警**（同一份内容不重复计入分母）', async () => {
    if (!dbAvailable) return;

    const path = `sec/${RUN}/unchanged.md`;
    const content = bodyWithKey('# 标题');
    await upsertDoc(path, content);
    warnSpy.mockClear();

    const res = await req().put(`/doc-spaces/${spaceId}/docs`).send({ path, content });
    expect(res.status).toBe(200);
    expect((res.body as Envelope<{ unchanged?: boolean }>).data.unchanged).toBe(true);

    expect(suspectLines()).toHaveLength(0);
  });

  it('④ doc batch：**逐条**扫描——created 扫 / unchanged 不扫 / failed 不扫', async () => {
    if (!dbAvailable) return;

    // 一个 source='git' 的既有文档 ⇒ batch 里用同 path 的 item 会 per-item failed
    const gitPath = `sec/${RUN}/git-source.md`;
    const gitDoc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId,
        path: gitPath,
        title: 'git 文档',
        summary: null,
        contentHash: crypto.randomUUID(),
        sectionCount: 0,
        tags: [],
        source: 'git',
        createdBy: agentAId,
      }),
    );
    created.docIds.push(gitDoc.id);

    const newPath = `sec/${RUN}/batch-new.md`;
    warnSpy.mockClear();

    const res = await req()
      .put(`/doc-spaces/${spaceId}/docs/batch`)
      .send({
        docs: [
          { path: newPath, content: bodyWithKey('# 批量新文档') },
          // 同 path + 同内容 ⇒ unchanged（若门控缺失会再扫一次）
          { path: newPath, content: bodyWithKey('# 批量新文档') },
          // 非 native 文档写 native 内容 ⇒ per-item failed（不得扫）
          { path: gitPath, content: bodyWithKey('# 非法写入') },
        ],
      });
    expect(res.status).toBe(200);

    const results = (
      res.body as Envelope<{ results: Array<{ path: string; status: string; id?: string }> }>
    ).data.results;
    expect(results.map((item) => item.status)).toEqual(['created', 'unchanged', 'failed']);
    if (results[0].id) created.docIds.push(results[0].id);

    // **只有 created 那条落了一行告警**（三条都带凭证 ⇒ 门控若失效会落 3 行/2 行）
    const lines = suspectLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ resourceKind: 'doc', resourceId: results[0].id });
  });

  it('⑤ doc patchSection：整节新片段被扫 ⇒ 告警 + hints', async () => {
    if (!dbAvailable) return;

    const docId = await upsertDoc(`sec/${RUN}/patch-section.md`, cleanBody('# 标题'));
    warnSpy.mockClear();

    const res = await req()
      .patch(`/docs/${docId}/sections/0`)
      .send({ content: `# 标题\n\n${BODY_MARKER}：${FAKE_KEY}\n` });

    expect(res.status).toBe(200);
    expectLastSuspectLine({ resourceKind: 'doc', resourceId: docId });
    expect(credentialHints(res.body)).toHaveLength(1);
  });

  it('⑥ doc patchContent：**只扫 newString**——写入凭证报警，删除凭证不报警', async () => {
    if (!dbAvailable) return;

    const docId = await upsertDoc(`sec/${RUN}/patch-content.md`, cleanBody('# 标题'));

    // 6a：newString 带凭证 ⇒ 报警
    warnSpy.mockClear();
    const insert = await req()
      .patch(`/docs/${docId}/content`)
      .send({ oldString: `${BODY_MARKER}（无凭证）。`, newString: `${BODY_MARKER}：${FAKE_KEY}` });
    expect(insert.status).toBe(200);
    expect(suspectLines()).toHaveLength(1);
    expect(credentialHints(insert.body)).toHaveLength(1);

    // 6b：把刚写进去的凭证**删掉**（oldString 带凭证、newString 干净）⇒ **不报警**
    //（删除是修复动作，不是泄漏 —— 扫 oldString 会把修复报成泄漏）
    warnSpy.mockClear();
    const remove = await req()
      .patch(`/docs/${docId}/content`)
      .send({ oldString: `${BODY_MARKER}：${FAKE_KEY}`, newString: `${BODY_MARKER}（已清理）。` });
    expect(remove.status).toBe(200);
    expect(suspectLines()).toHaveLength(0);
  });

  it('⑦ doc append：追加片段被扫 ⇒ 告警 + hints', async () => {
    if (!dbAvailable) return;

    const docId = await upsertDoc(`sec/${RUN}/append.md`, cleanBody('# 标题'));
    warnSpy.mockClear();

    const res = await req()
      .post(`/docs/${docId}/append`)
      .send({ content: `\n## 追加节\n\n${BODY_MARKER}：${FAKE_KEY}\n` });

    expect(res.status).toBe(200);
    expectLastSuspectLine({ resourceKind: 'doc', resourceId: docId });
  });

  // ─── task 挂点（4 个调用点，5 条路径） ───────────────────────────

  it('⑧ task create **无幂等键**路径（:844）：描述被扫 ⇒ 告警 + hints', async () => {
    if (!dbAvailable) return;
    warnSpy.mockClear();

    const res = await req()
      .post('/tasks')
      .send({ listId, title: `sec create ${RUN}`, description: bodyWithKey('任务描述') });
    expect(res.status).toBe(201);
    const taskId = (res.body as Envelope<{ id: string }>).data.id;
    created.taskIds.push(taskId);

    expectLastSuspectLine({ resourceKind: 'task_description', resourceId: taskId });
    const hint = credentialHints(res.body);
    expect(hint).toHaveLength(1);
    expect(hint![0].data).toMatchObject({ resourceKind: 'task_description', resourceId: taskId });
  });

  it('⑨ task create **有幂等键**路径（:911）+ replay（:925）不重复告警', async () => {
    if (!dbAvailable) return;
    const payload = {
      listId,
      title: `sec idem ${RUN}`,
      description: bodyWithKey('幂等任务描述'),
      clientRequestId: `sec-idem-${RUN}`,
    };

    warnSpy.mockClear();
    const first = await req().post('/tasks').send(payload);
    expect(first.status).toBe(201);
    const taskId = (first.body as Envelope<{ id: string }>).data.id;
    created.taskIds.push(taskId);
    expectLastSuspectLine({ resourceKind: 'task_description', resourceId: taskId });
    expect(suspectLines()).toHaveLength(1);

    // replay：同一 clientRequestId + 同 payload ⇒ 幂等重放（**不是真实写入** ⇒ 禁 emit）
    warnSpy.mockClear();
    const replay = await req().post('/tasks').send(payload);
    expect(replay.status).toBe(201);
    expect((replay.body as Envelope<{ idempotentReplay?: boolean }>).data.idempotentReplay).toBe(
      true,
    );
    expect(suspectLines()).toHaveLength(0);
  });

  it('⑩ task update：`dto.description` 存在时被扫；只改标题不扫', async () => {
    if (!dbAvailable) return;
    const taskId = await createTask('update');

    warnSpy.mockClear();
    const withDescription = await req()
      .patch(`/tasks/${taskId}`)
      .send({ description: bodyWithKey('新描述') });
    expect(withDescription.status).toBe(200);
    expectLastSuspectLine({ resourceKind: 'task_description', resourceId: taskId });
    expect(suspectLines()).toHaveLength(1);

    warnSpy.mockClear();
    const titleOnly = await req()
      .patch(`/tasks/${taskId}`)
      .send({ title: `sec renamed ${RUN}` });
    expect(titleOnly.status).toBe(200);
    expect(suspectLines()).toHaveLength(0);
  });

  it('⑪ task patchDescription：**只扫 newString**（写凭证报警 / 删凭证不报警）', async () => {
    if (!dbAvailable) return;
    warnSpy.mockClear();
    const taskId = await createTask('patch-desc', `${BODY_MARKER}`);
    expect(suspectLines()).toHaveLength(0);

    // 11a：newString 带凭证 ⇒ 报警
    warnSpy.mockClear();
    const write = await req()
      .patch(`/tasks/${taskId}/description`)
      .send({ oldString: `${BODY_MARKER}`, newString: `${BODY_MARKER}：${FAKE_KEY}` });
    expect(write.status).toBe(200);
    expect(suspectLines()).toHaveLength(1);
    expectLastSuspectLine({ resourceKind: 'task_description', resourceId: taskId });

    // 11b：删除刚写入的凭证 ⇒ 不报警
    warnSpy.mockClear();
    const remove = await req()
      .patch(`/tasks/${taskId}/description`)
      .send({ oldString: `${BODY_MARKER}：${FAKE_KEY}`, newString: `${BODY_MARKER}（已清理）。` });
    expect(remove.status).toBe(200);
    expect(suspectLines()).toHaveLength(0);
  });

  it('⑫ task addComment：评论正文被扫 ⇒ 告警 + hints', async () => {
    if (!dbAvailable) return;
    const taskId = await createTask('comment');

    warnSpy.mockClear();
    const res = await req()
      .post(`/tasks/${taskId}/comments`)
      .send({ content: `${BODY_MARKER}：${FAKE_KEY}` });

    expect(res.status).toBe(201);
    expectLastSuspectLine({ resourceKind: 'task_comment', resourceId: taskId });
    const hint = credentialHints(res.body);
    expect(hint).toHaveLength(1);
    expect(hint![0].data).toMatchObject({ resourceKind: 'task_comment', resourceId: taskId });
  });

  // ─── topic 挂点（2 条路径） ──────────────────────────────────────

  it('⑬ topic 消息**无幂等键**路径：正文被扫 ⇒ 告警 + hints', async () => {
    if (!dbAvailable) return;
    warnSpy.mockClear();

    const res = await req()
      .post(`/topics/${topicId}/messages`)
      .send({ content: `${BODY_MARKER}：${FAKE_KEY}` });

    expect([200, 201]).toContain(res.status);
    expectLastSuspectLine({ resourceKind: 'topic_message', resourceId: topicId });
    const hint = credentialHints(res.body);
    expect(hint).toHaveLength(1);
    expect(hint![0].data).toMatchObject({ resourceKind: 'topic_message', resourceId: topicId });
  });

  it('⑭ topic 消息**幂等路径** + replay 不重复告警', async () => {
    if (!dbAvailable) return;
    const payload = { content: `${BODY_MARKER}：${FAKE_KEY}`, clientRequestId: `sec-msg-${RUN}` };

    warnSpy.mockClear();
    const first = await req().post(`/topics/${topicId}/messages`).send(payload);
    expect([200, 201]).toContain(first.status);
    expect(suspectLines()).toHaveLength(1);

    warnSpy.mockClear();
    const replay = await req().post(`/topics/${topicId}/messages`).send(payload);
    expect([200, 201]).toContain(replay.status);
    expect((replay.body as Envelope<{ idempotentReplay?: boolean }>).data.idempotentReplay).toBe(
      true,
    );
    expect(suspectLines()).toHaveLength(0);
  });

  // ─── 观测面纪律 ──────────────────────────────────────────────────

  it('⑮ 全部告警行都不含正文（收敛口径：响应本体回显正文，但告警行与 hints 不得外流）', async () => {
    if (!dbAvailable) return;

    // 制造一批带正文的写入，然后一次性核对**所有**告警行
    warnSpy.mockClear();
    await upsertDoc(`sec/${RUN}/sweep.md`, bodyWithKey('# 横扫'));
    await req()
      .post(`/topics/${topicId}/messages`)
      .send({ content: `${BODY_MARKER}：${FAKE_KEY}` });

    const lines = suspectLines();
    expect(lines.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(BODY_MARKER);
    expect(serialized).not.toContain(FAKE_KEY);
    // 每行都是**单 JSON 对象**（可被 stdout 采集链直接 parse）
    for (const line of lines) {
      expect(typeof line.tag).toBe('string');
      expect(line.tag).toBe('SECURITY_CREDENTIAL_SUSPECTED');
    }
  });

  it('⑯ kill switch：总开关关停后 helper 是纯 no-op（模块加载时读取 ⇒ 重启生效）', () => {
    if (!dbAvailable) return;

    const loadWithEnv = (env: { scanDisabled?: string; patternsDisabled?: string }) => {
      const prevScan = process.env.HINT_CREDENTIAL_SCAN_DISABLED;
      const prevPatterns = process.env.HINT_CREDENTIAL_PATTERNS_DISABLED;
      if (env.scanDisabled === undefined) delete process.env.HINT_CREDENTIAL_SCAN_DISABLED;
      else process.env.HINT_CREDENTIAL_SCAN_DISABLED = env.scanDisabled;
      if (env.patternsDisabled === undefined) delete process.env.HINT_CREDENTIAL_PATTERNS_DISABLED;
      else process.env.HINT_CREDENTIAL_PATTERNS_DISABLED = env.patternsDisabled;

      let loaded!: typeof import('../src/modules/hints/credential-scan');
      let isolatedWarn!: jest.SpyInstance;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nestCommon = require('@nestjs/common') as typeof import('@nestjs/common');
        isolatedWarn = jest
          .spyOn(nestCommon.Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        loaded = require('../src/modules/hints/credential-scan');
      });
      if (prevScan === undefined) delete process.env.HINT_CREDENTIAL_SCAN_DISABLED;
      else process.env.HINT_CREDENTIAL_SCAN_DISABLED = prevScan;
      if (prevPatterns === undefined) delete process.env.HINT_CREDENTIAL_PATTERNS_DISABLED;
      else process.env.HINT_CREDENTIAL_PATTERNS_DISABLED = prevPatterns;
      return { mod: loaded, isolatedWarn };
    };

    // 对照组：未关停 ⇒ 真的会扫（否则下面的「没落行」是假绿）
    const enabled = loadWithEnv({});
    enabled.mod.emitCredentialScanFactIfHit(FAKE_KEY, {
      resourceKind: 'doc',
      resourceId: 'doc-1',
    });
    expect(enabled.isolatedWarn).toHaveBeenCalledTimes(1);

    // 关停 ⇒ 零落行（扫描与告警全停）
    const disabled = loadWithEnv({ scanDisabled: 'true' });
    expect(disabled.mod.credentialScanDisabled()).toBe(true);
    disabled.mod.emitCredentialScanFactIfHit(FAKE_KEY, {
      resourceKind: 'doc',
      resourceId: 'doc-1',
    });
    expect(disabled.isolatedWarn).not.toHaveBeenCalled();

    // 模式级收敛 ⇒ 该模式不再命中（其余模式不受影响）
    const patternOff = loadWithEnv({ patternsDisabled: 'platform_agent_key' });
    patternOff.mod.emitCredentialScanFactIfHit(FAKE_KEY, {
      resourceKind: 'doc',
      resourceId: 'doc-1',
    });
    expect(patternOff.isolatedWarn).not.toHaveBeenCalled();
  });
});

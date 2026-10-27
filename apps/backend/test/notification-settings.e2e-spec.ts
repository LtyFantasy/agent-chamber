/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期设置面六端点的 **HTTP 契约 e2e**（真实路由 + 真实 ValidationPipe +
 *     **真实守卫链**），以及 **B1 回归门**（X-API-Key 认证的请求打六个端点全 401）。
 *
 * [代码职责]
 *   - JWT 正常 CRUD 一轮（PUT 绑定 → GET 可见 → DELETE → GET 不可见 + 再 DELETE 404）
 *   - B1 回归门：① 前提取证——直接构造真实 `JwtAuthGuard`，断言其 X-API-Key 分支**只挂
 *     `request.agent`、不挂 `request.user`**；② 以 `X-API-Key` 打六个端点（走**真实守卫** +
 *     打桩的 ApiKey/Agent 仓储让鉴权真的成功）⇒ 全 401 且零写入
 *   - 未验证置 enabled=true ⇒ 400；test 限流 ⇒ 429 + `Retry-After` + `data.retryAfterSeconds`
 *   - PUT prefs 非法键/非法值 ⇒ 400；DELETE prefs ⇒ 恢复缺省集（B2）
 *
 * [权威文档]
 *   - 主文档: plan `red-tornado-wonder-woman-blue-devil.md` §D5（六端点全契约）
 *
 * [关键不变量]
 *   - **必须带 `Authorization: Bearer <JWT>`**：`test-setup` 的 `overrideGuard(JwtAuthGuard)` 对
 *     这些路由**不生效**（实测：不带 token 时 401 来自真实 passport 守卫），故本套件按
 *     `board.e2e-spec.ts` 的既有做法签发真 token + 提供 `User.findOne` 替身。
 *   - **B1 的两半分工（harness 边界，别误读）**：这条路由上有两层守卫——全局 `APP_GUARD`（真实）
 *     与控制器 `@UseGuards(JwtAuthGuard)`（test-setup 的替身，会凭空注入 userId，好让其它套件
 *     免 token 调受保护端点）。**HTTP 层因此构造不出"已认证但没有 userId"的请求**：
 *     · 前提取证（真实守卫在 X-API-Key 分支只挂 `request.agent`）→ 本套件第一条用例；
 *     · 服务侧判空（六入口 401 TOKEN_INVALID）→ `notification-settings.service.spec.ts`；
 *     · 本套件守的是**路由是否漏挂守卫**（无凭据打六端点全 401）。
 *   - **仓储用内存仿真而不是纯 jest.fn()**：本批的核心写路径是**条件 UPDATE**（M3），只有把
 *     `set`/`where`/`execute` 真的作用到行集合上，才能验证"未验证地址不许置启用（400）"与
 *     "tombstone 不可见（404）"这两条**由 `affected` 驱动**的语义。
 *   - **`NOTIFY_ENABLED=true` + `NOTIFY_PROVIDERS=feishu` 但刻意不给飞书凭据**：provider 在凭据
 *     缺失时本地短路返回失败 ⇒ **零真实出境**，同时能走通 enabled/provider/限流/总闸/写态分支。
 *   - **409（地址被他人占用）无法在本套件制造**：要求两个账户对同一地址都"验证成功"，而验证
 *     成功需要真实凭据。409 由 `notification-settings.service.spec.ts` 的 M4 用例与
 *     `user-notification-channels-schema.e2e-spec.ts` 的 23505 断言覆盖。
 *
 * [关联代码]
 *   - src/modules/notifications/notification-settings.controller.ts — 被测路由
 *   - test/test-setup.ts — AppModule 级测试装置（本套件复用）
 *   - src/common/guards/jwt-auth.guard.ts — B1 前提取证的被测真实守卫
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查) #21(双层校验)
 * =============================================================================
 */
import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { ErrorCode, AgentStatus, UserRole } from '@agent-chamber/shared';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mocked-hash'),
  })),
  randomBytes: jest.fn(() => ({ toString: jest.fn().mockReturnValue('mocked-random-bytes') })),
}));

/** 仿真行（`user_notification_channels` 的最小列集） */
interface Row {
  id: string;
  userId: string;
  provider: string;
  recipientAddress: string;
  enabled: boolean;
  lastTestAt: Date | null;
  lastTestStatus: string | null;
  lastTestAddress: string | null;
  source: string;
  unboundAt: Date | null;
  createdAt: Date;
}

const USER_ID = '00000000-0000-4000-8000-000000000005';

describe('NotificationSettingsController (e2e) —— 六端点 HTTP 契约 + B1 回归门', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;
  let authToken: string;
  let rows: Row[];
  let prefs: Record<string, unknown>;
  let idSeq: number;

  beforeAll(() => {
    // 让六端点走"已启用 + 有出口"的分支（仍无凭据 ⇒ 无出境，见文件头不变量）
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_PROVIDERS = 'feishu';
    process.env.NOTIFY_CATEGORIES = 'task_done,direct';
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });

  afterAll(() => {
    delete process.env.NOTIFY_ENABLED;
    delete process.env.NOTIFY_PROVIDERS;
    delete process.env.NOTIFY_CATEGORIES;
  });

  beforeEach(async () => {
    rows = [];
    prefs = {};
    idSeq = 0;
    ({ app, mockRepos } = await createTestingApp());

    authToken = app.get(JwtService).sign({
      sub: USER_ID,
      email: 'settings-e2e@example.com',
      role: UserRole.EDITOR,
    });

    // JwtStrategy.validate 的读路径（真实守卫要它）+ 服务侧 requireUser 的读路径
    mockRepos.User.findOne.mockImplementation(async () => ({
      id: USER_ID,
      email: 'settings-e2e@example.com',
      username: 'settings-e2e',
      role: UserRole.EDITOR,
      deletedAt: null,
      status: AgentStatus.ACTIVE,
      preferences: { ...prefs },
      actor: { status: AgentStatus.ACTIVE, deletedAt: null },
    }));

    // X-API-Key 认证成功所需的两个仓储替身（B1 矩阵用；默认让它们也能通过）
    mockRepos.ApiKey.findOne.mockResolvedValue({
      id: 'key-1',
      keyHash: 'mocked-hash',
      revokedAt: null,
      deletedAt: null,
      expiresAt: null,
      agentId: 'agent-1',
    } as never);
    mockRepos.Agent.findOne.mockResolvedValue({
      id: 'agent-1',
      name: 'probe-agent',
      ownerId: USER_ID,
      actor: { status: AgentStatus.ACTIVE, deletedAt: null },
    } as never);

    // ── 偏好原子写（B2）：把 SQL 真的落到内存 prefs 上 ──
    mockRepos.User.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (String(sql).includes('jsonb_set')) {
        const patch = JSON.parse(String(params[1])) as Record<string, unknown>;
        const current = (prefs['notificationCategories'] ?? {}) as Record<string, unknown>;
        prefs['notificationCategories'] = { ...current, ...patch };
      } else if (String(sql).includes("preferences - 'notificationCategories'")) {
        delete prefs['notificationCategories'];
      }
      return [];
    });

    // ── 渠道表仿真（条件 UPDATE 真的作用到行集合上）──
    const channelRepo = mockRepos.UserNotificationChannel;
    channelRepo.create.mockImplementation((row: Partial<Row>) => ({
      enabled: false,
      lastTestAt: null,
      lastTestStatus: null,
      lastTestAddress: null,
      source: 'user',
      unboundAt: null,
      createdAt: new Date('2026-10-13T00:00:00Z'),
      ...row,
    }));
    channelRepo.save.mockImplementation(async (row: Partial<Row>) => {
      const id = (row.id as string) ?? `ch-${(idSeq += 1)}`;
      const fresh = { ...(row as Row), id };
      const index = rows.findIndex((candidate) => candidate.id === id);
      if (index >= 0) rows[index] = fresh;
      else rows.push(fresh);
      return fresh;
    });
    channelRepo.find.mockImplementation(async (options?: { where?: Record<string, unknown> }) => {
      const where = options?.where ?? {};
      return rows
        .filter(
          (row) =>
            (where.userId === undefined || row.userId === where.userId) &&
            (where.provider === undefined || row.provider === where.provider) &&
            // GET /me 的 tombstone 过滤就落在这条谓词上（unboundAt: IsNull()）
            (where.unboundAt === undefined || row.unboundAt === null),
        )
        .map((row) => ({ ...row }));
    });
    channelRepo.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
      const where = options?.where ?? {};
      const found = rows.find(
        (row) =>
          (where.userId === undefined || row.userId === where.userId) &&
          (where.provider === undefined || row.provider === where.provider) &&
          (where.unboundAt === undefined || row.unboundAt === null),
      );
      return found ? { ...found } : null;
    });
    channelRepo.createQueryBuilder.mockImplementation(() => {
      const predicates: Array<(row: Row) => boolean> = [];
      let patch: Partial<Row> = {};
      const builder: Record<string, unknown> = {
        update: jest.fn(() => builder),
        set: jest.fn((value: Partial<Row>) => {
          patch = value;
          return builder;
        }),
        where: jest.fn((sql: string, params: Record<string, unknown>) => {
          predicates.push(makePredicate(sql, params));
          return builder;
        }),
        andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
          predicates.push(makePredicate(sql, params));
          return builder;
        }),
        execute: jest.fn(async () => {
          const hits = rows.filter((row) => predicates.every((predicate) => predicate(row)));
          for (const hit of hits) Object.assign(hit, patch);
          return { affected: hits.length };
        }),
      };
      return builder;
    });
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * 把本服务实际发出的谓词串翻译成行过滤函数（未知谓词直接抛错——仿真器不许"猜"）。
   *
   * @param sql 谓词 SQL（本服务只用固定几种，见 notification-settings.service.ts）
   * @param params 绑定参数
   */
  function makePredicate(sql: string, params: Record<string, unknown>): (row: Row) => boolean {
    if (sql.startsWith('user_id = :userId')) return (row) => row.userId === params.userId;
    if (sql.startsWith('id = :id')) return (row) => row.id === params.id;
    if (sql.startsWith('provider = :provider')) return (row) => row.provider === params.provider;
    if (sql.includes('recipient_address = :recipientAddress')) {
      return (row) => row.recipientAddress === params.recipientAddress;
    }
    if (sql.includes('recipient_address = :address')) {
      return (row) => row.recipientAddress === params.address;
    }
    if (sql.includes('unbound_at IS NULL')) return (row) => row.unboundAt === null;
    if (sql.includes('last_test_address = recipient_address')) {
      return (row) => row.lastTestAddress === row.recipientAddress;
    }
    if (sql.includes('last_test_status IN')) {
      return (row) => (params.verifiedStatuses as string[]).includes(row.lastTestStatus ?? '');
    }
    throw new Error(`e2e 仿真器不认识的谓词：${sql}（实现变了就同步这里）`);
  }

  /** 带人类 JWT 的请求（真实守卫需要 Bearer token，见文件头不变量） */
  const asHuman = (method: 'get' | 'put' | 'post' | 'delete', path: string) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${authToken}`);

  /** 绑一个渠道 */
  async function bindChannel(address: string, body: Record<string, unknown> = {}) {
    return asHuman('put', '/notification-settings/me/channels/feishu').send({
      recipientOpenId: address,
      ...body,
    });
  }

  // ───────────────────────── B1 回归门 ─────────────────────────

  it('B1 前提取证：真实 JwtAuthGuard 的 X-API-Key 分支**不挂 request.user**（只挂 request.agent）', async () => {
    const guard = new JwtAuthGuard(
      // Reflector 只用于读 @Public 元数据：替身恒 false（本用例不测公开端点）
      { getAllAndOverride: () => false } as never,
      {
        authenticate: jest.fn().mockResolvedValue({ agentId: 'agent-1', actorId: 'agent-1' }),
      } as never,
    );

    const httpRequest: Record<string, unknown> = { headers: { 'x-api-key': 'ask_probe' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => httpRequest }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as never;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(httpRequest.agent).toBeDefined();
    // ⚠️ 这就是 B1 的根因：API-Key 分支没有 request.user ⇒ @CurrentUser('userId') 为 undefined
    // ⇒ `findOne({id: undefined})` 丢 WHERE 命中 users 首行 = 认证绕过。
    // 服务侧对此的防线（401 TOKEN_INVALID）由 service.spec 的 B1 矩阵逐入口覆盖——
    // 本套件在 HTTP 层构造不出这种请求（见下方用例的 harness 边界说明）。
    expect(httpRequest.user).toBeUndefined();
  });

  it('B1 回归门（HTTP 层）：六端点**全部要求凭据**——无任何凭据 ⇒ 全 401 且零写入', async () => {
    // ⚠️ **harness 边界（必须说清楚）**：这条路由上有**两层**守卫——
    //   · AppModule 的全局 APP_GUARD（真实守卫，替身对它不生效）；
    //   · 控制器的 `@UseGuards(JwtAuthGuard)`（被 test-setup 的替身替换，且替身会**凭空注入
    //     一个 userId**，以便其它套件免 token 调受保护端点）。
    // 后果：在 HTTP 层**无法**构造"通过认证但没有 userId"的请求（替身总会补一个），
    // 故"服务侧判空"这一层由 `notification-settings.service.spec.ts` 的 B1 矩阵（六入口
    // 直接以 `undefined` 调用 ⇒ 401 TOKEN_INVALID）承担；本用例守的是另一半风险——
    // **新增的六个路由有没有一个漏挂守卫**（漏挂 = 任何匿名请求都能读写通知设置）。
    // ⚠️ **惰性构造**：supertest 的 `Test` 在**执行时**才 listen，且它自己起的临时服务在响应后
    // 会被关掉——6 个 Test 对象预先创建会指向同一个已关闭的端口（实测 ECONNREFUSED）。
    const calls: Array<() => request.Test> = [
      () => request(app.getHttpServer()).get('/notification-settings/me'),
      () =>
        request(app.getHttpServer())
          .put('/notification-settings/me/channels/feishu')
          .send({ recipientOpenId: 'ou_anon_probe' }),
      () => request(app.getHttpServer()).delete('/notification-settings/me/channels/feishu'),
      () => request(app.getHttpServer()).post('/notification-settings/me/channels/feishu/test'),
      () =>
        request(app.getHttpServer())
          .put('/notification-settings/me/prefs')
          .send({ notificationCategories: { topic: true } }),
      () => request(app.getHttpServer()).delete('/notification-settings/me/prefs'),
    ];

    const seen: number[] = [];
    for (const call of calls) {
      const response = await call();
      seen.push(response.status);
      expect(response.status).toBe(401);
    }
    // 一个字节都没写（既没建行也没改偏好）
    expect(rows).toEqual([]);
    expect(mockRepos.User.query).not.toHaveBeenCalled();
    expect(mockRepos.UserNotificationChannel.save).not.toHaveBeenCalled();
    expect(seen).toEqual([401, 401, 401, 401, 401, 401]);
  });

  // ─────────────────── JWT 正常 CRUD 一轮 ───────────────────

  it('JWT：PUT 绑定 → GET 可见 → DELETE 解绑 → GET 不可见 + 再 DELETE 404', async () => {
    const address = 'ou_jwt_round';

    const put = await bindChannel(address);
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({
      provider: 'feishu',
      recipientAddress: address,
      enabled: false,
      lastTestStatus: null,
      source: 'user',
    });
    expect(rows).toHaveLength(1);

    const get1 = await asHuman('get', '/notification-settings/me');
    expect(get1.status).toBe(200);
    expect(get1.body.data.channels).toHaveLength(1);
    expect(get1.body.data.channels[0].recipientAddress).toBe(address);
    // B2：未覆盖的键落缺省集
    expect(get1.body.data.prefs.categories.task_done).toBe(true);
    expect(get1.body.data.prefs.defaults).toEqual(['task_done', 'direct']);

    const del = await asHuman('delete', '/notification-settings/me/channels/feishu');
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ deleted: true });
    expect(rows[0].unboundAt).toBeInstanceOf(Date);
    expect(rows[0].enabled).toBe(false);

    const get2 = await asHuman('get', '/notification-settings/me');
    expect(get2.body.data.channels).toEqual([]);

    const del2 = await asHuman('delete', '/notification-settings/me/channels/feishu');
    expect(del2.status).toBe(404);
  });

  it('未验证地址置 enabled=true ⇒ 400（服务端不变量的 HTTP 面）', async () => {
    await bindChannel('ou_unverified');

    const response = await asHuman('put', '/notification-settings/me/channels/feishu').send({
      enabled: true,
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/not been verified/i);
    expect(rows[0].enabled).toBe(false); // 一个字都没写
  });

  it('未知 provider ⇒ 400（`:provider` 值域管道）', async () => {
    const response = await asHuman('put', '/notification-settings/me/channels/email').send({
      recipientOpenId: 'x@example.com',
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Unknown notification provider/);
  });

  it('test：无活绑定 ⇒ 404；限流第 4 次 ⇒ 429 + Retry-After + data.retryAfterSeconds', async () => {
    const missing = await asHuman('post', '/notification-settings/me/channels/feishu/test');
    expect(missing.status).toBe(404);

    await bindChannel('ou_rate_limit');
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await asHuman('post', '/notification-settings/me/channels/feishu/test');
      statuses.push(response.status);
      if (index < 3) {
        // 无凭据 ⇒ 本地短路失败（零出境），信封同形
        expect(response.body.data).toEqual({
          delivered: 0,
          channels: [],
          reason: 'delivery_failed',
        });
      } else {
        expect(response.status).toBe(429);
        expect(response.headers['retry-after']).toBeDefined();
        expect(response.body.data.retryAfterSeconds).toBeGreaterThan(0);
        expect(response.body.code).toBe(ErrorCode.RATE_LIMITED);
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // 写态纪律（M6）：凭据缺失属 provider 类 ⇒ **不写验证态**
    expect(rows[0].lastTestStatus).toBeNull();
  });

  it('PUT prefs：合法稀疏覆盖 ⇒ 200 且显式布尔覆盖缺省；非法键 / 非布尔 ⇒ 400', async () => {
    const ok = await asHuman('put', '/notification-settings/me/prefs').send({
      notificationCategories: { topic: true, task_done: false },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.topic).toBe(true);
    expect(ok.body.data.task_done).toBe(false); // 显式关覆盖缺省 true
    expect(ok.body.data.direct).toBe(true); // 未提及 ⇒ 缺省

    const badKey = await asHuman('put', '/notification-settings/me/prefs').send({
      notificationCategories: { bogus_key: true },
    });
    expect(badKey.status).toBe(400);

    const badValue = await asHuman('put', '/notification-settings/me/prefs').send({
      notificationCategories: { topic: 'yes' },
    });
    expect(badValue.status).toBe(400);
  });

  it('DELETE prefs ⇒ 恢复缺省集（只删 notificationCategories 键）', async () => {
    await asHuman('put', '/notification-settings/me/prefs').send({
      notificationCategories: { topic: true, task_done: false },
    });

    const response = await asHuman('delete', '/notification-settings/me/prefs');
    expect(response.status).toBe(200);
    expect(response.body.data.task_done).toBe(true);
    expect(response.body.data.direct).toBe(true);
    expect(response.body.data.topic).toBe(false);
    expect(prefs['notificationCategories']).toBeUndefined();
  });

  it('JWT 正常路径：GET /me 返回契约形状（守卫行为由 B1 两条用例承担）', async () => {
    const response = await asHuman('get', '/notification-settings/me');
    expect(response.status).toBe(200);
    expect(response.body.data.channels).toEqual([]);
    expect(response.body.data.prefs.defaults).toEqual(['task_done', 'direct']);
    expect(response.body.data.prefs.relevantScopes).toBeDefined();
    expect(Array.isArray(response.body.data.platform.providers)).toBe(true);
  });
});

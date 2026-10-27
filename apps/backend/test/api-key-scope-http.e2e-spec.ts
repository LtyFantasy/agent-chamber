/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §2.1 —— API Key scope 语义表 + 判定规则 + 豁免面
 *   - 代码侧: apps/backend/src/common/guards/api-key-scope.guard.ts（守卫）
 *             apps/backend/src/config/agent-scope-exemptions.ts（豁免清单单源）
 *
 * [本套件职责]
 *   - **HTTP 线缆层**的 scope 执行面验证：403 是否真的带业务码 **1011**（而不是被
 *     all-exceptions.filter 静默降级成 FORBIDDEN/403）、方法判定与豁免端点在真实
 *     路由上是否按预期放行、DTO 层对非法 scopes 是否 400。
 *   - 姊妹套件 `api-key-scopes.e2e-spec.ts` 覆盖**真 PG** 侧的链（建 key → 落库 →
 *     authenticate → 守卫判定 / resetKey 交集 / BOLA）。两套刻意分开：本套件走
 *     test-setup 的 mock 仓库（含 jest.mock('crypto')，与真库哈希互斥）。
 *
 * [铁律关联] #9(代理层透传——403 不得被包装成 500 或丢业务码) #17(测试契约) #8(测试绑定)
 *
 * [harness 边界]（必须说清楚，否则结论会被误读）
 *   - test-setup 用 `overrideGuard` 替掉了**控制器级** `@UseGuards(JwtAuthGuard/JwtOrApiKeyGuard)`
 *     （替身会凭空注入 request.user），但 **AppModule 的全局 APP_GUARD 是真实的**——
 *     `ApiKeyScopeGuard` 正是全局守卫，故本套件的断言由真实守卫产出。
 *   - 副作用：控制器看到的 actor 是替身注入的 human observer（@CurrentActor 优先 user），
 *     因此业务层可能返回 403/404/500。**本套件只断言"是不是 scope 拒绝"**（code 是否
 *     1011），不断言业务层的 200/404——那是各业务套件的职责。
 * =============================================================================
 */
import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';
import { ErrorCode } from '@agent-chamber/shared';

/** scope 拒绝的业务码（与守卫实现同源：shared ErrorCode.AGENT_SCOPE_INSUFFICIENT） */
const SCOPE_CODE = ErrorCode.AGENT_SCOPE_INSUFFICIENT;

/** 豁免端点用的占位路径参数（UUID 形状，避免 ParseUUIDPipe 400 掩盖守卫判定） */
const EXEMPT_UUID = '00000000-0000-4000-8000-000000000123';

describe('API Key scopes — HTTP 线缆层（403 业务码 / 方法判定 / 豁免面）', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRepos: Record<string, any>;

  /** 让全局 JwtAuthGuard 的 X-API-Key 分支认证成功，并挂上指定 scopes */
  function authAsKey(scopes: unknown): void {
    mockRepos.ApiKey.findOne.mockResolvedValue({
      id: 'key-1',
      agentId: 'agent-1',
      keyHash: 'mocked-hash',
      keyPrefix: 'ask_test',
      name: 'K',
      revokedAt: null,
      deletedAt: null,
      expiresAt: null,
      permissions: scopes === undefined ? undefined : { scopes },
      lastUsedAt: null,
    });
    mockRepos.Agent.findOne.mockResolvedValue({
      id: 'agent-1',
      name: 'Agent One',
      ownerId: '00000000-0000-4000-8000-000000000005',
      status: 'active',
      actor: { id: 'agent-1', status: 'active' },
    });
  }

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());
  });

  afterEach(async () => {
    await app.close();
  });

  const withKey = (req: request.Test) => req.set('X-API-Key', 'ask_probe_key');

  it('只读 key + POST 写端点 → 403 且 body.code = 1011（数字业务码未被 filter 降级）', async () => {
    authAsKey(['read']);
    const res = await withKey(request(app.getHttpServer()).post('/agents')).send({
      name: 'X',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(SCOPE_CODE);
    expect(res.body.code).toBe(1011);
    // 403 教学化三要素在线上响应里可见（不是 500、不是泛化 FORBIDDEN）
    expect(String(res.body.message)).toContain("'write'");
    expect(String(res.body.message)).toContain('POST /agents/:id/keys');
  });

  it('只读 key + GET 端点 → 不是 scope 拒绝（方法判定 read 放行）', async () => {
    authAsKey(['read']);
    const res = await withKey(request(app.getHttpServer()).get('/agents/me/unread'));
    expect(res.body.code).not.toBe(SCOPE_CODE);
  });

  it('只读 key + PATCH /topics/:id/notification-settings → 403 + 1011（PATCH 按方法映射 = write，无豁免）', async () => {
    // v1.96.0-dev D5：新设置端点是**写**语义（持久化改 notification_settings），
    // 按方法映射需 write scope；豁免清单里没有它（agent-scope-exemptions.spec.ts 双向相等强制）。
    authAsKey(['read']);
    const res = await withKey(
      request(app.getHttpServer()).patch(`/topics/${EXEMPT_UUID}/notification-settings`),
    ).send({ mentionsOnly: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(SCOPE_CODE);
    expect(res.body.code).toBe(1011);
    expect(String(res.body.message)).toContain("'write'");

    // 配对断言：路由确实注册着（无凭据 → 401，而不是 404 未命中）
    const anon = await request(app.getHttpServer())
      .patch(`/topics/${EXEMPT_UUID}/notification-settings`)
      .send({ mentionsOnly: true });
    expect(anon.status).toBe(401);
  });

  /** 豁免端点的真实路径 + 最小合法 body（只用于触发路由，不追求业务成功） */
  const EXEMPT_ROUTES: ReadonlyArray<{
    label: string;
    path: string;
    body: Record<string, unknown>;
  }> = [
    {
      label: 'POST /memory/projects/:id/recalls',
      path: `/memory/projects/${EXEMPT_UUID}/recalls`,
      body: { query: 'x', contextIdentity: 'i', contextEpoch: 1 },
    },
    {
      label: 'POST /doc-spaces/:id/diagrams/validate',
      path: `/doc-spaces/${EXEMPT_UUID}/diagrams/validate`,
      body: { ir: {} },
    },
    {
      label: 'POST /attachments/:id/signed-url',
      path: `/attachments/${EXEMPT_UUID}/signed-url`,
      body: {},
    },
    { label: 'POST /topics/:id/read', path: `/topics/${EXEMPT_UUID}/read`, body: {} },
    {
      label: 'POST /system/usage-events',
      path: '/system/usage-events',
      body: { tool: 'noop', surface: 'mcp', latencyMs: 1 },
    },
  ];

  it.each(EXEMPT_ROUTES.map((r) => [r.label, r.path, r.body] as const))(
    '只读 key + 豁免端点 %s → 不是 scope 拒绝（且路由确实注册着）',
    async (label, path, body) => {
      authAsKey(['read']);
      const res = await withKey(request(app.getHttpServer()).post(path)).send(body);
      // 豁免生效 = 守卫没拦（业务层可能 200/400/404/500，均不属 scope 拒绝）
      expect({ label, status: res.status, code: res.body?.code }).not.toEqual({
        label,
        status: 403,
        code: SCOPE_CODE,
      });

      // 配对断言（2026-10-16 code-review m3）：上面那条**负**断言可被 **404 路由不存在**满足——
      // 一个拼错/被删掉的路由同样"不是 403"，于是豁免断言会在路由消失后静默保持绿。
      // 这一条证明路由**注册着**：不带任何凭据 → 401（认证层拦截，而非 404 未命中）。
      const anon = await request(app.getHttpServer()).post(path).send(body);
      expect({ label, status: anon.status }).toEqual({ label, status: 401 });
    },
  );

  it('双权 key + POST → 不是 scope 拒绝（回归：不误伤存量双权 key）', async () => {
    authAsKey(['read', 'write']);
    const res = await withKey(request(app.getHttpServer()).post('/agents')).send({ name: 'X' });
    expect(res.body.code).not.toBe(SCOPE_CODE);
  });

  it('scopes 缺失 / 空数组 / 含未知值 → fail-closed，POST 一律 403 + 1011', async () => {
    for (const scopes of [undefined, [], ['admin'], ['read', 'admin']]) {
      authAsKey(scopes);
      const res = await withKey(request(app.getHttpServer()).post('/agents')).send({ name: 'X' });
      expect({ scopes, status: res.status, code: res.body.code }).toEqual({
        scopes,
        status: 403,
        code: SCOPE_CODE,
      });
    }
  });

  it('human JWT（无 X-API-Key）→ 不是 scope 拒绝（守卫只对 API Key 身份生效）', async () => {
    const token = app.get(JwtService).sign({
      sub: '00000000-0000-4000-8000-000000000005',
      email: 'test@example.com',
      role: 'admin',
    });
    const res = await request(app.getHttpServer())
      .post('/agents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(res.body.code).not.toBe(SCOPE_CODE);
  });

  it('OPTIONS 预检 → 不被 scope 守卫拦截（唯一方法级旁路）', async () => {
    authAsKey(['read']);
    const res = await withKey(request(app.getHttpServer()).options('/agents'));
    expect(res.status).not.toBe(403);
  });

  it('DTO 层：scopes 传未知值 / 空数组 → 400（不会流到 service/DB）', async () => {
    authAsKey(['read', 'write']);
    const uuid = '00000000-0000-4000-8000-000000000123';

    const unknown = await withKey(request(app.getHttpServer()).post(`/agents/${uuid}/keys`)).send({
      name: 'K',
      scopes: ['admin'],
    });
    expect(unknown.status).toBe(400);
    // 注意：ValidationPipe 抛的是裸 BadRequestException（无业务 code）→ filter 按 HTTP 兜底，
    // 故这里 code 是 400（BAD_REQUEST），**不是** 9000；关键断言是"没到 1011/没进 service"
    expect(unknown.body.code).toBe(ErrorCode.BAD_REQUEST);
    expect(unknown.body.code).not.toBe(SCOPE_CODE);

    const empty = await withKey(request(app.getHttpServer()).post(`/agents/${uuid}/keys`)).send({
      name: 'K',
      scopes: [],
    });
    expect(empty.status).toBe(400);

    const nonArray = await withKey(request(app.getHttpServer()).post(`/agents/${uuid}/keys`)).send({
      name: 'K',
      scopes: 'read',
    });
    expect(nonArray.status).toBe(400);
  });
});

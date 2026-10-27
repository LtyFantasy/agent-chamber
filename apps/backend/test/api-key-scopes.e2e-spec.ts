/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §2.1（scope 语义表 / 判定规则 / 豁免面）+ §5（agent keys）
 *   - 代码侧: apps/backend/src/common/utils/api-key-scope.ts（判定单源）
 *             apps/backend/src/common/guards/api-key-scope.guard.ts（执行面）
 *             apps/backend/src/modules/agent/agent-key-projection.ts（响应白名单）
 *             apps/backend/src/config/agent-scope-exemptions.ts（豁免清单单源）
 *
 * [本套件职责]
 *   - **真 PG** 侧的 scope 执行链与 key 生命周期不变量：
 *     建 key（scopes）→ **真库落行** → ApiKeyAuthService.authenticate（真哈希、真 JOIN）
 *     → 守卫按真实 payload 判定；resetKey 交集继承（混合 scope）；BOLA 收窄；投影白名单。
 *   - 姊妹套件 `api-key-scope-http.e2e-spec.ts` 覆盖 **HTTP 线缆层**（403 业务码 1011 /
 *     方法判定 / 豁免端点 / DTO 400）。两套刻意分开：那套走 test-setup 的 mock 仓库
 *     （其 jest.mock('crypto') 与真库哈希互斥），本套件**不 import test-setup**，用真 crypto。
 *
 * [为什么豁免端点在本套件用"真实 handler 元数据"驱动守卫]
 *   守卫的单一真源是 handler 元数据（Reflector），不是路径字符串。用真实 controller 的
 *   原型方法跑守卫，等价于线上"这条路由进来"时守卫看到的东西；而"线上那 5 条路由是否
 *   挂了元数据"已由 api-key-scope-http.e2e-spec 在真实路由上验证。两者互补，不重复。
 *
 * [铁律关联] #23(ORM/jsonb 语义须真 PG 覆盖) #17(测试契约) #18(不变量检查) #22(findOne 判空)
 *
 * [环境约定]（同 agent-deletion-impact / admin-user-delete 套件）
 *   - 本地开发库 chamber-postgres（localhost:8744）；PG 不可达整套降级跳过（打印 dbAvailable）。
 *   - RUN 后缀隔离测试数据；afterAll 按 FK 依赖逆序硬删兜底。
 *   - ⚠️ 本套件**不 import test-setup** ⇒ crypto 为真实现（哈希与真库一致），
 *     且 bcrypt 未被 mock（本套件不涉及密码）。
 * =============================================================================
 */
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { AgentStatus, ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { Agent } from '../src/database/entities/agent.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { User } from '../src/database/entities/user.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { AgentService } from '../src/modules/agent/agent.service';
import { ApiKeyScopeGuard } from '../src/common/guards/api-key-scope.guard';
import { AGENT_SCOPE_KEY } from '../src/common/decorators/agent-scope.decorator';
import { MemoryController } from '../src/modules/memory/memory.controller';
import { DiagramController } from '../src/modules/docspace/diagram.controller';
import { AttachmentController } from '../src/modules/attachments/attachment.controller';
import { TopicController } from '../src/modules/topic/topic.controller';
import { UsageEventsController } from '../src/modules/usage-stats/usage-events.controller';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀（隔离测试数据 + 清理范围） */
const RUN = `akscope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 5 个读语义豁免端点的真实 handler（元数据驱动守卫的输入） */
const EXEMPT_HANDLERS: ReadonlyArray<{
  label: string;
  method: 'POST';
  handler: (...args: never[]) => unknown;
}> = [
  {
    label: 'POST /memory/projects/:id/recalls',
    method: 'POST',
    handler: MemoryController.prototype.recall,
  },
  {
    label: 'POST /doc-spaces/:id/diagrams/validate',
    method: 'POST',
    handler: DiagramController.prototype.validateDiagram,
  },
  {
    label: 'POST /attachments/:id/signed-url',
    method: 'POST',
    handler: AttachmentController.prototype.mintSignedUrl,
  },
  { label: 'POST /topics/:id/read', method: 'POST', handler: TopicController.prototype.markAsRead },
  {
    label: 'POST /system/usage-events',
    method: 'POST',
    handler: UsageEventsController.prototype.reportUsageEvent,
  },
];

/** 构造一个最小 http ExecutionContext（守卫只消费 getType/getHandler/switchToHttp） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeHttpContext(req: Record<string, unknown>, handler: any): any {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  };
}

describe('API Key scopes + key 生命周期 — 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let apiKeyAuth: ApiKeyAuthService;
  let agentService: AgentService;
  const guard = new ApiKeyScopeGuard(new Reflector());

  /** 本运行创建的行 id（afterAll 按 FK 依赖逆序硬删） */
  const created: {
    ownerActorIds: string[];
    ownerUserIds: string[];
    agentActorIds: string[];
    agentIds: string[];
    /** revokeKey service 层写审计行（entity_type='api_key'）——afterAll 必须清掉 */
    auditedApiKeyIds: string[];
  } = {
    ownerActorIds: [],
    ownerUserIds: [],
    agentActorIds: [],
    agentIds: [],
    auditedApiKeyIds: [],
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[api-key-scopes e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;
    // 证据行：报告里必须能看到本套件真的连上了库（而不是静默跳过）
    console.log(`[api-key-scopes e2e] dbAvailable=${dbAvailable} RUN=${RUN}`);

    apiKeyAuth = new ApiKeyAuthService(ds.getRepository(ApiKey), ds.getRepository(Agent));
    agentService = new AgentService(
      ds.getRepository(Agent),
      ds.getRepository(ApiKey),
      ds.getRepository(RoundtableSeat),
      new AuditService(
        ds.getRepository(AuditLog),
        new OwnerProxyService(ds.getRepository(Agent)),
        new ActorProfileService(
          ds.getRepository(Actor),
          ds.getRepository(Agent),
          ds.getRepository(User),
        ),
      ),
      {} as never, // taskService（本套件不触达）
      {} as never, // taskDependencyService（本套件不触达）
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // ① 审计行（2026-10-16 code-review m4）：`revokeKey` 的 service 层插桩会写
    //    audit_logs（action=DELETE / entity_type='api_key'，见 agent.service.ts 的
    //    auditService.log 调用）。清理范式照 audit-instrumentation*.e2e-spec.ts：
    //    按本套件自建的 keyId 精确删除（`entity_id = ANY(...)`），不做时间窗猜测。
    if (created.auditedApiKeyIds.length > 0) {
      await ds.query(
        `DELETE FROM audit_logs WHERE entity_type = 'api_key' AND entity_id = ANY($1::uuid[])`,
        [created.auditedApiKeyIds],
      );
    }
    // ② api_keys 随 agent 级联删（FK onDelete CASCADE）→ 先 agent 后 actor
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.agentActorIds) await ds.getRepository(Actor).delete({ id });
    for (const id of created.ownerUserIds) await ds.getRepository(User).delete({ id });
    for (const id of created.ownerActorIds) await ds.getRepository(Actor).delete({ id });
    await ds.destroy();
  }, 30000);

  /** 建 owner user + agent（actor + agents 行）；返回 agent id */
  async function createAgentRow(tag: string): Promise<string> {
    const s = `${RUN}-${tag}`;
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Scope Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorIds.push(ownerActor.id);
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: `scopeowner${s}`.slice(0, 50),
        email: `scope-owner-${s}@example.com`,
        authProvider: 'local',
        // users 表 idx_unique_admin 部分唯一索引：只能 EDITOR
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.ownerUserIds.push(owner.id);
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `Scope Agent ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.agentActorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `Scope Agent ${s}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    return agent.id;
  }

  it('只读 key：真库落行 → authenticate 透传 → 守卫 GET 通 / POST 拒 1011 / 5 豁免端点通', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgentRow('ro');

    const created_ = await agentService.createKey(agentId, {
      name: 'RO Key',
      scopes: ['read'],
    });
    const rawKey = created_.apiKey;

    // ① 真库落行：permissions.scopes 就是 ['read']（不是默认双权）
    const [row] = await ds.query<Array<{ scopes: string[] }>>(
      `SELECT permissions->'scopes' AS scopes FROM api_keys WHERE id = $1`,
      [created_.id],
    );
    expect(row?.scopes).toEqual(['read']);

    // ② authenticate 真链路（真 sha256 + 真 JOIN）→ payload.permissions 透传的是同一份
    const payload = await apiKeyAuth.authenticate(rawKey);
    expect(payload.id).toBe(agentId);
    expect(payload.permissions).toEqual({ scopes: ['read'] });

    // ③ 守卫按真实 payload 判定
    expect(
      guard.canActivate(
        makeHttpContext(
          { method: 'GET', agent: payload },
          MemoryController.prototype.createProject,
        ),
      ),
    ).toBe(true);

    const denied = (() => {
      try {
        guard.canActivate(
          makeHttpContext(
            { method: 'POST', agent: payload },
            MemoryController.prototype.createProject,
          ),
        );
        return null;
      } catch (e) {
        return e as { getStatus?: () => number; getResponse?: () => Record<string, unknown> };
      }
    })();
    expect(denied?.getStatus?.()).toBe(403);
    expect(denied?.getResponse?.().code).toBe(ErrorCode.AGENT_SCOPE_INSUFFICIENT);

    // ④ 5 个豁免端点：真实 handler 元数据 → 放行
    for (const { label, method, handler } of EXEMPT_HANDLERS) {
      expect({
        label,
        allowed: guard.canActivate(makeHttpContext({ method, agent: payload }, handler)),
      }).toEqual({ label, allowed: true });
      // 反向哨兵：元数据确实挂了 `'read'`（否则上面那条可能是"碰巧放行"）
      expect(Reflect.getMetadata(AGENT_SCOPE_KEY, handler)).toBe('read');
    }
  }, 30000);

  it('双权 key（存量形态）：真库落行 + 守卫全方法通（回归防误伤）', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgentRow('full');
    const { apiKey } = await agentService.createKey(agentId, { name: 'Full Key' });
    const payload = await apiKeyAuth.authenticate(apiKey);
    expect(payload.permissions).toEqual({ scopes: ['read', 'write'] });

    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(
        guard.canActivate(
          makeHttpContext({ method, agent: payload }, MemoryController.prototype.createProject),
        ),
      ).toBe(true);
    }
  }, 30000);

  it('resetKey 交集继承（混合 scope）：read + read-write 两把 → 重置后仅 read，且旧 key 全吊销', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgentRow('reset');
    const ro = await agentService.createKey(agentId, { name: 'RO', scopes: ['read'] });
    const full = await agentService.createKey(agentId, { name: 'Full', scopes: ['read', 'write'] });

    const reset = await agentService.resetKey(agentId);

    // ① 新 key scopes = 交集（仅 read，永不升格）
    expect(reset.scopes).toEqual(['read']);
    const [newRow] = await ds.query<Array<{ scopes: string[] }>>(
      `SELECT permissions->'scopes' AS scopes FROM api_keys WHERE id = $1`,
      [reset.id],
    );
    expect(newRow?.scopes).toEqual(['read']);

    // ② 新 key 可用（真哈希）
    const payload = await apiKeyAuth.authenticate(reset.apiKey);
    expect(payload.permissions).toEqual({ scopes: ['read'] });

    // ③ 旧两把已吊销
    const [oldRows] = await ds.query<Array<{ revoked: number; total: number }>>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked, count(*) AS total
         FROM api_keys WHERE agent_id = $1`,
      [agentId],
    );
    expect(Number(oldRows?.total)).toBe(3); // 原两把 + 新一把
    expect(Number(oldRows?.revoked)).toBe(2);

    // ④ 旧 key 不可再认证（吊销即失效）
    await expect(apiKeyAuth.authenticate(ro.apiKey)).rejects.toBeTruthy();
    await expect(apiKeyAuth.authenticate(full.apiKey)).rejects.toBeTruthy();
  }, 30000);

  it('resetKey 顺序不变量（鉴别性用例）：单把双权 key → 新 key 仍是双权，而非回落只读', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgentRow('reset-full');
    // 唯一活跃 key = 双权 key。这是**唯一**能区分两种实现的用例：
    //   · 正确（UPDATE **之前**读活跃 key）→ 交集 = ['read','write']；
    //   · 错误（UPDATE 之后读 / 读不到集合）→ 空交集 → 回落 ['read']。
    // 其余用例（read+双权、无活跃 key、非法 permissions）在两种实现下期望值相同（都落 ['read']），
    // 对顺序完全不敏感——没有这条，`resetKey` 的读取顺序可以静默退化。
    await agentService.createKey(agentId, { name: 'Full Only', scopes: ['read', 'write'] });

    const reset = await agentService.resetKey(agentId);

    expect(reset.scopes).toEqual(['read', 'write']);
    // 库内行同值（不是只在内存对象上对）
    const [row] = await ds.query<Array<{ scopes: string[] }>>(
      `SELECT permissions->'scopes' AS scopes FROM api_keys WHERE id = $1`,
      [reset.id],
    );
    expect(row?.scopes).toEqual(['read', 'write']);
    // 新 key 真能用（真哈希链路）
    const payload = await apiKeyAuth.authenticate(reset.apiKey);
    expect(payload.permissions).toEqual({ scopes: ['read', 'write'] });
  }, 30000);

  it('buildKeyPermissions：显式空数组 → 400（不是"缺省双权"；缺省只认 undefined）', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgentRow('empty-scopes');
    // 服务层直调（绕过 DTO 的 @ArrayNotEmpty）——`[]` 的字面意思是"无权限"，
    // 归一成双权 = 写侧静默加宽（fail-open）；正确姿态是明确拒绝。
    const err = await agentService.createKey(agentId, { name: 'Empty', scopes: [] }).then(
      () => null,
      (e: unknown) => e as { getStatus?: () => number; getResponse?: () => { code?: number } },
    );
    expect(err?.getStatus?.()).toBe(400);
    expect(err?.getResponse?.().code).toBe(ErrorCode.VALIDATION_ERROR);

    // 反证：同一 agent 在库内没有落任何 key（失败发生在写库之前）
    const [{ count }] = await ds.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM api_keys WHERE agent_id = $1`,
      [agentId],
    );
    expect(Number(count)).toBe(0);

    // 反证：缺省（省略字段）仍是双权——收紧没有误伤向后兼容路径
    const ok = await agentService.createKey(agentId, { name: 'Default' });
    expect(ok.scopes).toEqual(['read', 'write']);
  }, 30000);

  it('BOLA：agent A 用自己凭证吊销 agent B 的 keyId → 404 且 B 的 key 未被吊销（原缺陷）', async () => {
    if (!dbAvailable) return;
    const agentA = await createAgentRow('bola-a');
    const agentB = await createAgentRow('bola-b');
    const keyOfB = await agentService.createKey(agentB, { name: 'B Key' });

    // ① 跨 agent 吊销 → NotFoundException（与"key 不存在"同形）
    const err = await agentService.revokeKey(keyOfB.id, agentA).then(
      () => null,
      (e: unknown) => e as { getStatus?: () => number; getResponse?: () => { code?: string } },
    );
    expect(err?.getStatus?.()).toBe(404);
    expect(err?.getResponse?.().code).toBe(ErrorCode.NOT_FOUND);

    // ② B 的 key 仍活跃（原缺陷下这里 revoked_at 会被置位 = 越权成功）
    const [row] = await ds.query<Array<{ revoked_at: Date | null }>>(
      `SELECT revoked_at FROM api_keys WHERE id = $1`,
      [keyOfB.id],
    );
    expect(row?.revoked_at).toBeNull();

    // ③ 归属 agent 自己吊销 → 成功（收窄没有误伤正常路径）
    await expect(agentService.revokeKey(keyOfB.id, agentB)).resolves.toBe(true);
    // 成功路径会在 service 层写审计行（m4：登记以备 afterAll 清理）
    created.auditedApiKeyIds.push(keyOfB.id);
    const [after] = await ds.query<Array<{ revoked_at: Date | null }>>(
      `SELECT revoked_at FROM api_keys WHERE id = $1`,
      [keyOfB.id],
    );
    expect(after?.revoked_at).not.toBeNull();

    // ④ 审计在**收窄查询之后**：跨 agent 那次没有留下任何审计行（不存在越权写入审计的可能）
    const [auditRows] = await ds.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE entity_type = 'api_key' AND entity_id = $1`,
      [keyOfB.id],
    );
    expect(Number(auditRows?.count)).toBe(1); // 只有 ③ 那次成功吊销
  }, 30000);

  it('响应投影白名单：真行经 findKeys 不含 keyHash / ipWhitelist（含 scopes）', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgentRow('proj');
    await agentService.createKey(agentId, { name: 'P1', scopes: ['read'] });

    const keys = await agentService.findKeys(agentId);

    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('keyHash');
    expect(keys[0]).not.toHaveProperty('ipWhitelist');
    expect(keys[0].scopes).toEqual(['read']);
    // 白名单字段表（与 agent-key-projection.ts 的契约一致）
    expect(Object.keys(keys[0]).sort()).toEqual(
      [
        'createdAt',
        'expiresAt',
        'id',
        'keyPrefix',
        'lastUsedAt',
        'name',
        'revokedAt',
        'scopes',
      ].sort(),
    );
  }, 30000);
});

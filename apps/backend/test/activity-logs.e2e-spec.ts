/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan shadowcat-sunspot-catwoman.md Phase 1（活动日志系统：三层权限）
 *   - 补充: docs/spec.md §3.1 audit_logs（actor_id 无 FK，可哨兵 UUID）
 *
 * [踩坑索引]
 *   - SCOPE-SQL: actorId=null 行被 IN/等值 SQL 天然排除——mock 测不出（铁律 #23
 *     精神），本套件直连真 PG 验证：非 admin 查不到 null 行、admin 全量可见
 *   - R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——软删 agent
 *     的 deletedAt 投影只经 ActorProfileService（收口点），本套件直接断言其输出
 *
 * [铁律关联] #17(测试契约) #23(jsonb查询集成覆盖) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * 活动日志三层权限查询 —— 真实 PG 集成套件（活动日志系统 Phase 1，2026-08-28）
 *
 * 覆盖（plan shadowcat-sunspot-catwoman.md 决策 4/7/10，铁律 #23 真 PG 断言）：
 * ① agent：只见自己；越权 actorId 收窄（scope 回声）；响应无 ipAddress/userAgent/sessionId
 * ② human 非 admin：自己 + 名下 agent（含软删 agent，actorName 保留 + actorDeletedAt 非空）
 * ③ admin：全量（含 actorId=null 系统行、他人行）；scope=null；保留网络元数据
 * ④ actorId=null 行仅 admin 可见（SCOPE-SQL：IN 天然排除 NULL，mock 测不出）
 * ⑤ 时间窗过滤（created_at 显式 UPDATE 控制）+ 越权 actorId 收窄
 * ⑥ 真孤儿 actor（无 actors 行）→ actorName 兜底 null（R12）
 *
 * 与 task-list-projection.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres
 * （localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按
 * FK 依赖逆序硬删兜底清理。
 */
import { DataSource, In } from 'typeorm';
import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { ActorType, AgentStatus, AuditAction, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AuditService } from '../src/modules/audit/audit.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { UnifiedActor } from '../src/common/types/actor.types';
import { createTestingApp } from './test-setup';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行，模块级常量会跨用例复用导致唯一冲突） */
const runSuffix = (): string => `al-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 本套件专用哨兵 entityId（隔离测试数据：本地开发库含大量历史审计行，
 * 绝对数量断言必须按 entityId 过滤本套件行；beforeAll 先清残留保证可重入）
 */
const ENTITY_IDS = {
  rowA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  rowB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  rowC: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  rowD: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  rowE: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
};
const ALL_ENTITY_IDS = Object.values(ENTITY_IDS);

describe('活动日志三层权限查询 — 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let auditService: AuditService;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: {
    auditIds: string[];
    agent1Id?: string;
    agent1ActorId?: string;
    agent2Id?: string;
    agent2ActorId?: string;
    ownerId?: string;
    ownerActorId?: string;
  } = { auditIds: [] };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      // 与生产 AppModule 同款命名策略：未显式 name 的列走 snake_case
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[activity-logs e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // 可重入：清掉上次运行可能残留的本套件行（按专用哨兵 entityId）
    await ds.getRepository(AuditLog).delete({ entityId: In(ALL_ENTITY_IDS) });

    // 与生产同构直连：AuditService 依赖 OwnerProxyService（agents 表）+
    // ActorProfileService（actors/agents/users 三 repo，投影语义唯一收口点）
    const ownerProxy = new OwnerProxyService(ds.getRepository(Agent));
    const actorProfile = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    auditService = new AuditService(ds.getRepository(AuditLog), ownerProxy, actorProfile);

    // 测试数据：owner（human 非 admin）+ 名下两 agent（agent-2 软删）+ 审计行 5 条
    const s = runSuffix();

    // owner human（actor + users 行）
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `AL Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorId = ownerActor.id;
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: `alowner${s}`.slice(0, 50),
        email: `al-owner-${s}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.ownerId = owner.id;

    // agent-1（活跃）
    created.agent1ActorId = await createAgent(s, 'al-agent-1', owner.id, 'AL Agent One', false);
    created.agent1Id = created.agent1ActorId; // agents.id == actors.id

    // agent-2（软删：actor.deletedAt 非空；agents 行保留 → getOwnedAgentIds 仍返回）
    created.agent2ActorId = await createAgent(s, 'al-agent-2', owner.id, 'AL Agent Two', true);
    created.agent2Id = created.agent2ActorId;

    // 他人 actor（纯哨兵 UUID，不建 actors 行 → 真孤儿 actorName=null，R12）
    const otherActorId = `11111111-1111-4111-8111-111111111111`;

    // 审计行：row-A agent-1 / row-B 软删 agent-2 / row-C owner / row-D 他人 / row-E null
    const rowA = await saveAuditRow({
      action: AuditAction.CREATE,
      entityType: 'message',
      entityId: ENTITY_IDS.rowA,
      actorId: created.agent1ActorId,
      newData: { messageId: 'm-1', topicId: 't-1' },
      ipAddress: '10.0.0.1',
      userAgent: 'agent-client/1.0',
      sessionId: 'sess-a',
    });
    created.auditIds.push(rowA.id);
    const rowB = await saveAuditRow({
      action: AuditAction.UPDATE,
      entityType: 'topic',
      entityId: ENTITY_IDS.rowB,
      actorId: created.agent2ActorId,
      newData: { topicId: 't-2' },
      ipAddress: '10.0.0.2',
      userAgent: 'agent-client/1.0',
      sessionId: 'sess-b',
    });
    created.auditIds.push(rowB.id);
    const rowC = await saveAuditRow({
      action: AuditAction.CREATE,
      entityType: 'task',
      entityId: ENTITY_IDS.rowC,
      actorId: owner.id,
      newData: { taskId: 'tk-1' },
      ipAddress: '10.0.0.3',
      userAgent: 'browser/1.0',
      sessionId: 'sess-c',
    });
    created.auditIds.push(rowC.id);
    const rowD = await saveAuditRow({
      action: AuditAction.UPDATE,
      entityType: 'doc',
      entityId: ENTITY_IDS.rowD,
      actorId: otherActorId,
      newData: { path: 'docs/x.md' },
      ipAddress: '10.0.0.4',
      userAgent: 'other/1.0',
      sessionId: 'sess-d',
    });
    created.auditIds.push(rowD.id);
    const rowE = await saveAuditRow({
      action: AuditAction.CREATE,
      entityType: 'doc',
      entityId: ENTITY_IDS.rowE,
      actorId: null, // 系统行（无 actor）
      newData: { path: 'docs/system.md' },
      ipAddress: '10.0.0.5',
      userAgent: 'system/1.0',
      sessionId: 'sess-e',
    });
    created.auditIds.push(rowE.id);

    // 显式时间戳：row-A/row-C 落 2026-08-27 窗口；row-B/row-D/row-E 落 2099-01-01
    // （未来时间戳——admin 全量断言用 from=2099 窗口时，窗口内只剩本套件 3 行：
    // 并行 e2e 下其他套件写 audit 行 created_at=now（2026-08-29）会挤占 20 条
    // createdAt DESC 分页窗口把 row-B/D/E 挤出，未来时间戳免疫该交错，08-29 修复）
    await ds.query(`UPDATE audit_logs SET created_at = $1 WHERE id = ANY($2)`, [
      '2026-08-27T12:00:00Z',
      [rowA.id, rowC.id],
    ]);
    await ds.query(`UPDATE audit_logs SET created_at = $1 WHERE id = ANY($2)`, [
      '2099-01-01T00:00:00Z',
      [rowB.id, rowD.id, rowE.id],
    ]);
  }, 30000);

  /** 建 agent（actor + agents 行；softDeleted=true 时给 actor 设 deletedAt） */
  async function createAgent(
    s: string,
    name: string,
    ownerId: string,
    displayName: string,
    softDeleted: boolean,
  ): Promise<string> {
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName,
        status: AgentStatus.ACTIVE,
        ...(softDeleted ? { deletedAt: new Date('2026-08-25T00:00:00Z') } : {}),
      }),
    );
    await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId,
        name,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    return actor.id;
  }

  /** 造一条审计行（必填字段全给，避免列级 NOT NULL 拦截） */
  async function saveAuditRow(data: {
    action: AuditAction;
    entityType: string;
    entityId: string;
    actorId: string | null;
    newData: Record<string, unknown> | null;
    ipAddress: string;
    userAgent: string;
    sessionId: string;
  }): Promise<AuditLog> {
    return ds.getRepository(AuditLog).save(
      ds.getRepository(AuditLog).create({
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        actorId: data.actorId,
        oldData: null,
        newData: data.newData,
        diff: null,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
        requestId: null,
        sessionId: data.sessionId,
        source: 'api',
      }),
    );
  }

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）；
    // audit_logs.actor_id 无 FK，先删审计行再删 actor 行
    for (const id of created.auditIds) await ds.getRepository(AuditLog).delete({ id });
    if (created.agent1Id) await ds.getRepository(Agent).delete({ id: created.agent1Id });
    if (created.agent2Id) await ds.getRepository(Agent).delete({ id: created.agent2Id });
    if (created.ownerId) await ds.getRepository(User).delete({ id: created.ownerId });
    if (created.agent1ActorId) await ds.getRepository(Actor).delete({ id: created.agent1ActorId });
    if (created.agent2ActorId) await ds.getRepository(Actor).delete({ id: created.agent2ActorId });
    if (created.ownerActorId) await ds.getRepository(Actor).delete({ id: created.ownerActorId });
    await ds.destroy();
  }, 30000);

  const agentActor = (id: string): UnifiedActor => ({ id, type: ActorType.AGENT, name: 'agent' });
  const humanActor = (id: string, role: UserRole): UnifiedActor => ({
    id,
    type: ActorType.HUMAN,
    name: 'human',
    role,
  });

  it('agent：只见自己；actorName 正确解析；无 ipAddress/userAgent/sessionId', async () => {
    const result = await auditService.findScoped({}, agentActor(created.agent1Id!));

    // 只有 row-A（自己）
    expect(result.items).toHaveLength(1);
    expect(result.items[0].entityType).toBe('message');
    expect(result.items[0].actorId).toBe(created.agent1Id);
    expect(result.scope).toEqual([created.agent1Id]);
    // actorName 经 ActorProfileService 解析（agents.name 一等来源）
    expect(result.items[0].actorName).toBe('al-agent-1'); // R9: agents.name 一等来源
    // 最小披露：非 admin 剔除网络/会话元数据（决策 7）
    expect(result.items[0]).not.toHaveProperty('ipAddress');
    expect(result.items[0]).not.toHaveProperty('userAgent');
    expect(result.items[0]).not.toHaveProperty('sessionId');
  });

  it('agent 越权 actorId（他人/软删 agent）→ 收窄为自身 scope，不 403', async () => {
    const result = await auditService.findScoped(
      { actorId: created.agent2Id! },
      agentActor(created.agent1Id!),
    );

    // 收窄：只见自己（row-A），scope 回声 = [自己]
    expect(result.items).toHaveLength(1);
    expect(result.items[0].entityType).toBe('message');
    expect(result.scope).toEqual([created.agent1Id]);
  });

  it('human 非 admin：自己 + 名下 agent（含软删 agent，actorDeletedAt 非空）', async () => {
    const result = await auditService.findScoped({}, humanActor(created.ownerId!, UserRole.EDITOR));

    // 3 行：row-A（名下 agent-1）+ row-B（名下软删 agent-2）+ row-C（自己）
    const entityTypes = result.items.map((i) => i.entityType).sort();
    expect(entityTypes).toEqual(['message', 'task', 'topic']);
    expect(result.scope).toEqual([created.ownerId, created.agent1Id, created.agent2Id]);
    // 软删 agent-2：name 保留（历史归因）+ deletedAt 非空
    const softDeletedRow = result.items.find((i) => i.entityType === 'topic');
    expect(softDeletedRow?.actorName).toBe('al-agent-2'); // R9: agents.name 一等来源
    expect(softDeletedRow?.actorDeletedAt).toBe('2026-08-25T00:00:00.000Z');
    // 他人行（row-D）与 null 行（row-E）不可见
    expect(result.items.find((i) => i.entityType === 'doc')).toBeUndefined();
  });

  it('admin：全量（含他人行 + actorId=null 系统行），scope=null，保留网络元数据', async () => {
    // from=2099-01-01 未来窗口：本套件 row-B/row-D/row-E 恰为该时刻（beforeAll 显式
    // UPDATE），任何其他行（含并行 e2e 套件 created_at=now 的写入）都早于它 → 窗口内
    // 仅本套件 3 行，避开 20 条 createdAt DESC 分页截断（08-29 并行交错修复）
    const result = await auditService.findScoped(
      { from: '2099-01-01T00:00:00Z' },
      humanActor('99999999-9999-4999-8999-999999999999', UserRole.ADMIN),
    );

    const entityIds = new Set(result.items.map((i) => i.entityId));
    expect(entityIds.has(ENTITY_IDS.rowB)).toBe(true);
    expect(entityIds.has(ENTITY_IDS.rowD)).toBe(true);
    expect(entityIds.has(ENTITY_IDS.rowE)).toBe(true);
    expect(result.scope).toBeNull();
    // null 行（系统行）仅 admin 可见（SCOPE-SQL：IN 天然排除 NULL）
    const nullRow = result.items.find((i) => i.entityId === ENTITY_IDS.rowE);
    expect(nullRow).toBeDefined();
    expect(nullRow?.actorName).toBeNull();
    // 真孤儿 actor（row-D 他人哨兵，无 actors 行）→ actorName 兜底 null（R12）
    const orphanRow = result.items.find((i) => i.entityId === ENTITY_IDS.rowD);
    expect(orphanRow?.actorName).toBeNull();
    // admin 视图保留 ipAddress/userAgent/sessionId（以 null 行作锚，其必有网络元数据）
    expect(nullRow).toHaveProperty('ipAddress');
    expect(nullRow).toHaveProperty('userAgent');
    expect(nullRow).toHaveProperty('sessionId');
  });

  it('admin + actorId 过滤：精确过滤任意 actor（含 null 行仍不可见——等值匹配天然排除）', async () => {
    const result = await auditService.findScoped(
      { actorId: created.agent1Id! },
      humanActor('99999999-9999-4999-8999-999999999999', UserRole.ADMIN),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].actorId).toBe(created.agent1Id);
  });

  it('时间窗过滤：from/to 闭区间（created_at 显式控制）', async () => {
    const result = await auditService.findScoped(
      {
        from: '2026-08-27T00:00:00Z',
        to: '2026-08-27T23:59:59Z',
      },
      humanActor('99999999-9999-4999-8999-999999999999', UserRole.ADMIN),
    );

    // 相对断言：08-27 窗口内的 row-A + row-C 在结果中，2099 的 row-B/row-D/row-E 不在
    const entityIds = new Set(result.items.map((i) => i.entityId));
    expect(entityIds.has(ENTITY_IDS.rowA)).toBe(true);
    expect(entityIds.has(ENTITY_IDS.rowC)).toBe(true);
    expect(entityIds.has(ENTITY_IDS.rowB)).toBe(false);
    expect(entityIds.has(ENTITY_IDS.rowD)).toBe(false);
    expect(entityIds.has(ENTITY_IDS.rowE)).toBe(false);
  });

  it('过滤组合：entityType + action 精确匹配', async () => {
    const result = await auditService.findScoped(
      { entityType: 'doc', action: AuditAction.CREATE },
      humanActor('99999999-9999-4999-8999-999999999999', UserRole.ADMIN),
    );

    // 相对断言：doc+create 的 row-E 在结果中，doc+update 的 row-D 不在
    const entityIds = new Set(result.items.map((i) => i.entityId));
    expect(entityIds.has(ENTITY_IDS.rowE)).toBe(true);
    expect(entityIds.has(ENTITY_IDS.rowD)).toBe(false);
  });
});

describe('活动日志 HTTP 路由（createTestingApp 全 mock，无需 PG）', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());
    // 路由冒烟只验证端点可达（guard 已 override 放行），审计查询返回空分页
    mockRepos.AuditLog.findAndCount.mockResolvedValue([[], 0]);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /activity-logs 与 GET /audit 均为顶层可达路由（200）', async () => {
    // @Controller() 根路径 + 方法路径精确声明（NestJS leading slash 不忽略
    // controller 前缀——RoutePathFactory.concatPaths 实证）→ 两条顶层路径
    const jwtService = app.get(JwtService);
    const token = jwtService.sign({
      sub: '00000000-0000-4000-8000-000000000005',
      email: 'test@example.com',
      role: 'admin',
    });

    await request(app.getHttpServer())
      .get('/activity-logs')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toMatchObject({
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          // createTestingApp 的 dummy guard 固定 role=observer → 非 admin 回声
          scope: ['00000000-0000-4000-8000-000000000005'],
        });
      });

    await request(app.getHttpServer())
      .get('/audit')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toMatchObject({
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          // dummy guard 固定 observer → 非 admin 回声（同一 findScoped 路径）
          scope: ['00000000-0000-4000-8000-000000000005'],
        });
      });
  });

  it('GET /audit/activity-logs（错误路径）不存在 → 404（leading slash 未生效的回归防线）', async () => {
    const jwtService = app.get(JwtService);
    const token = jwtService.sign({
      sub: '00000000-0000-4000-8000-000000000005',
      email: 'test@example.com',
      role: 'admin',
    });

    await request(app.getHttpServer())
      .get('/audit/activity-logs')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

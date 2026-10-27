/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §3. Auth（POST /auth/login、POST /auth/refresh）
 *   - 补充: docs/api-definition.md §4.3-4.6 Admin users（DELETE /admin/users/:id 的凭证连带吊销）
 *   - 代码 Hook: apps/backend/src/modules/auth/auth.service.ts（LEFTJOIN-SOFTDEL 踩坑条）
 *     + apps/backend/src/modules/user/user.service.ts（LEFTJOIN-SOFTDEL / DEL-REVOKE）
 *
 * [踩坑索引]
 *   - LEFTJOIN-SOFTDEL: 软删标记只在 actors 行上（Actor.deletedAt 是 @DeleteDateColumn），
 *     TypeORM 把软删条件注入 JOIN 的 **ON 子句**；LEFT JOIN 下 ON 不匹配不丢行（actor 列
 *     全 NULL）→ user.actor=null → User.get status() 回落 'active' → 登录判据永不触发
 *     （软删用户原密码登录 200 + 死 token + 假审计行）。**本套件直连真 PG 复现/守卫该
 *     SQL 语义**——铁律 #23：mock 单测桩掉 queryBuilder，join 方法名与 SQL 语义无关，
 *     证不了本 bug。
 *   - DEL-REVOKE: deleteByAdmin 必须事务化"先 revoke 后软删"，且吊销只打未撤销行
 *     （`IsNull()` 限定条件——历史 revoked_at 时间戳不可覆写）。
 *   - R1: 断言软删事实必须直读 actors.deleted_at（@DeleteDateColumn({select:false})
 *     该列永不进 SELECT，实体属性恒 undefined）。
 *
 * [铁律关联] #23(ORM 语义须真 PG 覆盖) #17(测试契约) #18(不变量检查) #22(findOne 判空)
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
 * 软删用户登录/刷新 fail-open 修复 —— 真实 PG 集成套件（卡 e6926d73）
 *
 * 服务层等价于 HTTP 契约（沿用 test/admin-user-delete.e2e-spec.ts 范式）：
 * `POST /auth/login` → AuthService.login、`POST /auth/refresh` → AuthService.refresh、
 * `DELETE /admin/users/:id` → UserService.deleteByAdmin、受保护端点的 JWT 门 →
 * JwtStrategy.validate（JwtAuthGuard 的底层实现）。
 *
 * 覆盖：
 * ① 软删用户原密码登录 → 401 + code TOKEN_INVALID（≠ AGENT_DISABLED，不泄露账号状态）
 *   + message 'Invalid credentials'（与"用户不存在"不可区分）；
 * ③ **主断言：不产生新 refresh_tokens 行**（修前 fail-open 必 mint 落库）+ 不写假
 *   LOGIN 审计行；
 * ④ last_login_at 未被刷新；
 * ② 软删用户持删除前签发的 refresh token → 401；且"逃过吊销"的未撤销存量 token 同样
 *   被 user 门拦下，**该失败路径不得吊销旧 token**（顺序修正：门在 revoke 之前，
 *   旧实现先 revoke 再查 user → 用户被静默登出）；
 * ⑤ deleteByAdmin 吊销未撤销 refresh token，且不覆写历史已撤销行的时间戳；
 * ⑥ deleteByAdmin 连带吊销其名下 agent 的未撤销 API Key（agent 本体保持 active）；
 * ⑦ 软删用户持旧 access token → 401（该保证挂在 actor 软删过滤的隐式回路上，防有人把
 *   join 改回 leftJoin/withDeleted 把它静默复活）；
 * ⑧ 对照：**停用**（非软删）用户仍走 AGENT_DISABLED 分支——证明 ① 的判据未被扩大化。
 *
 * 环境约定（同 task-list-projection / admin-user-delete 套件）：本地开发库
 * chamber-postgres（localhost:8744），PG 不可达整套降级跳过（`dbAvailable` 判定行打进
 * 日志，防"跳过也算绿"）；RUN 后缀隔离测试数据；afterAll 按 FK 依赖逆序硬删兜底清理。
 * ⚠️ 不 mock bcrypt/crypto：本套件不导入 test-setup.ts，故二者为真实现（login 走真
 * hash 比对，refresh 行按真 token_hash 定位）。
 */
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { ActorType, AgentStatus, ErrorCode, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { UserService } from '../src/modules/user/user.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { RefreshToken } from '../src/database/entities/refresh-token.entity';
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
const runSuffix = (): string => `sdl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 操作 admin 的 actor id（只用于 deleteByAdmin 的"自保护"比较与审计 actorId）。
 * 用哨兵 UUID 而非真建 admin：`audit_logs.actor_id` 无 FK，而真建 admin 会撞
 * `idx_unique_admin`（role='admin' 全库唯一部分索引）。afterAll 按 actor_id 兜底清审计行。
 */
const SENTINEL_ADMIN_ID = '00000000-0000-4000-8000-00000000ad12';

/** 本套件自签 JWT 的密钥（与生产无关；AuthService/JwtStrategy 共用同一 ConfigService 替身） */
const TEST_JWT_SECRET = 'e2e-soft-deleted-login-secret';
const TEST_REFRESH_SECRET = 'e2e-soft-deleted-login-refresh-secret';

/** 历史"已撤销"行的时间戳哨兵——断言 deleteByAdmin 不覆写它 */
const OLD_REVOKED_AT = new Date('2020-01-01T00:00:00.000Z');

/** 测试账号明文密码（真 bcrypt hash 入库） */
const PASSWORD = 'TestPassw0rd!';

/** AuthService/JwtStrategy 的 ConfigService 替身（只喂 jwt.* 四键） */
const configStub = {
  get: (key: string): string | undefined =>
    ({
      'jwt.secret': TEST_JWT_SECRET,
      'jwt.refreshSecret': TEST_REFRESH_SECRET,
      'jwt.expiresIn': '2h',
      'jwt.refreshExpiresIn': '7d',
    })[key],
} as unknown as ConfigService;

/** 被断言异常的最小形状（NestJS HttpException 子集，避免引入类型耦合） */
interface CapturedHttpError {
  getStatus?: () => number;
  getResponse?: () => { message?: string; code?: number };
}

describe('软删用户登录/刷新 fail-open 修复（LEFTJOIN-SOFTDEL）— 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let authService: AuthService;
  let userService: UserService;
  let jwtStrategy: JwtStrategy;
  let jwtService: JwtService;

  /** 本运行创建的用户 / agent id（afterAll 按 FK 依赖逆序硬删兜底） */
  const createdUserIds: string[] = [];
  const createdAgentIds: string[] = [];

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
      console.warn(
        `[soft-deleted-login e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;
    // 正向判定行：完工报告贴运行输出时用它证"真跑"而不是降级跳过整套（铁律 #23）
    console.log(
      `[soft-deleted-login e2e] dbAvailable=true (real PG ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database})`,
    );

    // 与生产同构直连
    const actorProfileService = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    const auditService = new AuditService(
      ds.getRepository(AuditLog),
      new OwnerProxyService(ds.getRepository(Agent)),
      actorProfileService,
    );
    userService = new UserService(ds.getRepository(User), auditService);
    jwtService = new JwtService({});
    authService = new AuthService(
      ds.getRepository(User),
      ds.getRepository(RefreshToken),
      jwtService,
      configStub,
      auditService,
    );
    jwtStrategy = new JwtStrategy(configStub, ds.getRepository(User));
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删：审计行 → api_keys → agents → users → actors
    for (const id of createdUserIds) {
      await ds.getRepository(AuditLog).delete({ entityId: id });
    }
    await ds.getRepository(AuditLog).delete({ actorId: SENTINEL_ADMIN_ID });
    for (const agentId of createdAgentIds) {
      await ds.getRepository(ApiKey).delete({ agentId });
      await ds.getRepository(Agent).delete({ id: agentId });
      await ds.getRepository(Actor).delete({ id: agentId });
    }
    for (const id of createdUserIds) {
      await ds.getRepository(RefreshToken).delete({ userId: id });
      await ds.getRepository(User).delete({ id });
      await ds.getRepository(Actor).delete({ id });
    }
    await ds.destroy();
  }, 30000);

  // ───────────────────────── 助手 ─────────────────────────

  /**
   * 建一个真实用户（真 bcrypt hash，可走真登录链路）。
   * @param status actor 初始状态（默认 active；传 DISABLED 用作对照）
   */
  async function seedUser(status: AgentStatus = AgentStatus.ACTIVE): Promise<{
    id: string;
    email: string;
  }> {
    const s = runSuffix();
    const actor = ds.getRepository(Actor).create({
      type: ActorType.HUMAN,
      displayName: `SDL ${s}`,
      status,
    });
    await ds.getRepository(Actor).save(actor);
    const user = ds.getRepository(User).create({
      id: actor.id,
      email: `sdl-${s}@example.com`,
      username: `sdl_${s}`,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: UserRole.EDITOR,
    });
    await ds.getRepository(User).save(user);
    createdUserIds.push(user.id);
    return { id: user.id, email: user.email };
  }

  /** 给用户建一个 agent（actor 行 + agents 行）与一把未吊销 API Key */
  async function seedAgentWithKey(userId: string): Promise<{ agentId: string }> {
    const s = runSuffix();
    const agentActor = ds.getRepository(Actor).create({
      type: ActorType.AGENT,
      displayName: `SDL Agent ${s}`,
      status: AgentStatus.ACTIVE,
    });
    await ds.getRepository(Actor).save(agentActor);
    const agent = ds.getRepository(Agent).create({
      id: agentActor.id,
      ownerId: userId,
      name: `SDL Agent ${s}`,
    });
    await ds.getRepository(Agent).save(agent);
    createdAgentIds.push(agent.id);
    await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: `sdl-key-hash-${s}`,
        keyPrefix: s.slice(0, 8),
        name: `SDL Key ${s}`,
      }),
    );
    return { agentId: agent.id };
  }

  /** refresh token 明文 → 落库的 token_hash（与 AuthService 同算法） */
  function tokenHashOf(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * 直接插一行"未吊销"的 refresh token（模拟逃过吊销清扫的存量 token），返回明文 token。
   *
   * payload 带随机 `jti`：JWT 的 iat 只到秒，同一秒内对同一用户签两次会得到**完全相同**
   * 的 token → 撞 refresh_tokens 的 token_hash 唯一索引（真登录路径无法改 payload，
   * 故此处必须自带熵）。
   */
  async function insertUnrevokedRefreshToken(
    userId: string,
    email: string,
  ): Promise<{ token: string; revokedAt: Date | null }> {
    const token = jwtService.sign(
      { sub: userId, email, role: UserRole.EDITOR, jti: crypto.randomUUID() },
      { secret: TEST_REFRESH_SECRET, expiresIn: '7d' },
    );
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await ds
      .getRepository(RefreshToken)
      .save(
        ds.getRepository(RefreshToken).create({ userId, tokenHash: tokenHashOf(token), expiresAt }),
      );
    const row = await readRefreshTokenRow(tokenHashOf(token));
    return { token, revokedAt: row?.revoked_at ?? null };
  }

  /** 该用户 refresh_tokens 行数（③ 主断言：不得增长） */
  async function countRefreshTokens(userId: string): Promise<number> {
    const [row] = await ds.query<Array<{ count: string }>>(
      'SELECT count(*)::text AS count FROM refresh_tokens WHERE user_id = $1',
      [userId],
    );
    return Number(row!.count);
  }

  /** 直读 refresh_tokens 行（不经实体——避免实体投影差异） */
  async function readRefreshTokenRow(
    tokenHash: string,
  ): Promise<{ id: string; revoked_at: Date | null } | undefined> {
    const rows = await ds.query<Array<{ id: string; revoked_at: Date | null }>>(
      'SELECT id, revoked_at FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    return rows[0];
  }

  /** 直读 users.last_login_at（④ 未被刷新） */
  async function readLastLoginAt(userId: string): Promise<Date | null> {
    const rows = await ds.query<Array<{ last_login_at: Date | null }>>(
      'SELECT last_login_at FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.last_login_at ?? null;
  }

  /** 断言 promise 以 401 + 给定 code 拒绝，返回响应体 */
  async function captureHttpError(p: Promise<unknown>): Promise<CapturedHttpError | null> {
    return p.then(
      () => null,
      (e: unknown) => e as CapturedHttpError,
    );
  }

  // ───────────────────────── 用例 ─────────────────────────

  it('① 软删用户原密码登录必须 401（TOKEN_INVALID，不泄露账号状态）+ ③ 不产生新 refresh_tokens 行 + ④ last_login_at 不刷新', async () => {
    if (!dbAvailable) return;
    const u = await seedUser();

    // 反证：删除前同一凭据能登录（否则"删后 401"可能只是凭据本身就坏）
    const before = await authService.login({ email: u.email, password: PASSWORD });
    expect(before.accessToken).toBeTruthy();
    const rowsBefore = await countRefreshTokens(u.id);
    expect(rowsBefore).toBe(1);
    const lastLoginBefore = await readLastLoginAt(u.id);
    expect(lastLoginBefore).not.toBeNull();

    await userService.deleteByAdmin(u.id, SENTINEL_ADMIN_ID);
    const markedAt = new Date();
    // 与上一次成功登录拉开时间，确保"若真被刷新"必然产生可观测的毫秒差
    await new Promise((r) => setTimeout(r, 30));

    const err = await captureHttpError(authService.login({ email: u.email, password: PASSWORD }));
    expect(err).not.toBeNull();
    expect(err?.getStatus?.()).toBe(401);
    const body = err?.getResponse?.() ?? {};
    // 判据不泄露账号状态：与"用户不存在"同码同文案（code 绝不回 AGENT_DISABLED）
    expect(body.code).toBe(ErrorCode.TOKEN_INVALID);
    expect(body.code).not.toBe(ErrorCode.AGENT_DISABLED);
    expect(body.message).toBe('Invalid credentials');

    // ③ 主断言：fail-open 修复前此登录会 mint 一行 refresh_tokens（200 + 死 token）
    expect(await countRefreshTokens(u.id)).toBe(rowsBefore);
    // ④ 登录副作用不得发生
    expect(await readLastLoginAt(u.id)).toEqual(lastLoginBefore);
    // 假 LOGIN 审计行也不得出现（根因三症状之一）
    const [audit] = await ds.query<Array<{ count: string }>>(
      "SELECT count(*)::text AS count FROM audit_logs WHERE action = 'login' AND entity_id = $1 AND created_at > $2",
      [u.id, markedAt],
    );
    expect(Number(audit!.count)).toBe(0);
  }, 30000);

  it('② 软删用户 refresh 必须 401；失败路径不得吊销旧 token（user 门先于 revoke）', async () => {
    if (!dbAvailable) return;
    const u = await seedUser();
    const before = await authService.login({ email: u.email, password: PASSWORD });
    const preDeleteToken = before.refreshToken;

    await userService.deleteByAdmin(u.id, SENTINEL_ADMIN_ID);
    const rowsAfterDelete = await countRefreshTokens(u.id);

    // ②-a 删除前签发、已由 deleteByAdmin 吊销的 token → 401
    const e1 = await captureHttpError(authService.refresh({ refreshToken: preDeleteToken }));
    expect(e1?.getStatus?.()).toBe(401);

    // ②-b 逃过吊销的未撤销存量 token → 必须被 user 门拦下（软删不因 token 行未撤销而放行）
    const orphan = await insertUnrevokedRefreshToken(u.id, u.email);
    const e2 = await captureHttpError(authService.refresh({ refreshToken: orphan.token }));
    expect(e2?.getStatus?.()).toBe(401);
    expect(e2?.getResponse?.().code).toBe(ErrorCode.TOKEN_INVALID);

    // 顺序修正证据：失败路径**不得**吊销旧 token。旧实现先 revoke 再查 user——
    // 用户每次拿着有效 token 重试都被烧掉一把（静默登出）。
    const orphanRow = await readRefreshTokenRow(tokenHashOf(orphan.token));
    expect(orphanRow?.revoked_at).toBeNull();

    // 两次失败都不得 mint 新行（1 行来自成功 login + 1 行手工 orphan）
    expect(await countRefreshTokens(u.id)).toBe(rowsAfterDelete + 1);
  }, 30000);

  it('⑤ deleteByAdmin 吊销未撤销 refresh token，且不覆写历史已撤销行的时间戳', async () => {
    if (!dbAvailable) return;
    const u = await seedUser();

    // 历史已撤销行（旧时间戳哨兵）：用带 jti 的自签 token 建行，避免与真登录 token 撞 hash
    const historical = await insertUnrevokedRefreshToken(u.id, u.email);
    await ds
      .getRepository(RefreshToken)
      .update({ tokenHash: tokenHashOf(historical.token) }, { revokedAt: OLD_REVOKED_AT });

    // 活跃行：走真登录链路签发（真 bcrypt + 真 generateTokens）
    const live = await authService.login({ email: u.email, password: PASSWORD });

    await userService.deleteByAdmin(u.id, SENTINEL_ADMIN_ID);

    const row1 = await readRefreshTokenRow(tokenHashOf(historical.token));
    const row2 = await readRefreshTokenRow(tokenHashOf(live.refreshToken));
    expect(row1?.revoked_at?.getTime()).toBe(OLD_REVOKED_AT.getTime()); // 历史时间戳不被覆写
    expect(row2?.revoked_at).not.toBeNull(); // 未撤销行被吊销
    expect(row2!.revoked_at!.getTime()).toBeGreaterThan(OLD_REVOKED_AT.getTime());
  }, 30000);

  it('⑥ deleteByAdmin 连带吊销其名下 agent 的 API Key；agent 本体保持 active', async () => {
    if (!dbAvailable) return;
    const u = await seedUser();
    const { agentId } = await seedAgentWithKey(u.id);

    // 反证：删除前 Key 活跃、agent 未软删
    const [keyBefore] = await ds.query<Array<{ revoked_at: Date | null }>>(
      'SELECT revoked_at FROM api_keys WHERE agent_id = $1',
      [agentId],
    );
    expect(keyBefore!.revoked_at).toBeNull();

    await userService.deleteByAdmin(u.id, SENTINEL_ADMIN_ID);

    const [keyAfter] = await ds.query<
      Array<{ revoked_at: Date | null; revoked_reason: string | null }>
    >('SELECT revoked_at, revoked_reason FROM api_keys WHERE agent_id = $1', [agentId]);
    expect(keyAfter!.revoked_at).not.toBeNull();
    expect(keyAfter!.revoked_reason).toBe('owner deleted');

    // Owner 拍板：agent 本体保持 active（孤儿 agent 的状态治理另行登记）——
    // 直读 actors.deleted_at（R1：@DeleteDateColumn({select:false}) 实体属性恒 undefined）
    const [agentActor] = await ds.query<Array<{ status: string; deleted_at: Date | null }>>(
      'SELECT status, deleted_at FROM actors WHERE id = $1',
      [agentId],
    );
    expect(agentActor!.deleted_at).toBeNull();
    expect(agentActor!.status).toBe(AgentStatus.ACTIVE);
  }, 30000);

  it('⑦ 软删用户持旧 access token 访问受保护端点 → 401（JwtStrategy 拒绝）', async () => {
    if (!dbAvailable) return;
    const u = await seedUser();
    const before = await authService.login({ email: u.email, password: PASSWORD });
    const payload = { sub: u.id, email: u.email, role: UserRole.EDITOR };

    // 反证：删除前同一 payload 通过
    await expect(jwtStrategy.validate(payload)).resolves.toMatchObject({ userId: u.id });

    await userService.deleteByAdmin(u.id, SENTINEL_ADMIN_ID);

    const err = await captureHttpError(jwtStrategy.validate(payload));
    expect(err?.getStatus?.()).toBe(401);
    expect(err?.getResponse?.().code).toBe(ErrorCode.TOKEN_INVALID);

    // 拒绝来自 DB 门而非 token 失效：JWT 本身仍可验签（该门挂在 actor 软删过滤的
    // 隐式回路上——任何人把 join 改回 leftJoin/withDeleted 都会静默复活它）
    expect(() => jwtService.verify(before.accessToken, { secret: TEST_JWT_SECRET })).not.toThrow();
  }, 30000);

  it('⑧ 对照：停用（非软删）用户仍走 AGENT_DISABLED 分支——① 的判据未被扩大化', async () => {
    if (!dbAvailable) return;
    const u = await seedUser(AgentStatus.DISABLED);
    const err = await captureHttpError(authService.login({ email: u.email, password: PASSWORD }));
    expect(err?.getStatus?.()).toBe(401);
    expect(err?.getResponse?.().code).toBe(ErrorCode.AGENT_DISABLED);
  }, 30000);
});

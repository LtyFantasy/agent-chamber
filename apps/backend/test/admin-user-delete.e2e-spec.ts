/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §4.3-4.6 Admin users
 *   - 补充: docs/architecture.md §3.2.1 (Account / Auth / Agent) + code Hooks
 *     apps/backend/src/modules/user/user.service.ts（LEFTJOIN-SOFTDEL 踩坑）
 *
 * [踩坑索引]
 *   - LEFTJOIN-SOFTDEL: 软删过滤依赖 inner join——软删条件被 ORM 塞进 JOIN 的 ON 子句，
 *     左连接下 ON 不匹配不丢行（actor 列全 NULL），`actor.deleted_at IS NULL` 被 NULL
 *     空虚满足 → findAll 把已软删用户捞回列表（生产实证）；findAllLightweight 靠并列的
 *     `actor.status = :status` 谓词侥幸兜住（NULL 被排除），语义脆弱。本套件直连真 PG
 *     复现该语义（铁律 #23：mock 单测桩掉 queryBuilder，join 方法名与 SQL 语义无关，
 *     证不了本 bug）。
 *   - R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——断言软删事实必须
 *     withDeleted + addSelect('actor.deletedAt')，或直读 actors.deleted_at。
 *
 * [铁律关联] #23(jsonb/ORM 语义须真 PG 覆盖) #17(测试契约) #8(测试绑定) #18(不变量检查)
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
 * admin 用户列表的软删过滤 —— 真实 PG 集成套件
 *
 * 覆盖（服务层等价于 HTTP 契约：`DELETE /admin/users/:id` → UserService.deleteByAdmin，
 * `GET /admin/users` → findAll，`GET /users` → findAllLightweight）：
 * ① 建号后出现在 findAll 与 findAllLightweight 两个列表（反证：不是把所有人滤掉）；
 * ② deleteByAdmin 返回 true（= DELETE 200）后，两个列表都不再包含该用户
 *   （q 精确命中 → total 0，不受库里既有数据影响）；
 * ③ 二次 deleteByAdmin 抛 NotFoundException，HTTP 语义 404 + code USER_NOT_FOUND
 *   （= 二次 DELETE 404；此前列表里看到该用户、再删却 404，正是本 bug 的表象）；
 * ④ 删除是**软删**：actors 行仍在、deleted_at 已置位——证明列表消失来自过滤而非行丢失；
 * ⑤ 根因复现：同一过滤条件改用 leftJoin 时软删行**仍被返回**（NULL 空虚满足）——这是对
 *   TypeORM「把软删条件注入 JOIN 的 ON 子句」这一行为的机器可判证据（该行为一旦变化，
 *   此断言会红，提示可重新评估 join 写法）；**它不是服务回退的守卫**（本处自建 QB，不经过
 *   UserService）——服务回退由 ① 拦截（修复前 afterList.total 为 1 而非 0）。
 *
 * 环境约定（同 task-list-projection / deleted-actor-projection 套件）：本地开发库
 * chamber-postgres（localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，
 * afterAll 按 FK 依赖逆序硬删兜底清理（含本套件写出的 audit_logs 行）。
 * ⚠️ 不 mock bcrypt：createByAdmin 走真实 hash（test-setup.ts 的 jest.mock('bcrypt')
 * 只作用于导入它的文件，本套件不导入 test-setup，故为真实现）。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { ErrorCode, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { UserService } from '../src/modules/user/user.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
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
const runSuffix = (): string => `ul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 操作 admin 的 actor id（只用于 deleteByAdmin 的"自保护"比较与审计 actorId）。
 *
 * 用哨兵 UUID 而非真建一个 admin：`audit_logs.actor_id` 无 FK（docs/spec.md §3.1），
 * 而真建 admin 会撞 `idx_unique_admin`（role='admin' 全库唯一部分索引）——开发库里
 * 已有管理员时建不出来。afterAll 按 actor_id 兜底清掉本套件写出的审计行。
 */
const SENTINEL_ADMIN_ID = '00000000-0000-4000-8000-00000000ad11';

describe('admin 用户列表软删过滤（LEFTJOIN-SOFTDEL）— 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let userService: UserService;

  /** 本运行创建的用户 id（afterAll 按 FK 依赖逆序硬删兜底） */
  const createdUserIds: string[] = [];

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
        `[admin-user-delete e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // 与生产同构直连：UserService 只依赖 (userRepo, auditService)
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
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // 审计行（本套件写出的：entity_id ∈ 建出的用户 或 actor_id = 哨兵 admin）
    for (const id of createdUserIds) {
      await ds.getRepository(AuditLog).delete({ entityId: id });
    }
    await ds.getRepository(AuditLog).delete({ actorId: SENTINEL_ADMIN_ID });
    // FK 依赖逆序：users → actors（users.id = actors.id）
    for (const id of createdUserIds) {
      await ds.getRepository(User).delete({ id });
      await ds.getRepository(Actor).delete({ id });
    }
    await ds.destroy();
  }, 30000);

  /** 经 UserService.createByAdmin 建一个 editor 用户（等价于 POST /admin/users） */
  async function createUserViaAdminService(): Promise<{ id: string; email: string }> {
    const s = runSuffix();
    const email = `ulk-${s}@example.com`;
    const profile = await userService.createByAdmin(
      { email, password: 'TestPassw0rd!', name: `UL Kid ${s}`, role: UserRole.EDITOR },
      SENTINEL_ADMIN_ID,
    );
    createdUserIds.push(profile.id);
    return { id: profile.id, email };
  }

  it('建号 → 两个列表可见；删除 → 两个列表消失；二次删除 404', async () => {
    if (!dbAvailable) return;
    const { id, email } = await createUserViaAdminService();

    // ① 反证：删之前两个列表都能看到（否则"删后消失"可能只是列表恒空）
    const beforeList = await userService.findAll({ q: email, pageSize: '100' });
    expect(beforeList.total).toBe(1);
    expect(beforeList.items.map((u) => u.id)).toEqual([id]);
    const beforeLight = await userService.findAllLightweight({ q: email, pageSize: '100' });
    expect(beforeLight.total).toBe(1);
    expect(beforeLight.items.map((u) => u.id)).toEqual([id]);

    // ② DELETE /admin/users/:id → 200（deleteByAdmin 返回 true）
    await expect(userService.deleteByAdmin(id, SENTINEL_ADMIN_ID)).resolves.toBe(true);

    // ③ 两个列表都不再包含（q 精确命中 ⇒ total 0）
    const afterList = await userService.findAll({ q: email, pageSize: '100' });
    expect(afterList.total).toBe(0);
    expect(afterList.items).toEqual([]);
    const afterLight = await userService.findAllLightweight({ q: email, pageSize: '100' });
    expect(afterLight.total).toBe(0);
    expect(afterLight.items).toEqual([]);

    // ④ 二次删除 → 404（这就是生产"点删除报 404、列表却还在"的表象）
    const err = await userService.deleteByAdmin(id, SENTINEL_ADMIN_ID).then(
      () => null,
      (e: unknown) => e as { getStatus?: () => number; getResponse?: () => { code?: string } },
    );
    expect(err).not.toBeNull();
    expect(err?.getStatus?.()).toBe(404);
    expect(err?.getResponse?.().code).toBe(ErrorCode.USER_NOT_FOUND);
  }, 30000);

  it('删除只写 actors.deleted_at（软删，行仍在）+ leftJoin 写法的根因复现', async () => {
    if (!dbAvailable) return;
    const { id } = await createUserViaAdminService();
    await userService.deleteByAdmin(id, SENTINEL_ADMIN_ID);

    // ④' 软删不删行：actors 行仍在，deleted_at 已置位（列表消失来自过滤，不是行丢失）
    const [actorRow] = await ds.query<Array<{ deleted_at: Date | null }>>(
      'SELECT deleted_at FROM actors WHERE id = $1',
      [id],
    );
    expect(actorRow).toBeDefined();
    expect(actorRow!.deleted_at).not.toBeNull();
    expect(await ds.getRepository(User).count({ where: { id } })).toBe(1);

    // ⑤ 根因复现：同一条件改用 leftJoin，软删行**仍被返回**——
    // TypeORM 把软删条件并入 LEFT JOIN 的 ON 子句，ON 不匹配不丢行（actor 列全 NULL），
    // 显式 where 对 NULL 空虚满足。这正是修复前 findAll 的 SQL 形状。
    const legacyRows = await ds
      .getRepository(User)
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.actor', 'actor')
      .where('actor.deleted_at IS NULL')
      .andWhere('user.id = :id', { id })
      .getMany();
    expect(legacyRows.map((u) => u.id)).toEqual([id]);

    // 对照：innerJoin 同条件命中 0 行（修复后的形状）
    const fixedRows = await ds
      .getRepository(User)
      .createQueryBuilder('user')
      .innerJoinAndSelect('user.actor', 'actor')
      .where('actor.deleted_at IS NULL')
      .andWhere('user.id = :id', { id })
      .getMany();
    expect(fixedRows).toEqual([]);
  }, 30000);
});

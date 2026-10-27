/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期新增的**资源访问剖面**方法的真实 PG 守卫：`resolveBoardAccess` /
 *     `resolveSpaceAccess`（`{visibility, creatorActorId, memberUserIds, readableUserIds}`）。
 *
 * [代码职责]
 *   - **等价性断言**（plan §D3 的"两族谓词漂移守卫"）：对同一批资源与候选用户，
 *     `u ∈ getAccessibleBoardIds(u) ⇔ u ∈ resolveBoardAccess(board,[u]).readableUserIds`
 *     （space 同理）——把"白名单族"与"剖面族"钉死成同一份 read 谓词。
 *   - admin 安全层放行、成员集只含真成员、`withDeleted` 变体（整空间删除场景）逐条验证。
 *
 * [权威文档]
 *   - 主文档: plan `red-tornado-wonder-woman-blue-devil.md` §D3（双层判据 / 谓词单源 / 等价性断言）
 *
 * [关键不变量]
 *   - **等价性是本套件的存在理由**：剖面族是"按资源"的形态，白名单族是"按用户"的形态——两者
 *     必须由同一份 read 规则派生。任何一侧改了规则而另一侧没跟上，本套件变红。
 *   - 剖面方法的 **role 实时读 `users` 表**（所以候选用户必须在 `users` 里有真实行）；
 *     admin 通过"安全层"，非 admin 走 open ∪ creator(含 owner-proxy) ∪ member。
 *   - **`withDeleted` 只影响空间行的读取**（`doc_deleted` / 整空间删除时空间行已软删），
 *     判据仍按删除前的可见性。
 *
 * [关联代码]
 *   - src/common/services/access-query.service.ts — 被测实现（剖面族 + 白名单族）
 *   - test/mine-query.e2e-spec.ts — 同族套件（白名单族的真实 PG 守卫）
 *
 * [持久踩坑]
 *   - 剖面族必须打真实 PG：`users` role 查询、jsonb visibility、成员表 join 都是 ORM 生成物，
 *     mock 测不出来（铁律 #23）。
 *   - 共享开发库卫生：全部数据带 RUN 后缀 / 唯一 email，afterAll 按 id 硬删。
 *
 * [铁律关联] #11(注释强制) #18(不变量检查) #23(jsonb 查询集成覆盖)
 * =============================================================================
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { ActorType, AgentStatus, UserRole, Visibility } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { User } from '../src/database/entities/user.entity';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import type { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（既有真 PG e2e 惯例；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀（隔离本套件写入的数据） */
const RUN = `ap-${Date.now().toString(36)}`;

describe('资源访问剖面（Notifications 二期）— 真实 PG 等价性与语义守卫', () => {
  let ds: DataSource;
  let service: AccessQueryService;
  let dbAvailable = false;

  /** 播种出来的 id（afterAll 硬删兜底） */
  const actorIds: string[] = [];
  const userIds: string[] = [];
  const agentIds: string[] = [];
  const boardIds: string[] = [];
  const spaceIds: string[] = [];

  /** 候选用户（真实 users 行 ⇒ 剖面方法内部的 role 查询能命中） */
  let u: UnifiedActor;
  let other: UnifiedActor;
  let admin: UnifiedActor;
  /** 属于 u 的 agent（owner-proxy 分支） */
  let ownedAgentId: string;

  // 资源 id（按语义命名，断言可读）
  let openBoardByOther: string;
  let privateBoardByU: string;
  let privateBoardMemberU: string;
  let privateBoardByOther: string;
  let privateBoardByOwnedAgent: string;
  /**
   * 边界：`settings.visibility = ''`（空串）。
   *
   * 白名单族 SQL 是 `COALESCE(settings->>'visibility','open') = 'open'` ⇒ `''` **不是** open；
   * 剖面族的 JS 判定必须逐条对齐（m10：'' 曾被当成 open，是与白名单族分叉的一处）。
   */
  let emptyVisibilityBoardByOther: string;
  let openSpaceByOther: string;
  let privateSpaceByU: string;
  let privateSpaceMemberU: string;
  let privateSpaceByOther: string;
  let softDeletedPrivateSpaceByU: string;

  jest.setTimeout(60_000);

  /** 造人类 actor + users 行（role 决定 admin 安全层是否放行） */
  async function createHuman(role: UserRole, seq: number, label: string): Promise<UnifiedActor> {
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `${RUN} ${label}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    actorIds.push(actor.id);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        username: `${RUN}${seq}`.slice(0, 50),
        email: `${RUN}-${seq}@example.com`,
        authProvider: 'local',
        role,
        preferences: {},
      }),
    );
    userIds.push(user.id);
    return { id: user.id, type: ActorType.HUMAN, role };
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
      console.warn(`[access-profile e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    const boardRepo = ds.getRepository(Board);
    const spaceRepo = ds.getRepository(DocSpace);
    const memberRepo = ds.getRepository(BoardMember);
    const spaceMemberRepo = ds.getRepository(DocSpaceMember);
    const agentRepo = ds.getRepository(Agent);

    u = await createHuman(UserRole.EDITOR, 1, 'u');
    other = await createHuman(UserRole.EDITOR, 2, 'other');
    // admin 复用**已存在**的那个（`idx_unique_admin` 全库唯一，不能再造第二个）；
    // 找不到才自己造一个（此时它是本套件的行，afterAll 可安全删除）
    const existingAdmins = (await ds.query(
      `SELECT u.id FROM users u JOIN actors a ON a.id = u.id
        WHERE u.role = 'admin' AND a.deleted_at IS NULL LIMIT 1`,
    )) as { id: string }[];
    admin =
      existingAdmins.length > 0
        ? { id: existingAdmins[0].id, type: ActorType.HUMAN, role: UserRole.ADMIN }
        : await createHuman(UserRole.ADMIN, 3, 'admin');

    // 属于 u 的 agent（owner-proxy：u 对 agent 创建的资源视同 creator）。
    // ⚠️ 用**裸 SQL** 插入而不是 `agentRepo.save(...)`：开发库的 `agents` 表与实体存在既有列漂移
    // （实测 `column Agent.rateLimit does not exist`），ORM 写路径会撞上与本套件无关的问题。
    const agentActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `${RUN} agent`,
        status: AgentStatus.ACTIVE,
      }),
    );
    actorIds.push(agentActor.id);
    await ds.query(`INSERT INTO agents (id, name, owner_id) VALUES ($1, $2, $3)`, [
      agentActor.id,
      `${RUN}-agent`,
      u.id,
    ]);
    agentIds.push(agentActor.id);
    ownedAgentId = agentActor.id;

    const mkBoard = async (label: string, creatorId: string, visibility: Visibility) => {
      const board = await boardRepo.save(
        boardRepo.create({
          name: `${RUN}-${label}`,
          topicId: null,
          creatorId,
          color: '#6366f1',
          settings: { visibility },
        }),
      );
      boardIds.push(board.id);
      return board.id as string;
    };
    openBoardByOther = await mkBoard('open-other', other.id, Visibility.OPEN);
    privateBoardByU = await mkBoard('private-u', u.id, Visibility.PRIVATE);
    privateBoardMemberU = await mkBoard('private-member-u', other.id, Visibility.PRIVATE);
    privateBoardByOther = await mkBoard('private-other', other.id, Visibility.PRIVATE);
    privateBoardByOwnedAgent = await mkBoard('private-agent', ownedAgentId, Visibility.PRIVATE);
    // 空串可见性（边界形状；`as never` 绕过 enum 类型——载荷是不可信输入，铁律 #21）
    emptyVisibilityBoardByOther = await mkBoard('empty-visibility', other.id, '' as never);
    await memberRepo.save(
      memberRepo.create({
        boardId: privateBoardMemberU,
        actorId: u.id,
        role: 'member',
        invitedBy: other.id,
      }),
    );

    const mkSpace = async (label: string, creatorId: string, visibility: Visibility) => {
      const space = await spaceRepo.save(
        spaceRepo.create({
          name: `${RUN}-${label}`,
          slug: `${RUN}-${label}-${randomUUID().slice(0, 8)}`.slice(0, 128),
          creatorId,
          description: null,
          settings: { visibility },
        }),
      );
      spaceIds.push(space.id);
      return space.id as string;
    };
    openSpaceByOther = await mkSpace('open-other', other.id, Visibility.OPEN);
    privateSpaceByU = await mkSpace('private-u', u.id, Visibility.PRIVATE);
    privateSpaceMemberU = await mkSpace('private-member-u', other.id, Visibility.PRIVATE);
    privateSpaceByOther = await mkSpace('private-other', other.id, Visibility.PRIVATE);
    softDeletedPrivateSpaceByU = await mkSpace('soft-deleted-u', u.id, Visibility.PRIVATE);
    await spaceMemberRepo.save(
      spaceMemberRepo.create({
        spaceId: privateSpaceMemberU,
        actorId: u.id,
        role: 'member',
        invitedBy: other.id,
      }),
    );
    // 软删（整空间删除场景：行还在，但正常读路径看不见）
    await spaceRepo.softDelete(softDeletedPrivateSpaceByU);

    service = new AccessQueryService(
      ds.getRepository(Topic),
      boardRepo,
      spaceRepo,
      ds.getRepository(TopicParticipant),
      memberRepo,
      spaceMemberRepo,
      new AsyncLocalStorage<Map<string, Promise<string[] | null>>>(),
      new OwnerProxyService(agentRepo),
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // 硬删兜底（顺序：成员 → 资源 → agent → user → actor）
    await ds.query(`DELETE FROM board_members WHERE board_id = ANY($1)`, [boardIds]);
    await ds.query(`DELETE FROM doc_space_members WHERE space_id = ANY($1)`, [spaceIds]);
    await ds.query(`DELETE FROM boards WHERE id = ANY($1)`, [boardIds]);
    await ds.query(`DELETE FROM doc_spaces WHERE id = ANY($1)`, [spaceIds]);
    if (agentIds.length > 0) await ds.query(`DELETE FROM agents WHERE id = ANY($1)`, [agentIds]);
    if (userIds.length > 0) await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    if (actorIds.length > 0) await ds.query(`DELETE FROM actors WHERE id = ANY($1)`, [actorIds]);
    await ds.destroy();
  });

  // ══════════════════════════════════════════════════════════════════
  // ① 等价性断言：白名单族 ⇔ 剖面族（board）
  // ══════════════════════════════════════════════════════════════════

  it('① board 等价性：u ∈ getAccessibleBoardIds(u) ⇔ u ∈ resolveBoardAccess(board,[u]).readableUserIds', async () => {
    if (!dbAvailable) return;

    const allBoards = [
      openBoardByOther,
      privateBoardByU,
      privateBoardMemberU,
      privateBoardByOther,
      privateBoardByOwnedAgent,
      emptyVisibilityBoardByOther,
    ];
    const candidates = [u, other, admin];

    for (const candidate of candidates) {
      const accessible = await service.getAccessibleBoardIds(candidate);
      for (const boardId of allBoards) {
        const profile = await service.resolveBoardAccess(boardId, [candidate.id]);
        expect(profile).not.toBeNull();
        const inWhitelist = accessible === null ? true : accessible.includes(boardId);
        expect({
          board: boardId,
          user: candidate.id,
          inWhitelist,
        }).toEqual({
          board: boardId,
          user: candidate.id,
          inWhitelist: profile!.readableUserIds.has(candidate.id),
        });
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ② 语义明细（不是"等价就行"——把每条分支的真实期望写死）
  // ══════════════════════════════════════════════════════════════════

  it('② 语义：open 全员可读 / private 仅 creator(含 owner-proxy)+member / admin 安全层放行', async () => {
    if (!dbAvailable) return;

    const read = async (boardId: string, actorId: string) =>
      (await service.resolveBoardAccess(boardId, [actorId]))!.readableUserIds.has(actorId);

    // open：全员
    expect(await read(openBoardByOther, u.id)).toBe(true);
    expect(await read(openBoardByOther, other.id)).toBe(true);
    expect(await read(openBoardByOther, admin.id)).toBe(true);

    // private / creator = u / member = u / 无关者 other
    expect(await read(privateBoardByU, u.id)).toBe(true);
    expect(await read(privateBoardByU, other.id)).toBe(false);
    expect(await read(privateBoardMemberU, u.id)).toBe(true);
    expect(await read(privateBoardByOther, u.id)).toBe(false);
    expect(await read(privateBoardByOther, other.id)).toBe(true);

    // owner-proxy：agent 建的 private board，其人类 owner u 可读；他人不可读
    expect(await read(privateBoardByOwnedAgent, u.id)).toBe(true);
    expect(await read(privateBoardByOwnedAgent, other.id)).toBe(false);

    // admin 安全层放行（即使与资源毫无关系）
    expect(await read(privateBoardByOther, admin.id)).toBe(true);
    expect(await service.getAccessibleBoardIds(admin)).toBeNull();
  });

  it('② memberUserIds 只含该资源的成员（不是"能读的人"）', async () => {
    if (!dbAvailable) return;

    const profile = await service.resolveBoardAccess(privateBoardMemberU, [
      u.id,
      other.id,
      admin.id,
    ]);
    expect(profile).not.toBeNull();
    // u 是成员；other 是 creator（能读但不是成员）；admin 能读但不是成员
    expect([...profile!.memberUserIds]).toEqual([u.id]);
    expect(profile!.readableUserIds.has(other.id)).toBe(true);
    expect(profile!.memberUserIds.has(other.id)).toBe(false);
    expect(profile!.creatorActorId).toBe(other.id);
    expect(profile!.visibility).toBe(Visibility.PRIVATE);
  });

  // ══════════════════════════════════════════════════════════════════
  // ③ space 等价性 + withDeleted 变体
  // ══════════════════════════════════════════════════════════════════

  it('③ space 等价性：u ∈ getAccessibleDocSpaceIds(u) ⇔ u ∈ resolveSpaceAccess(space,[u]).readableUserIds', async () => {
    if (!dbAvailable) return;

    const allSpaces = [openSpaceByOther, privateSpaceByU, privateSpaceMemberU, privateSpaceByOther];
    const candidates = [u, other, admin];

    for (const candidate of candidates) {
      const accessible = await service.getAccessibleDocSpaceIds(candidate);
      for (const spaceId of allSpaces) {
        const profile = await service.resolveSpaceAccess(spaceId, [candidate.id]);
        expect(profile).not.toBeNull();
        const inWhitelist = accessible === null ? true : accessible.includes(spaceId);
        expect({ space: spaceId, user: candidate.id, inWhitelist }).toEqual({
          space: spaceId,
          user: candidate.id,
          inWhitelist: profile!.readableUserIds.has(candidate.id),
        });
      }
    }
  });

  it('③ withDeleted 变体：软删空间默认读不到（null），withDeleted=true 时按删除前可见性判定', async () => {
    if (!dbAvailable) return;

    // 默认（不带 withDeleted）：空间行已软删 ⇒ 剖面为 null（资源不存在）
    expect(await service.resolveSpaceAccess(softDeletedPrivateSpaceByU, [u.id])).toBeNull();

    // withDeleted=true：creator u 仍可读（判据 = 删除前的可见性 + creator 源）
    const profile = await service.resolveSpaceAccess(softDeletedPrivateSpaceByU, [u.id], {
      withDeleted: true,
    });
    expect(profile).not.toBeNull();
    expect(profile!.readableUserIds.has(u.id)).toBe(true);
    expect(profile!.visibility).toBe(Visibility.PRIVATE);

    // 无关者即使 withDeleted 也读不到
    const otherView = await service.resolveSpaceAccess(softDeletedPrivateSpaceByU, [other.id], {
      withDeleted: true,
    });
    expect(otherView!.readableUserIds.has(other.id)).toBe(false);
  });

  it("m10 边界：`visibility=''`（空串）**不是 open**——与白名单族 SQL 逐条对齐", async () => {
    if (!dbAvailable) return;

    // 剖面族：creator 可读、无关者不可读（空串 ≠ 'open'）
    const profile = await service.resolveBoardAccess(emptyVisibilityBoardByOther, [other.id, u.id]);
    expect(profile).not.toBeNull();
    expect(profile!.readableUserIds.has(other.id)).toBe(true); // creator
    expect(profile!.readableUserIds.has(u.id)).toBe(false); // 无关者：空串不算 open

    // 白名单族（SQL COALESCE 口径）：同一批用户的可读集合与剖面族一致
    const accessible = await service.getAccessibleBoardIds({
      id: u.id,
      type: ActorType.HUMAN,
      role: UserRole.EDITOR,
    });
    expect(accessible === null ? true : accessible.includes(emptyVisibilityBoardByOther)).toBe(
      profile!.readableUserIds.has(u.id),
    );
  });

  it('③ 资源不存在 ⇒ null（铁律 #22 判空）', async () => {
    if (!dbAvailable) return;

    expect(await service.resolveBoardAccess(randomUUID(), [u.id])).toBeNull();
    expect(await service.resolveSpaceAccess(randomUUID(), [u.id])).toBeNull();
  });

  it('③ 空候选集 / 无 row 的候选 id 不炸（不查 users 也不进任何集合）', async () => {
    if (!dbAvailable) return;

    const empty = await service.resolveBoardAccess(privateBoardByU, []);
    expect([...empty!.readableUserIds]).toEqual([]);

    const ghost = await service.resolveBoardAccess(privateBoardByU, [randomUUID()]);
    expect([...ghost!.readableUserIds]).toEqual([]);
  });
});

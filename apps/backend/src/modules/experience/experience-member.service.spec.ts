import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';
import { ExperienceMemberService } from './experience-member.service';
import { ExperienceSpaceMember } from '../../database/entities/experience-space-member.entity';
import type { ExperienceEntry } from '../../database/entities/experience-entry.entity';
import type { UnifiedActor } from '../../common/types/actor.types';

/**
 * ExperienceMemberService 单测（第二期批 2，plan §8 后端单测清单）。
 *
 * 覆盖两块**高风险面**：
 * ① **终审资格判定**（v1.81.0 起 = **纯角色判定**：admin ∪ 空间 owner/reviewer）。
 *    禁自审四态已于 2026-09-24 退役——"自己就是作者"不再是拒绝理由，故此处必须有用例
 *    钉住**本人所录条目也可审**（否则旧约束会静默回流：线上表现为队列空转，无任何报错）；
 * ② **成员管理三端点闸门**（admin 全权 / owner 双约束 / 其余拒绝 + denied 审计）。
 *
 * 为什么这些必须是单测而不是只靠 e2e：判定分支（无身份 / admin / owner / reviewer /
 * 非成员）在真库上要造多套身份与条目；单测用 mock 逐态钉死**判定走向与查询短路**，
 * e2e 再补"真 PG 上确实这么判"的端到端证据（两条腿缺一不可）。
 *
 * 分工：本文件只测**本服务**；ExperienceService 的委派与响应投影在
 * experience.service.spec.ts 里测（那边用 mock 断言委派，不复制判定）。
 */
const ACTOR_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const CREATOR_UUID = '33333333-3333-4333-8333-333333333333';
const OWNER_UUID = '44444444-4444-4444-8444-444444444444';

describe('ExperienceMemberService', () => {
  let service: ExperienceMemberService;
  let memberRepo: {
    findOne: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    getMany: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let actorProfile: { resolveProfiles: jest.Mock; assertActorUsable: jest.Mock };

  /**
   * **表状态**（内存行表，唯一事实源）。
   *
   * 为什么需要两张：并发护栏测的是"**读到的**与**写时库里的**不一致"这一个瞬间
   * （stale read），固定返回值的 mock 表达不了。故：
   * - `rows` = 库的真实状态（条件写的 `affected` 由它算）
   * - `findOne` 默认按 `where.actorId` 查它；要伪造**陈旧读**（并发护栏用例）用
   *   `mockImplementationOnce` 只覆盖第一次调用
   *
   * ⚠️ `findOne` 对 `where` 的其它键（role）**故意不参与过滤**：生产 SQL 里
   * `findOne({where:{actorId}})` 只按 PK 查（role 从不进 where），这里保持同形。
   */
  let rows: Map<
    string,
    { actorId: string; role: string; invitedBy: string | null; createdAt: Date }
  >;
  /** 默认档案解析结果（空 Map = 真孤儿，投影走兜底） */
  let profiles: Map<string, unknown>;

  const admin: UnifiedActor = {
    id: ACTOR_UUID,
    type: ActorType.HUMAN,
    name: 'admin',
    role: UserRole.ADMIN,
  } as UnifiedActor;
  const humanMember: UnifiedActor = {
    id: ACTOR_UUID,
    type: ActorType.HUMAN,
    name: 'h',
  } as UnifiedActor;
  const agentActor: UnifiedActor = {
    id: OTHER_UUID,
    type: ActorType.AGENT,
    name: 'reviewer-agent',
    ownerId: OWNER_UUID,
  } as UnifiedActor;
  const reviewerAgent: UnifiedActor = {
    id: OTHER_UUID,
    type: ActorType.AGENT,
    name: 'sibling-agent',
    ownerId: OWNER_UUID,
  } as UnifiedActor;

  /** PG 23505 形态的错误对象（并发撞 PK） */
  const uniqueViolation = (): Error & { code: string } =>
    Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

  beforeEach(() => {
    rows = new Map();
    setMemberRow(OTHER_UUID, 'reviewer');
    profiles = new Map([
      [
        OTHER_UUID,
        { type: ActorType.AGENT, name: 'A', avatarUrl: null, description: null, deletedAt: null },
      ],
    ]);

    memberRepo = {
      findOne: jest.fn(
        async ({ where }: { where: { actorId: string } }) => rows.get(where.actorId) ?? null,
      ),
      // 显式 INSERT：撞已存在的 PK → 23505（生产由 PG 抛，这里如实模拟）。
      // 成功后落表：随后的"回读落库行"能拿到真实行（生产就是再查一次）
      insert: jest.fn(async (row: { actorId: string; role: string; invitedBy: string | null }) => {
        if (rows.has(row.actorId)) throw uniqueViolation();
        const stored = { ...row, createdAt: new Date() };
        rows.set(row.actorId, stored);
        return { identifiers: [{ actorId: row.actorId }] };
      }),
      // 条件 UPDATE：where.role 给出时必须匹配（护栏的核心语义），否则 affected=0
      update: jest.fn(
        async (
          criteria: { actorId: string; role?: string },
          partial: { role?: string },
        ): Promise<{ affected: number }> => {
          const row = rows.get(criteria.actorId);
          if (!row) return { affected: 0 };
          if (criteria.role !== undefined && row.role !== criteria.role) return { affected: 0 };
          const next = { ...row, ...partial };
          rows.set(criteria.actorId, next);
          return { affected: 1 };
        },
      ),
      // 条件 DELETE：同 UPDATE 的 role 语义
      delete: jest.fn(
        async (criteria: { actorId: string; role?: string }): Promise<{ affected: number }> => {
          const row = rows.get(criteria.actorId);
          if (!row) return { affected: 0 };
          if (criteria.role !== undefined && row.role !== criteria.role) return { affected: 0 };
          rows.delete(criteria.actorId);
          return { affected: 1 };
        },
      ),
      createQueryBuilder: jest.fn(() => ({
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: memberRepo.getMany,
      })),
      getMany: jest.fn(async () => [...rows.values()]),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    actorProfile = {
      resolveProfiles: jest.fn(async () => profiles),
      assertActorUsable: jest.fn().mockResolvedValue(undefined),
    };

    // 构造参数与生产 DI 同形（v1.81.0：四态退役后 ownerProxy 已从本服务移除）
    service = new ExperienceMemberService(
      memberRepo as never,
      auditService as never,
      actorProfile as never,
    );
  });

  /** 铺一行成员（表状态；`findOne`/条件写的 affected 都读它） */
  function setMemberRow(
    actorId: string,
    role: 'owner' | 'reviewer',
    invitedBy: string | null = null,
  ): void {
    rows.set(actorId, { actorId, role, invitedBy, createdAt: new Date() });
  }

  /** 清空成员表（"还不是成员"场景） */
  function clearMembers(): void {
    rows.clear();
  }

  afterEach(() => jest.clearAllMocks());

  /** 造条目（只需判权用到的四列） */
  const entry = (overrides: Partial<ExperienceEntry> = {}): ExperienceEntry =>
    ({
      id: ACTOR_UUID,
      createdById: CREATOR_UUID,
      createdByType: ActorType.AGENT,
      quality: 'unverified',
      ...overrides,
    }) as ExperienceEntry;

  /** 取抛出的 HTTP 异常（未抛 → undefined） */
  const capture = async (fn: () => Promise<unknown>): Promise<unknown> =>
    fn().then(
      () => undefined,
      (err: unknown) => err,
    );

  // ══════════════════════════════════════════════════════════════════
  // 角色解析
  // ══════════════════════════════════════════════════════════════════

  describe('resolveMemberRole（禁缓存 + 空值不查库）', () => {
    it('成员行存在 → 返回其角色', async () => {
      expect(await service.resolveMemberRole(OTHER_UUID)).toBe('reviewer');
      expect(memberRepo.findOne).toHaveBeenCalledWith({ where: { actorId: OTHER_UUID } });
    });

    it('非成员 → null（不抛错：调用方据此判"无资格"）', async () => {
      clearMembers();
      expect(await service.resolveMemberRole(OTHER_UUID)).toBeNull();
    });

    it('空 id（null/undefined/空串）→ null 且**零查库**（findOne({id:undefined}) 同族坑）', async () => {
      expect(await service.resolveMemberRole(null)).toBeNull();
      expect(await service.resolveMemberRole(undefined)).toBeNull();
      expect(await service.resolveMemberRole('')).toBeNull();
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 终审资格判定（v1.81.0：纯角色判定；禁自审四态已退役）
  // ══════════════════════════════════════════════════════════════════

  describe('evaluateReviewPermission — 角色判定', () => {
    it('人类 admin → 可审（且不查成员表：admin 短路）', async () => {
      const state = await service.evaluateReviewPermission(entry(), admin);
      expect(state).toEqual({ canReview: true });
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('空间 reviewer → 可审（PK 单查命中）', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', null);
      const state = await service.evaluateReviewPermission(entry(), agentActor);
      expect(state).toEqual({ canReview: true });
    });

    it('空间 owner（人类）→ 可审', async () => {
      setMemberRow(ACTOR_UUID, 'owner', null);
      const state = await service.evaluateReviewPermission(entry(), humanMember);
      expect(state).toEqual({ canReview: true });
    });

    it('非成员（无角色）→ 不可审', async () => {
      clearMembers();
      const state = await service.evaluateReviewPermission(entry(), agentActor);
      expect(state).toEqual({ canReview: false });
    });

    it('无身份 → 不可审且**零查库**（首行短路）', async () => {
      expect(await service.evaluateReviewPermission(entry(), null)).toEqual({ canReview: false });
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('**本人所录也可审**（四态退役的核心断言：admin 与空间 reviewer 各一）', async () => {
      const own = entry({ createdById: ACTOR_UUID });
      // 旧实现：admin 审自己录的条目 = 态 1 'self' → 403/13002；现在必须放行
      expect(await service.evaluateReviewPermission(own, admin)).toEqual({ canReview: true });

      // 旧实现：空间 reviewer 审自己录的条目 = 态 1 'self'；现在必须放行
      setMemberRow(OTHER_UUID, 'reviewer', null);
      expect(await service.evaluateReviewPermission(own, agentActor)).toEqual({ canReview: true });
    });

    it('**同 owner 兄弟 agent 也可审**（旧态 4 的对应位；亲缘关系不再参与判定）', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', null);
      // reviewer（agentActor，ownerId=OWNER_UUID）与 creator 同 owner：旧实现 = 态 4 → 13002
      const sibling = entry({ createdById: CREATOR_UUID, createdByType: ActorType.AGENT });
      expect(await service.evaluateReviewPermission(sibling, agentActor)).toEqual({
        canReview: true,
      });
    });

    it('判定与"是哪一条"无关：同一调用者在任意条目上取值相同（纯角色判定的契约）', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', null);
      const mine = entry({ createdById: OTHER_UUID, createdByType: ActorType.AGENT });
      const others = entry({ createdById: CREATOR_UUID, createdByType: ActorType.HUMAN });
      expect(await service.evaluateReviewPermission(mine, agentActor)).toEqual(
        await service.evaluateReviewPermission(others, agentActor),
      );
    });
  });

  describe('assertCanReview — 抛出式（终审写路径）', () => {
    it('无身份 → 403/13004 且**成员仓储零调用**（首行守卫）', async () => {
      const err = (await capture(() =>
        service.assertCanReview(entry(), null),
      )) as ForbiddenException;
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('无终审角色 → 403/13004 + denied 审计（越权尝试留痕）', async () => {
      clearMembers();
      const err = (await capture(() =>
        service.assertCanReview(entry(), agentActor),
      )) as ForbiddenException;
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect((err.getResponse() as { message: string }).message).toContain(
        'GET /experiences/members',
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: agentActor.id,
          newData: expect.objectContaining({ denied: true, reason: 'no_review_role' }),
        }),
      );
    });

    it('**本人所录条目放行**（v1.81.0 四态退役：不再有 13002，且零审计）', async () => {
      // 空间 owner 审自己录的条目：旧实现 = 态 1 → 403/13002；现在必须静默放行
      setMemberRow(ACTOR_UUID, 'owner', null);
      await service.assertCanReview(entry({ createdById: ACTOR_UUID }), humanMember);
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('与作者同 owner 的 reviewer 也放行（旧态 4 的对应位）', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', null);
      await service.assertCanReview(
        entry({ createdById: CREATOR_UUID, createdByType: ActorType.AGENT }),
        agentActor,
      );
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('有资格 → 放行且**零审计**（成功路径不该在审计表留噪声）', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', null);
      await service.assertCanReview(entry(), agentActor);
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('assertReviewIdentity 单用：无身份 → 403/13004', () => {
      expect(() => service.assertReviewIdentity(null)).toThrow(ForbiddenException);
      expect(() => service.assertReviewIdentity(admin)).not.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 成员列表
  // ══════════════════════════════════════════════════════════════════

  describe('listMembers', () => {
    it('任何认证身份可读；invitedBy 对 reviewer（非 owner/admin）置 null', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', ACTOR_UUID);
      // 调用者 = 另一个 reviewer（查自己的行 → 角色 reviewer）
      memberRepo.findOne = jest.fn(async ({ where }: { where: { actorId: string } }) =>
        where.actorId === ACTOR_UUID
          ? { actorId: ACTOR_UUID, role: 'reviewer', invitedBy: null, createdAt: new Date() }
          : null,
      );
      memberRepo.getMany = jest.fn(async () => [...rows.values()]);
      const res = await service.listMembers(humanMember);
      expect(res.items[0]).toMatchObject({
        actorId: OTHER_UUID,
        role: 'reviewer',
        invitedBy: null,
      });
    });

    it('owner 调用 → invitedBy 透出（授权留痕可见）', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', ACTOR_UUID);
      memberRepo.findOne = jest.fn(async () => ({
        actorId: ACTOR_UUID,
        role: 'owner',
        invitedBy: null,
        createdAt: new Date(),
      }));
      memberRepo.getMany = jest.fn(async () => [...rows.values()]);
      const res = await service.listMembers(humanMember);
      expect(res.items[0].invitedBy).toBe(ACTOR_UUID);
    });

    it('admin 调用 → invitedBy 透出且不查成员表（短路）', async () => {
      setMemberRow(OTHER_UUID, 'reviewer', ACTOR_UUID);
      memberRepo.getMany = jest.fn(async () => [...rows.values()]);
      const res = await service.listMembers(admin);
      expect(res.items[0].invitedBy).toBe(ACTOR_UUID);
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('档案投影：actorName/actorType/avatarUrl/deletedAt 来自 ActorProfileService（成员行不存名）', async () => {
      const softDeleted = new Date('2026-01-01T00:00:00.000Z');
      profiles = new Map([
        [
          OTHER_UUID,
          {
            type: ActorType.HUMAN,
            name: 'Renamed',
            avatarUrl: 'http://a',
            description: null,
            deletedAt: softDeleted,
          },
        ],
      ]);
      memberRepo.getMany = jest.fn(async () => [...rows.values()]);
      const res = await service.listMembers(admin);
      expect(res.items[0]).toMatchObject({
        actorName: 'Renamed',
        actorType: 'human',
        avatarUrl: 'http://a',
        deletedAt: softDeleted.toISOString(),
      });
      expect(actorProfile.resolveProfiles).toHaveBeenCalledWith([OTHER_UUID]);
    });

    it('真孤儿（档案解析无该行）→ 名与类型缺省而非报错（历史归因保留）', async () => {
      profiles = new Map();
      memberRepo.getMany = jest.fn(async () => [...rows.values()]);
      const res = await service.listMembers(admin);
      expect(res.items[0]).toMatchObject({ actorId: OTHER_UUID, actorName: null });
      expect(res.items[0].actorType).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 授权（POST）
  // ══════════════════════════════════════════════════════════════════

  describe('addMember', () => {
    beforeEach(() => {
      clearMembers(); // 默认"还不是成员"
    });

    it('admin 授 reviewer → 写入 + CREATE 审计（谁给谁什么角色；created=true → 201）', async () => {
      const dto = { actorId: CREATOR_UUID, role: 'reviewer' as const };
      const res = await service.addMember(dto, admin);
      expect(res.created).toBe(true);
      expect(res.member).toMatchObject({
        actorId: CREATOR_UUID,
        role: 'reviewer',
        invitedBy: ACTOR_UUID,
      });
      expect(memberRepo.insert).toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create',
          entityType: 'experience_space_member',
          entityId: CREATOR_UUID,
          newData: expect.objectContaining({ role: 'reviewer', targetActorId: CREATOR_UUID }),
        }),
      );
    });

    it('admin 授 owner → 允许（owner 任免是 admin 专属）', async () => {
      const res = await service.addMember({ actorId: CREATOR_UUID, role: 'owner' }, admin);
      expect(res.member.role).toBe('owner');
      expect(res.created).toBe(true);
    });

    it('owner 授 reviewer → 允许', async () => {
      // 调用者自己 = owner 行（闸门用）；目标 CREATOR_UUID 尚未入表
      setMemberRow(ACTOR_UUID, 'owner');
      const res = await service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, humanMember);
      expect(res.member.role).toBe('reviewer');
      expect(res.created).toBe(true);
    });

    it('owner 授 owner → 403/13004 + denied 审计 + **零写入**（否则 owner 自造同级）', async () => {
      memberRepo.findOne = jest.fn(async ({ where }: { where: { actorId: string } }) =>
        where.actorId === ACTOR_UUID
          ? { actorId: ACTOR_UUID, role: 'owner', invitedBy: null, createdAt: new Date() }
          : null,
      );
      const err = (await capture(() =>
        service.addMember({ actorId: CREATOR_UUID, role: 'owner' }, humanMember),
      )) as ForbiddenException;
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          newData: expect.objectContaining({
            denied: true,
            reason: 'owner_may_only_grant_reviewer',
          }),
        }),
      );
      expect(memberRepo.insert).not.toHaveBeenCalled();
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('reviewer 成员调 POST → 403/13004（reviewer 无成员管理权）', async () => {
      memberRepo.findOne = jest.fn(async () => ({
        actorId: ACTOR_UUID,
        role: 'reviewer',
        invitedBy: null,
        createdAt: new Date(),
      }));
      const err = (await capture(() =>
        service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, humanMember),
      )) as ForbiddenException;
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          newData: expect.objectContaining({ reason: 'reviewer_cannot_manage_members' }),
        }),
      );
    });

    it('闸门在存在性之前：无管理权者拿不到 404/403 的差异（零 actor 查询）', async () => {
      clearMembers();
      await capture(() =>
        service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, agentActor),
      );
      expect(actorProfile.assertActorUsable).not.toHaveBeenCalled();
    });

    it('目标 actor 不存在/已软删 → 404/AGENT_NOT_FOUND（assertActorUsable 原样透出）', async () => {
      actorProfile.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );
      const err = (await capture(() =>
        service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, admin),
      )) as NotFoundException;
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err.getResponse() as { code: number }).code).toBe(ErrorCode.AGENT_NOT_FOUND);
      expect(memberRepo.insert).not.toHaveBeenCalled();
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('已是成员且**同角色** → 幂等（created=false → HTTP 200；零写入、零审计）', async () => {
      setMemberRow(CREATOR_UUID, 'reviewer', null);
      const res = await service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, admin);
      expect(res.created).toBe(false);
      expect(res.member).toMatchObject({ actorId: CREATOR_UUID, role: 'reviewer' });
      expect(memberRepo.insert).not.toHaveBeenCalled();
      expect(memberRepo.update).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('已是成员但**异角色** → 409/13005（指引走 PATCH，禁删了重加）', async () => {
      setMemberRow(CREATOR_UUID, 'owner', null);
      const err = (await capture(() =>
        service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, admin),
      )) as ConflictException;
      expect(err).toBeInstanceOf(ConflictException);
      const payload = err.getResponse() as { code: number; message: string };
      expect(payload.code).toBe(ErrorCode.EXPERIENCE_MEMBER_EXISTS);
      expect(payload.message).toContain('PATCH /experiences/members/:actorId');
      expect(memberRepo.insert).not.toHaveBeenCalled();
      expect(memberRepo.update).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 改角色（PATCH）
  // ══════════════════════════════════════════════════════════════════

  describe('updateMemberRole', () => {
    it('admin 改 reviewer → owner（任免 owner 是 admin 专属）', async () => {
      setMemberRow(CREATOR_UUID, 'reviewer', null);
      const res = await service.updateMemberRole(CREATOR_UUID, { role: 'owner' }, admin);
      expect(res.role).toBe('owner');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          oldData: { role: 'reviewer' },
          newData: expect.objectContaining({ role: 'owner' }),
        }),
      );
    });

    it('owner 改 reviewer → reviewer（双约束满足）→ 幂等 no-op 200（零写入，仅一次护栏探针）', async () => {
      setMemberRow(ACTOR_UUID, 'owner'); // 调用者
      setMemberRow(CREATOR_UUID, 'reviewer'); // 目标行
      const res = await service.updateMemberRole(CREATOR_UUID, { role: 'reviewer' }, humanMember);
      expect(res.role).toBe('reviewer');
      expect(memberRepo.insert).not.toHaveBeenCalled();
      // 条件 no-op UPDATE 探针：确认"该行此刻仍是 reviewer"（并发护栏），非真实改角色
      expect(memberRepo.update).toHaveBeenCalledTimes(1);
      expect(memberRepo.update).toHaveBeenCalledWith(
        { actorId: CREATOR_UUID, role: 'reviewer' },
        { role: 'reviewer' },
      );
      expect(rows.get(CREATOR_UUID)?.role).toBe('reviewer');
    });

    it('owner 把 reviewer 提成 owner → 403/13004 + 角色**未被改动**（security 复核 N1）', async () => {
      const target = {
        actorId: CREATOR_UUID,
        role: 'reviewer',
        invitedBy: null,
        createdAt: new Date(),
      };
      memberRepo.findOne = jest.fn(async ({ where }: { where: { actorId: string } }) =>
        where.actorId === ACTOR_UUID
          ? { actorId: ACTOR_UUID, role: 'owner', invitedBy: null, createdAt: new Date() }
          : target,
      );
      const err = (await capture(() =>
        service.updateMemberRole(CREATOR_UUID, { role: 'owner' }, humanMember),
      )) as ForbiddenException;
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect(target.role).toBe('reviewer'); // 未被改写
      expect(memberRepo.insert).not.toHaveBeenCalled();
      expect(memberRepo.update).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          newData: expect.objectContaining({ reason: 'owner_may_only_touch_reviewer_rows' }),
        }),
      );
    });

    it('owner 动 owner 行（即使请求值也是 owner）→ 403（目标行约束）', async () => {
      memberRepo.findOne = jest.fn(async ({ where }: { where: { actorId: string } }) => ({
        actorId: where.actorId,
        role: 'owner',
        invitedBy: null,
        createdAt: new Date(),
      }));
      const err = (await capture(() =>
        service.updateMemberRole(CREATOR_UUID, { role: 'owner' }, humanMember),
      )) as ForbiddenException;
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(memberRepo.insert).not.toHaveBeenCalled();
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('非成员目标 → 404/13003（message 指引先核对成员清单）', async () => {
      memberRepo.findOne = jest.fn(async ({ where }: { where: { actorId: string } }) =>
        where.actorId === ACTOR_UUID
          ? { actorId: ACTOR_UUID, role: 'owner', invitedBy: null, createdAt: new Date() }
          : null,
      );
      const err = (await capture(() =>
        service.updateMemberRole(CREATOR_UUID, { role: 'reviewer' }, humanMember),
      )) as NotFoundException;
      expect(err).toBeInstanceOf(NotFoundException);
      const payload = err.getResponse() as { code: number; message: string };
      expect(payload.code).toBe(ErrorCode.EXPERIENCE_MEMBER_NOT_FOUND);
      expect(payload.message).toContain('GET /experiences/members');
    });

    it('reviewer 成员调 PATCH → 403/13004（无成员管理权）', async () => {
      memberRepo.findOne = jest.fn(async () => ({
        actorId: ACTOR_UUID,
        role: 'reviewer',
        invitedBy: null,
        createdAt: new Date(),
      }));
      const err = (await capture(() =>
        service.updateMemberRole(CREATOR_UUID, { role: 'reviewer' }, humanMember),
      )) as ForbiddenException;
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 夺权（DELETE）
  // ══════════════════════════════════════════════════════════════════

  describe('removeMember', () => {
    it('admin 夺权 reviewer → **物理删** + DELETE 审计（含被夺角色与执行者）', async () => {
      setMemberRow(CREATOR_UUID, 'reviewer', ACTOR_UUID);
      const res = await service.removeMember(CREATOR_UUID, admin);
      expect(res).toEqual({ deleted: true, actorId: CREATOR_UUID });
      expect(memberRepo.delete).toHaveBeenCalledWith({ actorId: CREATOR_UUID });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'delete',
          entityId: CREATOR_UUID,
          newData: { actorId: CREATOR_UUID, role: 'reviewer', revokedBy: ACTOR_UUID },
        }),
      );
    });

    it('owner 夺权 reviewer 行 → 允许（条件删命中）', async () => {
      setMemberRow(ACTOR_UUID, 'owner'); // 调用者
      setMemberRow(CREATOR_UUID, 'reviewer'); // 目标行
      await expect(service.removeMember(CREATOR_UUID, humanMember)).resolves.toEqual({
        deleted: true,
        actorId: CREATOR_UUID,
      });
      // 条件删：带 role 条件（并发护栏），且行确实没了
      expect(memberRepo.delete).toHaveBeenCalledWith({ actorId: CREATOR_UUID, role: 'reviewer' });
      expect(rows.has(CREATOR_UUID)).toBe(false);
    });

    it('owner 夺权 owner 行 → 403/13004 + 零删除（owner 任免是 admin 专属）', async () => {
      memberRepo.findOne = jest.fn(async ({ where }: { where: { actorId: string } }) => ({
        actorId: where.actorId,
        role: 'owner',
        invitedBy: null,
        createdAt: new Date(),
      }));
      const err = (await capture(() =>
        service.removeMember(CREATOR_UUID, humanMember),
      )) as ForbiddenException;
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(memberRepo.delete).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          newData: expect.objectContaining({ reason: 'owner_may_only_remove_reviewer_rows' }),
        }),
      );
    });

    it('非成员目标 → 404/13003 + 零删除', async () => {
      memberRepo.findOne = jest.fn(async () => null);
      const err = (await capture(() =>
        service.removeMember(CREATOR_UUID, admin),
      )) as NotFoundException;
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_MEMBER_NOT_FOUND,
      );
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('reviewer 成员调 DELETE → 403/13004（无成员管理权）', async () => {
      memberRepo.findOne = jest.fn(async () => ({
        actorId: ACTOR_UUID,
        role: 'reviewer',
        invitedBy: null,
        createdAt: new Date(),
      }));
      const err = (await capture(() =>
        service.removeMember(CREATOR_UUID, humanMember),
      )) as ForbiddenException;
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('非成员调用者 → 403/13004 + denied 审计（not_a_member）', async () => {
      memberRepo.findOne = jest.fn(async () => null);
      const err = (await capture(() =>
        service.removeMember(CREATOR_UUID, agentActor),
      )) as ForbiddenException;
      expect((err.getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          newData: expect.objectContaining({ denied: true, reason: 'not_a_member' }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 写路径并发护栏 + 空身份纵深（2026-09-22 复审 P2-1 / P2-5）
  //
  // 这一组测的都是"**检查通过了、但写入那一刻库已变**"的时序窗——它们静默失效时的
  // 症状分别是：可重试的幂等授权变成 409、owner 把已升格的行删掉/改掉、被夺权的行复活。
  // 伪造手段：`mockImplementationOnce` 只覆盖前 N 次 findOne（"陈旧读"），
  // 之后的 findOne 落回真实表状态 `rows`（"并发已经改成什么"）。
  // ══════════════════════════════════════════════════════════════════

  describe('写路径并发护栏（P2-1）', () => {
    /** 伪造陈旧读：第 N 次 findOne 返回指定行（真实状态由 rows 表达） */
    const staleRead = (row: { actorId: string; role: string; invitedBy: string | null }): void => {
      memberRepo.findOne.mockImplementationOnce(async () => ({ ...row, createdAt: new Date() }));
    };

    describe('POST：23505 竞态收敛（撞 PK = 并发同 actor 授权）', () => {
      it('23505 + 并发方同角色 → 幂等返回 created=false（**绝不泄漏成 409**）', async () => {
        // 库里已有 reviewer 行，但预检读到 null（陈旧读）→ insert 撞 23505 → 回读收敛
        setMemberRow(CREATOR_UUID, 'reviewer', ACTOR_UUID);
        const rowBefore = rows.get(CREATOR_UUID);
        memberRepo.findOne.mockImplementationOnce(async () => null);

        const res = await service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, admin);
        expect(res.created).toBe(false);
        expect(res.member.role).toBe('reviewer');
        // 仍是并发方写下的那一行（本请求零写入）+ 未写 CREATE 审计
        expect(rows.get(CREATOR_UUID)).toBe(rowBefore);
        expect(memberRepo.insert).toHaveBeenCalledTimes(1); // 尝试过（然后被 23505 挡回）
        expect(auditService.log).not.toHaveBeenCalled();
      });

      it('23505 + 并发方异角色 → 409/13005（指引 PATCH）', async () => {
        setMemberRow(CREATOR_UUID, 'owner');
        memberRepo.findOne.mockImplementationOnce(async () => null);

        const err = (await capture(() =>
          service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, admin),
        )) as ConflictException;
        expect(err).toBeInstanceOf(ConflictException);
        expect((err.getResponse() as { code: number }).code).toBe(
          ErrorCode.EXPERIENCE_MEMBER_EXISTS,
        );
      });

      it('23505 + 回读为空（并发方插入后又删了）→ 409/9001 且 message 指明可重试', async () => {
        memberRepo.findOne.mockImplementationOnce(async () => null);
        memberRepo.insert.mockRejectedValueOnce(uniqueViolation());

        const err = (await capture(() =>
          service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, admin),
        )) as ConflictException;
        expect(err).toBeInstanceOf(ConflictException);
        const payload = err.getResponse() as { code: number; message: string };
        expect(payload.code).toBe(ErrorCode.RESOURCE_CONFLICT);
        expect(payload.message).toContain('retry');
      });

      it('非 23505 的写失败原样抛出（不被误判成竞态）', async () => {
        memberRepo.findOne.mockImplementationOnce(async () => null);
        memberRepo.insert.mockRejectedValueOnce(
          Object.assign(new Error('boom'), { code: '08006' }),
        );

        const err = (await capture(() =>
          service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, admin),
        )) as Error;
        expect((err as { code?: string }).code).toBe('08006');
      });
    });

    describe('DELETE：owner 条件删（检查后被升格的 owner 行不得被删）', () => {
      it('条件删 affected=0 + 行仍在（已被升成 owner）→ 403/13004 + denied 审计 + **未删**', async () => {
        setMemberRow(ACTOR_UUID, 'owner'); // 调用者
        setMemberRow(CREATOR_UUID, 'owner'); // 真实状态：检查后已升格
        memberRepo.findOne.mockImplementationOnce(async () => rows.get(ACTOR_UUID) ?? null);
        staleRead({ actorId: CREATOR_UUID, role: 'reviewer', invitedBy: null });

        const err = (await capture(() =>
          service.removeMember(CREATOR_UUID, humanMember),
        )) as ForbiddenException;
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err.getResponse() as { code: number }).code).toBe(
          ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
        );
        expect(rows.has(CREATOR_UUID)).toBe(true); // 没被删掉
        expect(auditService.log).toHaveBeenCalledWith(
          expect.objectContaining({
            newData: expect.objectContaining({
              denied: true,
              reason: 'role_changed_before_write',
            }),
          }),
        );
      });

      it('条件删 affected=0 + 行已消失（被并发夺权）→ 404/13003', async () => {
        setMemberRow(ACTOR_UUID, 'owner');
        memberRepo.findOne.mockImplementationOnce(async () => rows.get(ACTOR_UUID) ?? null);
        staleRead({ actorId: CREATOR_UUID, role: 'reviewer', invitedBy: null });
        // CREATOR_UUID 不在 rows ⇒ 条件删 affected=0 且回读为空

        const err = (await capture(() =>
          service.removeMember(CREATOR_UUID, humanMember),
        )) as NotFoundException;
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err.getResponse() as { code: number }).code).toBe(
          ErrorCode.EXPERIENCE_MEMBER_NOT_FOUND,
        );
      });
    });

    describe('PATCH：owner 条件写探针 / admin 条件写', () => {
      it('owner 条件写 affected=0（检查后已升成 owner）→ 403/13004，**不返 200**', async () => {
        setMemberRow(ACTOR_UUID, 'owner');
        setMemberRow(CREATOR_UUID, 'owner'); // 真实状态：已升格
        memberRepo.findOne.mockImplementationOnce(async () => rows.get(ACTOR_UUID) ?? null);
        staleRead({ actorId: CREATOR_UUID, role: 'reviewer', invitedBy: null });

        const err = (await capture(() =>
          service.updateMemberRole(CREATOR_UUID, { role: 'reviewer' }, humanMember),
        )) as ForbiddenException;
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err.getResponse() as { code: number }).code).toBe(
          ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
        );
        expect(rows.get(CREATOR_UUID)?.role).toBe('owner'); // 未被降级
      });

      it('admin 条件写 affected=0（行被并发夺权）→ 404，**不重建行**（夺权后复活防线）', async () => {
        memberRepo.findOne.mockImplementationOnce(async () => ({
          actorId: CREATOR_UUID,
          role: 'reviewer',
          invitedBy: null,
          createdAt: new Date(),
        }));
        // rows 无该行 ⇒ update affected=0
        const err = (await capture(() =>
          service.updateMemberRole(CREATOR_UUID, { role: 'owner' }, admin),
        )) as NotFoundException;
        expect(err).toBeInstanceOf(NotFoundException);
        expect(rows.has(CREATOR_UUID)).toBe(false);
        expect(auditService.log).not.toHaveBeenCalled();
      });

      it('admin 删 affected=0（行被并发夺权）→ 404（不是装作删成功）', async () => {
        memberRepo.findOne.mockImplementationOnce(async () => ({
          actorId: CREATOR_UUID,
          role: 'reviewer',
          invitedBy: null,
          createdAt: new Date(),
        }));
        const err = (await capture(() =>
          service.removeMember(CREATOR_UUID, admin),
        )) as NotFoundException;
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err.getResponse() as { code: number }).code).toBe(
          ErrorCode.EXPERIENCE_MEMBER_NOT_FOUND,
        );
      });
    });
  });

  describe('空身份纵深（P2-5）：三端点均 403/13004 且仓储零调用', () => {
    it('addMember / updateMemberRole / removeMember with actor=null', async () => {
      for (const call of [
        () => service.addMember({ actorId: CREATOR_UUID, role: 'reviewer' }, null as never),
        () => service.updateMemberRole(CREATOR_UUID, { role: 'reviewer' }, null as never),
        () => service.removeMember(CREATOR_UUID, null as never),
      ]) {
        const err = (await capture(call)) as ForbiddenException;
        expect(err).toBeInstanceOf(ForbiddenException);
        // 越权拒绝必须是 403/13004，**不能**是 500（recordDenied 读 actor.id 的 TypeError）
        expect((err.getResponse() as { code: number }).code).toBe(
          ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
        );
      }
      expect(memberRepo.findOne).not.toHaveBeenCalled();
      expect(memberRepo.insert).not.toHaveBeenCalled();
      expect(memberRepo.update).not.toHaveBeenCalled();
      expect(memberRepo.delete).not.toHaveBeenCalled();
      expect(actorProfile.assertActorUsable).not.toHaveBeenCalled();
    });

    it('assertManageIdentity 单用：空身份抛 403/13004，有身份放行', () => {
      expect(() => service.assertManageIdentity(null)).toThrow(ForbiddenException);
      expect(() => service.assertManageIdentity(admin)).not.toThrow();
    });
  });
});

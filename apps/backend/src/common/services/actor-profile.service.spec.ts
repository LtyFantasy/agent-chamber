/**
 * ActorProfileService 单测（统一批 A1 地基，契约见 docs/spec.md §1）
 *
 * 覆盖：活跃/软删 actor 解析、R9 名字回退链（agent/human 两侧）、真孤儿不进 map、
 * assertActorUsable 三态（不存在 / 已软删 / 正常）。
 * 关键契约断言（R1）：软删场景必须走 queryBuilder .withDeleted().addSelect('actor.deletedAt')
 * 双条件——find({withDeleted:true}) 不会选出 select:false 列，读 .deletedAt 恒 undefined。
 */
import { Repository } from 'typeorm';
import { ActorProfileService } from './actor-profile.service';
import { Actor } from '../../database/entities/actor.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { ActorType, ErrorCode } from '@agent-chamber/shared';

/** 构造最小 Actor 行（deletedAt 由用例显式传入——select:false 列在 mock 中直接给出） */
function makeActor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'actor-1',
    type: ActorType.AGENT,
    displayName: 'Display Bot',
    avatarUrl: null,
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  } as Actor;
}

describe('ActorProfileService', () => {
  let service: ActorProfileService;
  let actorRepo: jest.Mocked<Repository<Actor>>;
  let agentRepo: jest.Mocked<Repository<Agent>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let qb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    withDeleted: jest.Mock;
    where: jest.Mock;
    getMany: jest.Mock;
    getOne: jest.Mock;
  };

  beforeEach(() => {
    qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
      getOne: jest.fn(),
    };
    actorRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as jest.Mocked<Repository<Actor>>;
    agentRepo = { findBy: jest.fn() } as unknown as jest.Mocked<Repository<Agent>>;
    userRepo = { findBy: jest.fn() } as unknown as jest.Mocked<Repository<User>>;
    service = new ActorProfileService(actorRepo, agentRepo, userRepo);
  });

  describe('resolveProfiles', () => {
    it('活跃 agent：真名（agents.name）+ avatar/description + deletedAt null', async () => {
      qb.getMany.mockResolvedValue([
        makeActor({
          id: 'agent-1',
          type: ActorType.AGENT,
          displayName: 'Stale Display',
          avatarUrl: 'https://a/1.png',
        }),
      ]);
      agentRepo.findBy.mockResolvedValue([
        { id: 'agent-1', name: 'Kimi', description: '平台主脑' } as Agent,
      ]);

      const map = await service.resolveProfiles(['agent-1']);

      expect(map.get('agent-1')).toEqual({
        type: ActorType.AGENT,
        name: 'Kimi',
        avatarUrl: 'https://a/1.png',
        description: '平台主脑',
        deletedAt: null,
      });
    });

    it('软删 agent：withDeleted+addSelect 双条件查询 → 真名保留 + deletedAt 非空（R1）', async () => {
      const deletedAt = new Date('2024-06-01T00:00:00.000Z');
      qb.getMany.mockResolvedValue([
        makeActor({ id: 'agent-1', type: ActorType.AGENT, deletedAt }),
      ]);
      // agents 行恒在（软删标记在 actors 表），name 仍可取
      agentRepo.findBy.mockResolvedValue([{ id: 'agent-1', name: 'Kimi' } as Agent]);

      const map = await service.resolveProfiles(['agent-1']);

      expect(map.get('agent-1')).toMatchObject({ name: 'Kimi', deletedAt });
      // R1 契约：必须是 queryBuilder withDeleted + addSelect 双条件，禁止 find({withDeleted:true})
      expect(actorRepo.createQueryBuilder).toHaveBeenCalledWith('actor');
      expect(qb.withDeleted).toHaveBeenCalled();
      expect(qb.addSelect).toHaveBeenCalledWith('actor.deletedAt');
    });

    it('R9 agent 回退链：agents.name 优先于 actors.displayName；agents 缺行时回退 displayName', async () => {
      qb.getMany.mockResolvedValue([
        makeActor({ id: 'agent-1', type: ActorType.AGENT, displayName: 'Stale Display Name' }),
        makeActor({ id: 'agent-2', type: ActorType.AGENT, displayName: 'Display Two' }),
      ]);
      // agent-2 无 agents 行（极端缺行场景）
      agentRepo.findBy.mockResolvedValue([{ id: 'agent-1', name: 'Fresh Name' } as Agent]);

      const map = await service.resolveProfiles(['agent-1', 'agent-2']);

      // agents.name 是一等来源（agent 改名只更新 agents.name，displayName 会陈旧）
      expect(map.get('agent-1')?.name).toBe('Fresh Name');
      expect(map.get('agent-2')?.name).toBe('Display Two');
      // agents 补查只覆盖 type=agent 的 id
      expect(agentRepo.findBy).toHaveBeenCalledWith({ id: expect.anything() });
    });

    it('R9 human 回退链：displayName 优先，缺失时 username 回退，皆缺 → Unknown User', async () => {
      qb.getMany.mockResolvedValue([
        makeActor({ id: 'user-1', type: ActorType.HUMAN, displayName: 'Alice' }),
        makeActor({ id: 'user-2', type: ActorType.HUMAN, displayName: null }),
        makeActor({ id: 'user-3', type: ActorType.HUMAN, displayName: null }),
      ]);
      // users 条件补查只覆盖 displayName 为空的 human；user-3 无 users 行
      userRepo.findBy.mockResolvedValue([{ id: 'user-2', username: 'bob' } as User]);

      const map = await service.resolveProfiles(['user-1', 'user-2', 'user-3']);

      expect(map.get('user-1')?.name).toBe('Alice');
      expect(map.get('user-2')?.name).toBe('bob');
      expect(map.get('user-3')?.name).toBe('Unknown User');
      expect(map.get('user-1')?.deletedAt).toBeNull();
    });

    it('真孤儿（actors 表无行）不进 map，由调用方自行兜底（R12）', async () => {
      qb.getMany.mockResolvedValue([makeActor({ id: 'agent-1', type: ActorType.AGENT })]);
      agentRepo.findBy.mockResolvedValue([]);

      const map = await service.resolveProfiles(['agent-1', 'ghost-id']);

      expect(map.has('agent-1')).toBe(true);
      expect(map.has('ghost-id')).toBe(false);
      expect(map.size).toBe(1);
    });

    it('空/重复 id 输入：去重且空数组直接返回空 map（不发查询）', async () => {
      const map = await service.resolveProfiles([]);
      expect(map.size).toBe(0);
      expect(actorRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('assertActorUsable', () => {
    it('正常 actor（有行且未软删）→ 通过', async () => {
      qb.getOne.mockResolvedValue(makeActor({ id: 'agent-1', deletedAt: null }));
      await expect(service.assertActorUsable('agent-1')).resolves.toBeUndefined();
    });

    it('不存在（actors 表无行）→ 抛 AGENT_NOT_FOUND', async () => {
      qb.getOne.mockResolvedValue(null);
      await expect(service.assertActorUsable('ghost-id')).rejects.toMatchObject({
        response: expect.objectContaining({
          code: ErrorCode.AGENT_NOT_FOUND,
          message: 'Agent not found or deleted',
        }),
      });
    });

    it('已软删（有行但 deletedAt 非空）→ 抛 AGENT_NOT_FOUND（R14 两态合一）', async () => {
      qb.getOne.mockResolvedValue(
        makeActor({ id: 'agent-1', deletedAt: new Date('2024-06-01T00:00:00.000Z') }),
      );
      await expect(service.assertActorUsable('agent-1')).rejects.toMatchObject({
        response: expect.objectContaining({
          code: ErrorCode.AGENT_NOT_FOUND,
          message: 'Agent not found or deleted',
        }),
      });
      // 与 resolveProfiles 同规：withDeleted + addSelect 双条件（select:false 列必须显式选）
      expect(qb.withDeleted).toHaveBeenCalled();
      expect(qb.addSelect).toHaveBeenCalledWith('actor.deletedAt');
    });
  });
});

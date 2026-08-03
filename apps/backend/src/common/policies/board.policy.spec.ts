import { BoardPolicy } from './board.policy';
import { Board } from '../../database/entities/board.entity';
import { BoardMember } from '../../database/entities/board-member.entity';
import { UnifiedActor } from '../types/actor.types';
import { OwnerProxyService } from '../services/owner-proxy.service';
import { Visibility, UserRole, ActorType } from '@agent-chamber/shared';
import { Repository } from 'typeorm';

describe('BoardPolicy', () => {
  let policy: BoardPolicy;
  let memberRepo: jest.Mocked<Repository<BoardMember>>;
  let ownerProxy: jest.Mocked<OwnerProxyService>;

  beforeEach(() => {
    memberRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<BoardMember>>;
    ownerProxy = {
      isOwnerProxy: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<OwnerProxyService>;
    policy = new BoardPolicy(memberRepo, ownerProxy);
  });

  afterEach(() => jest.clearAllMocks());

  const makeBoard = (overrides: Partial<Board> = {}): Board =>
    ({
      id: 'board-1',
      name: 'Test Board',
      topicId: 'topic-1',
      creatorId: 'creator-1',
      creatorType: 'human',
      settings: { visibility: Visibility.OPEN },
      lists: [],
      ...overrides,
    }) as Board;

  const makeActor = (overrides: Partial<UnifiedActor> = {}): UnifiedActor =>
    ({
      id: 'actor-1',
      type: ActorType.AGENT,
      role: UserRole.EDITOR,
      ...overrides,
    }) as UnifiedActor;

  // ─── Helper: mock board_members lookup ───
  const mockMember = (role: string | null) => {
    memberRepo.findOne.mockResolvedValue(
      role
        ? ({ boardId: 'board-1', actorId: 'actor-1', role } as BoardMember)
        : null,
    );
  };

  describe('OPEN board', () => {
    it('anyone can read', async () => {
      mockMember(null);
      const result = await policy.can(makeActor(), makeBoard(), 'read');
      expect(result).toBe(true);
    });

    it('non-creator cannot write', async () => {
      mockMember(null);
      const result = await policy.can(makeActor(), makeBoard(), 'write');
      expect(result).toBe(false);
    });

    it('creator can write', async () => {
      const result = await policy.can(
        makeActor({ id: 'creator-1', type: ActorType.HUMAN }),
        makeBoard(),
        'write',
      );
      expect(result).toBe(true);
    });
  });

  describe('PRIVATE board', () => {
    it('uninvited non-participant cannot read', async () => {
      mockMember(null);
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'stranger-1' }), board, 'read');
      expect(result).toBe(false);
    });

    it('invited agent (member) can read', async () => {
      mockMember('member');
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'invited-1' }), board, 'read');
      expect(result).toBe(true);
    });

    it('creator can read', async () => {
      mockMember(null);
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(
        makeActor({ id: 'creator-1', type: ActorType.HUMAN }),
        board,
        'read',
      );
      expect(result).toBe(true);
    });

    // ─── 核心回归：已有 member 的权限 ───
    it('existing member (board_members) can read', async () => {
      mockMember('member');
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'existing-participant-1' }), board, 'read');
      expect(result).toBe(true);
      // 验证查的是 board_members
      expect(memberRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            boardId: 'board-1',
            actorId: 'existing-participant-1',
          },
        }),
      );
    });

    it('non-member cannot read private board', async () => {
      mockMember(null);
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'stranger-1' }), board, 'read');
      expect(result).toBe(false);
    });
  });

  describe('effectiveVisibility', () => {
    it('returns board own visibility (Batch 2: no topic inheritance)', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.PRIVATE } });
      const result = await policy.effectiveVisibility(board);
      expect(result).toBe(Visibility.PRIVATE);
    });

    it('defaults to OPEN when no visibility set', async () => {
      const board = makeBoard({ settings: {} });
      const result = await policy.effectiveVisibility(board);
      expect(result).toBe(Visibility.OPEN);
    });
  });

  describe('board without topicId', () => {
    it('OPEN standalone board: anyone can read', async () => {
      const board = makeBoard({ topicId: null, settings: { visibility: Visibility.OPEN } });
      const result = await policy.can(makeActor(), board, 'read');
      expect(result).toBe(true);
    });

    it('PRIVATE standalone board: only creator can read', async () => {
      mockMember(null);
      const board = makeBoard({
        topicId: null,
        settings: { visibility: Visibility.PRIVATE },
      });
      // creator
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), board, 'read'),
      ).toBe(true);
      // stranger
      expect(await policy.can(makeActor({ id: 'stranger-1' }), board, 'read')).toBe(false);
    });
  });

  describe('owner proxy (v1.37: human owner of creator agent acts as creator)', () => {
    const agentBoard = makeBoard({
      creatorId: 'agent-1',
      creatorType: ActorType.AGENT,
      settings: { visibility: Visibility.PRIVATE },
    });
    const ownerActor = makeActor({ id: 'human-owner-1', type: ActorType.HUMAN });

    it('owner human can read agent-created private board', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentBoard, 'read')).toBe(true);
      expect(ownerProxy.isOwnerProxy).toHaveBeenCalledWith('agent-1', ownerActor);
    });

    it('owner human can write agent-created board', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentBoard, 'write')).toBe(true);
    });

    it('owner human can delete agent-created board', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentBoard, 'delete')).toBe(true);
    });

    it('non-owner human cannot read agent-created private board', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      expect(
        await policy.can(makeActor({ id: 'stranger-human', type: ActorType.HUMAN }), agentBoard, 'read'),
      ).toBe(false);
    });

    it('non-owner human cannot delete agent-created board', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      expect(
        await policy.can(makeActor({ id: 'stranger-human', type: ActorType.HUMAN }), agentBoard, 'delete'),
      ).toBe(false);
    });

    it('agent actor never triggers owner proxy (agent cannot own agent)', async () => {
      mockMember(null);
      const agentActor = makeActor({ id: 'agent-2', type: ActorType.AGENT });
      expect(await policy.can(agentActor, agentBoard, 'read')).toBe(false);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('OPEN board read short-circuits owner proxy query', async () => {
      const openBoard = makeBoard({ creatorId: 'agent-1', creatorType: ActorType.AGENT });
      expect(await policy.can(ownerActor, openBoard, 'read')).toBe(true);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });
  });

  describe('admin bypass', () => {
    it('admin can read any board', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.PRIVATE } });
      const result = await policy.can(makeActor({ role: UserRole.ADMIN }), board, 'read');
      expect(result).toBe(true);
      // admin bypass 不应该查 DB
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('admin can write any board', async () => {
      const board = makeBoard({ creatorId: 'other-creator' });
      const result = await policy.can(makeActor({ role: UserRole.ADMIN }), board, 'write');
      expect(result).toBe(true);
    });
  });

  describe('write / delete', () => {
    it('only creator can write', async () => {
      mockMember(null);
      const board = makeBoard();
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), board, 'write'),
      ).toBe(true);
      expect(await policy.can(makeActor({ id: 'stranger-1' }), board, 'write')).toBe(false);
    });

    it('only creator can delete', async () => {
      mockMember(null);
      const board = makeBoard();
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), board, 'delete'),
      ).toBe(true);
      expect(await policy.can(makeActor({ id: 'stranger-1' }), board, 'delete')).toBe(false);
    });
  });

  describe('editor permissions', () => {
    it('editor can read private board', async () => {
      mockMember('editor');
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'editor-1' }), board, 'read');
      expect(result).toBe(true);
    });

    it('editor can write', async () => {
      mockMember('editor');
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'editor-1' }), board, 'write');
      expect(result).toBe(true);
    });

    it('editor cannot delete', async () => {
      mockMember('editor');
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'editor-1' }), board, 'delete');
      expect(result).toBe(false);
    });
  });
});

import { DocSpacePolicy } from './doc-space.policy';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { UnifiedActor } from '../types/actor.types';
import { OwnerProxyService } from '../services/owner-proxy.service';
import { Visibility, UserRole, ActorType } from '@agent-chamber/shared';
import { Repository } from 'typeorm';

describe('DocSpacePolicy', () => {
  let policy: DocSpacePolicy;
  let memberRepo: jest.Mocked<Repository<DocSpaceMember>>;
  let ownerProxy: jest.Mocked<OwnerProxyService>;

  beforeEach(() => {
    memberRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<DocSpaceMember>>;
    ownerProxy = {
      isOwnerProxy: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<OwnerProxyService>;
    policy = new DocSpacePolicy(memberRepo, ownerProxy);
  });

  afterEach(() => jest.clearAllMocks());

  const makeSpace = (overrides: Partial<DocSpace> = {}): DocSpace =>
    ({
      id: 'space-1',
      name: 'Test Space',
      slug: 'test-space',
      creatorId: 'creator-1',
      settings: { visibility: Visibility.OPEN },
      docCount: 0,
      ...overrides,
    }) as DocSpace;

  const makeActor = (overrides: Partial<UnifiedActor> = {}): UnifiedActor =>
    ({
      id: 'actor-1',
      type: ActorType.AGENT,
      role: UserRole.EDITOR,
      ...overrides,
    }) as UnifiedActor;

  // ─── Helper: mock doc_space_members lookup ───
  const mockMember = (role: string | null) => {
    memberRepo.findOne.mockResolvedValue(
      role ? ({ spaceId: 'space-1', actorId: 'actor-1', role } as DocSpaceMember) : null,
    );
  };

  describe('OPEN space', () => {
    it('anyone can read', async () => {
      mockMember(null);
      const result = await policy.can(makeActor(), makeSpace(), 'read');
      expect(result).toBe(true);
    });

    it('non-creator cannot write', async () => {
      mockMember(null);
      const result = await policy.can(makeActor(), makeSpace(), 'write');
      expect(result).toBe(false);
    });

    it('creator can write', async () => {
      const result = await policy.can(
        makeActor({ id: 'creator-1', type: ActorType.HUMAN }),
        makeSpace(),
        'write',
      );
      expect(result).toBe(true);
    });
  });

  describe('PRIVATE space', () => {
    it('uninvited non-member cannot read', async () => {
      mockMember(null);
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'stranger-1' }), space, 'read');
      expect(result).toBe(false);
    });

    it('invited agent (member) can read', async () => {
      mockMember('member');
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'invited-1' }), space, 'read');
      expect(result).toBe(true);
    });

    it('creator can read', async () => {
      mockMember(null);
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(
        makeActor({ id: 'creator-1', type: ActorType.HUMAN }),
        space,
        'read',
      );
      expect(result).toBe(true);
    });

    it('existing member (doc_space_members) can read', async () => {
      mockMember('member');
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'existing-member-1' }), space, 'read');
      expect(result).toBe(true);
      // 验证查的是 doc_space_members
      expect(memberRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            spaceId: 'space-1',
            actorId: 'existing-member-1',
          },
        }),
      );
    });

    it('non-member cannot read private space', async () => {
      mockMember(null);
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'stranger-1' }), space, 'read');
      expect(result).toBe(false);
    });
  });

  describe('effectiveVisibility', () => {
    it('returns space own visibility', async () => {
      const space = makeSpace({ settings: { visibility: Visibility.PRIVATE } });
      const result = await policy.effectiveVisibility(space);
      expect(result).toBe(Visibility.PRIVATE);
    });

    it('defaults to OPEN when no visibility set', async () => {
      const space = makeSpace({ settings: {} });
      const result = await policy.effectiveVisibility(space);
      expect(result).toBe(Visibility.OPEN);
    });
  });

  describe('standalone space (no topic/board binding)', () => {
    it('OPEN standalone: anyone can read', async () => {
      const space = makeSpace({
        topicId: null,
        boardId: null,
        settings: { visibility: Visibility.OPEN },
      });
      const result = await policy.can(makeActor(), space, 'read');
      expect(result).toBe(true);
    });

    it('PRIVATE standalone: only creator can read', async () => {
      mockMember(null);
      const space = makeSpace({
        topicId: null,
        boardId: null,
        settings: { visibility: Visibility.PRIVATE },
      });
      // creator
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), space, 'read'),
      ).toBe(true);
      // stranger
      expect(await policy.can(makeActor({ id: 'stranger-1' }), space, 'read')).toBe(false);
    });
  });

  describe('owner proxy (v1.37: human owner of creator agent acts as creator)', () => {
    const agentSpace = makeSpace({
      creatorId: 'agent-1',
      settings: { visibility: Visibility.PRIVATE },
    });
    const ownerActor = makeActor({ id: 'human-owner-1', type: ActorType.HUMAN });

    it('owner human can read agent-created private space', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentSpace, 'read')).toBe(true);
      expect(ownerProxy.isOwnerProxy).toHaveBeenCalledWith('agent-1', ownerActor);
    });

    it('owner human can write agent-created space', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentSpace, 'write')).toBe(true);
    });

    it('owner human can delete agent-created space', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentSpace, 'delete')).toBe(true);
    });

    it('non-owner human cannot read agent-created private space', async () => {
      mockMember(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      expect(
        await policy.can(
          makeActor({ id: 'stranger-human', type: ActorType.HUMAN }),
          agentSpace,
          'read',
        ),
      ).toBe(false);
    });

    it('agent actor never triggers owner proxy (agent cannot own agent)', async () => {
      mockMember(null);
      const agentActor = makeActor({ id: 'agent-2', type: ActorType.AGENT });
      expect(await policy.can(agentActor, agentSpace, 'read')).toBe(false);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('OPEN space read short-circuits owner proxy query', async () => {
      const openSpace = makeSpace({ creatorId: 'agent-1' });
      expect(await policy.can(ownerActor, openSpace, 'read')).toBe(true);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });
  });

  describe('admin bypass', () => {
    it('admin can read any space', async () => {
      const space = makeSpace({ settings: { visibility: Visibility.PRIVATE } });
      const result = await policy.can(makeActor({ role: UserRole.ADMIN }), space, 'read');
      expect(result).toBe(true);
      // admin bypass 不应该查 DB
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('admin can write any space', async () => {
      const space = makeSpace({ creatorId: 'other-creator' });
      const result = await policy.can(makeActor({ role: UserRole.ADMIN }), space, 'write');
      expect(result).toBe(true);
    });
  });

  describe('write / delete', () => {
    it('only creator can write', async () => {
      mockMember(null);
      const space = makeSpace();
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), space, 'write'),
      ).toBe(true);
      expect(await policy.can(makeActor({ id: 'stranger-1' }), space, 'write')).toBe(false);
    });

    it('only creator can delete', async () => {
      mockMember(null);
      const space = makeSpace();
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), space, 'delete'),
      ).toBe(true);
      expect(await policy.can(makeActor({ id: 'stranger-1' }), space, 'delete')).toBe(false);
    });
  });

  describe('editor permissions', () => {
    it('editor can read private space', async () => {
      mockMember('editor');
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'editor-1' }), space, 'read');
      expect(result).toBe(true);
    });

    it('editor can write', async () => {
      mockMember('editor');
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'editor-1' }), space, 'write');
      expect(result).toBe(true);
    });

    it('editor cannot delete', async () => {
      mockMember('editor');
      const space = makeSpace({
        settings: { visibility: Visibility.PRIVATE },
      });
      const result = await policy.can(makeActor({ id: 'editor-1' }), space, 'delete');
      expect(result).toBe(false);
    });
  });
});

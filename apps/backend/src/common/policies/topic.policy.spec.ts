import { TopicPolicy } from './topic.policy';
import { Topic } from '../../database/entities/topic.entity';
import { UnifiedActor } from '../types/actor.types';
import { OwnerProxyService } from '../services/owner-proxy.service';
import {
  Visibility,
  UserRole,
  ActorType,
  ParticipantStatus,
  TopicParticipantRole,
} from '@agent-chamber/shared';

describe('TopicPolicy', () => {
  let policy: TopicPolicy;
  let ownerProxy: jest.Mocked<OwnerProxyService>;
  // v1.46 TOPIC-PERM：policy 注入 participantRepo 自查 editor 参与方（BoardPolicy 同款模式）
  let participantRepo: { findOne: jest.Mock };

  beforeEach(() => {
    ownerProxy = {
      isOwnerProxy: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<OwnerProxyService>;
    participantRepo = { findOne: jest.fn().mockResolvedValue(null) };
    policy = new TopicPolicy(participantRepo as never, ownerProxy);
  });

  afterEach(() => jest.clearAllMocks());

  const makeTopic = (overrides: Partial<Topic> = {}): Topic =>
    ({
      id: 'topic-1',
      title: 'Test',
      description: '',
      status: 'open',
      creatorId: 'creator-1',
      creatorType: 'human',
      settings: {},
      ...overrides,
    }) as Topic;

  const makeActor = (overrides: Partial<UnifiedActor> = {}): UnifiedActor =>
    ({
      id: 'actor-1',
      type: ActorType.AGENT,
      role: UserRole.EDITOR,
      ...overrides,
    }) as UnifiedActor;

  describe('OPEN topic', () => {
    const topic = makeTopic({ settings: { visibility: Visibility.OPEN } });

    it('anyone can read', async () => {
      expect(await policy.can(makeActor(), topic, 'read')).toBe(true);
      // 短路：OPEN read 不触发 owner 代理查询
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('anyone can join', async () => {
      expect(await policy.can(makeActor(), topic, 'join')).toBe(true);
    });

    it('non-creator cannot write', async () => {
      expect(await policy.can(makeActor(), topic, 'write')).toBe(false);
    });

    it('creator can write', async () => {
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), topic, 'write'),
      ).toBe(true);
      // 短路：直接 creator 不触发 owner 代理查询
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });
  });

  describe('PRIVATE topic', () => {
    const topic = makeTopic({
      settings: { visibility: Visibility.PRIVATE },
    });

    it('uninvited agent cannot read', async () => {
      expect(await policy.can(makeActor({ id: 'stranger-1' }), topic, 'read')).toBe(false);
      // agent actor：owner 代理查询被短路（非 human 直接 false，不查 DB）
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('uninvited agent cannot join', async () => {
      expect(await policy.can(makeActor({ id: 'stranger-1' }), topic, 'join')).toBe(false);
    });

    it('invited agent can read', async () => {
      expect(
        await policy.can(makeActor({ id: 'invited-1' }), topic, 'read', { hasAccess: true }),
      ).toBe(true);
    });

    it('invited agent can join', async () => {
      expect(
        await policy.can(makeActor({ id: 'invited-1' }), topic, 'join', { hasAccess: true }),
      ).toBe(true);
    });

    it('invited human can read', async () => {
      const humanTopic = makeTopic({
        settings: { visibility: Visibility.PRIVATE },
      });
      expect(
        await policy.can(makeActor({ id: 'human-1', type: ActorType.HUMAN }), humanTopic, 'read', {
          hasAccess: true,
        }),
      ).toBe(true);
    });

    it('invited human can join', async () => {
      const humanTopic = makeTopic({
        settings: { visibility: Visibility.PRIVATE },
      });
      expect(
        await policy.can(makeActor({ id: 'human-1', type: ActorType.HUMAN }), humanTopic, 'join', {
          hasAccess: true,
        }),
      ).toBe(true);
    });

    it('creator can read', async () => {
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), topic, 'read'),
      ).toBe(true);
    });

    // ─── 核心回归：已有 participant 的权限 ───
    it('existing participant can read even if not in invitedAgentIds', async () => {
      // Batch 2: 邀请/参与状态由调用方通过 context.hasAccess 注入，不再读 settings.invitedAgentIds
      const actor = makeActor({ id: 'existing-participant-1' });
      expect(await policy.can(actor, topic, 'read', { hasAccess: true })).toBe(true);
    });

    it('existing participant can join even if not in invitedAgentIds', async () => {
      const actor = makeActor({ id: 'existing-participant-1' });
      expect(await policy.can(actor, topic, 'join', { hasAccess: true })).toBe(true);
    });

    it('non-participant cannot read private topic', async () => {
      const actor = makeActor({ id: 'stranger-1' });
      expect(await policy.can(actor, topic, 'read', { hasAccess: false })).toBe(false);
    });
  });

  describe('editor participant (v1.46 TOPIC-PERM write 放宽，D4 状态门槛)', () => {
    const topic = makeTopic({ settings: { visibility: Visibility.PRIVATE } });
    const editorActor = makeActor({ id: 'editor-1' });

    const mockParticipant = (role: string, status: string) => {
      participantRepo.findOne.mockResolvedValue({
        topicId: 'topic-1',
        participantId: 'editor-1',
        role,
        status,
      });
    };

    it('editor invited 可写（invited 未 join 即可编辑，D4 与 hasTopicAccess 语义一致）', async () => {
      mockParticipant(TopicParticipantRole.EDITOR, ParticipantStatus.INVITED);
      expect(await policy.can(editorActor, topic, 'write')).toBe(true);
      // 短路：editor 命中不触发 owner 代理查询
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('editor active 可写', async () => {
      mockParticipant(TopicParticipantRole.EDITOR, ParticipantStatus.ACTIVE);
      expect(await policy.can(editorActor, topic, 'write')).toBe(true);
    });

    it('editor left 不可写（LEFT 不算 editor，D4 状态门槛）', async () => {
      mockParticipant(TopicParticipantRole.EDITOR, ParticipantStatus.LEFT);
      expect(await policy.can(editorActor, topic, 'write')).toBe(false);
    });

    it('member active 不可写', async () => {
      mockParticipant(TopicParticipantRole.MEMBER, ParticipantStatus.ACTIVE);
      expect(await policy.can(editorActor, topic, 'write')).toBe(false);
    });

    it('无参与行 agent 不可写且不触发 owner 代理查询（agent 非候选）', async () => {
      expect(await policy.can(editorActor, topic, 'write')).toBe(false);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('editor 不可 delete（write/delete 拆分回归：放宽只及 write）', async () => {
      mockParticipant(TopicParticipantRole.EDITOR, ParticipantStatus.ACTIVE);
      expect(await policy.can(editorActor, topic, 'delete')).toBe(false);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('creator 可 delete（拆分后 delete 保持 creator-only）', async () => {
      expect(
        await policy.can(makeActor({ id: 'creator-1', type: ActorType.HUMAN }), topic, 'delete'),
      ).toBe(true);
    });
  });

  describe('owner proxy (v1.37: human owner of creator agent acts as creator)', () => {
    const agentTopic = makeTopic({
      creatorId: 'agent-1',
      creatorType: ActorType.AGENT,
      settings: { visibility: Visibility.PRIVATE },
    });
    const ownerActor = makeActor({ id: 'human-owner-1', type: ActorType.HUMAN });

    it('owner human can read agent-created private topic', async () => {
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentTopic, 'read')).toBe(true);
      expect(ownerProxy.isOwnerProxy).toHaveBeenCalledWith('agent-1', ownerActor);
    });

    it('owner human can write agent-created topic', async () => {
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentTopic, 'write')).toBe(true);
    });

    it('owner human can delete agent-created topic', async () => {
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentTopic, 'delete')).toBe(true);
    });

    it('owner human can join agent-created private topic (owner is not a participant)', async () => {
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      expect(await policy.can(ownerActor, agentTopic, 'join')).toBe(true);
    });

    it('non-owner human cannot read agent-created private topic', async () => {
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      expect(
        await policy.can(
          makeActor({ id: 'stranger-human', type: ActorType.HUMAN }),
          agentTopic,
          'read',
        ),
      ).toBe(false);
    });

    it('non-owner human cannot write agent-created topic', async () => {
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      expect(
        await policy.can(
          makeActor({ id: 'stranger-human', type: ActorType.HUMAN }),
          agentTopic,
          'write',
        ),
      ).toBe(false);
    });

    it('agent actor never gets owner proxy (agent cannot own agent)', async () => {
      const agentActor = makeActor({ id: 'agent-2', type: ActorType.AGENT });
      expect(await policy.can(agentActor, agentTopic, 'read')).toBe(false);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });
  });

  describe('admin bypass', () => {
    const privateTopic = makeTopic({
      settings: { visibility: Visibility.PRIVATE },
    });

    it('admin can read private topic', async () => {
      expect(await policy.can(makeActor({ role: UserRole.ADMIN }), privateTopic, 'read')).toBe(
        true,
      );
      // 短路：admin bypass 不触发 owner 代理查询
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('admin can join private topic', async () => {
      expect(await policy.can(makeActor({ role: UserRole.ADMIN }), privateTopic, 'join')).toBe(
        true,
      );
    });

    it('admin can write any topic', async () => {
      expect(await policy.can(makeActor({ role: UserRole.ADMIN }), privateTopic, 'write')).toBe(
        true,
      );
    });
  });
});

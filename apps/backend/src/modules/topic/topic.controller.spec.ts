import { Test, TestingModule } from '@nestjs/testing';
import { TopicController } from './topic.controller';
import { TopicService } from './topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { TopicStatus, ActorType, UserRole } from '@agent-chamber/shared';

describe('TopicController', () => {
  let controller: TopicController;
  let service: typeof mockService;
  let permService: typeof mockPermService;

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const mockAgentActor = { id: 'agent-1', type: ActorType.AGENT };

  const mockService = {
    findAll: jest.fn(),
    findById: jest.fn(),
    findOneWithParticipants: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    changeStatus: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    getMessages: jest.fn(),
    sendMessage: jest.fn(),
    getUnread: jest.fn(),
    markAsRead: jest.fn(),
    updateAgenda: jest.fn(),
    hasTopicAccess: jest.fn(),
    isActiveParticipant: jest.fn(),
    removeParticipant: jest.fn(),
    inviteAgent: jest.fn(),
    uninviteAgent: jest.fn(),
    uninviteUser: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TopicController],
      providers: [
        { provide: TopicService, useValue: mockService },
        { provide: PermissionService, useValue: mockPermService },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TopicController>(TopicController);
    service = module.get<TopicService>(TopicService) as unknown as typeof mockService;
    permService = module.get<PermissionService>(
      PermissionService,
    ) as unknown as typeof mockPermService;
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('should call service.findAll with query and actor', async () => {
      const result = {
        items: [{ id: 'topic-1' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      };
      service.findAll.mockResolvedValue(result);

      const response = await controller.findAll({ page: 1 }, mockActor);
      expect(response).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith({ page: 1 }, mockActor);
    });
  });

  describe('create', () => {
    it('should call service.create with actor id and type', async () => {
      const dto = { title: 'New Topic', type: 'discussion' };
      const result = { id: 'topic-1', title: 'New Topic' };
      service.create.mockResolvedValue(result);

      expect(await controller.create(mockActor, dto)).toBe(result);
      expect(service.create).toHaveBeenCalledWith(mockActor.id, mockActor.type, dto);
    });
  });

  describe('findOne', () => {
    it('should ensure read permission with hasAccess context and return topic with participants', async () => {
      const topic = { id: 'topic-1', title: 'Test Topic' };
      const result = { id: 'topic-1', title: 'Test Topic', participants: [] };
      service.findById.mockResolvedValue(topic);
      service.hasTopicAccess.mockResolvedValue(true);
      service.findOneWithParticipants.mockResolvedValue(result);

      expect(await controller.findOne('topic-1', mockActor)).toBe(result);
      expect(service.findById).toHaveBeenCalledWith('topic-1');
      // 守卫：PRIVATE 话题参与者必须经 hasAccess 注入获得读权限（生产 404 回归）
      expect(service.hasTopicAccess).toHaveBeenCalledWith('topic-1', mockActor.id);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'read', {
        hasAccess: true,
      });
      expect(service.findOneWithParticipants).toHaveBeenCalledWith('topic-1');
    });
  });

  describe('update', () => {
    it('should ensure write permission then update', async () => {
      const topic = { id: 'topic-1' };
      const dto = { title: 'Updated Topic' };
      const result = { id: 'topic-1', title: 'Updated Topic' };
      service.findById.mockResolvedValue(topic);
      service.update.mockResolvedValue(result);

      expect(await controller.update('topic-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.update).toHaveBeenCalledWith('topic-1', dto);
    });
  });

  describe('remove', () => {
    it('should ensure delete permission then remove', async () => {
      const topic = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.remove.mockResolvedValue(true);

      expect(await controller.remove('topic-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'delete');
      expect(service.remove).toHaveBeenCalledWith('topic-1');
    });
  });

  describe('close', () => {
    it('should ensure write permission then change status to CLOSED', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.CLOSED };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.close('topic-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.CLOSED);
    });
  });

  describe('pause', () => {
    it('should ensure write permission then change status to PAUSED', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.PAUSED };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.pause('topic-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.PAUSED);
    });
  });

  describe('resume', () => {
    it('should ensure write permission then change status to ACTIVE', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.ACTIVE };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.resume('topic-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.ACTIVE);
    });
  });

  describe('archive', () => {
    it('should ensure write permission then change status to ARCHIVED', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.ARCHIVED };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.archive('topic-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.ARCHIVED);
    });
  });

  describe('join', () => {
    it('should ensure join permission with hasAccess context then join', async () => {
      const topic = { id: 'topic-1' };
      const result = { topicId: 'topic-1', participantId: 'user-1', joinedAt: new Date() };
      service.findById.mockResolvedValue(topic);
      service.isActiveParticipant.mockResolvedValue(false);
      service.hasTopicAccess.mockResolvedValue(true);
      service.join.mockResolvedValue(result);

      expect(await controller.join('topic-1', mockActor)).toBe(result);
      expect(service.isActiveParticipant).toHaveBeenCalledWith('topic-1', mockActor.id);
      // 守卫：PRIVATE 话题被邀请者（invited 未 active）必须经 hasAccess 注入才能 join
      expect(service.hasTopicAccess).toHaveBeenCalledWith('topic-1', mockActor.id);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'join', {
        hasAccess: true,
      });
      expect(service.join).toHaveBeenCalledWith('topic-1', mockActor.id, mockActor.type);
    });

    it('should skip join if already an active participant', async () => {
      const topic = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.isActiveParticipant.mockResolvedValue(true);

      const result = await controller.join('topic-1', mockActor);
      expect((result as { success: boolean }).success).toBe(true);
      expect(service.isActiveParticipant).toHaveBeenCalledWith('topic-1', mockActor.id);
      expect(permService.ensureCan).not.toHaveBeenCalled();
      expect(service.join).not.toHaveBeenCalled();
    });
  });

  describe('leave', () => {
    it('should call service.leave with actor info', async () => {
      const result = { topicId: 'topic-1', participantId: 'user-1', leftAt: new Date() };
      service.leave.mockResolvedValue(result);

      expect(await controller.leave('topic-1', mockActor)).toBe(result);
      expect(service.leave).toHaveBeenCalledWith('topic-1', mockActor.id, mockActor.type);
    });
  });

  describe('removeParticipant', () => {
    it('should ensure write permission then remove participant', async () => {
      const topic = { id: 'topic-1' };
      const result = { topicId: 'topic-1', participantId: 'agent-1', leftAt: new Date() };
      service.findById.mockResolvedValue(topic);
      service.removeParticipant.mockResolvedValue(result);

      expect(
        await controller.removeParticipant('topic-1', mockActor, {
          participantId: 'agent-1',
        }),
      ).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.removeParticipant).toHaveBeenCalledWith('topic-1', mockActor.id, 'agent-1');
    });
  });

  describe('getMessages', () => {
    it('should ensure read permission then get messages', async () => {
      const topic = { id: 'topic-1' };
      const result = { messages: [], nextCursor: null, hasMore: false };
      service.findById.mockResolvedValue(topic);
      service.hasTopicAccess.mockResolvedValue(false);
      service.getMessages.mockResolvedValue(result);

      expect(await controller.getMessages('topic-1', { limit: 20 }, mockActor)).toBe(result);
      expect(service.hasTopicAccess).toHaveBeenCalledWith('topic-1', mockActor.id);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'read', {
        hasAccess: false,
      });
      expect(service.getMessages).toHaveBeenCalledWith('topic-1', { limit: 20 });
    });
  });

  describe('sendMessage', () => {
    it('should ensure read permission then send message', async () => {
      const topic = { id: 'topic-1' };
      const dto = { content: 'Hello' };
      const result = { id: 'msg-1', content: 'Hello' };
      service.findById.mockResolvedValue(topic);
      service.hasTopicAccess.mockResolvedValue(false);
      service.sendMessage.mockResolvedValue(result);

      expect(await controller.sendMessage('topic-1', mockActor, dto)).toBe(result);
      expect(service.hasTopicAccess).toHaveBeenCalledWith('topic-1', mockActor.id);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'read', {
        hasAccess: false,
      });
      expect(service.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        mockActor.id,
        mockActor.type,
        dto,
        mockActor.role,
      );
    });
  });

  describe('getUnread', () => {
    it('should ensure read permission with hasAccess context then get unread count', async () => {
      const topic = { id: 'topic-1' };
      const result = { topicId: 'topic-1', unreadCount: 5, messages: [], hasMore: false };
      service.findById.mockResolvedValue(topic);
      service.hasTopicAccess.mockResolvedValue(true);
      service.getUnread.mockResolvedValue(result);

      expect(await controller.getUnread('topic-1', {}, mockActor)).toBe(result);
      expect(service.hasTopicAccess).toHaveBeenCalledWith('topic-1', mockActor.id);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'read', {
        hasAccess: true,
      });
      expect(service.getUnread).toHaveBeenCalledWith(
        'topic-1',
        {},
        mockActor.id,
        mockActor.type,
      );
    });
  });

  describe('markAsRead', () => {
    it('should ensure read permission with hasAccess context then mark as read', async () => {
      const topic = { id: 'topic-1' };
      const dto = { messageId: 'msg-1' };
      const result = { topicId: 'topic-1', lastReadMessageId: 'msg-1', advanced: true };
      service.findById.mockResolvedValue(topic);
      service.hasTopicAccess.mockResolvedValue(true);
      service.markAsRead.mockResolvedValue(result);

      expect(await controller.markAsRead('topic-1', mockActor, dto)).toBe(result);
      expect(service.hasTopicAccess).toHaveBeenCalledWith('topic-1', mockActor.id);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'read', {
        hasAccess: true,
      });
      expect(service.markAsRead).toHaveBeenCalledWith('topic-1', mockActor.id, mockActor.type, dto);
    });
  });

  describe('updateAgenda', () => {
    it('should ensure write permission then update agenda', async () => {
      const topic = { id: 'topic-1' };
      const dto = { agenda: [{ title: 'Test', status: 'pending' as const, order: 1 }] };
      const result = { id: 'topic-1', agenda: dto.agenda };
      service.findById.mockResolvedValue(topic);
      service.updateAgenda.mockResolvedValue(result);

      expect(await controller.updateAgenda('topic-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.updateAgenda).toHaveBeenCalledWith('topic-1', dto);
    });
  });

  describe('inviteAgent', () => {
    it('should ensure write permission then invite agent', async () => {
      const topic = { id: 'topic-1' };
      const dto = { agentId: 'agent-1' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.inviteAgent.mockResolvedValue(result);

      expect(await controller.inviteAgent('topic-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.inviteAgent).toHaveBeenCalledWith('topic-1', 'agent-1');
    });
  });

  describe('uninviteAgent', () => {
    it('should ensure write permission then uninvite agent', async () => {
      const topic = { id: 'topic-1' };
      const dto = { agentId: 'agent-1' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.uninviteAgent.mockResolvedValue(result);

      expect(await controller.uninviteAgent('topic-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.uninviteAgent).toHaveBeenCalledWith('topic-1', 'agent-1');
    });
  });

  describe('inviteUser', () => {
    it('should ensure write permission then join user as human participant', async () => {
      const topic = { id: 'topic-1' };
      const dto = { userId: 'user-2' };
      const result = { topicId: 'topic-1', participantId: 'user-2', joinedAt: new Date() };
      service.findById.mockResolvedValue(topic);
      service.join.mockResolvedValue(result);

      expect(await controller.inviteUser('topic-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.join).toHaveBeenCalledWith('topic-1', 'user-2', ActorType.HUMAN);
    });
  });

  describe('uninviteUser', () => {
    it('should ensure write permission then uninvite user from participants', async () => {
      const topic = { id: 'topic-1' };
      const dto = { userId: 'user-2' };
      const result = { topicId: 'topic-1', participantId: 'user-2', leftAt: new Date() };
      service.findById.mockResolvedValue(topic);
      service.uninviteUser.mockResolvedValue(result);

      expect(await controller.uninviteUser('topic-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, mockActor, 'write');
      expect(service.uninviteUser).toHaveBeenCalledWith('topic-1', 'user-2');
    });
  });
});

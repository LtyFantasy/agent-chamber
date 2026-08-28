import { Test, TestingModule } from '@nestjs/testing';
import { TopicController } from './topic.controller';
import { TopicService } from './topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import {
  TopicStatus,
  ActorType,
  UserRole,
  ErrorCode,
  Visibility,
  AuditAction,
} from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';

describe('TopicController', () => {
  let controller: TopicController;
  let service: typeof mockService;
  let permService: typeof mockPermService;
  let ownerProxy: { isOwnerProxy: jest.Mock };
  let auditService: { log: jest.Mock };

  // admin（全局 bypass，沿用历史 mockActor 语义）
  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  // 非 creator 非 admin（editor 参与方身份由 policy/ownerProxy mock 模拟——controller
  // 层只测 ensureCreatorOrAdmin 收口：非 creator 级 → 403）
  const editorActor = { id: 'editor-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
  // 非 admin 的创建者（R4 语义：creator 判定必须用非 admin 身份验证，防 admin bypass 污染）
  const creatorActor = { id: 'creator-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
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
    addEditor: jest.fn(),
    removeEditor: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
  };

  const mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TopicController],
      providers: [
        { provide: TopicService, useValue: mockService },
        { provide: PermissionService, useValue: mockPermService },
        {
          provide: OwnerProxyService,
          useValue: { isOwnerProxy: jest.fn().mockResolvedValue(false) },
        },
        { provide: AuditService, useValue: mockAuditService },
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
    ownerProxy = module.get<OwnerProxyService>(OwnerProxyService) as unknown as {
      isOwnerProxy: jest.Mock;
    };
    auditService = module.get<AuditService>(AuditService) as unknown as { log: jest.Mock };
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
      // 审计（Phase 2）：UPDATE + topic；newData 白名单（title 变更）
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.UPDATE,
        entityType: 'topic',
        entityId: 'topic-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', title: 'Updated Topic' },
        source: 'api',
      });
    });

    // ─── 字段级分权（D3，v1.46 TOPIC-PERM：内容字段 policy write / 结构字段 creator-only）───

    it('editor 纯内容字段（title/description）→ 放行（policy write）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      const dto = { description: 'Updated' };
      const result = { id: 'topic-1', description: 'Updated' };
      service.findById.mockResolvedValue(topic);
      service.update.mockResolvedValue(result);

      expect(await controller.update('topic-1', dto, editorActor)).toBe(result);
      // 内容路径直接走 policy write（不自造 isCreatorOrEditor 判断）
      expect(permService.ensureCan).toHaveBeenCalledWith(topic, editorActor, 'write');
      expect(service.update).toHaveBeenCalledWith('topic-1', dto);
    });

    it('editor + visibility → 403，消息列出结构字段名（整体拒绝，无部分应用）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(topic);

      await expect(
        controller.update('topic-1', { visibility: Visibility.PRIVATE }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: ErrorCode.PERMISSION_DENIED,
            message: expect.stringContaining('visibility'),
          }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('editor + status: null 显式值也算结构字段出现（`!== undefined` 探测，truthy 判断是 bug）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(topic);

      await expect(
        controller.update('topic-1', { status: null as never }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: ErrorCode.PERMISSION_DENIED,
            message: expect.stringContaining('status'),
          }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('editor + 多结构字段 → 403 消息列出全部出现字段（R1 自修正能力）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(topic);

      await expect(
        controller.update(
          'topic-1',
          { visibility: Visibility.PRIVATE, invitedAgentIds: [] },
          editorActor,
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            message: expect.stringContaining('visibility'),
          }),
        }),
      );
      await expect(
        controller.update(
          'topic-1',
          { visibility: Visibility.PRIVATE, invitedAgentIds: [] },
          editorActor,
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            message: expect.stringContaining('invitedAgentIds'),
          }),
        }),
      );
    });

    it('creator（非 admin）全字段可更新（结构字段也放行）', async () => {
      const topic = { id: 'topic-1', creatorId: 'creator-1' };
      const dto = { title: 'Updated', visibility: Visibility.PRIVATE };
      const result = { id: 'topic-1', title: 'Updated' };
      service.findById.mockResolvedValue(topic);
      service.update.mockResolvedValue(result);

      expect(await controller.update('topic-1', dto, creatorActor)).toBe(result);
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
      // 审计（Phase 2）：DELETE + topic；newData {topicId, title}
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.DELETE,
        entityType: 'topic',
        entityId: 'topic-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', title: undefined },
        source: 'api',
      });
    });
  });

  describe('close', () => {
    it('admin 可 close（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.CLOSED };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.close('topic-1', mockActor)).toBe(result);
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.CLOSED);
      // 审计（Phase 2）：close 无专门枚举 → UPDATE + topic
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.UPDATE,
        entityType: 'topic',
        entityId: 'topic-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', status: TopicStatus.CLOSED },
        source: 'api',
      });
    });

    it('editor（非 creator 非 admin）close → 403（结构端点收口代表用例）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(topic);

      await expect(controller.close('topic-1', editorActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.changeStatus).not.toHaveBeenCalled();
    });
  });

  describe('pause', () => {
    it('admin 可 pause（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.PAUSED };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.pause('topic-1', mockActor)).toBe(result);
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.PAUSED);
      // 审计（Phase 2）：PAUSE_TOPIC 专用枚举
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.PAUSE_TOPIC,
        entityType: 'topic',
        entityId: 'topic-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', status: TopicStatus.PAUSED },
        source: 'api',
      });
    });
  });

  describe('resume', () => {
    it('admin 可 resume（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.ACTIVE };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.resume('topic-1', mockActor)).toBe(result);
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.ACTIVE);
      // 审计（Phase 2）：RESUME_TOPIC 专用枚举
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.RESUME_TOPIC,
        entityType: 'topic',
        entityId: 'topic-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', status: TopicStatus.ACTIVE },
        source: 'api',
      });
    });
  });

  describe('archive', () => {
    it('admin 可 archive（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const result = { id: 'topic-1', status: TopicStatus.ARCHIVED };
      service.findById.mockResolvedValue(topic);
      service.changeStatus.mockResolvedValue(result);

      expect(await controller.archive('topic-1', mockActor)).toBe(result);
      expect(service.changeStatus).toHaveBeenCalledWith('topic-1', TopicStatus.ARCHIVED);
      // 审计（Phase 2）：archive 无专门枚举 → UPDATE + topic
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.UPDATE,
        entityType: 'topic',
        entityId: 'topic-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', status: TopicStatus.ARCHIVED },
        source: 'api',
      });
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
      // 审计（Phase 2）：leave → DELETE + topic_participant；actor=自己
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.DELETE,
        entityType: 'topic_participant',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', participantId: 'user-1' },
        source: 'api',
      });
    });
  });

  describe('removeParticipant', () => {
    it('admin 可移除参与者（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const result = { topicId: 'topic-1', participantId: 'agent-1', leftAt: new Date() };
      service.findById.mockResolvedValue(topic);
      service.removeParticipant.mockResolvedValue(result);

      expect(
        await controller.removeParticipant('topic-1', mockActor, {
          participantId: 'agent-1',
        }),
      ).toBe(result);
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
      expect(service.getUnread).toHaveBeenCalledWith('topic-1', {}, mockActor.id, mockActor.type);
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
    it('admin 可更新 agenda（D2 ensureCreatorOrAdmin bypass；agenda 归结构字段）', async () => {
      const topic = { id: 'topic-1' };
      const dto = { agenda: [{ title: 'Test', status: 'pending' as const, order: 1 }] };
      const result = { id: 'topic-1', agenda: dto.agenda };
      service.findById.mockResolvedValue(topic);
      service.updateAgenda.mockResolvedValue(result);

      expect(await controller.updateAgenda('topic-1', dto, mockActor)).toBe(result);
      expect(service.updateAgenda).toHaveBeenCalledWith('topic-1', dto);
      // 审计（Phase 2）：UPDATE + topic；agenda 不入白名单 → 只记 {topicId, title}
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.UPDATE,
        entityType: 'topic',
        entityId: 'topic-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', title: undefined },
        source: 'api',
      });
    });
  });

  describe('inviteAgent', () => {
    it('admin 可邀请 agent（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const dto = { agentId: 'agent-1' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.inviteAgent.mockResolvedValue(result);

      expect(await controller.inviteAgent('topic-1', dto, mockActor)).toBe(result);
      expect(service.inviteAgent).toHaveBeenCalledWith('topic-1', 'agent-1');
      // 审计（Phase 2）：invite-agent → CREATE + topic_participant；actor=操作者
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.CREATE,
        entityType: 'topic_participant',
        entityId: 'agent-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', participantId: 'agent-1' },
        source: 'api',
      });
    });

    it('editor（非 creator 非 admin）invite-agent → 403（成员管理收口代表用例）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(topic);

      await expect(
        controller.inviteAgent('topic-1', { agentId: 'agent-1' }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.inviteAgent).not.toHaveBeenCalled();
    });

    it('creator（非 admin）可邀请 agent（owner 代理同规）', async () => {
      const topic = { id: 'topic-1', creatorId: 'creator-1' };
      const dto = { agentId: 'agent-1' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.inviteAgent.mockResolvedValue(result);

      expect(await controller.inviteAgent('topic-1', dto, creatorActor)).toBe(result);
      expect(service.inviteAgent).toHaveBeenCalledWith('topic-1', 'agent-1');
    });
  });

  describe('uninviteAgent', () => {
    it('admin 可取消邀请（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const dto = { agentId: 'agent-1' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.uninviteAgent.mockResolvedValue(result);

      expect(await controller.uninviteAgent('topic-1', dto, mockActor)).toBe(result);
      expect(service.uninviteAgent).toHaveBeenCalledWith('topic-1', 'agent-1');
      // 审计（Phase 2）：uninvite-agent → DELETE + topic_participant
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.DELETE,
        entityType: 'topic_participant',
        entityId: 'agent-1',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', participantId: 'agent-1' },
        source: 'api',
      });
    });
  });

  describe('inviteUser', () => {
    it('admin 可邀请人类用户（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const dto = { userId: 'user-2' };
      const result = { topicId: 'topic-1', participantId: 'user-2', joinedAt: new Date() };
      service.findById.mockResolvedValue(topic);
      service.join.mockResolvedValue(result);

      expect(await controller.inviteUser('topic-1', dto, mockActor)).toBe(result);
      // 审计在 service join 层（决策 2）；invite-user 传 operatorActorId=操作者（决策 8）
      expect(service.join).toHaveBeenCalledWith('topic-1', 'user-2', ActorType.HUMAN, 'user-1');
    });
  });

  describe('uninviteUser', () => {
    it('admin 可移除人类用户（D2 ensureCreatorOrAdmin bypass）', async () => {
      const topic = { id: 'topic-1' };
      const dto = { userId: 'user-2' };
      const result = { topicId: 'topic-1', participantId: 'user-2', leftAt: new Date() };
      service.findById.mockResolvedValue(topic);
      service.uninviteUser.mockResolvedValue(result);

      expect(await controller.uninviteUser('topic-1', dto, mockActor)).toBe(result);
      expect(service.uninviteUser).toHaveBeenCalledWith('topic-1', 'user-2');
      // 审计（Phase 2）：uninvite-user → DELETE + topic_participant
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.DELETE,
        entityType: 'topic_participant',
        entityId: 'user-2',
        actorId: 'user-1',
        newData: { topicId: 'topic-1', participantId: 'user-2' },
        source: 'api',
      });
    });
  });

  // ─── add-editor / remove-editor（v1.46 TOPIC-PERM：creator/admin-only） ───

  describe('addEditor', () => {
    it('creator（非 admin）可提升 editor', async () => {
      const topic = { id: 'topic-1', creatorId: 'creator-1' };
      const dto = { agentId: 'agent-2' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.addEditor.mockResolvedValue(result);

      expect(await controller.addEditor('topic-1', dto, creatorActor)).toBe(result);
      expect(service.addEditor).toHaveBeenCalledWith('topic-1', 'agent-2');
      // 审计（Phase 2）：add-editor → CREATE + topic_participant（与 invite 同族）
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.CREATE,
        entityType: 'topic_participant',
        entityId: 'agent-2',
        actorId: 'creator-1',
        newData: { topicId: 'topic-1', participantId: 'agent-2' },
        source: 'api',
      });
    });

    it('admin bypass：admin 可提升 editor', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      const dto = { agentId: 'agent-2' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.addEditor.mockResolvedValue(result);

      expect(await controller.addEditor('topic-1', dto, mockActor)).toBe(result);
      expect(service.addEditor).toHaveBeenCalledWith('topic-1', 'agent-2');
    });

    it('editor（非 creator 非 admin）→ 403（成员管理收口）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(topic);

      await expect(
        controller.addEditor('topic-1', { agentId: 'agent-2' }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.addEditor).not.toHaveBeenCalled();
    });
  });

  describe('removeEditor', () => {
    it('creator（非 admin）可撤销 editor', async () => {
      const topic = { id: 'topic-1', creatorId: 'creator-1' };
      const dto = { agentId: 'agent-2' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.removeEditor.mockResolvedValue(result);

      expect(await controller.removeEditor('topic-1', dto, creatorActor)).toBe(result);
      expect(service.removeEditor).toHaveBeenCalledWith('topic-1', 'agent-2');
      // 审计（Phase 2）：remove-editor → DELETE + topic_participant（与 uninvite 同族）
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.DELETE,
        entityType: 'topic_participant',
        entityId: 'agent-2',
        actorId: 'creator-1',
        newData: { topicId: 'topic-1', participantId: 'agent-2' },
        source: 'api',
      });
    });

    it('admin bypass：admin 可撤销 editor', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      const dto = { agentId: 'agent-2' };
      const result = { id: 'topic-1' };
      service.findById.mockResolvedValue(topic);
      service.removeEditor.mockResolvedValue(result);

      expect(await controller.removeEditor('topic-1', dto, mockActor)).toBe(result);
      expect(service.removeEditor).toHaveBeenCalledWith('topic-1', 'agent-2');
    });

    it('editor（非 creator 非 admin）→ 403（成员管理收口）', async () => {
      const topic = { id: 'topic-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(topic);

      await expect(
        controller.removeEditor('topic-1', { agentId: 'agent-2' }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.removeEditor).not.toHaveBeenCalled();
    });
  });
});

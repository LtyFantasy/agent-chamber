/**
 * AttachmentAccessService 授权矩阵单测（plan §3.2）
 *
 * 核心不变量：
 * 1. 复用真实 Policy 判定（PermissionService.can）——本服务只做资源定位与组装，
 *    不得自行按矩阵字面重写（mock 的 can 返回值即"Policy 已判定"）；
 * 2. 任何"无权"一律 404 ATTACHMENT_NOT_FOUND（不泄露存在性）；
 * 3. topic/doc 绑定走 withDeleted 直查（软删语义 = Policy 判定自然生效）；
 * 4. 无绑定态仅上传者/admin。
 */
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';
import { AttachmentAccessService } from './attachment-access.service';
import { Attachment } from '../../database/entities/attachment.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { TopicService } from '../topic/topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { UnifiedActor } from '../../common/types/actor.types';

/** 构造最小附件行（只需绑定列与 uploaderId 参与判定） */
function makeAttachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'att-1',
    uploaderId: 'uploader-1',
    topicId: null,
    docId: null,
    ...overrides,
  } as Attachment;
}

const outsider: UnifiedActor = { id: 'outsider-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
const admin: UnifiedActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };

describe('AttachmentAccessService', () => {
  let service: AttachmentAccessService;
  let topicRepo: { findOne: jest.Mock };
  let docRepo: { findOne: jest.Mock };
  let spaceRepo: { findOne: jest.Mock };
  let topicService: { hasTopicAccess: jest.Mock };
  let permService: { can: jest.Mock };

  beforeEach(async () => {
    topicRepo = { findOne: jest.fn() };
    docRepo = { findOne: jest.fn() };
    spaceRepo = { findOne: jest.fn() };
    topicService = { hasTopicAccess: jest.fn() };
    permService = { can: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentAccessService,
        { provide: getRepositoryToken(Topic), useValue: topicRepo },
        { provide: getRepositoryToken(Doc), useValue: docRepo },
        { provide: getRepositoryToken(DocSpace), useValue: spaceRepo },
        { provide: TopicService, useValue: topicService },
        { provide: PermissionService, useValue: permService },
      ],
    }).compile();

    service = module.get(AttachmentAccessService);
  });

  /** 404 且业务码 12000（错误码语义 = 不泄露存在性） */
  async function expectNotFound(p: Promise<unknown>): Promise<void> {
    await expect(p).rejects.toBeInstanceOf(NotFoundException);
    await expect(p).rejects.toMatchObject({ response: { code: ErrorCode.ATTACHMENT_NOT_FOUND } });
  }

  describe('topic 绑定', () => {
    const att = makeAttachment({ topicId: 'topic-1' });
    const topic = { id: 'topic-1', creatorId: 'creator-1', settings: {}, status: 'active' };

    it('Policy 放行（OPEN 局外人可读）→ 通过', async () => {
      topicRepo.findOne.mockResolvedValue(topic);
      topicService.hasTopicAccess.mockResolvedValue(false);
      permService.can.mockResolvedValue(true);
      await expect(service.assertCanRead(att, outsider)).resolves.toBeUndefined();
    });

    it('Policy 拒绝（PRIVATE 局外人）→ 404(12000)', async () => {
      topicRepo.findOne.mockResolvedValue(topic);
      topicService.hasTopicAccess.mockResolvedValue(false);
      permService.can.mockResolvedValue(false);
      await expectNotFound(service.assertCanRead(att, outsider));
    });

    it('hasTopicAccess 预查结果原样注入 Policy context（镜像 getMessages 组装）', async () => {
      topicRepo.findOne.mockResolvedValue(topic);
      topicService.hasTopicAccess.mockResolvedValue(true);
      permService.can.mockResolvedValue(true);
      await service.assertCanRead(att, outsider);
      expect(topicService.hasTopicAccess).toHaveBeenCalledWith('topic-1', outsider.id);
      expect(permService.can).toHaveBeenCalledWith(topic, outsider, 'read', { hasAccess: true });
    });

    it('topic 行直查带 withDeleted（软删语义 = Policy 判定自然生效）', async () => {
      topicRepo.findOne.mockResolvedValue(topic);
      topicService.hasTopicAccess.mockResolvedValue(false);
      permService.can.mockResolvedValue(true);
      await service.assertCanRead(att, outsider);
      expect(topicRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'topic-1' },
        withDeleted: true,
      });
    });

    it('topic 行不存在（硬删竞态）→ 404(12000)', async () => {
      topicRepo.findOne.mockResolvedValue(null);
      await expectNotFound(service.assertCanRead(att, outsider));
      expect(permService.can).not.toHaveBeenCalled();
    });
  });

  describe('doc 绑定', () => {
    const att = makeAttachment({ docId: 'doc-1' });
    const doc = { id: 'doc-1', spaceId: 'space-1' };
    const space = { id: 'space-1', slug: 's', docCount: 1, settings: {}, creatorId: 'c-1' };

    it('Policy 放行（space 成员）→ 通过', async () => {
      docRepo.findOne.mockResolvedValue(doc);
      spaceRepo.findOne.mockResolvedValue(space);
      permService.can.mockResolvedValue(true);
      await expect(service.assertCanRead(att, outsider)).resolves.toBeUndefined();
      expect(permService.can).toHaveBeenCalledWith(space, outsider, 'read');
    });

    it('Policy 拒绝 → 404(12000)', async () => {
      docRepo.findOne.mockResolvedValue(doc);
      spaceRepo.findOne.mockResolvedValue(space);
      permService.can.mockResolvedValue(false);
      await expectNotFound(service.assertCanRead(att, outsider));
    });

    it('doc/space 行不存在（硬删竞态）→ 404(12000)，且不触发 Policy', async () => {
      docRepo.findOne.mockResolvedValue(null);
      await expectNotFound(service.assertCanRead(att, outsider));

      docRepo.findOne.mockResolvedValue(doc);
      spaceRepo.findOne.mockResolvedValue(null);
      await expectNotFound(service.assertCanRead(att, outsider));
      expect(permService.can).not.toHaveBeenCalled();
    });
  });

  describe('无绑定态（topicId/docId 双 NULL，FK SET NULL 产物）', () => {
    const att = makeAttachment({});

    it('上传者本人 → 通过', async () => {
      const uploader: UnifiedActor = { id: 'uploader-1', type: ActorType.AGENT };
      await expect(service.assertCanRead(att, uploader)).resolves.toBeUndefined();
    });

    it('admin → 通过', async () => {
      await expect(service.assertCanRead(att, admin)).resolves.toBeUndefined();
    });

    it('第三人（非上传者非 admin）→ 404(12000)', async () => {
      await expectNotFound(service.assertCanRead(att, outsider));
    });

    it('无绑定态不触碰任何资源 repo / Policy', async () => {
      const uploader: UnifiedActor = { id: 'uploader-1', type: ActorType.HUMAN };
      await service.assertCanRead(att, uploader);
      expect(topicRepo.findOne).not.toHaveBeenCalled();
      expect(docRepo.findOne).not.toHaveBeenCalled();
      expect(permService.can).not.toHaveBeenCalled();
    });
  });
});

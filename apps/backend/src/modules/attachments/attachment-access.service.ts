/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型) + §3.2 (Attachments 读取授权)
 *   - 补充: docs/api-definition.md §Attachments（404 一致性契约）
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #9(代理层透传) #17(测试契约) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 授权规则变化必须复用 Policy 判定，禁止在本文件按矩阵字面重写
 *   □ 404 一致性（存在但无权限一律 404）不得破坏
 * =============================================================================
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode, UserRole } from '@agent-chamber/shared';
import { Attachment } from '../../database/entities/attachment.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { TopicService } from '../topic/topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * 附件读取授权（plan §3.2）——复用真实 Policy，禁止按矩阵字面重写。
 *
 * 判定链：
 * - topicId 绑定：镜像 GET /topics/:id/messages read 路径
 *   （TopicService.hasTopicAccess 预查 → PermissionService.can(topic, actor, 'read', {hasAccess})
 *   → TopicPolicy read 分支含 OPEN/creator/participant/owner-proxy/admin）；
 * - docId 绑定：doc → 所属 space → PermissionService.can(space, actor, 'read')
 *   （DocSpacePolicy read 分支含 OPEN/creator/member/owner-proxy/admin；
 *   DocSpacePolicy 未被 DocSpaceModule 导出，必须走全局 PermissionService duck-typing，
 *   禁止直接 import DocSpacePolicy）；
 * - 无绑定态（topicId/docId 双 NULL，FK SET NULL 产物）：仅上传者本人/admin。
 *
 * 软删语义（plan §3.2 写明可接受）：topic/doc 软删但绑定列未被 FK 清 NULL 时，
 * 用 withDeleted 拿到行后 Policy 判定自然生效（行数据/settings 仍在）——
 * 语义 = 资源成员仍可读；硬删后 FK SET NULL 落入无绑定态 = 仅上传者/admin。
 *
 * 404 一致性：任何"存在但无权限"一律抛 ATTACHMENT_NOT_FOUND（不泄露存在性）。
 */
@Injectable()
export class AttachmentAccessService {
  constructor(
    @InjectRepository(Topic)
    private readonly topicRepo: Repository<Topic>,
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocSpace)
    private readonly spaceRepo: Repository<DocSpace>,
    private readonly topicService: TopicService,
    private readonly permService: PermissionService,
  ) {}

  /**
   * 断言 actor 可读该附件；无权一律 404（12000）。
   * 调用方（attachment.service）已先行确认附件行存在且未软删。
   */
  async assertCanRead(attachment: Attachment, actor: UnifiedActor): Promise<void> {
    let allowed: boolean;

    if (attachment.topicId !== null) {
      allowed = await this.canReadViaTopic(attachment.topicId, actor);
    } else if (attachment.docId !== null) {
      allowed = await this.canReadViaDoc(attachment.docId, actor);
    } else {
      // 无绑定态：仅上传者/admin（admin 判定与 Policy 的 UserRole.ADMIN bypass 同口径）
      allowed = attachment.uploaderId === actor.id || actor.role === UserRole.ADMIN;
    }

    if (!allowed) {
      throw new NotFoundException({
        message: 'Attachment not found',
        code: ErrorCode.ATTACHMENT_NOT_FOUND,
      });
    }
  }

  /**
   * topic 绑定读取：镜像 topic.controller.ts getMessages 的 ensureCan + hasAccess 组装。
   * topic 行不存在只可能生于竞态（硬删 FK SET NULL 后列已清）——按无权处理（404）。
   */
  private async canReadViaTopic(topicId: string, actor: UnifiedActor): Promise<boolean> {
    const topic = await this.topicRepo.findOne({ where: { id: topicId }, withDeleted: true });
    if (!topic) return false;
    const hasAccess = await this.topicService.hasTopicAccess(topicId, actor.id);
    return this.permService.can(topic, actor, 'read', { hasAccess });
  }

  /**
   * doc 绑定读取：doc → space → DocSpacePolicy read（经 PermissionService duck-typing）。
   * doc/space 行不存在同 topic 侧竞态——按无权处理（404）。
   */
  private async canReadViaDoc(docId: string, actor: UnifiedActor): Promise<boolean> {
    const doc = await this.docRepo.findOne({ where: { id: docId }, withDeleted: true });
    if (!doc) return false;
    const space = await this.spaceRepo.findOne({
      where: { id: doc.spaceId },
      withDeleted: true,
    });
    if (!space) return false;
    return this.permService.can(space, actor, 'read');
  }
}

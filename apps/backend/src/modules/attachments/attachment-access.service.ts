/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件的**读取/删除授权判定**（不含字节出口与过期判定）
 *
 * [代码职责]
 *   - `assertCanRead`：topic 绑定 / doc 绑定 / 无绑定态三条判据链，复用真实 Policy
 *   - 404 一致性（存在但无权限 = 不存在）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型) + §3.2 (Attachments 读取授权)
 *   - 补充: docs/api-definition.md §Attachments（404 一致性契约）
 *   - 补充: docs/api-definition.md §16a — topic 连带软删后的语义反转（m5）
 *
 * [铁律关联] #9(代理层透传) #17(测试契约) #18(不变量检查)
 *
 * [关键不变量]
 *   - 授权规则变化必须复用 Policy 判定（`PermissionService.can` duck-typing），
 *     **禁止在本文件按矩阵字面重写**；DocSpacePolicy 未被导出，不得直接 import。
 *   - **404 一致性**：任何"存在但无权限"一律 ATTACHMENT_NOT_FOUND（不泄露存在性），
 *     读取与删除两端同码。
 *   - 本文件**不做**过期判定（懒判在字节出口、授权之后，见 attachment.service）：
 *     元数据面必须继续 200 + expiresAt（墓碑卡片要数据，m3 反向约束）。
 *   - topic 绑定用 withDeleted 取行（软删话题的 settings 仍在）：这是"其它路径软删
 *     话题"的兜底；**平台删除入口**（TopicService.remove）已连带软删附件 → 404。
 *
 * [关联代码]
 *   - attachment.service.ts — findAccessible（唯一入口）/ 字节面懒判与就绪谓词
 *   - attachment-signed-url.service.ts — 铸造复用同一入口（铸造不得绕过授权）
 *   - topic.service.ts remove — 连带软删附件（m5 语义反转的施加点）
 *
 * [持久踩坑]
 *   - （无历史踩坑，新建文件）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
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
 * ⚠️ **行为变更（v1.90.0-dev 附件 TTL 批 m5，有意反转）**：`TopicService.remove()`
 * 现在会在同一事务里**连带软删**该 topic 的全部附件，故上述"topic 软删后成员仍可读"
 * 的路径在**平台删除入口**下不再可达（附件行已软删 → findOne 默认滤 → 404·12000）。
 * 本判定的 withDeleted 语义仍然保留：它兜底的是"topic 被**其它路径**软删（不经
 * remove()）"或 FK 清空前的竞态窗口，不是"删除话题后附件仍可读"的承诺。
 * doc 侧语义不变（doc 软删不连带附件；doc 绑定附件永久，见 api-definition §16a）。
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

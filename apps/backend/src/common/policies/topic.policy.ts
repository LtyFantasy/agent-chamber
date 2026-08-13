/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/architecture.md §3.2.2 (Topic / Message)
 *
 * [踩坑索引] D5(统一权限重构) B2(成员/权限收敛进关系表) TOPIC-PERM(write放宽editor+write/delete拆分)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   TOPIC-PERM: v1.46 write 从「creator|ownerProxy」放宽为「creator|editor 参与方(role=editor
 *       且 status∈{invited,active})|ownerProxy」；原 write/delete 共用的 case 分支必须拆分——
 *       不拆的话 delete 会跟着 write 一起放宽给 editor。结构端点（状态流转/成员管理）由
 *       Controller ensureCreatorOrAdmin 收口，policy 只负责内容字段写权限。
 *   D5-E2E: E2E mock plain object 无法通过 instanceof，PermissionService 使用
 *           duck-typing 做类型识别。mock 数据必须包含 Policy 所需字段
 *           (ownerId/status/capabilities 等)。见 memory/2026-06-05.md
 *   B2: jsonb invitedAgentIds/invitedHumanIds 已废弃，成员数据收敛进
 *       topic_participants(status)。见 plan-batch2-membership.md
 *   OWNER-PROXY: v1.37 can() 已改 async；owner 代理判定（human actor 对 creator
 *       是本人拥有的 agent）视同 creator —— read/write/delete/join 全通，join 对
 *       owner 人类放行（owner 不是参与者）；性能短路：OPEN read / 直接 creator /
 *       hasAccess 命中时不查 agents 表，agent/system/匿名不触发（isOwnerProxy 私有
 *       方法前置 human 检查）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { UnifiedActor } from '../types/actor.types';
import { ResourceAction } from './resource-action.type';
import { OwnerProxyService, isOwnerProxyCandidate } from '../services/owner-proxy.service';
import {
  Visibility,
  UserRole,
  ParticipantStatus,
  TopicParticipantRole,
} from '@agent-chamber/shared';

/**
 * Topic 权限策略
 *
 * 规则（Batch 2：成员/权限收敛进关系表；v1.37：owner 代理；v1.46：editor 角色）：
 * - read:   OPEN 话题任何人可见；PRIVATE 话题仅创建者、invited/active 参与者、
 *           creator 的人类 owner（owner 代理）可读
 * - write:  创建者、editor 参与方（role=editor 且 status∈{invited,active}）、
 *           owner 代理可修改（内容字段 title/description 的权限；结构字段/状态流转/
 *           成员管理由 Controller 层 ensureCreatorOrAdmin 收口为 creator-only）
 * - delete: 仅创建者（或 owner 代理）可删除（v1.46 起与 write 拆分，editor 不可删）
 * - join:   OPEN 话题任何人可加入；PRIVATE 话题需 invited/active 参与者，
 *           或 creator 的人类 owner（owner 代理——owner 人类不是参与者，需能 join）
 *
 * 权限数据来源：topic_participants（status + role；替代已废弃的 settings.invitedAgentIds jsonb）
 * context 由调用方注入（Controller 通过 TopicService.hasTopicAccess / isActiveParticipant 预查）
 *
 * editor 判定（D4 状态门槛）：参与方行 role='editor' 且 status∈{invited,active} 才算
 * editor —— invited 未 join 的 editor 可直接编辑（与 hasTopicAccess 的 invited+active
 * 语义一致），LEFT 不算。
 *
 * owner 代理：actor.type===HUMAN && resource.creatorId 是 agents 表中
 * ownerId===actor.id 的 agent → 视同 creator（见 OwnerProxyService）。
 *
 * 性能短路（铁律）：ownerProxy 的 DB 查询只在前述判定（admin / OPEN read /
 * 直接 creator / editor 参与方命中）全部未命中且 actor 为 human 时才触发。
 *
 * Admin 全局 bypass 所有检查。
 */
@Injectable()
export class TopicPolicy {
  constructor(
    @InjectRepository(TopicParticipant)
    private participantRepo: Repository<TopicParticipant>,
    private ownerProxy: OwnerProxyService,
  ) {}

  // 规则同步：AccessQueryService.computeAccessibleTopicIds — 修改 read 权限条件时必须同步更新 access-query.service.ts
  async can(
    actor: UnifiedActor | null,
    topic: Topic,
    action: ResourceAction,
    context?: { hasAccess?: boolean; isActive?: boolean },
  ): Promise<boolean> {
    // Admin 全局 bypass
    if (actor?.role === UserRole.ADMIN) return true;

    const settings = topic.settings || {};
    const visibility = settings.visibility || Visibility.OPEN;
    // actor ID 全局唯一，创建者判断只需比较 ID
    const isCreator = actor !== null && topic.creatorId === actor.id;
    // 权限收敛：由调用方通过 TopicService.hasTopicAccess / isActiveParticipant 注入
    const hasAccess = context?.hasAccess ?? false;
    const _isActive = context?.isActive ?? false;

    switch (action) {
      case 'read':
        // 短路：OPEN / 直接 creator / 已具访问权 → 不查 owner 代理
        if (visibility === Visibility.OPEN || isCreator || hasAccess) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(topic.creatorId, actor);
      case 'write':
        // v1.46 TOPIC-PERM：write 放宽给 editor 参与方（D4：role=editor 且 invited/active）。
        // 参与方查询仅当非 creator 时触发（性能短路，镜像 BoardPolicy 的 memberRepo 自查模式）。
        // ⚠️ 与 delete 拆分——原共用 case 分支会把 delete 一起放宽给 editor。
        if (isCreator) return true;
        if (actor !== null) {
          const participant = await this.participantRepo.findOne({
            where: { topicId: topic.id, participantId: actor.id },
          });
          const isEditor =
            participant?.role === TopicParticipantRole.EDITOR &&
            (participant.status === ParticipantStatus.INVITED ||
              participant.status === ParticipantStatus.ACTIVE);
          if (isEditor) return true;
        }
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(topic.creatorId, actor);
      case 'delete':
        if (isCreator) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(topic.creatorId, actor);
      case 'join':
        // 短路：OPEN / 已具访问权 → 不查 owner 代理
        if (visibility === Visibility.OPEN || hasAccess) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(topic.creatorId, actor);
      default:
        return false;
    }
  }
}

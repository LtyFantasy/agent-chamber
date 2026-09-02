/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/architecture.md §3.2 (DocSpace 模块), plan §1.8, plan §4.2
 *
 * [踩坑索引] (无历史踩坑，新建文件；v1.37 加 OWNER-PROXY 代理判定)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { UnifiedActor } from '../types/actor.types';
import { ResourceAction } from './resource-action.type';
import { OwnerProxyService, isOwnerProxyCandidate } from '../services/owner-proxy.service';
import { Visibility, UserRole, DocSpaceMemberRole } from '@agent-chamber/shared';

/**
 * DocSpace 权限策略（v1.37：owner 代理）
 *
 * 规则：
 * - DocSpace 权限完全自治，不继承 topic/board 权限
 * - effectiveVisibility()：返回 space 自身 visibility
 * - read:   OPEN 空间任何人可见；PRIVATE 空间仅 creator、doc_space_members 行存在
 *           或 creator 的人类 owner（owner 代理）可读
 * - write:  仅创建者（或 owner 代理）或 editor 角色可修改
 * - delete: 仅创建者（或 owner 代理）可删除
 *
 * owner 代理：actor.type===HUMAN && resource.creatorId 是 agents 表中
 * ownerId===actor.id 的 agent → 视同 creator（见 OwnerProxyService）。
 *
 * 性能短路（铁律）：owner 代理查询只在前述判定（admin / OPEN read /
 * 直接 creator / member 命中）全部未命中时触发。
 *
 * Admin 全局 bypass。
 */
@Injectable()
export class DocSpacePolicy {
  constructor(
    @InjectRepository(DocSpaceMember)
    private memberRepo: Repository<DocSpaceMember>,
    private ownerProxy: OwnerProxyService,
  ) {}

  /** 返回 space 自身 visibility */
  async effectiveVisibility(space: DocSpace): Promise<Visibility> {
    return (space.settings?.visibility || Visibility.OPEN) as Visibility;
  }

  // 规则同步：AccessQueryService.computeAccessibleDocSpaceIds — 修改 read 权限条件时必须同步更新 access-query.service.ts
  async can(actor: UnifiedActor | null, space: DocSpace, action: ResourceAction): Promise<boolean> {
    if (actor?.role === UserRole.ADMIN) return true;

    const visibility = await this.effectiveVisibility(space);
    // actor ID 全局唯一，创建者判断只需比较 ID
    const isCreator = actor !== null && space.creatorId === actor.id;

    // 检查 doc_space_members 行：行存在即有权限（read=任意 role，write=editor）
    let memberRole: string | null = null;
    if (actor !== null) {
      const member = await this.memberRepo.findOne({
        where: { spaceId: space.id, actorId: actor.id },
      });
      memberRole = member?.role ?? null;
    }
    const isMember = memberRole !== null;
    // doc_space_members.role 实体类型为 string，值域对齐 DocSpaceMemberRole 枚举
    // （review-0831 任务 a8a295df 建专属枚举，此前借用 BoardMemberRole 比较）
    const isEditor = memberRole === DocSpaceMemberRole.EDITOR;

    switch (action) {
      case 'read':
        // 短路：OPEN / 直接 creator / member 命中 → 不查 owner 代理
        if (visibility === Visibility.OPEN || isCreator || isMember) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(space.creatorId, actor);
      case 'write':
        if (isCreator || isEditor) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(space.creatorId, actor);
      case 'delete':
        if (isCreator) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(space.creatorId, actor);
      default:
        return false;
    }
  }
}

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/architecture.md §3.2.3 (Board / Task), PROJECT.md §1.3.2 可见性继承
 *
 * [踩坑索引] D5(统一权限重构) B2(成员/权限收敛进关系表)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   D5-E2E: E2E mock plain object 无法通过 instanceof，PermissionService 使用
 *           duck-typing 做类型识别。mock 数据必须包含 Policy 所需字段
 *           (ownerId/status/capabilities 等)。见 memory/2026-06-05.md
 *   B2: Batch 2 删除 topic 继承（P4）、删除 topicRepo/participantRepo 依赖、
 *       改为注入 BoardMember repo。board read = open | creator | board_members 行存在。
 *       settings.invitedAgentIds/editorIds jsonb 已废弃。
 *   OWNER-PROXY: v1.37 人类 owner 对其 agent 创建的 board 视同 creator
 *       （read/write/delete）。性能短路：owner 代理查询只在前述判定
 *       （admin/OPEN read/直接 creator/member 命中）全部未命中时触发。
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
import { Board } from '../../database/entities/board.entity';
import { BoardMember } from '../../database/entities/board-member.entity';
import { UnifiedActor } from '../types/actor.types';
import { ResourceAction } from './resource-action.type';
import { OwnerProxyService, isOwnerProxyCandidate } from '../services/owner-proxy.service';
import { Visibility, UserRole, BoardMemberRole } from '@agent-chamber/shared';

/**
 * Board 权限策略（Batch 2：Board 权限自治；v1.37：owner 代理）
 *
 * 规则：
 * - Board 权限完全自治，不再继承 Topic 可见性或参与者
 * - effectiveVisibility()：返回 board 自身 visibility（保留方法以稳调用方）
 * - read:   OPEN 看板任何人可见；PRIVATE 看板仅成员（creator / board_members 行存在）
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
export class BoardPolicy {
  constructor(
    @InjectRepository(BoardMember)
    private memberRepo: Repository<BoardMember>,
    private ownerProxy: OwnerProxyService,
  ) {}

  /** 返回 board 自身 visibility（Batch 2: 不再继承 topic visibility） */
  async effectiveVisibility(board: Board): Promise<Visibility> {
    return (board.settings?.visibility || Visibility.OPEN) as Visibility;
  }

  // 规则同步：AccessQueryService.computeAccessibleBoardIds — 修改 read 权限条件时必须同步更新 access-query.service.ts
  async can(actor: UnifiedActor | null, board: Board, action: ResourceAction): Promise<boolean> {
    if (actor?.role === UserRole.ADMIN) return true;

    const visibility = await this.effectiveVisibility(board);
    // actor ID 全局唯一，创建者判断只需比较 ID
    const isCreator = actor !== null && board.creatorId === actor.id;

    // 检查 board_members 行：行存在即有权限（read=任意 role，write=editor）
    let memberRole: string | null = null;
    if (actor !== null) {
      const member = await this.memberRepo.findOne({
        where: { boardId: board.id, actorId: actor.id },
      });
      memberRole = member?.role ?? null;
    }
    const isMember = memberRole !== null;
    // board_members.role 实体类型为 string，值域对齐 BoardMemberRole 枚举
    const isEditor = memberRole === BoardMemberRole.EDITOR;

    switch (action) {
      case 'read':
        // 短路：OPEN / 直接 creator / member 命中 → 不查 owner 代理
        if (visibility === Visibility.OPEN || isCreator || isMember) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(board.creatorId, actor);
      case 'write':
        if (isCreator || isEditor) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(board.creatorId, actor);
      case 'delete':
        if (isCreator) return true;
        if (!isOwnerProxyCandidate(actor)) return false;
        return this.ownerProxy.isOwnerProxy(board.creatorId, actor);
      default:
        return false;
    }
  }
}

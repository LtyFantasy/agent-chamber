/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/architecture.md §3.2.3 (Board / Task)
 *
 * [踩坑索引] D5(统一权限重构) B2(成员/权限收敛进关系表)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   D5-E2E: E2E mock plain object 无法通过 instanceof，PermissionService 使用
 *           duck-typing 做类型识别。mock 数据必须包含 Policy 所需字段
 *           (ownerId/status/capabilities 等)。见 memory/2026-06-05.md
 *   B2: write 不再读 list.board.settings.editorIds jsonb，改为委托
 *       boardPolicy.can(actor, list.board, 'write')（语义等价，editor 经 board_members 放行）。
 *   OWNER-PROXY: v1.37 人类 owner 对其 agent 创建的 board 下 task 视同
 *       board creator —— write 委托 BoardPolicy（内部已含 owner 代理判定，不重复查库），
 *       delete 分支的 isBoardCreator 直接经 ownerProxy 扩展。
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
import { Task } from '../../database/entities/task.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { UnifiedActor } from '../types/actor.types';
import { ResourceAction } from './resource-action.type';
import { BoardPolicy } from './board.policy';
import { OwnerProxyService, isOwnerProxyCandidate } from '../services/owner-proxy.service';
import { UserRole } from '@agent-chamber/shared';

/**
 * Task 权限策略（v1.37：owner 代理）
 *
 * 规则：
 * - Task 继承所属 Board 的可见性（read 权限委托给 BoardPolicy）
 * - write: 被分配者（assignee）或 Board write（creator/editor/owner 代理，经 board_members）
 * - delete: 被分配者或 Board 创建者（editor 不能删除他人任务；owner 代理视同创建者）
 * - orphan task（无 listId）视为公开
 *
 * Admin 全局 bypass。
 */
@Injectable()
export class TaskPolicy {
  constructor(
    @InjectRepository(BoardList)
    private listRepo: Repository<BoardList>,
    private boardPolicy: BoardPolicy,
    private ownerProxy: OwnerProxyService,
  ) {}

  async can(actor: UnifiedActor | null, task: Task, action: ResourceAction): Promise<boolean> {
    if (actor?.role === UserRole.ADMIN) return true;

    // Orphan task = public
    if (!task.listId) return true;

    const list = await this.listRepo.findOne({
      where: { id: task.listId },
      relations: ['board'],
    });
    if (!list?.board) return true;

    // write: 被分配者 或 Board write（经 BoardPolicy→board_members，内部已含 owner 代理判定）
    if (action === 'write') {
      const isAssignee = actor !== null && task.assigneeId === actor.id;
      // Batch 2: 委托 BoardPolicy（editor 经 board_members 放行，不再读 jsonb）
      const canWriteBoard = await this.boardPolicy.can(actor, list.board, 'write');
      return isAssignee || canWriteBoard;
    }

    // delete: 被分配者 或 Board 创建者（editor 不能删除他人任务；owner 代理视同创建者）
    if (action === 'delete') {
      const isAssignee = actor !== null && task.assigneeId === actor.id;
      // actor ID 全局唯一，创建者判断只需比较 ID
      const isBoardCreator = actor !== null && list.board.creatorId === actor.id;
      if (isAssignee || isBoardCreator) return true;
      if (!isOwnerProxyCandidate(actor)) return false;
      return this.ownerProxy.isOwnerProxy(list.board.creatorId, actor);
    }

    // read: 继承 board visibility
    return this.boardPolicy.can(actor, list.board, 'read');
  }
}

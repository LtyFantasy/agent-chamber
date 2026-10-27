/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/architecture.md §3.2.3 (Board / Task)
 *
 * [踩坑索引] D5(统一权限重构) B2(成员/权限收敛进关系表) F4-2(assignee 通道合取 boardRead)
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
 *   F4-2: assignee 通道合取 `boardRead` —— 「被指派」不是授权来源，外人被指派即
 *       可写/删私板任务是越权。只给 assignee 通道补合取（board 通道 write ⇒ read
 *       已由 board.policy.ts 蕴含，见下方 can() 内注释）。
 *   S-N1: 软删板判定必须 withDeleted + **显式补选 deletedAt**（Board.deletedAt 是
 *       `select: false`，board.entity.ts:62）——只 withDeleted 会载入软删板但字段恒
 *       undefined，「板已删 → 写删拒」会变成永不触发的死代码（前科：
 *       common/services/api-key-auth.service.ts:128 同款死代码注释）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
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
 * Task 权限策略（v1.37：owner 代理；F4-2：assignee 通道合取 boardRead）
 *
 * 规则：
 * - Task 继承所属 Board 的可见性（read 权限委托给 BoardPolicy）
 * - write: 被分配者（assignee，**且能读该板**）或 Board write（creator/editor/owner 代理，
 *   经 board_members）
 * - delete: 被分配者（**且能读该板**）或 Board 创建者（editor 不能删除他人任务；owner
 *   代理视同创建者）
 * - orphan task（无 listId）：read 公开（与 blockers/batch 同口径），write/delete 拒绝
 * - 软删板（只读冷藏）：read 照 BoardPolicy（OPEN 外人仍可读），write/delete 一律拒
 * - 真缺失（list/board 行不存在 = 数据损坏）：全动作拒 + 告警
 *
 * Admin 全局 bypass。
 */
@Injectable()
export class TaskPolicy {
  /** 真缺失（数据损坏）告警通道——ops 可见性（S-N1） */
  private readonly logger = new Logger(TaskPolicy.name);

  constructor(
    @InjectRepository(BoardList)
    private listRepo: Repository<BoardList>,
    private boardPolicy: BoardPolicy,
    private ownerProxy: OwnerProxyService,
  ) {}

  /**
   * 按主键重载 list + board，**含软删行**。
   *
   * ⚠️ `withDeleted()` 是**钝器**：它对主实体（list）与所有 join（board）同时生效
   * （TypeORM `SelectQueryBuilder.js:986-988` —— join 侧仅在 `!withDeleted` 时才追加
   * `deleted_at IS NULL`）。本分支按主键取单行、以「板是否已删」为唯一判定输入，钝器
   * 副作用可接受；**禁止把该写法复制到任何列表/计数查询**（那会让软删板/列重新混入
   * 可见面）。
   *
   * ⚠️ **调用顺序即语义**：`withDeleted()` 必须在 `leftJoinAndSelect` **之前**调用。
   * join 的软删条件是在 `join()` 当场按 `expressionMap.withDeleted` 决定要不要追加的
   * （TypeORM `SelectQueryBuilder.js:975-990`：`if (joinAttributeMetadata.deleteDateColumn
   * && !this.expressionMap.withDeleted)`），所以**后置的 withDeleted 救不了已经建立的 join**
   * ——顺序写反会得到一个"主实体含软删、join 仍过滤软删"的半吊子查询：软删板载不回来，
   * 判定直接掉进"真缺失"分支。**mock 抓不到这个顺序 bug**，只有真 PG 能证伪
   * （`test/task-policy-soft-delete.e2e-spec.ts` 首次真跑就按这个形态变红）。
   *
   * ⚠️ 必须 `addSelect('board.deletedAt')`：`Board.deletedAt` 是 `@DeleteDateColumn({
   * select: false })`（board.entity.ts:62），`withDeleted` 只解除 WHERE 过滤、**不解除
   * select 过滤**，不补选则该字段恒 `undefined` → 软删板分支永不触发（S-N1 死代码）。
   * 写法与 common/services/actor-profile.service.ts:98-102 的 R1 先例同款。
   *
   * @param listId 任务所属列 id（调用方已保证非空）
   * @returns 载入的列（含 board 关系与 board.deletedAt）；行不存在返回 null
   */
  private async reloadListWithBoard(listId: string): Promise<BoardList | null> {
    return this.listRepo
      .createQueryBuilder('list')
      .withDeleted()
      .leftJoinAndSelect('list.board', 'board')
      .addSelect('board.deletedAt')
      .where('list.id = :id', { id: listId })
      .getOne();
  }

  async can(actor: UnifiedActor | null, task: Task, action: ResourceAction): Promise<boolean> {
    if (actor?.role === UserRole.ADMIN) return true;

    // ── ① orphan task（无 listId）──
    // read 保持 `true` 是**文档化语义**：task.controller.ts:907（blockers/batch）把 orphan
    // 当公开资源（`if (!board) continue`），本文件必须与它同口径——否则「单条 404 /
    // 批量放行」会反向分叉成「单条放行 / 批量 403」。
    // write/delete 改 `false`（F4-2，机制坑 fail-closed）：没有 list 就无从判定归属板，
    // 「无主即可写」是最不该留的默认。`tasks.list_id` 是 NOT NULL（task.entity.ts:35），
    // 本分支当前**不可达**，兜住的是"未来放开 NOT NULL / 内存构造实体"的洞。
    if (!task.listId) return action === 'read';

    // ── ② 定主键重载（含软删行，见 reloadListWithBoard 的钝器说明）──
    const list = await this.reloadListWithBoard(task.listId);

    // ── ③ 软删板：只读冷藏（无 restore 语义，恢复需 DBA）──
    // read 仍走 BoardPolicy ⇒ OPEN 语义不变（外人仍可读），PRIVATE 则成员可读、外人拒。
    // write/delete 一律拒：板已退出使用面，任何写都是往冷藏区注入数据。
    if (list?.board?.deletedAt) {
      if (action === 'read') return this.boardPolicy.can(actor, list.board, 'read');
      return false;
    }

    // ── ④ 真缺失（list 行或 board 行不存在）= 数据损坏 → 全拒 + 告警 ──
    // 此前是 `return true`：一条坏数据 = 该任务对所有写者开放，且**无任何日志痕迹**。
    // 不可达性论证：tasks.list_id NOT NULL + FK→board_lists；board_lists.board_id
    // FK→boards ON DELETE CASCADE —— 板/列被硬删时任务行随之消失，故「任务还在但
    // list/board 查不到」只能来自数据损坏或非法直改（ops 需知道，故 warn 不留静默）。
    if (!list?.board) {
      this.logger.warn(
        `[task.policy] list/board missing for task ${task.id} (listId=${task.listId}, ` +
          `list=${list ? 'found' : 'missing'}, board=${list?.board ? 'found' : 'missing'}) ` +
          `— denying all actions (fail-closed)`,
      );
      return false;
    }

    // ── ⑤ 正常板 ──
    // write: 被分配者 或 Board write（经 BoardPolicy→board_members，内部已含 owner 代理判定）
    if (action === 'write') {
      const isAssignee = actor !== null && task.assigneeId === actor.id;
      // Batch 2: 委托 BoardPolicy（editor 经 board_members 放行，不再读 jsonb）
      const canWriteBoard = await this.boardPolicy.can(actor, list.board, 'write');
      if (canWriteBoard) return true;
      // F4-2：assignee 通道 **合取** boardRead ——「被指派」不是授权来源，被指派者至少要
      // 能读该板；否则「外人被指派即可写私板任务」。
      // 蕴含证明（**勿给 board 通道加多余查询**）：board 通道 = BoardPolicy write =
      // creator ∨ editor ∨ ownerProxy（board.policy.ts:100-103），三者皆已蕴含 read
      // （同文件 :95-99 的 OPEN ∨ creator ∨ member ∨ ownerProxy）——故只有 assignee 通道
      // 需要这次合取，board 通道上再查一次 read 是纯浪费，还会让语义看起来像两次独立判定。
      if (!isAssignee) return false;
      return this.boardPolicy.can(actor, list.board, 'read');
    }

    // delete: 被分配者（且能读板） 或 Board 创建者（editor 不能删除他人任务；owner 代理视同创建者）
    if (action === 'delete') {
      const isAssignee = actor !== null && task.assigneeId === actor.id;
      // actor ID 全局唯一，创建者判断只需比较 ID
      const isBoardCreator = actor !== null && list.board.creatorId === actor.id;
      // F4-2：assignee 通道同样合取 boardRead（理由同 write）。isBoardCreator 与
      // ownerProxy 两路已蕴含 read（creator 在 board.policy.ts:97 的 read 短路内），
      // 不再重复查询。
      if (isAssignee && (await this.boardPolicy.can(actor, list.board, 'read'))) return true;
      if (isBoardCreator) return true;
      if (!isOwnerProxyCandidate(actor)) return false;
      return this.ownerProxy.isOwnerProxy(list.board.creatorId, actor);
    }

    // read: 继承 board visibility
    return this.boardPolicy.can(actor, list.board, 'read');
  }
}

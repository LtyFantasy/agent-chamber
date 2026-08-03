/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *
 * [踩坑索引] D5(统一权限重构) D5-E2E(mock instanceof) B-50(列表权限过滤)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #9(代理层透传)
 *
 * [详细踩坑]（最多 5 条）
 *   D5-E2E: E2E mock 的 plain object 无法通过 instanceof，PermissionService 使用
 *           duck-typing（ownerId/status/capabilities 等字段检查）做类型识别。
 *           mock 数据必须包含 Policy 所需字段。见 memory/2026-06-05.md
 *   B-50: Topic/Board 列表接口在 Controller 层用 filterTopics/filterBoards 过滤，导致
 *          分页 total 与 items 不一致。修复：删除死代码，统一改为 Service 层 QueryBuilder
 *          IN 过滤，Controller 只透传 actor。见 Plan §2.5。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Topic } from '../../database/entities/topic.entity';
import { Board } from '../../database/entities/board.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Task } from '../../database/entities/task.entity';
import { Agent } from '../../database/entities/agent.entity';
import { UnifiedActor } from '../types/actor.types';
import { ResourceAction } from '../policies/resource-action.type';
import { TopicPolicy } from '../policies/topic.policy';
import { BoardPolicy } from '../policies/board.policy';
import { DocSpacePolicy } from '../policies/doc-space.policy';
import { TaskPolicy } from '../policies/task.policy';
import { AgentPolicy } from '../policies/agent.policy';
import { ErrorCode } from '@agent-chamber/shared';

/**
 * 权限服务门面（Permission Service Facade）
 *
 * 统一入口，将权限检查分发到对应的 Policy 类。
 * Controller 中显式调用 `ensureCan()` 进行授权检查。
 *
 * 安全约定：
 * - read 操作无权限 → 404（不泄露私密资源存在性，security through obscurity）
 * - write/delete/join 无权限 → 403（资源存在但无权操作）
 *
 * 类型识别：优先使用 instanceof（生产环境 TypeORM 返回实体实例），
 * 同时支持 duck-typing（测试中常用 plain object mock）。
 */
@Injectable()
export class PermissionService {
  constructor(
    private topicPolicy: TopicPolicy,
    private boardPolicy: BoardPolicy,
    private docSpacePolicy: DocSpacePolicy,
    private taskPolicy: TaskPolicy,
    private agentPolicy: AgentPolicy,
  ) {}

  /** 明确授权检查：无权限则抛出异常 */
  async ensureCan(
    resource: Topic | Board | DocSpace | Task | Agent,
    actor: UnifiedActor | null,
    action: ResourceAction,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const allowed = await this.can(resource, actor, action, context);
    if (!allowed) {
      // read 操作返回 404（安全 through obscurity，不泄露私密资源存在性）
      if (action === 'read') {
        const code = this.getNotFoundCode(resource);
        throw new NotFoundException({
          message: `${this.getResourceName(resource)} not found`,
          code,
        });
      }
      // write/delete/join 返回 403（资源存在但无权操作）
      throw new ForbiddenException({
        message: `Access denied: ${action} on ${this.getResourceName(resource)}`,
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
  }

  /** 非抛出式检查：返回 boolean */
  async can(
    resource: Topic | Board | DocSpace | Task | Agent,
    actor: UnifiedActor | null,
    action: ResourceAction,
    context?: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.isTopic(resource))
      return this.topicPolicy.can(actor, resource as Topic, action, context);
    if (this.isBoard(resource)) return this.boardPolicy.can(actor, resource as Board, action);
    if (this.isDocSpace(resource))
      return this.docSpacePolicy.can(actor, resource as DocSpace, action);
    if (this.isTask(resource)) return this.taskPolicy.can(actor, resource as Task, action);
    if (this.isAgent(resource)) return this.agentPolicy.can(actor, resource as Agent, action);
    return false;
  }

  private isTopic(resource: Topic | Board | DocSpace | Task | Agent): boolean {
    return (
      resource instanceof Topic ||
      (resource &&
        'creatorId' in resource &&
        'settings' in resource &&
        'status' in resource &&
        !('listId' in resource) &&
        !('slug' in resource))
    );
  }

  private isBoard(resource: Topic | Board | DocSpace | Task | Agent): boolean {
    return (
      resource instanceof Board ||
      (resource && 'topicId' in resource && 'lists' in resource && !('slug' in resource))
    );
  }

  private isDocSpace(resource: Topic | Board | DocSpace | Task | Agent): boolean {
    return (
      resource instanceof DocSpace ||
      (resource && 'slug' in resource && 'docCount' in resource && 'settings' in resource)
    );
  }

  private isTask(resource: Topic | Board | DocSpace | Task | Agent): boolean {
    return (
      resource instanceof Task ||
      (resource && 'listId' in resource && 'status' in resource && 'assigneeId' in resource)
    );
  }

  private isAgent(resource: Topic | Board | DocSpace | Task | Agent): boolean {
    return (
      resource instanceof Agent ||
      (resource && 'ownerId' in resource && 'status' in resource && 'capabilities' in resource)
    );
  }

  private getNotFoundCode(resource: Topic | Board | DocSpace | Task | Agent): ErrorCode {
    if (this.isTopic(resource)) return ErrorCode.TOPIC_NOT_FOUND;
    if (this.isBoard(resource)) return ErrorCode.BOARD_NOT_FOUND;
    if (this.isDocSpace(resource)) return ErrorCode.DOC_SPACE_NOT_FOUND;
    if (this.isTask(resource)) return ErrorCode.TASK_NOT_FOUND;
    if (this.isAgent(resource)) return ErrorCode.AGENT_NOT_FOUND;
    return ErrorCode.NOT_FOUND;
  }

  private getResourceName(resource: Topic | Board | DocSpace | Task | Agent): string {
    if (this.isTopic(resource)) return 'Topic';
    if (this.isBoard(resource)) return 'Board';
    if (this.isDocSpace(resource)) return 'DocSpace';
    if (this.isTask(resource)) return 'Task';
    if (this.isAgent(resource)) return 'Agent';
    return 'Resource';
  }
}

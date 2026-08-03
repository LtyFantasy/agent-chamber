/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *
 * [踩坑索引] D5(统一权限重构) OWNER-PROXY(OwnerProxyService注册)
 *
 * [铁律关联] #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 *   OWNER-PROXY: OwnerProxyService 在本模块注册并导出（TopicService / 四个 Policy /
 *       Board、DocSpace Controller / AccessQueryService 共用），Agent repo 已在 forFeature。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Global, Module } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Topic } from '../database/entities/topic.entity';
import { TopicParticipant } from '../database/entities/topic-participant.entity';
import { Board } from '../database/entities/board.entity';
import { BoardList } from '../database/entities/board-list.entity';
import { BoardMember } from '../database/entities/board-member.entity';
import { Task } from '../database/entities/task.entity';
import { Agent } from '../database/entities/agent.entity';
import { DocSpace } from '../database/entities/doc-space.entity';
import { DocSpaceMember } from '../database/entities/doc-space-member.entity';
import { TopicPolicy } from './policies/topic.policy';
import { BoardPolicy } from './policies/board.policy';
import { DocSpacePolicy } from './policies/doc-space.policy';
import { TaskPolicy } from './policies/task.policy';
import { AgentPolicy } from './policies/agent.policy';
import { PermissionService } from './services/permission.service';
import { AccessQueryService, ACCESS_QUERY_STORE } from './services/access-query.service';
import { OwnerProxyService } from './services/owner-proxy.service';

/**
 * 全局权限模块
 *
 * 提供 Policy 类和 PermissionService 给所有 Feature Module 使用。
 * 使用 @Global() 避免每个模块重复导入。
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Topic,
      TopicParticipant,
      Board,
      BoardList,
      BoardMember,
      Task,
      Agent,
      DocSpace,
      DocSpaceMember,
    ]),
  ],
  providers: [
    TopicPolicy,
    BoardPolicy,
    DocSpacePolicy,
    TaskPolicy,
    AgentPolicy,
    PermissionService,
    AccessQueryService,
    OwnerProxyService,
    {
      provide: ACCESS_QUERY_STORE,
      useValue: new AsyncLocalStorage<Map<string, Promise<string[] | null>>>(),
    },
  ],
  exports: [PermissionService, AccessQueryService, OwnerProxyService, ACCESS_QUERY_STORE],
})
export class PermissionModule {}

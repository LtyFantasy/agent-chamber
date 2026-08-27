/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.1 (整体架构)
 *   - 补充: AGENTS.md §2.6 输入校验与资源存在性校验铁律
 *
 * [踩坑索引]
 *
 * [铁律关联] #21(双层校验) #22(findOne必须判空)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResourceValidator } from './resource-validator';
import { ActorProfileService } from './services/actor-profile.service';
import { Actor } from '../database/entities/actor.entity';
import { Agent } from '../database/entities/agent.entity';
import { User } from '../database/entities/user.entity';

/**
 * 通用基础设施模块
 *
 * 以 @Global() 注册，使 ResourceValidator / ActorProfileService 等通用工具可在所有
 * Feature Module 中直接注入，避免每个业务模块重复导入。
 *
 * ActorProfileService 需要 Actor/Agent/User 三个 repository（软删 actor 统一解析，
 * 见 docs/spec.md §1 契约），故 forFeature 注册于此——不放 auth.module 是避免
 * 认证模块与业务实体 repo 的循环依赖（统一批 A1 review R3 结论）。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Actor, User, Agent])],
  providers: [ResourceValidator, ActorProfileService],
  exports: [ResourceValidator, ActorProfileService],
})
export class CommonModule {}

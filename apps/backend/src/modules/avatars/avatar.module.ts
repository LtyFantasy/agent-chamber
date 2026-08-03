/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Avatars（Wave 3 补充契约）
 *
 * [踩坑索引]
 *
 * [铁律关联] #4(文档优先) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AvatarController } from './avatar.controller';
import { AvatarService } from './avatar.service';
import { Actor } from '../../database/entities/actor.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';

/**
 * 头像模块。
 *
 * 注册 SVG 自绘头像的上传/分发端点。业务只读写 actors 表（Supertype 根表，
 * 人类与 Agent 共用）；User/ApiKey/Agent 仓储是 JwtOrApiKeyGuard 的注入依赖
 * （对齐 TopicModule 先例，JwtModule/Guard 本体由 @Global AuthModule 导出）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Actor, User, ApiKey, Agent])],
  controllers: [AvatarController],
  providers: [AvatarService],
})
export class AvatarModule {}

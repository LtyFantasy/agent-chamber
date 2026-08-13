/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace)
 *   - 补充: docs/architecture.md §3.2 (DocSpace 模块)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #17(测试契约) #11(注释)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DocSpace creator 转让请求体（v1.45 DOCSPACE-PERM）。
 *
 * 目标可以是任意 actors 行（人类 user 或 agent 均统一在 actors 表）——
 * 存在性校验（铁律 #21 双层校验的第二层）在 Service 用
 * resourceValidator.exists(actorRepo, ...) 完成（404 ACTOR_NOT_FOUND），
 * 本 DTO 只负责格式正确性（UUID）。
 */
export class TransferCreatorDto {
  /** 新创建者的 actor ID（全局唯一，人/agent 通用） */
  @IsUUID()
  @ApiProperty({
    description: 'Actor ID of the new creator (human or agent, unified actors table)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  newCreatorId!: string;
}

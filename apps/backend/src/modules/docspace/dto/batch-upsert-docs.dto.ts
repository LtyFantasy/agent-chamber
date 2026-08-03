/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan big-barda-big-barda-pantha.md §2 D5 (batch DTO 上限 50 篇)
 *
 * [踩坑索引] 无历史踩坑，新建文件
 *
 * [铁律关联] #17(测试契约) #21(双层校验)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { IsArray, ArrayMinSize, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { UpsertDocDto } from './upsert-doc.dto';

/**
 * 批量 upsert 文档 DTO
 *
 * PUT /doc-spaces/:id/docs/batch
 * 每文档独立事务，单条失败不中断后续。
 * 上限 50 篇/次；超限由 class-validator 拦，调用方自行分批。
 */
export class BatchUpsertDocsDto {
  @ApiProperty({
    description: '文档列表（1-50 篇）',
    type: [UpsertDocDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => UpsertDocDto)
  docs: UpsertDocDto[];
}

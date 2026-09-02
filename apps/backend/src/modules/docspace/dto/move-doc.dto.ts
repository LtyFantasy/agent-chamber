/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.10 (DocSpace Module) + plan venom-longshot-ragman.md
 *     （v1.60.0-dev P1 双件：73cadb0d 原子 move_doc / 8d763914 move impact）
 *   - 补充: docs/api-definition.md §16（POST /docs/:id/move 契约）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #11(注释强制) #21(双层校验——DTO 管格式正确性，Service 管业务存在性)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { IsString, IsOptional, IsBoolean, MaxLength, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 原子移动文档 DTO
 *
 * POST /docs/:id/move
 * 按 docId 定位，单事务只改 path（保留 docId/versions/task links/route 引用）。
 */
export class MoveDocDto {
  @ApiProperty({
    description:
      '目标 path（空间内唯一，原子重命名）。' +
      '校验尺度与 upsert 的 path 一致：@IsString + @MaxLength(512)，无字符规则（与既有契约对齐）。',
    maxLength: 512,
  })
  @IsString()
  // docs.path 列为 varchar(512)，超长必须在 DTO 层 400，禁止透传 PG 22001 → 500（铁律 21）
  @MaxLength(512)
  toPath: string;

  @ApiPropertyOptional({
    description:
      '可选乐观锁前提（与 upsert 同语义）：调用方读取时拿到的 contentHash。' +
      '文档不存在或当前 hash 不符 → 409 DOC_CONTENT_CONFLICT（事务外快速失败 + ' +
      '事务内 FOR UPDATE 复核，TOCTOU 加固）。缺省 = 无前提校验。' +
      '⚠️ move 不改 contentHash——move 本身不会使调用方的 hash 过期，' +
      '并发内容编辑抢先才会。',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // sha256 hex 定长 64；超长 = 格式错误，DTO 层 400（铁律 21）
  @MaxLength(64)
  expectedContentHash?: string;

  @ApiPropertyOptional({
    description:
      'dryRun=true 跑完整校验链 + computeMoveImpact 预演视图，不写库。' +
      '响应 moved=false + wouldMove=true + impact 完整清单——迁移方先预演再真移。',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description:
      '幂等键（可选，1~64 字符）。同 actor 重复提交相同 clientRequestId 时返回首次成功' +
      '响应快照 + idempotentReplay 标记——文档不会再次移动、不发事件、不重算 linkHealth。' +
      '同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT。重试安全。',
    example: 'move-doc-20260821-001',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // 幂等键尺度照 create-task.dto 先例（1~64 字符，不强制 UUID）；超长在 DTO 层 400（铁律 21）
  @Length(1, 64)
  clientRequestId?: string;
}

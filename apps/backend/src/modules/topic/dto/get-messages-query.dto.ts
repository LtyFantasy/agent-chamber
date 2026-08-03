/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §6.11
 *   - 补充: docs/architecture.md §3.2.2 (Topic / Message)
 *
 * [踩坑索引] B-55(QueryBuilder orderBy select 风险)
 *
 * [铁律关联] #21(双层校验) #22(findOne 判空) #11(注释)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   B-55: TypeORM 0.3.30 在 skip/take + join + orderBy(关联字段) + select() 未包含该字段时，
 *         生成 count 子查询报 distinctAlias.xxx does not exist。修复：显式 select orderBy 依赖字段
 *         或改用 leftJoinAndSelect。见 memory/2026-07-02.md §B-55。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Type } from 'class-transformer';
import { IsOptional, Matches, IsISO8601, IsInt, Min, Max } from 'class-validator';

/** UUID 格式正则：仅校验 8-4-4-4-12 的十六进制结构，不限制版本位。
 * 与 NestJS ParseUUIDPipe 默认行为保持一致，兼容项目测试/生产中的顺序 UUID。 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /topics/:id/messages 查询参数 DTO
 * 负责格式正确性校验：UUID、时间戳、limit 范围。
 * 业务互斥与 topic 归属校验由 TopicService 负责。
 */
export class GetMessagesQueryDto {
  /** 游标 ID，返回该消息之后的新消息（不包含锚点本身） */
  @IsOptional()
  @Matches(UUID_REGEX)
  after?: string;

  /** 游标 ID，返回该消息之前的历史消息（不包含锚点本身） */
  @IsOptional()
  @Matches(UUID_REGEX)
  before?: string;

  /** ISO 8601 时间戳，返回该时间之后的消息 */
  @IsOptional()
  @IsISO8601()
  since?: string;

  /** 消息 ID，返回该消息本身及之后的消息（与 after 互斥） */
  @IsOptional()
  @Matches(UUID_REGEX)
  start?: string;

  /** 消息 ID，返回该消息本身及之前的消息（与 before 互斥） */
  @IsOptional()
  @Matches(UUID_REGEX)
  end?: string;

  /**
   * 每次获取条数，1~100，默认 50。
   * Agent 首次读取建议显式传入 1~5，按需通过 before/after 游标加载更多，
   * 避免一次性拉取大量历史消息造成 token 浪费。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** 按发送者 Actor ID 过滤 */
  @IsOptional()
  @Matches(UUID_REGEX)
  senderId?: string;
}

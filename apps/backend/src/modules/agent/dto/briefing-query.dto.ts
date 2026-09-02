/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Agent 启动简报（GET /agents/me/briefing）的查询参数契约
 *
 * [代码职责]
 *   - statuses/taskLimit/activityLimit/maxContentLength 四个可选参数的
 *     格式校验（REST 严格语义：越界/非法 → 400，与 MCP 宽松钳制不同）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §5 Agents（briefing 端点小节）— 参数表
 *   - 补充: plan captain-atom-crimson-avenger-rocket-dc.md §2.2 — 钉死项
 *
 * [关键不变量]
 *   - statuses 拒绝 'all' 与空值（空字符串/空数组 → 400），不得静默退化为
 *     全量查询——'all' 不在 TaskStatus 枚举内自动拒绝；空值经 Transform
 *     filter(Boolean) 后为空数组，由 length > 0 校验拒绝
 *   - 校验消息必须列合法枚举 + 给正确示例（DX N-1：不许照抄 IsTaskStatusOrAll
 *     的无枚举消息）
 *   - taskLimit/activityLimit 越界（<1 或 >50）、maxContentLength 越界
 *     （<0 或 >50000）→ 400（REST 严格语义；MCP 侧为宽松钳制，差异在
 *     api-definition 参数表写明）
 *
 * [关联代码]
 *   - agent.service.ts getMyBriefing — 消费本 DTO 的编排入口
 *   - task/dto/query-task.dto.ts IsTaskStatusOrAll — 对照参考（本 DTO 刻意
 *     不照抄其 'all' 语义与无枚举消息）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  IsOptional,
  IsInt,
  Min,
  Max,
  ValidationOptions,
  ValidationArguments,
  registerDecorator,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { TaskStatus } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 自定义校验：statuses 必须是合法 TaskStatus 枚举值数组（逗号分隔多值）。
 *
 * 与 task 模块的 IsTaskStatusOrAll 刻意不同（DX N-1）：
 * - 拒绝 'all'——briefing 的 active tasks 语义是"活跃状态集"，'all' 会静默
 *   退化为全量查询（含 done/archived），违背 active 语义；
 * - 拒绝空数组/空字符串——替换默认集后 status 参数为空，后端 /tasks 会退化
 *   为"全部状态"查询（MCP 侧 get-my-briefing.ts:168-191 同款防护移植）；
 * - 校验消息列合法枚举 + 给正确示例，不许照抄无枚举消息。
 */
function IsBriefingStatuses(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isBriefingStatuses',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          const statuses = Array.isArray(value) ? value : [value];
          return (
            statuses.length > 0 &&
            statuses.every(
              (s) => typeof s === 'string' && (Object.values(TaskStatus) as string[]).includes(s),
            )
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a non-empty comma-separated list of TaskStatus values (${Object.values(TaskStatus).join(', ')}); 'all' is not supported. Example: statuses=todo,in_progress`;
        },
      },
    });
  };
}

/**
 * GET /agents/me/briefing 查询参数。
 *
 * 全部可选；缺省 = backlog/todo/in_progress/blocked（活跃任务口径，与 MCP
 * get_my_briefing 缺省一致）。REST 严格语义：越界/非法 → 400（MCP 侧为
 * 宽松钳制，差异在 api-definition 参数表写明）。
 */
export class BriefingQueryDto {
  @IsOptional()
  @IsBriefingStatuses()
  @Transform(({ value }) => {
    // 逗号分隔字符串 → 数组；空串/纯逗号 → 空数组（由校验器拒绝，400）
    if (typeof value !== 'string') return value;
    return value.split(',').filter(Boolean);
  })
  @ApiPropertyOptional({
    description:
      'Active task statuses to include (default: backlog/todo/in_progress/blocked). ' +
      'Comma-separated; replaces the default set (not appends). ' +
      '"all" and empty values are rejected with 400.',
    example: 'todo,in_progress',
  })
  statuses?: TaskStatus[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  @ApiPropertyOptional({
    description: 'Max active tasks to return (1~50, default 20)',
    example: 20,
  })
  taskLimit?: number = 20;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  @ApiPropertyOptional({
    description: 'Number of recent activities to return (1~50, default 10)',
    example: 10,
  })
  activityLimit?: number = 10;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50000)
  @Type(() => Number)
  @ApiPropertyOptional({
    description:
      'Max chars per recent activity content before truncation ' +
      '(default 300; 0 = no truncation, full text; max 50000). ' +
      'Only affects recentActivities.',
    example: 300,
  })
  maxContentLength?: number = 300;
}

import { IsDefined, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * PUT /boards/:id/metrics 请求 DTO（v1.42）
 *
 * 语义：metrics 是 report-metrics.mjs 等机器写口上报的机器事实（测试基线/MCP 工具数等），
 * 服务端整对象透传进 settings.metrics（jsonb_set 原子合并，只动 metrics 键）。
 * @IsDefined + @IsObject：必填且必须为对象（class-validator 对 undefined/null 默认跳过
 * 校验，必须显式 @IsDefined 才能拒绝缺失 body）。
 */
export class UpdateBoardMetricsDto {
  /** 机器事实对象（整对象覆盖写入 settings.metrics；digest.metrics 段透传展示） */
  @IsDefined()
  @IsObject()
  @ApiProperty({
    description:
      'Machine facts to store in board.settings.metrics (test baselines, MCP tool counts, etc.)',
    example: { testBaseline: { backend: { suites: 75, tests: 1214 } } },
  })
  metrics: Record<string, unknown>;
}

/**
 * 建座位 DTO（POST /roundtable/seats）
 *
 * 双层校验（铁律 #21）：本 DTO 只做格式正确性（UUID/枚举/长度），
 * topic 存在性与权限校验在 RoundtableService（findById + ensureCan）。
 *
 * 字段语义出处：docs/roundtable-design.md §5（roundtable_seats 表）/ §3（SeatConfig）。
 */
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PERMISSION_MODES, SEAT_VENDORS } from '@agent-chamber/roundtable-protocol';

export class CreateSeatDto {
  @IsUUID()
  @ApiProperty({
    description: '所属圆桌 topic id',
    example: 'a0b17ace-6fde-4ee3-ba52-17c864f757ef',
  })
  topicId: string;

  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: '座位展示名（seatLabel 身份模型，web 渲染 badge）',
    example: 'kimi-1',
  })
  label: string;

  @IsIn([...SEAT_VENDORS])
  @ApiProperty({
    description: '厂商（kimi / codex / opencode / claude-code；M4 起扩展）',
    enum: [...SEAT_VENDORS],
    example: 'kimi',
  })
  vendor: string;

  @IsString()
  @ApiProperty({
    description: '座位工作目录（agent 的环境边界）',
    example: '/home/user/projects/demo',
  })
  cwd: string;

  @IsIn([...PERMISSION_MODES])
  @ApiProperty({
    description: '权限模式（显式钉死，禁止吃用户 config 剩饭）',
    enum: [...PERMISSION_MODES],
    example: 'auto',
  })
  permissionMode: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: '可选模型覆盖（ACP set_config_option）', example: 'kimi-k2' })
  model?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description:
      '绑定目标 actor id（runner 将用该 actor 的 API Key 拨号；缺省时创建者为 agent 则绑自己）',
  })
  bindActorId?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: '主脑座位标记（M3 只做标记/标识/公告）', example: false })
  coordinator?: boolean;

  /**
   * 攒批窗口（毫秒，设计 §6：座位维度时间窗，缺省 30s 一处常量可调）：
   * 0 = 直通（M1 行为，消息立即注入，dogfood 对照用）；>0 = 窗口内到达的消息
   * 合并为一次注入。上限 300000（5 分钟）防误配长窗导致消息滞留不可见。
   * 落 seat.config jsonb（entity 注释预留键名 batchWindowMs，阶段 2 消费）。
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300000)
  @ApiPropertyOptional({
    description: '攒批窗口毫秒（0=直通；缺省 30000，设计 §6 默认 30s）',
    example: 30000,
  })
  batchWindowMs?: number;
}

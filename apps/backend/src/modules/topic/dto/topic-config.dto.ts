import {
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsArray,
  IsUUID,
  IsIn,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Visibility, TopicConfigInput, TopicKind, WakePolicy } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class TopicConfigDto implements TopicConfigInput {
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Auto-archive', example: true })
  autoArchive?: boolean;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Archive after days', example: 1 })
  archiveAfterDays?: number;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Allow agents to join', example: true })
  allowAgentJoin?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Enable moderation', example: true })
  moderationEnabled?: boolean;

  /** 话题可见性：open（公开，自由加入）/ private（私密，仅受邀可加入） */
  @IsOptional()
  @IsEnum(Visibility)
  @ApiPropertyOptional({
    enum: Object.values(Visibility),
    description: 'Visibility, one of: open (public), private',
    example: Visibility.OPEN,
  })
  visibility?: Visibility;

  /** 私密话题的白名单（visibility=private 时生效） */
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    description: 'Invited agent IDs',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  invitedAgentIds?: string[];

  /**
   * 话题类型（设计 docs/roundtable-design.md §5，M2 阶段 1 落地）：
   * 'normal'（缺省）/ 'roundtable'。仅创建时生效——创建后不可变，update 忽略
   * （互转在 M2 推迟清单）。写 entity 列，不进 settings。
   */
  @IsOptional()
  @IsIn(Object.values(TopicKind))
  @ApiPropertyOptional({
    enum: Object.values(TopicKind),
    description: 'Topic kind: normal (default) | roundtable',
    example: TopicKind.ROUNDTABLE,
  })
  kind?: TopicKind;

  /**
   * 圆桌唤醒策略（设计 §6，r4 + R1 拍板）：'mention'（缺省——仅 @座位/@all 唤醒）/
   * 'broadcast'（新消息唤醒全部 active 座位）。写 settings jsonb；kind='roundtable'
   * 且未显式给定时由 service 缺省 'mention'。普通桌按「配置原样存储」透传。
   */
  @IsOptional()
  @IsIn(Object.values(WakePolicy))
  @ApiPropertyOptional({
    enum: Object.values(WakePolicy),
    description: 'Roundtable wake policy: mention (default) | broadcast',
    example: WakePolicy.MENTION,
  })
  wakePolicy?: WakePolicy;

  /**
   * 圆桌安全阀阈值（设计 §6，M2 阶段 4 落地）：topic 内座位间连续非沉默轮次
   * 无人类发言 ≥ 阈值 → 暂停注入 + topic 公告。缺省 8；显式 0 = 关闭安全阀
   * （dogfood 对照）；合法范围 0~1000。写 settings jsonb；service 读取处防御性
   * 解析（存量脏数据/越权直写 settings 时兜底缺省 8）。
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @ApiPropertyOptional({
    description:
      'Roundtable safety valve: consecutive non-silent rounds without a human message before injection pauses (0 = disabled)',
    example: 8,
    minimum: 0,
    maximum: 1000,
  })
  maxRoundsWithoutHuman?: number;
}

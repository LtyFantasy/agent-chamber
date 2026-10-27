/**
 * `POST /agents/:id/reset-key` 请求体（可选）。
 *
 * 语义（2026-10-16 卡 72566c2e，**升格后门修复**）：重置会吊销该 agent 全部活跃 key 并
 * 新建一把。新 key 的 scopes 取值优先级：
 *   1. 本 DTO 显式传入的 `scopes`（调用方明确表达意图时优先）；
 *   2. 否则 = **被吊销集合 scopes 的交集**（永不变宽：多把不一致时取最严）；
 *   3. 交集为空（理论上不可达，被吊销集合非空则交集至少含其元素）→ 回落 `['read']`。
 *
 * 修复前的行为是硬编码 `['read','write']`——只读 key 的持有者调 reset-key 会**升格**成
 * 双权 key（权限提升后门）。本 DTO 的显式入参是**显式授权路径**（controller 已 ensureCan
 * 'write'），不构成降级绕过。
 */
import { ArrayNotEmpty, ArrayUnique, IsArray, IsIn, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { API_KEY_SCOPE_VALUES, type ApiKeyScope } from '@agent-chamber/shared';

export class ResetAgentKeyDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(API_KEY_SCOPE_VALUES, { each: true })
  @ApiProperty({
    description:
      'Explicit scopes for the newly issued key. Omit to inherit the strictest set of the ' +
      'keys being revoked (intersection; never widens).',
    example: ['read'],
    enum: API_KEY_SCOPE_VALUES,
    isArray: true,
    required: false,
  })
  scopes?: ApiKeyScope[];
}

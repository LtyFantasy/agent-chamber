/**
 * `POST /agents/:id/keys` 请求体（创建 Agent API Key）。
 *
 * scopes（2026-10-16 卡 72566c2e）：可选，缺省 = 全量 `['read','write']`（向后兼容——
 * 既有调用方不传即得到旧行为）。值域单源 = shared `API_KEY_SCOPE_VALUES`；此处的 DTO 校验
 * 只负责**格式正确性**（双层校验铁律 #21 的外层），运行时 fail-closed 收窄由
 * `common/utils/api-key-scope.ts` 承担。
 *
 * 未知值（如 `['admin']`）→ 400（`@IsIn` 逐元素），不会流到 service/DB。
 */
import { ArrayNotEmpty, ArrayUnique, IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  API_KEY_SCOPE_VALUES,
  type ApiKeyScope,
  type CreateAgentKeyInput,
} from '@agent-chamber/shared';

export class CreateAgentKeyDto implements CreateAgentKeyInput {
  @IsString()
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(API_KEY_SCOPE_VALUES, { each: true })
  @ApiProperty({
    description:
      "Permission scopes. Omit for full access ['read','write']. 'read' covers GET/HEAD plus " +
      "read-semantics POST endpoints explicitly marked @AgentScope('read').",
    example: ['read'],
    enum: API_KEY_SCOPE_VALUES,
    isArray: true,
    required: false,
  })
  scopes?: ApiKeyScope[];
}

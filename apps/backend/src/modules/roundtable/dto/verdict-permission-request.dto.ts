/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 人类选择不透明审批 optionId 的输入合同。
 *
 * [代码职责]
 *   - 仅校验非空字符串及 100 字符上限；选项存在性、kind、状态与权限由 Service 校验。
 *
 * [权威文档]
 *   - 主文档: DocSpace Agent Chamber / docs/api-definition.md §7a.3 — 审批裁决。
 *   - 补充: DocSpace Agent Chamber / docs/modules/roundtable-design.md §4/§6 — 原 optionId 透传。
 *
 * [关键不变量]
 *   - optionId 不固定三选，不按其拼写推断 kind，也不在 DTO 收窄上行 options。
 *
 * [关联代码]
 *   - ../roundtable.service.ts — 选项匹配与标准 kind 结果投影。
 *   - test/roundtable-permission-verdict.e2e-spec.ts — HTTP 400/422 与不透明 ID 验证。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerdictPermissionRequestDto {
  /** 选中选项的不透明键，与请求 options 中 optionId/id 匹配并原样下发。 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @ApiProperty({
    description:
      '选中的不透明审批选项 id（必须 ∈ 请求 options 的 id/optionId；原样下发，不固定取值）',
    example: 'approve_once',
  })
  optionId: string;
}

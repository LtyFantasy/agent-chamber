/**
 * 审批裁决 DTO（POST /roundtable/permission-requests/:id/verdict）
 *
 * 双层校验（铁律 #21）：本 DTO 只做格式正确性（optionId 非空字符串）；
 * 状态机校验（pending、optionId ∈ options）与权限校验在 Service 层。
 * optionId 语义出处：docs/roundtable-design.md §4（seat.permission_verdict 下行
 * payload = requestId + 选中 optionId，对应契约① PermissionOption 的 id）。
 */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerdictPermissionRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @ApiProperty({
    description:
      '选中的审批选项 id（必须 ∈ 请求 options 的 id/optionId，ACP 三选：approve_once / approve_always / reject）',
    example: 'approve_once',
  })
  optionId: string;
}

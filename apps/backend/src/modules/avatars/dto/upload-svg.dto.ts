import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * PUT /avatars/me/svg 请求体。
 *
 * svg 必填字符串；体积上限与内容安全检查由 AvatarService.sanitizeSvg 负责
 * （DTO 层只做类型校验，避免校验规则分散两处）。
 */
export class UploadSvgDto {
  /** SVG 文档原文（允许前导空白与 <?xml 声明，必须以 <svg 根元素开头） */
  @ApiProperty({
    description: 'SVG source string, max 32KB',
    example: '<svg xmlns="...">...</svg>',
  })
  @IsString()
  svg: string;
}

import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * diagram.html 直出查询 DTO
 *
 * GET /docs/:id/diagram.html?lang=
 *
 * lang = 读时视图语言（可选，枚举与渲染器 IR meta.locale 对齐）。缺省 = 直出
 * 存储快照（IR 作者语言）；与存储 IR meta.locale 不一致时读时重渲染（不落库，
 * 见 DiagramService.getDiagramHtml）。值域与 web 端 Locale（'en'|'zh-CN'）一致。
 */
export class DiagramHtmlQueryDto {
  @ApiPropertyOptional({
    description:
      '读时视图语言覆盖：与存储 IR 语言不一致时按该语言重渲染（不落库）；' +
      '只影响渲染器生成的 viewer 文案/图例，用户编写的节点标签保持作者原语言',
    enum: ['en', 'zh-CN'],
  })
  @IsOptional()
  @IsIn(['en', 'zh-CN'])
  lang?: 'en' | 'zh-CN';
}

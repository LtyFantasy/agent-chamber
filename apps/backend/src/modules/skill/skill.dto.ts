import { ApiProperty } from '@nestjs/swagger';

/**
 * Skill 列表项 DTO。
 *
 * 用于 `GET /skills` 返回公开 Skill 的元数据，便于外部 Agent 自发现。
 */
export class SkillListItemDto {
  @ApiProperty({ description: 'Skill name (URL identifier)', example: 'agent-chamber' })
  name: string;

  @ApiProperty({
    description: 'Skill one-line description',
    example: 'Agent collaboration and communication middleware platform API guide.',
  })
  description: string;

  @ApiProperty({ description: 'Skill version', example: '1.3.1' })
  version: string;

  @ApiProperty({ description: 'Skill last updated date (ISO 8601)', example: '2026-06-16' })
  updatedAt: string;
}

/**
 * Skill 详情 DTO。
 *
 * 在列表项基础上增加 Markdown 内容，用于 `GET /skills/:name` 与 `GET /skills/:name/:subpath`。
 */
export class SkillDetailDto extends SkillListItemDto {
  @ApiProperty({ description: 'Skill Markdown content' })
  content: string;
}

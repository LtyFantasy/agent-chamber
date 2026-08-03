/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §13. Skill 模块
 *   - 补充: ./agents/skills/agent-chamber/SKILL.md
 *
 * [踩坑索引]
 *
 * [铁律关联] #4(文档优先) #10(工具优先) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ErrorCode } from '@agent-chamber/shared';
import { Public } from '../../common/decorators/public.decorator';
import { SkillService } from './skill.service';
import { SkillListItemDto, SkillDetailDto } from './skill.dto';

/**
 * Skill 分发控制器。
 *
 * 提供公开端点，让外部 Agent 和人类用户无需登录即可发现、查看和下载 Skill。
 */
@ApiTags('Skills')
@Controller('skills')
export class SkillController {
  constructor(private readonly skillService: SkillService) {}

  /**
   * 获取 Skill 列表。
   *
   * @returns Skill 元数据数组，由全局 ResponseInterceptor 包装为统一响应格式
   */
  @Get()
  @Public()
  @ApiOperation({
    summary: 'List skills',
    description:
      'Return metadata for all public skills. Supports agent self-discovery of available skills.',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns Skill list',
    type: [SkillListItemDto],
  })
  async findAll(): Promise<SkillListItemDto[]> {
    return this.skillService.findAll();
  }

  /**
   * 获取 Skill 详情。
   *
   * - 默认返回 JSON 格式的 `SkillDetailDto`。
   * - 传 `?format=raw` 时返回原始 Markdown，Content-Type 为 `text/markdown; charset=utf-8`。
   *
   * 由于同一端点需要同时支持统一 JSON 包装和裸 Markdown，本方法直接使用 Response 对象输出。
   *
   * @param name Skill 名称
   * @param format 返回格式
   * @param res Express Response
   * @param req Express Request
   */
  @Get(':name')
  @Public()
  @ApiOperation({
    summary: 'Get skill details',
    description: 'Returns JSON by default; pass format=raw to get plain Markdown.',
  })
  @ApiParam({ name: 'name', description: 'Skill name', example: 'agent-chamber' })
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['raw'],
    description: 'Response format; pass "raw" for raw Markdown',
  })
  @ApiResponse({ status: 200, description: 'Skill details' })
  @ApiResponse({ status: 404, description: 'Skill not found' })
  async findOne(
    @Param('name') name: string,
    @Query('format') format: string,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<void> {
    if (format === 'raw') {
      const content = await this.skillService.getRaw(name);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(content);
      return;
    }

    const detail = await this.skillService.findOne(name);
    res.json({
      code: ErrorCode.SUCCESS,
      message: 'success',
      data: detail,
      timestamp: new Date().toISOString(),
      requestId: req['requestId'] || 'unknown',
    });
  }

  /**
   * Get child skill details。
   *
   * @param name 父 Skill 名称
   * @param subpath 子 Skill 路径（如 taskboard、topics）
   * @returns 子 Skill 详情，由全局 ResponseInterceptor 包装
   */
  @Get(':name/:subpath')
  @Public()
  @ApiOperation({
    summary: 'Get child skill details',
    description: 'Return a sub-document under the specified skill, e.g. taskboard, topics.',
  })
  @ApiParam({ name: 'name', description: 'Parent skill name', example: 'agent-chamber' })
  @ApiParam({ name: 'subpath', description: 'Child skill path', example: 'taskboard' })
  @ApiResponse({ status: 200, description: 'Child skill details' })
  @ApiResponse({ status: 404, description: 'Skill not found' })
  async findSubSkill(
    @Param('name') name: string,
    @Param('subpath') subpath: string,
  ): Promise<SkillDetailDto> {
    return this.skillService.findSubSkill(name, subpath);
  }
}

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Avatars（Wave 3 补充契约）
 *   - 补充: .kimi 会话 plan nova-prime-multiple-man-forager.md（Avatar 身份体系批次）
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释强制) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { AvatarService } from './avatar.service';
import { UploadSvgDto } from './dto/upload-svg.dto';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * 头像控制器。
 *
 * 提供 SVG 自绘头像的上传（JWT 与 API Key 双通道，Agent/人类共用）与
 * 公开分发端点（<img> 标签无法携带凭证，故 GET 必须公开）。
 */
@ApiTags('Avatars')
@Controller('avatars')
export class AvatarController {
  constructor(private readonly avatarService: AvatarService) {}

  /**
   * 上传当前 Actor 的 SVG 自绘头像。
   *
   * 通过 sanitize 后写入 actors.avatar_svg，并把 avatarUrl 联动置为分发短链。
   *
   * @returns `{ avatarUrl }`，由全局 ResponseInterceptor 包装
   */
  @UseGuards(JwtOrApiKeyGuard)
  @Put('me/svg')
  @ApiOperation({
    summary: 'Upload SVG avatar',
    description:
      'Upload a self-drawn SVG avatar for the current actor (human via JWT or agent via API Key). ' +
      'Reject-style sanitization: must start with <svg, no <script>/foreignObject/on*= handlers, ' +
      'no external href, max 32KB. Sets avatarUrl to the public SVG endpoint.',
  })
  @ApiResponse({ status: 200, description: 'Avatar uploaded, returns avatarUrl' })
  @ApiResponse({
    status: 400,
    description: 'SVG validation failed (size / structure / dangerous features)',
  })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  async uploadSvg(@CurrentActor() actor: UnifiedActor, @Body() dto: UploadSvgDto) {
    return this.avatarService.uploadSvg(actor.id, dto.svg);
  }

  /**
   * 公开分发指定 Actor 的 SVG 头像。
   *
   * 直接写 Response（先例：skill.controller.ts findOne format=raw），
   * 绕过全局 `{code,message,data}` 响应包装——<img> 消费的是裸 SVG 文档。
   * Cache-Control 300s 平衡头像变更时效与分发压力。
   */
  @Public()
  @Get(':actorId.svg')
  @ApiOperation({
    summary: 'Get SVG avatar',
    description:
      'Public endpoint serving the raw SVG avatar for an actor. ' +
      'Returns image/svg+xml with Cache-Control: public, max-age=300; 404 when not set.',
  })
  @ApiParam({ name: 'actorId', description: 'Actor ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Raw SVG source (image/svg+xml)' })
  @ApiResponse({ status: 400, description: 'actorId is not a valid UUID' })
  @ApiResponse({ status: 404, description: 'Actor not found or no SVG avatar set' })
  async serveSvg(
    @Param('actorId', ParseUUIDPipe) actorId: string,
    @Res() res: Response,
  ): Promise<void> {
    const svg = await this.avatarService.getSvg(actorId);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(svg);
  }
}

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.4 (统一事件层)
 *   - 补充: docs/api-definition.md §9. Webhooks
 *
 * [踩坑索引] B-50(webhook列表越权)
 *
 * [铁律关联] #9(代理层透传) #17(测试契约) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: GET /webhooks 仅 JWT 认证，无角色过滤，任何登录用户都可查看全平台
 *          Webhook 投递记录。修复：Controller 类级别添加 @UseGuards(JwtAuthGuard,
 *          RolesGuard) + @Roles(ADMIN)，保持 Service 签名不变。见 Plan §5。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@agent-chamber/shared';
import { QueryWebhookDto } from './dto/query-webhook.dto';
import { TestWebhookDto } from './dto/test-webhook.dto';

@ApiTags('Webhooks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get()
  @ApiOperation({
    summary: 'List webhook deliveries',
    description: 'Paginated list of webhook delivery records; admin only',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number, default 1' })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: 'Items per page, default 20',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of webhook delivery records' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async findAll(@Query() query: QueryWebhookDto) {
    return this.webhookService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get webhook delivery',
    description: 'Get a single webhook delivery record detail by ID',
  })
  @ApiParam({ name: 'id', type: String, description: 'Webhook delivery record ID' })
  @ApiResponse({ status: 200, description: 'Webhook delivery record details' })
  @ApiResponse({ status: 404, description: 'Record not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhookService.findOne(id);
  }

  @Post('test')
  @ApiOperation({
    summary: 'Test webhook delivery',
    description: 'Simulate a webhook test request and record the delivery log',
  })
  @ApiResponse({
    status: 201,
    description: 'Webhook test successful; simulated delivery log returned',
  })
  @ApiResponse({ status: 400, description: 'Request validation failed' })
  async test(@Body() dto: TestWebhookDto) {
    return this.webhookService.test(dto);
  }
}

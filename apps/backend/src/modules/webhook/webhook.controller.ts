/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.4 (统一事件层)
 *   - 补充: docs/api-definition.md §9. Webhooks
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（webhook 模块唯一
 *     mutating 端点 = POST /webhooks/test 模拟投递；⚠️ 前提修正：agent 实体
 *     webhookUrl/webhookSecret/webhookEvents 为遗留死字段（无任何写路径），
 *     「webhook 配置变更」端点不存在——本模块按 test 端点落 CREATE + webhook_delivery，
 *     newData 只记 deliveryId + targetUrl 域名部分，payload 不入）
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
import { UserRole, AuditAction } from '@agent-chamber/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { QueryWebhookDto } from './dto/query-webhook.dto';
import { TestWebhookDto } from './dto/test-webhook.dto';

@ApiTags('Webhooks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly auditService: AuditService,
  ) {}

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
  async test(@Body() dto: TestWebhookDto, @CurrentUser('userId') adminId?: string) {
    const result = await this.webhookService.test(dto);
    // 审计（Phase 2）：CREATE + webhook_delivery（模拟投递）；actor=操作 admin；
    // newData 只记 deliveryId + targetUrl 域名部分（决策 6——payload 测试载荷不入，
    // 可能含任意内容）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: 'webhook_delivery',
      entityId: result.log.id,
      actorId: adminId ?? null,
      newData: {
        deliveryId: result.log.id,
        targetUrl: this.hostnameOf(dto.url),
      },
      source: 'api',
    });
    return result;
  }

  /** 提取 URL 域名部分（决策 6：完整 URL 可能带 query/secret 参数，只记 hostname） */
  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
}

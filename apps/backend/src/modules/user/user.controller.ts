/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §4 (Users)
 *   - 补充: docs/architecture.md §3.2 (Auth / Actor 统一模型)
 *
 * [踩坑索引] P2-#5(GET /users 对 API key 放行)
 *
 * [铁律关联] #21(双层校验) #22(findOne 判空) #4(文档优先) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条）
 *   P2-#5: GET /users 经 JwtOrApiKeyGuard 放行 agent API key，任何持有效 key 者
 *          可列出全部活跃用户。修复：findAll 显式校验 actor 类型，非 human 403；
 *          MCP agent.json 未透出 user_controller_*，tools 数不变。
 *          见 memory/2026-08-02.md §批次 A。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ErrorCode } from '@agent-chamber/shared';
import { UserService } from './user.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@ApiTags('Users')
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @ApiOperation({
    summary: 'List all users (lightweight, for invitation dropdown)',
    description:
      'Returns a paginated list of active users with lightweight fields (id, name, avatarUrl, role). ' +
      'Supports keyword search via `q`. **Human (JWT) only** — API key (agent) requests are rejected with 403.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (default: 1)',
    type: Number,
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, max 100 (default: 50)',
    type: Number,
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search keyword for display name or email',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Paginated lightweight user list' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — API key (agent) callers are rejected' })
  async findAll(
    @CurrentUser() user: { userId: string } | undefined,
    @Query() query: { page?: string | number; pageSize?: string | number; q?: string },
  ) {
    // 仅对人类（JWT）开放：JwtAuthGuard 对携带 X-API-Key 的请求走真实 API Key 认证
    // 并挂 request.agent（不挂 request.user，B-59 起不再「放行不认证」），故 user 缺失
    // 即代表 API key agent 调用 → 403。邀请下拉仅人类 UI 使用，Agent 无业务场景。
    if (!user) {
      throw new ForbiddenException({
        message: 'This endpoint is restricted to human (JWT) authentication',
        code: ErrorCode.FORBIDDEN,
      });
    }
    return this.userService.findAllLightweight(query);
  }

  @Get('me')
  @ApiOperation({
    summary: 'Get current user',
    description: 'Returns the full profile of the currently authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getMe(@CurrentUser('userId') userId: string) {
    return this.userService.getMe(userId);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update current user',
    description:
      'Updates the profile (name, avatar, preferences) of the currently authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Updated user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateMe(@CurrentUser('userId') userId: string, @Body() dto: UpdateProfileDto) {
    return this.userService.updateMe(userId, dto);
  }

  @Get('me/settings')
  @ApiOperation({
    summary: 'Get user settings',
    description: 'Returns the preference settings of the currently authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'User settings object' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getSettings(@CurrentUser('userId') userId: string) {
    return this.userService.getSettings(userId);
  }

  @Patch('me/settings')
  @ApiOperation({
    summary: 'Update user settings',
    description:
      'Updates the preference settings (theme, language, notifications) of the currently authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Updated user settings' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateSettings(@CurrentUser('userId') userId: string, @Body() dto: UpdateSettingsDto) {
    return this.userService.updateSettings(userId, dto);
  }

  @Post('me/change-password')
  @ApiOperation({
    summary: 'Change password',
    description:
      'Changes the password of the currently authenticated user. Requires the current password for verification.',
  })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async changePassword(@CurrentUser('userId') userId: string, @Body() dto: ChangePasswordDto) {
    return this.userService.changePassword(userId, dto);
  }

  @Post('me/avatar')
  @ApiOperation({
    summary: 'Update avatar',
    description: 'Updates the avatar URL of the currently authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Updated user profile with new avatar' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateAvatar(@CurrentUser('userId') userId: string, @Body('avatarUrl') avatarUrl: string) {
    return this.userService.updateAvatar(userId, avatarUrl);
  }
}

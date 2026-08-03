import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { UserService } from './user.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@agent-chamber/shared';
import { CreateUserByAdminDto, UpdateUserByAdminDto } from './dto';

@ApiTags('Admin Users')
@Controller('admin/users')
export class AdminUserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'List all users (admin only)',
    description:
      'Returns a paginated list of all users (including soft-deleted). Supports keyword search via `q`. Only accessible by ADMIN.',
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
    description: 'Items per page, max 100 (default: 20)',
    type: Number,
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search keyword for email or display name',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Paginated user list' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  async findAll(
    @Query() query: { page?: string | number; pageSize?: string | number; q?: string },
  ) {
    return this.userService.findAll(query);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Create user by admin',
    description: 'Creates a new user account with specified role. Only accessible by ADMIN.',
  })
  @ApiResponse({ status: 200, description: 'User created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiResponse({ status: 409, description: 'Email already registered or admin already exists' })
  async createByAdmin(@Body() dto: CreateUserByAdminDto) {
    return this.userService.createByAdmin(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Update user by admin',
    description:
      "Updates a user's profile, role, or status. Admin cannot downgrade or delete themselves. Only accessible by ADMIN.",
  })
  @ApiParam({ name: 'id', description: 'Target user ID', type: String })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 400, description: 'Cannot downgrade yourself' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'An admin already exists' })
  async updateByAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserByAdminDto,
    @CurrentUser('userId') currentAdminId: string,
  ) {
    return this.userService.updateByAdmin(id, dto, currentAdminId);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Delete user by admin (soft delete)',
    description:
      'Soft-deletes a user account. Admin cannot delete themselves. Only accessible by ADMIN.',
  })
  @ApiParam({ name: 'id', description: 'Target user ID', type: String })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 400, description: 'Cannot delete yourself' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteByAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') currentAdminId: string,
  ) {
    return this.userService.deleteByAdmin(id, currentAdminId);
  }
}

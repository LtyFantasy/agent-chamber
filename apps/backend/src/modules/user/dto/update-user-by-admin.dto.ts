import { IsString, IsEnum, IsOptional, MinLength, MaxLength } from 'class-validator';
import { UserRole } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 管理员更新用户的请求 DTO
 */
export class UpdateUserByAdminDto {
  /** 用户显示名称 */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Name', example: 'TestAgent' })
  name?: string;

  /** 用户角色 */
  @IsOptional()
  @IsEnum(UserRole)
  @ApiPropertyOptional({
    enum: Object.values(UserRole),
    description: 'Role, one of: admin, editor',
    example: UserRole.EDITOR,
  })
  role?: UserRole;

  /** 用户状态 */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Status', example: 'active' })
  status?: string;
}

import { IsEmail, IsString, IsEnum, MinLength, MaxLength, IsOptional } from 'class-validator';
import { UserRole } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 管理员创建用户的请求 DTO
 */
export class CreateUserByAdminDto {
  /** 用户邮箱 */
  @IsEmail()
  @ApiProperty({ description: 'Email address', example: 'user@example.com' })
  email: string;

  /** 用户显示名称 */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

  /** 初始密码 */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @ApiProperty({ description: 'Password', example: 'SecurePass123!' })
  password: string;

  /** 用户角色，默认为 OBSERVER */
  @IsOptional()
  @IsEnum(UserRole)
  @ApiPropertyOptional({
    enum: Object.values(UserRole),
    description: 'Role, one of: admin, editor',
    example: UserRole.EDITOR,
  })
  role?: UserRole;
}

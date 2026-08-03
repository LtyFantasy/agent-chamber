import { IsEmail, IsString, IsOptional } from 'class-validator';
import { LoginInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto implements LoginInput {
  @IsEmail()
  @ApiProperty({ description: 'Email address', example: 'user@example.com' })
  email: string;

  @IsString()
  @ApiProperty({ description: 'Password', example: 'SecurePass123!' })
  password: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'captcha', example: 'abc123' })
  captcha?: string;
}

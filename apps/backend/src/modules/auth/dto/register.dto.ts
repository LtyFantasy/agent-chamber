import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';
import { RegisterInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto implements RegisterInput {
  @IsEmail()
  @ApiProperty({ description: 'Email address', example: 'user@example.com' })
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(32)
  @ApiProperty({ description: 'Password', example: 'SecurePass123!' })
  password: string;

  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Invitation code', example: 'ABC123' })
  inviteCode?: string;
}

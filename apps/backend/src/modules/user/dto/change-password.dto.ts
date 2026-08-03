import { IsString, MinLength } from 'class-validator';
import { ChangePasswordInput } from '@agent-chamber/shared';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto implements ChangePasswordInput {
  @IsString()
  @ApiProperty({ description: 'Current password', example: 'OldPass123!' })
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @ApiProperty({ description: 'New password', example: 'NewPass123!' })
  newPassword: string;
}

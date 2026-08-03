import { IsString } from 'class-validator';
import { RefreshTokenInput } from '@agent-chamber/shared';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto implements RefreshTokenInput {
  @IsString()
  @ApiProperty({ description: 'Refresh token', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  refreshToken: string;
}

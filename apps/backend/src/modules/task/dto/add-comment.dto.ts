import { IsString } from 'class-validator';
import { AddCommentInput } from '@agent-chamber/shared';
import { ApiProperty } from '@nestjs/swagger';

export class AddCommentDto implements AddCommentInput {
  @IsString()
  @ApiProperty({ description: 'Content', example: 'Message content' })
  content: string;
}

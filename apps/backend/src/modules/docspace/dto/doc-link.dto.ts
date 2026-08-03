import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddDocLinkDto {
  @IsUUID()
  @ApiProperty({
    description: 'Document ID to link',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  docId: string;
}

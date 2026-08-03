import { IsString } from 'class-validator';
import { CreateAgentKeyInput } from '@agent-chamber/shared';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAgentKeyDto implements CreateAgentKeyInput {
  @IsString()
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;
}

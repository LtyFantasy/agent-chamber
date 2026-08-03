import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UpdateAgendaInput } from '@agent-chamber/shared';
import { AgendaItemDto } from './agenda-item.dto';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateAgendaDto implements UpdateAgendaInput {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgendaItemDto)
  @ApiProperty({
    description: 'Agenda items',
    type: () => [AgendaItemDto],
  })
  agenda: AgendaItemDto[];
}

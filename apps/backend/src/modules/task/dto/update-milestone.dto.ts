import { PartialType } from '@nestjs/swagger';
import { UpdateMilestoneInput } from '@agent-chamber/shared';
import { CreateMilestoneDto } from './create-milestone.dto';

export class UpdateMilestoneDto
  extends PartialType(CreateMilestoneDto)
  implements UpdateMilestoneInput {}

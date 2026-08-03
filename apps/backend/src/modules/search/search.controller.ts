import { Controller, Get, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { SearchQueryDto } from './dto';

@ApiTags('Search')
@UseGuards(JwtOrApiKeyGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Full-text search',
    description:
      'Full-text search across messages and tasks using PostgreSQL tsvector + GIN index, with keyword highlighting support.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Search keyword, 1–200 characters',
    type: String,
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Search scope: all / messages / tasks, defaults to all',
    type: String,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number, minimum 1, default 1',
    type: Number,
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, range 1–100, default 20',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Search results (paginated, grouped by type)' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async search(@Query() dto: SearchQueryDto, @CurrentActor() actor: UnifiedActor) {
    return this.searchService.search(dto, actor);
  }
}

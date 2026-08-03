import { Controller, Sse, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Observable, interval, map, merge } from 'rxjs';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { SseService } from './sse.service';

@ApiTags('SSE')
@Controller('events')
export class SseController {
  constructor(private readonly sseService: SseService) {}

  @UseGuards(JwtOrApiKeyGuard)
  @Sse('stream')
  @ApiOperation({ summary: 'SSE stream' })
  stream(): Observable<MessageEvent> {
    const heartbeat$ = interval(30000).pipe(
      map(
        () =>
          ({
            data: JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() }),
          }) as MessageEvent,
      ),
    );
    return merge(this.sseService.subscribe(), heartbeat$);
  }
}

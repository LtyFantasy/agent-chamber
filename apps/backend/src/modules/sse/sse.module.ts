import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SseController } from './sse.controller';
import { SseService } from './sse.service';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, ApiKey, Agent])],
  controllers: [SseController],
  providers: [SseService],
  exports: [SseService],
})
export class SseModule {}

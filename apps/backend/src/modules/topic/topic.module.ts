import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TopicService } from './topic.service';
import { TopicController } from './topic.controller';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Message } from '../../database/entities/message.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Board } from '../../database/entities/board.entity';
import { Task } from '../../database/entities/task.entity';
import { EventModule } from '../event/event.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Topic,
      TopicParticipant,
      Message,
      User,
      ApiKey,
      Agent,
      Actor,
      Board,
      Task,
    ]),
    EventModule,
    // 活动日志插桩（plan shadowcat-sunspot-catwoman Phase 2）：topic 写操作全量记
    AuditModule,
  ],
  providers: [TopicService],
  controllers: [TopicController],
  exports: [TopicService],
})
export class TopicModule {}

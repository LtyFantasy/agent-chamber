import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BoardService } from './board.service';
import { BoardController } from './board.controller';
import { Board } from '../../database/entities/board.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { BoardMember } from '../../database/entities/board-member.entity';
import { Task } from '../../database/entities/task.entity';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Actor } from '../../database/entities/actor.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { TaskModule } from '../task/task.module';
import { EventModule } from '../event/event.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Board,
      BoardList,
      BoardMember,
      Task,
      Topic,
      TopicParticipant,
      User,
      ApiKey,
      Agent,
      Actor,
      DocSpace,
    ]),
    TaskModule,
    EventModule,
  ],
  providers: [BoardService],
  controllers: [BoardController],
  exports: [BoardService],
})
export class BoardModule {}

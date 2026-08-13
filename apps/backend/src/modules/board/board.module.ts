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
import { Doc } from '../../database/entities/doc.entity';
import { Milestone } from '../../database/entities/milestone.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { Message } from '../../database/entities/message.entity';
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
      // v1.41 digest：BoardDigest docs 段按 boardId 找空间 + 该空间文档 updatedAt desc
      Doc,
      // v1.41 digest：milestones 段需查里程碑元数据 + 批量 stats（与 Doc 同款，无模块循环依赖）
      Milestone,
      // v1.44.0-dev digest：roundtable 段实时装配（圆桌 topic/座位/座位消息，平台级口径；
      // 与 Milestone 同款——实体注册仅依赖表，无模块循环依赖）
      RoundtableSeat,
      Message,
    ]),
    TaskModule,
    EventModule,
  ],
  providers: [BoardService],
  controllers: [BoardController],
  exports: [BoardService],
})
export class BoardModule {}

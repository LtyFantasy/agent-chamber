import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { User } from '../../database/entities/user.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Task } from '../../database/entities/task.entity';
import { Message } from '../../database/entities/message.entity';
import { Board } from '../../database/entities/board.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Doc } from '../../database/entities/doc.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Agent, Topic, Task, Message, Board, DocSpace, Doc])],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Message, Task, User, ApiKey, Agent])],
  providers: [SearchService],
  controllers: [SearchController],
})
export class SearchModule {}

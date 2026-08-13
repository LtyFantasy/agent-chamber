import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Doc } from '../../database/entities/doc.entity';
// DocSpaceModule 导出 DocSearchService（全局搜索文档一路复用其白名单检索）
import { DocSpaceModule } from '../docspace/docspace.module';

@Module({
  imports: [TypeOrmModule.forFeature([Message, Task, User, ApiKey, Agent, Doc]), DocSpaceModule],
  providers: [SearchService],
  controllers: [SearchController],
})
export class SearchModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocSpaceService } from './docspace.service';
import { DocService } from './doc.service';
import { DocSpaceController } from './docspace.controller';
import { DocController } from './doc.controller';
import { DocCategoryController } from './doc-category.controller';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
// JwtOrApiKeyGuard 的 ApiKeyRepository 依赖要求模块内注册 ApiKey 实体（BoardModule 同款先例）
import { ApiKey } from '../../database/entities/api-key.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Board } from '../../database/entities/board.entity';
import { Topic } from '../../database/entities/topic.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { Event } from '../../database/entities/event.entity';
import { BoardModule } from '../board/board.module';
import { EventModule } from '../event/event.module';
import { DocSearchService } from './doc-search.service';
import { DocRouteService } from './doc-route.service';
import { DocRouteController } from './doc-route.controller';
import { RouteHealthService } from './route-health.service';
import { DocRoute } from '../../database/entities/doc-route.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocSpace,
      DocSpaceMember,
      DocCategory,
      Doc,
      DocSection,
      TaskDocLink,
      DocRoute,
      Agent,
      User,
      ApiKey,
      Actor,
      Board,
      Topic,
      AuditLog,
      Event,
    ]),
    BoardModule,
    EventModule,
  ],
  providers: [DocSpaceService, DocService, DocSearchService, DocRouteService, RouteHealthService],
  controllers: [DocSpaceController, DocController, DocCategoryController, DocRouteController],
  exports: [DocSpaceService, DocService, DocSearchService, RouteHealthService],
})
export class DocSpaceModule {}

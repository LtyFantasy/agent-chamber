import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocSpaceService } from './docspace.service';
import { DocService } from './doc.service';
import { DocMoveService } from './doc-move.service';
import { DocBundleService } from './doc-bundle.service';
import { DocSpaceController } from './docspace.controller';
import { DocController } from './doc.controller';
import { DocCategoryController } from './doc-category.controller';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocVersion } from '../../database/entities/doc-version.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
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
import { AuditModule } from '../audit/audit.module';
import { DocSearchService } from './doc-search.service';
import { DocRouteService } from './doc-route.service';
import { DocRouteController } from './doc-route.controller';
import { RouteHealthService } from './route-health.service';
import { DocRoute } from '../../database/entities/doc-route.entity';
// Diagram IR v1（plan diagram-ir-v1-plan.md §4/§7 Phase 1）
import { DiagramService } from './diagram.service';
import { DiagramRendererService } from './diagram-renderer.service';
import { DiagramController } from './diagram.controller';
import { AttachmentModule } from '../attachments/attachment.module';

/**
 * DocSpace 模块。
 *
 * ⚠️ **双向 forwardRef（P2 批 5，plan §0 arch M1）**：本模块 `imports: [forwardRef(() => AttachmentModule)]`
 * 只为 bundle 的媒体段（DocBundleService 注入 AttachmentService 门面），而
 * AttachmentModule 早已 forwardRef 引用本模块（doc 绑定写校验）。
 * 代价 = 模块图不再是单向 DAG，Nest 需靠 forwardRef 解环——收益 = bundle 归属不动
 * （导出/导入编排留在 docspace，媒体实现留在 attachments，不为了"无环"把 bundle 挪走）。
 * gitnexus 复核：除本对外无其他环；构造器侧无 provider 互依，故无需 @Inject(forwardRef)。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocSpace,
      DocSpaceMember,
      DocCategory,
      Doc,
      DocSection,
      DocVersion,
      // v1.63.0：DocSpace 写族幂等记录（doc.service / doc-move.service 注入）
      IdempotencyRecord,
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
    AuditModule,
    // bundle formatVersion 2 媒体段（P2 批 5）：媒体读写全在 attachments 模块内聚，
    // 本模块只消费门面——双向 forwardRef 的代价说明见类注释
    forwardRef(() => AttachmentModule),
  ],
  providers: [
    DocSpaceService,
    DocService,
    DocMoveService,
    DocSearchService,
    DocRouteService,
    RouteHealthService,
    DocBundleService,
    // Diagram IR v1：渲染门（DocService upsertCore diagram 分支依赖）+ 端点业务服务
    DiagramRendererService,
    DiagramService,
  ],
  controllers: [
    DocSpaceController,
    DocController,
    DocCategoryController,
    DocRouteController,
    DiagramController,
  ],
  exports: [DocSpaceService, DocService, DocSearchService, RouteHealthService],
})
export class DocSpaceModule {}

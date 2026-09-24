/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块)
 *   - 补充: docs/api-definition.md §Attachments
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #4(文档优先) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 依赖方向不变量：import TopicModule/DocSpaceModule，禁止 import DocSpacePolicy
 * =============================================================================
 */
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AttachmentController } from './attachment.controller';
import { AttachmentPublicController } from './attachment-public.controller';
import { AttachmentService } from './attachment.service';
import { AttachmentSignedUrlService } from './attachment-signed-url.service';
import { AttachmentStorageService } from './storage.service';
import { AttachmentAccessService } from './attachment-access.service';
import { AttachmentGcService } from './attachment-gc.service';
import { MulterLimitErrorInterceptor } from './multer-error.interceptor';
import { Attachment } from '../../database/entities/attachment.entity';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { TopicModule } from '../topic/topic.module';
import { DocSpaceModule } from '../docspace/docspace.module';
import { AuditModule } from '../audit/audit.module';

/**
 * 附件模块（MinIO 媒体附件 P0，avatars 范式 avatar.module.ts:36-40）。
 *
 * 依赖方向（plan §3.2 钉死，gitnexus 实证无新环）：
 * - TopicModule（exports TopicService）——topic 绑定写校验 + 读取 hasTopicAccess；
 * - DocSpaceModule（exports DocSpaceService/DocService）——doc 绑定写校验；
 *   ⚠️ 该边自 P2 批 5 起是**双向 forwardRef**（DocSpaceModule 也引用本模块做 bundle
 *   媒体段）：解环成本由 Nest 承担，收益 = 两个模块各自内聚（见 DocSpaceModule 类注释）；
 * - 全局 PermissionService（PermissionModule @Global，无需 import）——
 *   读取授权 duck-typing 到 DocSpacePolicy（该 Policy 未被导出，禁止直接 import）；
 * - AuditModule（exports AuditService）——DELETE 审计 + 签名 URL 铸造审计。
 *
 * 导出面（P2 批 5）：AttachmentService——bundle 媒体门面（listByDocIds/listByIds/
 * readObjectBytes/importFromBundle/bindBundleMedia）的唯一消费方是 DocBundleService。
 * 刻意不导出 AttachmentStorageService：对象层只在本模块内使用，docspace 必须走门面。
 *
 * User/ApiKey/Agent 仓储是 JwtOrApiKeyGuard 的注入依赖（avatar 先例，
 * Guard 本体由 @Global AuthModule 导出）；Topic/Doc/DocSpace 仓储供
 * access service 直查（含 withDeleted 软删语义，见该文件注释）。
 *
 * AttachmentPublicController（P2 批 2）：`/public/attachments` 公开读取端点，
 * **类级无守卫**（签名 URL 的凭证在 query，公开端点不得要求 Authorization）——
 * 与全鉴权的 AttachmentController 刻意分文件，防"顺手加守卫"类回归。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Attachment,
      Topic,
      TopicParticipant,
      Doc,
      DocSpace,
      User,
      ApiKey,
      Agent,
    ]),
    // GC 定时调度（plan §3.7）：forRoot() 全应用注册一次即全局生效；
    // 挂在 AttachmentModule 内聚——cron 注册与 GC 归属同域（现状无其他
    // schedule 消费方，后续模块如需 cron 不得重复 forRoot）
    ScheduleModule.forRoot(),
    TopicModule,
    forwardRef(() => DocSpaceModule),
    AuditModule,
  ],
  controllers: [AttachmentController, AttachmentPublicController],
  providers: [
    AttachmentService,
    AttachmentSignedUrlService,
    AttachmentStorageService,
    AttachmentAccessService,
    AttachmentGcService,
    MulterLimitErrorInterceptor,
  ],
  exports: [AttachmentService],
})
export class AttachmentModule {}

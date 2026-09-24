/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）模块装配：实体仓储 + 审计依赖 + controller/service 注册
 *
 * [代码职责]
 *   - ExperienceModule 的 imports/controllers/providers/exports 声明
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §3（API 契约）/§10 批 2（交付范围）
 *   - 补充: 线上 DocSpace `docs/architecture.md` §3.2 — 模块清单
 *
 * [关键不变量]
 *   - **`User` 必须在本模块 forFeature 里**（不是"顺手抄的"）：方法级 `JwtOrApiKeyGuard`
 *     在**声明它的模块上下文**里实例化，其构造注入 `@InjectRepository(User)`；AuthModule
 *     虽是 `@Global()` 并导出了该 guard，但 **`TypeOrmModule.forFeature` 产生的仓储
 *     provider 默认不外泄** ⇒ 漏注册 = 应用启动后首个请求 500（DI 炸），而单测/e2e 因
 *     `overrideGuard` 全部漏网（audit.module.ts 的血泪注释同源，attachment.module 同款）
 *   - `AuditModule` 必须**显式 import**：它不是 @Global（只有 AuthModule/PermissionModule
 *     是），三处审计插桩（终审/软删/越权尝试）直接注入 AuditService
 *   - `OwnerProxyService` **不在此 import**：它由 `@Global() PermissionModule` 导出
 *   - `ActorProfileService` 同理（`@Global() CommonModule`）：`ExperienceMemberService` 直接注入
 *   - `IdempotencyRecord` 仓储在 forFeature 里（录入幂等走 common helper，需要共享表仓储）
 *   - **本模块不注册任何全局 provider**（无 APP_GUARD/APP_INTERCEPTOR）：鉴权走全局兜底 +
 *     方法级声明（见 controller 文件头不变量 1）；usage stats 拦截器零接线自动覆盖
 *
 * [关联代码]
 *   - experience.controller.ts — 12 端点（8 条目端点 + 4 成员端点；方法级守卫在此声明）
 *   - experience.service.ts — 条目业务规则
 *   - experience-member.service.ts — 成员表与终审资格（第二期批 2；两个 service 均在此注册）
 *   - modules/audit/audit.module.ts — AuditService 来源（非 @Global，必须 import）
 *   - app.module.ts — 本模块的注册点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增注入依赖时，先确认它由哪个模块导出（@Global 与否），再决定 import 还是 forFeature
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExperienceEntry } from '../../database/entities/experience-entry.entity';
import { ExperienceFeedback } from '../../database/entities/experience-feedback.entity';
import { ExperienceSearchEvent } from '../../database/entities/experience-search-event.entity';
import { ExperienceSpaceMember } from '../../database/entities/experience-space-member.entity';
import { ExperienceJudgmentRecord } from '../../database/entities/experience-judgment-record.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { User } from '../../database/entities/user.entity';
import { AuditModule } from '../audit/audit.module';
import { ExperienceController } from './experience.controller';
import { ExperienceService } from './experience.service';
import { ExperienceMemberService } from './experience-member.service';
import { ExperienceJudgmentService } from './experience-judgment.service';
import {
  judgmentConfigProvider,
  judgmentProviderProvider,
} from './judgment/judgment-provider.factory';

/**
 * 经验库模块（平台第四资源：Topic 管人 / Board 管事 / DocSpace 管知识 / Experience 管
 * 「带伤疤的实战笔记」）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ExperienceEntry,
      ExperienceFeedback,
      ExperienceSearchEvent,
      // 第二期双表（批 1 注册、批 2/3 消费）：成员仓储 + 判断日志仓储。
      // 现在注册而非等批 2 ——本模块文件头的 DI 不变量血泪教训指出"漏注册 = 应用启动后
      // 首个请求 500，而单测/e2e 因 overrideGuard 全部漏网"；提前注册是零行为增量的防呆
      // （未注入的仓储 provider 不产生任何运行期效果）。
      ExperienceSpaceMember,
      ExperienceJudgmentRecord,
      IdempotencyRecord,
      // 方法级 JwtOrApiKeyGuard 的 @InjectRepository(User) 从本模块解析（见文件头不变量）
      User,
    ]),
    // AuditService（终审/软删/越权尝试三插桩；非 @Global 模块）
    AuditModule,
  ],
  controllers: [ExperienceController],
  providers: [
    ExperienceService,
    /**
     * 空间成员与终审资格（第二期批 2）。
     *
     * 依赖三件：`ExperienceSpaceMember` 仓储（本模块 forFeature）、`AuditService`
     * （AuditModule，非 @Global 必须 import）、`OwnerProxyService`（@Global PermissionModule）
     * 与 `ActorProfileService`（@Global CommonModule）——后两者不需要在本模块 import。
     */
    ExperienceMemberService,
    /**
     * 判别服务接线（第二期批 3）：判定调用/日志落库/快照写 + 判断日志端点。
     *
     * 依赖：`ExperienceJudgmentRecord` 仓储（本模块 forFeature）+ `DataSource`（快照裸 SQL）
     * + 两个 judgment token（下方 provider 定义）+ `ExperienceMemberService`（端点判权复用）。
     */
    ExperienceJudgmentService,
    /**
     * 判别 provider 的两个 token（第二期批 3）：
     * - `JUDGMENT_PROVIDER` → 真 typesafe 客户端或 noop（按 config；e2e override 成内存 fake）
     * - `JUDGMENT_CONFIG` → 缺省补齐后的只读配置（service 读 rateLimitPerHour）
     * 两者都 inject ConfigService（ConfigModule 在 app.module 里 isGlobal）。
     */
    judgmentProviderProvider,
    judgmentConfigProvider,
  ],
  // 导出以便后续批次（platform-mcp 走 REST，不经 Nest DI；web 亦走 REST）——
  // 保持导出是模块惯例，且便于同进程的其它模块复用检索逻辑
  exports: [ExperienceService, ExperienceMemberService],
})
export class ExperienceModule {}

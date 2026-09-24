/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计（采集 → 聚合 → 落库 → 查询/上报）
 *
 * [代码职责]
 *   - 模块装配：全局采集拦截器注册 + 聚合并发服务 + 查询/上报 controller + 清理 cron
 *     + 本模块实体与 guard 依赖仓储注册
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §UsageStats 模块 — 模块总览与依赖方向
 *   - 补充: docs/api-definition.md §Usage Stats — 端点与统计口径专章
 *
 * [关键不变量]
 *   - **禁止 REQUEST 作用域**：buffer service 与拦截器必须是应用级单例，
 *     否则聚合 Map 碎成每请求一份（统计恒空）、@Cron 失效（D9）
 *   - **禁止重复 `ScheduleModule.forRoot()`**：已在 attachment.module.ts:82 注册一次，
 *     该 forRoot 的 explorer 全应用扫描自动发现任意模块的 @Cron（V7）；
 *     重复注册会创建第二个调度器
 *   - **forFeature 必须含 `User`**：`JwtOrApiKeyGuard`（上报端点）在**使用方模块**
 *     上下文实例化，`@InjectRepository(User)` 从这里解析——漏注册 = 运行时 DI 炸，
 *     且单测/e2e 因全局 overrideGuard 全部漏网（audit.module.ts 实证，回归钉见
 *     usage-stats.module.spec.ts）
 *   - 拦截器注册走 `APP_INTERCEPTOR` 令牌（全局生效），不要用 `app.useGlobalInterceptors`
 *     ——后者拿不到 DI（Reflector / buffer service 注入会失败）
 *
 * [关联代码]
 *   - usage-stats.interceptor.ts — 全局采集入口（APP_INTERCEPTOR 实体）
 *   - usage-stats-buffer.service.ts — 聚合/flush（本模块唯一有状态组件）
 *   - database/migrations/1789484900000-AddApiUsageStatsHourly.ts — 建表
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（作用域 / 重复 forRoot）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiUsageStatsHourly } from '../../database/entities/api-usage-stats-hourly.entity';
import { User } from '../../database/entities/user.entity';
import { ApiUsageController } from './api-usage.controller';
import { ApiUsageQueryService } from './api-usage-query.service';
import { UsageEventsController } from './usage-events.controller';
import { UsageStatsBufferService } from './usage-stats-buffer.service';
import { UsageStatsInterceptor } from './usage-stats.interceptor';
import { UsageStatsRetentionService } from './usage-stats-retention.service';

/**
 * 使用统计模块（plan rocket-batwoman-booster-gold §2 D9）。
 *
 * 批 1 = 采集核心：拦截器 + buffer/flush service + 表。批 2（本批）叠加三个组件：
 * - `GET /system/api-usage`（查询面，admin-only）→ `ApiUsageQueryService`；
 * - `POST /system/usage-events`（MCP 上报面，认证即可）→ 直接调 buffer；
 * - `UsageStatsRetentionService`（月度清理 cron，13 个月保留）——**cron 不重复
 *   `ScheduleModule.forRoot()`**：attachment.module.ts 已全应用注册一次，
 *   其 explorer 自动发现任意模块的 @Cron（V7），重复注册会起第二个调度器。
 *
 * `TypeOrmModule.forFeature([ApiUsageStatsHourly, User])`：
 * - `ApiUsageStatsHourly` 供查询面做原生聚合（批 1 的写入走 jsonb 批量 SQL，
 *   注册仓储是为查询面与实体元数据预置）；
 * - **`User` 是 `JwtOrApiKeyGuard` 的注入依赖**（上报端点用了该 guard）：guard 在
 *   **使用方模块**上下文实例化，`@InjectRepository(User)` 从本模块解析——漏注册
 *   = 运行时 DI 炸，而单测与 e2e 因全局 `overrideGuard` 双双漏网
 *   （audit.module.ts 的实证，回归钉见 usage-stats.module.spec.ts）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApiUsageStatsHourly, User])],
  controllers: [ApiUsageController, UsageEventsController],
  providers: [
    UsageStatsBufferService,
    ApiUsageQueryService,
    UsageStatsRetentionService,
    {
      // 全局采集拦截器：APP_INTERCEPTOR 令牌使注册全局生效，且实例化走 DI
      provide: APP_INTERCEPTOR,
      useClass: UsageStatsInterceptor,
    },
  ],
})
export class UsageStatsModule {}

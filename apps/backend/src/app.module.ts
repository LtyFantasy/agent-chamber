/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.1 (整体架构)
 *
 * [踩坑索引] D5(PermissionModule注册)
 *
 * [铁律关联] #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   D5: PermissionModule 为 @Global() 模块，导入 AppModule 后全局可用。
 *       各 Feature Module 无需重复导入 PermissionModule 即可注入 PermissionService。
 *       见 memory/2026-06-05.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { SnakeNamingStrategy } from './database/snake-naming.strategy';
import { RequestIdMiddleware } from './common/interceptors/request-id.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AccessQueryInterceptor } from './common/interceptors/access-query.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionModule } from './common/permission.module';
import { CommonModule } from './common/common.module';

import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import appConfig from './config/app.config';

import * as entities from './database/entities';

import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { AgentModule } from './modules/agent/agent.module';
import { TopicModule } from './modules/topic/topic.module';
import { BoardModule } from './modules/board/board.module';
import { DocSpaceModule } from './modules/docspace/docspace.module';
import { TaskModule } from './modules/task/task.module';
import { EventModule } from './modules/event/event.module';
import { SseModule } from './modules/sse/sse.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AvatarModule } from './modules/avatars/avatar.module';
import { SkillModule } from './modules/skill/skill.module';
import { AuditModule } from './modules/audit/audit.module';
import { SearchModule } from './modules/search/search.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { RoundtableModule } from './modules/roundtable/roundtable.module';
import { DownloadsModule } from './modules/downloads/downloads.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, jwtConfig, appConfig],
    }),
    // 事件总线（M1 圆桌计划决策 2）：@nestjs/event-emitter forRoot() 默认 global: true，
    // 注册一次全模块可注入 EventEmitter2。EventService.create() 末尾 emit('event.created')，
    // 12 个事件写入方零改动；roundtable 模块用 @OnEvent('event.created') 订阅。
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'agent_chamber',
      password: process.env.DB_PASSWORD || '***',
      // DB_NAME 优先，DB_DATABASE 为 .env.example 历史键名 fallback（A5：向后兼容）
      database: process.env.DB_NAME || process.env.DB_DATABASE || 'agent_chamber',
      entities: Object.values(entities),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
      migrationsRun: true,
      logging: process.env.NODE_ENV === 'development',
    }),
    // A6 登录限流（@nestjs/throttler，内存存储，单实例生产足够）。
    // v2 收窄决策：全局默认不设有效限流（limit 极大 = 实际关闭），避免误伤
    // events/poll 游标轮询、SSE 长连接、platform-mcp 编排（一次语义调用 = 多次 REST）
    // 等高频路径；仅 auth.controller 的 login/register 用 @Throttle 收紧（见该文件常量）。
    // ttl 单位为毫秒（@nestjs/throttler v5 API）。
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: parseInt(process.env.THROTTLE_GLOBAL_LIMIT || '100000', 10),
      },
    ]),
    PermissionModule,
    CommonModule,
    AuthModule,
    UserModule,
    AgentModule,
    TopicModule,
    BoardModule,
    DocSpaceModule,
    TaskModule,
    EventModule,
    SseModule,
    DashboardModule,
    AvatarModule,
    SkillModule,
    AuditModule,
    SearchModule,
    WebhookModule,
    MonitoringModule,
    // 圆桌模式（M1 计划阶段 3）：WS 控制面（/ws/runner）+ runner 注册表 + 座位管理
    // REST + 注入管线（@OnEvent('event.created') 触发，见 roundtable.service.ts）
    RoundtableModule,
    // 下载分发（M1「最后一公里」P2）：公开提供 install-runner.sh / runner bundle / 对接指南，
    // 供 curl | bash 一键安装链路使用；无 DB 依赖、全 @Public()
    DownloadsModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AccessQueryInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      // 全局限流 Guard：配合上方 ThrottlerModule 的极宽松默认值，实际只对
      // 显式标注 @Throttle 的端点（auth login/register）生效
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

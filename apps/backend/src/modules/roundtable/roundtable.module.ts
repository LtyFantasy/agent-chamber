/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §2 (组件与代码归属: chamber ② 控制通道层 + ③ 会话层)
 *   - 补充: docs/roundtable-design.md §4 (控制面协议 WebSocket) / §5 (数据模型)
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   1. JwtOrApiKeyGuard 依赖 UserRepository，而 TypeOrmModule.forFeature 的 repo 是
 *      模块作用域（TopicModule 注册了 User 但不 re-export）——本模块必须自己在
 *      forFeature 里注册 User，否则 Nest 启动期 DI 解析失败（单测 mock guard 测不出，
 *      只有真实启动才暴露，2026-08-07 dogfood 实测踩中）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { RoundtablePermissionRequest } from '../../database/entities/roundtable-permission-request.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Message } from '../../database/entities/message.entity';
import { Actor } from '../../database/entities/actor.entity';
import { User } from '../../database/entities/user.entity';
import { TopicModule } from '../topic/topic.module';
import { AuditModule } from '../audit/audit.module';
import { RunnerGateway } from './runner.gateway';
import { RunnerRegistryService } from './runner-registry.service';
import { RoundtableService } from './roundtable.service';
import { RoundtableController } from './roundtable.controller';

/**
 * 圆桌模式后端模块（M1 计划阶段 3：控制面 + 最小闭环）
 *
 * 职责切分（docs/roundtable-design.md §2）：
 * - RunnerGateway：② 控制通道层服务端——/ws/runner 握手认证、信封收发、连接生命周期
 * - RunnerRegistryService：② runner 注册表——在线表、一 key 一 runner 踢旧、座位绑定与
 *   seat.assign 下行
 * - RoundtableService：③ 圆桌会话层 M1 版——座位 CRUD、注入触发器（@OnEvent）、单飞行
 *   FIFO、自激防护、沉默拦截、规则头装配、hello 对账重放、回复落 topic；M3 阶段 1 追加
 *   审批持久化 + 裁决（permission_request 落库/公告、verdict 下行、断连孤儿作废、
 *   审批列表与 pending 计数）
 * - RoundtableController：座位管理 REST（POST/GET /roundtable/seats）+ 审批 REST
 *   （POST /roundtable/permission-requests/:id/verdict、GET .../permission-requests、
 *   GET .../pending-count）
 *
 * 依赖说明：
 * - TopicModule 引其 sendMessage（座位回复以 runner 对应 agent actor 身份落 topic，§6 身份模型）
 * - 本模块自持 Topic/Message/Actor repo：注入装配需要 topic 标题、消息原文（黑板即真相，
 *   对账重放从消息表重建 inject，§4 可靠性）与发送者身份投影
 * - PermissionModule 为 @Global()，PermissionService 直接可注入（app.module.ts D5 踩坑）
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RoundtableRunner,
      RoundtableSeat,
      RoundtablePermissionRequest,
      TopicParticipant,
      Topic,
      Message,
      Actor,
      User,
    ]),
    TopicModule,
    AuditModule,
  ],
  providers: [RunnerGateway, RunnerRegistryService, RoundtableService],
  controllers: [RoundtableController],
  exports: [RoundtableService],
})
export class RoundtableModule {}

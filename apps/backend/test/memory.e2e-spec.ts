/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块（Hument 集成一期 + 二期自助开通）的**端到端契约**：12 端点 + 未启用引擎的
 *     双组形状 + 三处同源权限过滤 + §7 逐态语义 + 恢复三通道 + 更正的唯一位释放 +
 *     alias（内容级去重）镜像 + 更正目标落库（`correction_target_memory_id` ⇒ 中断续跑同参，⑪）+
 *     **自助开通的创建三分支**（⑬：自动注册落派生三键 / 显式三键零注册 / 部分缺 400）+
 *     **召回 score 透传**（③：形状断言 + ScriptedEngine 后处理钩子证端到端 5）+ **项目投影
 *     `canReadContent` 与列表信封 `provisioningAvailable`**（⑭：清空绑定翻 false / admin 恒 true /
 *     软删绑定资源翻 false / 部署态开关两分支 / **admin 视角列表含私有绑定项目 + 无权限 agent
 *     不可见**——后者是 `findAll` 真实列表路径上 `isAdmin` 短路的回归锁，卡 27d7006d）
 *
 * [代码职责]
 *   - 用**真实 PG + 真实 HTTP**（真 JWT / 真 sha256 API Key）钉死计划 §8 的 e2e 清单，
 *     并把"只有真库能证伪"的部分钉住：部分唯一索引的并发仲裁、jsonb 映射（禁 SQL 谓词）、
 *     `recovery_path` 不在账本表（扫描排除集靠子查询）、`select:false` 的正文只在显式取时出现
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §5 权限模型 / §6 端点面 / §7 状态机与
 *     恢复三通道 / §8 测试矩阵（e2e 行：**未启用双组形状**、两 403 文案、混合来源过滤、
 *     更正后 current 不命中旧主张、崩溃恢复、recover 自愈、engineDataSuspect、三值 emptyReason、
 *     撤权后 memories/:id 404）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]（本套件是这些不变量的守门人，改断言前先想清楚在防什么）
 *   - **memory 是可选增强**：未配引擎时**本地数据端点照常 200**、引擎动词 503 —— 两者必须
 *     在同一个套件里同时被实测（只测一侧 = "配错了也能上线"或"没配就整站不可用"两种事故之一）。
 *   - **`withdrawn ⇒ engine_memory_ids 为空` 且释放唯一位**：更正未达成（no_memory）后
 *     **同一 old 必须能再更正**——这条只有把"唯一位释放"与"映射不认撤回行"一起跑才成立。
 *   - **三处同源**：召回过滤 / 账本降级投影 / `memories/:id` 的 404 用的是同一套判据，
 *     本套件用同一个"来源消失"动作（软删来源 doc）同时验证三处。
 *   - **`moved` 只对 doc 有定义**：改 `docs.content_hash` 后召回项的 `sources[].moved` 必须翻真，
 *     而 message/task/comment 恒假（它们没有版本列）。
 *   - **`engineDataSuspect` 排除在途行**：本项目存在 `submitted` 行时不得喊狼来了——否则
 *     刚提名完的合法调用会被判成"引擎数据脏"。
 *   - **`recovery_path` 不在账本表上**：扫描排除集必须按"最近一次尝试"判（子查询），
 *     若有人把它写成账本列谓词，SQL 会直接报列不存在（本套件会红）。
 *   - **GET 零副作用**：详情/列表/记忆详情都不推进 job、不写遥测（用 `memory_formation_events`
 *     的行数前后相等钉住）。
 *   - **投影放宽的分界是"内容面 vs 元数据"**（二期 D1）：`projectId` / `correctionOf` /
 *     `nominatorName` / `nominatorDeletedAt` **两档都有**（治理观察者据此归项目、画取代边、
 *     显示归属），而 `content` / `sourceRefs` / `sources` / `contentExcerpt` / `contentTruncated`
 *     仍只在 `full` **整键缺席**。列表的 `contentExcerpt` 由服务端从冻结正文抽（剥 locator /
 *     280 码点），**不读不写** `contentTruncated`。放宽是有意的——勿当越权回归"修回去"。
 *   - **alias 不形成第二条记忆**：同 workspace + 同正文的第二次提名 ⇒ 引擎回 `duplicate=true`，
 *     服务层镜像 canonical 行的**当前** `formation_state`（**含非终态**）、**不写 ids**
 *     （`engine_memory_ids` 恒 NULL）、`engine_canonical_nomination_id` 记 canonical 的引擎提名
 *     id；canonical 不在本项目 ⇒ `conflict`（不猜状态、不建影子行）。召回面 alias 不重复出现
 *     （引擎侧同正文只有一条记忆 ⇒ 只映射 canonical 行）。
 *   - **自助开通的判据是 `MEMORY_PROVISIONING` token，不是 `MEMORY_ENGINE`/`MEMORY_CONFIG`**：
 *     它由 `ConfigService` 的 `memory` namespace 独立解析（与引擎 token 无关），所以 ⑬ 用
 *     `overrideProvider(MEMORY_PROVISIONING)` 注入替身——改 `E2E_MEMORY_CONFIG` 对它**无效**。
 *     自动注册还要求「`engine=hument` + 三键**全缺**」，故替身在别的用例里恒不被调用
 *     （既有用例的 createProject 都显式带三键 ⇒ 零行为变化）。
 *   - **绑定读判定与运行时同口径**（⑧b，卡 7a21f96b）：topic 绑定的「可读」复用
 *     `getAccessibleTopicIds`（creator / owner-proxy / participant invited+active / OPEN）——
 *     private topic 的参与者必须能创建/改绑，非参与者与 `left` 仍 400。裸调 Policy 会因缺
 *     `context.hasAccess` 把参与者误判无权限。
 *   - **同 workspace ≠ 同引擎身份**（2026-10-24 claims 批）：平台 claim 唯一键是四列
 *     `(engine, workspaceId, actorId, credentialRef)`。需要"两个项目共享一个 workspace"的
 *     引擎级夹具（⑦ engineDataSuspect / ⑩ alias / ⑪ 更正目标）必须换 actor——否则新项目
 *     创建会被永久占用 409 拦下。FakeEngine 的身份仍只按 workspace（actor 不参与），故
 *     换 actor 不改变这些用例的引擎语义。
 *   - **⑬ 的 save 失败注入必须同时代理 `manager`**：服务层在 `projects.manager.transaction`
 *     内用事务仓储落库（项目与 claim 同事务），只代理仓储 provider 的 `save` 拦不到事务内写。
 *   - **`canReadContent` 是"读权限"的函数，不是"有没有绑定"的函数**：清空绑定 ⇒ 非 admin 调用者
 *     翻 false（creator 仍能读项目元数据与降级投影），而 **admin 恒 true**（Policy 层 bypass）——
 *     ⑭ 的四条断言各钉一角（含 `findAll` 列表路径上的 admin 可见性回归锁：绑定**私有**资源的
 *     项目对 admin 必须照常在列表里、对无绑定权限的 agent 必须不出现）。`provisioningAvailable` 是**部署级**开关（provisioning client 装没装），
 *     与 `items` 无关，零项目也返回（⑭ 用两个 app 的装配差异钉住两个分支——都取**显式钉过
 *     token** 的 app：false 分支用 `appWithoutEngine`，不用主 app——主 app 不 override 该 token
 *     ⇒ 会读 `process.env`，在启用自助开通的机器上假红）。
 *   - **自动注册的三键是派生值**：`workspace_id = project_id = slug`、`binding_id =
 *     binding-http-<slug>`、`actor_id = chamber`、`credential_ref` = 服务端配置值。
 *     e2e 只能验证"服务的唯一输入是 slug，且返回的派生值原样落库"——注册体的 11 字段与
 *     传输头（Origin/幂等键/Cookie）由 `hument-provisioning.client.spec.ts` 钉住。
 *
 * [关联代码]
 *   - src/modules/memory/memory.controller.ts — 12 端点（方法级守卫）
 *   - src/modules/memory/memory-{project,formation,recall,correction}.service.ts — 业务实现
 *   - src/modules/memory/memory-access.service.ts — 三处同源判据的唯一实现
 *   - src/modules/memory/engines/fake.engine.ts — 进程内确定性引擎（本套件默认引擎）
 *   - packages/automcp/src/profile/profile-files.spec.ts — 12 个 operationId 的 profile 守卫
 *
 * [持久踩坑]
 *   MEMORY-E2E-SHARED-DB(共享开发库): 本套件打共享库，且 memory_nominations→memory_projects 是
 *     **ON DELETE RESTRICT**——afterAll 必须**先删账本与遥测、再删项目**，否则残留会让后续
 *     手动清库报 23503（看起来像"数据坏了"）。**claim 表额外一层**：产品语义是"永久不释放"，
 *     但测试夹具必须按**本 run 自建 projectId** 精确清理（⑨ 的失败注入用例若意外成功也登记 id）；
 *     **禁止宽 LIKE workspace**（会误伤 dev 库里的合法永久 claim）。
 *   MEMORY-E2E-CLAIM-SHARED-WORKSPACE(同 workspace 夹具): 平台 claim 唯一键是四列；需要
 *     "两个项目共享同 workspace"的引擎级用例必须换 actorId（FakeEngine 仍只按 workspace
 *     识别记忆），否则第二个 create 会被 409 拦下。
 *   MEMORY-E2E-ENGINE-REPLAY(引擎幂等键): FakeEngine 按 `chamber-<账本id>` 记忆回执，
 *     **不同用例必须用不同的账本行**；复用同一行重放会拿到同一回执（表现为"第二次提名没形成记忆"，
 *     那不是 bug）。
 *   MEMORY-E2E-ENGINE-CONTENT-DEDUP(引擎内容级去重): FakeEngine **按内容去重**（`memories` 表以
 *     `sha256(workspace:content)` 为键），且该实例是**套件级共享、不 reset**——故"同一项目 +
 *     同 workspace 下用同一 `claim(token)` 提名两次" ⇒ 第二次是 **alias**（`duplicate=true`、
 *     ids 恒空），不是"第二条记忆"。要两条独立记忆，**换 token 或换 workspace**。
 *     另：`UPDATE memory_nominations` 只改形成态列即可造"canonical 在途"（引擎侧回执恒 committed，
 *     没有别的表达路径）——不要据此以为形成态是"引擎回执的投影"，它恰恰是**可被镜像的当前态**。
 * =============================================================================
 */

/**
 * Memory 模块 —— 真实 PG + 真实 HTTP 端到端套件（计划 §8 e2e 行）。
 *
 * 为什么不是 mock 链：本模块的风险全在"真库语义"上——`correction_of` 的**部分唯一索引**仲裁、
 * `engine_memory_ids` 的 jsonb 应用层映射（SQL 谓词永不命中，铁律 #23）、`recovery_path`
 * **不在账本表**（扫描排除集只能靠子查询）、`select:false` 的正文取舍、RESTRICT 外键的清理顺序。
 * 这些在 mock 仓储下**一律测不出**。
 *
 * 引擎：默认 FakeEngine（进程内确定性）；需要"失败面/未收敛"时用本文件内的 `ScriptedEngine`
 * 一次性脚本注入（**不把故障开关塞进 FakeEngine**——见该文件头不变量）。
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, type Repository } from 'typeorm';
import request = require('supertest');
import {
  ActorType,
  AgentStatus,
  API_PREFIX,
  ErrorCode,
  MessageType,
  ParticipantStatus,
  TopicParticipantRole,
  UserRole,
} from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { Task } from '../src/database/entities/task.entity';
import { TaskComment } from '../src/database/entities/task-comment.entity';
import { Message } from '../src/database/entities/message.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { MemoryNomination } from '../src/database/entities/memory-nomination.entity';
import { MemoryProject } from '../src/database/entities/memory-project.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { MemoryModule } from '../src/modules/memory/memory.module';
// ⚠️ 显式 import（虽然是 @Global）：MemoryModule 阶段二新增的 provider 注入 HintRegistry，
// 而 @Global 只对「已在应用里注册过」的模块生效——本测试根模块不走 AppModule（见下）
import { HintsModule } from '../src/modules/hints/hints.module';
import { MemoryAccessService } from '../src/modules/memory/memory-access.service';
import { EXCERPT_AREA_PREFIX } from '../src/modules/memory/memory-content.assembler';
import {
  MEMORY_ENGINE_RAW,
  type HumentRecallItem,
  type MemoryEngine,
  type MemoryEngineFailure,
  type MemoryEngineResult,
  type MemoryRecallResult,
} from '../src/modules/memory/engines/memory-engine.interface';
import {
  MEMORY_CONFIG,
  MEMORY_PROVISIONING,
} from '../src/modules/memory/engines/memory-engine.factory';
import {
  HUMENT_PROVISIONING_ACTOR_ID,
  buildProvisioningBindingId,
  buildProvisioningCredentialRef,
  type HumentDisableResult,
  type HumentProvisioningResult,
} from '../src/modules/memory/engines/hument-provisioning.client';
import { FakeEngine } from '../src/modules/memory/engines/fake.engine';
import { EngineHealthTracker } from '../src/modules/memory/engine-health-tracker.service';
// ⑯ 的断言面：告警通道 = notify `system_alert` 端口（卡 5e6cb000 拆掉 Topic 通道后）
import { NotifyOrchestrator } from '../src/modules/notifications/notify-orchestrator.service';
import type { MemoryConfig } from '../src/config/memory.config';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其它套件） */
const JWT_SECRET = 'memory-e2e-secret';

/** 本次运行的唯一后缀：隔离数据（slug/topic 名/正文全带它） */
const RUN = `mem-${Date.now().toString(36)}`;

/**
 * e2e 内联的引擎配置**构造器**（`fake` 只是给"配置面"一个确定值；判据只看 token 是否为 null）。
 *
 * ⚠️ 为什么是构造器而不是常量：配置对象必须在**编译 app 之前**就绪（`MEMORY_CONFIG` 是
 * provider），而 `beforeAll` 里要先做库探测、再编译三组 app。保持构造器形态让"每组 app 一份
 * 独立对象"在将来加运行时派生字段时有地方落。
 *
 * ⚠️ **本套件只覆盖 `MEMORY_ENGINE_RAW`**：自助开通的开关与 socket 路径由 `ConfigService` 的
 * `memory` namespace **独立解析**，override `MEMORY_CONFIG` 不会改变它（`MEMORY_PROVISIONING`
 * 有自己的工厂）。批次 3 要覆盖自动注册分支时必须 `overrideProvider(MEMORY_PROVISIONING)`
 * 注入替身（token 是字符串稳定值），而不是改这里的配置对象。
 *
 * ⚠️ 告警通道（卡 5e6cb000）已不走 Topic：本套件用 `NotifyOrchestrator` 的 spy 替身断言派发，
 * 配置面只剩探针开关（见下）。
 */
function makeMemoryConfig(): MemoryConfig {
  return {
    engine: 'fake',
    humentBaseUrl: 'http://127.0.0.1:1',
    humentTimeoutMs: 90000,
    // 自助开通在本套件内**关闭**（缺 socket 路径 ⇒ `MEMORY_PROVISIONING` 为 null，
    // 创建路径保持"全缺三键 ⇒ 400"的现状语义；批次 3 另加 override 覆盖自动注册分支）
    provisioningEnabled: false,
    operatorSocketPath: null,
    operatorBindingId: 'binding-ops-chamber',
    provisioningTenantId: 'chamber',
    // ⚠️ 探针**关**：本套件不注册 `ScheduleModule`（cron 不跑），探针启用只会让 A 臂永远等
    // 不到"连续 2 次成功"的恢复判据。恢复用例改由**一次成功调用**驱动——那正是探针关闭时的
    // A 臂恢复判据（见 tracker 的事件转移表 `callOk` 行）。探针路本身由 tracker/probe 单测覆盖。
    healthProbeEnabled: false,
    warnings: [],
  };
}

/**
 * 可脚本化的引擎替身：默认**委托给 FakeEngine**，需要"失败面 / 非收敛态"时用一次性 `next`
 * 覆盖下一次 `nominate` 的返回。
 *
 * rationale（见 FakeEngine 文件头不变量）：把故障开关塞进 FakeEngine 会让"fake 通过"与
 * "故障分支通过"混在一个类里，而 FakeEngine 的确定性（内容派生 memory id）是别的用例赖以
 * 成立的前提——故故障注入在**测试侧**做。
 */
class ScriptedEngine implements MemoryEngine {
  readonly name = 'fake';

  /** 一次性脚本（下一位 nominate 直接返回它，返回后清空） */
  next: unknown = null;

  /**
   * `nominate` 调用计数。
   *
   * ⚠️ 专门服务"replay 不调引擎"类断言：一次性 `next` 在第一次调用后**恒为 null**，
   * "哨兵没被消费"没有判别力（第一次调用之后就恒成立）。计数器才有。
   */
  nominateCalls = 0;

  /**
   * 一次性 recall 钩子：**内层结果的后处理**（下一次 recall 调用它一次，用后清空）。
   *
   * 形态是"改内层条目的字段"而不是"现造一个 recall 结果"——理由见 `recall` 方法的写法铁律。
   */
  recallScript: ((items: HumentRecallItem[]) => void) | null = null;

  /**
   * 一次性 correct 失败注入（下一次 `correct` 直接回这条引擎失败面，用后清空）。
   *
   * 为什么放在**测试侧**而不是 FakeEngine：fake 的确定性（内容派生 memory id）是别的用例
   * 赖以成立的前提，故障开关塞进它会让"fake 通过"与"故障分支通过"混为一谈
   * （见 fake.engine.ts 文件头最后一条不变量）。inspect 仍委托内层 ⇒ 未命中，
   * 正好复刻"inspect 未命中 + correct 被拒"的生产形态。
   */
  correctFailure: MemoryEngineFailure | null = null;

  /**
   * **recall 失败队列**（先进先出；空则委托内层）。
   *
   * 用途 = 卡 26c43f52 的告警用例：连续注入 N 次引擎失败（503/401），驱动
   * `EngineHealthTracker` 的连续失败计数。`next` 是"只消费一次"的钩子，驱动不了"连续 5 次"。
   */
  recallQueue: MemoryEngineResult<never>[] = [];

  /** **healthCheck 结果队列**（先进先出；空则委托内层 —— FakeEngine 恒 ok） */
  healthQueue: MemoryEngineResult<never>[] = [];

  /** `healthCheck` 调用计数（探针用例可断言"真的探了"） */
  healthCalls = 0;

  private readonly inner = new FakeEngine();

  reset(): void {
    this.next = null;
    this.nominateCalls = 0;
    this.recallScript = null;
    this.correctFailure = null;
    this.recallQueue.length = 0;
    this.healthQueue.length = 0;
    this.healthCalls = 0;
    this.inner.reset();
  }

  nominate(target: never, input: never): never {
    this.nominateCalls += 1;
    if (this.next) {
      const scripted = this.next;
      this.next = null;
      return scripted as never;
    }
    return this.inner.nominate(target, input) as never;
  }

  inspectNomination(target: never, input: never): never {
    return this.inner.inspectNomination(target, input) as never;
  }

  /**
   * 召回：默认委托内层（FakeEngine）；`recallScript` 提供"下一次召回的一次性后处理"。
   *
   * ⚠️ **写法铁律**（score 端到端透传用例能成立的前提）：钩子必须是**内层结果的后处理**，
   * 不能"现造一个 recall 结果"——服务层拿条目的 `memory_id` 去账本映射
   * （`memory-access.service.ts` 的 `loadMemoryIdMapping`；该方法本批已从
   * memory-recall.service 下沉到权限内核，读面是第二个消费方），现造结果里的 memory_id 映射不到
   * 本项目 committed 行 ⇒ 条目被丢进 unmapped ⇒ `items` 空 ⇒ 断言到不了响应（自欺）。
   * 所以这里先 `await inner.recall(...)`（FakeEngine 按本项目已提名记忆产出**真实**条目），
   * 再让钩子改它的字段。
   */
  async recall(target: never, input: never): Promise<never> {
    // 队列优先：告警用例要"连续 N 次失败"（`recallScript` 是后处理钩子，造不出失败面）
    const queued = this.recallQueue.shift();
    if (queued) return queued as never;

    const result = (await this.inner.recall(
      target,
      input,
    )) as MemoryEngineResult<MemoryRecallResult>;
    if (this.recallScript) {
      const script = this.recallScript;
      this.recallScript = null; // 一次性：先清空，脚本抛错也不会二次消费
      if (result.ok) script(result.value.items);
    }
    return result as never;
  }

  correct(target: never, input: never): never {
    // 一次性失败注入优先于内层（用后清空 ⇒ 后续 retry 会真正达成链接）
    if (this.correctFailure) {
      const failure = this.correctFailure;
      this.correctFailure = null;
      return { ok: false, failure } as never;
    }
    return this.inner.correct(target, input) as never;
  }

  inspectCorrection(target: never, input: never): never {
    return this.inner.inspectCorrection(target, input) as never;
  }

  readMemory(target: never, memoryId: never): never {
    return this.inner.readMemory(target, memoryId) as never;
  }

  // ⚠️ 五个**投影读面**（alpha.5 四个 + alpha.6 关系建议）：本替身**直接委托**内层
  // （它们的行为是确定的读语义，不需要脚本钩子）；不委托的话 `implements MemoryEngine`
  // 当场编译红（jest-e2e 的 ts-jest 未关 diagnostics）。若某个用例需要读面的失败面
  // （如 snapshot_stale），走 FakeEngine 自身的游标语义或另加一次性钩子——**别**把故障开关
  // 塞进 FakeEngine。
  getGraphView(target: never, query: never): never {
    return this.inner.getGraphView(target, query) as never;
  }

  getMemoryView(target: never, memoryId: never, query: never): never {
    return this.inner.getMemoryView(target, memoryId, query) as never;
  }

  getMemoryViewHistory(target: never, memoryId: never, resolution: never, query: never): never {
    return this.inner.getMemoryViewHistory(target, memoryId, resolution, query) as never;
  }

  getMemoryViewRepresentation(target: never, memoryId: never, representationId: never): never {
    return this.inner.getMemoryViewRepresentation(target, memoryId, representationId) as never;
  }

  // ⚠️ **alpha.6 关系建议读面**：同四个 view 读面——本替身**直接委托**内层（读语义确定，
  // 不需要脚本钩子）；不委托的话 `implements MemoryEngine` 当场编译红。
  getMemoryRelations(target: never, memoryId: never): never {
    return this.inner.getMemoryRelations(target, memoryId) as never;
  }

  // ⚠️ alpha.19 usage 两读面：本替身**直接委托**内层（FakeEngine 的确定性 usage 派生）；
  // 不委托 = `implements MemoryEngine` 编译红。故障面（旧 Hub 404 / 429）由
  // `test/memory-usage.e2e-spec.ts` 的 ScriptedUsageEngine 注入。
  getUsageSummary(target: never, query: never): never {
    return this.inner.getUsageSummary(target, query) as never;
  }

  getUsageTrace(target: never, query: never): never {
    return this.inner.getUsageTrace(target, query) as never;
  }

  /**
   * 就绪探测：队列优先（告警用例注入探针失败），否则委托内层（FakeEngine 恒 ok）。
   *
   * ⚠️ 本替身替换的是 `MEMORY_ENGINE_RAW`：包装层仍由工厂套上 ⇒ 上报路径在 e2e 里是真实的。
   */
  async healthCheck(): Promise<MemoryEngineResult<void>> {
    this.healthCalls += 1;
    const queued = this.healthQueue.shift();
    if (queued) return queued as never;
    return this.inner.healthCheck();
  }
}

/** 引擎替身实例（套件级共享：`next` 是"下一次调用"的一次性脚本） */
const scriptedEngine = new ScriptedEngine();

/**
 * 可脚本化的**自助开通**替身（二期；评审 N-10）。
 *
 * 装配面：`MEMORY_PROVISIONING` 是**独立 token**（由 `ConfigService` 的 memory namespace
 * 单独解析，与 `MEMORY_ENGINE` / `MEMORY_CONFIG` 无关）——所以这里 override 的是它自己，
 * 改 `E2E_MEMORY_CONFIG` 对它无效。
 *
 * 形状：只需 `provision(slug)`（服务层唯一的调用面）。真客户端在内部装配 11 字段注册体与
 * 传输头，那部分由 `hument-provisioning.client.spec.ts` 逐字段钉住；本替身按**同一套派生规则**
 * 回填成功面（`workspace_id = project_id = slug` / `actor_id = chamber` / `credential_ref` =
 * 配置值），于是 e2e 能证"派生三键原样流过服务层并落库"。
 */
class ScriptedProvisioning {
  /** 收到过的 slug（按调用顺序）——"零注册调用"类断言直接读它 */
  readonly calls: string[] = [];

  /** 每次 provision 收到的 `displayName`（与 `calls` 同序；未传 = undefined） */
  readonly displayNames: Array<string | undefined> = [];

  /** 收到过的孤儿善后 slug（按调用顺序）——"disable 是否被调"直接读它 */
  readonly disableCalls: string[] = [];

  /** 一次性脚本（下一次调用返回它，用后清空）；null = 按派生规则成功 */
  next: HumentProvisioningResult | null = null;

  /** 孤儿善后的一次性脚本（下一次 disableProject 返回它，用后清空）；null = 成功面 */
  nextDisable: HumentDisableResult | null = null;

  /** true = 被调用即抛错（"绝不应被调用"的用例：一旦被调到，失败必须响亮而不是静默计数） */
  throwOnCall = false;

  reset(): void {
    this.calls.length = 0;
    this.displayNames.length = 0;
    this.disableCalls.length = 0;
    this.next = null;
    this.nextDisable = null;
    this.throwOnCall = false;
  }

  /** 注册（真客户端的三步链在这里被整体替换：e2e 不碰 socket / Hub） */
  async provision(slug: string, displayName?: string): Promise<HumentProvisioningResult> {
    this.calls.push(slug);
    this.displayNames.push(displayName);
    if (this.throwOnCall) {
      throw new Error(
        `Unexpected provisioning call for slug '${slug}' — this path must not register`,
      );
    }
    if (this.next) {
      const scripted = this.next;
      this.next = null;
      return scripted;
    }
    return {
      ok: true,
      value: {
        workspaceId: slug,
        actorId: HUMENT_PROVISIONING_ACTOR_ID,
        // 与真客户端同一套派生规则（单源 = buildProvisioningCredentialRef）
        credentialRef: buildProvisioningCredentialRef(slug),
        replay: false,
      },
    };
  }

  /** 孤儿善后（真客户端的生命周期 PATCH 在这里被整体替换：e2e 不碰 Hub） */
  async disableProject(slug: string): Promise<HumentDisableResult> {
    this.disableCalls.push(slug);
    if (this.nextDisable) {
      const scripted = this.nextDisable;
      this.nextDisable = null;
      return scripted;
    }
    return { ok: true, value: { state: 'disabled', replay: false } };
  }
}

/** 自助开通替身实例（套件级共享；⑬ 每个用例前 `reset()`） */
const scriptedProvisioning = new ScriptedProvisioning();

/**
 * `memory_projects` 仓储的**可控代理**（⑬ 孤儿善后专用）。
 *
 * 除 `save` 外全部透传给真仓储，`save` 在 `saveFailure.enabled` 打开时抛一个真实形态的 PG
 * 错误——用来在 e2e 里**确定性**地走到"provision 成功但 save 失败"的孤儿路径
 * （真 PG 上不并发很难造出 23505；PG 抖动一类的失败更没法按需触发）。
 */
const saveFailure = { enabled: false };

/**
 * 可控 save 失败代理（⑬ 孤儿善后）。
 *
 * ⚠️ 服务层现在在 `projects.manager.transaction()` 内用 `manager.getRepository(MemoryProject).save`
 * 落库（claim 与项目必须同事务），**只代理仓储 provider 的 `save` 已经拦不到事务内的写**。
 * 因此这里同时代理 `manager`：事务回调里的 `MemoryProject` 仓储仍指向同一个可控 save 代理，
 * 其余实体透明委托给真实事务 manager。
 */
function withFailingSave<T extends object>(real: T): T {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'save') {
        return async (...args: unknown[]): Promise<unknown> => {
          if (saveFailure.enabled) {
            // 形态对齐一次真实的 PG 失败（非 23505）：服务层必须原样透出 + 仍记孤儿
            throw Object.assign(new Error('forced save failure'), { code: '40001' });
          }
          return (target as unknown as { save: (...a: unknown[]) => unknown }).save.apply(
            target,
            args,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as T;
}

function failingSaveRepo(real: Repository<MemoryProject>): Repository<MemoryProject> {
  const repo = withFailingSave(real);
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'manager') {
        return {
          // 事务外的 getRepository 也要能路由（F1 的派生三元组预查用）
          getRepository: (entity: unknown): unknown =>
            entity === MemoryProject ? repo : real.manager.getRepository(entity as never),
          // 保留真实 TypeORM 两个 overload，显式隔离级别不能被当成回调。
          transaction: async (
            isolationOrRun:
              | Parameters<typeof real.manager.transaction>[0]
              | ((manager: { getRepository: (entity: unknown) => unknown }) => Promise<unknown>),
            runWithIsolation?: (manager: {
              getRepository: (entity: unknown) => unknown;
            }) => Promise<unknown>,
          ): Promise<unknown> => {
            const run = typeof isolationOrRun === 'function' ? isolationOrRun : runWithIsolation!;
            const execute = async (txManager: typeof real.manager) => {
              const scoped = {
                getRepository: (entity: unknown): unknown =>
                  entity === MemoryProject
                    ? withFailingSave(txManager.getRepository(MemoryProject))
                    : txManager.getRepository(entity as never),
              };
              return run(scoped);
            };
            return typeof isolationOrRun === 'function'
              ? real.manager.transaction(execute)
              : real.manager.transaction(isolationOrRun, execute);
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Repository<MemoryProject>;
}

/** 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态：方法级 guard 在**声明它的模块**上下文实例化） */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get('jwt.secret'),
        signOptions: { expiresIn: '2h' },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([User, ApiKey, Agent]),
  ],
  providers: [JwtStrategy, ApiKeyAuthService, JwtAuthGuard, JwtOrApiKeyGuard, RolesGuard],
  exports: [
    JwtModule,
    PassportModule,
    TypeOrmModule,
    ApiKeyAuthService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    RolesGuard,
  ],
})
class MemoryE2eAuthModule {}

/** 测试根模块：真库 + 真认证 + 被验证的 MemoryModule */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: false,
    }),
    MemoryE2eAuthModule,
    CommonModule,
    PermissionModule,
    // ⚠️ **MemoryModule 现在 import NotificationsModule**（引擎运行时告警的推送端口）⇒
    // Notifications 的 `NotifyOrchestrator` 用 `@OnEvent` 订阅事件，需要 `EventEmitter2`。
    // 生产由 app.module 的 `EventEmitterModule.forRoot()` 提供；本测试根模块不走 AppModule，
    // 必须自己注册（否则编译期 "can't resolve EventEmitter"——卡 26c43f52 首次运行实测）。
    EventEmitterModule.forRoot(),
    MemoryModule,
    // ⚠️ **必须显式 import**（虽然它是 @Global）：MemoryModule 阶段二新增的
    // `MemoryNominationHintProvider` 注入 `HintRegistry`（去重窗口长度单源），
    // 而 `@Global` 只对"已在应用里注册过"的模块生效——本测试根模块不走 AppModule，
    // 不 import 它就没有 HintsModule，启动期报 "can't resolve ... HintRegistry"。
    // 生产同款：app.module.ts 的 imports 里有 HintsModule。
    HintsModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }],
})
class MemoryE2eModule {}

/** 响应信封 */ interface Envelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
  requestId: string;
}

describe('Memory 模块 — 真实 PG + 真实 HTTP 集成（计划 §8 e2e 行）', () => {
  let app: INestApplication;
  /** 未配引擎的第二个 app（**双组形状的第二组**：本地读 200 / 引擎动词 503） */
  let appWithoutEngine: INestApplication;
  /** 启用了自助开通的第三个 app（⑬：`MEMORY_PROVISIONING` = 脚本替身） */
  let appWithProvisioning: INestApplication;
  let ds: DataSource;
  let jwtService: JwtService;
  let dbAvailable = false;

  /** 主 actor（fixture 的创建者；同时是项目 creator ⇒ 治理观察者） */
  let agentAId: string;
  let agentAKey: string;
  /** 外部 actor（非创建者、非成员 ⇒ 用于负向权限用例） */
  let agentBId: string;
  let agentBKey: string;
  let agentBOwnerId: string;

  /**
   * 系统告警端口的 spy 替身（⑯ 的断言面）。
   *
   * 为什么替身而不是真编排器：真实现会读库（admin 账号 / 渠道）并按 `NOTIFY_ENABLED` 出走。
   * e2e 只需要证"tracker 有没有按臂/按种类把告警交给端口"——出境链路由 notifications 自己的
   * 套件覆盖（`notify-orchestrator.service.spec.ts` / `notifications.e2e-spec.ts`）。
   * 告警派发是 fire-and-forget，故 ⑯ 的断言同样要**有界轮询**（见 `waitForAlert`）。
   */
  const notifyStub = { sendSystemAlert: jest.fn().mockResolvedValue('delivered') };

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
    projectIds: [] as string[],
    topicIds: [] as string[],
    boardIds: [] as string[],
    listIds: [] as string[],
    taskIds: [] as string[],
    commentIds: [] as string[],
    messageIds: [] as string[],
    spaceIds: [] as string[],
    docIds: [] as string[],
  };

  /** 夹具 id（本套件共用；afterAll 按上面的登记清理） */
  const fx = {
    topicOpen: '',
    topicOther: '',
    messageInTopicOther: '',
    messageInTopicOpen: '',
    board: '',
    list: '',
    task: '',
    comment: '',
    space: '',
    doc: '',
    docSection: '',
  };

  const testStartedAt = new Date();

  // ─── HTTP 助手 ───────────────────────────────────────────────────

  /**
   * 造一个"带身份的三动词"助手（本套件全部走 agent 通道 = 真 sha256 API Key 校验）。
   *
   * @param appUnderTest 目标 app（主 app 或"未配引擎"的第二个 app）
   * @param key agent 的明文 key
   */
  function req(appUnderTest: INestApplication, key: string) {
    return {
      get: (path: string) =>
        request(appUnderTest.getHttpServer()).get(`${API_PREFIX}${path}`).set('X-API-Key', key),
      post: (path: string) =>
        request(appUnderTest.getHttpServer()).post(`${API_PREFIX}${path}`).set('X-API-Key', key),
      patch: (path: string) =>
        request(appUnderTest.getHttpServer()).patch(`${API_PREFIX}${path}`).set('X-API-Key', key),
    };
  }

  /** 造项目（默认 engine=hument + 三元组，绑定 topicOpen） */
  async function createProject(
    overrides: Record<string, unknown> = {},
    appUnderTest: INestApplication = app,
    key: string = agentAKey,
  ): Promise<string> {
    const res = await req(appUnderTest, key)
      .post('/memory/projects')
      .send({
        slug: `p-${RUN}-${created.projectIds.length}`,
        name: `project ${RUN} #${created.projectIds.length}`,
        bindings: [{ type: 'topic', id: fx.topicOpen }],
        engine: 'hument',
        engineWorkspaceId: `ws-${RUN}-${created.projectIds.length}`,
        engineActorId: 'chamber-service-actor',
        engineCredentialRef: `cred-ref-${RUN}`,
        ...overrides,
      });
    if (res.status !== 201) {
      throw new Error(`createProject failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const id = res.body.data.id as string;
    created.projectIds.push(id);
    return id;
  }

  /** 提名（默认 agent A；返回原始响应以便断言状态码） */
  function nominate(
    projectId: string,
    body: Record<string, unknown>,
    appUnderTest: INestApplication = app,
    key: string = agentAKey,
  ) {
    return req(appUnderTest, key).post(`/memory/projects/${projectId}/nominations`).send(body);
  }

  /**
   * 造一条"标准主张"载荷（正文由服务端装配；`token` 是唯一串，用来做召回的子串命中）。
   *
   * ⚠️ `token` 必须**每次不同**：FakeEngine 的 memory id 由内容派生，同内容 ⇒ 同 memory id
   * ⇒ 两行争同一 id（映射 fail-closed）。需要"未收敛/失败"的用例另用 `scriptedEngine.next`。
   */
  function claim(token: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      category: 'ruling',
      subject: `主张 ${token}`,
      scope: `适用范围 ${RUN}`,
      effectiveNote: '自本批次起生效',
      rationale: `理由 ${token}`,
      ...overrides,
    };
  }

  // ─── 身份与夹具 ───────────────────────────────────────────────────

  async function createHuman(role: UserRole, seq: number, label: string): Promise<string> {
    const displayName = `Mem ${label} ${RUN} #${seq}`;
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        actor,
        username: `memory${RUN}${seq}`.slice(0, 50),
        email: `memory-${RUN}-${seq}@example.com`,
        authProvider: 'local',
        role,
        preferences: {},
      }),
    );
    created.userIds.push(user.id);
    return user.id;
  }

  async function createAgentWithKey(
    seq: number,
    ownerUserId?: string,
  ): Promise<{ agentId: string; apiKey: string }> {
    const owner = ownerUserId ?? (await createHuman(UserRole.EDITOR, seq + 300, 'Owner'));
    const displayName = `Mem Agent ${RUN} #${seq}`;
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner,
        name: displayName,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    const rawKey = `ask_mem${RUN}${String(seq).padStart(3, '0')}`;
    const key = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner,
      }),
    );
    created.keyIds.push(key.id);
    return { agentId: agent.id, apiKey: rawKey };
  }

  /** 造话题（`settings.visibility` 决定 open 白名单来源） */
  async function createTopic(creatorId: string, visibility: 'open' | 'private'): Promise<string> {
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `memory topic ${RUN} ${visibility} ${created.topicIds.length}`,
        creatorId,
        settings: { visibility },
        participantCount: 0,
        messageCount: 0,
      }),
    );
    created.topicIds.push(topic.id);
    return topic.id;
  }

  /** 造看板 + 列 + 任务 + 评论（来源父链 task→list→board / comment→task→list→board） */
  async function createBoardChain(creatorId: string): Promise<void> {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `memory board ${RUN}`,
        creatorId,
        settings: { visibility: 'open' },
        taskCount: 0,
        completedTaskCount: 0,
      }),
    );
    created.boardIds.push(board.id);
    fx.board = board.id;

    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: `memory list ${RUN}`,
        position: 0,
      }),
    );
    created.listIds.push(list.id);
    fx.list = list.id;

    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `memory task ${RUN} token-task`,
        description: `任务描述 ${RUN}`,
        position: 0,
        customFields: {},
      }),
    );
    created.taskIds.push(task.id);
    fx.task = task.id;

    const comment = await ds.getRepository(TaskComment).save(
      ds.getRepository(TaskComment).create({
        taskId: task.id,
        authorId: creatorId,
        content: `评论正文 ${RUN}`,
      }),
    );
    created.commentIds.push(comment.id);
    fx.comment = comment.id;
  }

  /** 造文档空间 + 文档 + 首节（来源父链 doc→space；`content_hash` 是 `moved` 判据） */
  async function createDocChain(creatorId: string): Promise<void> {
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `memory space ${RUN}`,
        slug: `memory-space-${RUN}`,
        creatorId,
        settings: { visibility: 'open' },
        docCount: 1,
      }),
    );
    created.spaceIds.push(space.id);
    fx.space = space.id;

    const doc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId: space.id,
        path: `docs/memory-${RUN}.md`,
        title: `记忆来源文档 ${RUN}`,
        createdBy: creatorId,
        contentHash: 'frozenhash0000000000000000000000000000001',
        source: 'native',
        tags: [],
        sectionCount: 1,
        tokenEstimate: 10,
      }),
    );
    created.docIds.push(doc.id);
    fx.doc = doc.id;

    const section = await ds.getRepository(DocSection).save(
      ds.getRepository(DocSection).create({
        docId: doc.id,
        position: 0,
        headingPath: `正文 § 依据 ${RUN}`,
        headingText: `依据 ${RUN}`,
        headingLevel: 1,
        content: `关键依据摘录正文 ${RUN}`,
      }),
    );
    fx.docSection = section.id;
  }

  /** 造话题消息（来源父链 message→topic 的叶子） */
  async function createMessage(
    topicId: string,
    senderId: string,
    content: string,
  ): Promise<string> {
    const message = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId,
        senderId,
        content,
        // `type` 是 PG enum 列（值域 MessageType）；其余列走实体缺省，只显式给非空项
        type: MessageType.CHAT,
        metadata: {},
        editHistory: [],
        replyCount: 0,
      }),
    );
    created.messageIds.push(message.id);
    return message.id;
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[memory e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }

    // 表必须在（迁移链产物）——缺表即环境未跑迁移，显式失败而非静默跳过
    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
        ('memory_projects','memory_nominations','memory_formation_events','memory_recall_events','memory_engine_binding_claims')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'memory_engine_binding_claims',
      'memory_formation_events',
      'memory_nominations',
      'memory_projects',
      'memory_recall_events',
    ]);
    dbAvailable = true;

    // ── 身份夹具先建（话题/看板/文档的 creator）──
    const agentA = await createAgentWithKey(1);
    agentAId = agentA.agentId;
    agentAKey = agentA.apiKey;
    const agentBOwner = await createHuman(UserRole.EDITOR, 2, 'OtherOwner');
    agentBOwnerId = agentBOwner;
    const agentB = await createAgentWithKey(3, agentBOwner);
    agentBId = agentB.agentId;
    agentBKey = agentB.apiKey;

    // 引擎配置（告警通道 = notify 端口替身，配置面只剩探针开关）
    const memoryConfig = makeMemoryConfig();

    // ── 主 app（引擎 = 可脚本替身，默认 FakeEngine 行为）──
    // ⚠️ override 的是 **`MEMORY_ENGINE_RAW`**（裸引擎）：包装层 `InstrumentedMemoryEngine`
    // 仍由工厂套上 ⇒ 健康上报在 e2e 里是真实执行的（见 memory-engine.interface.ts 双 token 不变量）
    const moduleRef = await Test.createTestingModule({ imports: [MemoryE2eModule] })
      .overrideProvider(MEMORY_ENGINE_RAW)
      .useValue(scriptedEngine)
      .overrideProvider(MEMORY_CONFIG)
      .useValue(memoryConfig)
      // ⑯ 的断言面：告警通道 = notify 端口（spy 替身；真实现会读库/出境）
      .overrideProvider(NotifyOrchestrator)
      .useValue(notifyStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    // ── 第二组：**未配引擎**（token = null）──
    // 这一组是本模块最重要的产品契约：memory 是可选增强，"没配"不等于"站点坏了"
    const noEngineRef = await Test.createTestingModule({ imports: [MemoryE2eModule] })
      .overrideProvider(MEMORY_ENGINE_RAW)
      .useValue(null)
      .overrideProvider(MEMORY_CONFIG)
      .useValue(memoryConfig)
      // ⑯ 负向断言需要同一只 spy（"未配置 ≠ 故障"的零告警保证）
      .overrideProvider(NotifyOrchestrator)
      .useValue(notifyStub)
      // 显式钉住"自助开通也不可用"（⑬ 用例 6）：不 override 时它同样落到 config 兜底 ⇒ null，
      // 但显式写出来 = 这条断言不随 `resolveMemoryConfig` 兜底形状的变化而悄悄改变含义
      .overrideProvider(MEMORY_PROVISIONING)
      .useValue(null)
      .compile();
    appWithoutEngine = noEngineRef.createNestApplication();
    appWithoutEngine.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    appWithoutEngine.setGlobalPrefix(API_PREFIX);
    await appWithoutEngine.init();

    // ── 第三组：**启用了自助开通**（`MEMORY_PROVISIONING` = 脚本替身）──
    // ⑬ 专用：自动注册是**另一个 token** 的分支，混进主 app 会让"既有用例的 create 走哪条路"
    // 变得依赖替身是否被调（隐性耦合）。独立一个 app = 既有 12 组的行为零变化。
    const provisioningRef = await Test.createTestingModule({ imports: [MemoryE2eModule] })
      .overrideProvider(MEMORY_ENGINE_RAW)
      .useValue(scriptedEngine)
      .overrideProvider(MEMORY_CONFIG)
      .useValue(memoryConfig)
      .overrideProvider(MEMORY_PROVISIONING)
      .useValue(scriptedProvisioning)
      // 同一只告警 spy（本 app 不跑 ⑯，但保持三组装配同形：任何一组漏 override 都会让
      // 告警走上真编排器 —— 在 NOTIFY_ENABLED=true 的机器上会真的出境）
      .overrideProvider(NotifyOrchestrator)
      .useValue(notifyStub)
      // ⑬ 孤儿善后：仓储走"可控代理"，`saveFailure.enabled` 打开时 save 抛错
      // （除 save 外全透明，故既有 ⑬ 用例行为零变化）
      .overrideProvider(getRepositoryToken(MemoryProject))
      .useValue(failingSaveRepo(ds.getRepository(MemoryProject)))
      .compile();
    appWithProvisioning = provisioningRef.createNestApplication();
    appWithProvisioning.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    appWithProvisioning.setGlobalPrefix(API_PREFIX);
    await appWithProvisioning.init();

    // 本套件的 JWT 通道（⑭ 的 admin bypass 用例要签 admin token——agent 通道不填 role）
    jwtService = app.get(JwtService);

    // 夹具：A 的开放话题（绑定用）、B 的开放话题（稍后翻私密，用于负向权限）
    fx.topicOpen = await createTopic(agentAId, 'open');
    fx.topicOther = await createTopic(agentBId, 'open');
    fx.messageInTopicOpen = await createMessage(fx.topicOpen, agentAId, `A 的原始来源 ${RUN}`);
    fx.messageInTopicOther = await createMessage(fx.topicOther, agentBId, `B 私密来源 ${RUN}`);
    await createBoardChain(agentAId);
    await createDocChain(agentAId);
  }, 180000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (app) await app.close();
    if (appWithoutEngine) await appWithoutEngine.close();
    if (appWithProvisioning) await appWithProvisioning.close();

    // ⚠️ 清理顺序（见文件头踩坑）：claim → 遥测（无 FK）→ 账本 → 项目（RESTRICT）→ 内容 → 身份
    // claim 在产品语义上**永久不释放**（项目硬删也保留）；但本套件的夹具必须按**本 run 自建
    // 的 projectId** 精确清理。⚠️ 禁止用宽 LIKE 匹配 workspace（会误伤 dev 库里的合法永久 claim）；
    // ⑨ 的失败注入用例若意外成功也会登记 projectId（见该用例），保证 id 集合完整。
    if (created.projectIds.length > 0) {
      await ds.query(
        `DELETE FROM memory_engine_binding_claims WHERE project_id = ANY($1::uuid[])`,
        [created.projectIds],
      );
    }
    if (created.projectIds.length > 0) {
      await ds.query(`DELETE FROM memory_formation_events WHERE project_id = ANY($1::uuid[])`, [
        created.projectIds,
      ]);
      await ds.query(`DELETE FROM memory_recall_events WHERE project_id = ANY($1::uuid[])`, [
        created.projectIds,
      ]);
      await ds.query(`DELETE FROM memory_nominations WHERE project_id = ANY($1::uuid[])`, [
        created.projectIds,
      ]);
      await ds.query(`DELETE FROM memory_projects WHERE id = ANY($1::uuid[])`, [
        created.projectIds,
      ]);
    }
    if (created.commentIds.length > 0) {
      await ds.query(`DELETE FROM task_comments WHERE id = ANY($1::uuid[])`, [created.commentIds]);
    }
    if (created.taskIds.length > 0) {
      await ds.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [created.taskIds]);
    }
    if (created.listIds.length > 0) {
      await ds.query(`DELETE FROM board_lists WHERE id = ANY($1::uuid[])`, [created.listIds]);
    }
    if (created.boardIds.length > 0) {
      await ds.query(`DELETE FROM boards WHERE id = ANY($1::uuid[])`, [created.boardIds]);
    }
    if (created.messageIds.length > 0) {
      await ds.query(`DELETE FROM messages WHERE id = ANY($1::uuid[])`, [created.messageIds]);
    }
    if (created.docIds.length > 0) {
      await ds.query(`DELETE FROM doc_sections WHERE doc_id = ANY($1::uuid[])`, [created.docIds]);
      await ds.query(`DELETE FROM docs WHERE id = ANY($1::uuid[])`, [created.docIds]);
    }
    if (created.spaceIds.length > 0) {
      await ds.query(`DELETE FROM doc_spaces WHERE id = ANY($1::uuid[])`, [created.spaceIds]);
    }
    if (created.topicIds.length > 0) {
      await ds.query(`DELETE FROM topics WHERE id = ANY($1::uuid[])`, [created.topicIds]);
    }
    for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.userIds) await ds.getRepository(User).delete({ id });
    for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
    await ds.destroy();
  }, 120000);

  // ══════════════════════════════════════════════════════════════════
  // ① 引擎闸双组：**未配引擎**（本地读 200 / 引擎动词 503）
  // ══════════════════════════════════════════════════════════════════

  describe('① 引擎闸双组（未配引擎时 Chamber 完全可用）', () => {
    let projectId = '';

    it('本地数据端点照常 200：创建项目（engine=none）+ 列表 + 详情', async () => {
      if (!dbAvailable) return;

      const createdRes = await req(appWithoutEngine, agentAKey)
        .post('/memory/projects')
        .send({
          slug: `noengine-${RUN}`,
          name: `未配引擎的项目 ${RUN}`,
          bindings: [{ type: 'topic', id: fx.topicOpen }],
          engine: 'none',
        });
      expect(createdRes.status).toBe(201);
      const envelope = createdRes.body as Envelope<{ id: string; engineAvailability: unknown }>;
      projectId = envelope.data.id;
      created.projectIds.push(projectId);
      // 绑定引擎列被强制 null（不允许"半配置"）；reason 由**全局**配置态决定：
      // 本 app 的引擎 token 是 null ⇒ not_configured（"本项目未绑"是另一个 app 的场景，见 ②）
      expect(envelope.data.engineAvailability).toEqual({
        engine: 'none',
        available: false,
        reason: 'not_configured',
      });

      const list = await req(appWithoutEngine, agentAKey).get('/memory/projects');
      expect(list.status).toBe(200);
      expect((list.body as Envelope<{ total: number }>).data.total).toBeGreaterThan(0);

      const detail = await req(appWithoutEngine, agentAKey).get(`/memory/projects/${projectId}`);
      expect(detail.status).toBe(200);
      expect(
        (detail.body as Envelope<{ engineAvailability: { reason: string } }>).data
          .engineAvailability.reason,
      ).toBe('not_configured');
    });

    it('引擎动词 503 + 结构化 reason=not_configured（**全局未配**，非本项目未绑）', async () => {
      if (!dbAvailable) return;

      const res = await nominate(projectId, claim(`no-engine-${RUN}`), appWithoutEngine, agentAKey);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe(ErrorCode.MEMORY_UNAVAILABLE);
      expect(res.body.data.reason).toBe('not_configured');
      expect(res.body.message).toContain('not configured');
    });

    it('召回 503（引擎动词组）+ 落一行遥测（unavailable）', async () => {
      if (!dbAvailable) return;

      const before = (await ds.query(
        `SELECT count(*)::int AS n FROM memory_recall_events WHERE project_id = $1`,
        [projectId],
      )) as { n: number }[];

      const res = await req(appWithoutEngine, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: 'x', contextIdentity: `ctx-${RUN}`, contextEpoch: 0 });
      expect(res.status).toBe(503);
      expect(res.body.data.reason).toBe('not_configured');

      const after = (await ds.query(
        `SELECT count(*)::int AS n FROM memory_recall_events WHERE project_id = $1`,
        [projectId],
      )) as { n: number }[];
      // 失败也落一行（本表是引擎可用性的分母）
      expect(after[0].n).toBe(before[0].n + 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ② 引擎已配但本项目未绑（project_engine_unbound）
  // ══════════════════════════════════════════════════════════════════

  describe('② 引擎已配但本项目未绑', () => {
    it('nominate 503 + reason=project_engine_unbound（与 not_configured 分码）', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject({ engine: 'none' });
      const res = await nominate(projectId, claim(`unbound-${RUN}`));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe(ErrorCode.MEMORY_UNAVAILABLE);
      expect(res.body.data.reason).toBe('project_engine_unbound');
      expect(res.body.message).toContain('no engine bound');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ③ 全链路：项目 → 提名 → 账本 → 召回（FakeEngine 确定性）
  // ══════════════════════════════════════════════════════════════════

  describe('③ 全链路（FakeEngine）', () => {
    let projectId = '';
    const token = `chain-${RUN}`;

    it('提名 ⇒ 201 committed（采纳 ids / contentTruncated / hint）', async () => {
      if (!dbAvailable) return;

      projectId = await createProject();
      const res = await nominate(projectId, claim(token));
      expect(res.status).toBe(201);
      const body = res.body as Envelope<{
        ledgerId: string;
        formationState: string;
        status: string;
        engineMemoryIds: string[];
        contentTruncated: boolean;
        replay: boolean;
        hintCode: string | null;
        engineAvailability: { available: boolean; reason: string | null };
      }>;
      expect(body.data.formationState).toBe('committed');
      expect(body.data.status).toBe('active');
      expect(body.data.engineMemoryIds).toHaveLength(1);
      expect(body.data.contentTruncated).toBe(false);
      expect(body.data.replay).toBe(false);
      expect(body.data.hintCode).toBe('committed');
      expect(body.data.engineAvailability.available).toBe(true);
      expect(body.data.engineAvailability.reason).toBeNull();

      // 账本行确已落库，且正文是**服务端装配产物**（三要素 + 理由 + 无摘录区）
      const row = (await ds.query(
        `SELECT content, formation_state, engine_memory_ids FROM memory_nominations WHERE id = $1`,
        [body.data.ledgerId],
      )) as { content: string; formation_state: string; engine_memory_ids: string[] }[];
      expect(row[0].formation_state).toBe('committed');
      expect(row[0].content).toContain(`[ruling] 主张 ${token}`);
      expect(row[0].content).toContain('范围: 适用范围');
      expect(row[0].content).toContain(`理由: 理由 ${token}`);
      expect(row[0].content).not.toContain(EXCERPT_AREA_PREFIX);
    });

    it('幂等：同 clientRequestId 重发返回首次结果（replay=true，无二次形成）', async () => {
      if (!dbAvailable) return;

      const key = `idem-${RUN}`;
      const first = await nominate(projectId, claim(`idem-a-${RUN}`, { clientRequestId: key }));
      expect(first.status).toBe(201);
      const firstLedger = (first.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      const second = await nominate(projectId, claim(`idem-b-${RUN}`, { clientRequestId: key }));
      expect(second.status).toBe(201);
      const secondBody = second.body as Envelope<{ ledgerId: string; replay: boolean }>;
      // 同 key ⇒ 返回**首次**那行，且没有二次形成
      expect(secondBody.data.ledgerId).toBe(firstLedger);
      expect(secondBody.data.replay).toBe(true);

      const count = (await ds.query(
        `SELECT count(*)::int AS n FROM memory_nominations WHERE project_id = $1 AND client_request_id = $2`,
        [projectId, key],
      )) as { n: number }[];
      expect(count[0].n).toBe(1);
    });

    it('召回：全字段契约 + 信任框信封 + emptyReason=none', async () => {
      if (!dbAvailable) return;

      const res = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `ctx-${RUN}`, contextEpoch: 1 });
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{
        items: Array<{
          memoryId: string;
          ledgerId: string;
          category: string;
          subject: string;
          scope: string;
          body: string;
          kind: string;
          resolution: string;
          status: string;
          /** 引擎词面命中排序权重（仅同次召回内可比，非置信度——见 controller @ApiOperation） */
          score: number;
          derivation: string;
          contentTruncated: boolean;
          reviewDue: boolean;
          sources: unknown[];
        }>;
        emptyReason: string;
        filteredByPermission: boolean;
        engineDataSuspect: boolean;
        recallId: string;
        presentationEventId: string | null;
        trustLevel: string;
        decisionAuthority: string;
        usageNote: string;
      }>;

      expect(body.data.emptyReason).toBe('none');
      expect(body.data.filteredByPermission).toBe(false);
      expect(body.data.engineDataSuspect).toBe(false);
      expect(body.data.recallId).toBeTruthy();
      // 信任框信封三件套（定论⑤：建议 + 出处，不是裁决）
      expect(body.data.trustLevel).toBe('untrusted_advisory');
      expect(body.data.decisionAuthority).toBe('none');
      expect(body.data.usageNote).toContain('关键使用前回查');

      expect(body.data.items).toHaveLength(1);
      const item = body.data.items[0];
      // 逐字段对照 §6 契约（缺一即消费方拿不到出处）
      expect(item.memoryId).toMatch(/^mem_/);
      expect(item.ledgerId).toBeTruthy();
      expect(item.category).toBe('ruling');
      expect(item.subject).toBe(`主张 ${token}`);
      expect(item.scope).toContain('适用范围');
      expect(item.body).toContain(`主张 ${token}`); // 正文 = 账本冻结原文
      expect(item.kind).toBe('concept');
      expect(item.resolution).toBe('R2');
      expect(item.status).toBe('active');
      // `score` 只做**形状断言**（值透传由 `memory-recall.service.spec.ts` 的 score:7 用例证明）；
      // ⚠️ 局限：FakeEngine 的分数是确定性常量 1（`fake.engine.ts` 的 buildRecallItem：
      // 子串命中即 1），所以这里**恒为 1**，断言具体数值毫无信息量——真值透传的端到端证明
      // 走 `scriptedEngine.recallScript` 的那条用例（score:5）。
      expect(item.score).toBeDefined();
      expect(Number.isInteger(item.score)).toBe(true);
      expect(item.derivation).toBe('authorship'); // 无 sourceRefs = 纯著述
      expect(item.contentTruncated).toBe(false);
      expect(item.reviewDue).toBe(false);
      expect(item.sources).toEqual([]);
    });

    it('召回 score 端到端透传：引擎给 5 ⇒ 响应 5（不是 fake 的常量 1）', async () => {
      if (!dbAvailable) return;

      // 自造项目 + 真实提名：钩子拿到的 items 必须是本项目 committed 记忆的**真实条目**
      // （memory_id 能映射到账本行——见 ScriptedEngine.recall 的写法铁律）
      const token5 = `score5-${RUN}`;
      const project5 = await createProject();
      const nominated = await nominate(project5, claim(token5));
      expect(nominated.status).toBe(201);

      scriptedEngine.recallScript = (items) => {
        if (items.length === 0) {
          throw new Error('recallScript got no items — the inner recall produced nothing to patch');
        }
        items[0].score = 5;
      };

      let res: request.Response;
      try {
        res = await req(app, agentAKey)
          .post(`/memory/projects/${project5}/recalls`)
          .send({ query: token5, contextIdentity: `ctx-score-${RUN}`, contextEpoch: 1 });
        // 钩子是一次性的：被内层结果消费后自清空
        expect(scriptedEngine.recallScript).toBeNull();
      } finally {
        // 兜底清空：若上面的请求没走到引擎（断言提前失败），别把一次性脚本漏给后续用例
        scriptedEngine.recallScript = null;
      }

      expect(res.status).toBe(200);
      const body = res.body as Envelope<{ items: Array<{ score: number }> }>;
      expect(body.data.items).toHaveLength(1);
      // 端到端原值透传（fake 引擎恒 1 ⇒ 5 只可能来自引擎给出的原值）
      expect(body.data.items[0].score).toBe(5);
    });

    it('零结果 ⇒ emptyReason=no_matches（200 不是错误）', async () => {
      if (!dbAvailable) return;

      const res = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: `绝不存在-${RUN}`, contextIdentity: `ctx2-${RUN}`, contextEpoch: 1 });
      expect(res.status).toBe(200);
      const body = res.body as Envelope<{ items: unknown[]; emptyReason: string }>;
      expect(body.data.items).toEqual([]);
      expect(body.data.emptyReason).toBe('no_matches');
    });

    it('contextEpoch 超平台护栏（1e9）⇒ **DTO 400**，不到引擎（引擎 alpha.4 起已放宽，护栏仍刻意保留）', async () => {
      if (!dbAvailable) return;

      // 1e9 是**平台主动保留的护栏**（不是引擎当前的运行时限制）：alpha.3 时代引擎会拒 >1e9
      // （1e9 → 200、1e9+1 → 400），alpha.4 起引擎已放宽到 JS 安全整数（FEEDBACK-10 已修复）；
      // 平台仍卡 1e9，因为 epoch 的语义是"同一 identity 下的第几轮"——拿绝对时间当 epoch 恒为误用，
      // 调用方本该在**平台边界**被挡下（铁律 #21）。
      const recallEventsBefore = (await ds.query(
        `SELECT count(*)::int AS n FROM memory_recall_events WHERE project_id = $1`,
        [projectId],
      )) as { n: number }[];

      const over = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({
          query: `epoch-${RUN}`,
          contextIdentity: `ctx-${RUN}`,
          contextEpoch: 1_000_000_001,
        });
      expect(over.status).toBe(400);
      // ⚠️ 本套件的 app **未挂** AllExceptionsFilter（只有 ResponseInterceptor），故这里是 Nest
      // 默认错误体（`statusCode` + `message`）。生产挂在 AppModule 的 APP_FILTER 上会把无自定义
      // code 的 400 落成 `code: ErrorCode.BAD_REQUEST(=400)`（映射本身由
      // `all-exceptions.filter.spec.ts:285` 守护）——所以 controller 的 Swagger 写 `400` 而不是 `9000`
      //（9000 只给服务层显式构造的 400，如 nominate 的字节闸门）。
      expect(over.body.statusCode).toBe(400);
      expect(JSON.stringify(over.body.message)).toContain('contextEpoch');

      // Date.now() 毫秒（≈1.76e12）——生产实测中招的那个值，必须同样在边界被拒
      const millis = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: `epoch-${RUN}`, contextIdentity: `ctx-${RUN}`, contextEpoch: Date.now() });
      expect(millis.status).toBe(400);
      // message 要能指导下一步（点名别传毫秒、建议逻辑纪元）
      expect(JSON.stringify(millis.body.message)).toContain('Date.now()');

      // 边界值本身放行（1e9 是平台护栏的上界——刻意保留，不是引擎当前的硬顶）
      const atLimit = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `epoch-limit-${RUN}`, contextEpoch: 1_000_000_000 });
      expect(atLimit.status).toBe(200);

      // 被拒的两次**一步都没进服务层**：没有新的召回遥测行（否则就是"400 了还烧了配额"）
      const recallEventsAfter = (await ds.query(
        `SELECT count(*)::int AS n FROM memory_recall_events WHERE project_id = $1`,
        [projectId],
      )) as { n: number }[];
      // 只有 atLimit 那一次真打到了引擎 ⇒ 恰好 +1
      expect(recallEventsAfter[0].n).toBe(recallEventsBefore[0].n + 1);
    });

    it('账本详情：完整投影 + 正文只在详情（select:false 显式取）+ 摘要可读', async () => {
      if (!dbAvailable) return;

      const ledgerRows = (await ds.query(
        `SELECT id FROM memory_nominations WHERE project_id = $1 AND formation_state = 'committed' ORDER BY created_at ASC LIMIT 1`,
        [projectId],
      )) as { id: string }[];

      const res = await req(app, agentAKey).get(`/memory/nominations/${ledgerRows[0].id}`);
      expect(res.status).toBe(200);
      const body = res.body as Envelope<{
        projection: string;
        content?: string;
        contentExcerpt?: string;
        sourceRefs?: unknown[];
        engineMemoryIds?: string[];
        nominatorName?: string | null;
      }>;
      expect(body.data.projection).toBe('full');
      expect(body.data.content).toContain('范围:');
      expect(body.data.sourceRefs).toEqual([]);
      expect(body.data.engineMemoryIds).toHaveLength(1);
      // ② 读面摘要（二期 D1④）：本行是 authorship（无 sourceRefs ⇒ 无摘录锚点）⇒ 退化路径 =
      // 跳过模板头两行（`[category] subject` / `范围:`），从 `生效/撤销:` 起截。
      // 期望值从**真实落库正文的模板**（`claim()`）派生，不是手打的自由文本。
      expect(body.data.contentExcerpt).toBe(`生效/撤销: 自本批次起生效\n理由: 理由 ${token}`);
      // ③ 提名者归属（二期 D1b）：本行的提名者是 agent A，真名必须透出
      expect(body.data.nominatorName).toBe(`Mem Agent ${RUN} #1`);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ④ 三处同源：来源消失同时作用于 召回 / 账本投影 / 记忆详情
  // ══════════════════════════════════════════════════════════════════

  describe('④ 三处同源（权限过滤 / 降级投影 / 详情 404）', () => {
    let projectId = '';
    const token = `source-${RUN}`;
    let memoryId = '';
    let ledgerId = '';

    it('来源可见（B 的话题仍为 open）：召回命中 + 详情 200 + 账本 full', async () => {
      if (!dbAvailable) return;

      projectId = await createProject();
      const res = await nominate(
        projectId,
        claim(token, { sourceRefs: [{ type: 'message', id: fx.messageInTopicOther }] }),
      );
      expect(res.status).toBe(201);
      const body = res.body as Envelope<{ ledgerId: string; engineMemoryIds: string[] }>;
      ledgerId = body.data.ledgerId;
      memoryId = body.data.engineMemoryIds[0];

      const recall = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `ctx-${RUN}`, contextEpoch: 2 });
      expect(recall.status).toBe(200);
      const recallBody = recall.body as Envelope<{
        items: Array<{
          sources: Array<{
            type: string;
            id: string;
            parent: { type: string; id: string };
            versionHash: string | null;
            headingPath: string | null;
            locator: string;
            moved: boolean;
            readWith: { tool: string; params: Record<string, unknown> };
          }>;
          derivation: string;
        }>;
      }>;
      expect(recallBody.data.items).toHaveLength(1);
      const source = recallBody.data.items[0].sources[0];
      expect(recallBody.data.items[0].derivation).toBe('sourced');
      expect(source.type).toBe('message');
      expect(source.id).toBe(fx.messageInTopicOther);
      expect(source.parent).toEqual({ type: 'topic', id: fx.topicOther });
      expect(source.versionHash).toBeNull(); // message 无版本列
      expect(source.headingPath).toBeNull();
      expect(source.locator).toBe(`chamber://message/${fx.messageInTopicOther}`);
      expect(source.moved).toBe(false);
      // readWith = "关键使用前回查当前版本"的平台入口
      expect(source.readWith.tool).toBe('get_topic_digest');
      // readWith 的参数必须**原样可调**：topicId 定位话题、markRead=false 防"回读"推进已读游标、
      // maxContentLength=0 取全文（回读就是要看当前版本全文）；具体消息靠同级 locator 定位
      const readParams = source.readWith.params as Record<string, unknown>;
      expect(readParams.topicId).toBe(fx.topicOther);
      expect(readParams.markRead).toBe(false);
      expect(readParams.maxContentLength).toBe(0);

      const detail = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/memories/${memoryId}`,
      );
      expect(detail.status).toBe(200);

      // 账本列表（full 档）② 摘要：本行**有**来源 ⇒ 摘要 = 摘录区内容，且**剥掉 locator 前缀**
      // （locator 已由 `sources[].locator` 提供，不进摘要、不占 280 字符预算）
      const list = await req(app, agentAKey).get(`/memory/projects/${projectId}/nominations`);
      expect(list.status).toBe(200);
      const listBody = list.body as Envelope<{
        items: Array<{
          id: string;
          projection: string;
          content?: string;
          contentExcerpt?: string;
        }>;
      }>;
      const listed = listBody.data.items.find((row) => row.id === ledgerId);
      expect(listed?.projection).toBe('full');
      // 列表**仍不带正文**（正文只在详情给），但带摘要
      expect(listed && 'content' in listed).toBe(false);
      expect(listed?.contentExcerpt).toBe(`B 私密来源 ${RUN}`);
      expect(listed?.contentExcerpt).not.toContain('chamber://');
      expect(listed?.contentExcerpt).not.toContain('范围:'); // 固定区（含主张三要素）不进摘要
    });

    it('自由正文（contentOverride 写路径）：摘要**不被吞**（真实库 + 真实 HTTP 回归）', async () => {
      if (!dbAvailable) return;

      // `content` 的第二条一等公民写路径：客户端自由正文（无模板头、无摘录锚点）。
      // 曾经"按固定行数跳头部"会把单行正文吞成空摘要、多行丢掉前两行——本用例在真库里钉住。
      const projectId = await createProject();
      const freeText = `客户端自写的一行正文 ${RUN}`;
      const res = await nominate(
        projectId,
        claim(`override-${RUN}`, { contentOverride: freeText }),
      );
      expect(res.status).toBe(201);
      const body = res.body as Envelope<{ ledgerId: string; contentTruncated: boolean }>;
      // 落库事实：正文短、未被字节闸门截（与"摘要被 280 码点截"是两条独立信号）
      expect(body.data.contentTruncated).toBe(false);

      const list = await req(app, agentAKey).get(`/memory/projects/${projectId}/nominations`);
      expect(list.status).toBe(200);
      const listed = (
        list.body as Envelope<{ items: Array<{ id: string; contentExcerpt?: string }> }>
      ).data.items.find((row) => row.id === body.data.ledgerId);

      expect(listed?.contentExcerpt).toBe(freeText);
    });

    it('话题转私密（撤权）⇒ 召回过滤 + 账本降级 + 详情 404（**三处同源**）', async () => {
      if (!dbAvailable) return;

      // 撤权动作：把 B 的话题从 open 变 private（AccessQueryService 的白名单随之不再包含它）
      await ds.query(`UPDATE topics SET settings = $2::jsonb WHERE id = $1`, [
        fx.topicOther,
        JSON.stringify({ visibility: 'private' }),
      ]);

      // ① 召回：该条目整条被过滤（不是"部分来源丢失"）
      const recall = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `ctx-${RUN}`, contextEpoch: 3 });
      expect(recall.status).toBe(200);
      const recallBody = recall.body as Envelope<{
        items: unknown[];
        emptyReason: string;
        filteredByPermission: boolean;
      }>;
      expect(recallBody.data.items).toEqual([]);
      expect(recallBody.data.filteredByPermission).toBe(true);
      expect(recallBody.data.emptyReason).toBe('all_filtered');

      // ② 账本：该行降级为元数据投影（正文/来源字段**整键缺席**），同项目其它行仍为 full
      const list = await req(app, agentAKey).get(`/memory/projects/${projectId}/nominations`);
      expect(list.status).toBe(200);
      const listBody = list.body as Envelope<{
        items: Array<{
          id: string;
          projection: string;
          content?: string;
          contentExcerpt?: string;
          sourceRefs?: unknown;
          projectId?: string;
          correctionOf?: string | null;
          nominatorName?: string | null;
          nominatorDeletedAt?: string | null;
          engineDiagnostics?: unknown;
        }>;
      }>;
      const degraded = listBody.data.items.find((row) => row.id === ledgerId);
      expect(degraded?.projection).toBe('metadata');
      expect(degraded && 'content' in degraded).toBe(false);
      expect(degraded && 'sourceRefs' in degraded).toBe(false);
      // 诊断属内容面证据 ⇒ 降级档整键缺席（与 full 档形成对照，防投影白名单漏键）
      expect(degraded && 'engineDiagnostics' in degraded).toBe(false);
      // 摘要属内容面 ⇒ 降级档同样整键缺席（二期只放宽元数据，不放宽正文/摘要）
      expect(degraded && 'contentExcerpt' in degraded).toBe(false);
      // 治理白名单字段仍在
      expect(degraded).toMatchObject({ id: ledgerId, category: 'ruling' });
      // 二期放宽的四键：**两档都有**（治理面要能归项目 / 画取代边 / 显示归属）
      expect(degraded).toMatchObject({
        projectId,
        correctionOf: null,
        nominatorName: `Mem Agent ${RUN} #1`,
        nominatorDeletedAt: null,
      });

      // ③ 记忆详情：任一来源不可见 ⇒ 404（不确认存在性，防撤权逃逸）
      const detail = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/memories/${memoryId}`,
      );
      expect(detail.status).toBe(404);
      expect(detail.body.code).toBe(ErrorCode.MEMORY_NOMINATION_NOT_FOUND);
    });

    it('moved：来源 doc 的 contentHash 变化后 sources[].moved=true（message 恒 false）', async () => {
      if (!dbAvailable) return;

      const docToken = `doc-${RUN}`;
      const project = await createProject();
      const res = await nominate(
        project,
        claim(docToken, { sourceRefs: [{ type: 'doc', id: fx.doc, position: 0 }] }),
      );
      expect(res.status).toBe(201);

      // 冻结 versionHash = 提名当时的 doc.contentHash
      const frozen = (await ds.query(`SELECT source_refs FROM memory_nominations WHERE id = $1`, [
        (res.body as Envelope<{ ledgerId: string }>).data.ledgerId,
      ])) as {
        source_refs: Array<{ versionHash?: string; headingPath?: string; excerpt?: string }>;
      }[];
      expect(frozen[0].source_refs[0].versionHash).toBe(
        'frozenhash0000000000000000000000000000001',
      );
      // 首节摘录与标题路径也被冻结（§4 服务端实取）
      expect(frozen[0].source_refs[0].headingPath).toContain('正文 § 依据');
      expect(frozen[0].source_refs[0].excerpt).toContain('关键依据摘录正文');

      const before = await req(app, agentAKey)
        .post(`/memory/projects/${project}/recalls`)
        .send({ query: docToken, contextIdentity: `ctx-${RUN}`, contextEpoch: 4 });
      const beforeBody = before.body as Envelope<{
        items: Array<{ sources: Array<{ moved: boolean; locator: string }> }>;
      }>;
      expect(beforeBody.data.items[0].sources[0].moved).toBe(false);
      expect(beforeBody.data.items[0].sources[0].locator).toBe(
        `chamber://doc/${fx.doc}#h${'frozenhash00'.slice(0, 12)}`.replace(
          '#hfrozenhash0',
          '#hfrozenhash0',
        ),
      );

      // 来源被改：doc 的 content_hash 变化 ⇒ moved 翻真
      await ds.query(`UPDATE docs SET content_hash = $2 WHERE id = $1`, [
        fx.doc,
        'changedhash0000000000000000000000000000002',
      ]);
      const after = await req(app, agentAKey)
        .post(`/memory/projects/${project}/recalls`)
        .send({ query: docToken, contextIdentity: `ctx-${RUN}`, contextEpoch: 5 });
      const afterBody = after.body as Envelope<{
        items: Array<{ sources: Array<{ moved: boolean }> }>;
      }>;
      expect(afterBody.data.items[0].sources[0].moved).toBe(true);

      // 复位（后续用例还要用这个 doc）
      await ds.query(`UPDATE docs SET content_hash = $2 WHERE id = $1`, [
        fx.doc,
        'frozenhash0000000000000000000000000000001',
      ]);
    });

    it('reviewDue：review_at 已到 ⇒ true（仅提醒，不改变可见性）', async () => {
      if (!dbAvailable) return;

      const token = `review-${RUN}`;
      const project = await createProject();
      const past = new Date(Date.now() - 60_000).toISOString();
      const res = await nominate(project, claim(token, { reviewAt: past }));
      expect(res.status).toBe(201);

      const recall = await req(app, agentAKey)
        .post(`/memory/projects/${project}/recalls`)
        .send({ query: token, contextIdentity: `ctx-${RUN}`, contextEpoch: 6 });
      const body = recall.body as Envelope<{ items: Array<{ reviewDue: boolean }> }>;
      expect(body.data.items[0].reviewDue).toBe(true);

      // 提醒不改变可见性：账本列表按 reviewBefore 过滤也仍返回该行（且 formation_state 不变）
      const list = await req(app, agentAKey).get(
        `/memory/projects/${project}/nominations?reviewBefore=${new Date().toISOString()}`,
      );
      const listBody = list.body as Envelope<{ items: Array<{ formationState: string }> }>;
      expect(listBody.data.items).toHaveLength(1);
      expect(listBody.data.items[0].formationState).toBe('committed');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ 更正：达成（双写 + 旧主张 superseded）与未达成（释放唯一位）
  // ══════════════════════════════════════════════════════════════════

  describe('⑤ 更正编排', () => {
    // 套件级清理：`correctFailure` 等一次性脚本若在用例中途失败时未被消费，残留会毒化后续
    // 更正用例（评审 M6）——每个用例前重置替身，脚本只在用例内布置。
    beforeEach(() => {
      scriptedEngine.reset();
    });

    it('达成：新主张 committed ⇒ correct ⇒ 旧行 superseded；current 视图不再命中旧主张', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const oldToken = `corr-old-${RUN}`;
      const newToken = `corr-new-${RUN}`;

      const oldRes = await nominate(project, claim(oldToken));
      expect(oldRes.status).toBe(201);
      const oldLedgerId = (oldRes.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      const res = await req(app, agentAKey)
        .post(`/memory/projects/${project}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(newToken) });
      expect(res.status).toBe(201);
      const body = res.body as Envelope<{
        ledgerId: string;
        oldClaimStatus: string;
        formationState: string;
        engineCorrectionId?: string | null;
      }>;
      expect(body.data.oldClaimStatus).toBe('superseded');
      expect(body.data.formationState).toBe('committed');
      expect(body.data.ledgerId).not.toBe(oldLedgerId);

      // 双写：新行记 correction id，旧行 superseded
      const rows = (await ds.query(
        `SELECT id, status, engine_correction_id, correction_of FROM memory_nominations
          WHERE project_id = $1 ORDER BY created_at ASC`,
        [project],
      )) as Array<{
        id: string;
        status: string;
        engine_correction_id: string | null;
        correction_of: string | null;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].status).toBe('superseded');
      expect(rows[1].correction_of).toBe(oldLedgerId);
      expect(rows[1].engine_correction_id).toBeTruthy();

      // current 视图：旧主张（引擎侧已 superseded）不再命中
      const current = await req(app, agentAKey)
        .post(`/memory/projects/${project}/recalls`)
        .send({ query: oldToken, contextIdentity: `ctx-${RUN}`, contextEpoch: 7 });
      const currentBody = current.body as Envelope<{ items: unknown[]; emptyReason: string }>;
      expect(currentBody.data.items).toEqual([]);
      expect(currentBody.data.emptyReason).toBe('no_matches');

      // history 视图仍可查（可溯源性）
      const history = await req(app, agentAKey)
        .post(`/memory/projects/${project}/recalls`)
        .send({ query: oldToken, view: 'history', contextIdentity: `ctx-${RUN}`, contextEpoch: 8 });
      const historyBody = history.body as Envelope<{ items: Array<{ body: string }> }>;
      expect(historyBody.data.items).toHaveLength(1);
      expect(historyBody.data.items[0].body).toContain(oldToken);
    });

    it('未达成（no_memory）：新行 withdrawn + 清 ids ⇒ **同一 old 可再次更正**（唯一位释放）', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const oldToken = `corr-release-${RUN}`;
      const oldRes = await nominate(project, claim(oldToken));
      expect(oldRes.status).toBe(201);
      const oldLedgerId = (oldRes.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      // 脚本：引擎回 "no_change_validated"（§7 第 2 行：即使 job_state=committed 也是 no_memory）
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: `nom-no-memory-${RUN}`,
          duplicate: false,
          jobState: 'committed',
          deferred: false,
          outcome: 'no_change_validated',
          memoryIds: [],
          durable: true,
        },
      };

      const failed = await req(app, agentAKey)
        .post(`/memory/projects/${project}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-drop-${RUN}`) });
      expect(failed.status).toBe(200); // §6：no_memory → 200
      const failedBody = failed.body as Envelope<{ status: string; oldClaimStatus: string }>;
      expect(failedBody.data.status).toBe('withdrawn');
      expect(failedBody.data.oldClaimStatus).toBe('still_current');

      // 不变量：withdrawn ⇒ engine_memory_ids 必为空（否则"已撤回"的行仍会被召回映射认作 canonical）
      const withdrawn = (await ds.query(
        `SELECT status, engine_memory_ids FROM memory_nominations
          WHERE project_id = $1 AND correction_of = $2`,
        [project, oldLedgerId],
      )) as Array<{ status: string; engine_memory_ids: string[] | null }>;
      expect(withdrawn).toHaveLength(1);
      expect(withdrawn[0].status).toBe('withdrawn');
      expect(withdrawn[0].engine_memory_ids).toBeNull();

      // **关键回归守卫**：唯一位已被释放 ⇒ 同一条旧主张可以再更正（否则这里必然 409）
      const retry = await req(app, agentAKey)
        .post(`/memory/projects/${project}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-retry-${RUN}`) });
      expect(retry.status).toBe(201);
      expect((retry.body as Envelope<{ oldClaimStatus: string }>).data.oldClaimStatus).toBe(
        'superseded',
      );
    });

    it('链接失败（correct 被引擎拒）⇒ 201 + correctionLinkFailure + correction_link_pending；retry 续跑后 superseded', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const oldRes = await nominate(project, claim(`corr-link-old-${RUN}`));
      expect(oldRes.status).toBe(201);
      const oldLedgerId = (oldRes.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      // 故障注入：下一次 correct 回引擎失败面（生产实证形态 = 缺 runtime_private_write ⇒ 403）。
      // inspect 仍委托内层 ⇒ 未命中，复刻"新主张已形成但链接未建立"的卡点。
      scriptedEngine.correctFailure = {
        kind: 'http',
        httpStatus: 403,
        engineCode: 'source_access_denied',
        message: 'denied',
        latencyMs: 7,
      };

      const failed = await req(app, agentAKey)
        .post(`/memory/projects/${project}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-link-new-${RUN}`) });
      expect(failed.status).toBe(201); // 新主张**确实形成了**（账本是 durable receipt）
      const failedBody = failed.body as Envelope<{
        ledgerId: string;
        oldClaimStatus: string;
        hintCode: string;
        correctionLinkFailure?: { kind: string; engineCode?: string; httpStatus?: number };
      }>;
      expect(failedBody.data.oldClaimStatus).toBe('still_current');
      // 卡 61688768 的核心：失败必须**响亮**，不能只回 "Nothing further to do"
      expect(failedBody.data.hintCode).toBe('correction_link_pending');
      expect(failedBody.data.correctionLinkFailure).toEqual({
        kind: 'http',
        engineCode: 'source_access_denied',
        httpStatus: 403,
      });

      // 链接没建立 ⇒ 旧行仍 active（双写事务没开）
      const oldRows = (await ds.query(`SELECT status FROM memory_nominations WHERE id = $1`, [
        oldLedgerId,
      ])) as { status: string }[];
      expect(oldRows[0].status).toBe('active');

      // retry 本行：钩子已消费 ⇒ 内层 fake 真正达成链接（续跑只重试链接步）
      const retried = await req(app, agentAKey)
        .post(`/memory/nominations/${failedBody.data.ledgerId}/retry`)
        .send({});
      expect(retried.status).toBe(201);
      const retriedBody = retried.body as Envelope<{
        oldClaimStatus: string;
        hintCode: string;
        correctionLinkFailure?: unknown;
      }>;
      expect(retriedBody.data.oldClaimStatus).toBe('superseded');
      expect(retriedBody.data.hintCode).toBe('committed');
      // 缺席 ≠ "链接成功"的断言，但成功路径必须缺席（否则消费方会以为还能续跑）
      expect(retriedBody.data).not.toHaveProperty('correctionLinkFailure');
    });

    it('预检：旧行非 active / 已有有效更正行 ⇒ 409；跨项目旧行 ⇒ 404', async () => {
      if (!dbAvailable) return;

      const projectA = await createProject();
      const projectB = await createProject();
      const committed = await nominate(projectA, claim(`corr-pre-${RUN}`));
      const oldLedgerId = (committed.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      // 跨项目：按"本项目无此账本行"处理（不泄露存在性）
      const crossProject = await req(app, agentAKey)
        .post(`/memory/projects/${projectB}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-cross-${RUN}`) });
      expect(crossProject.status).toBe(404);
      expect(crossProject.body.code).toBe(ErrorCode.MEMORY_NOMINATION_NOT_FOUND);

      // 已有有效更正行 ⇒ 409（部分唯一索引的友好前置）
      const ok = await req(app, agentAKey)
        .post(`/memory/projects/${projectA}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-first-${RUN}`) });
      expect(ok.status).toBe(201);
      const dup = await req(app, agentAKey)
        .post(`/memory/projects/${projectA}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-dup-${RUN}`) });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe(ErrorCode.MEMORY_NOMINATION_CONFLICT);

      // 旧行已被 supersede ⇒ 再更正旧行必被预检拦下
      const stale = await req(app, agentAKey)
        .post(`/memory/projects/${projectB}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-stale-${RUN}`) });
      expect(stale.status).toBe(404); // 跨项目仍是 404（不区分"已 superseded"）
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥ 恢复三通道：GET 零副作用 / retry 续跑 / recover 自愈与排除集
  // ══════════════════════════════════════════════════════════════════

  describe('⑥ 恢复三通道', () => {
    it('非终态（deferred）⇒ 202；GET 零副作用；retry 同 key 续跑 ⇒ 201', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const token = `resume-${RUN}`;

      // 脚本：引擎要求延后（§7 第 5 行 ⇒ submitted + same_key_resend）
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: `nom-deferred-${RUN}`,
          duplicate: false,
          jobState: 'pending',
          deferred: true,
          outcome: 'deferred',
          memoryIds: [],
          durable: true,
        },
      };

      const res = await nominate(project, claim(token));
      expect(res.status).toBe(202);
      const body = res.body as Envelope<{
        ledgerId: string;
        formationState: string;
        hintCode: string;
        engineMemoryIds: string[];
      }>;
      expect(body.data.formationState).toBe('submitted');
      expect(body.data.hintCode).toBe('same_key_resend');
      const ledgerId = body.data.ledgerId;

      // **GET 零副作用**：连续读两次，形成态不变且不新增遥测行（GET 不推进 job）
      const eventsBefore = (await ds.query(
        `SELECT count(*)::int AS n FROM memory_formation_events WHERE ledger_id = $1`,
        [ledgerId],
      )) as { n: number }[];
      const first = await req(app, agentAKey).get(`/memory/nominations/${ledgerId}`);
      const second = await req(app, agentAKey).get(`/memory/nominations/${ledgerId}`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = first.body as Envelope<{ formationState: string; recoveryPath: string }>;
      expect(firstBody.data.formationState).toBe('submitted');
      expect(firstBody.data.recoveryPath).toBe('same_key_resend');
      const eventsAfter = (await ds.query(
        `SELECT count(*)::int AS n FROM memory_formation_events WHERE ledger_id = $1`,
        [ledgerId],
      )) as { n: number }[];
      expect(eventsAfter[0].n).toBe(eventsBefore[0].n);

      // retry：同 key 重发（此时替身不再拦截 ⇒ FakeEngine 真正形成）
      const retry = await req(app, agentAKey)
        .post(`/memory/nominations/${ledgerId}/retry`)
        .send({});
      expect(retry.status).toBe(201);
      const retryBody = retry.body as Envelope<{
        formationState: string;
        engineMemoryIds: string[];
      }>;
      expect(retryBody.data.formationState).toBe('committed');
      expect(retryBody.data.engineMemoryIds).toHaveLength(1);
    });

    it('recover：只扫"未收敛且不在排除集"的行（config_invalid 恒错行不重发）', async () => {
      if (!dbAvailable) return;

      const project = await createProject();

      // X：deferred ⇒ submitted（可自愈）
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: `nom-x-${RUN}`,
          duplicate: false,
          jobState: 'claimed',
          deferred: false,
          outcome: 'deferred',
          memoryIds: [],
          durable: true,
        },
      };
      const x = await nominate(project, claim(`recover-x-${RUN}`));
      expect(x.status).toBe(202);

      // Y：error.code=binding_not_found ⇒ failed + config_invalid（**恒错行，排除集**）
      scriptedEngine.next = {
        ok: false,
        failure: {
          kind: 'http',
          message: 'stub',
          httpStatus: 400,
          engineCode: 'binding_not_found',
          retryable: false,
          latencyMs: 3,
        },
      };
      const y = await nominate(project, claim(`recover-y-${RUN}`));
      expect(y.status).toBe(503);
      expect(y.body.data.reason).toBe('engine_error');
      const yLedger = (y.body as unknown as { data: { ledgerId: string } }).data.ledgerId;

      // Z：引擎 409（逐因可辨；未给 cause ⇒ 兜底 conflict）⇒ conflict（可自愈：在途前缀场景）
      scriptedEngine.next = {
        ok: false,
        failure: { kind: 'http', message: 'stub', httpStatus: 409, retryable: false, latencyMs: 4 },
      };
      const z = await nominate(project, claim(`recover-z-${RUN}`));
      expect(z.status).toBe(409);
      expect(z.body.code).toBe(ErrorCode.MEMORY_NOMINATION_CONFLICT);

      const summary = await req(app, agentAKey)
        .post(`/memory/projects/${project}/recover`)
        .send({});
      expect(summary.status).toBe(202);
      const summaryBody = summary.body as Envelope<{
        scanned: number;
        resumed: number;
        skipped: number;
        items: Array<{ ledgerId: string; action: string }>;
      }>;
      // 排除集内的 Y 连**扫**都不进（scanned 只数候选）
      expect(summaryBody.data.scanned).toBe(2);
      expect(summaryBody.data.resumed).toBe(2);
      expect(summaryBody.data.items.every((item) => item.action === 'resent')).toBe(true);

      // Y 保持 failed + config_invalid（未被重发）
      const yRow = (await ds.query(`SELECT formation_state FROM memory_nominations WHERE id = $1`, [
        yLedger,
      ])) as { formation_state: string }[];
      expect(yRow[0].formation_state).toBe('failed');
      const yPath = (await ds.query(
        // ⚠️ 三键同序 = 生产 `latestRecoveryPaths` / `resumeProject` 的"最近一次尝试"判据：
        // 只按 created_at 排在同毫秒重试时会指向另一行（断言与读面静默错档）
        `SELECT recovery_path FROM memory_formation_events WHERE ledger_id = $1
          ORDER BY created_at DESC, retry_count DESC, id DESC LIMIT 1`,
        [yLedger],
      )) as { recovery_path: string }[];
      expect(yPath[0].recovery_path).toBe('config_invalid');
    });

    it('客户端超时 ⇒ unknown + 202（§7 第 10 行：**非终态**，同 key 重发）；连接未达 ⇒ failed + 503', async () => {
      if (!dbAvailable) return;

      const project = await createProject();

      // ① 客户端超时：**无回执** ⇒ unknown（Hument 终态但 Chamber 不可恢复）+ same_key_resend
      //    §6 的 HTTP 语义由账本态驱动：unknown ⇒ 202（不是 503——它不是 failed）
      scriptedEngine.next = {
        ok: false,
        failure: { kind: 'timeout', message: 'stub timeout', retryable: true, latencyMs: 90000 },
      };
      const timeout = await nominate(project, claim(`timeout-${RUN}`));
      expect(timeout.status).toBe(202);
      const timeoutBody = timeout.body as Envelope<{
        formationState: string;
        hintCode: string;
        ledgerId: string;
      }>;
      expect(timeoutBody.data.formationState).toBe('unknown');
      expect(timeoutBody.data.hintCode).toBe('outcome_unknown');
      // 非终态 ⇒ 行仍在（可 retry），账本 id 必须回给消费方
      expect(timeoutBody.data.ledgerId).toBeTruthy();

      // ② 连接未达（请求没到引擎）⇒ failed + 同 key 重发安全 ⇒ 503 + reason=engine_unreachable
      scriptedEngine.next = {
        ok: false,
        failure: { kind: 'unreachable', message: 'stub refused', latencyMs: 2 },
      };
      const unreachable = await nominate(project, claim(`unreachable-${RUN}`));
      expect(unreachable.status).toBe(503);
      expect(unreachable.body.code).toBe(ErrorCode.MEMORY_UNAVAILABLE);
      expect(unreachable.body.data.reason).toBe('engine_unreachable');
      expect(unreachable.body.data.formationState).toBe('failed');
      expect(unreachable.body.data.ledgerId).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥b 引擎诊断透传（b4d41314）：409 逐因 / 终拒证据 / correct 撤回 / replay 一致性
  // ══════════════════════════════════════════════════════════════════

  describe('⑥b 引擎诊断透传', () => {
    /** 脚本一次 409 admission 失败（`ScriptedEngine.next` 一次性） */
    function scriptAdmissionFailure(cause: string, requestId: string): void {
      scriptedEngine.next = {
        ok: false,
        failure: {
          kind: 'http',
          message: 'stub 409',
          httpStatus: 409,
          engineCode: 'conflict',
          retryable: false,
          admissionCause: cause,
          requestId,
          latencyMs: 4,
        },
      };
    }

    it.each([
      ['prefix_unresolved', 'conflict_prefix_unresolved'],
      ['quota_exceeded', 'conflict_quota_exceeded'],
      ['exact_content', 'conflict_exact_content'],
    ])(
      '409 admission_cause=%s ⇒ 409/14005 + %s；data/详情 full 档/遥测三处同值',
      async (cause, hintCode) => {
        if (!dbAvailable) return;

        const project = await createProject();
        const requestId = `req-${cause}-${RUN}`;
        scriptAdmissionFailure(cause, requestId);

        const res = await nominate(project, claim(`diag-${cause}-${RUN}`));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe(ErrorCode.MEMORY_NOMINATION_CONFLICT);
        const body = res.body as Envelope<{
          ledgerId: string;
          hintCode: string;
          engineDiagnostics: { admissionCause?: string; requestId?: string };
        }>;
        expect(body.data.hintCode).toBe(hintCode);
        expect(body.data.engineDiagnostics).toEqual({ admissionCause: cause, requestId });
        const ledgerId = body.data.ledgerId;

        // 详情 full 档：同一诊断可见（"详情读面可见" = full 档可见）
        const detail = await req(app, agentAKey).get(`/memory/nominations/${ledgerId}`);
        expect(detail.status).toBe(200);
        const detailBody = detail.body as Envelope<{
          projection: string;
          engineDiagnostics?: { admissionCause?: string; requestId?: string };
        }>;
        expect(detailBody.data.projection).toBe('full');
        expect(detailBody.data.engineDiagnostics).toEqual({ admissionCause: cause, requestId });

        // 账本列表读面（full 档）：与详情同一诊断（此前只有 mock 级覆盖）
        const list = await req(app, agentAKey).get(`/memory/projects/${project}/nominations`);
        expect(list.status).toBe(200);
        const listBody = list.body as Envelope<{
          items: Array<{ id: string; projection: string; engineDiagnostics?: unknown }>;
        }>;
        const listed = listBody.data.items.find((row) => row.id === ledgerId);
        expect(listed?.projection).toBe('full');
        expect(listed?.engineDiagnostics).toEqual({ admissionCause: cause, requestId });

        // 遥测行：与生产读面**同一行**（同序三键，防两处指向不同尝试）
        const events = (await ds.query(
          `SELECT diagnostics FROM memory_formation_events WHERE ledger_id = $1
            ORDER BY created_at DESC, retry_count DESC, id DESC LIMIT 1`,
          [ledgerId],
        )) as { diagnostics: Record<string, unknown> | null }[];
        expect(events[0].diagnostics).toEqual({ admissionCause: cause, requestId });
      },
    );

    it('200 终拒回执 ⇒ 409 rejected_hub_manual + data.engineDiagnostics 三字段（证据）', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: `nom-rejected-${RUN}`,
          duplicate: false,
          deferred: false,
          outcome: 'rejected',
          reasonCode: 'provider_rejected',
          errorDetail: 'provider_decision_evidence_missing',
          failureClass: 'terminal_rejection',
          requestId: `req-rejected-${RUN}`,
          memoryIds: [],
          durable: true,
        },
      };

      const res = await nominate(project, claim(`rejected-${RUN}`));
      expect(res.status).toBe(409);
      const body = res.body as Envelope<{
        ledgerId: string;
        formationState: string;
        hintCode: string;
        engineDiagnostics?: Record<string, unknown>;
      }>;
      expect(body.data.formationState).toBe('rejected');
      expect(body.data.hintCode).toBe('rejected_hub_manual');
      expect(body.data.engineDiagnostics).toEqual({
        engineReasonCode: 'provider_rejected',
        errorDetail: 'provider_decision_evidence_missing',
        failureClass: 'terminal_rejection',
        requestId: `req-rejected-${RUN}`,
      });

      // 行落 rejected，详情 full 档同值
      const ledgerId = body.data.ledgerId;
      const rows = (await ds.query(`SELECT formation_state FROM memory_nominations WHERE id = $1`, [
        ledgerId,
      ])) as { formation_state: string }[];
      expect(rows[0].formation_state).toBe('rejected');
      const detail = await req(app, agentAKey).get(`/memory/nominations/${ledgerId}`);
      expect(
        (detail.body as Envelope<{ engineDiagnostics?: Record<string, unknown> }>).data
          .engineDiagnostics,
      ).toEqual({
        engineReasonCode: 'provider_rejected',
        errorDetail: 'provider_decision_evidence_missing',
        failureClass: 'terminal_rejection',
        requestId: `req-rejected-${RUN}`,
      });
    });

    it('correct 撞 prefix_unresolved ⇒ 撤回语义文案 + 新行 withdrawn / 旧行 active', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const seeded = await nominate(project, claim(`corr-old-${RUN}`));
      expect(seeded.status).toBe(201);
      const oldLedgerId = (seeded.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      scriptAdmissionFailure('prefix_unresolved', `req-corr-${RUN}`);
      const corr = await req(app, agentAKey)
        .post(`/memory/projects/${project}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`corr-new-${RUN}`) });

      expect(corr.status).toBe(409);
      const body = corr.body as Envelope<{
        ledgerId: string;
        hintCode: string;
        hint: string;
      }>;
      expect(body.data.hintCode).toBe('conflict_prefix_unresolved');
      // correct 版文案：撤回事实 + 只能"起新更正"（retry 本行是死路）
      expect(body.data.hint).toMatch(/WITHDRAWN/);
      expect(body.data.hint).toContain('NEW clientRequestId');

      const rows = (await ds.query(
        `SELECT id, status FROM memory_nominations WHERE id = ANY($1::uuid[])`,
        [[body.data.ledgerId, oldLedgerId]],
      )) as { id: string; status: string }[];
      const byId = new Map(rows.map((row) => [row.id, row.status]));
      expect(byId.get(body.data.ledgerId)).toBe('withdrawn');
      expect(byId.get(oldLedgerId)).toBe('active');
    });

    it('replay 一致性：同 clientRequestId 的 409 回放**不调引擎**且诊断与首次相同', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const clientRequestId = `replay-diag-${RUN}`;
      scriptAdmissionFailure('quota_exceeded', `req-replay-${RUN}`);

      const first = await nominate(project, claim(`replay-${RUN}`, { clientRequestId }));
      expect(first.status).toBe(409);
      const firstBody = first.body as Envelope<{
        engineDiagnostics?: Record<string, unknown>;
        hintCode: string;
      }>;
      expect(firstBody.data.engineDiagnostics).toEqual({
        admissionCause: 'quota_exceeded',
        requestId: `req-replay-${RUN}`,
      });
      const callsAfterFirst = scriptedEngine.nominateCalls;

      // 哨兵只作辅助：真正的判据是计数器（一次性 next 在第一次调用后恒为 null）
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: 'sentinel-should-not-be-used',
          duplicate: false,
          deferred: false,
          outcome: 'memory_committed',
          memoryIds: ['sentinel'],
          durable: true,
        },
      };
      const second = await nominate(project, claim(`replay-${RUN}`, { clientRequestId }));
      expect(second.status).toBe(409);
      expect(scriptedEngine.nominateCalls).toBe(callsAfterFirst);
      expect(scriptedEngine.next).not.toBeNull();
      scriptedEngine.next = null; // 清掉哨兵，避免污染后续用例

      const secondBody = second.body as Envelope<{
        engineDiagnostics?: Record<string, unknown>;
        hintCode: string;
      }>;
      expect(secondBody.data.hintCode).toBe(firstBody.data.hintCode);
      expect(secondBody.data.engineDiagnostics).toEqual(firstBody.data.engineDiagnostics);
    });

    it('quota 动作闭环：同 key POST 只回放；retry 本行才真正续跑（201）', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const clientRequestId = `quota-loop-${RUN}`;
      scriptAdmissionFailure('quota_exceeded', `req-quota-${RUN}`);

      const first = await nominate(project, claim(`quota-loop-${RUN}`, { clientRequestId }));
      expect(first.status).toBe(409);
      const firstBody = first.body as Envelope<{
        ledgerId: string;
        hintCode: string;
        hint: string;
      }>;
      expect(firstBody.data.hintCode).toBe('conflict_quota_exceeded');
      // 文案必须指向可执行的续跑通道（同 clientRequestId 的 POST 只回放）
      expect(firstBody.data.hint).toContain('/memory/nominations/:id/retry');
      const ledgerId = firstBody.data.ledgerId;

      // 同 key POST = 幂等重放（永远拿缓存 409，不会重试引擎）
      const replay = await nominate(project, claim(`quota-loop-${RUN}`, { clientRequestId }));
      expect(replay.status).toBe(409);

      // 文档给的动作 = POST /memory/nominations/:id/retry（这次替身不再拦截 ⇒ FakeEngine 真形成）
      const retry = await req(app, agentAKey)
        .post(`/memory/nominations/${ledgerId}/retry`)
        .send({});
      expect(retry.status).toBe(201);
      const retryBody = retry.body as Envelope<{
        formationState: string;
        hintCode: string;
        engineDiagnostics?: unknown;
      }>;
      expect(retryBody.data.formationState).toBe('committed');
      expect(retryBody.data.hintCode).toBe('committed');
      // committed 行没有引擎诊断 ⇒ 键缺席（不是 null）
      expect('engineDiagnostics' in retryBody.data).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑦ engineDataSuspect（映射不到的条目 + 排除在途行）
  // ══════════════════════════════════════════════════════════════════

  describe('⑦ engineDataSuspect', () => {
    it('引擎返回本项目映射不到的条目（有 committed、无在途行）⇒ engineDataSuspect=true', async () => {
      if (!dbAvailable) return;

      const workspace = `ws-shared-${RUN}`;
      const projectA = await createProject({ engineWorkspaceId: workspace });
      // 引擎侧共享同一个 workspace，但平台身份 claim 是**四列**唯一：换 actor 避免新
      // "不同项目占同一身份" 409，同时不改变 FakeEngine 的 workspace 级共享语义。
      const projectB = await createProject({
        engineWorkspaceId: workspace,
        engineActorId: 'chamber-service-actor-b',
      });

      const tokenA = `suspect-src-${RUN}`;
      await nominate(projectA, claim(tokenA)); // M1 落在共享 workspace
      await nominate(projectB, claim(`suspect-other-${RUN}`)); // B 自己有 committed 行

      const res = await req(app, agentAKey)
        .post(`/memory/projects/${projectB}/recalls`)
        .send({ query: tokenA, contextIdentity: `ctx-${RUN}`, contextEpoch: 9 });
      expect(res.status).toBe(200);
      const body = res.body as Envelope<{
        items: unknown[];
        emptyReason: string;
        filteredByPermission: boolean;
        engineDataSuspect: boolean;
      }>;
      expect(body.data.items).toEqual([]);
      expect(body.data.emptyReason).toBe('all_filtered');
      expect(body.data.filteredByPermission).toBe(false); // 不是权限问题，是**映射**问题
      expect(body.data.engineDataSuspect).toBe(true);
    });

    it('本项目存在在途行 ⇒ 不喊狼来了（engineDataSuspect=false）', async () => {
      if (!dbAvailable) return;

      const workspace = `ws-shared-${RUN}`; // 与上一用例同一 workspace（复用同一条 M1）
      const projectC = await createProject({
        engineWorkspaceId: workspace,
        engineActorId: 'chamber-service-actor-c',
      });
      await nominate(projectC, claim(`suspect-third-${RUN}`));

      // 造一条在途行（submitted）——它能解释"映射不到的条目"
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: `nom-inflight-${RUN}`,
          duplicate: false,
          jobState: 'provider_inflight',
          deferred: false,
          memoryIds: [],
          durable: true,
        },
      };
      const inflight = await nominate(projectC, claim(`suspect-inflight-${RUN}`));
      expect(inflight.status).toBe(202);

      const res = await req(app, agentAKey)
        .post(`/memory/projects/${projectC}/recalls`)
        .send({ query: `suspect-src-${RUN}`, contextIdentity: `ctx-${RUN}`, contextEpoch: 10 });
      const body = res.body as Envelope<{ engineDataSuspect: boolean; emptyReason: string }>;
      expect(body.data.engineDataSuspect).toBe(false);
      expect(body.data.emptyReason).toBe('all_filtered');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑧ 两 403 文案分开（项目级 / 来源级）
  // ══════════════════════════════════════════════════════════════════

  describe('⑧ 两 403 文案分开', () => {
    it('项目级无写权限：403 + 「无本项目写权限」（不泄露来源细节）', async () => {
      if (!dbAvailable) return;

      const project = await createProject(); // 绑定 A 的话题
      // B 不是该话题的创建者/参与方 ⇒ 无写权限（TopicPolicy write）
      const res = await nominate(project, claim(`forbidden-b-${RUN}`), app, agentBKey);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      expect(res.body.message).toContain('无本项目写权限');
    });

    it('来源级无权：403 + 「source_refs[i] 无权读取或不存在」（下标级指认）', async () => {
      if (!dbAvailable) return;

      // B 的**私密**话题（A 完全无权）：来源回取必须用提名者权限，故必 403
      const topicPrivate = (await ds.query(
        `INSERT INTO topics (title, creator_id, settings) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [`memory private ${RUN}`, agentBId, JSON.stringify({ visibility: 'private' })],
      )) as { id: string }[];
      created.topicIds.push(topicPrivate[0].id);
      const secretMessage = await createMessage(
        topicPrivate[0].id,
        agentBId,
        `B 的私密原文 ${RUN}`,
      );

      const project = await createProject();
      const res = await nominate(
        project,
        claim(`forbidden-source-${RUN}`, {
          sourceRefs: [{ type: 'message', id: secretMessage }],
        }),
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      expect(res.body.message).toContain('source_refs[0]');
      expect(res.body.message).toContain('无权读取或不存在');
    });

    it('项目级无管理权限：PATCH 403（更新=权限变更；**不是 409**——无权不是状态冲突）', async () => {
      if (!dbAvailable) return;

      const project = await createProject(); // creator=A，绑定 A 的话题
      // B 非 creator、非 admin、无任何绑定写权限 ⇒ 403/PERMISSION_DENIED
      const res = await req(app, agentBKey)
        .patch(`/memory/projects/${project}`)
        .send({ name: `hijack ${RUN}` });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      expect(res.body.message).toContain('无本项目管理权限');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑧b 绑定读判定：private topic 参与者与运行时召回同口径（卡 7a21f96b）
  // ══════════════════════════════════════════════════════════════════

  describe('⑧b 绑定读判定（private topic 参与者）', () => {
    /**
     * 往 topic_participants 写一行。
     *
     * `active` 必须带 joinedAt——DB CHECK 不变量 `status != 'active' OR joined_at IS NOT NULL`；
     * `invited` 刻意留 null（受邀行未激活）。
     */
    async function addParticipant(
      topicId: string,
      participantId: string,
      status: ParticipantStatus,
    ): Promise<void> {
      const repo = ds.getRepository(TopicParticipant);
      await repo.save(
        repo.create({
          topicId,
          participantId,
          role: TopicParticipantRole.MEMBER,
          status,
          joinedAt: status === ParticipantStatus.ACTIVE ? new Date() : null,
          leftAt: null,
          notificationSettings: { mute: false, mentions_only: false },
          lastReadMessageId: null,
        }),
      );
    }

    /** 建一个 engine=none 的项目（本组只验绑定校验，不碰引擎面） */
    function createNoneProject(bindings: Array<{ type: string; id: string }>, key: string) {
      return req(app, key)
        .post('/memory/projects')
        .send({
          slug: `p-bind-${RUN}-${created.projectIds.length}`,
          name: `project bind ${RUN} #${created.projectIds.length}`,
          engine: 'none',
          bindings,
        });
    }

    it('invited 参与者绑定 private topic ⇒ 201（不再 400）；改绑同 topic ⇒ 200', async () => {
      if (!dbAvailable) return;

      const topic = await createTopic(agentBId, 'private');
      await addParticipant(topic, agentAId, ParticipantStatus.INVITED);

      const createdRes = await createNoneProject([{ type: 'topic', id: topic }], agentAKey);
      expect(createdRes.status).toBe(201);
      created.projectIds.push(createdRes.body.data.id as string);

      // 建完后**确实可读**（不只是"通过校验"）：详情投影 canReadContent 与运行时同口径实算
      const detail = await req(app, agentAKey).get(`/memory/projects/${createdRes.body.data.id}`);
      expect(detail.status).toBe(200);
      expect((detail.body as Envelope<{ canReadContent: boolean }>).data.canReadContent).toBe(true);

      // PATCH 改绑走同一 `assertBindingsResolvable`——修复必须同时覆盖「创建」与「改绑」
      const patched = await req(app, agentAKey)
        .patch(`/memory/projects/${createdRes.body.data.id}`)
        .send({ bindings: [{ type: 'topic', id: topic }] });
      expect(patched.status).toBe(200);
    });

    it('active 参与者同样通过（白名单口径 = invited + active）', async () => {
      if (!dbAvailable) return;

      const topic = await createTopic(agentBId, 'private');
      await addParticipant(topic, agentAId, ParticipantStatus.ACTIVE);

      const res = await createNoneProject([{ type: 'topic', id: topic }], agentAKey);
      expect(res.status).toBe(201);
      created.projectIds.push(res.body.data.id as string);
    });

    it('非参与者仍 400（指名字段 + 可读要求）', async () => {
      if (!dbAvailable) return;

      // A 的 private topic：B 既非创建者也无 participant 行
      const topic = await createTopic(agentAId, 'private');

      const res = await createNoneProject([{ type: 'topic', id: topic }], agentBKey);
      // 反例若意外 201（回归）项目已落库：兜底登记清理，避免污染共享库
      if (res.body?.data?.id) created.projectIds.push(res.body.data.id as string);
      expect(res.status).toBe(400);
      const message = JSON.stringify(res.body.message);
      expect(message).toContain(`bindings[topic:${topic}]`);
      expect(message).toContain('not readable');
    });

    it('left（已离开）不算参与者 ⇒ 400（白名单只认 invited/active）', async () => {
      if (!dbAvailable) return;

      const topic = await createTopic(agentBId, 'private');
      await addParticipant(topic, agentAId, ParticipantStatus.LEFT);

      const res = await createNoneProject([{ type: 'topic', id: topic }], agentAKey);
      // 反例若意外 201（回归）项目已落库：兜底登记清理，避免污染共享库
      if (res.body?.data?.id) created.projectIds.push(res.body.data.id as string);
      expect(res.status).toBe(400);
      // 字段级指认：400 必须点名 bindings[topic:<id>]，而不是泛泛的"某个绑定不可读"
      expect(JSON.stringify(res.body.message)).toContain(`bindings[topic:${topic}]`);
      expect(JSON.stringify(res.body.message)).toContain('not readable');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑨ 返修补测：PATCH 值判定 / withdrawn 续跑闸门 / 系统写不顶 updated_at
  // ══════════════════════════════════════════════════════════════════

  describe('⑨ 返修补测', () => {
    it('已绑引擎的项目 PATCH 仅改 name ⇒ 200，且三个引擎绑定列不变', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const before = (await ds.query(
        `SELECT engine, engine_workspace_id, engine_actor_id, engine_credential_ref
           FROM memory_projects WHERE id = $1`,
        [project],
      )) as Array<{
        engine: string;
        engine_workspace_id: string | null;
        engine_actor_id: string | null;
        engine_credential_ref: string | null;
      }>;

      // 回归守卫：值判定修好之前这里必然 400（`hasOwn` 恒真 ⇒ 引擎绑定三元组被当成"要改"，
      // 而请求里根本没带那三列 ⇒ "缺一不可"的校验把只改名的请求也拦了）
      const res = await req(app, agentAKey)
        .patch(`/memory/projects/${project}`)
        .send({ name: `renamed ${RUN}` });
      expect(res.status).toBe(200);
      const body = res.body as Envelope<{
        name: string;
        engine: string;
        engineWorkspaceId: string | null;
        engineActorId: string | null;
        engineCredentialRef: string | null;
      }>;
      expect(body.data.name).toBe(`renamed ${RUN}`);
      expect(body.data.engine).toBe(before[0].engine);
      expect(body.data.engineWorkspaceId).toBe(before[0].engine_workspace_id);
      expect(body.data.engineActorId).toBe(before[0].engine_actor_id);
      expect(body.data.engineCredentialRef).toBe(before[0].engine_credential_ref);

      const after = (await ds.query(
        `SELECT engine_workspace_id, engine_actor_id, engine_credential_ref
           FROM memory_projects WHERE id = $1`,
        [project],
      )) as Array<Record<string, string | null>>;
      expect(after[0]).toEqual({
        engine_workspace_id: before[0].engine_workspace_id,
        engine_actor_id: before[0].engine_actor_id,
        engine_credential_ref: before[0].engine_credential_ref,
      });
    });

    it('withdrawn 行不可续跑：retry ⇒ 409（否则会写回 ids，击穿 withdrawn ⇒ ids 空）', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      const oldRes = await nominate(project, claim(`withdrawn-retry-${RUN}`));
      const oldLedgerId = (oldRes.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      // 用"更正未达成"这条既有路径造一条 withdrawn 行（⑤ 已验证该路径本身）
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: `nom-w-${RUN}`,
          duplicate: false,
          jobState: 'committed',
          deferred: false,
          outcome: 'no_change_validated',
          memoryIds: [],
          durable: true,
        },
      };
      const dropped = await req(app, agentAKey)
        .post(`/memory/projects/${project}/corrections`)
        .send({ correctionOf: oldLedgerId, ...claim(`withdrawn-new-${RUN}`) });
      expect(dropped.status).toBe(200);
      const withdrawnId = (dropped.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      const retry = await req(app, agentAKey)
        .post(`/memory/nominations/${withdrawnId}/retry`)
        .send({});
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe(ErrorCode.MEMORY_NOMINATION_CONFLICT);
      expect(retry.body.message).toContain('withdrawn');

      // 不变量仍成立：没有被重发写回 ids
      const row = (await ds.query(
        `SELECT status, engine_memory_ids FROM memory_nominations WHERE id = $1`,
        [withdrawnId],
      )) as Array<{ status: string; engine_memory_ids: string[] | null }>;
      expect(row[0].status).toBe('withdrawn');
      expect(row[0].engine_memory_ids).toBeNull();
    });

    it('系统态写入不顶 updated_at：recover 推进 formation_state 但 updated_at 不变', async () => {
      if (!dbAvailable) return;

      const project = await createProject();
      scriptedEngine.next = {
        ok: true,
        value: {
          engineNominationId: `nom-ts-${RUN}`,
          duplicate: false,
          jobState: 'pending',
          deferred: true,
          outcome: 'deferred',
          memoryIds: [],
          durable: true,
        },
      };
      const res = await nominate(project, claim(`ts-${RUN}`));
      expect(res.status).toBe(202);
      const ledgerId = (res.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      const before = (await ds.query(`SELECT updated_at FROM memory_nominations WHERE id = $1`, [
        ledgerId,
      ])) as Array<{ updated_at: Date }>;

      const summary = await req(app, agentAKey)
        .post(`/memory/projects/${project}/recover`)
        .send({});
      expect(summary.status).toBe(202);

      const after = (await ds.query(
        `SELECT updated_at, formation_state FROM memory_nominations WHERE id = $1`,
        [ledgerId],
      )) as Array<{ updated_at: Date; formation_state: string }>;
      // 先确认收敛真的发生了（否则下一条断言是空转）
      expect(after[0].formation_state).toBe('committed');
      // 但 `updated_at`（"最近人工动作"信号）不被系统写顶
      expect(new Date(after[0].updated_at).getTime()).toBe(
        new Date(before[0].updated_at).getTime(),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑩ alias（引擎判重复 ⇒ 镜像 canonical 行）
  // ══════════════════════════════════════════════════════════════════

  describe('⑩ alias（内容级去重：镜像 canonical 行 / ids 恒空 / 召回不重复）', () => {
    it('canonical committed ⇒ alias 镜像 committed（201）：ids 恒空 + canonical 提名 id 落库 + 召回只映射 canonical 行', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const token = `alias-${RUN}`;

      const canonical = await nominate(projectId, claim(token));
      expect(canonical.status).toBe(201);
      const canonicalBody = canonical.body as Envelope<{
        ledgerId: string;
        engineNominationId: string;
        engineMemoryIds: string[];
      }>;
      expect(canonicalBody.data.engineMemoryIds).toHaveLength(1);

      // 第二次提名：**四要素逐字相同**（装配器是载荷的纯函数——不含账本 id / 时间戳）⇒ 引擎判重复。
      // 带上**独立的** clientRequestId 是为了坐实"这确实是一条新账本行，不是幂等重放"。
      const alias = await nominate(
        projectId,
        claim(token, { clientRequestId: `alias-key-${RUN}` }),
      );
      // 镜像的是 canonical 行的**当前**态 = committed ⇒ 逐态状态码与 committed 同一路（201）
      expect(alias.status).toBe(201);
      const aliasBody = alias.body as Envelope<{
        ledgerId: string;
        formationState: string;
        engineMemoryIds: string[];
        engineCanonicalNominationId: string | null;
        replay: boolean;
      }>;
      expect(aliasBody.data.ledgerId).not.toBe(canonicalBody.data.ledgerId);
      expect(aliasBody.data.replay).toBe(false);
      expect(aliasBody.data.formationState).toBe('committed');
      expect(aliasBody.data.engineMemoryIds).toEqual([]); // alias 不形成记忆
      expect(aliasBody.data.engineCanonicalNominationId).toBe(
        canonicalBody.data.engineNominationId,
      );

      // ── 真实 PG 直查：镜像与"不写 ids"必须落在**列**上（HTTP 投影自证不了落库） ──
      const rows = (await ds.query(
        `SELECT id, formation_state, engine_memory_ids, engine_nomination_id,
                engine_canonical_nomination_id
           FROM memory_nominations WHERE project_id = $1
          ORDER BY created_at ASC, id ASC`,
        [projectId],
      )) as Array<{
        id: string;
        formation_state: string;
        engine_memory_ids: string[] | null;
        engine_nomination_id: string | null;
        engine_canonical_nomination_id: string | null;
      }>;
      expect(rows.map((row) => row.id)).toEqual([
        canonicalBody.data.ledgerId,
        aliasBody.data.ledgerId,
      ]);
      const [canonicalRow, aliasRow] = rows;
      expect(canonicalRow.formation_state).toBe('committed');
      expect(canonicalRow.engine_memory_ids).toHaveLength(1);
      expect(aliasRow.formation_state).toBe(canonicalRow.formation_state); // 镜像 canonical 当前态
      expect(aliasRow.engine_memory_ids).toBeNull(); // alias 行恒 NULL（实体不变量）
      expect(aliasRow.engine_canonical_nomination_id).toBe(canonicalRow.engine_nomination_id);

      // ── 召回面：同正文在引擎侧只有**一条**记忆 ⇒ 只映射 canonical 行，alias 不重复出现、不 500 ──
      const recall = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `ctx-alias-${RUN}`, contextEpoch: 5 });
      expect(recall.status).toBe(200);
      const recallBody = recall.body as Envelope<{
        items: Array<{ ledgerId: string; memoryId: string }>;
        emptyReason: string;
        engineDataSuspect: boolean;
      }>;
      expect(recallBody.data.emptyReason).toBe('none');
      expect(recallBody.data.engineDataSuspect).toBe(false); // alias 行不是"映射不到的条目"
      expect(recallBody.data.items).toHaveLength(1);
      expect(recallBody.data.items[0].ledgerId).toBe(canonicalBody.data.ledgerId);

      // ── 回归：alias 行在账本读面正常（列表带该行、详情可读、ids 投影为空） ──
      const list = await req(app, agentAKey).get(`/memory/projects/${projectId}/nominations`);
      expect(list.status).toBe(200);
      const listBody = list.body as Envelope<{ items: Array<{ id: string }>; total: number }>;
      expect(listBody.data.total).toBe(2);
      expect(listBody.data.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([canonicalBody.data.ledgerId, aliasBody.data.ledgerId]),
      );

      const detail = await req(app, agentAKey).get(
        `/memory/nominations/${aliasBody.data.ledgerId}`,
      );
      expect(detail.status).toBe(200);
      const detailBody = detail.body as Envelope<{
        projection: string;
        content?: string;
        engineMemoryIds?: string[];
        engineCanonicalNominationId?: string | null;
      }>;
      expect(detailBody.data.projection).toBe('full');
      expect(detailBody.data.content).toContain(`主张 ${token}`); // alias 正文与 canonical 逐字节相同
      expect(detailBody.data.engineMemoryIds).toEqual([]);
      expect(detailBody.data.engineCanonicalNominationId).toBe(
        canonicalBody.data.engineNominationId,
      );
    });

    it('canonical 尚未收敛 ⇒ alias 镜像**当前态**（非终态也落库、也随其进扫描集）', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const token = `alias-inflight-${RUN}`;

      const canonical = await nominate(projectId, claim(token));
      expect(canonical.status).toBe(201);
      const canonicalId = (canonical.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      // 把 canonical 行改成"尚未收敛"（§7 第 7 行 committing 的形态：在途 + ids 不采纳）。
      // 这是**唯一**能表达"canonical 在途"的造法：FakeEngine 回执恒 committed，其形成态必然已落
      // committed。而本用例要考的正是"服务层镜像的是 canonical 行的**当前**态，不是 alias 回执里的
      // 快照"——故只能把"当前态"改成在途，再让 alias 去镜像它。
      await ds.query(
        `UPDATE memory_nominations SET formation_state = 'submitted', engine_memory_ids = NULL
          WHERE id = $1`,
        [canonicalId],
      );

      const alias = await nominate(
        projectId,
        claim(token, { clientRequestId: `alias-inflight-key-${RUN}` }),
      );
      // 镜像非终态 ⇒ 与 submitted 同一路（202，**不是** 201）
      expect(alias.status).toBe(202);
      const aliasBody = alias.body as Envelope<{
        ledgerId: string;
        formationState: string;
        engineMemoryIds: string[];
        engineCanonicalNominationId: string | null;
      }>;
      expect(aliasBody.data.formationState).toBe('submitted');
      expect(aliasBody.data.engineMemoryIds).toEqual([]);
      expect(aliasBody.data.engineCanonicalNominationId).toBeTruthy();

      const rows = (await ds.query(
        `SELECT id, formation_state, engine_memory_ids FROM memory_nominations
          WHERE project_id = $1 ORDER BY created_at ASC, id ASC`,
        [projectId],
      )) as Array<{ id: string; formation_state: string; engine_memory_ids: string[] | null }>;
      expect(rows).toHaveLength(2);
      const aliasRow = rows.find((row) => row.id === aliasBody.data.ledgerId);
      expect(aliasRow?.formation_state).toBe('submitted'); // 非终态照落（不是回落 conflict/unknown）
      expect(aliasRow?.engine_memory_ids).toBeNull();
    });

    it('canonical 不在本项目（共享 workspace 的邻项目）⇒ alias 落 conflict（409，不猜不建影子行）', async () => {
      if (!dbAvailable) return;

      // 同 workspace 的两个项目：引擎侧内容级去重是**按 workspace** 的，故邻项目先形成的那条记忆
      // 对后者的同内容提名就是 canonical——但它的账本行**不在本项目** ⇒ §7 的 conflict 分支。
      const workspace = `ws-alias-shared-${RUN}`;
      const projectA = await createProject({ engineWorkspaceId: workspace });
      // 同 workspace 的邻项目（平台 claim 四列唯一 ⇒ 用不同 actor；引擎仍按 workspace 去重）
      const projectB = await createProject({
        engineWorkspaceId: workspace,
        engineActorId: 'chamber-service-actor-b',
      });
      const token = `alias-cross-${RUN}`;

      const first = await nominate(projectA, claim(token));
      expect(first.status).toBe(201);
      const firstBody = first.body as Envelope<{ engineNominationId: string }>;

      const second = await nominate(projectB, claim(token));
      expect(second.status).toBe(409);
      expect(second.body.code).toBe(ErrorCode.MEMORY_NOMINATION_CONFLICT);

      const rows = (await ds.query(
        `SELECT formation_state, engine_memory_ids, engine_canonical_nomination_id
           FROM memory_nominations WHERE project_id = $1`,
        [projectB],
      )) as Array<{
        formation_state: string;
        engine_memory_ids: string[] | null;
        engine_canonical_nomination_id: string | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].formation_state).toBe('conflict');
      expect(rows[0].engine_memory_ids).toBeNull();
      // 线索照落（排障用），但**不猜**：没有 canonical 行可镜像 ⇒ conflict，而不是编一个状态
      expect(rows[0].engine_canonical_nomination_id).toBe(firstBody.data.engineNominationId);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑪ 更正目标落库（中断续跑同参：显式非主目标不得被打回主记忆）
  // ══════════════════════════════════════════════════════════════════

  describe('⑪ 更正目标落库（续跑同参）', () => {
    it('显式非主目标 + 中断续跑 ⇒ 续跑打到 mem2（不是旧行主记忆 mem1），且目标落在列上', async () => {
      if (!dbAvailable) return;

      // 同 workspace 的两个项目：mem2 必须**真实存在于引擎**，但又不能落进项目 A 的
      // `engine_memory_ids` 映射（否则 mem2 会同时映射到两行 ⇒ 映射 fail-closed 剔除它，
      // 断言面反而看不到它）。故 mem2 借邻项目 B 形成。
      const workspace = `ws-correct-target-${RUN}`;
      const projectA = await createProject({ engineWorkspaceId: workspace });
      // 同 workspace 的邻项目（平台 claim 四列唯一 ⇒ 用不同 actor；引擎仍按 workspace 去重）
      const projectB = await createProject({
        engineWorkspaceId: workspace,
        engineActorId: 'chamber-service-actor-b',
      });

      const oldToken = `ct-old-${RUN}`; // 旧主张（主记忆 mem1）
      const secondToken = `ct-second-${RUN}`; // 引擎侧第二条记忆 mem2（经项目 B 形成）
      const newToken = `ct-new-${RUN}`; // 新主张（形成 mem-new）

      // ① 项目 A 形成旧主张（一条记忆）
      const oldRes = await nominate(projectA, claim(oldToken));
      expect(oldRes.status).toBe(201);
      const oldLedgerId = (oldRes.body as Envelope<{ ledgerId: string; engineMemoryIds: string[] }>)
        .data.ledgerId;
      const mem1 = (oldRes.body as Envelope<{ engineMemoryIds: string[] }>).data.engineMemoryIds[0];
      expect(mem1).toBeTruthy();

      // ② 同 workspace 的邻项目形成 mem2（内容不同 ⇒ 引擎不判 alias）
      const secondRes = await nominate(projectB, claim(secondToken));
      expect(secondRes.status).toBe(201);
      const mem2 = (secondRes.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];
      expect(mem2).toBeTruthy();
      expect(mem2).not.toBe(mem1);

      // ③ 项目 A 里形成"新主张"行（稍后改造成中断的更正行）
      const newRes = await nominate(projectA, claim(newToken));
      expect(newRes.status).toBe(201);
      const newLedgerId = (newRes.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      // ④ 旧行声明它形成了**两条**记忆：主记忆 mem1 + 次记忆 mem2（缺省回退链会打到 mem1）
      await ds.query(`UPDATE memory_nominations SET engine_memory_ids = $2::jsonb WHERE id = $1`, [
        oldLedgerId,
        JSON.stringify([mem1, mem2]),
      ]);

      // ⑤ 把新行改造成"首跑中断"的形态：已是更正行 + 已 committed（记忆已形成）+ 无 correction id
      //    + 落库目标 = **非主记忆** mem2。
      //    ⚠️ 为什么不是"让 correct 首次落空"：ScriptedEngine 只覆盖 `nominate`（见其类注释：
      //    故障注入刻意留在测试侧），无法注入单次 correct 失败 ⇒ 直接构造中断态，断言面等价
      //    （续跑分支的进入条件恰好就是这四个字段）。
      await ds.query(
        `UPDATE memory_nominations
            SET correction_of = $2, correction_target_memory_id = $3, engine_correction_id = NULL
          WHERE id = $1`,
        [newLedgerId, oldLedgerId, mem2],
      );

      // ⑥ 续跑（POST /memory/nominations/:id/retry）⇒ 走更正续跑分支，目标取自**落库值**
      const resumed = await req(app, agentAKey).post(`/memory/nominations/${newLedgerId}/retry`);
      expect(resumed.status).toBe(201);
      const resumedBody = resumed.body as Envelope<{
        oldClaimStatus: string;
        formationState: string;
      }>;
      expect(resumedBody.data.oldClaimStatus).toBe('superseded');
      expect(resumedBody.data.formationState).toBe('committed');

      // ⑦ 落库自证：目标列 = mem2（续跑同参的锚点），旧行转 superseded
      const ledger = (await ds.query(
        `SELECT id, status, correction_of, correction_target_memory_id, engine_correction_id
           FROM memory_nominations WHERE id = $1`,
        [newLedgerId],
      )) as Array<{
        status: string;
        correction_of: string | null;
        correction_target_memory_id: string | null;
        engine_correction_id: string | null;
      }>;
      expect(ledger[0].correction_of).toBe(oldLedgerId);
      expect(ledger[0].correction_target_memory_id).toBe(mem2);
      expect(ledger[0].engine_correction_id).toBeTruthy();

      const oldRow = (await ds.query(`SELECT status FROM memory_nominations WHERE id = $1`, [
        oldLedgerId,
      ])) as Array<{ status: string }>;
      expect(oldRow[0].status).toBe('superseded');

      // ⑦-b 本列**仅更正行有意义**：两个项目里的普通提名行一律 NULL（列不变量）
      const ordinaryRows = (await ds.query(
        `SELECT correction_of, correction_target_memory_id FROM memory_nominations
          WHERE project_id = ANY($1::uuid[])`,
        [[projectA, projectB]],
      )) as Array<{ correction_of: string | null; correction_target_memory_id: string | null }>;
      expect(ordinaryRows.length).toBeGreaterThan(0);
      expect(
        ordinaryRows
          .filter((row) => row.correction_of === null)
          .every((row) => row.correction_target_memory_id === null),
      ).toBe(true);

      // ⑧ 引擎侧自证（欠账本体）：被 supersede 的是 **mem2**，mem1 仍是当前有效主张。
      //    缺了落库值这一级，这两个断言会同时反向（mem1 superseded / mem2 active）。
      const mem2Detail = await req(app, agentAKey).get(
        `/memory/projects/${projectA}/memories/${mem2}`,
      );
      expect(mem2Detail.status).toBe(200);
      expect(
        (mem2Detail.body as Envelope<{ engine: { memory: { status: string } } }>).data.engine.memory
          .status,
      ).toBe('superseded');

      const mem1Detail = await req(app, agentAKey).get(
        `/memory/projects/${projectA}/memories/${mem1}`,
      );
      expect(mem1Detail.status).toBe(200);
      expect(
        (mem1Detail.body as Envelope<{ engine: { memory: { status: string } } }>).data.engine.memory
          .status,
      ).toBe('active');

      // ⑨ 读面：详情透出落库目标（full 投影；metadata 降级面不含它——与 engineNominationId 同档）
      const detail = await req(app, agentAKey).get(`/memory/nominations/${newLedgerId}`);
      expect(detail.status).toBe(200);
      const detailBody = detail.body as Envelope<{
        projection: string;
        correctionTargetMemoryId?: string | null;
      }>;
      expect(detailBody.data.projection).toBe('full');
      expect(detailBody.data.correctionTargetMemoryId).toBe(mem2);
    });

    it('落库目标为空（列后加的旧行）⇒ 续跑回落到旧行主记忆（末级兜底，不因新列 409）', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const oldToken = `ct-fallback-old-${RUN}`;
      const newToken = `ct-fallback-new-${RUN}`;

      const oldRes = await nominate(projectId, claim(oldToken));
      const oldLedgerId = (oldRes.body as Envelope<{ ledgerId: string }>).data.ledgerId;
      const mem1 = (oldRes.body as Envelope<{ engineMemoryIds: string[] }>).data.engineMemoryIds[0];

      const newRes = await nominate(projectId, claim(newToken));
      const newLedgerId = (newRes.body as Envelope<{ ledgerId: string }>).data.ledgerId;

      // 中断态 + **目标列留空**（模拟本列上线前落下的旧行）
      await ds.query(
        `UPDATE memory_nominations
            SET correction_of = $2, correction_target_memory_id = NULL, engine_correction_id = NULL
          WHERE id = $1`,
        [newLedgerId, oldLedgerId],
      );

      const resumed = await req(app, agentAKey).post(`/memory/nominations/${newLedgerId}/retry`);
      expect(resumed.status).toBe(201);

      // 末级兜底仍是旧行主记忆（不是 409、也不是静默不动）
      const mem1Detail = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/memories/${mem1}`,
      );
      expect(mem1Detail.status).toBe(200);
      expect(
        (mem1Detail.body as Envelope<{ engine: { memory: { status: string } } }>).data.engine.memory
          .status,
      ).toBe('superseded');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑫ 召回 query 原文留存（默认开 / 可关 / **零 API 读取面**）
  // ══════════════════════════════════════════════════════════════════

  describe('⑫ 召回 query 原文留存（默认开 + 可关）', () => {
    /** 召回遥测两列的 sha256（与实现同款，用来**确定性**定位某一次召回的行） */
    const sha256 = (value: string): string =>
      crypto.createHash('sha256').update(value).digest('hex');

    /** 按 query_hash 取那一行的原文列（唯一命中 ⇒ 不受 created_at 同刻并列影响） */
    const queryTextOf = async (projectId: string, query: string): Promise<string | null> => {
      const rows = (await ds.query(
        `SELECT query_text FROM memory_recall_events WHERE project_id = $1 AND query_hash = $2`,
        [projectId, sha256(query)],
      )) as Array<{ query_text: string | null }>;
      expect(rows).toHaveLength(1);
      return rows[0].query_text;
    };

    it('新项目默认 retainQueryText=true，召回后 query_text 落**原文**（摘要照旧）', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const token = `qt-on-${RUN}`;

      // 开关默认开 = 库侧 DEFAULT true（不是服务层补的）：创建投影里直接读得到
      const detail = await req(app, agentAKey).get(`/memory/projects/${projectId}`);
      expect((detail.body as Envelope<{ retainQueryText: boolean }>).data.retainQueryText).toBe(
        true,
      );

      const res = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `qt-${RUN}`, contextEpoch: 1 });
      expect(res.status).toBe(200);

      // ⚠️ 原文列**没有 API 读取面**（select:false + 无响应字段）⇒ 只能显式 SQL 读
      expect(await queryTextOf(projectId, token)).toBe(token);

      const hashes = (await ds.query(
        `SELECT query_hash FROM memory_recall_events WHERE project_id = $1`,
        [projectId],
      )) as Array<{ query_hash: string }>;
      expect(hashes[0].query_hash).toBe(sha256(token));
    });

    it('PATCH retainQueryText=false 后再召回 ⇒ 新行 query_text 为 NULL，**历史行不被回改**', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const before = `qt-before-${RUN}`;
      const after = `qt-after-${RUN}`;

      // ① 默认开：先落一行带原文的
      const first = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: before, contextIdentity: `qt-b-${RUN}`, contextEpoch: 1 });
      expect(first.status).toBe(200);

      // ② 翻关（PATCH 的写权限：agent A 是 creator）
      const patched = await req(app, agentAKey)
        .patch(`/memory/projects/${projectId}`)
        .send({ retainQueryText: false });
      expect(patched.status).toBe(200);
      expect((patched.body as Envelope<{ retainQueryText: boolean }>).data.retainQueryText).toBe(
        false,
      );

      // ③ 关掉后再召回 ⇒ 新行原文列 NULL（摘要在，排障仍可对账）
      const second = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: after, contextIdentity: `qt-a-${RUN}`, contextEpoch: 1 });
      expect(second.status).toBe(200);

      expect(await queryTextOf(projectId, after)).toBeNull();
      // 历史行**不被回改**：开关只对之后新落的行生效
      expect(await queryTextOf(projectId, before)).toBe(before);
    });

    it('**零 API 读取面**：项目投影只有开关、召回响应不回显 query 原文', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const token = `qt-noleak-${RUN}`;

      const recall = await req(app, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `qt-nl-${RUN}`, contextEpoch: 1 });
      expect(recall.status).toBe(200);
      // 召回响应体里不得出现查询原文（否则原文就成了一个隐式读取面）
      expect(JSON.stringify((recall.body as Envelope<unknown>).data)).not.toContain(token);

      const detail = await req(app, agentAKey).get(`/memory/projects/${projectId}`);
      const data = (detail.body as Envelope<Record<string, unknown>>).data;
      // 项目投影只暴露**开关**，不暴露原文（原文只走运维 SQL）
      expect(data).not.toHaveProperty('queryText');
      expect(data.retainQueryText).toBe(true);
      expect(JSON.stringify(data)).not.toContain(token);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑬ 自助开通：建项目自动注册 workspace/binding（二期）
  // ══════════════════════════════════════════════════════════════════

  describe('⑬ 自助开通（自动注册 / 显式三键 / 部分缺）', () => {
    beforeEach(() => {
      // 每个用例从"零调用 + 按派生规则成功"起步（替身是套件级共享的）
      scriptedProvisioning.reset();
      // 可控 save 失败开关也复位（只有孤儿善后用例会打开它）
      saveFailure.enabled = false;
    });

    /** 走 provisioning app 造项目（**不带三键** ⇒ 命中自动注册分支） */
    function autoCreate(slug: string, overrides: Record<string, unknown> = {}) {
      return req(appWithProvisioning, agentAKey)
        .post('/memory/projects')
        .send({
          slug,
          name: `prov ${slug}`,
          bindings: [{ type: 'topic', id: fx.topicOpen }],
          engine: 'hument',
          // ⚠️ 刻意**不带** engineWorkspaceId / engineActorId / engineCredentialRef（三键全缺）
          ...overrides,
        });
    }

    /** 登记一个新建项目的 id 供 afterAll 清理（RESTRICT 外键：先删账本再删项目） */
    function trackProject(res: { body: unknown }): string {
      const id = (res.body as Envelope<{ id: string }>).data.id;
      created.projectIds.push(id);
      return id;
    }

    it('① 全缺三键 ⇒ 自动注册：响应 + **DB 行**三列 = 派生三键，且替身只收到 slug', async () => {
      if (!dbAvailable) return;

      const slug = `prov-auto-${RUN}`;
      const res = await autoCreate(slug);

      // 这一条同时是 `overrideProvider(MEMORY_PROVISIONING)` **生效性**的实证：
      // 若它没生效，token 会落到 config 兜底（未启用）⇒ 这里是 400 而不是 201。
      expect(res.status).toBe(201);
      const body = res.body as Envelope<{
        id: string;
        engine: string;
        engineWorkspaceId: string | null;
        engineActorId: string | null;
        engineCredentialRef: string | null;
        engineAvailability: { available: boolean; reason: string | null };
      }>;
      // 先登记清理（断言中途失败也不让行残留——本套件打共享开发库）
      created.projectIds.push(body.data.id);

      // 服务 → 替身的唯一输入就是 slug（注册体的 11 字段在真客户端内部装配，
      // 由 hument-provisioning.client.spec.ts 逐字段钉住）
      expect(scriptedProvisioning.calls).toEqual([slug]);
      // 派生规则单源（e2e 层只需钉住"响应里落的是这套派生值"）
      expect(HUMENT_PROVISIONING_ACTOR_ID).toBe('chamber');
      expect(buildProvisioningBindingId(slug)).toBe(`binding-http-${slug}`);

      expect(body.data.engine).toBe('hument');
      expect(body.data.engineWorkspaceId).toBe(slug);
      expect(body.data.engineActorId).toBe('chamber');
      expect(body.data.engineCredentialRef).toBe(buildProvisioningCredentialRef(slug));
      // 引擎可用性块必须随之变"可用"（三列齐 + token 在）
      expect(body.data.engineAvailability).toEqual({
        engine: 'hument',
        available: true,
        reason: null,
      });

      const rows = (await ds.query(
        `SELECT engine, engine_workspace_id, engine_actor_id, engine_credential_ref
           FROM memory_projects WHERE id = $1`,
        [body.data.id],
      )) as Array<{
        engine: string;
        engine_workspace_id: string | null;
        engine_actor_id: string | null;
        engine_credential_ref: string | null;
      }>;
      expect(rows[0]).toEqual({
        engine: 'hument',
        engine_workspace_id: slug,
        engine_actor_id: 'chamber',
        engine_credential_ref: buildProvisioningCredentialRef(slug),
      });
    });

    it('② 自动注册出来的三键能流过 engineTarget：nominate ⇒ committed ⇒ recall 命中', async () => {
      if (!dbAvailable) return;

      const slug = `prov-chain-${RUN}`;
      const created0 = await autoCreate(slug);
      expect(created0.status).toBe(201);
      const projectId = trackProject(created0);

      const token = `prov-chain-${RUN}`;
      const nominated = await nominate(projectId, claim(token), appWithProvisioning, agentAKey);
      expect(nominated.status).toBe(201);
      const nominatedBody = nominated.body as Envelope<{
        formationState: string;
        engineAvailability: { available: boolean };
      }>;
      expect(nominatedBody.data.formationState).toBe('committed');
      // 派生三键确实被当成 workspace/actor/credential 用了（否则这里会是 project_engine_unbound）
      expect(nominatedBody.data.engineAvailability.available).toBe(true);

      const recalled = await req(appWithProvisioning, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: token, contextIdentity: `prov-ctx-${RUN}`, contextEpoch: 1 });
      expect(recalled.status).toBe(200);
      const recallBody = recalled.body as Envelope<{
        items: Array<{ subject: string }>;
      }>;
      // 新 workspace（= 新 slug）+ 新 token ⇒ 必然是**新**记忆，不是别处项目的 alias/重复
      expect(recallBody.data.items.length).toBeGreaterThan(0);
      expect(recallBody.data.items.some((item) => item.subject.includes(token))).toBe(true);
    });

    it('③ 三键全显式 ⇒ 手工老路，**零注册调用**（替身被调即抛错）', async () => {
      if (!dbAvailable) return;

      scriptedProvisioning.throwOnCall = true;
      const slug = `prov-explicit-${RUN}`;
      const res = await req(appWithProvisioning, agentAKey)
        .post('/memory/projects')
        .send({
          slug,
          name: `prov ${slug}`,
          bindings: [{ type: 'topic', id: fx.topicOpen }],
          engine: 'hument',
          engineWorkspaceId: `ws-manual-${RUN}`,
          engineActorId: 'chamber-service-actor',
          engineCredentialRef: `cred-manual-${RUN}`,
        });

      expect(res.status).toBe(201);
      const body = res.body as Envelope<{
        engineWorkspaceId: string | null;
        engineCredentialRef: string | null;
      }>;
      // 落的是**显式给的那套**，不是派生值
      expect(body.data.engineWorkspaceId).toBe(`ws-manual-${RUN}`);
      expect(body.data.engineCredentialRef).toBe(`cred-manual-${RUN}`);
      expect(scriptedProvisioning.calls).toEqual([]);
      created.projectIds.push((res.body as Envelope<{ id: string }>).data.id);
    });

    it('④ 三键**部分缺** ⇒ 400 指名字段（替身零调用；不猜测缺的那一列）', async () => {
      if (!dbAvailable) return;

      scriptedProvisioning.throwOnCall = true;
      const res = await autoCreate(`prov-partial-${RUN}`, { engineWorkspaceId: `ws-only-${RUN}` });

      expect(res.status).toBe(400);
      const body = res.body as Envelope<{ field?: string }> & { message: string };
      expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(body.data.field).toBe('engineActorId');
      expect(scriptedProvisioning.calls).toEqual([]);

      // 也没留下任何行（400 早于 save）
      const rows = (await ds.query(`SELECT id FROM memory_projects WHERE slug = $1`, [
        `prov-partial-${RUN}`,
      ])) as unknown[];
      expect(rows).toHaveLength(0);
    });

    it('⑤ 注册失败 ⇒ 503 + data.reason，且 **DB 无行**（provision 早于 save）', async () => {
      if (!dbAvailable) return;

      const slug = `prov-fail-${RUN}`;
      scriptedProvisioning.next = {
        ok: false,
        failure: {
          kind: 'http',
          httpStatus: 403,
          engineCode: 'scope_denied',
          message: 'Hument operator registration returned HTTP 403',
          latencyMs: 3,
        },
      };

      const res = await autoCreate(slug);

      expect(res.status).toBe(503);
      const body = res.body as Envelope<{ reason: string; engineCode?: string }> & {
        message: string;
      };
      expect(body.code).toBe(ErrorCode.MEMORY_UNAVAILABLE);
      expect(body.data.reason).toBe('provisioning_failed');
      // engineCode 透传：消费方不必解析文案
      expect(body.data.engineCode).toBe('scope_denied');

      expect(scriptedProvisioning.calls).toEqual([slug]);
      const rows = (await ds.query(`SELECT id FROM memory_projects WHERE slug = $1`, [
        slug,
      ])) as unknown[];
      expect(rows).toHaveLength(0);
    });

    it('⑥ 未启用自助开通的 app（token=null）⇒ 全缺三键仍是 400（现状语义不变）', async () => {
      if (!dbAvailable) return;

      const slug = `prov-null-${RUN}`;
      const res = await req(appWithoutEngine, agentAKey)
        .post('/memory/projects')
        .send({
          slug,
          name: `prov ${slug}`,
          bindings: [{ type: 'topic', id: fx.topicOpen }],
          engine: 'hument',
        });

      expect(res.status).toBe(400);
      const body = res.body as Envelope<{ field?: string }> & { message: string };
      expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(body.data.field).toBe('engineWorkspaceId');
      // 该 app 的替身从未存在于它的 module graph 里 —— 只断言本套件共享替身没被这条路径摸到
      expect(scriptedProvisioning.calls).toEqual([]);

      const rows = (await ds.query(`SELECT id FROM memory_projects WHERE slug = $1`, [
        slug,
      ])) as unknown[];
      expect(rows).toHaveLength(0);
    });

    it('⑦ slug 预检**先于** provision ⇒ 同名已占用时 409 且替身零调用（Hub 不留孤儿）', async () => {
      if (!dbAvailable) return;

      const slug = `prov-dup-${RUN}`;
      // 先占位（engine=none ⇒ 不走注册；同一 slug）
      const first = await req(appWithProvisioning, agentAKey)
        .post('/memory/projects')
        .send({
          slug,
          name: `holder ${slug}`,
          bindings: [{ type: 'topic', id: fx.topicOpen }],
          engine: 'none',
        });
      expect(first.status).toBe(201);
      created.projectIds.push((first.body as Envelope<{ id: string }>).data.id);

      scriptedProvisioning.throwOnCall = true;
      const second = await autoCreate(slug);

      expect(second.status).toBe(409);
      expect((second.body as Envelope<unknown>).code).toBe(ErrorCode.MEMORY_PROJECT_CONFLICT);
      // ⚠️ 关键：注册在预检之后 ⇒ 这条路径下替身**一次都没被调**（Hub 上不会有孤儿 workspace）
      expect(scriptedProvisioning.calls).toEqual([]);
    });

    it('⑧ 自动注册把**展示名**交给 Hub（mock 收到 displayName = DTO 的 name）', async () => {
      if (!dbAvailable) return;

      const slug = `prov-name-${RUN}`;
      const res = await autoCreate(slug); // autoCreate 的 name = `prov ${slug}`
      expect(res.status).toBe(201);
      created.projectIds.push((res.body as Envelope<{ id: string }>).data.id);

      expect(scriptedProvisioning.calls).toEqual([slug]);
      // 服务层把 DTO 的 name（trim 后）透传给 provision ⇒ Hub 侧 display_name 与平台展示名对齐
      expect(scriptedProvisioning.displayNames).toEqual([`prov ${slug}`]);
    });

    it('⑨ provision 成功但 save 失败 ⇒ **best-effort disable 被调**（孤儿从"还在服务"降级为 disabled）', async () => {
      if (!dbAvailable) return;

      const slug = `prov-orphan-${RUN}`;
      // 打开可控 save 失败：走 service 的孤儿路径（真 PG 上不并发造不出 23505）
      saveFailure.enabled = true;
      let status = 0;
      try {
        const res = await autoCreate(slug);
        status = res.status;
        // 若失败注入失效（意外 201），也要登记 id 供 afterAll 精确清理 claim/project
        const maybeId = (res.body as Envelope<{ id?: string }> | undefined)?.data?.id;
        if (maybeId) created.projectIds.push(maybeId);
      } finally {
        saveFailure.enabled = false;
      }
      // save 抛的是非 23505（40001）⇒ 服务层**原样透出**，响应是 500（孤儿善后绝不改变报错路径）
      expect(status).toBe(500);

      // Hub 侧登记成功（替身收到 slug），本地 save 失败 ⇒ 善后被调一次（同 slug）
      // ⚠️ B-1 前提复核：这条路径下本地**确实无行**（save 根本没成功），复核通过 ⇒ disable 照常发出
      expect(scriptedProvisioning.calls).toEqual([slug]);
      expect(scriptedProvisioning.disableCalls).toEqual([slug]);

      // 本地**没有**残留行（save 失败早于落库）；Hub 侧登记已由 disable 收口
      const rows = (await ds.query(`SELECT id FROM memory_projects WHERE slug = $1`, [
        slug,
      ])) as unknown[];
      expect(rows).toHaveLength(0);
    });

    it('⑩ 软删项目同 slug 自动注册重放 ⇒ 预查 claim/withDeleted 直接 409，Hub 调用与 disable 均为 0（F1）', async () => {
      if (!dbAvailable) return;

      const slug = `prov-softdel-${RUN}`;
      const first = await autoCreate(slug);
      expect(first.status).toBe(201);
      const projectId = trackProject(first);
      expect(scriptedProvisioning.calls).toEqual([slug]);

      // 软删项目（保留 claim）：同 slug 再自动注册时，Hub 会重放既有登记
      await ds.query(`UPDATE memory_projects SET deleted_at = now() WHERE id = $1`, [projectId]);

      // 清空替身调用记录：本用例要证明第二次请求**一次 Hub 都没打**
      scriptedProvisioning.reset();

      const second = await autoCreate(slug);
      expect(second.status).toBe(409);
      expect((second.body as Envelope<unknown>).code).toBe(ErrorCode.MEMORY_PROJECT_CONFLICT);
      expect(scriptedProvisioning.calls).toEqual([]);
      expect(scriptedProvisioning.disableCalls).toEqual([]);

      // 只有原软删行，没有新行
      const rows = (await ds.query(
        `SELECT id, deleted_at FROM memory_projects WHERE slug = $1 ORDER BY id`,
        [slug],
      )) as Array<{ id: string; deleted_at: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(projectId);
      expect(rows[0].deleted_at).not.toBeNull();

      // ── 删除 claim 后重试：命中 **withDeleted 历史项目** 预查分支（不是 claim 分支）──
      // 精确按本 run 自建 projectId 清理，绝不宽匹配。
      await ds.query(`DELETE FROM memory_engine_binding_claims WHERE project_id = $1`, [projectId]);
      expect(
        await ds.query(
          `SELECT count(*)::int AS n FROM memory_engine_binding_claims WHERE project_id = $1`,
          [projectId],
        ),
      ).toEqual([{ n: 0 }]);

      scriptedProvisioning.reset();
      const third = await autoCreate(slug);
      expect(third.status).toBe(409);
      expect((third.body as Envelope<unknown>).code).toBe(ErrorCode.MEMORY_PROJECT_CONFLICT);
      expect(scriptedProvisioning.calls).toEqual([]);
      expect(scriptedProvisioning.disableCalls).toEqual([]);

      // 仍只有原软删行；且没有因这次重试新写 claim
      const rowsAfterClaimRemoval = (await ds.query(
        `SELECT id, deleted_at FROM memory_projects WHERE slug = $1 ORDER BY id`,
        [slug],
      )) as Array<{ id: string; deleted_at: string | null }>;
      expect(rowsAfterClaimRemoval).toHaveLength(1);
      expect(rowsAfterClaimRemoval[0].id).toBe(projectId);
      expect(rowsAfterClaimRemoval[0].deleted_at).not.toBeNull();
      expect(
        await ds.query(
          `SELECT count(*)::int AS n FROM memory_engine_binding_claims WHERE project_id = $1`,
          [projectId],
        ),
      ).toEqual([{ n: 0 }]);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑭ 项目投影 canReadContent（A3）+ 列表信封 provisioningAvailable（A2 后端补位）
  // ══════════════════════════════════════════════════════════════════

  describe('⑭ 项目投影 canReadContent + 列表信封 provisioningAvailable', () => {
    /** JWT（人类）通道助手：本组只有 "admin bypass" 类用例用得到（agent 通道没有 role） */
    function jwtReq(appUnderTest: INestApplication, token: string) {
      return {
        get: (path: string) =>
          request(appUnderTest.getHttpServer())
            .get(`${API_PREFIX}${path}`)
            .set('Authorization', `Bearer ${token}`),
      };
    }

    /**
     * 解析一个**可用**的 admin 人类 JWT（本组 admin bypass 断言的唯一身份来源）。
     *
     * ⚠️ 不能无条件 `createHuman(UserRole.ADMIN)`：`idx_unique_admin` 是**唯一**部分索引
     * （全库至多一个 admin）⇒ 库里已有 admin 时再造就 23505。故先复用既有 admin
     * （只读操作，绝不动它）；只有全新库（无 "active 且未软删" 的 admin）才现造一个。
     * 判据**必须** join actors 并校验 `status='active'` ∧ `deleted_at IS NULL`——只按
     * `users.role='admin'` 取会复用到一个已停用/已软删的 actor，JWT 过不了 guard，
     * 测试会以"401"这种看不出真因的方式红。
     */
    async function resolveAdminToken(): Promise<string> {
      const admins = (await ds.query(
        `SELECT u.id AS id FROM users u JOIN actors a ON a.id = u.id
          WHERE u.role = 'admin' AND a.status = 'active' AND a.deleted_at IS NULL LIMIT 1`,
      )) as Array<{ id: string }>;
      const adminUserId = admins[0]?.id ?? (await createHuman(UserRole.ADMIN, 902, 'VisAdmin'));
      return jwtService.sign({
        sub: adminUserId,
        email: `admin-${RUN}@example.com`,
        role: UserRole.ADMIN,
      });
    }

    it('清空绑定 ⇒ canReadContent 翻 false（详情 + 列表一致）；admin 恒 true（bypass 设计）', async () => {
      if (!dbAvailable) return;

      const slug = `canread-${RUN}`;
      const projectId = await createProject({ slug });

      // ① 初态：绑定 = A 的可读话题 ⇒ 内容读权限为 true
      const before = await req(app, agentAKey).get(`/memory/projects/${projectId}`);
      expect(before.status).toBe(200);
      const beforeBody = before.body as Envelope<{ canReadContent: boolean; bindings: unknown[] }>;
      expect(beforeBody.data.bindings).toHaveLength(1);
      expect(beforeBody.data.canReadContent).toBe(true);

      // ② 清空绑定（UpdateMemoryProjectDto.bindings 无 ArrayNotEmpty ⇒ `[]` 是合法输入）：
      //    A 是 creator（治理观察者）⇒ 详情仍 200，但内容读权限必须翻 false。
      //    ⚠️ 响应里的 false 证明的是"**改绑后重算**"——拿变更前的 true 投影会撒谎。
      const cleared = await req(app, agentAKey)
        .patch(`/memory/projects/${projectId}`)
        .send({ bindings: [] });
      expect(cleared.status).toBe(200);
      const clearedBody = cleared.body as Envelope<{
        canReadContent: boolean;
        bindings: unknown[];
      }>;
      expect(clearedBody.data.bindings).toEqual([]);
      expect(clearedBody.data.canReadContent).toBe(false);

      // ③ 详情复读 + 列表同项目：两处口径一致（列表项取的是**该行自己的** access）
      const detail = await req(app, agentAKey).get(`/memory/projects/${projectId}`);
      expect((detail.body as Envelope<{ canReadContent: boolean }>).data.canReadContent).toBe(
        false,
      );

      const list = await req(app, agentAKey).get(`/memory/projects?slug=${slug}`);
      const listBody = list.body as Envelope<{
        items: Array<{ id: string; canReadContent: boolean }>;
      }>;
      expect(listBody.data.items).toHaveLength(1);
      expect(listBody.data.items[0].canReadContent).toBe(false);

      // ④ **admin 恒 true**（显式断言）：这是 memory-access.service.ts `resolveProjectAccess` 的
      //    `readable: isAdmin || resolved.some(...)` bypass 设计（Policy 层 admin 全放行），
      //    与"本项目绑定是否为空"无关。走人类 JWT 通道是**唯一**能拿到 admin 身份的路
      //    （agent 通道不填 role）。
      // ⚠️ 不能无条件 `createHuman(UserRole.ADMIN)`：`idx_unique_admin` 是**唯一**部分索引
      //   （全库至多一个 admin）⇒ 库里已有 admin 时再造就 23505。故先复用既有 admin
      //   （只读操作，绝不动它）；只有全新库（无 "active 且未软删" 的 admin）才现造一个。
      //   判据逐字对齐兄弟套件（experience.e2e-spec.ts / usage-stats.e2e-spec.ts 的
      //   `resolveAdmin()`）：**必须 join actors 并校验 `status='active'` ∧ `deleted_at IS NULL`**
      //   ——只按 `users.role='admin'` 取会复用到一个已停用/已软删的 actor，JWT 过不了 guard，
      //   测试会以"401"这种看不出真因的方式红。
      const admins = (await ds.query(
        `SELECT u.id AS id FROM users u JOIN actors a ON a.id = u.id
          WHERE u.role = 'admin' AND a.status = 'active' AND a.deleted_at IS NULL LIMIT 1`,
      )) as Array<{ id: string }>;
      const adminUserId = admins[0]?.id ?? (await createHuman(UserRole.ADMIN, 901, 'CanReadAdmin'));
      const adminToken = jwtService.sign({
        sub: adminUserId,
        email: `admin-${RUN}@example.com`,
        role: UserRole.ADMIN,
      });
      const adminDetail = await jwtReq(app, adminToken).get(`/memory/projects/${projectId}`);
      expect(adminDetail.status).toBe(200);
      expect((adminDetail.body as Envelope<{ canReadContent: boolean }>).data.canReadContent).toBe(
        true,
      );
      const adminList = await jwtReq(app, adminToken).get(`/memory/projects?slug=${slug}`);
      expect(
        (adminList.body as Envelope<{ items: Array<{ canReadContent: boolean }> }>).data.items[0]
          .canReadContent,
      ).toBe(true);
    });

    it('（可选）绑定的可读资源被软删 ⇒ canReadContent 转 false（详情仍 200：治理观察者路径）', async () => {
      if (!dbAvailable) return;

      // 专用话题——**绝不软删套件共享夹具 fx.topicOpen**（会连累其它用例）
      const topic = await createTopic(agentAId, 'open');
      const projectId = await createProject({
        slug: `canread-del-${RUN}`,
        bindings: [{ type: 'topic', id: topic }],
      });
      const before = await req(app, agentAKey).get(`/memory/projects/${projectId}`);
      expect((before.body as Envelope<{ canReadContent: boolean }>).data.canReadContent).toBe(true);

      // 软删绑定资源：绑定条目还在，但解析出 readable=false（"存在 + 未软删"是读权限前提）
      await ds.query(`UPDATE topics SET deleted_at = now() WHERE id = $1`, [topic]);

      const after = await req(app, agentAKey).get(`/memory/projects/${projectId}`);
      // creator ⇒ 治理观察者 ⇒ 项目元数据仍可见（200），只是内容面关闭
      expect(after.status).toBe(200);
      expect((after.body as Envelope<{ canReadContent: boolean }>).data.canReadContent).toBe(false);
    });

    it('provisioningAvailable：**显式钉 null** 的 app ⇒ false；装配替身的 app ⇒ true（部署态、零项目也带）', async () => {
      if (!dbAvailable) return;

      // ⚠️ 刻意用 `appWithoutEngine` 而不是主 app（评审 M-2）：主 app 没 override
      //  `MEMORY_PROVISIONING` ⇒ 会落到**真工厂**读 `process.env`（HUMENT_PROVISIONING_ENABLED /
      //  HUMENT_OPERATOR_SOCKET_PATH）——在启用了自助开通的机器上这里会假红。本组只认
      //  **显式钉过 token** 的 app（与 :808-811 的装配纪律同源）。
      const off = await req(appWithoutEngine, agentAKey).get('/memory/projects');
      expect(off.status).toBe(200);
      expect(
        (off.body as Envelope<{ provisioningAvailable: boolean }>).data.provisioningAvailable,
      ).toBe(false);

      // 第三组 app 显式注入脚本替身 ⇒ 装配态 ⇒ true（与"列表里有没有项目"无关，是部署态）
      const on = await req(appWithProvisioning, agentAKey).get('/memory/projects');
      expect(on.status).toBe(200);
      expect(
        (on.body as Envelope<{ provisioningAvailable: boolean }>).data.provisioningAvailable,
      ).toBe(true);
    });

    /**
     * 回归锁（卡 27d7006d）：**admin 视角的列表必须包含自己按绑定读不到的项目**。
     *
     * 守的是什么：`memory-access.service.ts` 的 `resolveProjectAccess` 里
     * `readable: isAdmin || resolved.some(...)` 这一处 admin 短路，配上 `findAll` 的
     * `if (access.readable || access.isGovernanceViewer)` 收口，再配 `toDto` 的
     * `canReadContent: access.readable`。
     *
     * ⚠️ **这条锁的种子必须选对，否则它是空的——本结论是实测出来的，不是推理出来的**：
     * Topic / Board / DocSpace 三个 Policy 的 `can()` **各自第一行就有 admin bypass**
     * （`board.policy.ts:74` / `doc-space.policy.ts:63` / `topic.policy.ts:89`），所以
     * "绑定一个私有资源"对 admin 依然可读——**Policy 层就放行了，走不到 `isAdmin` 短路**。
     * 实测：把 `isAdmin` 改写成 `false` 做变异探针，"只绑私有资源"的断言**照旧绿**。
     * 让 `isAdmin` 成为唯一救命稻草的只有两种形态，本用例两种各钉一个：
     *   ① 绑**私有看板**（卡片 27d7006d 的原始场景：防"admin 漏看私有绑定项目"）——走 Policy 层 admin bypass；
     *   ② 绑**已被软删的看板**——`resolveBinding` 在资源加载不到时**直接返回 `readable:false`、
     *      根本不调 Policy**（见 `memory-access.service.ts` 的 `loadBindingResource` 早返回段），
     *      admin bypass 无处发力 ⇒ 只有 `resolveProjectAccess` 的 `isAdmin` 能救。
     *      **②才是变异探针会变红的那个锁**；①保的是卡片场景本身。
     *
     * 负面对照（B 的列表）是这条锁的**有效性证明**：没有它，一个"列表恒空"的实现也能让断言① 绿；
     * 本用例把两侧同时钉住，任一侧退化都会红。
     */
    it('admin 视角列表：绑定私有 board / 绑定已软删 board 的项目都照常可见（canReadContent=true）；无绑定权限的 agent 均不可见', async () => {
      if (!dbAvailable) return;

      // ── 种子①：私有 board（creator = A，visibility=private）─────────────────
      // 按 board.policy 的 read 规则，只有 OPEN / creator / board_members 行三者之一可读。
      // B 三者皆无（且 B 的 owner 与 A 的 owner 不是同一个人 ⇒ owner 代理不兜底）。
      // ⚠️ 必须是**专用** board：绝不能复用共享夹具 fx.board——那个是 OPEN 的，B 读得到，
      //    拿它当"私有绑定"会让本用例退化成恒绿的空壳。
      const privateBoard = await ds.getRepository(Board).save(
        ds.getRepository(Board).create({
          name: `memory private board ${RUN}`,
          creatorId: agentAId,
          settings: { visibility: 'private' },
          taskCount: 0,
          completedTaskCount: 0,
        }),
      );
      created.boardIds.push(privateBoard.id);

      const privateSlug = `admin-vis-private-${RUN}`;
      const privateProjectId = await createProject({
        slug: privateSlug,
        bindings: [{ type: 'board', id: privateBoard.id }],
      });

      // ── 种子②：绑定一个**后来被软删**的 board（本用例真正锁 `isAdmin` 的那一条）──────
      // 顺序要紧：创建时绑定必须可解析（`assertBindingsResolvable` 要求每个绑定都可读），
      // 故**先建项目、再软删绑定资源**（镜像既有 ⑭ 软删用例的手势）。
      const doomedBoard = await ds.getRepository(Board).save(
        ds.getRepository(Board).create({
          name: `memory doomed board ${RUN}`,
          creatorId: agentAId,
          settings: { visibility: 'open' },
          taskCount: 0,
          completedTaskCount: 0,
        }),
      );
      created.boardIds.push(doomedBoard.id);
      const doomedSlug = `admin-vis-doomed-${RUN}`;
      const doomedProjectId = await createProject({
        slug: doomedSlug,
        bindings: [{ type: 'board', id: doomedBoard.id }],
      });
      await ds.query(`UPDATE boards SET deleted_at = now() WHERE id = $1`, [doomedBoard.id]);

      // ── 种子③（对照）：绑定共享的 OPEN 话题（A 与 B 都可读）───────────────────
      // 用来证明"B 的列表本身在工作"——否则断言② 的"空"可能只是列表恒空的假绿
      const openSlug = `admin-vis-open-${RUN}`;
      const openProjectId = await createProject({ slug: openSlug });

      const adminToken = await resolveAdminToken();
      /** admin 按 slug 精确取一条（`findAll` 的 slug 过滤 ⇒ 结果确定、不依赖列表顺序） */
      type AdminListBody = Envelope<{
        items: Array<{ id: string; canReadContent: boolean }>;
        total: number;
      }>;
      const adminListBySlug = async (slug: string): Promise<AdminListBody> => {
        const res = await jwtReq(app, adminToken).get(`/memory/projects?slug=${slug}`);
        expect(res.status).toBe(200);
        return res.body as AdminListBody;
      };

      // ①-1 卡片原始场景：admin 看得见"绑定私有资源"的项目，且内容读权限为 true
      const adminPrivate = await adminListBySlug(privateSlug);
      expect(adminPrivate.data.items).toHaveLength(1);
      expect(adminPrivate.data.items[0].id).toBe(privateProjectId);
      expect(adminPrivate.data.items[0].canReadContent).toBe(true);

      // ①-2 **真正锁 `isAdmin` 的那一条**：绑定资源已软删 ⇒ 对任何人都解析不出 readable
      //      （连 Policy 都不查，admin bypass 无处发力）⇒ 只有 `resolveProjectAccess` 的
      //      `isAdmin` 能救它。**把那处短路摘掉，这里必须红**（已用变异探针实测过）。
      const adminDoomed = await adminListBySlug(doomedSlug);
      expect(adminDoomed.data.items).toHaveLength(1);
      expect(adminDoomed.data.items[0].id).toBe(doomedProjectId);
      expect(adminDoomed.data.items[0].canReadContent).toBe(true);

      // ①-3 对照项目也在（"项目都在"）：admin 不是只对某类绑定开恩的例外通道
      const adminOpen = await adminListBySlug(openSlug);
      expect(adminOpen.data.items.map((item) => item.id)).toEqual([openProjectId]);
      expect(adminOpen.data.items[0].canReadContent).toBe(true);

      // ② 负面对照：B 对私有 board 既非 creator 也无 member 行；对软删 board 更是解析不出可读位；
      //    两个项目也都不是 B 创建的 ⇒ 非治理观察者 ⇒ `readable || isGovernanceViewer` 两位
      //    全 false ⇒ 整条不进 B 的列表。**这一侧是断言① 的"有牙齿"证明**：列表恒空的实现
      //    会在这里绿、但在 ① 红（反之亦然），故两侧必须同时钉。
      for (const slug of [privateSlug, doomedSlug]) {
        const res = await req(app, agentBKey).get(`/memory/projects?slug=${slug}`);
        expect(res.status).toBe(200);
        const body = res.body as Envelope<{ items: unknown[]; total: number }>;
        expect({ slug, items: body.data.items, total: body.data.total }).toEqual({
          slug,
          items: [],
          total: 0,
        });
      }

      // ②-2 证明上面那两条"空"是**过滤**的结果，而不是"B 的列表恒空"——OPEN 话题的项目 B 读得到
      const bOpen = await req(app, agentBKey).get(`/memory/projects?slug=${openSlug}`);
      expect(bOpen.status).toBe(200);
      expect(
        (bOpen.body as Envelope<{ items: Array<{ id: string }> }>).data.items.map(
          (item) => item.id,
        ),
      ).toEqual([openProjectId]);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑮ 引擎投影读面（hument 五读面：alpha.5 四读面 + alpha.6 关系建议）——真 PG + 真 HTTP
  // ══════════════════════════════════════════════════════════════════

  describe('⑮ 投影读面（/views/* 五读面）', () => {
    /** 造一篇**专用**来源文档（绝不软删共享夹具 fx.doc——那会连累其它用例） */
    async function createSourceDoc(token: string): Promise<string> {
      const doc = await ds.getRepository(Doc).save(
        ds.getRepository(Doc).create({
          spaceId: fx.space,
          path: `docs/views-${RUN}-${token}.md`,
          title: `读面来源文档 ${token}`,
          createdBy: agentAId,
          contentHash: 'viewshash000000000000000000000000000000001',
          source: 'native',
          tags: [],
          sectionCount: 1,
          tokenEstimate: 10,
        }),
      );
      created.docIds.push(doc.id);
      return doc.id;
    }

    it('graph 200：信封字段级断言（引擎块逐字 + 平台计数 + ledgerMapping + 信任框）', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const first = await nominate(projectId, claim(`views-a-${RUN}`));
      const second = await nominate(projectId, claim(`views-b-${RUN}`));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstLedger = (first.body as Envelope<{ ledgerId: string; engineMemoryIds: string[] }>)
        .data;
      const secondLedger = (
        second.body as Envelope<{ ledgerId: string; engineMemoryIds: string[] }>
      ).data;

      const res = await req(app, agentAKey).get(`/memory/projects/${projectId}/views/graph`);
      expect(res.status).toBe(200);
      const body = res.body as Envelope<Record<string, unknown>>;
      const data = body.data;

      // ── 平台外层字段（引擎块**之外**的四计数 + 映射 + 信任框） ──
      expect(data.filteredByPermission).toBe(false);
      expect(data.filteredNodeCount).toBe(0);
      expect(data.filteredEdgeCount).toBe(0);
      expect(data.unmappedCount).toBe(0);
      expect(data.engineDataSuspect).toBe(false);
      expect(data.trustLevel).toBe('untrusted_advisory');
      expect(data.decisionAuthority).toBe('none');
      expect(typeof data.usageNote).toBe('string');
      // ledgerMapping 只含可见节点（前端据此钻取详情页）
      const ledgerMapping = data.ledgerMapping as Record<string, string>;
      expect(Object.keys(ledgerMapping).sort()).toEqual(
        [firstLedger.engineMemoryIds[0], secondLedger.engineMemoryIds[0]].sort(),
      );
      expect(ledgerMapping[firstLedger.engineMemoryIds[0]]).toBe(firstLedger.ledgerId);

      // ── 引擎块：字段名与形状**逐字**（snake_case，平台不归一化） ──
      const engine = data.engine as Record<string, unknown>;
      expect(Object.keys(engine).sort()).toEqual(
        [
          'auth_kind',
          'authority',
          'budget',
          'center_memory_id',
          'edge_page',
          'edges',
          'filters',
          'mode',
          'node_page',
          'nodes',
          'omitted_edge_count',
          'redaction',
          'request_id',
          'schema_version',
          'snapshot_digest',
          'target',
        ].sort(),
      );
      expect(engine.schema_version).toBe('memory-view-memory-graph-v1');
      expect(engine.authority).toBe('inspect_read');
      expect(engine.redaction).toBe('memory-projection-safe-v1');
      // 平台不设默认值 ⇒ 引擎默认档生效并在 budget 里回声
      expect(engine.budget).toEqual({
        node_limit: 200,
        edge_limit: 600,
        neighborhood_limit: 100,
        preview_scalars: 160,
        depth: 1,
      });
      // 响应 filters 回声比请求域多 `any`
      expect((engine.filters as Record<string, unknown>).kind).toBe('any');
      expect((engine.node_page as Record<string, unknown>).total_kind).toBe('exact');
      expect((engine.target as Record<string, unknown>).scope).toBe('actor_private');

      const nodes = engine.nodes as Array<Record<string, unknown>>;
      expect(nodes).toHaveLength(2);
      expect(Object.keys(nodes[0]).sort()).toEqual(
        [
          'active_resolution',
          'anchor_state',
          'available_resolution',
          'boundary',
          'confidence_present',
          'contradiction_count',
          'created_at',
          'kind',
          'label',
          'label_resolution',
          'memory_id',
          'preview',
          'scope',
          'status',
          'supersession_count',
          'updated_at',
        ].sort(),
      );
      // scope 与平台恒传一致（**不是** workspace_shared）
      expect(nodes[0].scope).toBe('actor_private');
      // 边：≥1 条非 supersedes（合成规则）+ audit_locator 四键齐
      const edges = engine.edges as Array<Record<string, unknown>>;
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(edges[0].audit_locator as object).sort()).toEqual(
        ['journal_event_id', 'mutation_id', 'revision_id', 'status'].sort(),
      );

      // ── 单记忆 detail：五槽 ladder + provenance 7 键 ──
      const detail = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${firstLedger.engineMemoryIds[0]}`,
      );
      expect(detail.status).toBe(200);
      const detailEngine = (detail.body as Envelope<{ engine: Record<string, unknown> }>).data
        .engine;
      const memory = detailEngine.memory as Record<string, unknown>;
      for (const key of [
        'source_type',
        'source_ref',
        'source_revision',
        'provider',
        'provider_version',
        'receipt_digest',
        'policy_version',
      ]) {
        expect((memory.provenance as Record<string, unknown>)[key]).toBeDefined();
      }
      const sections = detailEngine.sections as Record<string, Record<string, unknown>>;
      const ladder = sections.representations.ladder as Array<Record<string, unknown>>;
      expect(ladder).toHaveLength(5);
      expect(ladder.map((slot) => slot.resolution)).toEqual(['R0', 'R1', 'R2', 'R3', 'R4']);
      expect(ladder.filter((slot) => slot.active)).toHaveLength(1);

      // ── 历史版本：R2 有旧版本（current 恒 false）；R0 是**合法空页** ──
      const history = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${firstLedger.engineMemoryIds[0]}/history/R2`,
      );
      expect(history.status).toBe(200);
      const historyItems = (
        history.body as Envelope<{ engine: { items: Array<Record<string, unknown>> } }>
      ).data.engine.items;
      expect(historyItems).toHaveLength(1);
      expect(historyItems[0].current).toBe(false);

      const emptyHistory = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${firstLedger.engineMemoryIds[0]}/history/R0`,
      );
      expect(emptyHistory.status).toBe(200);
      expect(
        (emptyHistory.body as Envelope<{ engine: { items: unknown[] } }>).data.engine.items,
      ).toEqual([]);

      // ── 表示正文：当前正文 = 账本冻结正文；未知 id ⇒ 404 ──
      const currentBody = ladder[2].current as Record<string, unknown>;
      const repr = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${firstLedger.engineMemoryIds[0]}` +
          `/representations/${currentBody.representation_id}`,
      );
      expect(repr.status).toBe(200);
      expect(
        (repr.body as Envelope<{ engine: { representation: { body: string } } }>).data.engine
          .representation.body,
      ).toContain(`主张 views-a-${RUN}`);

      // ⚠️ 引擎侧的 404（"不认识这个 representation_id"）在平台侧落 **502/14004 + engineCode**
      // 而**不是** 404：平台的 404 只表示"本项目没这条记忆 / 来源不可见"（不确认存在性），
      // 而"引擎答了错误体"是另一件事——替引擎断言 404 = 把它的答案翻译成平台的语义。
      // 与既有 19.16 `getMemory` 同款（plan §2.3 的错误映射表）。
      const unknownRepr = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${firstLedger.engineMemoryIds[0]}` +
          '/representations/repr_does_not_exist',
      );
      expect(unknownRepr.status).toBe(502);
      const unknownBody = unknownRepr.body as { code: string; data: { engineCode?: string } };
      expect(unknownBody.code).toBe(ErrorCode.MEMORY_ENGINE_ERROR);
      expect(unknownBody.data.engineCode).toBe('resource_not_found');
    });

    it('graph 过滤语义（**非 admin** actor）：来源软删 ⇒ 节点丢弃 + 边级联 + ledgerMapping 只留可见', async () => {
      if (!dbAvailable) return;

      // 专用 doc：本用例会把它软删，绝不碰共享夹具 fx.doc
      const docId = await createSourceDoc('filter-graph');
      const projectId = await createProject();
      const hidden = await nominate(
        projectId,
        claim(`views-hidden-${RUN}`, { sourceRefs: [{ type: 'doc', id: docId, position: 0 }] }),
      );
      const visible = await nominate(projectId, claim(`views-visible-${RUN}`));
      expect(hidden.status).toBe(201);
      expect(visible.status).toBe(201);
      const hiddenMemory = (hidden.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];

      // 来源软删：doc 的父链断裂 ⇒ 该节点对**任何人**都不可见（含 admin；"存在且未软删"是硬前提）
      await ds.query(`UPDATE docs SET deleted_at = now() WHERE id = $1`, [docId]);

      const res = await req(app, agentAKey).get(`/memory/projects/${projectId}/views/graph`);
      expect(res.status).toBe(200);
      const data = (res.body as Envelope<Record<string, unknown>>).data;

      expect(data.filteredByPermission).toBe(true);
      expect(data.filteredNodeCount).toBe(1);
      // 边级联：合成边"两个节点互连"⇒ 一端被砍，边一并丢弃（必须有出口，否则图静默失真）
      expect(data.filteredEdgeCount).toBeGreaterThanOrEqual(1);
      const engine = data.engine as { nodes: Array<{ memory_id: string }> };
      expect(engine.nodes).toHaveLength(1);
      expect(engine.nodes[0].memory_id).not.toBe(hiddenMemory);
      // ledgerMapping **只含可见节点**
      const ledgerMapping = data.ledgerMapping as Record<string, string>;
      expect(Object.keys(ledgerMapping)).not.toContain(hiddenMemory);
      expect(Object.keys(ledgerMapping)).toHaveLength(1);
      // ⚠️ 引擎口径的 loaded 仍是引擎加载数（≠ 过滤后的 nodes.length）——前端不得拿它当分母
      expect((data.engine as { node_page: { loaded: number } }).node_page.loaded).toBe(2);

      // 单记忆 detail/history/representation 三端点：来源不可见 ⇒ 404（同码同语义，不确认存在性）
      for (const path of [
        `/memory/projects/${projectId}/views/memories/${hiddenMemory}`,
        `/memory/projects/${projectId}/views/memories/${hiddenMemory}/history/R2`,
        `/memory/projects/${projectId}/views/memories/${hiddenMemory}/representations/repr_x`,
      ]) {
        const denied = await req(app, agentAKey).get(path);
        expect(denied.status).toBe(404);
        expect((denied.body as { code: string }).code).toBe(ErrorCode.MEMORY_NOMINATION_NOT_FOUND);
      }
    });

    it('404 不泄露存在性：本项目无映射的 memory id / 未配引擎的项目', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject();
      const missing = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/mem_never_existed`,
      );
      expect(missing.status).toBe(404);
      expect((missing.body as { code: string }).code).toBe(ErrorCode.MEMORY_NOMINATION_NOT_FOUND);
    });

    it('503/14000：未配引擎的 app ⇒ 读面族统一引擎闸', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject(
        { slug: `views-noengine-${RUN}` },
        appWithoutEngine,
        agentAKey,
      );

      const graph = await req(appWithoutEngine, agentAKey).get(
        `/memory/projects/${projectId}/views/graph`,
      );
      expect(graph.status).toBe(503);
      expect((graph.body as { code: string; data: { reason: string } }).code).toBe(
        ErrorCode.MEMORY_UNAVAILABLE,
      );
      // 三个单记忆端点也要过闸（先 404 后 503：无映射时是 404，这里给一条**已映射**的）
      const history = await req(appWithoutEngine, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/mem_never_existed/history/R2`,
      );
      expect(history.status).toBe(404);
    });

    it('403/1009：治理观察者（creator）绑定全不可读 ⇒ 内容面关闭', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject({ slug: `views-gov-${RUN}` });
      // 清空绑定 ⇒ 非 admin 调用者 readable=false，但 creator 仍是治理观察者（详情仍 200）
      const cleared = await req(app, agentAKey)
        .patch(`/memory/projects/${projectId}`)
        .send({ bindings: [] });
      expect(cleared.status).toBe(200);

      const graph = await req(app, agentAKey).get(`/memory/projects/${projectId}/views/graph`);
      expect(graph.status).toBe(403);
      expect((graph.body as { code: string }).code).toBe(ErrorCode.PERMISSION_DENIED);
    });

    it('**cursor 双通道**：snapshot_stale ⇒ 502/14004 + engineCode 逐字；改过滤器 ⇒ invalid_argument', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject({ slug: `views-cursor-${RUN}` });
      await nominate(projectId, claim(`views-c1-${RUN}`));
      await nominate(projectId, claim(`views-c2-${RUN}`));

      // 取第一页（nodeLimit=1 ⇒ 必然被截断，带出 next_cursor）
      const page1 = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/graph?nodeLimit=1`,
      );
      expect(page1.status).toBe(200);
      const page1Engine = (
        page1.body as Envelope<{ engine: { node_page: { next_cursor: string } } }>
      ).data.engine;
      const cursor = page1Engine.node_page.next_cursor;
      expect(cursor).not.toBe('');

      // ① 携 cursor **改过滤器** ⇒ 引擎 400 invalid_argument ⇒ 502/14004 + engineCode 逐字
      const changed = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/graph?nodeLimit=1&kind=concept&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(changed.status).toBe(502);
      const changedBody = changed.body as { code: string; data: { engineCode: string } };
      expect(changedBody.code).toBe(ErrorCode.MEMORY_ENGINE_ERROR);
      expect(changedBody.data.engineCode).toBe('invalid_argument');

      // ② 过滤器不变、**快照变了**（又形成一条记忆 ⇒ workspace 指纹变化）⇒ 409 snapshot_stale
      await nominate(projectId, claim(`views-c3-${RUN}`));
      const stale = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/graph?nodeLimit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(stale.status).toBe(502);
      const staleBody = stale.body as { code: string; data: { engineCode: string } };
      expect(staleBody.code).toBe(ErrorCode.MEMORY_ENGINE_ERROR);
      expect(staleBody.data.engineCode).toBe('snapshot_stale');
    });

    it('node_limit=200 档：`evaluateSourceRefs` **只调一次**（批式过滤的成本护栏）', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject({ slug: `views-batch-${RUN}` });
      await nominate(projectId, claim(`views-b1-${RUN}`));
      await nominate(projectId, claim(`views-b2-${RUN}`));
      await nominate(projectId, claim(`views-b3-${RUN}`));

      // 真 app 的 DI 容器里就是被测服务：spy 它的批式入口（照 memory-access.service.spec 的钉法）
      const accessService = app.get(MemoryAccessService);
      const spy = jest.spyOn(accessService, 'evaluateSourceRefs');

      const res = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/graph?nodeLimit=200`,
      );
      expect(res.status).toBe(200);
      const nodes = (res.body as Envelope<{ engine: { nodes: unknown[] } }>).data.engine.nodes;
      expect(nodes).toHaveLength(3);
      // ⚠️ 3 个节点仍只调一次（逐节点调用会在生产 200 档放大成 200 次 8 表预载）
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });

    it('DTO 护栏：node_limit>200 / 未知 query 属性（scope）/ 非法 resolution 全部 400', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject({ slug: `views-400-${RUN}` });

      // 平台护栏 200（引擎合同允许 1000；平台按过滤成本收更严的一档）
      const overLimit = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/graph?nodeLimit=201`,
      );
      expect(overLimit.status).toBe(400);

      // `scope` 不在 DTO ⇒ forbidNonWhitelisted 拒（**这是设计意图**：作用域不由调用方选）
      const withScope = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/graph?scope=actor_private`,
      );
      expect(withScope.status).toBe(400);

      // createdFrom > createdTo：边界层先拦（引擎也会 400，但停在边界更省一次往返）
      const badRange = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/graph?createdFrom=2026-02-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z`,
      );
      expect(badRange.status).toBe(400);

      // 非法 resolution（路径参数走 MemoryViewHistoryParamsDto 的值域闸门）
      const badResolution = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/mem-1/history/R9`,
      );
      expect(badResolution.status).toBe(400);

      // 路径参数的**长度**闸门（合同 ≤128）：三个单记忆端点都走 params DTO，
      // 故超长 id 在**边界层**就被挡下（不进服务层、更不打引擎）。
      // ⚠️ 这条同时是"params DTO 而不是裸 `@Param` 装饰器"的端到端证据——裸串参数上的
      //    装饰器在全局 ValidationPipe 下不生效（单测里另有对照用例）。
      const tooLong = 'm'.repeat(129);
      const longEngineId = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${tooLong}`,
      );
      expect(longEngineId.status).toBe(400);

      const longRepresentationId = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/mem-1/representations/${tooLong}`,
      );
      expect(longRepresentationId.status).toBe(400);

      // 本批新增的 relations 端点同样走 params DTO（组合与 detail 相同但**各写一份**）
      const longRelationsId = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${tooLong}/relations`,
      );
      expect(longRelationsId.status).toBe(400);
    });

    it('relations 200：引擎块逐字 + **双向块** + 三个过滤计数 + 信任框；**空 advisories 也是合法 200**', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject({ slug: `views-rel-${RUN}` });
      const first = await nominate(projectId, claim(`views-rel-a-${RUN}`));
      const second = await nominate(projectId, claim(`views-rel-b-${RUN}`));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstMemory = (first.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];
      const secondMemory = (second.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];

      const res = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${firstMemory}/relations`,
      );
      expect(res.status).toBe(200);
      const data = (res.body as Envelope<Record<string, unknown>>).data;

      // ── 平台外层（引擎块**之外**的三个计数 + 信任框） ──
      expect(data.filteredByPermission).toBe(false);
      expect(data.filteredCaseCount).toBe(0);
      expect(data.unmappedCaseCount).toBe(0);
      expect(data.droppedAdvisoryCount).toBe(0);
      expect(data.trustLevel).toBe('untrusted_advisory');
      expect(data.decisionAuthority).toBe('none');
      expect(typeof data.usageNote).toBe('string');

      // ── 引擎块：字段名与形状**逐字**（snake_case，平台不归一化） ──
      const engine = data.engine as Record<string, unknown>;
      expect(Object.keys(engine).sort()).toEqual(
        ['advisories', 'memory_id', 'schema_version', 'truncated'].sort(),
      );
      expect(engine.schema_version).toBe('hument-memory-relations-v1');
      expect(engine.memory_id).toBe(firstMemory);
      expect(engine.truncated).toBe(false);

      // ⚠️ **两块**：new-side（另一条在 `old`）+ old-side（另一条在 `new`）——只产一块的话，
      //    "平台按另一侧过滤"在 e2e 里就证不了（旧实现恒取 `old` 也能全绿）。
      const advisories = engine.advisories as Array<Record<string, unknown>>;
      expect(advisories).toHaveLength(2);
      for (const advisory of advisories) {
        expect(Object.keys(advisory).sort()).toEqual(
          [
            'advisory_only',
            'cases',
            'coverage',
            'created_at',
            'job_id',
            'matched_memory_id',
            'model',
            'new_memory_id',
            'source_state',
            'state',
            'usage',
          ].sort(),
        );
        // 信任语义是**契约级 const**（不是装饰性文案）
        expect(advisory.source_state).toBe('author_reported');
        expect(advisory.advisory_only).toBe(true);
        expect(advisory.state).toBe('complete');
        // 块级归因：两块都必须 matched === 本请求（否则会被守卫整块丢掉）
        expect(advisory.matched_memory_id).toBe(firstMemory);
        expect(Object.keys(advisory.coverage as object).sort()).toEqual(
          [
            'budget_incomplete',
            'candidate_count',
            'new_memory_id',
            'orient_truncated',
            'status',
          ].sort(),
        );
        expect(Object.keys(advisory.usage as object).sort()).toEqual(
          ['cost_micros', 'input_tokens', 'output_tokens'].sort(),
        );
      }

      // ── ① new-side：本记忆是 new 侧 ⇒ 另一条在 `old_memory_id` ──
      const newSideCases = advisories[0].cases as Array<Record<string, unknown>>;
      expect(advisories[0].new_memory_id).toBe(firstMemory);
      expect(newSideCases).toHaveLength(1);
      expect(newSideCases[0].new_memory_id).toBe(firstMemory);
      expect(newSideCases[0].old_memory_id).toBe(secondMemory);
      expect(newSideCases[0].source_state).toBe('author_reported');
      expect(newSideCases[0].advisory_only).toBe(true);
      expect(typeof newSideCases[0].case_id).toBe('string');
      expect(typeof newSideCases[0].decision).toBe('string');
      expect(typeof newSideCases[0].reason).toBe('string');
      expect(['duplicate', 'supplement', 'conflict', 'uncertain']).toContain(newSideCases[0].label);
      expect(typeof newSideCases[0].confidence).toBe('number');
      // `coverage.candidate_count` 是**引擎口径**（不是过滤后的 cases.length 的分母）
      expect((advisories[0].coverage as Record<string, unknown>).candidate_count).toBe(1);

      // ── ② old-side：本记忆是**被比较的旧侧** ⇒ 另一条在 `new_memory_id`（块级 matched 仍是本记忆）──
      const oldSideCases = advisories[1].cases as Array<Record<string, unknown>>;
      expect(advisories[1].new_memory_id).toBe(secondMemory);
      expect(oldSideCases).toHaveLength(1);
      expect(oldSideCases[0].new_memory_id).toBe(secondMemory);
      expect(oldSideCases[0].old_memory_id).toBe(firstMemory);

      // ── 单记忆 relations：**空 advisories 是合法 200**（≠"这条记忆没有关系"） ──
      const lonelyProject = await createProject({ slug: `views-rel-lonely-${RUN}` });
      const lonely = await nominate(lonelyProject, claim(`views-rel-lonely-${RUN}`));
      expect(lonely.status).toBe(201);
      const lonelyMemory = (lonely.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];
      const lonelyRes = await req(app, agentAKey).get(
        `/memory/projects/${lonelyProject}/views/memories/${lonelyMemory}/relations`,
      );
      expect(lonelyRes.status).toBe(200);
      expect(
        (lonelyRes.body as Envelope<{ engine: { advisories: unknown[] } }>).data.engine.advisories,
      ).toEqual([]);
    });

    it('relations 逐 case 来源过滤（**非 admin** actor）：另一条记忆的来源消失 ⇒ 丢 case + 计数，而它自己的 relations 是 404', async () => {
      if (!dbAvailable) return;

      // 专用 doc：本用例会把它软删，绝不碰共享夹具 fx.doc
      const docId = await createSourceDoc('filter-relations');
      const projectId = await createProject({ slug: `views-rel-filter-${RUN}` });
      const plain = await nominate(projectId, claim(`views-rel-plain-${RUN}`));
      const sourced = await nominate(
        projectId,
        claim(`views-rel-sourced-${RUN}`, {
          sourceRefs: [{ type: 'doc', id: docId, position: 0 }],
        }),
      );
      expect(plain.status).toBe(201);
      expect(sourced.status).toBe(201);
      const plainMemory = (plain.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];
      const sourcedMemory = (sourced.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];

      // 来源软删：doc 的父链断裂 ⇒ 那条记忆对**任何人**都不可见（含 admin）
      await ds.query(`UPDATE docs SET deleted_at = now() WHERE id = $1`, [docId]);

      const res = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${plainMemory}/relations`,
      );
      expect(res.status).toBe(200);
      const data = (res.body as Envelope<Record<string, unknown>>).data;

      // 两条 case 各指向那条不可见的记忆（new-side 块的 `old` 侧 + old-side 块的 `new` 侧）
      // ⇒ 都丢弃 + 出口计数（**两块本身都保留**：它们的 matched 都是调用方**已过 404 闸门**的
      // 这条记忆，故块级守不会丢它们）
      expect(data.filteredByPermission).toBe(true);
      expect(data.filteredCaseCount).toBe(2);
      expect(data.unmappedCaseCount).toBe(0);
      expect(data.droppedAdvisoryCount).toBe(0);
      const advisories = (data.engine as { advisories: Array<Record<string, unknown>> }).advisories;
      expect(advisories).toHaveLength(2);
      expect(advisories[0].cases).toEqual([]);
      expect(advisories[1].cases).toEqual([]);
      // 引擎口径的候选数**不减**（前端不得拿它当过滤后 cases 的分母）
      expect((advisories[0].coverage as Record<string, unknown>).candidate_count).toBe(1);

      // 那条记忆**自己的** relations：来源不可见 ⇒ 404/14003（同码同语义，不确认存在性）
      const denied = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${sourcedMemory}/relations`,
      );
      expect(denied.status).toBe(404);
      expect((denied.body as { code: string }).code).toBe(ErrorCode.MEMORY_NOMINATION_NOT_FOUND);

      // 无映射的 memory id ⇒ 同样的 404（不泄露"引擎里有没有这条"）
      const missing = await req(app, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/mem_never_existed/relations`,
      );
      expect(missing.status).toBe(404);
      expect((missing.body as { code: string }).code).toBe(ErrorCode.MEMORY_NOMINATION_NOT_FOUND);
    });

    it('relations 的 query DTO 是**空的**：任何 query（含 scope）一律 400', async () => {
      if (!dbAvailable) return;

      const projectId = await createProject({ slug: `views-rel-400-${RUN}` });

      // ⚠️ 没有 `@Query()` 类元类型的话，这一条会**静默 200**（作用域从 fail-closed
      //    降级成"看起来可选其实无效"）——本用例是那类回归的守卫。
      for (const query of ['scope=actor_private', 'relationLimit=5', 'cursor=abc']) {
        const res = await req(app, agentAKey).get(
          `/memory/projects/${projectId}/views/memories/mem-1/relations?${query}`,
        );
        expect(res.status).toBe(400);
      }
    });

    it('relations 503/14000 + 403/1009：引擎闸与内容闸与其余四读面同档', async () => {
      if (!dbAvailable) return;

      // 未配引擎的 app：先造一条**已映射**的记忆（在主 app 上提名 ⇒ 账本行落 engineMemoryIds），
      // 再用**无引擎**的 app 打 relations ⇒ 过闸门后落 503/14000（引擎动词不可用）。
      // ⚠️ 两个 app 共用同一个 PG 与同一份 auth ⇒ 项目与映射对 appWithoutEngine 同样可见，
      //    唯一差别就是注入的 `MEMORY_ENGINE` token（null）。
      const projectId = await createProject({ slug: `views-rel-noengine-${RUN}` });
      const nominated = await nominate(projectId, claim(`views-rel-noengine-${RUN}`));
      expect(nominated.status).toBe(201);
      const mapped = (nominated.body as Envelope<{ engineMemoryIds: string[] }>).data
        .engineMemoryIds[0];

      const unavailable = await req(appWithoutEngine, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/${mapped}/relations`,
      );
      expect(unavailable.status).toBe(503);
      expect((unavailable.body as { code: string; data: { reason: string } }).code).toBe(
        ErrorCode.MEMORY_UNAVAILABLE,
      );
      // 未映射的 id 在**引擎闸之前**就落 404（引擎没配也不会回答"这条记忆在不在"）
      const beforeGate = await req(appWithoutEngine, agentAKey).get(
        `/memory/projects/${projectId}/views/memories/mem_never_existed/relations`,
      );
      expect(beforeGate.status).toBe(404);

      // 治理观察者（creator）绑定全不可读 ⇒ 403/1009（内容面关闭）
      const govProject = await createProject({ slug: `views-rel-gov-${RUN}` });
      const cleared = await req(app, agentAKey)
        .patch(`/memory/projects/${govProject}`)
        .send({ bindings: [] });
      expect(cleared.status).toBe(200);
      const gov = await req(app, agentAKey).get(
        `/memory/projects/${govProject}/views/memories/mem_any/relations`,
      );
      expect(gov.status).toBe(403);
      expect((gov.body as { code: string }).code).toBe(ErrorCode.PERMISSION_DENIED);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑯ 引擎运行时告警（卡 26c43f52 / 5e6cb000）：连续失败 → notify 端口 / 恢复 / 未配引擎零告警
  // ══════════════════════════════════════════════════════════════════

  /**
   * 告警通道的端到端契约（**端口层**：tracker → `NotifyOrchestrator.sendSystemAlert()`）。
   *
   * 为什么用 spy 替身：告警出境是 `NOTIFY_ENABLED` 治理下的外部投递（真实现要 admin 账号 +
   * 渠道 + provider 装配），与本模块无关；本套件证的是"状态机在正确时机、按正确的臂/种类/
   * 闭集文案把告警交给了端口"。出境链路由 `notify-orchestrator.service.spec.ts` 与
   * `notifications.e2e-spec.ts` 覆盖（分工见 plan D7）。
   *
   * 为什么必须轮询：派发是 **fire-and-forget**（`raiseAlert` 置位后不等投递），同步直读 spy
   * 会读到"派发还没发生"（假红）。范式同 `notifications-pipeline.e2e-spec.ts` 的 `waitFor`。
   *
   * 覆盖三条产品断言：
   * ① 业务调用连续 5×503 ⇒ `arm=availability` 告警**真的交给端口**（且文案闭集）；
   * ② 随后一次成功调用 ⇒ 恢复通知（探针在本套件关着 ⇒ `callOk` 是 A 臂的恢复判据）；
   * ③ 未配引擎的 app 打 6 次 ⇒ **零告警**（"未配置 ≠ 故障"的结构保证）。
   */
  describe('⑯ 引擎运行时告警（双臂状态机 → notify system_alert 端口）', () => {
    /** 告警入参形状（只声明断言用到的字段） */
    type AlertCall = {
      source: string;
      kind: string;
      arm: string;
      title: string;
      body: string;
      occurredAt: string;
      consecutive?: number;
      workspaceId?: string;
    };

    // ⚠️ **隔离**（卡 2 评审 m1）：tracker 是 app-scoped 单例，同一 app 的多个 `it` 共享
    // 计数与告警位——不复位会形成执行顺序依赖；spy 的调用记录同样要清（否则负向断言会读到
    // 上一例的派发）。
    beforeEach(() => {
      notifyStub.sendSystemAlert.mockClear();
      notifyStub.sendSystemAlert.mockResolvedValue('delivered');
      if (!dbAvailable) return;
      app.get(EngineHealthTracker).resetForTest();
    });

    /** 已交给端口的告警（按派发顺序） */
    function alertCalls(): AlertCall[] {
      return notifyStub.sendSystemAlert.mock.calls.map((call) => call[0] as AlertCall);
    }

    /** 有界轮询：等满足 `predicate` 的派发出现（**派发是异步的**，禁同步直读） */
    async function waitForAlert(
      predicate: (call: AlertCall) => boolean,
      timeoutMs = 30_000,
    ): Promise<AlertCall> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = alertCalls().find(predicate);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const seen = alertCalls().map((call) => `${call.kind}/${call.arm}`);
      throw new Error(`waitForAlert timeout (seen: ${seen.join(', ') || 'none'})`);
    }

    /** 一次召回（引擎动词；返回原始响应，供断言状态码） */
    function recallOnce(projectId: string, appUnderTest: INestApplication = app) {
      return req(appUnderTest, agentAKey)
        .post(`/memory/projects/${projectId}/recalls`)
        .send({ query: `告警口径 ${RUN}`, contextIdentity: `ctx-alert-${RUN}`, contextEpoch: 0 });
    }

    /** 一次引擎 503 失败面（形态对齐 hument：`http` + 503 + retryable） */
    function engine503(): MemoryEngineResult<never> {
      return {
        ok: false,
        failure: {
          kind: 'http',
          message: 'Hument returned HTTP 503',
          httpStatus: 503,
          retryable: true,
          latencyMs: 3,
        },
      };
    }

    it('连续 5 次引擎 503 ⇒ availability 告警交给端口（文案闭集）；随后成功 ⇒ 恢复通知', async () => {
      if (!dbAvailable) return;

      // 本块独占脚本引擎状态（前面的用例可能留下一次性钩子）
      scriptedEngine.reset();

      const projectId = await createProject({ slug: `alert-${RUN}` });
      const project = await ds.query(
        `SELECT engine_workspace_id FROM memory_projects WHERE id = $1`,
        [projectId],
      );
      const workspaceId = (project as { engine_workspace_id: string }[])[0].engine_workspace_id;

      // ── ① 连续 5 次 503：第 5 次触发 A 臂告警 ──
      for (let i = 0; i < 5; i += 1) scriptedEngine.recallQueue.push(engine503());
      for (let i = 0; i < 5; i += 1) {
        const res = await recallOnce(projectId);
        // 拿到错误体 ⇒ 平台 502（引擎可达但报错；不是 503「引擎不可用」）
        expect(res.status).toBe(502);
      }

      const alert = await waitForAlert((call) => call.kind === 'alert');
      // ⚠️ 隔离守卫（评审 m1）：本轮**恰好**一条告警。若 `beforeEach` 的 `resetForTest()`
      // 失效且前一例留下了活跃告警，`raiseAlert` 会短路 ⇒ 本轮的派发计数为 0 —— 这条断言
      // 把"spy 里恰好有一条"与"那条是不是本轮产生的"绑在一起。
      expect(alertCalls().filter((call) => call.kind === 'alert')).toHaveLength(1);
      const content = `${alert.title}\n${alert.body}`;
      // 端口契约：source 是闭集；kind/arm 决定 notify 侧的量控分桶
      expect(alert.source).toBe('memory-engine');
      expect(alert.arm).toBe('availability');
      expect(alert.title).toContain('[engine alert]');
      expect(content).toContain('连续失败 5 次');
      expect(content).toContain('kind=http httpStatus=503');
      expect(content).toContain(`workspaceId=${workspaceId}`);
      // **文案闭集**：端点 / 凭据引用 / 引擎错误码一律不得出现在告警正文里
      expect(content).not.toContain('127.0.0.1');
      expect(content).not.toContain('cred-ref');
      expect(content).not.toContain('engineCode=');
      // payload 的 workspaceId 与库里绑定值同源（生产方净化不改变 allowlist 值）
      expect(alert.workspaceId).toBe(workspaceId);

      // ── ② 恢复：探针关闭 ⇒ 一次成功调用即恢复 ──
      const ok = await recallOnce(projectId);
      expect(ok.status).toBe(200);

      const recovery = await waitForAlert((call) => call.kind === 'recovery');
      expect(recovery.arm).toBe('availability');
      expect(`${recovery.title}\n${recovery.body}`).toContain('一次成功的业务调用');
      expect(recovery.body).toContain('本通知为恢复确认，无需处置。');
    });

    it('未配引擎（appWithoutEngine）连打 6 次 ⇒ **零告警**（未配置 ≠ 故障）', async () => {
      if (!dbAvailable) return;

      // 用同一个项目（绑定仍在），换 app：该 app 的引擎 token 是 null
      const projectId = await createProject({ slug: `alert-noengine-${RUN}`, engine: 'none' });

      for (let i = 0; i < 6; i += 1) {
        const res = await recallOnce(projectId, appWithoutEngine);
        expect(res.status).toBe(503); // 引擎闸在**调用之前**：根本没有"引擎失败"可计
      }

      // 负向断言的 settle 窗口：派发是异步的，给足时间让"如果真发了"暴露出来
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // ⚠️ 负向断言用 spy 的**调用次数**（不是消息表）：真编排器若被误装，这里同样会红
      expect(notifyStub.sendSystemAlert).not.toHaveBeenCalled();
    });
  });
});

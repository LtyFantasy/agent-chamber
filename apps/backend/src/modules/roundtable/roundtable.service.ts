/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §6 (会话层规则: ③ 核心逻辑)
 *   - 补充: docs/roundtable-design.md §3 (契约① SeatEvent/单飞行) / §4 (双向对账/seat.inject
 *     r3 冻结消息体) / §5 (roundtable_seats: config/state 分列, last_event_seq/last_inject_seq)
 *     / §7 (seatLabel 身份模型与回声抑制) / §8 (ACP 无 system prompt → 规则头随 inject 装配)
 *     / §6 r5 (攒批管线语义: 座位维度 batchWindowMs 窗口, 0=直通, 到期封批入单飞行 FIFO)
 *     / §6 r6 (唤醒路由落地: mention @label token 精确 + @all / broadcast / system 不唤醒 /
 *     失败回执 / silent 文本兜底 / parked 语义与重启强制封批 / 规则头 v2)
 *     / §6 r7 (圆桌安全阀: 计数落 seat.state——roundsWithoutHuman/silentCount/valveTripCount；
 *     派生暂停无标志位；人类发言复位不附带唤醒；触发公告在跨过阈值那一 turn + per-topic
 *     节流；0=关闭)
 *     / §12 r13 (M3 阶段 3: 座位移除软删语义/权限、@all 冷却、seatCoordinator 透传)
 *     / §12 r17 (一 agent 一 topic 一 active 座位唯一约束: createSeat 业务检查 409 +
 *     部分唯一索引 uq_roundtable_seats_topic_bind_actor 兜底, removed 软删豁免可重建)
 *
 * [踩坑索引] RT-BATCH-1(封批即冻结) RT-BATCH-2(定时器随 offline 清理) RT-BATCH-3(replayGap 覆盖不到未派发消息) RT-ROUTE-1(system 不唤醒防礼貌循环) RT-ROUTE-2(唤醒不可达只 park 不开窗) RT-VALVE-1(触发公告在跨过阈值那 turn+节流) RT-VALVE-2(人类判定走 actor 表, senderType/actorType 是内存字段) RT-VALVE-3(暂停只闸新唤醒, FIFO 存量照发) RT-DEBT-1(游标蛙跳: 失败 seq 精确留档, dedup 放行) RT-DEBT-2(无界增长: chunk 缓冲上限 + 两侧对账裁剪) RT-DEBT-3(auto-join 公告幂等) RT-ANNOUNCE-1(公告正文 tool 摘要 title 优先) RT-SEAT-1(jsonb 嵌套 findOne 生成整列等值, 路径提取须 queryBuilder) RT-PERM-2(审批幂等键须带 status=pending, requestId 跨会话归零撞键) TOPIC-PERM(write放宽后座位/裁决须creator收口)
 *
 * [铁律关联] #9(代理层透传) #11(注释) #17(测试契约) #20(契约即设计) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   TOPIC-PERM: v1.46 TopicPolicy.write 放宽给 editor 参与方——roundtable 内两处
 *               ensureCan(topic,'write') 调用点（createSeat / resolvePermissionRequest）
 *               若不同步收口，editor 将获得建座位/裁决权限请求的能力（属成员管理/治理
 *               范畴）。修复：两处叠加 ensureTopicCreatorOrAdmin（admin|creator|ownerProxy）。
 *   RT-PERM-2: permission_request 幂等去重键 (seatId, requestId) 不含状态——requestId
 *               是 ACP 进程内 jsonrpc id，runner 重启/session resume 后从 0 重新计数，
 *               新请求与已 orphaned 的旧行撞键被当「重放」跳过落库 + 返回 true（事件被
 *               ack 不重放）→ 请求静默吞掉，agent 永久 park（M3 阶段 4 验收实测）。
 *               修复：findOne 加 status='pending'，已终结行（orphaned/approved/
 *               rejected）不挡新请求落库。
 *   RT-DEBT-1: message_complete 落库失败时若只「不推进游标」，后续任一非 complete
 *               事件会无条件推进游标越过失败 seq → runner 重连重放该 seq 被幂等去重
 *               丢弃 → 回复永久丢失（游标蛙跳）。修复：失败 seq 精确留档
 *               seat.state.failedEventSeqs（cap 50 随 state 持久化，重启不失），dedup
 *               改为 `seq <= lastEventSeq && !failedEventSeqs.includes(seq)` 才丢；
 *               正常终结分支清档 + 游标取 max 不回退。
 *   RT-DEBT-2: 无界增长两处：chamber chunkBuffers 无上限（失控 turn 撑爆内存）→
 *               加 MAX_CHUNK_BUFFER_CHARS 上限丢最旧 + 每座位 60s 节流 warn；runner
 *               pendingEvents 重放后无条件清空（未确认事件可能被丢）+ 长连接不裁剪 →
 *               新增 hello_ack 下行 + ping 可选 seats 游标，按 chamber 已确认区间裁剪
 *               （留档 seq 不裁，待重放）。
 *   RT-DEBT-3: 座位绑定 actor 非 topic 参与者时私密桌发言被 Forbidden → createSeat
 *               自动 join + 「座位 X 已入座」system 公告；公告幂等 = 已参与者不 join
 *               不公告；公告是 system → 「system 不唤醒」天然免疫递归。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual, Not, FindOptionsWhere } from 'typeorm';
import {
  EventType,
  ActorType,
  ErrorCode,
  MessageType,
  ParticipantStatus,
  PaginatedResponse,
  UserRole,
} from '@agent-chamber/shared';
import {
  RULE_HEADER_VERSION,
  SILENT_SENTINEL,
  assembleInjectBody,
  buildEnvelope,
  parseSilentReply,
  type Envelope,
  type HelloAckPayload,
  type HelloPayload,
  type InjectBody,
  type InjectBodyMessage,
  type InjectFromType,
  type InjectPayload,
  type PermissionVerdictPayload,
  type SeatEventPayload,
  type ToolBrief,
} from '@agent-chamber/roundtable-protocol';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtablePermissionRequest } from '../../database/entities/roundtable-permission-request.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Message } from '../../database/entities/message.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Event } from '../../database/entities/event.entity';
import { TopicService } from '../topic/topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { UnifiedActor } from '../../common/types/actor.types';
import { RunnerRegistryService } from './runner-registry.service';
import {
  CreateSeatDto,
  ListSeatsQueryDto,
  VerdictPermissionRequestDto,
  ListPermissionRequestsQueryDto,
} from './dto';
import { findMentionedLabels, hasAllMention, stripMentionNoise } from './mention';

/** recentInjects ring buffer 容量（M1 计划决策 9：cap 100，`[{seq, messageIds}]`） */
const RING_BUFFER_CAP = 100;

/** recentActivity ring buffer 容量（M4b-1：近况时间线环形，cap 10 淘汰最旧——失控 turn 防 state jsonb 膨胀） */
const RECENT_ACTIVITY_CAP = 10;

/**
 * recentActivity 工具标题摘要截断长度（M4b-1 R5 摘要化加固）：
 * title 截断 80 字符 + 剥座位 cwd 前缀——title 常是绝对路径/超长工具名，
 * 防敏感路径泄进 state（seat.state participant 全可读）。
 */
const RECENT_ACTIVITY_TITLE_CAP = 80;

/**
 * 攒批窗口缺省值（毫秒；设计 docs/roundtable-design.md §6：座位维度时间窗默认 30s，
 * 一处常量可调）。0 = 直通（M1 行为，dogfood 桌可关攒批对照）——阶段 2 消费。
 */
export const DEFAULT_BATCH_WINDOW_MS = 30000;

/** busy 排队超限回执阈值（决策 #6）：per-seat flight.queue.length > 20 落「排队积压」回执 */
const QUEUE_RECEIPT_THRESHOLD = 20;

/** 回执节流窗口：per-seat per-reason 5 分钟内不重复（内存表；重启清零可接受——回执是提示不是账本） */
const RECEIPT_THROTTLE_MS = 5 * 60 * 1000;

/**
 * 圆桌安全阀阈值缺省值（设计 §6，M2 阶段 4；topic.settings.maxRoundsWithoutHuman 可配）：
 * topic 内座位间连续 N 轮非沉默发言无人类消息即暂停注入——防 agent 间礼貌/抬杠循环
 * 烧穿账单（mention 与 broadcast 模式都生效）。缺省 8；显式 0 = 关闭（dogfood 对照）。
 * service 读取处防御性解析：非整数/超界（0~1000 之外）/缺省一律按本常量（DTO 已校验，
 * 此层兜底存量脏数据与越权直写 settings）。
 */
export const DEFAULT_MAX_ROUNDS_WITHOUT_HUMAN = 8;

/** 安全阀公告节流窗口：per-topic per-kind 5 分钟内不重复（与回执节流同窗口同精神——公告是提示不是账本，重启清零最多多一条） */
const VALVE_ANNOUNCE_THROTTLE_MS = RECEIPT_THROTTLE_MS;

/**
 * 审批公告节流窗口（M3 阶段 1）：per-seat（请求公告）/ per-topic（孤儿作废公告）
 * 5 分钟内不重复（与回执同窗口同精神——公告是提示不是账本，审批行本身已落库，
 * web 角标与列表才是权威展示；裁决公告不节流——同一请求只能裁决一次，天然无刷屏）
 */
const PERMISSION_ANNOUNCE_THROTTLE_MS = RECEIPT_THROTTLE_MS;

/**
 * @all 群体唤醒冷却窗口（M3 阶段 3，r13）：per-topic 60 秒——距上次 @all 群体唤醒
 * < 60s 的 @all 消息不再触发群体唤醒（消息正常落库、正常进攒批可见集，只是不唤醒）
 * + 冷却提示（节流，与冷却同周期）。一处常量可配。冷却状态存内存 Map（topicId →
 * 上次唤醒时间戳），重启清零可接受——断网恢复后最多少冷却一次，无安全问题。
 */
export const ALL_WAKE_COOLDOWN_MS = 60_000;

/**
 * 失败 seq 留档容量上限（M1 三新债 #1 游标蛙跳修复；RT-DEBT-1）：
 * seat.state.failedEventSeqs 去重后最多保留 50 条，超限淘汰最旧——单座位一次重连
 * 重放窗口内的失败事件量级远小于此，cap 防失控 turn 反复失败把 state jsonb 撑爆。
 */
const FAILED_EVENT_SEQ_CAP = 50;

/**
 * message_chunk 缓冲字符上限（M1 三新债 #2 无界增长；RT-DEBT-2）：
 * 1M 字符 ≈ ACP 长 turn 正常输出量级的数倍（正常完整回复远低于此），失控 turn
 * （死循环输出/超长生成）的内存兜底。超限丢最旧 chunks 至上限内 + 每座位节流 warn；
 * 拼装照常（头部截断降级语义，完整度由 message_complete.text 兜底——新 runner 全
 * 文自带，buffer 仅老 runner 兼容路径）。
 */
const MAX_CHUNK_BUFFER_CHARS = 1_000_000;

/** chunk 缓冲超限 warn 节流窗口：每座位 60s 内至多一条（失控 turn 持续超限时防刷屏） */
const CHUNK_TRIM_WARN_THROTTLE_MS = 60_000;

/**
 * 系统 actor 哨兵 id（ActorUnification migration 1781364902335 播种的 actors 行，
 * display_name='system'；平台系统消息（失败回执等）以此为发送者，profile 查询按
 * senderId 命中 type='system'，展示为系统消息——与消息 type=SYSTEM 语义一致）
 */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/** 单飞行待发注入：seq 在入队时确定（新注入 = 游标递增；重放 = 历史原 seq） */
interface PendingInject {
  seq: number;
  payload: InjectPayload;
  messageIds: string[];
}

/** 座位单飞行状态（per-seat，M1 计划 §二 决策 6：busy 则入内存 FIFO，complete 后放行下一批） */
interface SeatFlight {
  busy: boolean;
  queue: PendingInject[];
}

/**
 * 近况活动条目（M4b-1，落 seat.state.recentActivity——participant 全可读，故 R5 摘要化：
 * 只保留展示所需字段，剥离 rawInput/locations 等敏感载荷，title 截断 + cwd 前缀剥离）
 */
export interface RecentActivityItem {
  /** 活动发生时间（ISO 8601） */
  at: string;
  /** 活动类别：tool_call（工具调用）/ turn（一轮发言终结）/ permission（审批请求） */
  kind: 'tool_call' | 'turn' | 'permission';
  /** 摘要文本（工具标题或「回复 n 字/沉默」；不承载原始载荷） */
  summary: string;
  /** 结果态（工具 status / stopReason / 'pending'，原文透传不翻译） */
  result: string;
}

/**
 * 座位实时相位（M4b-1，chamber 内存派生视图：不落库、不进 events 表——设计定稿
 * 「实时态唯一权威点」；listSeats 响应时 overlay，重启丢失可接受）
 * 推导映射（R4，见 handleSeatEvent）：status busy→thinking；tool_event
 * in_progress/pending→tool（带 toolTitle）；tool_event completed→回 thinking；
 * message_chunk→replying；message_complete→idle（沉默不是相位，💤 由 idle +
 * 上轮 silent 在 web 端推导）；status online→idle、offline→offline；
 * runner 断连（registry 摘牌）→offline；seat 移除→清条目。
 */
export interface SeatPresence {
  /** 相位：thinking 思考中 / tool 工具调用中 / replying 回复中 / idle 空闲 / offline 离线 */
  phase: 'thinking' | 'tool' | 'replying' | 'idle' | 'offline';
  /** 相位变更时间（ISO 8601） */
  at: string;
  /** 工具标题（仅 phase='tool' 时存在；已摘要化，供 chip 展示） */
  toolTitle?: string;
}

/**
 * per-seat 攒批收集器（M2 阶段 2/3，r5 §6：座位维度时间窗 + r6 parked 语义）
 *
 * 内存投影（R4 可重建视图）：真相 = topic 黑板 + lastInjectSeq，本结构只负责
 * 「已到达、尚未封批」的消息暂存——backend 重启后由 reconcile →
 * rebuildUndispatched 从黑板重建，不依赖本结构持久化。
 * 两段式（r6 架构拍板）：
 * - parked：非唤醒消息（未 @ 命中 / system）暂存——「继续躺着」，不起定时器；
 *   下次任一唤醒消息封批时并入（未 @ 不唤醒但下次派发可见，§6 被动可见性）。
 * - window：唤醒消息攒批窗口（首条唤醒消息到达时开批 + 启动定时器）→ 到期封批
 *   （sealed + 出表）→ 新唤醒消息开新批。封批即冻结（RT-BATCH-1）。
 * 注意：parked 无界（M1 三新债 #2，阶段 5 加硬帽；本阶段只保不丢）。
 */
interface BatchCollector {
  /** 非唤醒消息 id 集合（去重；封批时并入批内） */
  parked: string[];
  /** 唤醒消息攒批窗口（null = 无开着的批） */
  window: BatchWindow | null;
}

/** 攒批窗口（唤醒消息暂存 + 到期封批定时器） */
interface BatchWindow {
  /** 已收集唤醒消息 id（封批后冻结，不再进新消息） */
  messageIds: string[];
  /** 窗口到期定时器（到期 → 封批入单飞行 FIFO）；随 offline/断连清理防泄漏（RT-BATCH-2） */
  timer: NodeJS.Timeout;
  /** 封批标记（幂等防御：offline 清理与定时器到期并发时只封一次；出表后实际不可见） */
  sealed: boolean;
}

/**
 * 圆桌会话层 M1 版（chamber ③，厂商无关；docs/roundtable-design.md §2/§6）
 *
 * 职责：
 * 1. 座位 CRUD（createSeat/listSeats）：topic 存在性 findOrThrow + permService.ensureCan
 *    权限（铁律 #21/#22，Controller 只管格式）
 * 2. 注入触发器 @OnEvent('event.created')：过滤 NEW_MESSAGE → 按 messageId 自查消息存在性
 *    （listener 铁规③，免疫事务回滚幻影）→ 查该 topic active 座位 → 零座位短路（普通
 *    topic 零开销）→ 读 topic.settings 解析 wakePolicy → 安全阀门闸（r7：人类消息先
 *    复位再走路由——清零全部 active 座位计数、paused 则复位公告；非人类消息先算
 *    paused——暂停中全部座位只 park 不唤醒、不发回执）→ 回声抑制跳过（metadata.seatLabel
 *    === seat.label，§6）→ 唤醒判定（M2 阶段 3：mention @label token 精确 / @all /
 *    broadcast / system 永不唤醒，R1 人机一致不按 senderType 特判）→ per-seat 收集器
 *    （唤醒+可达 → 窗口攒批/直通封批；其余 → parked 躺着）→ 失败回执（唤醒但不可达）
 * 3. 注入装配：规则头（RULE_HEADER_VERSION=2，§6 统一装配——ACP 无 system prompt 通道，
 *    §8 实测） + assembleInjectBody（r3 冻结 schema，windowMs = 座位配置值；封批多条
 *    ts 升序）→ seat.inject 下行（经 registry.sendToRunner）→ 落 last_inject_seq +
 *    state.recentInjects ring buffer
 * 4. seat.event 上行：seq 幂等去重（≤ last_event_seq 丢弃，§4 双向对账）；message_chunk
 *    内存累积（message_complete 全文 = 累积拼装——契约① message_complete 无 text 字段）；
 *    silent → 只记日志不落 topic（§6 沉默拦截；M2 阶段 3 补文本兜底：parseSilentReply
 *    对全文二次判定，runner 标志优先）且 state.silentCount+1（r7，R6）；否则 sendMessage
 *    以 runner actor 身份落库（§6 身份模型：metadata.seatLabel 标记子身份；
 *    clientRequestId = rt:{seatId}:{seq} 防重放双写）且 state.roundsWithoutHuman+1
 *    （跨过阈值那一 turn 再 valveTripCount+1 + topic 触发公告，r7）；usage →
 *    state.lastUsage（M1 顺手存，M3 预算熔断数据源）；status → 座位状态 +
 *    offline 时窗口立即封批；permission_request 落库 pending + topic 公告
 *    （M3 阶段 1，落库失败留档待重放按 requestId 幂等）；seat_info →
 *    state.modelInfo（M3 阶段 5：座位实际在跑配置观测 model/thinking/mode，
 *    lastUsage 同款 jsonb 落法，不建列不迁移）
 * 5. hello 对账重放（§4 可靠性）：runner 报 lastReceivedSeq < chamber last_inject_seq →
 *    从 state.recentInjects 按缺口重建 inject 重发（黑板即真相，无 outbox 表）；
 *    R4 重启重建：窗口内未派发消息（未 persistDispatch）按 ring 时间下界从黑板补捞
 *    （parked 一并按强制封批处理——重启即到期，宁可多唤醒一次不丢消息）
 * 6. 断连：onRunnerOffline 重置绑定座位的单飞行 busy（已发未确认由 hello 对账兜底）+
 *    立即封批清窗口定时器（防泄漏，RT-BATCH-2；parked 一并封入队列等重连）
 * 7. 失败回执（决策 #6，M2 阶段 3）：唤醒但不可达（未绑 runner / runner 离线）/ busy
 *    排队超限（>QUEUE_RECEIPT_THRESHOLD）→ topic 内 type='system' 回执，per-seat
 *    per-reason 节流（RECEIPT_THROTTLE_MS，5 分钟）；回执自身是 system 消息 →
 *    「system 不唤醒」规则天然免疫递归
 * 8. 圆桌安全阀（r7，设计 §6）：计数全落 seat.state（roundsWithoutHuman / silentCount /
 *    valveTripCount，注入管线独占写 §5）；暂停 = 派生态（任一 active 座位计数 ≥ 阈值
 *    N，无标志位不落库）；触发/复位公告复用系统消息通道（sendSystemMessage，与回执
 *    同源）+ per-topic 节流；阈值 topic.settings.maxRoundsWithoutHuman 缺省 8、0=关闭
 *    （计数照常推进但不熔断）
 * 9. M3 阶段 3（r13）治理三小件：座位移除（DELETE /roundtable/seats/:id——软删
 *    status='removed' + 解绑 runner + seat.revoke 下行 + 收集器/单飞行清理 +
 *    topic 公告，仅人类管理员）；@all 冷却（per-topic 60s 内存 Map，冷却内 @all
 *    只入可见集不唤醒 + 冷却提示）；seatCoordinator 透传（座位发言落库 metadata
 *    补 seatCoordinator=true 仅主脑座位，topic.service 同款单键投影）
 * 10. M4b-1（seat 状态可视化轻量版）：presence 实时相位内存推导（既有上行事件
 *     R4 映射——busy→thinking / tool in_progress→tool / chunk→replying /
 *     complete→idle / offline→offline，listSeats 响应 overlay，不落库）+ 近况
 *     recentActivity 聚合（tool_event/permission 当轮内存缓冲 → message_complete
 *     冲刷落 state.recentActivity cap 10 环形，R3 冲刷式一次落库；permission_request
 *     即时写；R5 摘要化防敏感泄漏）+ POST /roundtable/seats/:id/cancel（治理身份
 *     admin|creator|ownerProxy + busy 门控 409 + seat.cancel 下行 fire-and-forget）
 *
 * 线程/并发模型：单进程内 per-seat 队列串行（队列头保留至发送成功才出队；发送失败
 * 保持队头等重连 flush）。攒批收集器/窗口定时器同为内存态：chamber 重启丢窗口与队列，
 * 由 reconcile → rebuildUndispatched 从 topic 黑板重建（R4 可重建视图，M2 阶段 2 补上
 * 该路径——M1 时期重启丢内存队列是已接受窗口）。
 */
@Injectable()
export class RoundtableService {
  private readonly logger = new Logger(RoundtableService.name);

  /** per-seat 单飞行状态（内存；chamber 重启丢失，靠 hello 对账 + recentInjects 重建） */
  private readonly flights = new Map<string, SeatFlight>();

  /** message_chunk 累积缓冲：seatId → 当前 turn 的增量文本（message_complete 拼装后清除） */
  private readonly chunkBuffers = new Map<string, string[]>();

  /**
   * recentActivity 当轮累积缓冲（M4b-1 R3 冲刷式）：seatId → 当轮活动条目。
   * tool_event 高频只入本缓冲；message_complete 时冲刷合并进 state.recentActivity
   * （随该分支既有 state 写入一次落库——无锁整对象替换的竞态窗口不因高频写放大）；
   * permission_request 低频治理事件即时写不经过本缓冲；runner 断连 → 当轮缓冲丢弃
   * （近况摘要语义可接受：断连轮未终结，半截活动不污染时间线）。
   */
  private readonly recentActivityBuffers = new Map<string, RecentActivityItem[]>();

  /** 座位实时相位（M4b-1，内存 Map 不落库——实时态是派生视图，重启清零可接受） */
  private readonly seatPresences = new Map<string, SeatPresence>();

  /** per-seat 攒批收集器（内存投影，R4：真相 = topic 黑板 + lastInjectSeq；重启后重建） */
  private readonly batchCollectors = new Map<string, BatchCollector>();

  /** 回执节流表：`${seatId}:${reason}` → 上次落回执时间戳（内存；重启清零可接受，见 emitReceipt） */
  private readonly receiptThrottle = new Map<string, number>();

  /** 安全阀公告节流表：`${topicId}:${kind}` → 上次公告时间戳（内存；重启清零可接受——最多多一条，见 emitValveAnnouncement） */
  private readonly valveAnnounceThrottle = new Map<string, number>();

  /** 审批公告节流表：`${seat.id}:request`（请求公告）/ `${topicId}:orphan`（孤儿作废公告）→ 上次公告时间戳（内存；重启清零可接受，见 announcePermissionRequest/announceOrphan） */
  private readonly permissionAnnounceThrottle = new Map<string, number>();

  /** @all 群体唤醒冷却表：topicId → 上次 @all 群体唤醒时间戳（内存；重启清零可接受，见 tryAllWake/ALL_WAKE_COOLDOWN_MS） */
  private readonly allWakeCooldown = new Map<string, number>();

  /** @all 冷却提示节流表：topicId → 上次冷却提示时间戳（内存；与冷却同周期——提示是提示不是账本，见 emitAllWakeHint） */
  private readonly allWakeHintThrottle = new Map<string, number>();

  /** chunk 缓冲超限 warn 节流表：seatId → 上次 warn 时间戳（内存；重启清零可接受——提示性日志，见 message_chunk 分支） */
  private readonly chunkTrimWarnThrottle = new Map<string, number>();

  /** 下行 seq 分配游标缓存：seatId → 下一个待分配 seq（懒初始化自 seat.lastInjectSeq） */
  private readonly nextSeqCache = new Map<string, number>();

  constructor(
    @InjectRepository(RoundtableSeat)
    private seatRepo: Repository<RoundtableSeat>,
    @InjectRepository(RoundtableRunner)
    private runnerRepo: Repository<RoundtableRunner>,
    @InjectRepository(RoundtablePermissionRequest)
    private permReqRepo: Repository<RoundtablePermissionRequest>,
    @InjectRepository(TopicParticipant)
    private participantRepo: Repository<TopicParticipant>,
    @InjectRepository(Topic)
    private topicRepo: Repository<Topic>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    @InjectRepository(Actor)
    private actorRepo: Repository<Actor>,
    private readonly topicService: TopicService,
    private readonly permService: PermissionService,
    private readonly registry: RunnerRegistryService,
    private readonly ownerProxy: OwnerProxyService,
  ) {}

  // ─────────────────────────── 座位 CRUD（M1 最小 REST） ───────────────────────────

  /**
   * TOPIC-PERM 收口（v1.46）：TopicPolicy.write 已放宽给 editor 参与方，但座位创建
   * （绑定 agent 进圆桌）与权限请求裁决属成员管理/治理范畴（目标语义表 creator-only）
   * ——roundtable 内两处 ensureCan('write') 调用点必须叠加本收口：admin | creator |
   * 人类 owner 代理（isOwnerProxy 自带 human 短路），editor 一律 403。
   */
  private async ensureTopicCreatorOrAdmin(topic: Topic, actor: UnifiedActor): Promise<void> {
    if (actor.role === UserRole.ADMIN || topic.creatorId === actor.id) return;
    if (await this.ownerProxy.isOwnerProxy(topic.creatorId, actor)) return;
    throw new ForbiddenException({
      message: 'Only the topic creator can perform this action',
      code: ErrorCode.PERMISSION_DENIED,
    });
  }

  /**
   * 建座位（POST /roundtable/seats）
   * topic 存在性（findById → 404）+ 参与者写权限（ensureCan 'write'）在 Service 层（铁律 #21）；
   * v1.46 起叠加 ensureTopicCreatorOrAdmin 收口（write 已放宽给 editor，座位创建保持 creator-only）。
   * bindActorId 缺省时：创建者是 agent → 默认绑自己（runner 用该 agent 的 key 拨号）；
   * 创建者是人类 → 必须显式指定（400）。
   * @param dto Controller 已做格式校验的 DTO
   * @param actor 当前统一身份
   * @returns 落库后的座位行
   * @throws ConflictException 409 ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT——同 topic 下该
   *   bindActorId 已有 active 座位（r17 唯一约束：一 agent 一 topic 一 active 座位）
   */
  async createSeat(dto: CreateSeatDto, actor: UnifiedActor): Promise<RoundtableSeat> {
    const topic = await this.topicService.findById(dto.topicId);
    await this.permService.ensureCan(topic, actor, 'write');
    await this.ensureTopicCreatorOrAdmin(topic, actor);
    const bindActorId = dto.bindActorId ?? (actor.type === ActorType.AGENT ? actor.id : undefined);
    if (!bindActorId) {
      throw new BadRequestException({
        message: 'bindActorId is required when creator is not an agent',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    // r17 唯一座位约束（docs/roundtable-design.md §12 r17：一 agent 一 topic 只能有一个
    // active 座位；removed 软删豁免——移除后可重建）：同 topic + 同 bindActorId 且
    // status != 'removed' 的座位已存在 → 409（铁律 #21/#22 业务存在性检查在 Service 层）。
    // ⚠️ RT-SEAT-1：findOne 的 jsonb 嵌套对象条件（config: { bindActorId }）在 typeorm
    // 0.3.30 生成的是整列等值（"config" = $3，真机验证永不命中），不是路径提取——必须
    // 用 queryBuilder 显式 config->>'bindActorId'，与唯一索引表达式等值语义一致。
    // bindActorId 必非空（上方 400 已短路缺省路径：agent 缺省绑自己、人类缺省 400）。
    const existing = await this.seatRepo
      .createQueryBuilder('seat')
      .where('seat.topicId = :topicId', { topicId: dto.topicId })
      .andWhere("seat.status != 'removed'")
      .andWhere("seat.config->>'bindActorId' = :bindActorId", { bindActorId })
      .getOne();
    if (existing) {
      throw new ConflictException({
        message: `Roundtable seat for bindActorId ${bindActorId} already exists in topic ${dto.topicId} (status=${existing.status})`,
        code: ErrorCode.ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT,
      });
    }
    // config 只存静态配置（§5 分列铁律）；permissionMode 显式钉死（§7：禁止吃用户 config 剩饭）
    const config: Record<string, unknown> = {
      permissionMode: dto.permissionMode,
      cwd: dto.cwd,
      bindActorId,
      // 攒批窗口：缺省 30s（设计 §6，DEFAULT_BATCH_WINDOW_MS 一处常量）；0 = 直通（M1 行为）
      batchWindowMs: dto.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    };
    if (dto.model) config.model = dto.model;
    const seat = this.seatRepo.create({
      topicId: dto.topicId,
      label: dto.label,
      vendor: dto.vendor,
      runnerId: null,
      config,
      state: {},
      status: 'active',
      coordinator: dto.coordinator ?? false,
      lastEventSeq: '0',
      lastInjectSeq: '0',
    });
    let saved: RoundtableSeat;
    try {
      saved = await this.seatRepo.save(seat);
    } catch (err: unknown) {
      // DB 唯一索引兜底（r17）：业务检查非原子，并发双建仍可能触发部分唯一索引 23505
      // （uq_roundtable_seats_topic_bind_actor）——翻译为与业务检查一致的 409，禁止上游
      // PG 错误透传成 500（铁律 #9）；非本索引冲突原样抛出
      throw this.translateBindActorConflict(err);
    }
    // 债③ auto-join（M1 三新债 #3，RT-DEBT-3）：座位发言以绑定 actor 身份落 topic
    // （§6 身份模型），私密桌 participant 检查会拒绝非成员——创建时若该 actor 非
    // topic active 参与者 → 自动 join + 「座位 {label} 已入座」system 公告。幂等：
    // 已参与者不 join 不公告（防重复公告）；公告是 system 消息 → 「system 不唤醒」
    // 天然免疫递归。失败不阻断建座（记日志；join 失败=座位仍创建，私密桌发言受限
    // 会在运行期暴露）。
    await this.ensureSeatActorJoined(topic, saved.label, bindActorId);
    return saved;
  }

  /**
   * 座位唯一约束冲突翻译（r17，createSeat 的 DB 兜底路径）：
   * 部分唯一索引 uq_roundtable_seats_topic_bind_actor（(topic_id, config->>'bindActorId')
   * WHERE status != 'removed'，见 migration 1786202112450）冲突 23505 → 409
   * ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT，与业务检查（createSeat 前置 findOne）同码——
   * 并发双建时业务检查可能双双未命中，索引是最后防线（铁律 #9：禁止 23505 透传成 500）。
   * 非本索引的 23505 / 其他错误原样抛出。
   * @param err save 抛出的原始错误（TypeORM QueryFailedError 透传 pg driver 的 code/constraint）
   * @returns 翻译后的 ConflictException，或原错误（非本索引冲突）
   */
  private translateBindActorConflict(err: unknown): Error {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'uq_roundtable_seats_topic_bind_actor') {
      return new ConflictException({
        message: 'Roundtable seat for this actor already exists in the topic',
        code: ErrorCode.ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT,
      });
    }
    return err as Error;
  }

  /**
   * 债③ auto-join 实现（RT-DEBT-3）：绑定 actor 非 topic active 参与者 → 复用
   * topicService.join 通道加入（actorType 查 actors 表，缺省 agent）+ 复用
   * sendSystemMessage 通道落「座位 {label} 已入座」公告。幂等：已参与者直接返回
   * （不 join 不公告）。异常自吞只记日志（建座主流程不因公告失败失败）。
   * @param topic 已校验存在与写权限的 topic 行
   * @param label 座位 label（进公告文案）
   * @param bindActorId 座位绑定的 actor id（runner.actorId）
   */
  private async ensureSeatActorJoined(
    topic: Pick<Topic, 'id'>,
    label: string,
    bindActorId: string,
  ): Promise<void> {
    try {
      if (await this.topicService.isActiveParticipant(topic.id, bindActorId)) return;
      const actor = await this.actorRepo.findOne({ where: { id: bindActorId } });
      await this.topicService.join(topic.id, bindActorId, actor?.type ?? ActorType.AGENT);
      await this.sendSystemMessage(topic.id, `座位 ${label} 已入座`);
      this.logger.log(
        `auto-join: 座位 ${label} 绑定 actor ${bindActorId} 已加入 topic ${topic.id} 并公告`,
      );
    } catch (err) {
      this.logger.error(
        `auto-join 失败 seat ${label} actor ${bindActorId} topic ${topic.id}（座位已创建，运行期受限）: ${String(err)}`,
      );
    }
  }

  /**
   * 座位列表（GET /roundtable/seats?topicId=）
   * topic 存在性 + read 权限（ensureCan 'read' 失败统一 404，安全 through obscurity）。
   * 排除 status='removed' 的已移除座位（M3 阶段 3 座位移除：软删语义，行保留供
   * 历史消息座位溯源——metadata.seatLabel 已在消息上，行内 label 是溯源旁证）。
   * M4b-1：响应 overlay presence（内存派生实时相位，查询后合并——不污染实体不落库；
   * 无相位条目 = 座位从未活动，不加 presence 字段）。
   */
  async listSeats(
    topicId: string,
    actor: UnifiedActor,
  ): Promise<Array<RoundtableSeat & { presence?: SeatPresence }>> {
    const topic = await this.topicService.findById(topicId);
    await this.permService.ensureCan(topic, actor, 'read');
    const seats = await this.seatRepo.find({ where: { topicId, status: Not('removed') } });
    return seats.map((seat) => {
      const presence = this.seatPresences.get(seat.id);
      return presence ? { ...seat, presence } : seat;
    });
  }

  // ─────────────────────────── runner 列表（v1.49.0 座位管理 UI） ───────────────────────────

  /**
   * runner 列表（GET /roundtable/runners，v1.49.0 web 座位管理 runner 状态块数据源）
   *
   * 权限哲学：任意认证 actor 可读（控制器 JwtOrApiKeyGuard 既有闸）——runner 拓扑是
   * 部署基础设施信息而非业务敏感数据，与 seats 的 participant 可读哲学一致；
   * web 建座前需要知道「有没有 runner 在线、支持哪些 vendor」。
   *
   * 最小暴露：响应做字段投影，不透 actorId（runner 与 agent actor 的内部归属）与
   * createdAt/updatedAt（审计字段，UI 无消费场景）。
   *
   * 排序契约：online 优先，同状态按 lastSeenAt 倒序（web 状态块按序直接渲染，
   * 离线 runner 沉底但不隐藏——排障需要看到「曾经有 runner」）。
   *
   * @returns runner 投影列表（id/name/status/version/vendors/lastSeenAt）
   */
  async listRunners(): Promise<
    Array<Pick<RoundtableRunner, 'id' | 'name' | 'status' | 'version' | 'vendors' | 'lastSeenAt'>>
  > {
    const runners = await this.runnerRepo.find();
    return runners
      .map(({ id, name, status, version, vendors, lastSeenAt }) => ({
        id,
        name,
        status,
        version,
        vendors,
        lastSeenAt,
      }))
      .sort((a, b) => {
        // online 优先；同状态 lastSeenAt 倒序（null 视为最旧沉底）
        if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
        return (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0);
      });
  }

  // ─────────────────────────── 座位移除（M3 阶段 3，设计 §6 座位管理） ───────────────────────────

  /**
   * 座位移除（DELETE /roundtable/seats/:id，r13）：软删——status 置 'removed' +
   * 解绑 runner（runnerId=null），物理行保留。
   *
   * 为什么软删（选择理由）：
   * - 现有查询面天然屏蔽非 active 座位：onMessageCreated 只查 status='active'
   *   （唤醒/注入全断）；bindSeats 只认 status IN ('active','offline')（重连不再
   *   认领）；runnerId=null 后 reconcile/buildSeatAck/onRunnerOffline 按 runnerId
   *   查询不再命中（重放/对账/断连清理全断）。listSeats 是唯一需要显式排除的点。
   * - 保留行与 metadata.seatLabel 历史消息互为溯源旁证；config/state 留档便于
   *   排障审计。无 deleted_at 列，加列需 migration——status='removed' 零迁移成本。
   *
   * 权限模型（§6「人类（topic 管理员/平台管理员）可移除座位」+ §7 治理层人类特权）：
   * - agent API Key 一律 403（移除 = 治理动作，人类特权，与裁决同规）
   * - 人类：平台管理员（actor.role === UserRole.ADMIN）/ topic 创建者 /
   *   creator 的人类 owner 代理（OwnerProxyService，与 topic.service sendMessage
   *   私密桌放行同规）→ 放行；其余 403
   *
   * 行为顺序（每一步失败都不阻断后续，保证「移除」语义最终生效）：
   * 1. 存在性（404，铁律 #22）+ 权限（403）
   * 2. 下行 seat.revoke（fire-and-forget：runner 在线 → 停驱动清状态；
   *    offline → 记 warning——重连后不会重新认领（status='removed' 被 bindSeats
   *    排除），本地残留会话是已接受缺口：无注入即无消耗，见交付说明）
   * 3. 收集器清理（复用 sealBatch 同规，圆桌 service status offline 分支注释要求）：
   *    sealBatch 封批丢弃 + 清单飞行 pending 队列（勿注入）+ 清 chunk 缓冲
   * 4. 落库 status='removed' + runnerId=null
   * 5. topic 系统公告「座位 X 已被移除」（fire-and-forget + 内部自吞，复用
   *    sendSystemMessage 通道；公告是 system 消息 → 「system 不唤醒」免疫递归）
   *
   * @param seatId 座位 UUID
   * @param actor 当前统一身份（人类管理员）
   * @returns 落库后的座位行（status='removed'）
   * @throws NotFoundException 座位不存在；ForbiddenException agent 或非管理员
   */
  async removeSeat(seatId: string, actor: UnifiedActor): Promise<RoundtableSeat> {
    const seat = await this.seatRepo.findOne({ where: { id: seatId } });
    if (!seat) {
      throw new NotFoundException({
        message: 'Roundtable seat not found',
        code: ErrorCode.ROUNDTABLE_SEAT_NOT_FOUND,
      });
    }
    await this.ensureCanManageTopic(seat.topicId, actor);
    // 已移除幂等：重复 DELETE 直接返回（行已不可见，无需再走一遍 revoke/公告）
    if (seat.status === 'removed') return seat;

    const label = seat.label;
    // 下行 revoke（fire-and-forget；信封构造与 seat.assign 同规——seq=0 无对账语义，
    // payload 空对象（协议 validateEmptyPayload 要求），runner 侧 handleRevoke 已就绪）
    if (seat.runnerId) {
      const ok = this.registry.sendToRunner(
        seat.runnerId,
        buildEnvelope('seat.revoke', {}, { seatId: seat.id, seq: 0 }),
      );
      if (!ok) {
        this.logger.warn(
          `seat.revoke 下行失败（runner 离线）seat ${seat.id}（${label}）——重连后 status='removed' 不会被重新认领；残留会话无注入即无消耗，重启 runner 后自然消失`,
        );
      }
    }
    // 收集器清理（复用 sealBatch 同规：封批丢弃窗口/parked 入队——enqueueBatch 读
    // 库时 runnerId 仍旧值会入队，故**先 await 封批完成**再清空单飞行 pending 队列，
    // 两段合起来 = 「待注入批封批丢弃 + 清 pending，勿注入」——避免入队与清空竞态
    // 导致 revoke 后仍发注入）；offline 清理与定时器到期并发时 sealBatch 幂等
    // （出表保证只封一次）
    await this.sealBatch(seat.id);
    const flight = this.flights.get(seat.id);
    if (flight) {
      flight.queue = [];
      flight.busy = false;
    }
    this.chunkBuffers.delete(seat.id);
    this.nextSeqCache.delete(seat.id);
    // M4b-1：座位移除 → 清 presence 条目与当轮近况缓冲（行已不可见，内存派生态一并清理）
    this.seatPresences.delete(seat.id);
    this.recentActivityBuffers.delete(seat.id);

    seat.status = 'removed';
    seat.runnerId = null;
    const saved = await this.seatRepo.save(seat);
    this.logger.log(`座位已移除: seat ${seat.id}（${label}）topic ${seat.topicId}`);
    // topic 系统公告（fire-and-forget + 内部自吞，与 emitReceipt 同精神）
    void this.announceSeatRemoved(seat.topicId, label);
    return saved;
  }

  /**
   * 治理权限判定（M3 阶段 3，§6 座位管理 + §7 人类特权）：仅人类可移除座位——
   * 平台管理员（actor.role === ADMIN）/ topic 创建者 / creator 的人类 owner 代理
   * （OwnerProxyService，与 topic.service sendMessage 私密桌放行同规；agent actor
   * 无 owner 代理概念，isOwnerProxy 自带 human 短路）。
   * @param topicId 座位所属 topic
   * @param actor 当前统一身份（agent → 403）
   * @throws ForbiddenException 非人类或非管理员
   */
  private async ensureCanManageTopic(topicId: string, actor: UnifiedActor): Promise<void> {
    if (actor.type !== ActorType.HUMAN) {
      throw new ForbiddenException({
        message: 'Only human users can manage roundtable seats',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    // 性能短路（owner-proxy 铁律）：admin / 直接 creator 先短路，不触发代理查询
    if (actor.role === UserRole.ADMIN) return;
    const topic = await this.topicService.findById(topicId); // 404 透传（topic 缺失）
    if (topic.creatorId === actor.id) return;
    if (await this.ownerProxy.isOwnerProxy(topic.creatorId, actor)) return;
    throw new ForbiddenException({
      message: 'Access denied: only the topic admin or platform admin can remove seats',
      code: ErrorCode.PERMISSION_DENIED,
    });
  }

  /**
   * 座位移除公告（M3 阶段 3）：topic 内 type='system' 消息——「座位 X 已被移除」。
   * 通道复用 sendSystemMessage（与回执/安全阀公告同源：系统 actor + 私密桌 join）；
   * fire-and-forget + 内部自吞（公告失败不影响移除主流程）；公告是 system 消息 →
   * 「system 不唤醒」天然免疫递归（RT-ROUTE-1）。移除是低频治理动作，不节流。
   * @param topicId 目标 topic
   * @param label 座位 label（进文案）
   */
  private async announceSeatRemoved(topicId: string, label: string): Promise<void> {
    try {
      await this.sendSystemMessage(topicId, `座位 ${label} 已被移除`);
      this.logger.log(`座位移除公告: topic ${topicId} seat ${label}`);
    } catch (err) {
      this.logger.error(`座位移除公告落库失败 topic ${topicId} seat ${label}: ${String(err)}`);
    }
  }

  /**
   * 取消座位发言（POST /roundtable/seats/:id/cancel，M4b-1）
   *
   * 权限（治理动作，与座位管理同规）：先 topic read 权限（ensureCan 'read'——非参与者
   * 统一 404，安全 through obscurity，与 verdictPermissionRequest「先 404 后 403」同模式），
   * 再 admin | topic creator | creator 的 owner 代理（ensureTopicCreatorOrAdmin 收口——
   * 取消会打断在跑会话，editor 参与者一律 403）。
   * busy 门控（R1）：presence 相位非 busy（thinking/tool/replying 之外，含无条目 =
   * 从未活动）→ 409 RESOURCE_CONFLICT——空闲会话不得下发 cancel，否则 runner 侧
   * 超时兜底 kill 会误杀健康进程。
   * 下行：seat.cancel（空 payload，seq=0——无对账语义，与 seat.revoke 同规）经
   * registry fire-and-forget；runner 离线只记 warning（优雅取消结果是异步的，web 经
   * 轮询观察相位变化自然收敛）。
   * 响应语义：立即返回 accepted（不落库——presence 是内存派生视图，无持久化状态）。
   *
   * @param seatId 座位 UUID
   * @param actor 当前统一身份（admin|creator|ownerProxy）
   * @returns { accepted: true, seatId }——优雅结果异步，调用方不得同步等待
   * @throws NotFoundException 座位/topic 不存在；ForbiddenException 非治理身份；
   *   ConflictException presence 非 busy（空闲会话）
   */
  async cancelSeat(
    seatId: string,
    actor: UnifiedActor,
  ): Promise<{ accepted: true; seatId: string }> {
    const seat = await this.seatRepo.findOne({ where: { id: seatId } });
    if (!seat) {
      throw new NotFoundException({
        message: 'Roundtable seat not found',
        code: ErrorCode.ROUNDTABLE_SEAT_NOT_FOUND,
      });
    }
    const topic = await this.topicService.findById(seat.topicId); // topic 404 透传（铁律 #22）
    // 先 404 后 403（verdict 同款调用模式）：read 失败统一 404（非参与者不泄露座位存在性，
    // through obscurity）；参与者再走治理身份收口——editor 403
    await this.permService.ensureCan(topic, actor, 'read');
    await this.ensureTopicCreatorOrAdmin(topic, actor);
    const phase = this.seatPresences.get(seat.id)?.phase;
    if (!phase || phase === 'idle' || phase === 'offline') {
      throw new ConflictException({
        message: `Seat is not busy (phase=${phase ?? 'unknown'}), cannot cancel`,
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }
    // 下行 cancel（fire-and-forget；信封构造与 seat.revoke 同规——seq=0 无对账语义，
    // payload 空对象（协议 validateEmptyPayload 要求），runner 侧 handleCancel 已就绪）
    if (seat.runnerId) {
      const ok = this.registry.sendToRunner(
        seat.runnerId,
        buildEnvelope('seat.cancel', {}, { seatId: seat.id, seq: 0 }),
      );
      if (!ok) {
        this.logger.warn(
          `seat.cancel 下行失败（runner 离线）seat ${seat.id}（${seat.label}）——座位已在跑但 runner 不可达，重连后由用户重试`,
        );
      }
    } else {
      this.logger.warn(`seat.cancel: seat ${seat.id} 未绑定 runner，下行跳过`);
    }
    return { accepted: true, seatId: seat.id };
  }

  // ─────────────────────────── 审批持久化 + 裁决（M3 阶段 1，§6 审批可见性） ───────────────────────────

  /**
   * permission_request 上行落库（M3 阶段 1，handleSeatEvent 分支调用）：
   * pending 行落库 + topic 公告（fire-and-forget + 节流，复用 emitReceipt 模式）。
   * 重放幂等（RT-DEBT-1 语义 + RT-PERM-2 收紧）：同 (seatId, requestId) 已有
   * **pending** 行 → 视为重放（平台已落库但 ack 丢失，runner 重连重放未确认事件），
   * 返回 true 不重复落库不重复公告。**已有行非 pending（orphaned/approved/rejected =
   * 已终结）→ 视为新请求落新行**：requestId 是 ACP 进程内 jsonrpc id，跨会话从 0
   * 重新计数——runner 重启/session resume 后新请求必然与历史终结行撞键，不区分
   * 状态会把重启后的首次审批当重放静默吞掉（agent 在 runner 侧永久 park）。
   * @param seat 发起请求的座位（topicId 随行落库）
   * @param payload permission_request 事件载荷（tool/options 原样存 jsonb）
   * @returns true = 已持久化（含重放命中已有 pending 行）；false = 落库失败（调用方留档待重放）
   */
  private async persistPermissionRequest(
    seat: RoundtableSeat,
    payload: Extract<SeatEventPayload, { type: 'permission_request' }>,
  ): Promise<boolean> {
    // RT-PERM-2：幂等键必须带 status='pending'——requestId 跨 ACP 会话归零复用，
    // 只按 (seatId, requestId) 去重会把重启后的新请求误判为旧行重放（见方法 doc）
    const existing = await this.permReqRepo.findOne({
      where: { seatId: seat.id, requestId: payload.requestId, status: 'pending' },
    });
    if (existing) {
      this.logger.debug(
        `permission_request 重放命中已有 pending 行 seat ${seat.id} requestId ${payload.requestId}（幂等，跳过落库）`,
      );
      return true;
    }
    try {
      await this.permReqRepo.save(
        this.permReqRepo.create({
          requestId: payload.requestId,
          seatId: seat.id,
          topicId: seat.topicId,
          tool: payload.tool,
          options: payload.options,
          status: 'pending',
          verdictOptionId: null,
          resolvedBy: null,
          resolvedAt: null,
        }),
      );
      this.logger.log(
        `permission_request 落库 pending: seat ${seat.id} (${seat.label}) requestId ${payload.requestId}`,
      );
      // M4b-1：审批请求即时写近况（低频治理事件值得立即可见，不等 message_complete 冲刷；
      // 仅内存改 state——所在 handler 尾部有统一 save 落库，不新增 save 次数；
      // 重放命中已有 pending 行时走上方 existing 分支提前返回，不会重复写条目——幂等）
      this.pushRecentActivityNow(seat, this.permissionRecentActivityItem(seat, payload.tool));
      // 公告 fire-and-forget（失败自吞只记日志，绝不影响上行处理热路径）
      void this.announcePermissionRequest(seat, payload.tool);
      return true;
    } catch (err) {
      this.logger.error(
        `permission_request 落库失败 seat ${seat.id} requestId ${payload.requestId}: ${String(err)}`,
      );
      return false;
    }
  }

  /**
   * 审批请求公告（M3 阶段 1）：topic 内 type='system' 消息——「座位 X 请求审批：<tool 摘要>」。
   * - 通道复用 sendSystemMessage（与失败回执/安全阀公告同源：系统 actor + 私密桌 join）
   * - 节流：per-seat PERMISSION_ANNOUNCE_THROTTLE_MS（5 分钟）内不重复（内存表；重启
   *   清零可接受——公告是提示不是账本，审批行已落库，web 角标/列表是权威展示）
   * - 递归防护：公告是 system 消息 → 「system 不唤醒」天然免疫（RT-ROUTE-1）
   * - fire-and-forget + 内部自吞（与 emitReceipt 同精神）
   * @param seat 发起请求的座位（label 进文案）
   * @param tool 工具摘要（ToolBrief；真机 ACP 形状 {title, toolCallId, content} 无 name 字段——
   *   title 优先（人类可读工具名），回退 name，再截断 JSON 兜底防刷屏）
   */
  private async announcePermissionRequest(seat: RoundtableSeat, tool: ToolBrief): Promise<void> {
    const key = `${seat.id}:request`;
    const now = Date.now();
    if (now - (this.permissionAnnounceThrottle.get(key) ?? 0) < PERMISSION_ANNOUNCE_THROTTLE_MS) {
      return;
    }
    this.permissionAnnounceThrottle.set(key, now);
    // 摘要取值优先级：title（真机 ToolBrief {title, toolCallId, content} 的人类可读工具名，
    // 公告正文不能变成原始 JSON dump）→ name（老形状兼容）→ 截断 JSON 兜底（防刷屏）
    const toolName =
      typeof tool?.title === 'string' && tool.title.length > 0
        ? tool.title
        : typeof tool?.name === 'string' && tool.name.length > 0
          ? tool.name
          : JSON.stringify(tool).slice(0, 120);
    try {
      await this.sendSystemMessage(seat.topicId, `座位 ${seat.label} 请求审批：${toolName}`);
      this.logger.log(
        `审批公告: seat ${seat.id} tool ${toolName}（节流 ${PERMISSION_ANNOUNCE_THROTTLE_MS}ms）`,
      );
    } catch (err) {
      this.logger.error(`审批公告落库失败 seat ${seat.id}: ${String(err)}`);
    }
  }

  /**
   * 人类裁决（POST /roundtable/permission-requests/:id/verdict，M3 阶段 1）
   *
   * 权限模型（§7 + M3 拍板）：仅人类（JWT）可裁决，agent API Key 一律 403（裁决 =
   * 治理动作，人类特权）；裁决者必须为 topic 参与者（ensureCan 'write'，非参与者 403）。
   * 状态机（铁律 #18）：仅 pending 可裁决——非 pending 409（重复裁决/已作废/已孤儿）；
   * optionId 必须 ∈ 请求 options（按 id/optionId 双键匹配，与 runner 侧 handleVerdict
   * 同规）——非法 422。状态映射：选中 option 的 kind === 'reject' → rejected，否则
   * approved（approve_once/approve_always 都是放行，二者差异仅对 runner 会话内生效）。
   * 落库 → seat.permission_verdict 下行（requestId + optionId，seq=0——对账游标仅适用
   * inject，与 seat.assign 同规）→ topic 公告（「<人> 已批准/拒绝了座位 X 的审批请求」，
   * 不节流——同一请求只能裁决一次，天然无刷屏）。
   * 座位离线时 sendToRunner 返回 false：只记 warning 不报错（审批永不过期，状态在库；
   * runner 重启后 permissions Map 清空，verdict 会被 runner 忽略——已知孤儿场景，
   * 由断连作废 orphanPendingRequests 兜底，见 onRunnerOffline）。
   * @param id 审批请求行 id
   * @param dto Controller 已做格式校验的 DTO（optionId）
   * @param actor 当前统一身份（人类）
   * @returns 落库后的审批请求行（status/verdictOptionId/resolvedBy/resolvedAt 已更新）
   * @throws ForbiddenException agent 或非参与者；NotFoundException 请求不存在；
   *   ConflictException 非 pending；UnprocessableEntityException optionId 非法
   */
  async verdictPermissionRequest(
    id: string,
    dto: VerdictPermissionRequestDto,
    actor: UnifiedActor,
  ): Promise<RoundtablePermissionRequest> {
    // agent 禁止裁决（403 优先于一切资源校验——不向 agent 泄露请求存在性，§7）
    if (actor.type !== ActorType.HUMAN) {
      throw new ForbiddenException({
        message: 'Only human users can resolve permission requests',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    const request = await this.permReqRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException({
        message: 'Permission request not found',
        code: ErrorCode.ROUNDTABLE_PERMISSION_REQUEST_NOT_FOUND,
      });
    }
    if (request.status !== 'pending') {
      throw new ConflictException({
        message: `Permission request already resolved (status=${request.status})`,
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }
    // 裁决者必须为 topic 参与者（ensureCan 'write'：非参与者 403，与座位管理同规）；
    // v1.46 起叠加 ensureTopicCreatorOrAdmin 收口（write 已放宽给 editor，裁决保持 creator-only）
    const topic = await this.topicService.findById(request.topicId);
    await this.permService.ensureCan(topic, actor, 'write');
    await this.ensureTopicCreatorOrAdmin(topic, actor);
    // optionId 权威校验源 = 请求 options（铁律 #20 契约即设计；options 形状未冻结，
    // 防御性按 optionId/id 双键匹配——runner 侧同规，见 runner-core handleVerdict）
    const option = (request.options ?? []).find(
      (o: Record<string, unknown>) =>
        String(o?.optionId) === dto.optionId || String(o?.id) === dto.optionId,
    );
    if (!option) {
      throw new UnprocessableEntityException({
        message: `optionId ${dto.optionId} not found in request options`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const status = String(option.kind ?? '') === 'reject' ? 'rejected' : 'approved';
    request.status = status;
    request.verdictOptionId = dto.optionId;
    request.resolvedBy = actor.id;
    request.resolvedAt = new Date();
    const saved = await this.permReqRepo.save(request);
    // 下行裁决（fire-and-forget 语义：座位离线只记 warning 不报错——审批状态已在库，
    // 人类无需重试；runner 重启孤儿由断连作废兜底）
    const seat = await this.seatRepo.findOne({ where: { id: request.seatId } });
    if (seat?.runnerId) {
      const verdictPayload: PermissionVerdictPayload = {
        requestId: request.requestId,
        optionId: dto.optionId,
      };
      const ok = this.registry.sendToRunner(
        seat.runnerId,
        buildEnvelope(
          'seat.permission_verdict',
          verdictPayload as unknown as Record<string, unknown>,
          {
            seatId: seat.id,
            seq: 0, // 对账游标仅适用于 inject；verdict 无重放语义，与 seat.assign 同规
          },
        ),
      );
      if (!ok) {
        this.logger.warn(
          `verdict 下行失败（runner/座位离线）seat ${seat.id} requestId ${request.requestId}（审批状态已落库）`,
        );
      }
    } else {
      this.logger.warn(
        `verdict: seat ${request.seatId} 未绑定 runner，下行跳过（审批状态已落库；runner 重启后孤儿场景由断连作废兜底）`,
      );
    }
    // topic 公告（fire-and-forget + 内部自吞；裁决公告天然 once-per-request，不节流）
    const actorName = actor.name?.trim() ? actor.name : `user-${actor.id.slice(0, 8)}`;
    void this.announceVerdict(request.topicId, seat?.label ?? request.seatId, status, actorName);
    return saved;
  }

  /**
   * 裁决公告（M3 阶段 1）：topic 内 type='system' 消息——「<人> 已批准/拒绝了座位 X 的
   * 审批请求」。通道复用 sendSystemMessage；fire-and-forget + 内部自吞（公告失败不影响
   * 裁决主流程）；公告是 system 消息 → 「system 不唤醒」天然免疫递归（RT-ROUTE-1）。
   * @param topicId 目标 topic
   * @param seatLabel 座位展示名（座位行缺失时回退 seatId）
   * @param status 裁决结果（approved/rejected，进文案「批准/拒绝」）
   * @param actorName 裁决者展示名
   */
  private async announceVerdict(
    topicId: string,
    seatLabel: string,
    status: 'approved' | 'rejected',
    actorName: string,
  ): Promise<void> {
    const verdictText = status === 'approved' ? '已批准' : '已拒绝';
    try {
      await this.sendSystemMessage(
        topicId,
        `${actorName} ${verdictText}了座位 ${seatLabel} 的审批请求`,
      );
      this.logger.log(`裁决公告: topic ${topicId} seat ${seatLabel} ${verdictText}`);
    } catch (err) {
      this.logger.error(`裁决公告落库失败 topic ${topicId}: ${String(err)}`);
    }
  }

  /**
   * 审批请求列表（GET /roundtable/permission-requests?topicId=&status=，M3 阶段 1，
   * 阶段 2 web UI 数据源）：按 topic 归属查询（必填 topicId），status 可选过滤。
   * topic 存在性 + read 权限（ensureCan 'read' 失败统一 404，安全 through obscurity）；
   * 分页 page/pageSize（缺省 1/20，pageSize ≤ 100，DTO 已校验）。
   * @param query Controller 已做格式校验的查询 DTO
   * @param actor 当前统一身份
   * @returns 标准分页响应（PaginatedResponse<RoundtablePermissionRequest>，按创建时间倒序）
   */
  async listPermissionRequests(
    query: ListPermissionRequestsQueryDto,
    actor: UnifiedActor,
  ): Promise<PaginatedResponse<RoundtablePermissionRequest>> {
    const topic = await this.topicService.findById(query.topicId);
    await this.permService.ensureCan(topic, actor, 'read');
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: FindOptionsWhere<RoundtablePermissionRequest> = { topicId: query.topicId };
    if (query.status) where.status = query.status;
    const [items, total] = await this.permReqRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const totalPages = Math.ceil(total / pageSize);
    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * 当前用户可见的 pending 审批总数（GET /roundtable/permission-requests/pending-count，
   * M3 阶段 1，web 全局待办角标数据源）：按「参与者可见」口径——actor 作为 active
   * 参与者（topic_participants 表，与 isActiveParticipant 同源）的全部 topic 内
   * pending 计数。读操作仅返回计数，任何身份可查（agent 可见 = 自己参与桌的挂起数）。
   * @param actor 当前统一身份
   * @returns pending 审批总数
   */
  async pendingPermissionRequestCount(actor: UnifiedActor): Promise<number> {
    const participations = await this.participantRepo.find({
      where: { participantId: actor.id, status: ParticipantStatus.ACTIVE },
    });
    if (participations.length === 0) return 0;
    return this.permReqRepo.count({
      where: { topicId: In(participations.map((p) => p.topicId)), status: 'pending' },
    });
  }

  // ─────────────────────────── 注入触发器（listener 三铁规） ───────────────────────────

  /**
   * 事件总线注入触发器（M1 计划决策 2：EventService.create 末尾 emit('event.created')）
   *
   * listener 三铁规：① async 派发（@OnEvent {async:true}，不阻塞 sendMessage 热路径）；
   * ② 异常自吞（try/catch 只记日志，注入失败绝不让消息落库响应变 500）；③ 按 messageId
   * 自查消息存在性（免疫事务回滚产生的幻影事件）。
   *
   * 过滤链（M2 阶段 3/4 全量接入，r5 §6 / R1 / R5 / r7）：NEW_MESSAGE → 消息存在 → active 座位 →
   * 零座位短路（普通 topic 零开销，不读 topic）→ 有座位才读 topic.settings 解析
   * wakePolicy（PK 读不缓存：路由判定走读一致性，且仅圆桌 topic 每条消息发生一次）→
   * 安全阀门闸（r7：人类消息先复位再走路由——清零全部 active 座位计数、paused 则复位
   * 公告；非人类消息先算 paused——暂停中全部座位只 park 不唤醒、不发回执）→
   * 逐座位：回声抑制（§6 按 seatLabel 精确过滤，座位自己的发言不回灌给自己）→ 唤醒判定
   * （mention = @label token 精确 / @all，broadcast = 全部；type='system' 任何模式不唤醒
   * ——防 回执→唤醒→回复→回执 循环，M2 阶段 3 新定规则）→ 收集（唤醒+可达 → 窗口/
   * 直通封批；其余 → parked 躺着）→ 失败回执（被唤醒但不可达：未绑 runner 或 runner
   * 离线，决策 #6）。
   */
  @OnEvent('event.created', { async: true })
  async onMessageCreated(event: Event): Promise<void> {
    try {
      if (event.eventType !== EventType.NEW_MESSAGE || !event.topicId) return;
      const message = await this.messageRepo.findOne({
        where: { id: event.resourceId, topicId: event.topicId },
      });
      if (!message) return; // 铁规③：查不到 = 事务回滚幻影，直接免疫
      const seats = await this.seatRepo.find({
        where: { topicId: event.topicId, status: 'active' },
      });
      if (seats.length === 0) return; // 零座位短路：普通 topic 零开销（不读 topic）
      // 有座位才读 topic（PK 读，无需缓存：注入路径低频、走读一致性即可）
      const topic = await this.topicRepo.findOne({ where: { id: event.topicId } });
      const wakePolicy = this.resolveWakePolicy(topic);
      const isSystem = message.type === MessageType.SYSTEM;

      // ── 圆桌安全阀门闸（M2 阶段 4，r7；座位数组已在手，零额外座位查询）──
      // 人类消息先复位再走路由（R2）；非人类消息先算 paused——暂停中全部座位只 park
      // 不唤醒、不发失败回执（gate 提前 return 短路下方回执触发点 A/B）。已在单飞行
      // FIFO 队列的存量注入照发（暂停只闸新唤醒——complete 释放仍照常 flushPending）。
      const threshold = this.maxRoundsWithoutHuman(topic);
      const isHuman = await this.isHumanSender(message);
      if (isHuman) {
        const wasPaused = this.isPaused(seats, threshold);
        await this.resetValveCounts(seats);
        if (wasPaused) {
          // 复位公告：paused → 人类消息 → 一条「安全阀已复位」；未 paused 不发
          void this.emitValveAnnouncement(event.topicId, 'reset');
        }
        // 复位不附带唤醒：本条消息继续走正常路由（@谁唤醒谁是路由的事，R1 人机一致）
      } else if (this.isPaused(seats, threshold)) {
        for (const seat of seats) {
          if (message.metadata?.seatLabel === seat.label) continue; // 自激防护（回声抑制）
          // wake=false + reachable=false：只入 parked 不起定时器（RT-ROUTE-2 同规——
          // 暂停等效「唤醒不可达」，parked 由人类复位后的下次唤醒封批并入）
          await this.collectForSeat(seat, message, false, false);
        }
        return;
      }

      // mention 模式对正文剥噪一次（代码块/inline code/引用行内的 @ 不算提及，R5）；
      // system 消息无需剥噪——任何模式都不唤醒，直接短路到 parked
      const mentionText =
        wakePolicy === 'mention' && !isSystem ? stripMentionNoise(message.content ?? '') : null;
      // @all 群体唤醒冷却闸（M3 阶段 3，r13）：mention 模式含 @all 的消息受
      // per-topic ALL_WAKE_COOLDOWN_MS（60s）冷却——冷却内 @all 不再触发群体唤醒
      // （消息正常落库、正常进攒批可见集：下方 collectForSeat 以 wake=false 收进
      // parked，只是不唤醒）+ 冷却提示（节流同周期）。**token 级抑制**（终审修订）：
      // 冷却只闸 @all 广播项——同一条消息里的 @label token 仍正常唤醒对应座位
      // （decideWake 收到 allWakeSuppressed 后仅屏蔽 hasAllMention 项，@label 项
      // 照常）；broadcast 模式无 @all 概念（decideWake 恒真，不闸）。
      const allMention = mentionText !== null && hasAllMention(mentionText);
      const allWakeSuppressed = allMention && !this.tryAllWake(event.topicId);
      if (allWakeSuppressed) {
        void this.emitAllWakeHint(event.topicId);
      }
      for (const seat of seats) {
        if (message.metadata?.seatLabel === seat.label) continue; // 自激防护（回声抑制）
        const wake = this.decideWake(seat, wakePolicy, isSystem, mentionText, allWakeSuppressed);
        const reachable = this.isSeatReachable(seat);
        await this.collectForSeat(seat, message, wake, reachable);
        // 失败回执触发点 A（决策 #6）：被唤醒但不可达 → system 回执（节流内），
        // 消息本身仍 parked（上线后 reconcile 重建 / 下次唤醒封批送达，不丢）
        if (wake && !reachable) {
          void this.emitReceipt(seat, 'offline');
        }
      }
    } catch (err) {
      // 铁规②：异常自吞只记日志（EventEmitter2 v6 同步冒泡实测，见 event.service.ts 挂点注释）
      this.logger.error(`onMessageCreated 注入触发失败（已自吞）: ${String(err)}`);
    }
  }

  // ─────────────────────────── 唤醒路由（M2 阶段 3，R1 人机一致 / R5 token 精确） ───────────────────────────

  /**
   * 解析 topic 唤醒策略（r5 §6 定稿）：显式 settings.wakePolicy 值优先；缺省 →
   * kind='roundtable' 时 'mention'（新桌默认省钱安全），否则 'broadcast'
   * （=M1 行为，向后兼容存量 normal 桌——存量 dogfood topic 是 kind='normal' 且无
   * wakePolicy 键，按 broadcast 解析保持 M1 全唤醒语义）。
   * @param topic 已读取的 topic 行（null = 查询未命中，防御按 normal 处理）
   */
  private resolveWakePolicy(
    topic: Pick<Topic, 'kind' | 'settings'> | null,
  ): 'mention' | 'broadcast' {
    const v = topic?.settings?.wakePolicy;
    if (v === 'mention' || v === 'broadcast') return v;
    return topic?.kind === 'roundtable' ? 'mention' : 'broadcast';
  }

  /**
   * 解析 topic 安全阀阈值（r7）：显式整数 0~1000 生效（0 = 关闭）；缺省/非整数/超界 →
   * DEFAULT_MAX_ROUNDS_WITHOUT_HUMAN（8）。防御性解析：DTO 已做 whitelist 校验，此层
   * 兜底存量脏数据与越权直写 settings 的场景（铁律 #21 双层校验精神）。
   * @param topic 已读取的 topic 行（null = 查询未命中，防御按缺省）
   */
  private maxRoundsWithoutHuman(topic: Pick<Topic, 'settings'> | null): number {
    const v = topic?.settings?.maxRoundsWithoutHuman;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000
      ? v
      : DEFAULT_MAX_ROUNDS_WITHOUT_HUMAN;
  }

  /**
   * 派生暂停态判定（r7：无标志位，不落库——计数是真相，暂停由计数推导，避免双写漂移）：
   * 任一 active 座位 roundsWithoutHuman ≥ 阈值即暂停。阈值 0 = 关闭安全阀 → 永不暂停
   * （dogfood 对照：计数照常推进但熔断/公告/门闸全部失效）。
   * @param seats 已查询的 active 座位数组（onMessageCreated 手里现成，零额外查询）
   * @param threshold 解析后的阈值（maxRoundsWithoutHuman 输出）
   */
  private isPaused(seats: RoundtableSeat[], threshold: number): boolean {
    if (threshold <= 0) return false;
    return seats.some((s) => (s.state?.roundsWithoutHuman ?? 0) >= threshold);
  }

  /**
   * 人类消息判定（安全阀复位触发源，r7）——查 actors 表按 senderId 取 type。
   * 为何不读 Message.senderType / Event.actorType：两者都是**内存字段**（DB 列已历史移除，
   * TypeORM `repo.create()` 只拷贝列属性 nonVirtualColumns，repo 查询路径同样不填充——
   * 实测 topic.service buildMessageResponse 也走显式参数而非实体字段）。actor 表是唯一
   * 可靠来源，与 projectMessage 投影同源（一次 PK 读，仅圆桌 topic 有 active 座位时发生）。
   * @param message 已确认存在性的消息（listener 铁规③之后）
   */
  private async isHumanSender(message: Message): Promise<boolean> {
    const actor = await this.actorRepo.findOne({ where: { id: message.senderId } });
    return actor?.type === ActorType.HUMAN;
  }

  /**
   * R2 复位：topic 内人类消息 → 全部 active 座位的 roundsWithoutHuman 清零。
   * 只 save 计数 >0 的行（计数为 0/缺省的行不写——避免无意义 DB 写；state 由注入
   * 管线独占写 §5，与计数落库同规）。复位**不附带唤醒**：唤醒与否是路由层的事
   * （@谁唤醒谁，R1 人机一致），本方法只做熔断器维度清零。
   * 失败不抛出：复位失败不阻断消息路由（下一条人类消息会再复位），记日志便于排障。
   */
  private async resetValveCounts(seats: RoundtableSeat[]): Promise<void> {
    const dirty = seats.filter((s) => (s.state?.roundsWithoutHuman ?? 0) > 0);
    if (dirty.length === 0) return;
    for (const seat of dirty) {
      seat.state = { ...seat.state, roundsWithoutHuman: 0 };
      await this.seatRepo.save(seat).catch((err: unknown) => {
        this.logger.error(`安全阀复位落库失败 seat ${seat.id}: ${String(err)}`);
      });
    }
  }

  /**
   * 唤醒判定（R1：人机一致，不按 senderType 特判——人类/agent/主脑同规）：
   * - type='system'：任何模式不唤醒（M2 阶段 3 新定规则：防 回执→唤醒→回复→回执
   *   循环；只入可见集 parked，下次派发可见）——优先级最高
   * - mention：@座位label（token 精确，R5）或 @all（保留令牌，唤醒全部 active 座位）
   * - broadcast：任何非 system 消息唤醒（= M1 行为）
   * - @all 冷却（M3 阶段 3，r13，token 级抑制）：allWakeSuppressed=true 时仅屏蔽
   *   hasAllMention 项（@all 不触发群体唤醒），同消息内的 @label token 仍按
   *   findMentionedLabels 正常唤醒——冷却闸粒度是 token 不是消息（终审修订）
   * 注：唤醒只决定「触发派发 vs 继续躺着」；被动可见性两种模式相同（§6）。
   * @param seat 目标座位（label 参与 @ 匹配）
   * @param wakePolicy topic 唤醒策略（resolveWakePolicy 输出）
   * @param isSystem 消息是否为 system 类型
   * @param mentionText mention 模式已剥噪正文（非 mention 模式传 null）
   * @param allWakeSuppressed @all 群体唤醒是否处于冷却抑制态（onMessageCreated
   *   由 tryAllWake 判定；broadcast 模式恒 false 不影响恒真短路）
   */
  private decideWake(
    seat: RoundtableSeat,
    wakePolicy: 'mention' | 'broadcast',
    isSystem: boolean,
    mentionText: string | null,
    allWakeSuppressed: boolean,
  ): boolean {
    if (isSystem) return false;
    if (wakePolicy === 'broadcast') return true;
    // mention 模式：mentionText 必非 null（onMessageCreated 仅在 mention 模式且非
    // system 时计算；此处防御性判空，逻辑不可达）
    if (mentionText === null) return false;
    // token 级抑制：冷却只闸 @all 广播项，@label 定向项不受影响（r13 终审修订）
    return (
      (!allWakeSuppressed && hasAllMention(mentionText)) ||
      findMentionedLabels(mentionText, [seat.label]).size > 0
    );
  }

  /**
   * 座位当前是否可注入（触发点 A 判定）：已绑 runner 且 runner 在线。
   * registry.isRunnerOnline 与 sendToRunner 同数据源同判据（在线表 + socket OPEN）；
   * DB status='offline' 的行已被 seats 查询（status='active'）排除，此处兜「runner
   * 已断连但 DB 状态尚未刷新/竞态」的窗口。
   */
  private isSeatReachable(seat: RoundtableSeat): boolean {
    return seat.runnerId !== null && this.registry.isRunnerOnline(seat.runnerId);
  }

  // ─────────────────────────── per-seat 攒批收集器（M2 阶段 2/3） ───────────────────────────

  /**
   * 消息 → 目标座位收集入口（数据面 + 唤醒路由，r5 §6 / R3 / R1）：
   * - 唤醒 + 可达：batchWindowMs>0 → 加入开着的批（无则开新批 + 窗口定时器）；
   *   =0（直通）→ 立即封批派发（批 = parked + 本条，「未 @ 不唤醒但下次派发可见」）；
   * - 其余（非唤醒 / 唤醒但不可达）：推入 parked（去重）不起定时器——「继续躺着」，
   *   下次任一唤醒消息封批时并入；重启由 rebuildUndispatched 强制封批兜底。
   * 唤醒但不可达（未绑 runner / runner 离线）只 park 不开窗（RT-ROUTE-2）：若开窗，
   *   到期封批 enqueueBatch 对未绑座位会丢批；park 后由「上线后下次唤醒封批」或
   *   reconcile 重建送达（触发点 A 回执已提示「已暂存」）。
   * @param seat 目标座位
   * @param message 待收集消息
   * @param wake 唤醒判定结果（mention @label/@all 命中或 broadcast；system 恒 false）
   * @param reachable 座位当前可注入（已绑 runner 且 runner 在线）
   */
  private async collectForSeat(
    seat: RoundtableSeat,
    message: Message,
    wake: boolean,
    reachable: boolean,
  ): Promise<void> {
    const windowMs = this.batchWindowMs(seat);
    const collector = this.getCollector(seat.id);
    if (windowMs === 0) {
      // 直通（M1 行为）：
      // - 唤醒+可达且无 parked：M1 原路径（消息对象在手，零额外查询，热路径）
      // - 唤醒+可达但有 parked（此前非唤醒消息躺着）：并入 parked 后整体封批（不丢）
      // - 其余（非唤醒 / 唤醒但不可达）：仅入 parked，等下次唤醒封批或 reconcile 重建
      if (wake && reachable) {
        if (collector.parked.length === 0) {
          await this.enqueuePending(seat, [message], 0);
        } else {
          this.pushParked(collector, message.id);
          // 直通路径 await 封批（与 M1 热路径同序：本条消息派发完成才返回）；
          // 定时器/offline 路径保持 fire-and-forget（见 sealBatch 返回语义）
          await this.sealBatch(seat.id);
        }
      } else {
        this.pushParked(collector, message.id);
      }
      return;
    }
    if (wake && reachable) {
      if (collector.window && !collector.window.sealed) {
        collector.window.messageIds.push(message.id);
        return;
      }
      // 无开着的批（首次唤醒到达 / 上一批已封）：开新批 + 启动窗口定时器
      collector.window = {
        messageIds: [message.id],
        sealed: false,
        // 定时器到期路径 fire-and-forget（注入失败由 enqueueBatch 自吞，不炸定时器回调）
        timer: setTimeout(() => void this.sealBatch(seat.id), windowMs),
      };
    } else {
      this.pushParked(collector, message.id);
    }
  }

  /** 取/建座位收集器（懒初始化） */
  private getCollector(seatId: string): BatchCollector {
    let collector = this.batchCollectors.get(seatId);
    if (!collector) {
      collector = { parked: [], window: null };
      this.batchCollectors.set(seatId, collector);
    }
    return collector;
  }

  /**
   * 推入 parked（去重防御：正常路径事件一次一条，同 id 二次到达不重复躺——防御即可；
   * O(n) 可接受：parked 有界于两次唤醒之间的消息量，阶段 5 补硬帽）
   */
  private pushParked(collector: BatchCollector, messageId: string): void {
    if (!collector.parked.includes(messageId)) {
      collector.parked.push(messageId);
    }
  }

  /**
   * 封批：batch = parked + window.messageIds 合并去重 → 清空收集器（出表）→ 有消息则
   * 作为一个 PendingInject 入单飞行 FIFO。封批即冻结（RT-BATCH-1）：该批不再进新消息，
   * 新消息到达时开新批——runner 侧处理旧批期间若混入新消息，turn 边界与 seq 对账全乱。
   * 幂等：offline 清理与定时器到期并发时，出表保证只封一次（第二次找不到条目直接返回）。
   * 语义注记（r6）：parked 在此并入批——「未 @ 不唤醒但下次派发可见」（§6 被动可见性）；
   * 重启重建（rebuildUndispatched）对 parked 一律按强制封批处理（重启即到期，宁可多
   * 唤醒一次不丢消息，见该方法注释）。
   * 返回语义：无消息返回 void；有消息返回 enqueueBatch 的 Promise——调用方决定
   * await（直通路径保热路径顺序）或 fire-and-forget（定时器/offline 路径，注入失败
   * 由 enqueueBatch 内部自吞，绝不影响定时器/断连流程）。
   */
  private sealBatch(seatId: string): Promise<void> | void {
    const collector = this.batchCollectors.get(seatId);
    if (!collector) return;
    const window = collector.window;
    const messageIds = [...new Set([...collector.parked, ...(window?.messageIds ?? [])])];
    if (window) {
      window.sealed = true;
      clearTimeout(window.timer); // 到期回调也走这里，防御性清理（RT-BATCH-2）
    }
    this.batchCollectors.delete(seatId); // 幂等：并发二次封批（offline+定时器）找不到条目
    if (messageIds.length === 0) return;
    return this.enqueueBatch(seatId, messageIds);
  }

  /**
   * 封批入队：按 id 查消息原文（黑板即真相）→ ts 升序 → 分配 seq（新注入）→
   * 装配 body（windowMs = 座位配置值）→ 入单飞行 FIFO → flushPending。
   * 座位消失/解绑时丢弃该批（M1 无删除 API，理论不可达，防御分支）。
   */
  private async enqueueBatch(seatId: string, messageIds: string[]): Promise<void> {
    try {
      const seat = await this.seatRepo.findOne({ where: { id: seatId } });
      if (!seat || !seat.runnerId) {
        this.logger.warn(`enqueueBatch: seat ${seatId} 不可派发，丢弃封批 ${messageIds.length} 条`);
        return;
      }
      const messages = await this.messageRepo.find({ where: { id: In(messageIds) } });
      if (messages.length === 0) return; // 全幻影（收集时已查过存在性，理论不可达）
      if (messages.length !== messageIds.length) {
        this.logger.warn(
          `enqueueBatch: seat ${seatId} 批内消息部分缺失（${messages.length}/${messageIds.length}）`,
        );
      }
      await this.enqueuePending(seat, messages, this.batchWindowMs(seat));
    } catch (err) {
      // 封批入队失败不炸定时器回调（与 listener 铁规②同精神：注入失败自吞只记日志）
      this.logger.error(`enqueueBatch: seat ${seatId} 封批入队失败: ${String(err)}`);
    }
  }

  /** 读座位攒批窗口配置（0 = 直通；缺省 DEFAULT_BATCH_WINDOW_MS，createSeat 已落库） */
  private batchWindowMs(seat: RoundtableSeat): number {
    const v = seat.config?.batchWindowMs;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : DEFAULT_BATCH_WINDOW_MS;
  }

  /**
   * 新注入入队（per-seat 单飞行 FIFO，M2 阶段 2 泛化入口）：分配下行 seq → 装配 body
   * → 入队 → 尝试派发。直通（windowMs=0 单条）、封批（多条）、重启重建共用。
   * 注意：seq 在入队时分配（保证排队中的多条互不冲突），lastInjectSeq/recentInjects
   * 在真正发送成功后才落库（发送失败的队头保留，重连后 flush 重试；已发送未确认的
   * 由 hello 对账重放兜底）。
   * @param seat 目标座位（label/coordinator/config 决定装配）
   * @param messages 待注入消息（内部按 createdAt 升序，保证协议 batch.messages ts 升序）
   * @param windowMs 攒批窗口值写入 body（0 = 直通；>0 = 座位配置值，r5 §6）
   */
  private async enqueuePending(
    seat: RoundtableSeat,
    messages: Message[],
    windowMs: number,
  ): Promise<void> {
    const sorted = [...messages].sort(
      (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );
    const seq = this.assignNextSeq(seat);
    const body = await this.buildInjectBody(seat, sorted, windowMs);
    const flight = this.getFlight(seat.id);
    flight.queue.push({
      seq,
      payload: { ruleHeader: this.buildRuleHeader(seat), body },
      messageIds: sorted.map((m) => m.id),
    });
    // 失败回执触发点 B（决策 #6）：busy 排队超限 → system 回执（节流内）；消息保留
    // 队列不丢弃（「响应可能延迟」是提示不是丢弃；无界硬帽是阶段 5 的活，本阶段只做回执）
    if (flight.queue.length > QUEUE_RECEIPT_THRESHOLD) {
      void this.emitReceipt(seat, 'queue_backlog');
    }
    await this.flushPending(seat.id);
  }

  /**
   * 单飞行派发：busy 不派发；队列头在发送成功后才出队（失败保持队头等重连）；
   * 发送成功 → busy=true + 落库（last_inject_seq / recentInjects ring）。
   * 由注入触发器、hello 对账、message_complete 释放三处触发，幂等。
   */
  async flushPending(seatId: string): Promise<void> {
    const flight = this.flights.get(seatId);
    if (!flight || flight.busy || flight.queue.length === 0) return;
    const job = flight.queue[0];
    const seat = await this.seatRepo.findOne({ where: { id: seatId } });
    if (!seat || !seat.runnerId) {
      // 座位被删/解绑：丢弃队头（防御分支；M1 无座位删除 API，理论不可达）
      flight.queue.shift();
      this.logger.warn(`flushPending: seat ${seatId} 不可派发（缺失或未绑定），丢弃队头`);
      return;
    }
    const envelope = buildEnvelope(
      'seat.inject',
      job.payload as unknown as Record<string, unknown>,
      { seatId, seq: job.seq },
    );
    const ok = this.registry.sendToRunner(seat.runnerId, envelope);
    if (!ok) {
      // runner 离线：保持队头，重连后 bindSeats → reconcile → flushPending 自动重试
      this.logger.debug(`flushPending: seat ${seatId} runner 离线，队头保留等待重连`);
      return;
    }
    flight.queue.shift();
    flight.busy = true;
    await this.persistDispatch(seat, job);
  }

  /**
   * 落库下行游标与 ring buffer（发送成功后才调用）：
   * last_inject_seq = seq；state.recentInjects push {seq, messageIds}，cap 100 淘汰最旧。
   * 重放场景（hello 对账重建的原 seq ≤ 当前游标）不推进游标、不重复记录 ring——
   * 原 seq 已落过库，黑板即真相（§4）。
   * state 列由注入管线独占写（§5 config/state 分列，避免 read-modify-write 竞争）。
   */
  private async persistDispatch(seat: RoundtableSeat, job: PendingInject): Promise<void> {
    const currentSeq = parseInt(seat.lastInjectSeq ?? '0', 10);
    if (job.seq <= currentSeq) {
      return; // 重放：游标/ring 已含该 seq，只重发不重记
    }
    const ring = Array.isArray(seat.state?.recentInjects)
      ? [...(seat.state.recentInjects as Array<{ seq: number; messageIds: string[] }>)]
      : [];
    ring.push({ seq: job.seq, messageIds: job.messageIds });
    if (ring.length > RING_BUFFER_CAP) ring.splice(0, ring.length - RING_BUFFER_CAP);
    seat.state = { ...seat.state, recentInjects: ring };
    seat.lastInjectSeq = String(job.seq);
    await this.seatRepo.save(seat).catch((err: unknown) => {
      // 落库失败不阻断已发送的注入；重连对账时会按旧游标重放该条 → 可能重复一轮
      //（极端故障窗口，M1 接受，记日志便于排障）
      this.logger.error(`persistDispatch: seat ${seat.id} seq ${job.seq} 落库失败: ${String(err)}`);
    });
  }

  /**
   * 分配下行注入 seq（座位级独立递增，§4 双向各自编号）。
   * 游标缓存懒初始化：首次取 seat.lastInjectSeq + 1，此后内存递增（单进程安全）。
   */
  private assignNextSeq(seat: RoundtableSeat): number {
    const base = this.nextSeqCache.get(seat.id) ?? parseInt(seat.lastInjectSeq ?? '0', 10) + 1;
    this.nextSeqCache.set(seat.id, base + 1);
    return base;
  }

  // ─────────────────────────── 注入装配（规则头 + r3 冻结消息体） ───────────────────────────

  /**
   * 圆桌规则头装配（§6：chamber 统一装配，runner 与 prompt 作者禁止改写；版本化
   * ruleHeaderVersion=2，演进时全平台一致升级——v2（M2 阶段 3）= 新增 @all 显式广播
   * 令牌说明（R1 用户拍板），v1 = M1 初版）。ACP 无 system prompt 注入通道（§8 实测），
   * 规则头只能随每次 inject 重复进入上下文——保持精简。
   * 内容：座位身份（label）、沉默协议（§4 上行约定哨兵）、@提及路由（含 @all 广播
   * 令牌）、攒批消息体语义（按 from+id 逐条引用）、证据纪律；主脑座位追加主脑版加成
   * （§6：调度指令必须 topic 明说可观测）。
   * @param seat 座位（label/coordinator 决定规则头内容）
   * @returns markdown 规则头文本
   */
  buildRuleHeader(seat: { label: string; coordinator: boolean }): string {
    const lines = [
      `# 圆桌规则头（version ${RULE_HEADER_VERSION}）`,
      `你的座位标识（seatLabel）是「${seat.label}」。以下是你在圆桌中必须遵守的规则。`,
      '',
      '## 身份与路由',
      `- 你的座位标识：${seat.label}；其他参与者用 @${seat.label} 提及你。`,
      `- 需要指定接收者时，在回复正文中使用 @座位label（如 @${seat.label}）。`,
      '- @all 唤醒全部座位，慎用（mention 模式下 @all 是显式广播令牌，人机皆可用）。',
      ...(seat.coordinator
        ? [
            '- 你是**主脑座位**：可发起调度指令；所有调度指令必须写成 topic 中明确可观测的正文（人类与其他座位都能看到）。',
          ]
        : []),
      '',
      '## 沉默协议（重要）',
      `- 无事可说（没有新信息/无需回应）时，整个回复仅回 \`${SILENT_SENTINEL}\`，不得包含任何其他内容。`,
      '- 其余情况回复为自然 markdown 正文，不做 JSON 约束（正文里藏 JSON 不会触发沉默判定）。',
      '',
      '## 注入消息体说明',
      '- 每次注入携带 JSON 消息体：每条消息含 id 与 from（name/type/seatLabel/coordinator），按 from 与 id 逐条引用回应。',
      '- 座位发言的 from.seatLabel 标识其身份；你收不到自己的发言（回声抑制），体中出现的必然都是别人的。',
      '',
      '## 证据纪律',
      '- 报告测试/验证结果时必须粘贴原始输出，禁止仅转述结论。',
    ];
    return lines.join('\n');
  }

  /**
   * 装配注入消息体（r3 冻结 schema；M2 阶段 2：支持多消息 + windowMs 传座位配置值）
   * 投影来源：topic 标题（topicRepo）+ 发送者身份（actorRepo：type/displayName；
   * seatLabel 消息的展示名用座位 label——badge 语义）+ 消息原文（黑板即真相）。
   * @param seat 接收座位
   * @param messages 待投影消息（调用方保证按 ts 升序；enqueuePending 已排序）
   * @param windowMs 攒批窗口毫秒（0 = 直通；>0 = 座位配置值，写入 body.batch.windowMs）
   */
  private async buildInjectBody(
    seat: RoundtableSeat,
    messages: Message[],
    windowMs: number,
  ): Promise<InjectBody> {
    const topic = await this.topicRepo.findOne({ where: { id: seat.topicId } });
    return assembleInjectBody({
      topic: { id: seat.topicId, title: topic?.title ?? seat.topicId },
      seatLabel: seat.label,
      coordinator: seat.coordinator,
      windowMs,
      messages: await Promise.all(messages.map((m) => this.projectMessage(seat, m))),
    });
  }

  /**
   * 消息 → 注入体单条投影（InjectBodyMessage，r3 冻结字段）
   * - 座位发言（metadata.seatLabel 非空）：name = 对应座位 label，coordinator = 该座位标记
   * - 人类/系统发言：name = actor.displayName（缺省截断 id），coordinator = false
   * - from.type = actor.type（human/agent/system 与 r3 冻结枚举同值）
   */
  private async projectMessage(seat: RoundtableSeat, message: Message): Promise<InjectBodyMessage> {
    const seatLabel =
      typeof message.metadata?.seatLabel === 'string' ? message.metadata.seatLabel : null;
    // 发送者身份投影（actors 表：type + displayName；agent.id == actor.id，PK=FK 惯例）
    const actor = await this.actorRepo.findOne({ where: { id: message.senderId } });
    let name: string;
    let coordinator = false;
    if (seatLabel) {
      const labelSeat = await this.seatRepo.findOne({
        where: { topicId: seat.topicId, label: seatLabel },
      });
      name = labelSeat?.label ?? seatLabel;
      coordinator = labelSeat?.coordinator ?? false;
    } else {
      name = actor?.displayName ?? `sender-${message.senderId.slice(0, 8)}`;
    }
    const fromType: InjectFromType = (actor?.type as InjectFromType) ?? 'agent';
    return {
      id: message.id,
      from: { name, type: fromType, seatLabel, coordinator },
      ts: (message.createdAt ?? new Date()).toISOString(),
      replyTo: message.replyToId ?? null,
      content: message.content,
    };
  }

  // ─────────────────────────── 失败回执 + 安全阀公告（系统消息通道，决策 #6 / r7） ───────────────────────────

  /**
   * 系统消息落库通道（失败回执 emitReceipt / 安全阀公告 emitValveAnnouncement 共用，
   * r7 从 emitReceipt 泛化提取）：私密 topic 的 participant 检查会拒绝非成员发送 →
   * 首次落系统消息前保证系统 actor 为 active 参与者（复用 join 通道，幂等；仅非 active
   * 才 join，避免刷新 joinedAt 与重复 AGENT_JOINED 事件）→ TopicService.sendMessage
   * 落 type='system' 消息。调用方负责节流与异常自吞；本方法不包 try/catch——
   * 失败向上抛，由调用方按「提示性消息失败绝不影响注入管线」记日志。
   * @param topicId 目标 topic（须已确认存在）
   * @param content 系统消息正文
   */
  private async sendSystemMessage(topicId: string, content: string): Promise<void> {
    if (!(await this.topicService.isActiveParticipant(topicId, SYSTEM_ACTOR_ID))) {
      await this.topicService.join(topicId, SYSTEM_ACTOR_ID, ActorType.SYSTEM);
    }
    await this.topicService.sendMessage(topicId, SYSTEM_ACTOR_ID, ActorType.SYSTEM, {
      content,
      type: MessageType.SYSTEM,
      metadata: {},
    });
  }

  /**
   * 圆桌安全阀公告（r7，设计 §6）：'trip'（触发——某座位非沉默轮跨过阈值那一 turn，
   * RT-VALVE-1）/ 'reset'（复位——paused 态被人类消息复位时）。
   * - 通道复用 sendSystemMessage（与失败回执同源：系统 actor + 私密桌 join）
   * - 节流：per-topic per-kind VALVE_ANNOUNCE_THROTTLE_MS（5 分钟，内存表；重启清零
   *   可接受——公告是提示不是账本，重启后最多多一条）；多座位同窗口跨过阈值只一条
   * - 递归防护：公告自身是 system 消息 → 「system 不唤醒」天然免疫（RT-ROUTE-1）
   * - metadata 不带 seatLabel（不触发任何座位回声抑制特例）
   * - fire-and-forget + 内部自吞：公告失败只记日志（与 listener 铁规②同精神）
   * @param topicId 目标 topic
   * @param kind 公告类型：'trip'（触发）/ 'reset'（复位）
   * @param threshold 触发阈值（仅 trip 用，进文案）
   */
  private async emitValveAnnouncement(
    topicId: string,
    kind: 'trip' | 'reset',
    threshold?: number,
  ): Promise<void> {
    const key = `${topicId}:${kind}`;
    const now = Date.now();
    if (now - (this.valveAnnounceThrottle.get(key) ?? 0) < VALVE_ANNOUNCE_THROTTLE_MS) return;
    this.valveAnnounceThrottle.set(key, now);
    const text =
      kind === 'trip'
        ? `圆桌安全阀触发：座位间已连续 ${threshold} 轮无人类发言，本桌注入已暂停。人类发言即可恢复。`
        : '安全阀已复位，注入恢复';
    try {
      await this.sendSystemMessage(topicId, text);
      this.logger.log(`安全阀公告: topic ${topicId} kind ${kind}`);
    } catch (err) {
      this.logger.error(`安全阀公告落库失败 topic ${topicId} kind ${kind}: ${String(err)}`);
    }
  }

  /**
   * @all 群体唤醒冷却闸（M3 阶段 3，r13）：per-topic 60s（ALL_WAKE_COOLDOWN_MS）——
   * 距上次 @all 群体唤醒 < 冷却窗口 → 返回 false（本次 @all 不唤醒）；否则记录
   * 本次唤醒时间并返回 true。冷却状态存内存 Map：重启清零可接受（断网恢复后最多
   * 少冷却一次——唤醒是提示不是账本，无安全问题）。
   * @param topicId 目标 topic
   * @returns true = 允许本次 @all 群体唤醒（已记录时间戳）；false = 冷却中
   */
  private tryAllWake(topicId: string): boolean {
    const now = Date.now();
    if (now - (this.allWakeCooldown.get(topicId) ?? 0) < ALL_WAKE_COOLDOWN_MS) {
      return false;
    }
    this.allWakeCooldown.set(topicId, now);
    return true;
  }

  /**
   * @all 冷却提示（M3 阶段 3，r13）：topic 内 type='system' 消息——「@all 冷却中，
   * 稍后再试」。冷却内重复 @all 只提示一次（节流与冷却同周期 ALL_WAKE_COOLDOWN_MS，
   * 防刷屏）。通道复用 sendSystemMessage（系统 actor + 私密桌 join）；fire-and-forget
   * + 内部自吞；公告是 system 消息 → 「system 不唤醒」免疫递归（RT-ROUTE-1）。
   * @param topicId 目标 topic
   */
  private async emitAllWakeHint(topicId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.allWakeHintThrottle.get(topicId) ?? 0) < ALL_WAKE_COOLDOWN_MS) return;
    this.allWakeHintThrottle.set(topicId, now);
    try {
      await this.sendSystemMessage(topicId, '@all 冷却中，稍后再试');
      this.logger.log(`@all 冷却提示: topic ${topicId}`);
    } catch (err) {
      this.logger.error(`@all 冷却提示落库失败 topic ${topicId}: ${String(err)}`);
    }
  }

  /**
   * 落失败回执（决策 #6，§6 失败回执）：topic 内 type='system' 消息——「发送者不把
   * 沉默当已读」。触发点：A（唤醒时离线：未绑 runner / runner 离线）、B（busy 排队
   * 超限 > QUEUE_RECEIPT_THRESHOLD）。
   * - 通道复用 sendSystemMessage（r7 泛化提取，与安全阀公告同源；私密 topic 前置 join
   *   系统 actor，幂等）
   * - 节流：per-seat per-reason RECEIPT_THROTTLE_MS（5 分钟）内不重复（内存表；
   *   重启清零可接受——回执是提示性消息不是账本，重启后最多多发一条）
   * - 递归防护：回执自身是 system 消息 → 唤醒路由「system 不唤醒」天然免疫
   *   （防 回执→唤醒→回复→回执 循环，M2 阶段 3 新定规则，测试覆盖该断言）
   * - metadata 不带 seatLabel（不触发任何座位回声抑制特例）
   * - fire-and-forget + 内部自吞：回执失败只记日志（与 listener 铁规②同精神，
   *   提示性消息失败绝不影响注入管线）
   * @param seat 目标座位（label 进回执文案）
   * @param reason 回执原因（offline = 唤醒时不可达；queue_backlog = 排队超限）
   */
  private async emitReceipt(
    seat: RoundtableSeat,
    reason: 'offline' | 'queue_backlog',
  ): Promise<void> {
    const key = `${seat.id}:${reason}`;
    const now = Date.now();
    if (now - (this.receiptThrottle.get(key) ?? 0) < RECEIPT_THROTTLE_MS) return;
    this.receiptThrottle.set(key, now);
    const text =
      reason === 'offline'
        ? `座位 ${seat.label} 当前离线，消息已暂存，上线后送达`
        : `座位 ${seat.label} 排队积压（>${QUEUE_RECEIPT_THRESHOLD}），响应可能延迟`;
    try {
      await this.sendSystemMessage(seat.topicId, text);
      this.logger.log(
        `失败回执: seat ${seat.id} (${seat.label}) reason ${reason}（节流 ${RECEIPT_THROTTLE_MS}ms）`,
      );
    } catch (err) {
      this.logger.error(`失败回执落库失败 seat ${seat.id} reason ${reason}: ${String(err)}`);
    }
  }

  // ─────────────────────────── seat.event 上行处理 ───────────────────────────

  /**
   * seat.event 上行处理（gateway 信封分发后调用；envelope 已通过 validatePayload）
   *
   * 防护：座位存在性 + 归属校验（仅绑定该 runner 的座位可上行）；seq 幂等去重
   * （≤ last_event_seq 直接丢弃，§4 双向对账——runner 重连重放不产生双写）。
   * message_complete 分支内部自行推进游标（仅成功落库后推进，失败留待重放）；
   * 其余分支在尾部统一推进。
   */
  async handleSeatEvent(runnerId: string, envelope: Envelope): Promise<void> {
    const seatId = envelope.seatId!; // validateEnvelope 保证座位归属消息必带 seatId
    const seat = await this.seatRepo.findOne({ where: { id: seatId } });
    if (!seat) {
      this.logger.warn(`seat.event: seat ${seatId} 不存在`);
      this.sendRunnerError(runnerId, 'SEAT_NOT_FOUND', `seat ${seatId} not found`);
      return;
    }
    if (seat.runnerId !== runnerId) {
      // 归属校验：只处理绑定本 runner 的座位（防跨 runner 冒认，§7 边界）
      this.logger.warn(
        `seat.event: seat ${seatId} 绑定 runner ${seat.runnerId}，拒绝 runner ${runnerId} 上行`,
      );
      this.sendRunnerError(
        runnerId,
        'SEAT_NOT_BOUND',
        `seat ${seatId} is not bound to this runner`,
      );
      return;
    }
    const lastEvent = parseInt(seat.lastEventSeq ?? '0', 10);
    // 幂等去重（§4 双向对账）——RT-DEBT-1 蛙跳修复：留档的失败 seq（failedEventSeqs）
    // 即使 ≤ 游标也放行（重放可重试）；仅「已处理」的 seq 才丢弃
    const failedSeqs = this.failedEventSeqs(seat);
    if (envelope.seq <= lastEvent && !failedSeqs.includes(envelope.seq)) {
      this.logger.debug(`seat.event 幂等去重: seat ${seatId} seq ${envelope.seq} ≤ ${lastEvent}`);
      return;
    }
    const payload = envelope.payload as SeatEventPayload;
    switch (payload.type) {
      case 'message_chunk': {
        // M4b-1：流式增量 → 相位 replying（R4 映射；tool 相位被 chunk 覆盖——发言已进入输出阶段）
        this.setPresence(seatId, 'replying');
        // 流式增量：M1 只做内存累积 + 日志，不落库（完整回复在 message_complete 拼装）。
        // 债②无界增长（RT-DEBT-2）：超 MAX_CHUNK_BUFFER_CHARS 丢弃最旧 chunks 至上限内
        // （失控 turn 内存兜底）+ 每座位 CHUNK_TRIM_WARN_THROTTLE_MS 节流 warn
        // （防刷屏）；拼装照常——头部截断降级语义，完整度由 complete.text 兜底。
        const buf = this.chunkBuffers.get(seatId) ?? [];
        buf.push(payload.text);
        let total = buf.reduce((sum, t) => sum + t.length, 0);
        let dropped = 0;
        while (buf.length > 1 && total > MAX_CHUNK_BUFFER_CHARS) {
          total -= buf[0].length;
          buf.shift();
          dropped += 1;
        }
        this.chunkBuffers.set(seatId, buf);
        if (dropped > 0) {
          const now = Date.now();
          if (now - (this.chunkTrimWarnThrottle.get(seatId) ?? 0) >= CHUNK_TRIM_WARN_THROTTLE_MS) {
            this.chunkTrimWarnThrottle.set(seatId, now);
            this.logger.warn(
              `message_chunk seat ${seatId} 缓冲超限（>${MAX_CHUNK_BUFFER_CHARS} 字符），丢弃最旧 ${dropped} chunk(s)，保留 ${total} 字符（失控 turn 兜底）`,
            );
          }
        }
        this.logger.debug(
          `message_chunk seat ${seatId} seq ${envelope.seq}: +${payload.text.length} chars`,
        );
        break;
      }
      case 'message_complete': {
        // M4b-1：turn 终结 → 相位 idle（无论落库成败——runner 已结束发言；失败重放
        // 时近况冲刷由 handleMessageComplete 成功分支处理，相位幂等）
        this.setPresence(seatId, 'idle');
        // 内部自行处理游标推进/单飞行释放，处理完直接返回
        await this.handleMessageComplete(seat, envelope.seq, payload);
        return;
      }
      case 'tool_event': {
        // M4b-1：工具调用可观测——presence 相位推导（R4）+ recentActivity 当轮累积
        // （R3 冲刷式：只入内存缓冲，message_complete 才一次落库——高频不再写放大）。
        // tool 载荷真机形状（RT-PERM-2）：{toolCallId, title, kind, status, locations,
        // rawInput, ...}——仅提取展示字段，rawInput/locations 天然剥离（R5）。
        const tool = (payload.tool ?? {}) as Record<string, unknown>;
        const status = typeof tool.status === 'string' ? tool.status : '';
        if (status === 'completed' || status === 'error') {
          // 工具结束回 thinking（r1 漏边修正：completed 不回 tool 会卡在「工具中」）
          this.setPresence(seatId, 'thinking');
        } else {
          // in_progress / pending / 缺省 = 工具进行中（带 toolTitle 供 chip 展示）
          this.setPresence(seatId, 'tool', this.summarizeToolTitle(seat, tool.title ?? tool.name));
        }
        this.pushRecentActivityBuffer(seat.id, this.toolRecentActivityItem(seat, tool));
        this.logger.debug(
          `tool_event seat ${seatId} seq ${envelope.seq}: ${JSON.stringify(payload.tool).slice(0, 200)}`,
        );
        break;
      }
      case 'permission_request': {
        // M3 阶段 1：审批持久化 + topic 公告（裁决 API/UI 数据源，§6 审批可见性）。
        // 落库失败 → 失败 seq 精确留档（与 message_complete 同规 RT-DEBT-1），游标
        // 不推进，重连重放时按 (seatId, requestId) 幂等去重（见 persistPermissionRequest）；
        // 成功 → 尾部统一推进游标。
        const persisted = await this.persistPermissionRequest(seat, payload);
        if (!persisted) {
          if (this.recordFailedSeq(seat, envelope.seq)) {
            await this.seatRepo.save(seat).catch((err: unknown) => {
              this.logger.error(
                `permission_request 失败留档落库失败 seat ${seat.id} seq ${envelope.seq}: ${String(err)}`,
              );
            });
          }
          return;
        }
        break;
      }
      case 'usage': {
        // 预算熔断 + 上下文水位数据源（M3），M1 顺手存 state.lastUsage
        seat.state = {
          ...seat.state,
          lastUsage: { used: payload.used, size: payload.size, at: new Date().toISOString() },
        };
        break;
      }
      case 'seat_info': {
        // M3 阶段 5：座位实际在跑配置观测（model/thinking/mode 地面真相，非配置声明——
        // config 是创建时声明，configOptions 是 ACP 会话当前值；本批仅观测不做下发钉死）。
        // lastUsage 同款落法：state jsonb 只增键，不建列不迁移。runner 侧每次全量
        // 快照上行（含 current_mode_update 热更新合并后的值），整块替换即可。
        seat.state = {
          ...seat.state,
          modelInfo: {
            ...(payload.model !== undefined ? { model: payload.model } : {}),
            ...(payload.thinking !== undefined ? { thinking: payload.thinking } : {}),
            ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
            at: new Date().toISOString(),
          },
        };
        break;
      }
      case 'status': {
        // M4b-1 presence 映射（R4）：busy → thinking（默认思考相位）；online → idle；
        // offline → offline（runner 主动报离线，与断连摘牌同终点）
        if (payload.status === 'busy') {
          this.setPresence(seatId, 'thinking');
        } else if (payload.status === 'offline') {
          this.setPresence(seatId, 'offline');
        } else {
          this.setPresence(seatId, 'idle');
        }
        // driver 运行时状态 → 座位生命周期状态：offline 落 offline，online/busy 归 active
        seat.status = payload.status === 'offline' ? 'offline' : 'active';
        if (seat.status === 'offline') {
          // 座位 offline：窗口立即封批入 FIFO（RT-BATCH-2；队列保留，重连后 flush）。
          // 座位 revoke API（M3 座位管理）落地时需复用 sealBatch 同规清理。
          void this.sealBatch(seat.id);
        }
        this.logger.log(
          `status seat ${seatId} seq ${envelope.seq}: ${payload.status}${payload.detail ? ` (${payload.detail})` : ''}`,
        );
        break;
      }
    }
    seat.lastEventSeq = String(envelope.seq);
    await this.seatRepo.save(seat).catch((err: unknown) => {
      this.logger.error(`seat.event 游标推进失败 seat ${seatId}: ${String(err)}`);
    });
  }

  /**
   * message_complete 处理（turn 终结）：
   * - silent → 只记日志不落库（§6 沉默拦截，防礼貌循环烧 token），推进游标
   *   （M2 阶段 3 判定升级：runner `silent` 标志优先，`parseSilentReply(全文)` 文本
   *   兜底——老 runner 不带标志但只回哨兵文本时同样拦截；正文藏 JSON 不误杀）；
   *   state.silentCount +1（R6，与游标同次 save）
   * - 正文空且非沉默 → 记警告跳过落库，推进游标（不加计数）
   * - 正常 → complete 自带 text 优先（无则 chunk buffer 拼装兜底）→
   *   TopicService.sendMessage(runner actor, AGENT,
   *   {content, metadata:{seatLabel}, clientRequestId:'rt:{seatId}:{seq}'})（§6 身份模型）
   *   → 成功才推进游标 + 清 chunk buffer（失败保留 buffer 与游标，runner 重连重放重试）；
   *   安全阀计数同次 save：state.roundsWithoutHuman +1，跨过阈值那一 turn →
   *   state.valveTripCount +1 + topic 触发公告（r7，RT-VALVE-1）
   * - 失败留档（RT-DEBT-1 蛙跳修复）：落库失败 → 失败 seq 精确入
   *   state.failedEventSeqs（cap 50 淘汰最旧，随 state 持久化重启不失）——后续事件
   *   推进游标不会使其被 dedup 丢弃，重连重放可重试；三个「正常终结」分支（成功/
   *   沉默/空正文）从留档移除该 seq 并清档（与游标 save 同次写入，不新增 save 次数）；
   *   游标写入取 max（重放 seq ≤ 当前游标时不得回退，防已处理事件被二次处理）
   * 单飞行释放放 finally：无论成败 busy=false 并 flush 下一批（失败时队内后续照发，
   * 已记日志；重放窗口的重复由 clientRequestId 幂等兜底）。
   */
  private async handleMessageComplete(
    seat: RoundtableSeat,
    seq: number,
    payload: Extract<SeatEventPayload, { type: 'message_complete' }>,
  ): Promise<void> {
    const flight = this.getFlight(seat.id);
    try {
      const chunks = this.chunkBuffers.get(seat.id) ?? [];
      // 全文与落库取数同源：complete 自带 text 优先（runner 侧全文；chamber 重启清空
      // buffer 后仍不丢），buffer 仅兜底（老 runner 不带 text 时的兼容路径，
      // 2026-08-07 dogfood 实测缺口）
      const fullText = payload.text ?? chunks.join('');
      // silent 判定：runner 标志优先，文本兜底（parseSilentReply 宽松解析——trim 后
      // 整段可 JSON.parse 且 silent===true；flag=false + 正文藏 JSON 不误杀）
      const silentByFlag = payload.silent === true;
      const silentByText = !silentByFlag && parseSilentReply(fullText);
      if (silentByFlag || silentByText) {
        this.logger.log(
          `沉默拦截（§6）: seat ${seat.id} seq ${seq} 回复仅为哨兵，不落 topic` +
            (silentByText ? '（文本兜底命中）' : ''),
        );
        this.chunkBuffers.delete(seat.id);
        // M4b-1：silent 轮也记近况 turn 条目（「沉默」），随本次 save 一次落库（R3 冲刷式）
        this.pushRecentActivityBuffer(seat.id, this.turnRecentActivityItem(true, 0, payload.stopReason));
        this.flushRecentActivity(seat);
        // 游标取 max 不回退（重放失败 seq 时不得低于已推进游标，RT-DEBT-1）
        seat.lastEventSeq = String(Math.max(parseInt(seat.lastEventSeq ?? '0', 10), seq));
        // 沉默拦截计数（R6 落 state，与游标同次 save——不新增 save）：silentCount +1，
        // 供阶段 7 digest 沉默拦截率（拦截次数/总轮次）。沉默轮**不加**
        // roundsWithoutHuman（沉默 ≠ 消耗轮次，不推进安全阀）。重放成功终结 →
        // 同步清失败留档（RT-DEBT-1）。
        this.clearFailedSeq(seat, seq);
        seat.state = { ...seat.state, silentCount: (seat.state?.silentCount ?? 0) + 1 };
        await this.seatRepo.save(seat).catch((err: unknown) => {
          this.logger.error(`silent 游标推进失败 seat ${seat.id}: ${String(err)}`);
        });
        return;
      }
      const content = fullText;
      if (content.trim().length === 0) {
        this.logger.warn(`message_complete seat ${seat.id} seq ${seq} 正文为空且非沉默，跳过落库`);
        this.chunkBuffers.delete(seat.id);
        // M4b-1：空正文也记近况 turn 条目（「回复 0 字」，异常轮可观测）
        this.pushRecentActivityBuffer(seat.id, this.turnRecentActivityItem(false, 0, payload.stopReason));
        this.flushRecentActivity(seat);
        // 空正文非沉默：不加任何计数（roundsWithoutHuman 只认「落库成功」的轮次，r7）
        seat.lastEventSeq = String(Math.max(parseInt(seat.lastEventSeq ?? '0', 10), seq));
        this.clearFailedSeq(seat, seq); // 重放成功终结 → 清失败留档（RT-DEBT-1）
        await this.seatRepo.save(seat).catch((err: unknown) => {
          this.logger.error(`空正文游标推进失败 seat ${seat.id}: ${String(err)}`);
        });
        return;
      }
      const runner = await this.runnerRepo.findOne({ where: { id: seat.runnerId! } });
      if (!runner) {
        // runner 行缺失（理论不可达：正在上行的事件必然来自在线 runner）——与落库失败
        // 同规：留档待重放（否则后续事件推进游标后会丢该 seq）
        this.logger.error(
          `message_complete: runner ${seat.runnerId} 不存在，无法落库（留档待重放）`,
        );
        if (this.recordFailedSeq(seat, seq)) {
          await this.seatRepo.save(seat).catch((err: unknown) => {
            this.logger.error(
              `message_complete 失败留档落库失败 seat ${seat.id} seq ${seq}: ${String(err)}`,
            );
          });
        }
        return;
      }
      // 座位发言以 runner 对应 agent actor 身份落 topic（§6 身份模型，方案 b）
      // metadata：seatLabel 单键（子身份 badge）+ seatCoordinator 仅主脑座位写
      // true（r13：缺省不写保持载荷瘦；web 消息流据此渲染主脑 badge，与注入体
      // from.coordinator 投影同源）
      await this.topicService.sendMessage(seat.topicId, runner.actorId, ActorType.AGENT, {
        content,
        metadata: {
          seatLabel: seat.label,
          ...(seat.coordinator ? { seatCoordinator: true } : {}),
        },
        clientRequestId: `rt:${seat.id}:${seq}`,
      });
      this.chunkBuffers.delete(seat.id); // 落库成功才清 buffer（失败保留供重放拼装）
      // 安全阀计数（R6 落 state，与 lastEventSeq 同次 seatRepo.save——不新增 save）：
      // 非沉默轮落库成功 → roundsWithoutHuman +1；该座位**跨过阈值（N-1→N）那一 turn**
      // → valveTripCount +1 + topic 触发公告（per-topic 节流，RT-VALVE-1；公告是
      // type='system' → 「system 不唤醒」天然免疫递归，RT-ROUTE-1）。阈值 0 = 关闭：
      // 计数照常推进（digest 可读），但永不 trip/暂停/公告。
      const valveTopic = await this.topicRepo.findOne({ where: { id: seat.topicId } });
      const threshold = this.maxRoundsWithoutHuman(valveTopic);
      const prevRounds = seat.state?.roundsWithoutHuman ?? 0;
      const nextRounds = prevRounds + 1;
      const tripped = threshold > 0 && nextRounds === threshold;
      this.clearFailedSeq(seat, seq); // 重放成功落库 → 清失败留档（RT-DEBT-1）
      // M4b-1：正常终结 → 近况冲刷（「回复 n 字」+ 当轮 tool 条目，随本次 save 一次落库）
      this.pushRecentActivityBuffer(seat.id, this.turnRecentActivityItem(false, content.length, payload.stopReason));
      this.flushRecentActivity(seat);
      seat.state = {
        ...seat.state,
        roundsWithoutHuman: nextRounds,
        ...(tripped ? { valveTripCount: (seat.state?.valveTripCount ?? 0) + 1 } : {}),
      };
      seat.lastEventSeq = String(Math.max(parseInt(seat.lastEventSeq ?? '0', 10), seq));
      await this.seatRepo.save(seat).catch((err: unknown) => {
        this.logger.error(`message_complete 游标推进失败 seat ${seat.id}: ${String(err)}`);
      });
      if (tripped) {
        void this.emitValveAnnouncement(seat.topicId, 'trip', threshold);
      }
    } catch (err) {
      // 落库失败：游标不推进 + 保留 chunk buffer（重放可拼装）+ 失败 seq 精确留档
      // （RT-DEBT-1：随 state 持久化，重启不失；后续事件推进游标不使其被 dedup 丢弃）
      const recorded = this.recordFailedSeq(seat, seq);
      this.logger.error(
        `message_complete seat ${seat.id} seq ${seq} 落库失败（留档待重放）: ${String(err)}`,
      );
      if (recorded) {
        await this.seatRepo.save(seat).catch((err2: unknown) => {
          this.logger.error(
            `message_complete 失败留档落库失败 seat ${seat.id} seq ${seq}: ${String(err2)}`,
          );
        });
      }
    } finally {
      // 释放单飞行并发下一批（无论成败）
      flight.busy = false;
      await this.flushPending(seat.id);
    }
  }

  // ─────────────────────────── presence + recentActivity（M4b-1 seat 状态可视化） ───────────────────────────

  /**
   * 推导座位当前相位并写入内存 Map（M4b-1 R4 映射唯一写入口；at 取推导时刻）。
   * 相位是派生视图（不落库）：由既有上行事件推导，无事件流 = 无条目（listSeats
   * 不加 presence 字段；cancelSeat busy 门控视无条目为「空闲」）。
   * @param seatId 座位 id
   * @param phase 目标相位（R4 映射见 SeatPresence 注释）
   * @param toolTitle 工具标题（仅 phase='tool' 时传；已摘要化）
   */
  private setPresence(seatId: string, phase: SeatPresence['phase'], toolTitle?: string): void {
    this.seatPresences.set(seatId, {
      phase,
      at: new Date().toISOString(),
      ...(toolTitle ? { toolTitle } : {}),
    });
  }

  /**
   * 工具标题摘要化（M4b-1 R5 加固）：title 截断 RECENT_ACTIVITY_TITLE_CAP（80）字符 +
   * 剥离座位 cwd 前缀——title 常是绝对路径（如 /tmp/seat/project/src/x.ts），cwd 前缀
   * 会泄座位工作目录细节进 state（participant 全可读）。空 title 返回空串（调用方兜底）。
   * @param seat 座位行（config.cwd 参与前缀剥离）
   * @param rawTitle 原始 title（宽松透传形状，非字符串视为空）
   */
  private summarizeToolTitle(seat: RoundtableSeat, rawTitle: unknown): string {
    let title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : '';
    const cwd = typeof seat.config?.cwd === 'string' && seat.config.cwd.length > 0 ? seat.config.cwd : null;
    if (title && cwd && title.startsWith(cwd)) {
      title = title.slice(cwd.length).replace(/^[/\\]+/, '');
    }
    if (title.length > RECENT_ACTIVITY_TITLE_CAP) {
      title = `${title.slice(0, RECENT_ACTIVITY_TITLE_CAP)}…`;
    }
    return title;
  }

  /**
   * 工具事件 → 近况条目（M4b-1，plan 形状 `{at, kind:'tool_call', summary:'<title>（<kind>）',
   * result:<status>}`）。R5 摘要化：只提取 title/kind/status 三个展示字段——
   * rawInput/locations 等敏感载荷天然剥离（不复制进条目）。
   */
  private toolRecentActivityItem(seat: RoundtableSeat, tool: Record<string, unknown>): RecentActivityItem {
    const title = this.summarizeToolTitle(seat, tool.title ?? tool.name);
    const kind = typeof tool.kind === 'string' && tool.kind.length > 0 ? tool.kind : '';
    return {
      at: new Date().toISOString(),
      kind: 'tool_call',
      summary: [title, kind ? `（${kind}）` : ''].join('') || 'tool',
      result: typeof tool.status === 'string' ? tool.status : '',
    };
  }

  /**
   * 审批请求 → 近况条目（M4b-1，plan 形状 `{kind:'permission', summary:'<title>',
   * result:'pending'}`）。title 走同一摘要化（ToolBrief 真机形状 {title, toolCallId,
   * content}——content 可能含敏感内容，只提取 title）。
   */
  private permissionRecentActivityItem(seat: RoundtableSeat, tool: Record<string, unknown>): RecentActivityItem {
    const title = this.summarizeToolTitle(seat, tool.title ?? tool.name);
    return {
      at: new Date().toISOString(),
      kind: 'permission',
      summary: title || 'unknown tool',
      result: 'pending',
    };
  }

  /**
   * turn 终结 → 近况条目（M4b-1，plan 形状 `{kind:'turn', summary: silent?'沉默':
   * '回复 <n> 字', result: stopReason}`）。n = 回复字符数；stopReason 原文透传
   * （cancelled/end_turn 等，web 端可据此区分取消收尾）。
   */
  private turnRecentActivityItem(silent: boolean, charCount: number, stopReason: string): RecentActivityItem {
    return {
      at: new Date().toISOString(),
      kind: 'turn',
      summary: silent ? '沉默' : `回复 ${charCount} 字`,
      result: stopReason,
    };
  }

  /** 当轮近况条目入缓冲（M4b-1 R3：tool_event 高频只入内存缓冲，message_complete 才冲刷落库） */
  private pushRecentActivityBuffer(seatId: string, item: RecentActivityItem): void {
    const buf = this.recentActivityBuffers.get(seatId) ?? [];
    buf.push(item);
    this.recentActivityBuffers.set(seatId, buf);
  }

  /**
   * 当轮缓冲冲刷（M4b-1 R3 冲刷式）：缓冲条目合并进 state.recentActivity（cap 10
   * 环形，超限淘汰最旧）后清空缓冲——**不落库**，由调用方所在分支的既有 state 写入
   * 同次 seatRepo.save 落库（不新增 save 次数，无锁整对象替换竞态窗口不放大）。
   * 调用时机：handleMessageComplete 的三个「正常终结」分支（silent/空正文/成功）；
   * 失败 catch 分支不冲刷（游标不推进，重放成功后再冲刷——防半截 turn 污染时间线）。
   * @returns 是否有条目被合并（false = 当轮无活动，state 未被改）
   */
  private flushRecentActivity(seat: RoundtableSeat): boolean {
    const buffered = this.recentActivityBuffers.get(seat.id);
    if (!buffered || buffered.length === 0) return false;
    this.recentActivityBuffers.delete(seat.id);
    const ring = Array.isArray(seat.state?.recentActivity)
      ? [...(seat.state.recentActivity as RecentActivityItem[])]
      : [];
    ring.push(...buffered);
    if (ring.length > RECENT_ACTIVITY_CAP) {
      ring.splice(0, ring.length - RECENT_ACTIVITY_CAP);
    }
    seat.state = { ...seat.state, recentActivity: ring };
    return true;
  }

  /**
   * 即时合并近况条目（M4b-1：permission_request 低频治理事件即时写，不等冲刷；
   * 仅内存改 state——所在 handler（handleSeatEvent）尾部有统一 save 落库）。
   * 幂等保证：重放命中已有 pending 行时 persistPermissionRequest 提前返回，不触发本方法。
   */
  private pushRecentActivityNow(seat: RoundtableSeat, item: RecentActivityItem): void {
    const ring = Array.isArray(seat.state?.recentActivity)
      ? [...(seat.state.recentActivity as RecentActivityItem[])]
      : [];
    ring.push(item);
    if (ring.length > RECENT_ACTIVITY_CAP) {
      ring.splice(0, ring.length - RECENT_ACTIVITY_CAP);
    }
    seat.state = { ...seat.state, recentActivity: ring };
  }

  // ─────────────────────────── 失败留档（RT-DEBT-1 蛙跳修复） ───────────────────────────

  /**
   * 读座位失败留档列表（seat.state.failedEventSeqs；防御性归一——脏数据/缺省按空表）。
   * 语义（RT-DEBT-1）：曾落库失败、尚未重放成功的上行 seq——dedup 对留档 seq 放行。
   */
  private failedEventSeqs(seat: RoundtableSeat): number[] {
    const v = seat.state?.failedEventSeqs;
    return Array.isArray(v)
      ? (v as number[]).filter((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
      : [];
  }

  /**
   * 记录失败留档（去重；超 FAILED_EVENT_SEQ_CAP 淘汰最旧 + 日志）。
   * @returns 是否真的写入（去重命中 = false——调用方据此决定是否 save，防无意义写）
   */
  private recordFailedSeq(seat: RoundtableSeat, seq: number): boolean {
    const failed = this.failedEventSeqs(seat);
    if (failed.includes(seq)) return false;
    failed.push(seq);
    if (failed.length > FAILED_EVENT_SEQ_CAP) {
      const dropped = failed.splice(0, failed.length - FAILED_EVENT_SEQ_CAP);
      this.logger.warn(
        `seat ${seat.id} failedEventSeqs 超 cap ${FAILED_EVENT_SEQ_CAP}，淘汰最旧 ${dropped.length} 条留档`,
      );
    }
    seat.state = { ...seat.state, failedEventSeqs: failed };
    return true;
  }

  /**
   * 从失败留档移除已正常终结的 seq（重放落库成功/沉默/空正文等分支，RT-DEBT-1）——
   * 与游标 save 同次写入（不新增 save 次数）；清空后整键移除（state 不残留空数组）。
   */
  private clearFailedSeq(seat: RoundtableSeat, seq: number): void {
    const failed = this.failedEventSeqs(seat);
    if (!failed.includes(seq)) return;
    const rest = failed.filter((s) => s !== seq);
    if (rest.length === 0) {
      const { failedEventSeqs: _omit, ...state } = seat.state ?? {};
      seat.state = state;
    } else {
      seat.state = { ...seat.state, failedEventSeqs: rest };
    }
  }

  // ─────────────────────────── hello 对账重放（§4 可靠性） ───────────────────────────

  /**
   * hello 对账重放（连接建立/重连后由 gateway 调用）
   *
   * 对每座位：runner 报 lastReceivedSeq < chamber last_inject_seq → 缺口
   * (lastReceivedSeq, lastInjectSeq] 从 state.recentInjects ring 重建 inject（原 seq 重发，
   * 不推进游标——黑板即真相，inject 可由 topic 消息重建，无 outbox 表）；runner 超前
   * （chamber 落库丢失）→ 采纳 runner 游标并抬高分配游标（防 seq 复用被去重楔死）；
   * 随后 rebuildUndispatched 重建「重启窗口内未派发」的消息（R4，见该方法注释），
   * 最后 flushPending 把内存队列中未发送的注入一并派发。
   * 顺序保证：重放先入队 → 重建后入队 → 新注入后入队，FIFO 与 runner 单飞行天然串行。
   */
  async reconcile(runnerId: string, hello: HelloPayload): Promise<void> {
    const seats = await this.seatRepo.find({ where: { runnerId } });
    for (const seat of seats) {
      const rec = hello.seats?.[seat.id];
      if (rec) {
        const chamberSent = parseInt(seat.lastInjectSeq ?? '0', 10);
        if (rec.lastReceivedSeq < chamberSent) {
          await this.replayGap(seat, rec.lastReceivedSeq, chamberSent);
        } else if (rec.lastReceivedSeq > chamberSent) {
          // runner 超前 = chamber 侧落库丢失（重启窗口/竞态）——采纳 runner 游标：
          // runner 是下行去重的权威方，seq 复用会被 runner 幂等去重导致注入静默丢失
          // + busy 楔死（2026-08-07 dogfood 三连实测）；采纳后分配游标同步抬高
          this.logger.warn(
            `reconcile: runner ${runnerId} 报 seat ${seat.id} lastReceivedSeq=${rec.lastReceivedSeq} 超前 chamber ${chamberSent}，采纳 runner 游标`,
          );
          seat.lastInjectSeq = String(rec.lastReceivedSeq);
          await this.seatRepo.save(seat).catch((err: unknown) => {
            this.logger.error(`reconcile 采纳游标落库失败 seat ${seat.id}: ${String(err)}`);
          });
          this.nextSeqCache.set(seat.id, rec.lastReceivedSeq + 1);
        }
      }
      // R4 重启重建：窗口内未派发消息（从未 persistDispatch，ring 覆盖不到）从黑板补捞
      await this.rebuildUndispatched(seat);
      // 无论 hello 是否报告该座位都 flush：断连窗口内存队列中的注入靠此派发
      await this.flushPending(seat.id);
    }
  }

  /**
   * 装配 hello_ack / ping 携带的上行游标回执（RT-DEBT-2 无界增长修复的 chamber 侧）：
   * 按 runner 全部绑定座位读 last_event_seq + state.failedEventSeqs——runner 据此裁剪
   * 已确认送达的未确认队列（`≤ lastEventSeq 且不在 failedEventSeqs` 的条目可裁；
   * 留档 seq = chamber 未处理，不得裁，待重放）。gateway 在 hello 处理后回发
   * hello_ack（重连清已确认区间）+ 30s 心跳 ping 携带（长连接定期裁剪）。
   * @param runnerId 目标 runner
   * @returns seatId → 上游游标信息
   */
  async buildSeatAck(runnerId: string): Promise<HelloAckPayload> {
    const seats = await this.seatRepo.find({ where: { runnerId } });
    const map: HelloAckPayload['seats'] = {};
    for (const seat of seats) {
      map[seat.id] = {
        lastEventSeq: parseInt(seat.lastEventSeq ?? '0', 10),
        failedEventSeqs: this.failedEventSeqs(seat),
      };
    }
    return { seats: map };
  }

  /**
   * 重启重建「未派发消息」（R4 可重建视图，RT-BATCH-3）
   *
   * 背景洞：replayGap 只从 state.recentInjects ring 重建「已 persistDispatch 但 runner
   * 未确认」的缺口；窗口内收集未封批 / 已封批未发送的消息从未落 ring → backend 重启
   * 后内存丢失且 ring 无条目 → 丢消息。
   * 补法（真相 = topic 黑板 + lastInjectSeq）：以 ring 内全部消息的最大 createdAt 为
   * 「最后注入时间」下界（ring 持久化在 DB，重启不丢；采纳游标场景 ring 可能缺最新
   * 条目，取全部条目 max 兜底），查 topic 黑板中 createdAt ≥ 下界且 id 不在 ring 内
   * 的消息（排除自身座位发言，与 onMessageCreated 回声抑制同规）→ 按 ts 升序以新 seq
   * 注入（重启后游标从 lastInjectSeq+1 续，无冲突）。
   * 边界：从未派发过（ring 空）→ 无时间下界，不重建（避免把 topic 历史消息全量重放，
   * 与 M1「座位创建后新消息才注入」语义一致）；persistDispatch 落库失败的极端窗口
   * 可能重复一轮（M1 已接受，见 persistDispatch 注释）。
   * parked 语义注记（r6，只注释不改逻辑）：收集器的 parked（非唤醒消息）与开着的
   * window 都是内存态，重启丢失后统一由本方法按「强制封批」从黑板补捞——重启即
   * 到期，宁可多唤醒一次（把未 @ 的消息也注入）也不丢消息；已注入的重放重复由
   * runner 侧 seatId+seq 幂等 + clientRequestId 兜底。
   */
  private async rebuildUndispatched(seat: RoundtableSeat): Promise<void> {
    const ring = Array.isArray(seat.state?.recentInjects)
      ? (seat.state.recentInjects as Array<{ seq: number; messageIds: string[] }>)
      : [];
    const ringIds = new Set(ring.flatMap((entry) => entry.messageIds));
    if (ringIds.size === 0) {
      this.logger.debug(`rebuildUndispatched: seat ${seat.id} 从未派发过（ring 空），跳过重建`);
      return;
    }
    const ringMessages = await this.messageRepo.find({ where: { id: In([...ringIds]) } });
    const lastInjectedAt = ringMessages.reduce<Date | null>((max, m) => {
      if (!m.createdAt) return max;
      return max === null || m.createdAt > max ? m.createdAt : max;
    }, null);
    if (!lastInjectedAt) return; // ring 消息全部缺失（理论不可达：黑板即真相）
    const candidates = await this.messageRepo.find({
      where: {
        topicId: seat.topicId,
        createdAt: MoreThanOrEqual(lastInjectedAt),
        id: Not(In([...ringIds])),
      },
    });
    const undispatched = candidates
      .filter((m) => m.metadata?.seatLabel !== seat.label) // 回声抑制同规（自己的发言不注入）
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    if (undispatched.length === 0) return;
    this.logger.log(
      `reconcile: seat ${seat.id} 重建 ${undispatched.length} 条未派发消息（重启窗口补捞）`,
    );
    // 以新 seq 立即注入（重启 = 窗口强制到期；不再重新开窗等待，避免再次丢窗口）
    await this.enqueuePending(seat, undispatched, this.batchWindowMs(seat));
  }

  /**
   * 缺口重放：从 recentInjects ring 找 (runnerReceived, chamberSent] 区间的历史注入，
   * 按消息 id 重取消息原文重建 inject body，以原 seq 入队（原样重发，runner 按
   * seatId+seq 幂等去重，§4）。
   */
  private async replayGap(
    seat: RoundtableSeat,
    runnerReceived: number,
    chamberSent: number,
  ): Promise<void> {
    const ring = Array.isArray(seat.state?.recentInjects)
      ? (seat.state.recentInjects as Array<{ seq: number; messageIds: string[] }>)
      : [];
    const missing = ring
      .filter((entry) => entry.seq > runnerReceived && entry.seq <= chamberSent)
      .sort((a, b) => a.seq - b.seq);
    if (missing.length === 0) {
      this.logger.warn(
        `reconcile: seat ${seat.id} 缺口 (${runnerReceived}, ${chamberSent}] 在 ring 中无对应条目` +
          `（ring 已淘汰或此前未持久化；M1 接受该窗口，M2 需补启动对账）`,
      );
      return;
    }
    const flight = this.getFlight(seat.id);
    for (const entry of missing) {
      const messages = await this.messageRepo.find({ where: { id: In(entry.messageIds) } });
      messages.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
      if (messages.length === 0) {
        this.logger.warn(`reconcile: seat ${seat.id} seq ${entry.seq} 消息全部缺失，跳过重放`);
        continue;
      }
      if (messages.length !== entry.messageIds.length) {
        this.logger.warn(
          `reconcile: seat ${seat.id} seq ${entry.seq} 部分消息缺失（${messages.length}/${entry.messageIds.length}）`,
        );
      }
      const topic = await this.topicRepo.findOne({ where: { id: seat.topicId } });
      const body = assembleInjectBody({
        topic: { id: seat.topicId, title: topic?.title ?? seat.topicId },
        seatLabel: seat.label,
        coordinator: seat.coordinator,
        // 重放与原注入同语义：windowMs 传座位配置值（runner 侧据此感知攒批模式）
        windowMs: this.batchWindowMs(seat),
        messages: await Promise.all(messages.map((m) => this.projectMessage(seat, m))),
      });
      flight.queue.push({
        seq: entry.seq,
        payload: { ruleHeader: this.buildRuleHeader(seat), body },
        messageIds: entry.messageIds,
      });
    }
    this.logger.log(`reconcile: seat ${seat.id} 重放 ${missing.length} 条缺口注入`);
  }

  // ─────────────────────────── 断连处理 ───────────────────────────

  /**
   * runner 断连（gateway handleDisconnect 调用）：重置该 runner 全部绑定座位的单飞行
   * busy 标志 + 立即封批清窗口定时器（RT-BATCH-2：断连期间窗口继续计时没意义，开着的
   * 批立即封入 FIFO，offline 队列保留等重连——flushPending sendToRunner=false 队头不出队）。
   * 已发送未确认的注入由下次 hello 对账重放；DB 侧 status=offline 由 registry.unregisterBySocket
   * 负责（此处只管会话层内存状态）。
   * M3 阶段 1 追加：孤儿审批处理（orphanPendingRequests）——该 runner 名下座位的全部
   * pending 审批标 orphaned + topic 公告（agent 重连后将重新发起；作废即终态，防人类
   * 误判「可裁决」——runner 重启后 permissions Map 清空，旧请求必然不可达）。
   */
  async onRunnerOffline(runnerId: string): Promise<void> {
    const seats = await this.seatRepo.find({ where: { runnerId } });
    for (const seat of seats) {
      const flight = this.flights.get(seat.id);
      if (flight) {
        flight.busy = false;
        this.logger.debug(`onRunnerOffline: seat ${seat.id} 单飞行 busy 重置`);
      }
      void this.sealBatch(seat.id); // 有开着的批 → 立即封批入队（幂等：无批则直接返回）
      // M4b-1：断连 → presence offline（registry 摘牌后座位不可达）+ 当轮近况缓冲丢弃
      // （R3：断连轮未终结，半截活动不落库——近况摘要语义可接受，重启 runner 后重来）
      this.setPresence(seat.id, 'offline');
      this.recentActivityBuffers.delete(seat.id);
    }
    if (seats.length > 0) {
      this.logger.log(`runner ${runnerId} offline: 重置 ${seats.length} 个座位的单飞行状态`);
    }
    // M3 阶段 1：孤儿审批作废（fire-and-forget + 内部自吞，失败不影响断连主流程）
    void this.orphanPendingRequests(seats);
  }

  /**
   * runner 断连孤儿处理（M3 阶段 1）：该 runner 名下座位的全部 pending 审批标
   * orphaned（作废即终态——写 resolved_at 不写 resolved_by，作废非人类裁决）+ per-topic
   * 公告「runner 断连，N 条待审批已作废，agent 重连后将重新发起」。
   * 背景（§9 已知孤儿场景）：runner 重启后其 permissions Map 清空，chamber 此刻再投递
   * verdict 会被 runner 忽略（handleVerdict 按 requestId 查不到直接丢弃）——审批不跨
   * 进程存活，继续挂 pending 只会让人类与 web 角标误判可裁决。
   * 节流：per-topic PERMISSION_ANNOUNCE_THROTTLE_MS（5 分钟，runner 反复重连防刷屏；
   * 公告是提示不是账本）。保存失败自吞只记日志（单条失败不影响其余作废）。
   * @param seats 该 runner 绑定的座位行（调用方已查询；空数组直接返回）
   */
  private async orphanPendingRequests(seats: RoundtableSeat[]): Promise<void> {
    if (seats.length === 0) return;
    try {
      const pending = await this.permReqRepo.find({
        where: { seatId: In(seats.map((s) => s.id)), status: 'pending' },
      });
      if (pending.length === 0) return;
      const now = new Date();
      // 按 topic 聚合公告计数（成功作废数进文案——公告是提示，与库内事实尽量一致）
      const byTopic = new Map<string, number>();
      let succeeded = 0;
      for (const p of pending) {
        p.status = 'orphaned';
        p.resolvedAt = now;
        const ok = await this.permReqRepo
          .save(p)
          .then(() => true)
          .catch((err: unknown) => {
            this.logger.error(`orphan 作废落库失败 request ${p.id}: ${String(err)}`);
            return false;
          });
        if (ok) {
          succeeded += 1;
          byTopic.set(p.topicId, (byTopic.get(p.topicId) ?? 0) + 1);
        }
      }
      for (const [topicId, count] of byTopic) {
        void this.announceOrphan(topicId, count);
      }
      this.logger.log(`orphan 处理: ${pending.length} 条 pending 审批作废（成功 ${succeeded} 条）`);
    } catch (err) {
      this.logger.error(`orphan 处理失败（座位 ${seats.length} 个）: ${String(err)}`);
    }
  }

  /**
   * 孤儿作废公告（M3 阶段 1，fire-and-forget + per-topic 节流；通道复用 sendSystemMessage
   * ——系统 actor + 私密桌 join，与回执/审批公告同源；公告是 system 消息 → 「system 不
   * 唤醒」天然免疫递归 RT-ROUTE-1；内部自吞只记日志，失败不影响断连主流程）。
   * @param topicId 目标 topic
   * @param count 成功作废条数（进文案）
   */
  private async announceOrphan(topicId: string, count: number): Promise<void> {
    const key = `${topicId}:orphan`;
    const now = Date.now();
    if (now - (this.permissionAnnounceThrottle.get(key) ?? 0) < PERMISSION_ANNOUNCE_THROTTLE_MS) {
      return;
    }
    this.permissionAnnounceThrottle.set(key, now);
    try {
      await this.sendSystemMessage(
        topicId,
        `runner 断连，${count} 条待审批已作废，agent 重连后将重新发起`,
      );
      this.logger.log(`孤儿作废公告: topic ${topicId} count ${count}`);
    } catch (err) {
      this.logger.error(`孤儿作废公告落库失败 topic ${topicId}: ${String(err)}`);
    }
  }

  /** 向 runner 回错误信封（业务层显式回执——spike 结论③：handler 抛错客户端收不到帧） */
  private sendRunnerError(runnerId: string, code: string, message: string): void {
    this.registry.sendToRunner(runnerId, buildEnvelope('error', { code, message }, {}));
  }

  /** 取/建座位单飞行状态（懒初始化） */
  private getFlight(seatId: string): SeatFlight {
    let flight = this.flights.get(seatId);
    if (!flight) {
      flight = { busy: false, queue: [] };
      this.flights.set(seatId, flight);
    }
    return flight;
  }
}

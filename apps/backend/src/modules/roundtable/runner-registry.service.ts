/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §2 (② 控制通道层: runner 注册表)
 *   - 补充: docs/roundtable-design.md §4 (控制面协议: seat.assign 下行/hello 对账)
 *           docs/roundtable-design.md §5 (roundtable_runners / roundtable_seats 表)
 *           docs/roundtable-design.md §7 (安全边界: API Key 复用, 一 key 一 runner 后到踢先到)
 *
 * [踩坑索引]
 *
 * [铁律关联] #9(代理层透传) #11(注释) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { WebSocket } from 'ws';
import {
  buildEnvelope,
  SEAT_RUNTIME_STATUS,
  type Envelope,
  type HelloPayload,
  type SeatAssignPayload,
  type SeatVendor,
} from '@agent-chamber/roundtable-protocol';
import { SEAT_LIFECYCLE_STATUS } from '@agent-chamber/shared';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import type { AgentPayload } from '../../common/services/api-key-auth.service';

/** 在线 runner 内存表条目：一条连接 = 一个条目（一 key 一 runner，同 actor 新连接踢旧） */
interface OnlineRunnerEntry {
  /** runner 行 id（DB 主键，actorId 维度 upsert 得到的稳定 id） */
  runnerId: string;
  /** API Key 对应 agent 的 actor id（§7：按 actor 绑定 runner） */
  actorId: string;
  /** 认证得到的 agent 身份载荷 */
  agent: AgentPayload;
  /** 活跃 WS 连接（唯一，被踢的连接已从表移除） */
  socket: WebSocket;
  /** 30s 心跳 ping 定时器（handleDisconnect 时清理） */
  pingTimer?: NodeJS.Timeout;
}

/**
 * runner 注册表（chamber ② 控制通道层，M1 计划阶段 3）
 *
 * 职责：
 * - 在线 runner 内存表（runnerId → 连接条目）+ DB upsert（roundtable_runners 行，
 *   actorId 维度幂等：同 key 重连更新同一行）
 * - 一 key 一 runner（§7 安全边界）：同 actor 新连接踢掉旧连接（close 4012 + 日志）
 * - 座位绑定：hello 后按「config.bindActorId == runner actor 且 seat.vendor ∈ hello.vendors
 *   且座位状态可绑定」查座位，落 runner_id 并逐座位下行 seat.assign（§7 + M1 自审补）
 * - sendToRunner：下游（注入管线）经此向在线 runner 发信封；离线返回 false（调用方
 *   自行决定是否兜底，M1 不做失败回执——设计 §6 失败回执 M2 落地）
 *
 * 断连清理：unregisterBySocket 移除内存条目 + DB status=offline + 绑定座位 status=offline；
 * 座位状态恢复 active 由重连后的 bindSeats 完成（M1 计划 §三 runner.gateway 职责）。
 */
@Injectable()
export class RunnerRegistryService {
  private readonly logger = new Logger(RunnerRegistryService.name);

  /** 在线 runner 表：runnerId → 连接条目（进程内，chamber 重启后由 hello 对账重建） */
  private readonly online = new Map<string, OnlineRunnerEntry>();

  constructor(
    @InjectRepository(RoundtableRunner)
    private runnerRepo: Repository<RoundtableRunner>,
    @InjectRepository(RoundtableSeat)
    private seatRepo: Repository<RoundtableSeat>,
  ) {}

  /**
   * 注册 runner 连接（WS 握手认证通过后调用）
   *
   * 流程：同 actor 已有在线连接 → 踢旧（close 4012）→ DB upsert（actorId 维度幂等）→
   * 写入在线表。握手认证在 gateway，本方法假设已通过（key → agent 身份成立）。
   * @param agent 认证得到的 AgentPayload
   * @param socket 新连接
   * @returns runnerId（DB 行 id）
   */
  async register(agent: AgentPayload, socket: WebSocket): Promise<string> {
    this.kickExisting(agent.id, socket);
    const runner = await this.upsertRunner(agent);
    this.online.set(runner.id, { runnerId: runner.id, actorId: agent.id, agent, socket });
    this.logger.log(`runner online: ${runner.id} (actor ${agent.id}, agent ${agent.name})`);
    return runner.id;
  }

  /**
   * 一 key 一 runner（§7）：同 actor 已有在线连接时踢掉旧连接。
   * 旧连接 close(4012, ...) 触发其 handleDisconnect → unregisterBySocket 清理。
   * @param actorId 新连接的 actor id
   * @param newSocket 新连接（防御：若新连接恰好已在表中，不踢自己）
   */
  private kickExisting(actorId: string, newSocket: WebSocket): void {
    for (const [runnerId, entry] of this.online) {
      if (entry.actorId === actorId && entry.socket !== newSocket) {
        this.logger.warn(
          `kick old runner connection: runner=${runnerId} actor=${actorId} ` +
            `(一 key 一 runner，后到踢先到，§7)`,
        );
        this.online.delete(runnerId);
        this.clearPingTimer(entry);
        try {
          entry.socket.close(4012, 'replaced by a newer connection for the same API key');
        } catch (err) {
          // close 抛错（连接已关）不阻断注册路径；记录后继续
          this.logger.warn(`kick: close failed for runner ${runnerId}: ${String(err)}`);
        }
      }
    }
  }

  /**
   * DB upsert：按 actorId 查行，存在则更新（name/version/vendors 保留旧值，
   * 待 hello 刷新；status/last_seen_at 本次连接刷新），不存在则插入。
   * @param agent 认证得到的 AgentPayload
   * @returns upsert 后的 runner 行
   */
  private async upsertRunner(agent: AgentPayload): Promise<RoundtableRunner> {
    const existing = await this.runnerRepo.findOne({ where: { actorId: agent.id } });
    if (existing) {
      existing.status = SEAT_RUNTIME_STATUS.ONLINE;
      existing.lastSeenAt = new Date();
      return this.runnerRepo.save(existing);
    }
    const created = this.runnerRepo.create({
      name: agent.name,
      actorId: agent.id,
      status: SEAT_RUNTIME_STATUS.ONLINE,
      version: null,
      vendors: [],
      lastSeenAt: new Date(),
    });
    return this.runnerRepo.save(created);
  }

  /**
   * hello 到达后刷新 runner 元信息（version/vendors；hello payload 若携带可选 name
   * 字段则一并刷新——契约 v1 未冻结 name 字段，validateHelloPayload 不拒绝多余键，
   * 此处宽松读取向前兼容，缺省回退 agent 展示名）
   * @param runnerId runner id
   * @param hello hello payload（validatePayload 已通过）
   */
  async updateHelloInfo(runnerId: string, hello: HelloPayload): Promise<void> {
    const runner = await this.runnerRepo.findOne({ where: { id: runnerId } });
    if (!runner) {
      this.logger.warn(`updateHelloInfo: runner ${runnerId} not found`);
      return;
    }
    runner.version = hello.version;
    runner.vendors = [...hello.vendors];
    // 宽松读取可选 name（hello payload 为 Record<string, unknown> 的窄化，见类头注释）
    const raw = hello as HelloPayload & { name?: unknown };
    if (typeof raw.name === 'string' && raw.name.trim().length > 0) {
      runner.name = raw.name.trim();
    }
    runner.lastSeenAt = new Date();
    await this.runnerRepo.save(runner).catch((err: unknown) => {
      // 元信息刷新失败不阻断 hello 主流程（注册/绑定已成功），记日志由下次 hello 重试
      this.logger.error(`updateHelloInfo: save failed for runner ${runnerId}: ${String(err)}`);
    });
  }

  /**
   * 座位绑定（hello 后执行，M1 计划 §三 runner.gateway 职责）
   *
   * 绑定规则（§7 + M1 自审补）：`seat.config.bindActorId == runner actor id` 且
   * `seat.vendor ∈ hello.vendors` 且座位状态可绑定（active/offline——paused/parked
   * 留给 M3 座位管理，禁止被自动认领）。绑定落库（runner_id + status=active）后逐座位
   * 下行 seat.assign（携带完整 SeatConfig，runner 据此拉起会话）。
   * @param runnerId runner id
   * @param vendors runner 支持的厂商列表（hello 上报）
   * @returns 本轮绑定的座位行（空数组 = 无匹配座位）
   */
  async bindSeats(runnerId: string, vendors: SeatVendor[]): Promise<RoundtableSeat[]> {
    const entry = this.online.get(runnerId);
    if (!entry) {
      this.logger.warn(`bindSeats: runner ${runnerId} not online`);
      return [];
    }
    if (vendors.length === 0) {
      this.logger.warn(`bindSeats: runner ${runnerId} hello 未声明任何 vendor，无可绑定座位`);
      return [];
    }
    // 原生 JSON 表达式过滤 bindActorId 与 vendor（config jsonb 内嵌字段无法用普通
    // where 对象匹配；status IN ('active','offline') 排除 paused/parked）
    const seats = await this.seatRepo
      .createQueryBuilder('seat')
      .where(`seat.config->>'bindActorId' = :actorId`, { actorId: entry.actorId })
      .andWhere(`seat.vendor IN (:...vendors)`, { vendors: [...vendors] })
      .andWhere(
        `seat.status IN ('${SEAT_LIFECYCLE_STATUS.ACTIVE}', '${SEAT_LIFECYCLE_STATUS.OFFLINE}')`,
      )
      .getMany();
    const bound: RoundtableSeat[] = [];
    for (const seat of seats) {
      if (seat.runnerId === runnerId) {
        bound.push(seat);
        continue;
      }
      // 已被其他 runner 绑定的座位不抢（一 seat 一 runner；重连场景 runnerId 相同则复用）
      if (seat.runnerId && seat.runnerId !== runnerId) {
        this.logger.warn(
          `bindSeats: seat ${seat.id} already bound to runner ${seat.runnerId}, skip`,
        );
        continue;
      }
      seat.runnerId = runnerId;
      seat.status = SEAT_LIFECYCLE_STATUS.ACTIVE;
      await this.seatRepo.save(seat);
      bound.push(seat);
    }
    for (const seat of bound) {
      this.sendToRunner(runnerId, this.buildAssignEnvelope(seat));
    }
    this.logger.log(
      `bindSeats: runner ${runnerId} bound ${bound.length} seat(s): ${bound.map((s) => s.label).join(', ') || '-'}`,
    );
    return bound;
  }

  /** 装配 seat.assign 信封（SeatConfig 即 payload，§4 下行表） */
  private buildAssignEnvelope(seat: RoundtableSeat): Envelope {
    const payload: SeatAssignPayload = {
      seatId: seat.id,
      label: seat.label,
      vendor: seat.vendor as SeatVendor,
      cwd: String(seat.config?.cwd ?? ''),
      permissionMode: String(
        seat.config?.permissionMode ?? 'default',
      ) as SeatAssignPayload['permissionMode'],
    };
    if (typeof seat.config?.model === 'string' && seat.config.model.length > 0) {
      payload.model = seat.config.model;
    }
    return buildEnvelope('seat.assign', payload as unknown as Record<string, unknown>, {
      seatId: seat.id,
      seq: 0, // seat.assign 每次绑定独立下行，对账游标不适用（对账仅针对 seat.inject）
    });
  }

  /**
   * 向在线 runner 发送信封（协议收发只走 socket.send(JSON.stringify(envelope))，
   * 阶段 2 spike 结论：无任何 handler 返回通道）
   * @param runnerId 目标 runner
   * @param envelope 信封（调用方需保证 payload 通过 validatePayload）
   * @returns 是否发送成功（false = runner 离线，调用方自行决定兜底）
   */
  sendToRunner(runnerId: string, envelope: Envelope): boolean {
    const entry = this.online.get(runnerId);
    if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
      this.logger.warn(`sendToRunner: runner ${runnerId} offline, drop envelope ${envelope.type}`);
      return false;
    }
    entry.socket.send(JSON.stringify(envelope));
    return true;
  }

  /**
   * 连接断开清理（gateway handleDisconnect 调用）
   * 移除内存条目 + DB status=offline + 绑定座位 status=offline（重连后 bindSeats 恢复
   * active，M1 计划 §三 roundtable.service 断连职责）。
   * @param socket 断开的连接
   * @returns 该连接对应的 runnerId（无对应条目返回 null）
   */
  async unregisterBySocket(socket: WebSocket): Promise<string | null> {
    for (const [runnerId, entry] of this.online) {
      if (entry.socket !== socket) continue;
      this.online.delete(runnerId);
      this.clearPingTimer(entry);
      this.logger.log(`runner offline: ${runnerId}`);
      await this.runnerRepo
        .update({ id: runnerId }, { status: SEAT_RUNTIME_STATUS.OFFLINE, lastSeenAt: new Date() })
        .catch((err: unknown) => {
          this.logger.error(`unregister: runner ${runnerId} offline update failed: ${String(err)}`);
        });
      await this.seatRepo
        .update({ runnerId }, { status: SEAT_LIFECYCLE_STATUS.OFFLINE })
        .catch((err: unknown) => {
          this.logger.error(
            `unregister: seat offline update failed for runner ${runnerId}: ${String(err)}`,
          );
        });
      return runnerId;
    }
    return null;
  }

  /** 心跳应答刷新（pong 上行时调用；fire-and-forget，失败只记日志） */
  async touch(runnerId: string): Promise<void> {
    await this.runnerRepo
      .update({ id: runnerId }, { lastSeenAt: new Date() })
      .catch((err: unknown) => {
        this.logger.error(`touch: runner ${runnerId} lastSeenAt 更新失败: ${String(err)}`);
      });
  }

  /**
   * 查询 runner 在线状态与连接
   * @param runnerId runner id
   * @returns 在线条目（不存在/已断开返回 undefined）
   */
  getOnline(runnerId: string): OnlineRunnerEntry | undefined {
    return this.online.get(runnerId);
  }

  /**
   * 查询 runner 是否可注入（M2 阶段 3 失败回执触发点 A 判定；与 sendToRunner 同数据源
   * 同判据：在线表存在且 socket OPEN——getOnline 不查 socket 状态，断连竞态窗口
   * （DB status 未刷新）下可能误判在线，调用方需用本方法）
   * @param runnerId runner id
   * @returns 是否可下发信封
   */
  isRunnerOnline(runnerId: string): boolean {
    const entry = this.online.get(runnerId);
    return !!entry && entry.socket.readyState === entry.socket.OPEN;
  }

  /** 心跳定时器登记（gateway 建连后调用；disconnect/踢旧时自动清理） */
  attachPingTimer(runnerId: string, timer: NodeJS.Timeout): void {
    const entry = this.online.get(runnerId);
    if (entry) entry.pingTimer = timer;
  }

  private clearPingTimer(entry: OnlineRunnerEntry): void {
    if (entry.pingTimer) {
      clearInterval(entry.pingTimer);
      entry.pingTimer = undefined;
    }
  }
}

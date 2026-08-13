/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §2 (② 控制通道层: WebSocket 服务端)
 *   - 补充: docs/roundtable-design.md §4 (控制面协议: 信封/上行/下行/双向对账)
 *           docs/roundtable-design.md §7 (安全边界: WS 握手 API Key 认证, 注入面逐类型校验)
 *
 * [踩坑索引] WS-SPIKE-1(全局守卫不作用) WS-SPIKE-2(handler 返回值自动回发) WS-SPIKE-3(异常无帧) WS-SPIKE-4(eventemitter2 同步冒泡) RT-DEBT-2(hello_ack/上行游标: 长连接定期裁剪载体)
 *
 * [铁律关联] #9(代理层透传) #11(注释) #20(契约即设计) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条）
 *   RT-DEBT-2: runner 未确认队列的裁剪依据（上游游标）由本 gateway 下发——hello 处理后
 *      回 hello_ack（携带各座位 lastEventSeq + failedEventSeqs），30s 心跳 ping 顺带
 *      携带同款 seats 可选字段（长连接定期裁剪载体）；ping 每 tick 现装配（游标装配
 *      失败降级纯心跳，心跳不能断）。hello_ack 发送位置在 bindSeats 之后（seat.assign
 *      是 runner 业务前件，回执是清理收尾——gateway 集成测试断言首帧为 seat.assign）。
 *   WS-SPIKE-1: 全局 APP_GUARD/APP_INTERCEPTOR/APP_FILTER 不作用于 gateway；platform-ws
 *               适配器会把 handler 一切非 nil 返回值自动发回客户端，且 @SubscribeMessage
 *               线缆帧必须是 {event,data}（与冻结信封不兼容）→ 本 gateway 不用
 *               @SubscribeMessage，handleConnection 里裸 socket.on('message') 解析信封。
 *   WS-SPIKE-2: 握手认证 = handleConnection 内读 request.headers['x-api-key'] →
 *               ApiKeyAuthService.authenticate() → 失败 client.close(4401, reason)
 *               （禁止 NestJS WS guard 或自写 adapter）。
 *   WS-SPIKE-3: handler 抛异常客户端收不到任何帧 → 一切错误回执必须业务层显式
 *               socket.send(error 信封)。
 *   WS-SPIKE-4: eventemitter2 v6 listener 抛错同步冒泡出 emit → 注入 listener 三铁规
 *               （async 派发 + 异常自吞 + 按 messageId 自查）见 roundtable.service.ts。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import {
  buildEnvelope,
  validateEnvelope,
  validatePayload,
  type Envelope,
  type HelloPayload,
} from '@agent-chamber/roundtable-protocol';
import { ApiKeyAuthService } from '../../common/services/api-key-auth.service';
import type { AgentPayload } from '../../common/services/api-key-auth.service';
import { RunnerRegistryService } from './runner-registry.service';
import { RoundtableService } from './roundtable.service';

/** 心跳间隔（§4 下行表：ping 30s；runner 回 pong，chamber 顺手刷新 last_seen_at） */
const PING_INTERVAL_MS = 30_000;

/** 握手认证失败关闭码（spike 结论②实测可行；4400-4499 为应用自定义段） */
const WS_CLOSE_AUTH_FAILED = 4401;

/**
 * runner 控制面 WebSocket 服务端（chamber ②，平台首个 WS 服务端，M1 计划阶段 3）
 *
 * 传输面职责（不碰 topic 语义）：
 * - 握手认证：handleConnection 读 X-API-Key → ApiKeyAuthService.authenticate() →
 *   失败 close(4401)（spike 结论②）；成功 → registry.register（一 key 一 runner 踢旧）
 * - 信封收发：只走 socket.send(JSON.stringify(envelope))，无 @SubscribeMessage 返回通道
 *   （spike 结论①）；socket.on('message') 裸 JSON 解析 → validateEnvelope + validatePayload
 *   逐类型校验（§7 注入面）→ 按 type 分发（hello → 注册刷新/座位绑定/对账；seat.event →
 *   会话层；pong → 心跳应答）
 * - 心跳：每连接 30s 下行 ping 信封
 * - 断连：registry.unregisterBySocket 清理（DB offline + 座位 offline）+ 会话层
 *   onRunnerOffline 重置单飞行
 *
 * 错误回执（spike 结论③）：非法 JSON/信封/方向一律显式 error 信封回发，不抛异常。
 */
@WebSocketGateway({ path: '/ws/runner' })
@Injectable()
export class RunnerGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RunnerGateway.name);

  constructor(
    private readonly apiKeyAuth: ApiKeyAuthService,
    private readonly registry: RunnerRegistryService,
    private readonly roundtable: RoundtableService,
  ) {}

  /**
   * 连接建立：握手认证（X-API-Key header → AgentPayload）→ 注册（踢旧）→ 挂消息/心跳。
   * 竞态防护：handleConnection 是异步的（认证 + 注册），而客户端在 open 后即可发帧——
   * 若监听器挂晚了，早到的 hello 会丢（ws 不缓冲事件）。因此先挂缓冲监听器，注册完成
   * 后切换直通并回放缓冲帧。
   * @param client ws 连接
   * @param request HTTP upgrade 请求（platform-ws 的 connection 事件第二参数）
   */
  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    // 先挂缓冲监听器（未注册完成前的帧入缓冲，注册后回放）
    let runnerId: string | null = null;
    let registered = false;
    const pending: Buffer[] = [];
    client.on('message', (data) => {
      const raw = Buffer.isBuffer(data)
        ? data
        : Buffer.from(
            Array.isArray(data) ? data.map((d) => d.toString()).join('') : data.toString(),
          );
      if (registered && runnerId) {
        void this.handleMessage(client, runnerId, raw);
      } else {
        pending.push(raw);
      }
    });

    const apiKey = this.extractApiKey(request);
    if (!apiKey) {
      this.logger.warn('WS 握手拒绝: 缺少 X-API-Key header');
      this.closeWithReason(client, WS_CLOSE_AUTH_FAILED, 'missing X-API-Key header');
      return;
    }
    let agent: AgentPayload;
    try {
      agent = await this.apiKeyAuth.authenticate(apiKey);
    } catch (err) {
      // 铁律 #9：认证失败透传 4401 关闭（不包装成 500；错误详情记日志，客户端只见关闭码）
      this.logger.warn(`WS 握手拒绝: API Key 认证失败 — ${String(err)}`);
      this.closeWithReason(client, WS_CLOSE_AUTH_FAILED, 'invalid API key');
      return;
    }
    runnerId = await this.registry.register(agent, client);
    // 心跳（§4 下行表 ping 30s；RT-DEBT-2：ping 顺带携带上行游标 seats，runner 据此
    // 定期裁剪已确认送达的未确认队列——无逐条 ack 协议下的定期确认载体）；定时器随
    // 断连/踢旧由 registry 清理
    const pingTimer = setInterval(() => {
      void this.sendPingWithAck(runnerId!);
    }, PING_INTERVAL_MS);
    this.registry.attachPingTimer(runnerId, pingTimer);
    // 切换直通并回放缓冲帧（协议收发只走裸 message 事件——spike 结论①：
    // @SubscribeMessage 的 {event,data} 帧与冻结信封不兼容）
    registered = true;
    for (const raw of pending.splice(0)) {
      void this.handleMessage(client, runnerId, raw);
    }
    this.logger.log(`runner ${runnerId} 已认证并注册（agent ${agent.name}）`);
  }

  /** 连接断开：registry 清理（DB offline + 座位 offline）+ 会话层单飞行重置 */
  async handleDisconnect(client: WebSocket): Promise<void> {
    const runnerId = await this.registry.unregisterBySocket(client);
    if (runnerId) {
      await this.roundtable.onRunnerOffline(runnerId);
    }
  }

  /**
   * 信封分发入口（socket.on('message') 回调，含 try/catch 兜底——spike 结论③：
   * handler 抛异常客户端收不到任何帧，错误一律显式回执）
   */
  private async handleMessage(
    client: WebSocket,
    runnerId: string,
    data: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        this.sendError(client, 'INVALID_JSON', 'message is not valid JSON');
        return;
      }
      const envResult = validateEnvelope(raw);
      if (!envResult.ok) {
        this.sendError(client, 'INVALID_ENVELOPE', envResult.errors.join('; '));
        return;
      }
      const envelope = raw as Envelope;
      const payloadResult = validatePayload(envelope.type, envelope.payload);
      if (!payloadResult.ok) {
        this.sendError(client, 'INVALID_PAYLOAD', payloadResult.errors.join('; '));
        return;
      }
      switch (envelope.type) {
        case 'hello': {
          const hello = envelope.payload as unknown as HelloPayload;
          await this.registry.updateHelloInfo(runnerId, hello);
          // 绑定规则（§7 + M1 自审补）：bindActorId == runner actor 且 vendor ∈ hello.vendors
          await this.registry.bindSeats(runnerId, hello.vendors);
          // 双向对账（§4 可靠性）：下行缺口重建重放 + 内存队列 flush
          await this.roundtable.reconcile(runnerId, hello);
          // RT-DEBT-2：hello 回执（hello_ack 下行，阶段 5 新增）携带各座位上行游标
          // （lastEventSeq + failedEventSeqs）——runner 重放后据此裁剪「已确认送达」的
          // 未确认队列区间（重连对账完成即清已确认部分；无逐条 ack，回执即确认）。
          // 位置在 seat.assign 之后：绑定/对账是 runner 业务前件，回执是清理收尾。
          const ack = await this.roundtable.buildSeatAck(runnerId);
          this.registry.sendToRunner(
            runnerId,
            buildEnvelope('hello_ack', ack as unknown as Record<string, unknown>, {}),
          );
          break;
        }
        case 'seat.event':
          await this.roundtable.handleSeatEvent(runnerId, envelope);
          break;
        case 'pong':
          // 心跳应答：刷新 last_seen_at（fire-and-forget，失败只记日志）
          await this.registry.touch(runnerId);
          break;
        default:
          // 下行类型被 runner 上行 = 协议方向错误（spike 结论③：显式回执）
          this.sendError(
            client,
            'INVALID_DIRECTION',
            `${envelope.type} is a downlink-only message`,
          );
      }
    } catch (err) {
      // 兜底（正常路径业务错误已在各分支处理；这里只接意外异常，显式回执不静默）
      this.logger.error(`WS 消息处理异常 runner ${runnerId}: ${String(err)}`);
      this.sendError(client, 'INTERNAL', 'internal handler error, see chamber logs');
    }
  }

  /** 提取 X-API-Key header（string | string[] 归一；缺失返回 null） */
  private extractApiKey(request: IncomingMessage): string | null {
    const header = request.headers['x-api-key'];
    if (Array.isArray(header)) return header[0] ?? null;
    return header ?? null;
  }

  /**
   * 心跳 ping 下行（RT-DEBT-2）：携带上行游标 seats（可选字段，仅增——旧 runner 忽略
   * 多余键，缺省 `{}` 与旧协议兼容）。游标装配失败降级为纯心跳（心跳不能断）。
   */
  private async sendPingWithAck(runnerId: string): Promise<void> {
    try {
      const ack = await this.roundtable.buildSeatAck(runnerId);
      this.registry.sendToRunner(
        runnerId,
        buildEnvelope('ping', ack as unknown as Record<string, unknown>, {}),
      );
    } catch (err) {
      this.logger.warn(`ping 游标装配失败，降级纯心跳 runner ${runnerId}: ${String(err)}`);
      this.registry.sendToRunner(runnerId, buildEnvelope('ping', {}, {}));
    }
  }

  /** 认证失败关闭（spike 结论②：close(4401) 已实测可行） */
  private closeWithReason(client: WebSocket, code: number, reason: string): void {
    try {
      client.close(code, reason);
    } catch (err) {
      // 连接已处于关闭态时 close 抛错，忽略
      this.logger.debug(`close ${code} failed: ${String(err)}`);
    }
  }

  /** 显式错误信封回执（spike 结论③；error 为无座位归属消息，seq=0） */
  private sendError(client: WebSocket, code: string, message: string): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(buildEnvelope('error', { code, message }, {})));
    }
  }
}

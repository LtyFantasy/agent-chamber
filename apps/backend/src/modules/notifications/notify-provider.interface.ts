/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块的**出口端口**：渲染好的通知 → 某个外部 IM 渠道的一次投递尝试。
 *     端口是 provider 叶子与编排器之间**唯一的契约面**（飞书是本期唯一实现，S3 落地）。
 *
 * [代码职责]
 *   - `NotifyProvider`：`key`（= 投递记录 `channel` 列的值）+ `send()`（**never-throw**）
 *   - `RenderedNotification`：编排器交给 provider 的成品（标题 / 正文 / 深链 / 收件人）
 *     — **出境字段的边界就在这里**（provider 只允许看见这些字段，见 [关键不变量]）
 *   - `DeliveryOutcome`：一次投递的**终态**（成功/失败 + 尝试数 + 错误摘要）→ 投递记录行
 *   - DI token `NOTIFY_PROVIDER_LIST`（值为 `NotifyProvider[]`，由工厂按配置装配）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §3 架构（ProviderRegistry 段）/
 *     §6 数据层（`channel` / `status` / `attempts` / `last_error` 列的语义出处）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`；
 *     落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **never-throw 是硬契约**：一切失败（超时 / DNS / 连接拒绝 / 非 2xx / 体不可解析）都必须
 *     落在 `DeliveryOutcome.status='failed'`，**绝不抛异常**。理由：本端口由编排器的
 *     `void` fire-and-forget 管线调用——抛出 = 未捕获 rejection = Node 22 默认崩进程
 *     （plan §2 探针实证，本仓无全局 unhandledRejection 处理器）。provider 叶子必须自己吞。
 *   - **`RenderedNotification` 就是出境面**：provider 只能看见这里的字段（标题 / 正文 / 链接 /
 *     收件人 / 类别 / 事件 id）。**给这个类型加字段 = 扩大出境面**——必须同 commit 更新
 *     `config/notifications.config.ts` 的 `NOTIFY_EGRESS_FIELDS` 声明（单源，三处引用）。
 *   - **`attempts` 恒 ≥ 1**：即使 provider 在发起请求前就短路（未启用 / 无收件人），也要记
 *     `attempts: 1`——投递行的语义是"尝试过一次"，不是"发过字节"。
 *   - **`lastError` 只放短描述**：**绝不回显上游响应体原文**（可能夹带 token 片段），
 *     写入侧另有 500 字符截断（见 `notify-delivery.repository.ts`）。
 *   - **`key` 必须等于投递记录 `channel` 列的取值**（一期恒 `'feishu'`）：两个概念一个名字，
 *     否则 admin 列表按 channel 过滤会对不上 provider 白名单。
 *   - **端口不认识节流 / 幂等 / 自回声**：那些是编排器的职责。provider 只管"发这一条"。
 *   - **重试预算由调用方给**（`NotifySendOptions`，S3 加）：叶子只认"最多几次、总共多长"，
 *     两条链路的等待哲学天差地别（事件链路 fire-and-forget 可退避 1s/2s；直发链路同步等待、
 *     总预算 ≤10s）。⚠️ 缺省值仍是**事件链路档**（不含预算上限）——直发调用方必须显式传小预算，
 *     否则一次端点请求会被退避拖过 agent 的客户端超时。
 *
 * [关联代码]
 *   - notifications-provider.factory.ts — 本 token 的装配点（按 `NOTIFY_PROVIDERS` 分派 + 诊断）
 *   - feishu.notify-provider.ts — 一期唯一实现（S3 真身：token 缓存 + 退避 + 错误分派）
 *   - notify-orchestrator.service.ts — 唯一消费者（遍历激活 provider 投递 + 终态落库）
 *   - ../../config/notifications.config.ts — `NOTIFY_PROVIDERS` 值域与 `NOTIFY_EGRESS_FIELDS` 声明
 *   - ../database/entities/notification-delivery.entity.ts — `channel` / `status` 列的落库值域
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 provider 实现必须同步 config 值域 + 工厂分派 + 双份 spec 矩阵（枚举一致性断言会红）
 *   □ 新增 `RenderedNotification` 字段必须同 commit 更新出境字段声明（见 [关键不变量]）
 *   □ 改 `NotifySendOptions` 字段必须同步 feishu 叶子的预算解析（缺省档 + 夹逼）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type {
  NotificationDeliveryCategory,
  NotificationDeliveryStatus,
} from '../../database/entities/notification-delivery.entity';

/**
 * 编排器交给 provider 的**成品通知**（= 出境面，见文件头 [关键不变量]）。
 *
 * 渲染（标题 / 正文截断 / 深链拼接）在编排器完成——provider 不做任何内容加工，只做传输。
 * 这条分工的收益：出境字段的集合只有一个决定点（编排器的渲染函数 + 本类型），
 * 分散到各 provider = 每加一个渠道就要重新审计一次"发出去的是什么"。
 *
 * ⚠️ **正文宽度按类别分层**（单源 = `notify-orchestrator.service.ts` 的两个导出常量）：
 * topic / digest **100**（预览语义）、task / doc **200**（归属信息是消息本体）、
 * direct **≤2000**（agent 自填）。provider 侧**不得**再做任何宽度假设或二次截断。
 */
export interface RenderedNotification {
  /** 通知类别（投递记录 `category` 列的值；含 L2 摘要的 `digest`） */
  category: NotificationDeliveryCategory;
  /** 触发本通知的事件 ID（**直发为 null**；无 FK 弱关联，见实体文件头） */
  eventId: string | null;
  /** 标题（已渲染；≤200 字符由渲染层保证，与列宽一致） */
  title: string;
  /**
   * 正文（已渲染；**深链不在这里**，它是独立的 `link` 字段）。
   * 宽度**按类别分层**（topic/digest 100、task/doc 200、direct ≤2000）——单源见
   * `notify-orchestrator.service.ts` 的 `NOTIFICATION_SUMMARY_MAX_LENGTH` /
   * `NOTIFICATION_BODY_MAX_LENGTH`，**别在本层假设 100**。
   */
  body: string;
  /** 深链（**绝对 URL**：`NOTIFY_WEB_BASE_URL` + 资源路径；无基址时为 null） */
  link: string | null;
  /** 收件人地址（飞书 = open_id；由 config `FEISHU_RECIPIENT_OPEN_ID` 决定，不经调用方传入） */
  recipient: string;
}

/**
 * 一次投递尝试的**终态**（→ 投递记录行的非主键字段）。
 *
 * `status` 复用实体侧的两态值域（`success` | `failed`）：端口不引入第三态，
 * 否则投递记录表的 `status` 列值域就要有第二个来源。
 */
export interface DeliveryOutcome {
  /** 终态（`success` | `failed`） */
  status: NotificationDeliveryStatus;
  /** 实际尝试次数（**恒 ≥ 1**，含未发字节的短路尝试） */
  attempts: number;
  /** provider HTTP 响应码（网络层失败 / 未拿到响应为 null） */
  responseStatus: number | null;
  /** 失败短描述（成功恒 null；**绝不回显响应体原文 / secret**，写入侧再截断 500 字符） */
  lastError: string | null;
  /** 送达时刻（success 写入；failed 恒 null） */
  deliveredAt: Date | null;
  /**
   * 失败**归因分类**（可选；Notifications 二期 M6）——只有 provider 知道自己是"地址被拒"还是
   * "上游/网络抖了"，消费方（test 端点的验证态写入）据此决定**是否把这笔账记到地址头上**：
   * - `'address'`：消息端点**拒绝了这次投递请求本身**（4xx / 业务码拒绝，如 receive_id 非法、
   *   机器人不在会话）⇒ 重试同一个地址不会变好；
   * - `'provider'`：上游侧问题（5xx / 鉴权 / 频控 / 响应体不可解析 / 凭据未配 / 未分类）；
   * - `'transport'`：**没拿到任何 HTTP 响应**（超时 / DNS / 连接拒绝）。
   *
   * ⚠️ **可选**是刻意的（兼容契约）：不填 = 调用方按"未分类"处置——编排器与直发链路只把
   * 它当透传字段（不改变任何既有行为）；**只有** test 端点的验证态写入会读它，且
   * 未分类/`provider`/`transport` 一律**不写验证态**（保守方向：绝不因上游抖动把用户已
   * 验证的地址打成失败，那会让用户静默掉出可投递集合）。
   */
  failureKind?: DeliveryFailureKind;
}

/** 失败归因分类（见 {@link DeliveryOutcome.failureKind}） */
export type DeliveryFailureKind = 'address' | 'provider' | 'transport';

/**
 * 一次投递的**重试预算**（可选；缺省 = 事件链路的保守档）。
 *
 * 为什么由调用方传而不写死在 provider 里：**两条链路的等待预算天差地别**——
 * 事件链路是 fire-and-forget（没人等，退避 1s/2s 不心疼，plan §3 给到 3 次尝试）；
 * 直发链路（S4，`POST /notifications/messages`）是**同步等待**的 HTTP 端点，agent 的
 * 客户端有超时保护，必须把总预算钉死在 ≤2 次尝试 / ≤10s 内（plan §7.1）。
 * 把这两个数字放在调用点而不是叶子内部：叶子只认"给我多少次、多长时间"。
 */
export interface NotifySendOptions {
  /**
   * 最多尝试次数（**含首次**；≥1）。
   *
   * 缺省 = 事件链路档（provider 叶子自己的常量，飞书为 3 次）。传 1 = 不重试。
   */
  maxAttempts?: number;
  /**
   * 总预算（毫秒，**从 `send` 进入起算**；≥1）。触及即停：不再发起下一次尝试。
   *
   * `undefined` = 不设总预算（事件链路的缺省：单次请求仍受 `NOTIFY_HTTP_TIMEOUT_MS` 约束）。
   * 单次请求的超时会被夹到**剩余预算**内——否则"预算 10s"会被一次 8s 超时 + 退避穿透。
   */
  budgetMs?: number;
}

/**
 * 通知出口端口（一个 provider 叶子实现一个外部 IM 渠道）。
 *
 * `send` 的 **never-throw 是硬契约**（见文件头 [关键不变量]）：调用方按 fire-and-forget
 * 管线调用它，抛出即崩进程。
 */
export interface NotifyProvider {
  /** 出口标识（= 投递记录 `channel` 列取值；一期只有 `'feishu'`） */
  readonly key: string;
  /**
   * 投递一条成品通知。
   *
   * @param notification 已渲染的通知（出境面，见 {@link RenderedNotification}）
   * @param opts 重试预算（可选；缺省 = 事件链路档，见 {@link NotifySendOptions}）
   * @returns 终态结果（**失败也必须 resolve**，不得 reject）
   */
  send(notification: RenderedNotification, opts?: NotifySendOptions): Promise<DeliveryOutcome>;
}

/**
 * 激活 provider 列表的注入 token。
 *
 * 值为 `NotifyProvider[]`（**有序**：按 `NOTIFY_PROVIDERS` 的出现顺序，便于启动日志与单测断言）。
 * 空数组 = 没有任何出口（`NOTIFY_PROVIDERS` 为空或全部未知）——此时编排器对每次投递
 * **丢弃 + 打一行 INFO `dropped [no_provider]`，且不落投递行**（投递行的语义是"尝试过一次"，
 * 没有出口就没有尝试，见 orchestrator / repository 文件头），而不是静默丢弃。
 * ⚠️ 不要把这里的 `no_provider` 与**直发端点信封的 reason 值域**（S4）混为一谈——后者是给调用
 * agent 的机器可读理由，本层这个只是日志标记。
 *
 * provider 工厂在配置被 `overrideProvider` 替换时同样可替换（e2e 注入内存 fake 断言全链路）。
 */
export const NOTIFY_PROVIDER_LIST = 'NOTIFY_PROVIDER_LIST';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 投递记录的**唯一读写入口**：把一次投递的终态写进 `notification_deliveries`
 *     （append-only，只落终态）。
 *
 * [代码职责]
 *   - `record()`：写入一行终态投递记录（**唯一写路径**），负责两条列级契约的落实：
 *     ① `last_error` 截断 500 字符（列宽是 text，截断是**应用层**契约）；
 *     ② `attempts` 归一为 ≥ 1（端口契约要求，防御性兜底）。
 *   - `findAll()`：**admin 只读列表的读路径**（分页 + category/status 过滤 + createdAt/id 全序），
 *     与 `record()` 同为本文件的对外面（读侧于 S4 落地）。
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §6 数据层（逐列契约）/
 *     §8 S4 实施步骤（admin 列表端点的形状：`{items,total,page,pageSize,totalPages,hasNext,hasPrev}`）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`；
 *     落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **写入永不抛**：`record()` 由 fire-and-forget 管线调用（编排器的 `void` promise），
 *     任何 DB 抖动都不得让进程崩——失败只记 error 日志（**落库失败 = 丢一条审计行，
 *     不是丢一条通知**：通知已经发出去了，这里丢的只是"账本"）。这条是刻意的取舍：
 *     为了账本行去重试/抛出，会把一次 DB 抖动升级成进程级故障。
 *   - **只落终态**：`status ∈ {success, failed}`，本文件不产生第三态；抑制类事件（自回声 /
 *     类别关 / 节流命中）**根本不会走到这里**（见实体文件头 [关键不变量]）。
 *   - **`last_error` 截断到 500 字符**（`LAST_ERROR_MAX_LENGTH`）：上游响应体可能很长且可能
 *     回显凭据——截断 + provider 侧只放短描述，两道防线缺一不可。
 *   - **`eventId` 原样落库（可空）**：**不做存在性校验、不建 FK**——弱关联是本表的设计
 *     （日志须比事件行活得久，见实体文件头）。
 *
 * [关联代码]
 *   - ../database/entities/notification-delivery.entity.ts — 表契约（`NOTIFICATION_DELIVERY_STATUSES` /
 *     `DIGEST_DELIVERY_CATEGORY` 单源）
 *   - notify-orchestrator.service.ts — 事件链路的写调用方（投递终态落库）
 *   - notifications.controller.ts — admin 列表端点的调用方（本文件 `findAll()` 的唯一消费者）
 *   - dto/query-notification-deliveries.dto.ts — 查询契约（分页/过滤值域；`findAll()` 的入参形状）
 *   - notify-provider.interface.ts — `DeliveryOutcome`（本文件 `record()` 的输入形状）
 *
 * [持久踩坑]
 *   NOTIFY-LEDGER-BLOCKS-DELIVERY(账本拖垮投递): 若 `record()` 抛错并冒泡，一次 PG 抖动会让
 *     整条 `void` 管线变成未捕获 rejection（Node 22 默认崩进程）。安全方向: 本方法内部
 *     全包 try/catch + error 日志，**永不抛**。
 *
 * [铁律关联] #11(注释强制) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ S4 补读路径时保持"唯一入口"纪律（不要在 service 里直接注入 Repository）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { NotificationDelivery } from '../../database/entities/notification-delivery.entity';
import type { DeliveryOutcome } from './notify-provider.interface';
import type { QueryNotificationDeliveriesDto } from './dto/query-notification-deliveries.dto';
import { NOTIFY_DEFAULT_PAGE_SIZE, NOTIFY_MAX_PAGE_SIZE } from './notifications.constants';

/**
 * `last_error` 的落库长度上限（**应用层契约**，列宽是 text 不代劳）。
 *
 * rationale：上游错误体可能长达数 KB 且可能回显 token 片段——截断既防表膨胀，
 * 也让"日志/列表里看到的错误"保持可读。500 与 `.env.example` / provider 文案的口径一致。
 */
export const LAST_ERROR_MAX_LENGTH = 500;

/**
 * 写入一行的入参（= 投递上下文 + 终态结果）。
 *
 * `channel` 与 `category` 由调用方给出（编排器知道自己在投哪个 provider、哪一类），
 * 不从 `outcome` 里反推——终态结果只描述"结果"，不描述"投了什么"。
 */
export interface RecordDeliveryInput {
  /** 渠道（= provider key，如 `feishu`） */
  channel: string;
  /** 收件人（飞书 open_id） */
  recipient: string;
  /** 通知类别（值域单源 = `NOTIFY_CATEGORIES`） */
  category: string;
  /** 触发事件 ID（直发为 null） */
  eventId: string | null;
  /** 已渲染标题（≤200 字符由渲染层保证） */
  title: string;
  /** 已渲染正文 */
  body: string;
  /** provider 返回的终态 */
  outcome: DeliveryOutcome;
  /**
   * 这条投递归属的平台用户（`users.id`；可选）。
   *
   * ⚠️ **四条写路径已全部落值**（Notifications 二期批 2 棒 B 收口）：编排器 deliver
   * （`NotifyRecipient.userId`）/ L2 摘要（`L2Window.recipientUserId`）/ 直发（调用 agent 的
   * `ownerId`）/ test 端点（当前用户）。字段仍是**可选**的（存量调用方与将来的旁路不该被类型
   * 绑架），落库时缺省 `null` = "**尚未归属**"，**不是**"不属于任何人"——admin 的
   * `recipientUserId` 过滤刻意不命中 NULL 行（见 `findAll` 的注释）。
   */
  recipientUserId?: string | null;
}

/**
 * 投递记录分页信封（**形状单源**：与 webhook 的 `findAll` 同形——运维在两个列表之间平移
 * 习惯时不需要重新理解字段名）。
 */
export interface NotificationDeliveryPage {
  /** 本页的行（`createdAt DESC, id DESC` 全序） */
  items: NotificationDelivery[];
  /** 过滤条件下的总行数（不受分页影响） */
  total: number;
  /** 当前页码（1 起） */
  page: number;
  /** 每页条数（已夹到 `NOTIFY_MAX_PAGE_SIZE` 以内） */
  pageSize: number;
  /** 总页数（`total = 0` 时为 0） */
  totalPages: number;
  /** 是否还有下一页 */
  hasNext: boolean;
  /** 是否还有上一页 */
  hasPrev: boolean;
}

/**
 * 投递记录仓库（**唯一读写入口**：写侧 `record()` + 读侧 `findAll()`）。
 */
@Injectable()
export class NotifyDeliveryRepository {
  private readonly logger = new Logger(NotifyDeliveryRepository.name);

  constructor(
    @InjectRepository(NotificationDelivery)
    private readonly deliveryRepo: Repository<NotificationDelivery>,
  ) {}

  /**
   * 写入一行投递终态记录（**永不抛**，见文件头 [关键不变量]）。
   *
   * @param input 投递上下文 + 终态结果
   */
  async record(input: RecordDeliveryInput): Promise<void> {
    try {
      const { outcome } = input;
      await this.deliveryRepo.save(
        this.deliveryRepo.create({
          channel: input.channel,
          recipient: input.recipient,
          category: input.category as NotificationDelivery['category'],
          eventId: input.eventId,
          title: input.title,
          body: input.body,
          status: outcome.status,
          // 端口契约要求 attempts ≥ 1；这里再兜一层（防御 provider 实现写漏）
          attempts: Math.max(1, Math.floor(outcome.attempts)),
          // 截断是**应用层**契约（见文件头不变量）；null 透传（成功没有错误可记）
          lastError: truncateLastError(outcome.lastError),
          responseStatus: outcome.responseStatus,
          deliveredAt: outcome.deliveredAt,
          // 归属用户（Notifications 二期）：批 1 仅 test 端点传值，其余路径缺省 null
          recipientUserId: input.recipientUserId ?? null,
        }),
      );
    } catch (err) {
      // 落库失败 = 丢一条审计行，不是丢一条通知（通知已经发出去了）——只记 error，绝不抛。
      this.logger.error(
        `failed to record notification delivery (category=${input.category}, ` +
          `channel=${input.channel}): ${String(err)}`,
      );
    }
  }

  /**
   * 分页读取投递记录（**admin 只读列表的唯一数据入口**，S4）。
   *
   * 语义要点：
   * - **只读**：本表 append-only 无更新语义（见实体文件头），故这里没有写回路径；
   * - **全序**：`createdAt DESC, id DESC`。只按 `createdAt DESC` 排序时，同一时刻落库的多行
   *   （直发端点在同一个循环里连投多个 provider、或事件链路在毫秒内连发）在翻页时会因
   *   tie-break 不确定而**漏行或重复**——experience judgments 的全序索引是同一个教训；
   * - **过滤在 DB 做**（不拉全表再筛）：`category` / `status` 直接进 `where`，`total` 是
   *   过滤后的真值（分页信封里的 `total` 必须与过滤一致，否则前端页码会算错）；
   * - **夹逼**：`pageSize` 上限 `NOTIFY_MAX_PAGE_SIZE`（DTO 已挡一层，这里是服务层兜底——
   *   铁律 #21 的第二层；本方法的另一个调用方（将来的导出/运维脚本）不经过 DTO）。
   *
   * @param query 查询参数（缺省：第 1 页 / `NOTIFY_DEFAULT_PAGE_SIZE` 条 / 不过滤）
   * @returns 分页信封（形状见 {@link NotificationDeliveryPage}）
   */
  async findAll(query: QueryNotificationDeliveriesDto): Promise<NotificationDeliveryPage> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const requested =
      query.pageSize && query.pageSize > 0 ? query.pageSize : NOTIFY_DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(requested, NOTIFY_MAX_PAGE_SIZE);

    // 只放"真的传了"的过滤条件：`{}` 会被 TypeORM 当成无条件（与不传等价），
    // 但显式构造能让"过滤了但值恰好是 undefined"这类静默失效不可能发生
    const where: FindOptionsWhere<NotificationDelivery> = {};
    if (query.category) where.category = query.category;
    if (query.status) where.status = query.status;
    // Notifications 二期：按平台用户过滤（服务层第二层构造，见 DTO 注释）。NULL 归属的行
    // 刻意不命中（"未归属" ≠ "属于该用户"——用 OR IS NULL 会把存量行全混进来）。
    if (query.recipientUserId) where.recipientUserId = query.recipientUserId;

    const [items, total] = await this.deliveryRepo.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
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
}

/**
 * `last_error` 截断（单源在本文件；见文件头不变量）。
 *
 * @param raw provider 给出的失败短描述（可为 null）
 * @returns 截断后的字符串，或 null
 */
export function truncateLastError(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.length > LAST_ERROR_MAX_LENGTH ? raw.slice(0, LAST_ERROR_MAX_LENGTH) : raw;
}

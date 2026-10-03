/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件对象回收三轨：软删行超期清扫（每日）+ 孤儿对象清扫（每周）+
 *     过期附件物理回收（每小时，v1.90.0-dev）
 *
 * [代码职责]
 *   - `sweepSoftDeletedOlderThan()`：软删超 30 天行 → 删对象（原图+缩略图）→ 硬删行
 *   - `sweepOrphanObjectsOlderThan()`：桶内无行对应的对象 → 删对象（保护集 = 全表双列）
 *   - `sweepExpiredAttachmentsOlderThan()`：TTL 过期行 → 删对象 → **行照硬删**（无恢复窗口）
 *   - 三轨都不写 audit（系统行为，logger 记录）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / GC)
 *   - 补充: docs/api-definition.md §16a — TTL 过期语义（410 / 扫前扫后 / 无恢复窗口）
 *   - 补充: docs/database.md — attachments 三轨 GC 与 idx_attachments_expires_gc
 *
 * [关键不变量]
 *   - 软删行查询必须显式取 deleted_at（select:false 列需 addSelect）
 *   - 孤儿保护集必须 withDeleted 全表取 objectKey + **thumbKey 双列**：保留期内的
 *     软删行对象/缩略图都还合法，漏一列即误删（缩略图是独立键，无行与之对应）
 *   - 孤儿删除必须过 grace：新对象（含在途上传、保护集快照竞态）一律不删
 *   - 过期回收谓词**钉死** `expires_at < now() AND deleted_at IS NULL`：与
 *     `idx_attachments_expires_gc` 的 partial 谓词精确匹配（否则全表扫）；
 *     且不得吞掉软删行的 30d 管道（软删且过期的行归轨道一）
 *   - 过期回收**必须分批**（`take(EXPIRED_SWEEP_BATCH_SIZE)` + 外层循环）：
 *     整批同时到期时单轮会超过 cron 周期（1h），与下一轮重叠反而放大压力；
 *     "整批 delete 影响 0 行"必须终止本轮（防并发软删导致的死循环）
 *   - 过期硬删**必须带 `deletedAt: IsNull()` 谓词**（TOCTOU 守卫）：命中后被用户
 *     并发软删的行不得硬删，保住其 30d 恢复窗口（该行归轨道一）；`hardDeleted`
 *     按 `affected` 累加（计数真实化），不是"循环了几行"
 *   - 过期回收 cron **受 isTestEnv 控制**（`ATTACHMENT_EXPIRED_SWEEP_ENABLED`）：
 *     测试环境不执行——否则 410 用例会因整点 :11 的物理回收变 404（e2e flaky）
 *   - `onApplicationBootstrap` 只调轨道一（启动补扫不做全表过期删除与全桶列举：
 *     MinIO 不可达时拖慢启动）
 *   - 对象删除逐键 try/catch：单键失败只计数并留待下轮，不牵连其它对象/行
 *   - GC 永不写 audit（本服务无 audit 依赖——结构性保证；TTL 到期是确定性事件，
 *     等价 S3 lifecycle，故过期硬删同样不留 audit）
 *
 * [关联代码]
 *   - storage.service.ts — listObjects/removeObject 对象层入口
 *   - ../database/entities/attachment.entity.ts — object_key/thumb_key/expires_at/deleted_at 列语义
 *   - attachment.constants.ts — ATTACHMENT_EXPIRED_SWEEP_ENABLED（测试环境开关）
 *   - test/attachments-orphan-sweep.e2e-spec.ts — 真 MinIO 双保护 + grace 验证入口
 *
 * [持久踩坑]
 *   P2-ORPHAN(双列保护): 孤儿清扫若只保护 object_key，会误删全部缩略图对象
 *     （thumb_key 是独立 uuid 键、任何行的 object_key 都不等于它）。安全方向:
 *     双列建 Set + 必测"软删行 thumb 对象仍保留"。
 *   TTL-SWEEP-FLAKY(cron 与测试中间态): 小时级过期回收若在测试环境注册，跨过
 *     整点 :11 会把"过期但行仍在"的 410 用例翻成 404。安全方向: cron 受
 *     isTestEnv 控制（disabled），e2e 构造过期态一律走"关 sweep + 直改 DB"。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Attachment } from '../../database/entities/attachment.entity';
import { AttachmentStorageService } from './storage.service';
import { ATTACHMENT_EXPIRED_SWEEP_ENABLED, EXPIRED_SWEEP_BATCH_SIZE } from './attachment.constants';

/**
 * 软删保留期（plan §3.7 钉死 30 天）：软删行超过该窗口后硬删并清对象。
 * 30 天的取舍：给"误删恢复/审计追溯"留足人工窗口，同时把 MinIO 对象
 * 体积增长限制在月级线性以内（配额在软删时已释放，这里清的是存储成本）。
 */
export const ATTACHMENT_GC_RETENTION_DAYS = 30;

/**
 * 孤儿对象 grace 窗口（1 小时，P2 批 4）。
 *
 * 为什么必须有：上传是"先落对象、后插行"（见 attachment.service.ts upload 的插入点），
 * 两者之间对象已存在但无行；若清扫此刻介入就会删掉在途上传的对象。
 * 1h 远大于一次上传的最长耗时（10MiB 传输 + sharp 缩略图 + 配额事务），
 * 又不至于让真孤儿（DELETE/GC 删对象失败留下的尾巴）长期占存储。
 */
export const ATTACHMENT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * 计数日志抽样 key 条数上限（PM M8 可见性要求：扫到多少、删了多少、删了哪些——
 * 让运维能抽查清扫是否误伤，不必翻对象存储审计）。非安全参数。
 */
export const ORPHAN_SWEEP_SAMPLE_LIMIT = 10;

/** 孤儿清扫计数结果（cron 入口与核心方法共用；全量落 logger） */
export interface OrphanSweepResult {
  /** 列举到的对象数（含被保护的合法对象） */
  scanned: number;
  /** 实际删除的孤儿对象数 */
  deleted: number;
  /** grace 窗口内的新对象（含在途上传对象）——跳过不删 */
  skippedFresh: number;
  /** 列举未返回时间戳的对象——年龄不可证，保守跳过不删 */
  skippedUnknownAge: number;
  /** 删除失败的对象数（记日志继续；下轮清扫自然重试，MinIO 删除幂等） */
  failures: number;
}

/**
 * 过期附件回收计数结果（v1.90.0-dev §1.3；轨道三：小时级过期硬回收）。
 * 语义与轨道一同形（scanned/hardDeleted/objectFailures），刻意复用同字段名降低读成本。
 */
export interface ExpiredSweepResult {
  /** 命中的过期行数（`expires_at < now() AND deleted_at IS NULL`） */
  scanned: number;
  /** 实际硬删的行数（删对象失败也照删——容错与轨道一同款） */
  hardDeleted: number;
  /** 对象删除失败次数（原图/缩略图各计一次；残留对象归每周孤儿清扫） */
  objectFailures: number;
}

/**
 * 过期回收 INFO 抽样条数上限（N6 取证面：id/uploaderId/expiresAt 前 N 条——
 * 让运维能抽查"哪些附件在什么时候被过期回收"，不必翻对象存储审计）。
 * 非安全参数；与 ORPHAN_SWEEP_SAMPLE_LIMIT 同值同规。
 */
export const EXPIRED_SWEEP_SAMPLE_LIMIT = 10;

/**
 * 附件对象回收服务（plan §3.7 软删清扫 + P2 批 4 孤儿清扫 + v1.90.0-dev 过期回收）。
 *
 * 轨道一（每日，本类下方）：软删超 30 天行 → 删 MinIO 对象（**原图 + 缩略图
 * 双键**，幂等——MinIO 对不存在键返回成功，DELETE 端点删对象失败留下的尾巴由
 * 这里重试）→ 硬删行。失败语义：删对象失败仅记日志并继续（行照硬删）——
 * 不能让单个坏对象卡死整批 GC。
 *
 * 轨道二（每周，`sweepOrphanObjects`）：桶内对象与全表（withDeleted）object_key +
 * thumb_key 双列比对，无对应行的对象判为孤儿删除；1h grace 保护在途上传。
 *
 * 轨道三（每小时，`sweepExpiredAttachments`，v1.90.0-dev）：TTL 过期行（`expires_at <
 * now() AND deleted_at IS NULL`）→ 删双键对象 → **行照硬删**。与轨道一的区别：
 * 无 30 天保留窗口（TTL 到期是确定性事件，等价 S3 lifecycle，不留人工恢复窗口），
 * 且只处理"活的过期行"（软删行的 30d 管道仍归轨道一）。
 * 三轨互补：轨道一按行驱动（软删行→清对象）、轨道二按对象驱动（有对象→无行即清）、
 * 轨道三按 TTL 驱动（过期活行→清对象 + 行）。
 *
 * 边界（plan 钉死）：
 * - GC 不写 audit（系统行为；logger 记录全量动作，三轨同规）；
 * - 软删行查询必须显式取 deleted_at：Attachment.deletedAt 是
 *   DeleteDateColumn({ select: false })，queryBuilder 需 addSelect 才拿得到值
 *   （ WHERE 条件本身不受 select:false 影响，但此处要按它算窗口）。
 *
 * 调度：每日 03:17 软删清扫（+ onApplicationBootstrap 补扫一次，fire-and-forget：
 * 不 await 阻塞启动——MinIO 不可达时 sweep 内部逐对象失败记日志，拖慢启动无收益）；
 * 每周日 04:42 孤儿清扫（无启动补扫——全桶列举开销大，不值得为启动省几小时延迟）；
 * 每小时 :11 过期回收（**无启动补扫**——同 N2 理由；且测试环境不注册，见 N3）。
 */
@Injectable()
export class AttachmentGcService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttachmentGcService.name);

  constructor(
    @InjectRepository(Attachment)
    private readonly attachmentRepo: Repository<Attachment>,
    private readonly storage: AttachmentStorageService,
  ) {}

  /** 启动补扫（fire-and-forget，错误自吞——sweep 内部已有逐项兜底） */
  onApplicationBootstrap(): void {
    void this.sweepExpired().catch((err) =>
      this.logger.error(`Startup sweep failed: ${(err as Error).message}`, (err as Error).stack),
    );
  }

  /** 每日 03:17 定时清扫 */
  @Cron('17 3 * * *')
  async sweepExpired(): Promise<{ scanned: number; hardDeleted: number; objectFailures: number }> {
    return this.sweepSoftDeletedOlderThan(ATTACHMENT_GC_RETENTION_DAYS);
  }

  /**
   * 核心清扫逻辑（独立方法便于直测）。
   *
   * @param retentionDays 软删保留天数窗口
   * @returns 扫描/硬删/对象删除失败计数（logger 记录，调用方可观测）
   */
  async sweepSoftDeletedOlderThan(
    retentionDays: number,
  ): Promise<{ scanned: number; hardDeleted: number; objectFailures: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // withDeleted() 解除软删过滤 + addSelect 显式取 deleted_at（select:false 列）
    const expired = await this.attachmentRepo
      .createQueryBuilder('a')
      .withDeleted()
      .addSelect('a.deletedAt')
      .where('a.deleted_at IS NOT NULL')
      .andWhere('a.deleted_at < :cutoff', { cutoff })
      .getMany();

    let hardDeleted = 0;
    let objectFailures = 0;
    for (const row of expired) {
      // 原图 + 缩略图双删（P2 批 1）：两键独立 try/catch——一个坏对象不牵连
      // 另一个；失败记日志继续，行照硬删（残留对象归 P2 批 4 孤儿清扫）
      for (const key of [row.objectKey, row.thumbKey]) {
        if (!key) continue;
        try {
          await this.storage.removeObject(key);
        } catch (err) {
          objectFailures += 1;
          this.logger.error(
            `GC removeObject failed (id=${row.id}, key=${key}), ` +
              `hard-delete row anyway; orphan object left for P2 sweep: ${(err as Error).message}`,
          );
        }
      }
      await this.attachmentRepo.delete({ id: row.id });
      hardDeleted += 1;
    }

    this.logger.log(
      `GC sweep done: scanned=${expired.length}, hardDeleted=${hardDeleted}, ` +
        `objectFailures=${objectFailures} (retentionDays=${retentionDays})`,
    );
    return { scanned: expired.length, hardDeleted, objectFailures };
  }

  /**
   * 每周日 04:42 孤儿对象清扫（cron 入口，P2 批 4）。
   *
   * 为什么周频（与每日软删清扫刻意分轨）：本清扫是**全桶列举**（O(桶对象数) 的
   * 网络 + 内存开销），而孤儿只是"删除失败/上传中断留下的尾巴"这类低概率残留，
   * 日频只有成本没有收益；04:42 错峰（避整点与每日 03:17 软删清扫）。
   * 不做启动补扫：全桶列举不该拖慢每次启动，多等一周无实质风险。
   */
  @Cron('42 4 * * 0')
  async sweepOrphanObjects(): Promise<OrphanSweepResult> {
    return this.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);
  }

  /**
   * 小时级过期附件物理回收（cron 入口，v1.90.0-dev §1.3 M4）。
   *
   * 调度：每小时第 11 分（`11 * * * *`）——避开整点，与每日 03:17 / 每周 04:42
   * 错峰。**命名刻意不撞既有 `sweepExpired()`**（那是每日 30d 软删轨道的 cron
   * 入口名，m1）：本方法是过期行的独立快速通道。
   *
   * **测试环境不注册（N3 硬约束）**：`disabled: !ATTACHMENT_EXPIRED_SWEEP_ENABLED`
   * （`isTestEnv` 时 false）。小时级 cron 与"过期但行仍在"的 e2e 中间态天然冲突
   * （跨过整点 :11 会让 410 用例变 404）。装饰器是静态的，用 `disabled` 表达
   * "测试环境不注册/不执行"，行为与"不注册"等价且无需运行时分支。
   *
   * **不挂 onApplicationBootstrap 补扫（N2）**：启动补扫保持只调轨道一
   * （见 onApplicationBootstrap 注释）——启动时对全表过期行批量删对象会在
   * MinIO 不可达时拖慢启动，正是既有设计刻意规避的。
   */
  @Cron('11 * * * *', {
    name: 'sweepExpiredAttachments',
    disabled: !ATTACHMENT_EXPIRED_SWEEP_ENABLED,
  })
  async sweepExpiredAttachments(): Promise<ExpiredSweepResult> {
    return this.sweepExpiredAttachmentsOlderThan(new Date());
  }

  /**
   * 过期附件回收核心逻辑（独立方法便于直测；now 参数化让测试可构造精确边界）。
   *
   * **谓词钉死**（§1.3 M4）：`expires_at < now() AND deleted_at IS NULL`——
   * - 与 migration `idx_attachments_expires_gc` 的 partial 谓词
   *   （`deleted_at IS NULL AND expires_at IS NOT NULL`）精确匹配，否则 PG 无法用索引、
   *   退化为全表扫；
   * - **只管"活的过期行"**：软删行的 30d 保留管道归每日轨道一，职责干净
   *   （软删且过期的行**不会**被本通道提前硬删——测试钉死该谓词纪律）。
   *
   * 动作：删 MinIO 对象（原图 + 缩略图双键，幂等）→ **行照硬删**。
   * 删对象失败仅计数记日志、行仍硬删（**与轨道一同款容错**：残留对象归每周孤儿
   * 清扫兜底）——不能因单个坏对象卡死整批回收。
   *
   * **分批循环（m2①）**：`take(batchSize)` + 外层 while，防"整批同时到期"时单轮
   * 超过 cron 周期（1h）与下一轮重叠；每批处理后重新查询，直到批不满 / 无行可删。
   * **TOCTOU 守卫（m2②）**：硬删带 `deleted_at IS NULL` 谓词——行被本方法"命中"
   * 之后、删除之前被用户手动软删时，硬删会打掉他的 30 天恢复窗口；带谓词则删 0 行，
   * 该行留给轨道一（对象已删，但软删行的对象本就归轨道一重试，语义一致）。
   * **计数真实化（m2③）**：`hardDeleted` 按 `affected` 累加，不是"循环了几行"。
   *
   * **无 30 天误删恢复窗口**（N6，文档写明）：TTL 到期是确定性、非行为者触发、
   * 可由 expires_at 反推的事件（等价 S3 lifecycle），故**不写 audit**（沿用 GC
   * 不变量）且立即硬删；与用户手动 DELETE 的软删管道语义不同（并发软删是唯一
   * 例外，见上条 TOCTOU 守卫）。
   *
   * 稳态占用（M4 定案）：单次扫描滞后 ≤1h → 物理占用 ≤ 2× 配额。
   *
   * @param now 过期判定基准（显式注入便于测试；cron 传当前时刻）
   * @param batchSize 单批处理条数（缺省 {@link EXPIRED_SWEEP_BATCH_SIZE}；测试可注入小值）
   */
  async sweepExpiredAttachmentsOlderThan(
    now: Date,
    batchSize: number = EXPIRED_SWEEP_BATCH_SIZE,
  ): Promise<ExpiredSweepResult> {
    let scanned = 0;
    let hardDeleted = 0;
    let objectFailures = 0;
    /** INFO 抽样（id/uploaderId/expiresAt 前 N 条）——过期硬删的取证面（N6） */
    const sample: Array<{ id: string; uploaderId: string; expiresAt: string }> = [];

    // 每批重建 queryBuilder：批间数据在变（行被删/被软删），复用同一 builder 的
    // 快照语义会失真；谓词与 partial index 精确匹配（见方法注释）
    for (;;) {
      const expired = await this.attachmentRepo
        .createQueryBuilder('a')
        .where('a.expires_at IS NOT NULL')
        .andWhere('a.expires_at < :now', { now })
        .andWhere('a.deleted_at IS NULL')
        .orderBy('a.expires_at', 'ASC')
        .take(batchSize)
        .getMany();

      if (expired.length === 0) break;
      scanned += expired.length;

      let deletedThisBatch = 0;
      for (const row of expired) {
        if (sample.length < EXPIRED_SWEEP_SAMPLE_LIMIT && row.expiresAt) {
          sample.push({
            id: row.id,
            uploaderId: row.uploaderId,
            expiresAt: row.expiresAt.toISOString(),
          });
        }
        // 原图 + 缩略图双删：两键独立 try/catch——一个坏对象不牵连另一个；
        // 失败记日志继续，**行照硬删**（残留对象归每周孤儿清扫）
        for (const key of [row.objectKey, row.thumbKey]) {
          if (!key) continue;
          try {
            await this.storage.removeObject(key);
          } catch (err) {
            objectFailures += 1;
            this.logger.error(
              `Expired sweep removeObject failed (id=${row.id}, key=${key}), ` +
                `hard-delete row anyway; orphan object left for weekly sweep: ${(err as Error).message}`,
            );
          }
        }
        // TOCTOU 守卫：只硬删"仍是活行"的（并发软删 → affected 0，留给轨道一）
        const res = await this.attachmentRepo.delete({ id: row.id, deletedAt: IsNull() });
        const affected = res.affected ?? 0;
        deletedThisBatch += affected;
        hardDeleted += affected;
      }

      // 批不满 = 本轮已取完；整批都删不掉 = 全被并发软删挡下 → 终止防死循环
      if (expired.length < batchSize) break;
      if (deletedThisBatch === 0) {
        this.logger.warn(
          `Expired sweep: a full batch of ${batchSize} rows could not be hard-deleted ` +
            `(concurrently soft-deleted?); stopping this run, rows fall back to the daily track`,
        );
        break;
      }
    }

    // 空轮降级 debug（n3）：小时级 cron 下每小时一条 INFO 空日志纯噪声
    if (scanned === 0) {
      this.logger.debug('Expired attachment sweep: nothing to purge');
    } else {
      this.logger.log(
        `Expired attachment sweep done: scanned=${scanned}, hardDeleted=${hardDeleted}, ` +
          `objectFailures=${objectFailures}, sample=[${sample
            .map((s) => `${s.id}/${s.uploaderId}/${s.expiresAt}`)
            .join(', ')}]`,
      );
    }
    return { scanned, hardDeleted, objectFailures };
  }

  /**
   * 孤儿清扫核心逻辑（独立方法便于直测；grace 窗口参数化——e2e 传 0 才能验证
   * "删除"分支，MinIO 对象时间戳由服务端生成、无法回拨成旧对象）。
   *
   * 判定：桶内对象 key 不在保护集内 **且** 年龄 ≥ graceMs → 删除。
   * 保护集 = attachments 全表（withDeleted）的 objectKey + thumbKey 双列。
   *
   * 竞态说明：保护集是列举前的快照，快照之后才插入的行其对象年龄必然 < grace
   * （对象先于行创建），因此不会被本轮删除——grace 一处同时兜住"在途上传"与
   * "快照竞态"两类时序问题。
   *
   * 刻意不加的短路：表为空时全桶对象都会被判孤儿——这在语义上正确（无行即孤儿），
   * 生产不存在"空表 + 满桶"的组合，故不引入启发式保护（避免"看起来安全"的
   * 隐性行为分叉）。
   *
   * 多 bucket 边界：只扫 `storage.getBucket()`（配置 bucket）；若未来真出现
   * 多 bucket 分流，需改为遍历 `SELECT DISTINCT bucket`（见 attachment.entity.ts）。
   *
   * @param graceMs 宽限窗口（毫秒）：最后修改时间在此窗口内的对象一律不删
   */
  async sweepOrphanObjectsOlderThan(graceMs: number): Promise<OrphanSweepResult> {
    // withDeleted()：软删行在保留期内其对象与缩略图都仍合法，必须计入保护集；
    // 只 select 两列（部分实体）——避免把 sha256 等大列读进内存
    const rows = await this.attachmentRepo
      .createQueryBuilder('a')
      .withDeleted()
      .select(['a.objectKey', 'a.thumbKey'])
      .getMany();

    const protectedKeys = new Set<string>();
    for (const row of rows) {
      if (row.objectKey) protectedKeys.add(row.objectKey);
      if (row.thumbKey) protectedKeys.add(row.thumbKey);
    }

    const cutoff = Date.now() - graceMs;
    let scanned = 0;
    let deleted = 0;
    let skippedFresh = 0;
    let skippedUnknownAge = 0;
    let failures = 0;
    /** 被删 key 抽样（日志前 10 个——运维抽查清扫是否误伤的可见性入口） */
    const sampleKeys: string[] = [];

    for await (const object of this.storage.listObjects()) {
      scanned += 1;
      if (protectedKeys.has(object.key)) continue;
      if (!object.lastModified) {
        // 年龄不可证 = 不能删（凭未知年龄删数据是事故方向）
        skippedUnknownAge += 1;
        continue;
      }
      if (object.lastModified.getTime() > cutoff) {
        skippedFresh += 1;
        continue;
      }
      try {
        await this.storage.removeObject(object.key);
        deleted += 1;
        if (sampleKeys.length < ORPHAN_SWEEP_SAMPLE_LIMIT) sampleKeys.push(object.key);
      } catch (err) {
        // 单键失败不中止整轮（与软删清扫同规）；对象仍在桶里，下轮自然重试
        failures += 1;
        this.logger.error(
          `Orphan sweep removeObject failed (key=${object.key}), left for next sweep: ` +
            `${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Orphan sweep done: scanned=${scanned}, deleted=${deleted}, skippedFresh=${skippedFresh}, ` +
        `skippedUnknownAge=${skippedUnknownAge}, failures=${failures}, ` +
        `sampleKeys=[${sampleKeys.join(', ')}] (graceMs=${graceMs}, bucket=${this.storage.getBucket()})`,
    );
    return { scanned, deleted, skippedFresh, skippedUnknownAge, failures };
  }
}

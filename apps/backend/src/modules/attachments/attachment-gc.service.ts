/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / GC)
 *   - 补充: docs/api-definition.md §Attachments（软删/配额释放语义）
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #11(注释) #17(测试契约) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 软删行查询必须显式取 deleted_at（select:false 需 addSelect，见下）
 *   □ GC 永不写 audit（系统行为，logger 记录）
 * =============================================================================
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Attachment } from '../../database/entities/attachment.entity';
import { AttachmentStorageService } from './storage.service';

/**
 * 软删保留期（plan §3.7 钉死 30 天）：软删行超过该窗口后硬删并清对象。
 * 30 天的取舍：给"误删恢复/审计追溯"留足人工窗口，同时把 MinIO 对象
 * 体积增长限制在月级线性以内（配额在软删时已释放，这里清的是存储成本）。
 */
export const ATTACHMENT_GC_RETENTION_DAYS = 30;

/**
 * 附件 GC（plan §3.7）。
 *
 * 职责链：软删超 30 天行 → 删 MinIO 对象（幂等——MinIO 对不存在键返回成功，
 * DELETE 端点删对象失败留下的尾巴由这里重试）→ 硬删行。
 * 失败语义：删对象失败仅记日志并继续（行照硬删，孤儿对象清扫归 P2）——
 * 不能让单个坏对象卡死整批 GC。
 *
 * 边界（plan 钉死）：
 * - GC 不写 audit（系统行为；logger 记录全量动作）；
 * - 孤儿对象（无行有对象）清扫不在本服务——P2 清单；
 * - 软删行查询必须显式取 deleted_at：Attachment.deletedAt 是
 *   DeleteDateColumn({ select: false })，queryBuilder 需 addSelect 才拿得到值
 *   （ WHERE 条件本身不受 select:false 影响，但此处要按它算窗口）。
 *
 * 调度：每日 03:17（Cron('17 3 * * *')，错开备份/整点高峰惯例）+
 * onApplicationBootstrap 补扫一次（fire-and-forget：不 await 阻塞启动——
 * MinIO 不可达时 sweep 内部逐对象失败记日志，拖慢启动无任何收益）。
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
      try {
        await this.storage.removeObject(row.objectKey);
      } catch (err) {
        objectFailures += 1;
        // 失败记日志继续：行照硬删（软删已超窗，数据语义已死），
        // 残留对象归 P2 孤儿清扫——单对象故障不许卡死整批
        this.logger.error(
          `GC removeObject failed (id=${row.id}, key=${row.objectKey}), ` +
            `hard-delete row anyway; orphan object left for P2 sweep: ${(err as Error).message}`,
        );
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
}

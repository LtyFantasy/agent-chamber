/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块)
 *   - 补充: docs/api-definition.md §Attachments（端点契约/错误码语义）
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #11(注释) #17(测试契约) #18(不变量检查) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 配额事务不变量未破坏：SUM 与插行同事务、advisory lock 持有到提交、
 *     putObject 在锁外、插行失败删对象
 *   □ 404 一致性（存在但无权限一律 404）未破坏
 * =============================================================================
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import type { Readable } from 'stream';
import { ActorType, AuditAction, ErrorCode, UserRole, Visibility } from '@agent-chamber/shared';
import { Attachment } from '../../database/entities/attachment.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { ParticipantStatus } from '@agent-chamber/shared';
import { TopicService } from '../topic/topic.service';
import { DocService } from '../docspace/doc.service';
import { DocSpaceService } from '../docspace/docspace.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { UnifiedActor } from '../../common/types/actor.types';
import { AttachmentStorageService } from './storage.service';
import { AttachmentAccessService } from './attachment-access.service';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_DIMENSION_PX,
  ATTACHMENT_MAX_TOTAL_PIXELS,
  ATTACHMENT_QUOTA_BYTES,
} from './attachment.constants';
import { exceedsDimensionLimits, readImageDimensions, sniffImageMime } from './image-sniffer';
import { sanitizeOriginalName } from './filename-sanitize';
import { UploadAttachmentQueryDto } from './dto/upload-attachment-query.dto';
import { QueryMineDto } from './dto/query-mine.dto';
import {
  AttachmentMetadataDto,
  UploadAttachmentResponse,
  buildContentUrl,
} from './dto/attachment-response.dto';

/**
 * 上传文件载荷（multer memoryStorage 产物）。
 *
 * 本地定义而非 Express.Multer.File：项目未装 @types/multer（依赖纪律：
 * platform-express 已内建 multer@2.0.2，不单独声明），该全局命名空间不可用；
 * 结构对齐 memoryStorage 下的 Express.Multer.File 字段（buffer 在磁盘存储模式不存在——
 * 本模块 controller 钉死 memoryStorage，buffer 恒在）。
 */
export interface UploadedMemoryFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** GET /content 的载荷：授权通过的附件行 + 对象流 */
export interface AttachmentContent {
  attachment: Attachment;
  stream: Readable;
}

/** GET /mine 分页结果（topic.service findAll 形状先例：items/total/page/pageSize/totalPages） */
export interface MinePage {
  items: AttachmentMetadataDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * 附件主服务。
 *
 * 上传校验链（plan §3.1 钉死顺序，每层违例即拒、后续层不执行）：
 * 0. 文件存在 + 防御性字节复检（multer limits 是第一道，此处兜底）；
 * 1. 绑定恰好一值（12005）；
 * 2. 绑定资源存在 + 写权限（topic 镜像 sendMessage 语义：OPEN 非 participant 可发，
 *    PRIVATE 需 active participant/admin/ownerProxy，topic.service.ts:1193-1220；
 *    doc 需 space write 权限；无权 403 ATTACHMENT_FORBIDDEN）；
 * 3. 魔数嗅探白名单（12002；不信任客户端声明 Content-Type）；
 * 4. 图片炸弹头部尺寸校验（单边 ≤16384px、总像素 ≤40MP；头部无法解析同拒）；
 * 5. sha256 → putObject（锁外）→ 配额事务：pg_advisory_xact_lock → SUM → 插行 → 提交，
 *    锁持有到提交、插行失败删对象（§3.1/§10 配额事务边界钉死）。
 */
@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  constructor(
    @InjectRepository(Attachment)
    private readonly attachmentRepo: Repository<Attachment>,
    @InjectRepository(TopicParticipant)
    private readonly participantRepo: Repository<TopicParticipant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly storage: AttachmentStorageService,
    private readonly access: AttachmentAccessService,
    private readonly topicService: TopicService,
    private readonly docService: DocService,
    private readonly docSpaceService: DocSpaceService,
    private readonly permService: PermissionService,
    private readonly ownerProxy: OwnerProxyService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * 上传附件（校验链见类注释；事务与锁语义见下方实现注释）。
   *
   * @returns plan §3.1 钉死的响应形状（含 contentUrl）
   */
  async upload(
    actor: UnifiedActor,
    query: UploadAttachmentQueryDto,
    file: UploadedMemoryFile | undefined,
  ): Promise<UploadAttachmentResponse> {
    // ── 0. 文件存在 + 防御性字节复检 ─────────────────────────────
    // multer limits.fileSize 是第一道（超→413 经 controller 拦截器映射 12001），
    // 本层是防御性复检：limits 配置漂移时错误码也不许说谎。
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        message: 'file is required',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (file.buffer.length > ATTACHMENT_MAX_BYTES) {
      throw new PayloadTooLargeException({
        message: `File exceeds max size of ${ATTACHMENT_MAX_BYTES} bytes`,
        code: ErrorCode.ATTACHMENT_TOO_LARGE,
      });
    }

    // ── 1. 绑定恰好一值（12005）──────────────────────────────────
    const { topicId, docId } = query;
    if ((topicId == null) === (docId == null)) {
      throw new BadRequestException({
        message: 'Exactly one of topicId or docId must be provided',
        code: ErrorCode.ATTACHMENT_BIND_CONFLICT,
      });
    }

    // ── 2. 绑定资源存在 + 写权限 ─────────────────────────────────
    if (topicId != null) {
      await this.assertTopicWritable(topicId, actor);
    } else {
      // docId != null（恰好一值已保证）
      await this.assertDocWritable(docId as string, actor);
    }

    // ── 3. 魔数嗅探（12002）──────────────────────────────────────
    const sniffed = sniffImageMime(file.buffer);
    if (!sniffed) {
      throw new BadRequestException({
        message: 'File content is not an allowed image type (png/jpeg/gif/webp)',
        code: ErrorCode.ATTACHMENT_TYPE_NOT_ALLOWED,
      });
    }

    // ── 4. 头部尺寸校验（防解码炸弹；头部不可解析 = 不可信文件）───
    const dim = readImageDimensions(file.buffer, sniffed.mime);
    if (!dim) {
      throw new BadRequestException({
        message: 'Image header is malformed or truncated; dimensions unreadable',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (exceedsDimensionLimits(dim, ATTACHMENT_MAX_DIMENSION_PX, ATTACHMENT_MAX_TOTAL_PIXELS)) {
      throw new BadRequestException({
        message:
          `Image dimensions ${dim.width}x${dim.height} exceed limits ` +
          `(max side ${ATTACHMENT_MAX_DIMENSION_PX}px, max total ${ATTACHMENT_MAX_TOTAL_PIXELS} pixels)`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    // ── 5. 哈希 → putObject（锁外）→ 配额事务 ────────────────────
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const objectKey = `${randomUUID()}.${sniffed.ext}`;
    const originalName = sanitizeOriginalName(file.originalname);
    const bucket = this.storage.getBucket();

    // putObject 在 advisory 锁外先做（§3.1：锁内只留 SUM+插行，缩短锁持有窗口）；
    // 后续任何失败必须删对象（下方 catch 统一兜底，不留孤儿对象）。
    await this.storage.putObject(objectKey, file.buffer, sniffed.mime);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let saved: Attachment;
    try {
      // 配额 SUM 与插行同一事务：行级 advisory 锁按上传者串行化并发上传，
      // 锁持有到提交（xact 变体提交自动释放），杜绝两请求同时过 SUM 检查的超卖窗口
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        actor.id,
      ]);
      const rows: Array<{ total: string }> = await queryRunner.query(
        `SELECT COALESCE(SUM(size_bytes), 0)::text AS total
         FROM attachments WHERE uploader_id = $1 AND deleted_at IS NULL`,
        [actor.id],
      );
      // SUM(bigint) 经 ::text 显式转型后 Number()（§2 转换点钉死；规模远小于 2^53）
      const used = Number(rows[0]?.total ?? '0');
      if (used + file.buffer.length > ATTACHMENT_QUOTA_BYTES) {
        throw new ForbiddenException({
          message:
            `Storage quota exceeded: used ${used} bytes of ${ATTACHMENT_QUOTA_BYTES}, ` +
            `this upload needs ${file.buffer.length} more`,
          code: ErrorCode.ATTACHMENT_QUOTA_EXCEEDED,
        });
      }

      saved = await queryRunner.manager.save(
        queryRunner.manager.create(Attachment, {
          uploaderId: actor.id,
          bucket,
          objectKey,
          originalName,
          mimeType: sniffed.mime,
          sizeBytes: String(file.buffer.length),
          sha256,
          status: 'ready',
          topicId: topicId ?? null,
          docId: docId ?? null,
        }),
      );
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      // 插行失败删对象（plan §3.1）；删除失败仅记日志——孤儿对象清扫归 P2 GC
      await this.storage
        .removeObject(objectKey)
        .catch((rmErr) =>
          this.logger.error(
            `Orphan object cleanup failed (key=${objectKey}): ${(rmErr as Error).message}`,
          ),
        );
      throw err;
    } finally {
      await queryRunner.release();
    }

    return { ...this.toMetadataDto(saved), contentUrl: buildContentUrl(saved.id) };
  }

  /**
   * 元数据读取（GET /attachments/:id）。不存在/无权限统一 404（12000）。
   */
  async getMetadata(id: string, actor: UnifiedActor): Promise<AttachmentMetadataDto> {
    const attachment = await this.findAccessible(id, actor);
    return this.toMetadataDto(attachment);
  }

  /**
   * 内容读取（GET /attachments/:id/content）。授权通过 → getObject 流。
   */
  async getContent(id: string, actor: UnifiedActor): Promise<AttachmentContent> {
    const attachment = await this.findAccessible(id, actor);
    const stream = await this.storage.getObject(attachment.objectKey);
    return { attachment, stream };
  }

  /**
   * 我的附件分页（GET /attachments/mine）：仅按 uploader_id 收口，
   * 不做绑定资源可见性过滤（自己的上传自己总能管理；读取他人仍走绑定授权）。
   */
  async findMine(actor: UnifiedActor, query: QueryMineDto): Promise<MinePage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [rows, total] = await this.attachmentRepo.findAndCount({
      where: { uploaderId: actor.id },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: rows.map((row) => this.toMetadataDto(row)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 删除（DELETE /attachments/:id）：上传者或 admin——注意 404 一致性：
   * 非上传者非 admin 对存在的附件也返回 404（不泄露存在性，plan §3.1）。
   *
   * 顺序钉死：先软删行（事务）→ 后删 MinIO 对象（失败仅记日志，GC 重试）——
   * 严禁反序：先删对象后软删失败会留下"行在对象无"的永久脏行（plan §3.1）。
   * 软删即释放配额（SUM 只计 deleted_at IS NULL）。
   */
  async remove(id: string, actor: UnifiedActor): Promise<void> {
    const attachment = await this.attachmentRepo.findOne({ where: { id } });
    if (!attachment) {
      throw new NotFoundException({
        message: 'Attachment not found',
        code: ErrorCode.ATTACHMENT_NOT_FOUND,
      });
    }
    const isUploader = attachment.uploaderId === actor.id;
    const isAdmin = actor.role === UserRole.ADMIN;
    if (!isUploader && !isAdmin) {
      throw new NotFoundException({
        message: 'Attachment not found',
        code: ErrorCode.ATTACHMENT_NOT_FOUND,
      });
    }

    await this.dataSource.transaction(async (em) => {
      await em.softDelete(Attachment, id);
    });

    // 删对象失败仅记日志：行已软删（读取面已封闭），对象由 GC 兜底重试
    await this.storage
      .removeObject(attachment.objectKey)
      .catch((err) =>
        this.logger.error(
          `MinIO removeObject failed after soft-delete (key=${attachment.objectKey}), ` +
            `GC will retry: ${(err as Error).message}`,
        ),
      );

    // 审计（fail-open，AuditService.log 内部已兜底）；系统行为不写 audit 的边界：
    // 本端点是用户/Agent 显式动作，必须留痕
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.ATTACHMENT,
      entityId: id,
      actorId: actor.id,
      newData: {
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        sizeBytes: Number(attachment.sizeBytes),
        sha256: attachment.sha256,
      },
      source: 'api',
    });
  }

  /**
   * 存在性 + 读取授权统一入口：行不存在（含已软删，findOne 默认滤）→ 404；
   * 授权判定全在 AttachmentAccessService（无权同样 404，双路径同码）。
   */
  private async findAccessible(id: string, actor: UnifiedActor): Promise<Attachment> {
    const attachment = await this.attachmentRepo.findOne({ where: { id } });
    if (!attachment) {
      throw new NotFoundException({
        message: 'Attachment not found',
        code: ErrorCode.ATTACHMENT_NOT_FOUND,
      });
    }
    await this.access.assertCanRead(attachment, actor);
    return attachment;
  }

  /**
   * topic 绑定写权限：镜像 sendMessage 语义（topic.service.ts:1193-1220）——
   * OPEN topic 非 participant 可发；PRIVATE 需 active participant/admin/ownerProxy。
   * topic 不存在 → 404 TOPIC_NOT_FOUND（findById 已抛）；无权 → 403 12004。
   * 注：plan 只镜像 visibility 段——topic 状态（closed/paused/archived）不拦截上传。
   */
  private async assertTopicWritable(topicId: string, actor: UnifiedActor): Promise<void> {
    const topic = await this.topicService.findById(topicId);
    const settings = topic.settings || {};
    if (settings.visibility !== Visibility.PRIVATE) return;

    const participant = await this.participantRepo.findOne({
      where: { topicId, participantId: actor.id, status: ParticipantStatus.ACTIVE },
    });
    if (participant) return;

    // admin 短路（性能短路铁律：不触发 owner 代理查询）；
    // owner 代理判定仅对 human 有效（sendMessage 同款显式 type 前置判断）
    const isAdmin = actor.role === UserRole.ADMIN;
    const isOwnerProxy =
      !isAdmin && actor.type === ActorType.HUMAN
        ? await this.ownerProxy.isOwnerProxy(topic.creatorId, actor)
        : false;
    if (!isAdmin && !isOwnerProxy) {
      throw new ForbiddenException({
        message: 'You must join the topic before uploading attachments',
        code: ErrorCode.ATTACHMENT_FORBIDDEN,
      });
    }
  }

  /**
   * doc 绑定写权限：doc 存在（404 DOC_NOT_FOUND，findById 已抛）→
   * 所属 space 需 write 权限（DocSpacePolicy write 分支：creator/editor/ownerProxy/admin，
   * 经全局 PermissionService duck-typing）；无权 → 403 12004。
   */
  private async assertDocWritable(docId: string, actor: UnifiedActor): Promise<void> {
    const doc = await this.docService.findById(docId);
    const space = await this.docSpaceService.findById(doc.spaceId);
    const allowed = await this.permService.can(space, actor, 'write');
    if (!allowed) {
      throw new ForbiddenException({
        message: 'You do not have write access to this doc space',
        code: ErrorCode.ATTACHMENT_FORBIDDEN,
      });
    }
  }

  /**
   * DB 行 → 元数据 DTO。sizeBytes 显式 Number()（bigint string → number，
   * §2 钉死的唯一转换点）；bucket/objectKey/status 刻意不出（内部存储细节）。
   */
  private toMetadataDto(attachment: Attachment): AttachmentMetadataDto {
    return {
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: Number(attachment.sizeBytes),
      sha256: attachment.sha256,
      topicId: attachment.topicId,
      docId: attachment.docId,
      createdAt: attachment.createdAt,
    };
  }
}

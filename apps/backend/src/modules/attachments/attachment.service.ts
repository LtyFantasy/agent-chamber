/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 媒体附件主服务（上传校验链 / 读取授权入口 / 删除 / 配额事务）
 *   - DocSpace bundle formatVersion 2 的**媒体门面**（导出取行读字节 / 导入落库回绑）
 *
 * [代码职责]
 *   - 上传、元数据读取、内容/缩略图读取、分页、删除、findAccessible 授权入口
 *   - `listByDocIds`/`listByIds`/`readObjectBytes`：供 DocSpace 导出打包（docspace 不碰 storage）
 *   - `importFromBundle`/`bindBundleMedia`：bundle 导入的媒体两阶段（字节证据校验 → 落库 → 回绑）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块)
 *   - 补充: docs/api-definition.md §Attachments（端点契约/错误码语义）
 *   - 补充: docs/api-definition.md §16（bundle formatVersion 2 的 media 段契约）
 *
 * [关键不变量]
 *   - 上传：配额事务里 SUM 与插行同事务、advisory lock 持有到提交、putObject 在锁外、
 *     插行失败删对象（原图 + 缩略图双删）
 *   - 缩略图 fail-open：生成/上传失败只降级 thumb 5 列为 null；缩略图不计入配额
 *   - bundle 导入：**解码字节的嗅探结果才是 mime 的事实来源**（声明值只作对照，
 *     不符即 failed 不落行——存储型 XSS 防线）；复用行属性以库内为准（不更新文件名）；
 *     复用/插行的候选集 = (uploaderId=importer, sha256, topicId NULL, status='ready',
 *     deletedAt NULL, docId NULL 或 = 目标 doc)，确定性序 createdAt,id，本轮已配对行排除
 *   - 404 一致性（存在但无权限一律 404）未破坏
 *
 * [关联代码]
 *   - attachment-bundle-media.ts — bundle 载荷解码/字节证据校验（纯函数，纯逻辑单测入口）
 *   - attachment-bundle.types.ts — 与 DocSpace 编排层的跨模块形状（无依赖类型文件）
 *   - doc-bundle.service.ts — bundle 导出/导入编排（联合预算、URL 重写、结果信封）
 *   - attachment.constants.ts — 配额/上限常量单一事实源
 *
 * [持久踩坑]
 *   - BUNDLE-XSS(B2): bundle 的 mimeType/originalName 都是声明值，只信声明 = 允许把
 *     脚本字节以 image/png 存进平台并同源回吐（存储型 XSS）。安全方向：解码字节魔数
 *     嗅探必须与声明一致，不符即 failed 不落行（与上传同一套 sniffImageMime）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
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
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
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
  buildThumbnailUrl,
} from './dto/attachment-response.dto';
import { generateWebpThumbnail } from './thumbnail-generator';
import {
  decodeAndVerifyBundleMedia,
  decodeAndVerifyBundleThumbnail,
} from './attachment-bundle-media';
import type {
  BundleMediaBindEntry,
  BundleMediaBindResult,
  BundleMediaImportInput,
  BundleMediaImportResult,
} from './attachment-bundle.types';

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

/** GET /content 的载荷：授权通过的附件行 + 对象流（GET /thumbnail 复用同形状） */
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
 * 6. 缩略图变体（P2 批 1）：原图 putObject 后、配额事务前生成 webp 缩略图并落对象
 *    ——fail-open（生成/上传失败只降级 thumb 5 列为 null + warn 日志，上传照常）；
 *    缩略图字节**不计入配额**（配额口径仍为 SUM(size_bytes)，只计原图）。
 *
 * bundle 媒体门面（P2 批 5，见类内 §DocSpace bundle 媒体门面）：导出侧取行/读字节、
 * 导入侧两阶段落库与回绑——DocSpace 编排层因此完全不接触 storage。
 */
@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  /**
   * 缩略图生成失败计数（进程生命周期内累计，P2 批 1 fail-open 可观测性）。
   * 为什么用计数而不是每失败一条独立错误：缩略图失败不影响主链路（fail-open），
   * 单条 warn 不足以看出"是不是持续在失败"——计数随每条 warn 输出，
   * 运维/日志侧无需聚合即可判断 fail-open 是偶发还是规模化。
   */
  private thumbFailureCount = 0;

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
    // 行 id 提前生成（而非交给 DB gen_random_uuid）：缩略图步骤在插行之前，
    // 失败日志要带 attachmentId 做关联——同一 id 随后插行使用，日志与数据行对齐。
    const attachmentId = randomUUID();

    // putObject 在 advisory 锁外先做（§3.1：锁内只留 SUM+插行，缩短锁持有窗口）；
    // 后续任何失败必须删对象（下方 catch 统一兜底，不留孤儿对象）。
    await this.storage.putObject(objectKey, file.buffer, sniffed.mime);

    // ── 5.5 缩略图变体（P2 批 1）：fail-open —— 失败只降级，不阻断上传 ────
    // 插入点钉死（plan §0 arch M8）：原图 putObject 后、配额事务前——
    // 原图已落对象存储，缩略图失败不影响主链路事务；缩略图是增强不是契约。
    let thumb: {
      objectKey: string;
      width: number;
      height: number;
      sizeBytes: string;
      sha256: string;
    } | null = null;
    try {
      const generated = await generateWebpThumbnail(file.buffer);
      const thumbKey = `${randomUUID()}.thumb.webp`; // 独立 uuid，不与原图共享键
      await this.storage.putObject(thumbKey, generated.data, 'image/webp');
      thumb = {
        objectKey: thumbKey,
        width: generated.width,
        height: generated.height,
        sizeBytes: String(generated.data.length),
        sha256: createHash('sha256').update(generated.data).digest('hex'),
      };
    } catch (err) {
      // fail-open：结构化 warn（attachmentId/uploaderId/sniffed mime/error 类）
      // + 累计失败计数；thumb 5 列全 null，原图对象与上传流程不受影响
      const error = err as Error;
      this.thumbFailureCount += 1;
      this.logger.warn(
        `Thumbnail generation failed (fail-open, upload continues): attachmentId=${attachmentId}, ` +
          `uploaderId=${actor.id}, mime=${sniffed.mime}, errorClass=${error.constructor?.name ?? 'Error'}, ` +
          `failuresSinceStartup=${this.thumbFailureCount}, error=${error.message}`,
      );
    }

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
          id: attachmentId,
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
          // 缩略图 5 列同生共死：fail-open 时整组 null（部分写入 = 数据面说谎）
          thumbKey: thumb?.objectKey ?? null,
          thumbWidth: thumb?.width ?? null,
          thumbHeight: thumb?.height ?? null,
          thumbSizeBytes: thumb?.sizeBytes ?? null,
          thumbSha256: thumb?.sha256 ?? null,
        }),
      );
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      // 插行失败删对象（plan §3.1）——原图 + 缩略图**双删**（幂等：MinIO 对
      // 不存在键安全）；删除失败仅记日志——孤儿对象清扫归 P2 批 4 GC
      for (const key of [objectKey, thumb?.objectKey]) {
        if (!key) continue;
        await this.storage
          .removeObject(key)
          .catch((rmErr) =>
            this.logger.error(
              `Orphan object cleanup failed (key=${key}): ${(rmErr as Error).message}`,
            ),
          );
      }
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
   * 缩略图读取（GET /attachments/:id/thumbnail）：授权与 /content 同一入口
   * （findAccessible：不存在/无权一律 404 · 12000，不泄露存在性）。
   *
   * 无缩略图（thumb_key IS NULL：存量行未回溯生成 / 上传时 fail-open 失败）→
   * **404 · 12008**（与 12000 刻意分码：附件存在且有权读，只是没有缩略图——
   * 消息指导消费方改用 /content 取原图）。
   *
   * @returns 行（ETag/文件名用）+ 缩略图对象流（Content-Type 恒 image/webp）
   */
  async getThumbnail(id: string, actor: UnifiedActor): Promise<AttachmentContent> {
    const attachment = await this.findAccessible(id, actor);
    if (!attachment.thumbKey) {
      throw new NotFoundException({
        message:
          'No thumbnail available for this attachment; use /attachments/:id/content for the original',
        code: ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE,
      });
    }
    const stream = await this.storage.getObject(attachment.thumbKey);
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

    // 删对象失败仅记日志：行已软删（读取面已封闭），对象由 GC 兜底重试。
    // 原图 + 缩略图双删（幂等——MinIO 对不存在键返回成功）：两键互不阻塞，
    // 任一失败不牵连另一对象（各自的日志独立可追踪）。
    for (const key of [attachment.objectKey, attachment.thumbKey]) {
      if (!key) continue;
      await this.storage
        .removeObject(key)
        .catch((err) =>
          this.logger.error(
            `MinIO removeObject failed after soft-delete (key=${key}), ` +
              `GC will retry: ${(err as Error).message}`,
          ),
        );
    }

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
   *
   * public 而非 private（P2 批 2）：签名 URL 铸造（attachment-signed-url.service）
   * 复用同一入口，保证"铸造不得绕过授权"与 /content 的 404 契约**单一事实源**
   * ——禁止在其它服务里另写一份 findOne+assertCanRead。
   */
  async findAccessible(id: string, actor: UnifiedActor): Promise<Attachment> {
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

  // ─── DocSpace bundle 媒体门面（P2 批 5）────────────────────────────────
  //
  // 存在意义：bundle 的媒体段必须读对象字节（导出）与写对象/行（导入），而这些能力
  // 全部内聚在 attachments 模块（storage / 嗅探 / 配额锁）。DocSpace 侧只拿"行 + 字节"
  // 与"映射"，**不得 import AttachmentStorageService**（plan §⑤.5 模块边界钉死）。

  /**
   * 按 doc 绑定批量取行（导出侧候选集）。
   *
   * 为什么导出侧候选 = doc 绑定行而不是"正文里出现的所有附件 id"：
   * doc 绑定附件与空间读权限同面（space read → doc read → attachment read），
   * topic 绑定附件不在该面内（跨环境 topic id 也不通用）——把它们塞进 bundle 既是
   * 权限越界也是无效数据。正文引用但非 doc 绑定的 id 由调用方落 mediaOmitted。
   *
   * 空数组短路：TypeORM `In([])` 生成 `IN ()` 是 SQL 语法错误，必须显式返回。
   */
  async listByDocIds(docIds: string[]): Promise<Attachment[]> {
    if (docIds.length === 0) return [];
    return this.attachmentRepo.find({
      where: { docId: In(docIds), deletedAt: IsNull() },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /** 按附件 id 批量取行（导出侧"正文引用的附件"反查；含 topic 绑定项，供 mediaOmitted 判定） */
  async listByIds(ids: string[]): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    return this.attachmentRepo.find({ where: { id: In(ids), deletedAt: IsNull() } });
  }

  /**
   * 读对象字节（导出打包用）。流式拼接为 Buffer：bundle 需要 sha256 与 base64 编码，
   * 都必须拿到完整字节；调用方已按 DB 列预判过体积（只读"能进预算"的对象）。
   */
  async readObjectBytes(objectKey: string): Promise<Buffer> {
    const stream = await this.storage.getObject(objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  /**
   * bundle 导入阶段 ②：媒体落库（字节证据校验 → 复用或新建）。
   *
   * 六步里的第 ② 步（plan §⑤.4）：必须早于 docs 阶段——正文重写需要
   * `sourceAttachmentId → 新行 id` 的映射，而映射只有落库后才能确定。
   *
   * 幂等语义（plan §0 dx B1/arch M3/PM B1 行）：
   * - 复用键 = (uploaderId=importer, sha256, topicId NULL, status='ready', deletedAt NULL,
   *   docId NULL 或 = 该项 docPath 现解析出的 docId)；确定性序 `createdAt ASC, id ASC`
   *   （同事务 `now()` 的 tie 无排序保证，必须钉 tie-break）；取本轮未配对的第一条。
   * - **本轮未配对**：同 bundle 里两条相同字节不得共享一行（否则重导后两处内容指向同一
   *   attachment id，而它们本该是两份独立记录）。
   * - 复用行属性以库内为准（同 sha 不同名不更新文件名）：sha 相同即字节相同，
   *   文件名差异是"同一张图两次上传"的历史事实，不应被后到的包覆盖。
   * - 复用命中时**不落对象**（否则"同 bundle 二导对象数不变"立即破功）。
   *
   * 并发与锁：候选查询与插行都在 `pg_advisory_xact_lock(importer)` 事务内
   * （锁覆盖 select+insert），防两个并发导入各自看到"无候选"后双插。对象写入在锁外
   * （与上传同纪律：存储 IO 不占锁），锁内二次探测命中复用则把刚落的对象删掉。
   *
   * @returns 计数 + 失败明细 + 配对映射（正文重写与阶段 ④ 回绑的输入）
   */
  async importFromBundle(input: BundleMediaImportInput): Promise<BundleMediaImportResult> {
    const result: BundleMediaImportResult = {
      created: 0,
      reused: 0,
      skipped: 0,
      failed: [],
      bindings: [],
    };
    /** 本轮已配对的行 id（复用键的"本轮未配对"语义） */
    const pairedRowIds = new Set<string>();
    /** 本轮已成功配对的 sourceAttachmentId（重复项 → failed，防"一个旧 id 映射到两行"） */
    const pairedSourceIds = new Set<string>();
    /** 本轮已用掉的解码后总量（导入侧对称预算复检，plan §⑤.4 末句） */
    let decodedBudgetUsed = 0;

    for (const item of input.items) {
      const fail = (reason: string): void => {
        result.failed.push({
          docPath: item.docPath,
          originalName: item.originalName,
          reason,
        });
      };

      try {
        // 导出侧未打包标记：计入 skipped（无字节、无写）
        if (item.skipped) {
          result.skipped++;
          continue;
        }

        // ── 联合形状的必填性（DTO 只能表达"可选"；union 语义在这里定）──
        const sourceId = item.sourceAttachmentId?.toLowerCase() ?? null;
        if (!sourceId) {
          fail('missing required field: sourceAttachmentId');
          continue;
        }
        if (!input.docPathSet.has(item.docPath)) {
          // 手改包/自建包的常见错误：media 项挂在不存在的 docPath 上
          fail(`docPath '${item.docPath}' does not appear in bundle docs[]`);
          continue;
        }
        if (pairedSourceIds.has(sourceId)) {
          fail(`duplicate sourceAttachmentId '${sourceId}' in this bundle`);
          continue;
        }
        if (
          !item.originalName ||
          !item.mimeType ||
          item.contentBase64 === null ||
          item.sha256 === null ||
          item.sizeBytes === null
        ) {
          fail(
            'missing required media fields (originalName/mimeType/sizeBytes/sha256/contentBase64)',
          );
          continue;
        }

        // ── 字节证据校验（与上传同一套嗅探）+ sha/size 自洽 ──
        const verified = decodeAndVerifyBundleMedia({
          contentBase64: item.contentBase64,
          declaredMime: item.mimeType,
          sizeBytes: item.sizeBytes,
          sha256: item.sha256,
        });
        if (!verified.ok) {
          this.logger.warn(
            `Bundle media rejected (docPath=${item.docPath}, sourceAttachmentId=${sourceId}): ${verified.reason}`,
          );
          fail(verified.reason);
          continue;
        }
        if (verified.data.length > input.limits.itemMaxBytes) {
          fail(
            `media item exceeds the per-item limit of ${input.limits.itemMaxBytes} bytes ` +
              `(decoded ${verified.data.length})`,
          );
          continue;
        }

        let thumbnailBytes: Buffer | null = null;
        if (item.thumbnail) {
          const thumb = decodeAndVerifyBundleThumbnail({
            contentBase64: item.thumbnail.contentBase64,
            sizeBytes: item.thumbnail.sizeBytes,
            sha256: item.thumbnail.sha256,
          });
          if (!thumb.ok) {
            fail(thumb.reason);
            continue;
          }
          thumbnailBytes = thumb.data;
        }

        // ── 导入侧对称防御复检：本包解码后总量（原图 + 缩略图）──
        const neededBytes = verified.data.length + (thumbnailBytes?.length ?? 0);
        if (decodedBudgetUsed + neededBytes > input.limits.budgetBytes) {
          fail(
            `bundle media budget exceeded: this bundle decodes to more than ` +
              `${input.limits.budgetBytes} bytes of media payload`,
          );
          continue;
        }

        // ── 复用快路径（锁内 select；命中则不落对象、不插行）──
        const resolvedDocId = input.docIdByPath.get(item.docPath) ?? null;
        const reusable = await this.withQuotaLock(input.importerId, (em) =>
          this.findReusableBundleRow(em, {
            importerId: input.importerId,
            sha256: item.sha256 as string,
            resolvedDocId,
            excludedRowIds: pairedRowIds,
          }),
        );
        if (reusable) {
          pairedRowIds.add(reusable.id);
          pairedSourceIds.add(sourceId);
          decodedBudgetUsed += neededBytes;
          result.reused++;
          result.bindings.push({
            sourceAttachmentId: sourceId,
            attachmentId: reusable.id,
            docPath: item.docPath,
            originalName: reusable.originalName,
          });
          continue;
        }

        // ── 落对象（锁外）→ 锁内终局（并发竞态复检 + 配额 + 插行）──
        const objectKey = `${randomUUID()}.${verified.ext}`;
        const thumbKey = thumbnailBytes ? `${randomUUID()}.thumb.webp` : null;
        await this.storage.putObject(objectKey, verified.data, verified.mime);
        if (thumbKey) {
          await this.storage.putObject(thumbKey, thumbnailBytes as Buffer, 'image/webp');
        }

        try {
          // 显式联合标注：让 `'reusedRow' in outcome` 的分支收窄成立（推断出的
          // 交叉形态带 optional undefined 属性，in 判定收窄不掉）
          const outcome: { reusedRow: Attachment } | { saved: Attachment } =
            await this.withQuotaLock(input.importerId, async (em) => {
              // 二次探测：并发导入可能刚刚插了等价行（锁外落对象窗口）→ 复用并丢弃新对象
              const raced = await this.findReusableBundleRow(em, {
                importerId: input.importerId,
                sha256: item.sha256 as string,
                resolvedDocId,
                excludedRowIds: pairedRowIds,
              });
              if (raced) return { reusedRow: raced };

              const rows: Array<{ total: string }> = await em.query(
                `SELECT COALESCE(SUM(size_bytes), 0)::text AS total
               FROM attachments WHERE uploader_id = $1 AND deleted_at IS NULL`,
                [input.importerId],
              );
              const used = Number(rows[0]?.total ?? '0');
              if (used + verified.data.length > ATTACHMENT_QUOTA_BYTES) {
                throw new ForbiddenException({
                  message:
                    `Storage quota exceeded: used ${used} bytes of ${ATTACHMENT_QUOTA_BYTES}, ` +
                    `this import needs ${verified.data.length} more`,
                  code: ErrorCode.ATTACHMENT_QUOTA_EXCEEDED,
                });
              }

              const saved = await em.save(
                em.create(Attachment, {
                  uploaderId: input.importerId,
                  bucket: this.storage.getBucket(),
                  objectKey,
                  // 文件名走与上传同一套 sanitize（bundle 的 originalName 同样是外部输入）
                  originalName: sanitizeOriginalName(item.originalName as string),
                  // mime 以**嗅探值**入库（声明值只作对照，已在 decode 阶段比对一致）
                  mimeType: verified.mime,
                  sizeBytes: String(verified.data.length),
                  sha256: item.sha256 as string,
                  status: 'ready',
                  topicId: null,
                  // 阶段 ② 刻意不绑 doc：目标 doc 要到阶段 ③ 才 upsert，
                  // 阶段 ④ 统一回绑（回绑失败留 docId NULL = 断链可见、重导可续绑）
                  docId: null,
                  thumbKey,
                  thumbWidth: item.thumbnail?.width ?? null,
                  thumbHeight: item.thumbnail?.height ?? null,
                  thumbSizeBytes: thumbnailBytes ? String(thumbnailBytes.length) : null,
                  thumbSha256: item.thumbnail?.sha256 ?? null,
                }),
              );
              return { saved };
            });

          if ('reusedRow' in outcome) {
            await this.removeBundleObjectsQuietly([objectKey, thumbKey]);
            pairedRowIds.add(outcome.reusedRow.id);
            pairedSourceIds.add(sourceId);
            decodedBudgetUsed += neededBytes;
            result.reused++;
            result.bindings.push({
              sourceAttachmentId: sourceId,
              attachmentId: outcome.reusedRow.id,
              docPath: item.docPath,
              originalName: outcome.reusedRow.originalName,
            });
          } else {
            pairedRowIds.add(outcome.saved.id);
            pairedSourceIds.add(sourceId);
            decodedBudgetUsed += neededBytes;
            result.created++;
            result.bindings.push({
              sourceAttachmentId: sourceId,
              attachmentId: outcome.saved.id,
              docPath: item.docPath,
              originalName: outcome.saved.originalName,
            });
          }
        } catch (err) {
          // 插行失败/配额超限 → 删除刚落的对象（不留孤儿；删除失败由孤儿清扫兜底）
          await this.removeBundleObjectsQuietly([objectKey, thumbKey]);
          throw err;
        }
      } catch (err) {
        // per-item 失败不中止批次（与 categories/routes 段同口径）
        fail(err instanceof Error ? err.message : String(err));
      }
    }

    return result;
  }

  /**
   * bundle 导入阶段 ④：把已落库的媒体行回绑到目标 doc。
   *
   * 三条边界（plan §0 PM M4）：
   * - 已绑同一 doc（重导复用行）→ no-op 成功，不产生 churn；
   * - 行已绑**别的** doc → failed（绝不"偷绑定"：跨空间导入不得把原空间的绑定改掉）；
   * - 行不存在/绑定失败 → failed，行保持 docId NULL 态（断链可见，重导可续绑）。
   */
  async bindBundleMedia(entries: BundleMediaBindEntry[]): Promise<BundleMediaBindResult> {
    const failures: BundleMediaBindResult['failures'] = [];
    let bound = 0;

    for (const entry of entries) {
      try {
        const row = await this.attachmentRepo.findOne({ where: { id: entry.attachmentId } });
        if (!row) {
          throw new Error(`attachment row ${entry.attachmentId} not found`);
        }
        if (row.docId === entry.docId) {
          bound++;
          continue;
        }
        if (row.docId !== null) {
          throw new Error(
            `attachment ${entry.attachmentId} is already bound to another doc; refusing to rebind`,
          );
        }
        await this.attachmentRepo.update({ id: entry.attachmentId }, { docId: entry.docId });
        bound++;
      } catch (err) {
        failures.push({
          docPath: entry.docPath,
          originalName: entry.originalName,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { bound, failures };
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
   * 在 importer 的 advisory 锁事务内执行 `fn`（bundle 导入的复用候选查询与插行共用）。
   *
   * 为什么锁键与上传同一把（`hashtextextended(uploaderId)`）：配额是**按 uploader** 的
   * 累计口径，bundle 导入与并发上传若用两把锁，两者各自的 SUM 都看不到对方的在途写入
   * → 双超卖。同一把锁让"上传/导入"在同一序列里排队。
   *
   * 锁范围刻意只含 `fn`（select + insert），对象 IO 留在锁外——与上传路径同纪律。
   */
  private async withQuotaLock<T>(
    importerId: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        importerId,
      ]);
      const out = await fn(queryRunner.manager);
      await queryRunner.commitTransaction();
      return out;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * 复用候选查询（plan §0 dx B1/arch M3/PM B1 行）：
   * `(uploaderId=importer, sha256, topicId NULL, status='ready', deletedAt NULL,
   *   docId NULL 或 = 该项 docPath 现解析 docId)`，确定性序 `createdAt ASC, id ASC`，
   * 取**本轮未配对**的第一条。
   *
   * 为什么必须 ORDER BY created_at, id：同一事务/同一毫秒插入的多行 `created_at` 相等，
   * 无 tie-break 时 PG 返回顺序不保证 → 重导可能配到另一行，正文重写结果随之抖动，
   * "二导 docs unchanged"的收敛性就没了。
   *
   * 为什么 docId NULL 行可共享：NULL = 尚未绑定（阶段 ② 刚落的行 / 阶段 ④ 绑定失败的
   * 残留），与空间无关，可被后续导入复用；已绑他空间 doc 的行被排除（跨空间不偷绑定）。
   *
   * 收敛性与"一次性 churn"语义（plan §0 dx B1/arch M3/PM B1 要求写明）：
   * - 稳态（同一 bundle 重复导入同一空间）= 稳定复用 + docs unchanged；
   * - **例外（版本噪声）**：若上次导入留下的行已被软删、被绑到别处、或状态不再是
   *   'ready'，复用键不再命中 → 本次会新建行与对象。这是**一次性**的：此后该空间
   *   的行重新满足复用键，下一轮即收敛。消费方对 bundle 做 git diff 时可能看到一次
   *   附件 id 变化（docs 从 unchanged 变 updated），属预期。
   */
  private async findReusableBundleRow(
    em: EntityManager,
    params: {
      importerId: string;
      sha256: string;
      resolvedDocId: string | null;
      excludedRowIds: ReadonlySet<string>;
    },
  ): Promise<Attachment | null> {
    const base = {
      uploaderId: params.importerId,
      sha256: params.sha256,
      topicId: IsNull(),
      deletedAt: IsNull(),
      status: 'ready',
    };
    const where =
      params.resolvedDocId === null
        ? [{ ...base, docId: IsNull() }]
        : [
            { ...base, docId: IsNull() },
            { ...base, docId: params.resolvedDocId },
          ];
    const rows = await em.find(Attachment, {
      where,
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.find((row) => !params.excludedRowIds.has(row.id)) ?? null;
  }

  /** 幂等删对象（MinIO 对不存在键安全）；失败只记日志——孤儿由清扫（批 4）兜底 */
  private async removeBundleObjectsQuietly(keys: Array<string | null>): Promise<void> {
    for (const key of keys) {
      if (!key) continue;
      await this.storage
        .removeObject(key)
        .catch((err) =>
          this.logger.error(
            `Bundle import object cleanup failed (key=${key}): ${(err as Error).message}`,
          ),
        );
    }
  }

  /**
   * DB 行 → 元数据 DTO。sizeBytes 显式 Number()（bigint string → number，
   * §2 钉死的唯一转换点）；bucket/objectKey/status 刻意不出（内部存储细节）。
   *
   * thumbnailContentUrl **条件展开**（P2 批 1 四表面同一口径）：有缩略图
   * （thumb_key 非空）才出现该键，无缩略图时字面缺键——绝不落 null/空串。
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
      ...(attachment.thumbKey ? { thumbnailContentUrl: buildThumbnailUrl(attachment.id) } : {}),
    };
  }
}

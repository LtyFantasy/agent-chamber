/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件短时签名 URL（capability URL）：铸造（mint）与公开端点验签/取流
 *
 * [代码职责]
 *   - `mint()`：读授权 → 变体可行性 fail-fast → HS256 签发 → 审计（不含 token）
 *   - `resolvePublicContent()`：验签三断言 → 行存活 → 变体取流（**不做授权检查**
 *     ——token 即凭证，这是公开端点与 /attachments/:id/content 的本质差异）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Attachments — 签名 URL 两端点契约 + 12006/12007/12008 语义
 *   - 补充: DEPLOY.md — ATTACHMENT_URL_SECRET 生产配置（强随机、不得与 JWT_SECRET 同值）
 *
 * [关键不变量]
 *   - 签名密钥独立于会话 JWT：只从 config `attachmentUrl.secret` 读取，逐调用显式传
 *     给 JwtService（全局 JwtModule 的 secret 是会话密钥，绝不能被沿用）
 *   - 断言顺序：验签 → scope/aid 断言 → 行查询（**先 401 后 404**——无效凭证不得
 *     借 404 探测附件是否存在；篡改 token + 不存在 id 必须是 401 而非 404）
 *   - 审计 `mint_attachment_url` 的 newData **禁含 token**（能力凭证不进审计面）
 *   - 铸造可安全重试：每次签发新 token，除审计行外无副作用（无状态，不落库）
 *
 * [关联代码]
 *   - config/attachment-url.config.ts — 密钥与默认 TTL 单一事实源
 *   - attachment.constants.ts — issuer/scope/变体值域/限流与 TTL 边界
 *   - dto/attachment-response.dto.ts — signedUrl 与响应形状拼装点
 *   - attachment-public.controller.ts — 公开端点（唯一消费 resolvePublicContent 的入口）
 *   - common/utils/redact-url.ts — 日志侧 token 脱敏（本能力的凭证不出现在日志）
 *
 * [持久踩坑]
 *   P2-B1(凭证同钥): 附件 token 若用会话密钥签发，则其签名在会话守卫处合法，
 *     只剩 payload 形状断言一层防线（无 sub 会被 TypeORM 丢 WHERE 条件命中首条用户）。
 *     安全方向: 独立密钥（生产拒绝同值）+ 守卫侧断言，双管不撤。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'stream';
import { AuditAction, ErrorCode } from '@agent-chamber/shared';
import { Attachment } from '../../database/entities/attachment.entity';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { UnifiedActor } from '../../common/types/actor.types';
import { AttachmentService } from './attachment.service';
import { AttachmentStorageService } from './storage.service';
import { MintSignedUrlDto } from './dto/mint-signed-url.dto';
import { MintSignedUrlResponse, buildSignedContentUrl } from './dto/attachment-response.dto';
import {
  ATTACHMENT_SIGNED_URL_DEFAULT_VARIANT,
  ATTACHMENT_SIGNED_URL_ISSUER,
  ATTACHMENT_SIGNED_URL_SCOPE,
  AttachmentSignedUrlVariant,
} from './attachment.constants';

/**
 * 12006 文案（逐字钉死，plan §②.6）：三断言失败的**粗粒度**归类——不回显 token
 * 原文/claims 明细（防 oracle），并明确指导下一步（重新铸造）与该端点无需 API Key。
 * export：公开 controller 的防御性形状复检复用同一条文案（逐字同源，禁止另写一份）。
 */
export const SIGNATURE_INVALID_MESSAGE =
  'Signed URL token is invalid (bad signature, wrong scope, or attachment id mismatch). ' +
  'Mint a new URL via POST /attachments/:id/signed-url; this public URL needs no API key.';

/** 12007 文案（逐字钉死，plan §②.6）：过期与"凭证被改"分码，同样给出行动指引 */
export const SIGNATURE_EXPIRED_MESSAGE =
  'Signed URL has expired. Mint a new URL via POST /attachments/:id/signed-url.';

/** 12008 文案（公开端点专属，逐字钉死，plan §②.6）：仅 var=thumbnail 路径可达 */
const PUBLIC_THUMBNAIL_UNAVAILABLE_MESSAGE =
  'No thumbnail available for this signed URL; mint with variant=original instead';

/** 12008 文案（铸造端点专属，逐字钉死，plan §②.6）：说明原因 + 替代变体 */
const MINT_THUMBNAIL_UNAVAILABLE_MESSAGE =
  'No thumbnail available for this attachment (uploaded before v1.75 or generation failed); ' +
  'mint with variant=original instead';

/** 公开端点取流结果（controller 只消费，不再自行判变体） */
export interface PublicAttachmentContent {
  attachment: Attachment;
  variant: AttachmentSignedUrlVariant;
  stream: Readable;
}

/**
 * 附件签名 URL 服务（P2 批 2 / plan §②）。
 *
 * 两职责：
 * 1. 铸造（鉴权端点）：`POST /attachments/:id/signed-url` → 相对路径 signedUrl；
 * 2. 消费（公开端点）：`GET /public/attachments/:id/content?token=` → 对象流。
 *
 * 为什么独立成服务而非并入 AttachmentService：签名/验签是**凭证域**（JWT 密钥、
 * issuer/scope、过期分码），与附件业务域（上传校验链/配额/授权矩阵）的变更节奏
 * 不同；独立文件也让"密钥只在这里被使用"成为可审计事实（grep 一处即知）。
 */
@Injectable()
export class AttachmentSignedUrlService {
  private readonly logger = new Logger(AttachmentSignedUrlService.name);

  /**
   * 签名密钥与默认 TTL 在构造期定格（storage.service 同款：配置读取点集中，
   * 进程生命周期内不变；env 变更需重启才生效）。
   */
  private readonly secret: string;
  private readonly ttlDefaultSeconds: number;

  constructor(
    @InjectRepository(Attachment)
    private readonly attachmentRepo: Repository<Attachment>,
    private readonly attachmentService: AttachmentService,
    private readonly storage: AttachmentStorageService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    // 默认值兜底与 config 工厂同值：单元测试/直构场景未提供 config 时行为可预期
    // （生产 fail-fast 由 config 工厂在启动期保证，不依赖本行）
    this.secret =
      configService.get<string>('attachmentUrl.secret') ||
      'default-attachment-url-secret-change-me';
    this.ttlDefaultSeconds = configService.get<number>('attachmentUrl.ttlDefaultSeconds') ?? 300;
  }

  /**
   * 铸造签名 URL（`POST /attachments/:id/signed-url`）。
   *
   * 顺序（每步失败即中断，后续不执行）：
   * 1. 读授权 + 软删 fail-fast（`findAccessible`：不存在/已软删/无权一律 404·12000，
   *    与 /content 同一入口同一语义——铸造不是绕过授权的通道）；
   * 2. variant=thumbnail 且无缩略图 → 404·12008（**fail fast**：签出注定 404 的 URL
   *    只会把问题推迟到消费方，此处当场说清原因与替代方案）；
   * 3. 签发 HS256 JWT（独立密钥；载荷 `{aid, var, scope}`）；
   * 4. 审计 fail-open（`mint_attachment_url`，newData 只有 variant/ttlSeconds/expiresAt）。
   *
   * @param id 附件 UUID（controller 已 ParseUUIDPipe 校验格式）
   * @param actor 已认证 actor（读授权判定方）
   * @param dto 请求体（ttlSeconds 边界已由 DTO 校验；此处只做缺省回填）
   */
  async mint(
    id: string,
    actor: UnifiedActor,
    dto: MintSignedUrlDto,
  ): Promise<MintSignedUrlResponse> {
    // 1. 读授权 + 软删 fail-fast（findOne 默认滤软删 → 已软删行等同不存在）
    const attachment = await this.attachmentService.findAccessible(id, actor);

    // 2. 变体可行性：无缩略图（存量行/生成失败）时不签缩略图 URL
    const variant = dto.variant ?? ATTACHMENT_SIGNED_URL_DEFAULT_VARIANT;
    if (variant === 'thumbnail' && !attachment.thumbKey) {
      throw new NotFoundException({
        message: MINT_THUMBNAIL_UNAVAILABLE_MESSAGE,
        code: ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE,
      });
    }

    // 3. 生效 TTL：请求显式值优先，否则 config 默认（两值都已落在 DTO/文档区间内）
    const ttlSeconds = dto.ttlSeconds ?? this.ttlDefaultSeconds;

    const token = this.jwtService.sign(
      { aid: attachment.id, var: variant, scope: ATTACHMENT_SIGNED_URL_SCOPE },
      {
        secret: this.secret,
        issuer: ATTACHMENT_SIGNED_URL_ISSUER,
        expiresIn: ttlSeconds,
        algorithm: 'HS256',
      },
    );

    // expiresAt 取自签出 token 的 exp（与验签同源）：另算 Date.now()+ttl 会因
    // 秒取整/时钟边界与 token 实际到期时刻出现毫秒级不一致（响应说谎即消费方早/晚判）
    const decoded = this.jwtService.decode(token) as { exp?: unknown } | null;
    const expiresAtSeconds =
      decoded && typeof decoded.exp === 'number'
        ? decoded.exp
        : Math.floor(Date.now() / 1000) + ttlSeconds;

    // 4. 审计（fail-open，AuditService.log 内部兜底）：只记元信息，**禁含 token**
    await this.auditService.log({
      action: AuditAction.MINT_ATTACHMENT_URL,
      entityType: AUDIT_ENTITY_TYPE.ATTACHMENT,
      entityId: attachment.id,
      actorId: actor.id,
      newData: {
        variant,
        ttlSeconds,
        expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      },
      source: 'api',
    });

    this.logger.log(
      `Signed URL minted: attachmentId=${attachment.id}, actorId=${actor.id}, ` +
        `variant=${variant}, ttlSeconds=${ttlSeconds}`,
    );

    return {
      signedUrl: buildSignedContentUrl(attachment.id, token),
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      variant,
    };
  }

  /**
   * 公开端点取流（`GET /public/attachments/:id/content?token=`）。
   *
   * 顺序钉死（**先 401 后 404**）：验签三断言 → 行存活（404·12000）→ 变体取流。
   * 若反序，篡改 token + 不存在 id 就会先暴露 404，把公开端点变成附件 ID 探测面。
   *
   * 授权检查刻意**不做**：token 即凭证（capability URL 语义）；行已软删等同不存在
   * （404·12000），这是能力 URL 的唯一失效手段（无撤销列表，TTL 是天然窗口）。
   */
  async resolvePublicContent(id: string, token: string): Promise<PublicAttachmentContent> {
    const variant = this.verifySignedUrlToken(id, token);

    const attachment = await this.attachmentRepo.findOne({ where: { id } });
    if (!attachment) {
      throw new NotFoundException({
        message: 'Attachment not found',
        code: ErrorCode.ATTACHMENT_NOT_FOUND,
      });
    }

    if (variant === 'thumbnail') {
      if (!attachment.thumbKey) {
        // 铸造侧已 fail-fast；能到这里的情况：token 为 thumb 变体但缩略图对象列被清空
        // （软删对象清理/数据修复）——仍用 12008 与"附件不可达"区分
        throw new NotFoundException({
          message: PUBLIC_THUMBNAIL_UNAVAILABLE_MESSAGE,
          code: ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE,
        });
      }
      return { attachment, variant, stream: await this.storage.getObject(attachment.thumbKey) };
    }

    return { attachment, variant, stream: await this.storage.getObject(attachment.objectKey) };
  }

  /**
   * 验签 + 三断言（不查库）。
   *
   * - 验签：独立密钥 + 钉死 issuer + algorithms 白名单（**显式限 HS256**：不给
   *   `alg` 混淆留面——虽然 jsonwebtoken 对非对称键有防护，白名单是最便宜的确定性）；
   * - 断言：`scope === 'attachment:content'`（用途）、`aid === 路径 :id`（张冠李戴）、
   *   `var` ∈ 变体值域（载荷形状，非白名单值无从分支）；
   * - 过期与其它失败分码：jsonwebtoken 的 TokenExpiredError 经 `name` 识别
   *   （jsonwebtoken 不是本包直接依赖，不做 instanceof import），其余（签名不符/
   *   issuer 不符/结构损坏）统一 12006。
   *
   * @throws UnauthorizedException 12007（过期）/ 12006（其余失败）
   */
  private verifySignedUrlToken(id: string, token: string): AttachmentSignedUrlVariant {
    let payload: unknown;
    try {
      payload = this.jwtService.verify(token, {
        secret: this.secret,
        issuer: ATTACHMENT_SIGNED_URL_ISSUER,
        algorithms: ['HS256'],
      });
    } catch (err) {
      const expired = (err as { name?: string } | null)?.name === 'TokenExpiredError';
      throw new UnauthorizedException({
        message: expired ? SIGNATURE_EXPIRED_MESSAGE : SIGNATURE_INVALID_MESSAGE,
        code: expired
          ? ErrorCode.ATTACHMENT_SIGNATURE_EXPIRED
          : ErrorCode.ATTACHMENT_SIGNATURE_INVALID,
      });
    }

    const claims = (typeof payload === 'object' && payload !== null ? payload : {}) as {
      aid?: unknown;
      var?: unknown;
      scope?: unknown;
    };
    const variant = claims.var;
    const variantValid =
      typeof variant === 'string' && (variant === 'original' || variant === 'thumbnail');
    if (claims.scope !== ATTACHMENT_SIGNED_URL_SCOPE || claims.aid !== id || !variantValid) {
      throw new UnauthorizedException({
        message: SIGNATURE_INVALID_MESSAGE,
        code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID,
      });
    }
    return variant as AttachmentSignedUrlVariant;
  }
}

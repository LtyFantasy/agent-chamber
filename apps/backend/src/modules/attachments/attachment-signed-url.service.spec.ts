/**
 * AttachmentSignedUrlService 单测（P2 批 2 / plan §②：铸造 + 公开端点验签）。
 *
 * 覆盖点（对应 plan §②.8 单测行 + §②.6 逐端点文案表）：
 * - 铸造：默认 TTL 300 / 显式 TTL / 载荷与签名参数（独立密钥、issuer、HS256、
 *   {aid,var,scope}）/ 无缩略图变体 → 404·12008 逐字 / 审计不含 token；
 * - 验签：三断言反例（签名/scope/aid）+ 变体值域 → 401·12006 逐字；
 *   过期 → 401·12007 逐字；**先 401 后 404**（篡改 token + 不存在 id 必须 401）；
 * - 取流：original 走 objectKey / thumbnail 走 thumbKey；行缺失 → 404·12000；
 *   thumb 列被清空 → 404·12008 逐字（公开端点专属文案）。
 */
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { ActorType, AuditAction, ErrorCode, UserRole } from '@agent-chamber/shared';
import { AttachmentSignedUrlService } from './attachment-signed-url.service';
import { AttachmentService } from './attachment.service';
import { AttachmentStorageService } from './storage.service';
import { AuditService } from '../audit/audit.service';
import { Attachment } from '../../database/entities/attachment.entity';
import { UnifiedActor } from '../../common/types/actor.types';
import { ATTACHMENT_SIGNED_URL_ISSUER, ATTACHMENT_SIGNED_URL_SCOPE } from './attachment.constants';

const ATTACHMENT_URL_SECRET = 'test-attachment-url-secret';
const ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ID = '99999999-8888-7777-6666-555555555555';

const ACTOR: UnifiedActor = {
  id: 'actor-1',
  type: ActorType.HUMAN,
  name: 'Tester',
  role: UserRole.EDITOR,
};

/** 附件行（只带本服务读取的列；类型断言避免造全字段） */
function attachmentRow(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: ID,
    objectKey: 'obj-original.png',
    thumbKey: 'obj.thumb.webp',
    mimeType: 'image/png',
    originalName: '图.png',
    sha256: 'a'.repeat(64),
    thumbSha256: 'b'.repeat(64),
    uploaderId: ACTOR.id,
    topicId: null,
    docId: null,
    ...overrides,
  } as Attachment;
}

describe('AttachmentSignedUrlService', () => {
  let service: AttachmentSignedUrlService;
  let jwtService: JwtService;
  let attachmentService: { findAccessible: jest.Mock };
  let attachmentRepo: { findOne: jest.Mock };
  let storage: { getObject: jest.Mock };
  let auditService: { log: jest.Mock };

  beforeEach(() => {
    jwtService = new JwtService({});
    attachmentService = { findAccessible: jest.fn(async () => attachmentRow()) };
    attachmentRepo = { findOne: jest.fn(async () => attachmentRow()) };
    storage = { getObject: jest.fn(async (key: string) => Readable.from([Buffer.from(key)])) };
    auditService = { log: jest.fn(async () => undefined) };

    service = new AttachmentSignedUrlService(
      attachmentRepo as never,
      attachmentService as unknown as AttachmentService,
      storage as unknown as AttachmentStorageService,
      auditService as unknown as AuditService,
      jwtService,
      {
        get: (key: string) =>
          key === 'attachmentUrl.secret'
            ? ATTACHMENT_URL_SECRET
            : key === 'attachmentUrl.ttlDefaultSeconds'
              ? 300
              : undefined,
      } as unknown as ConfigService,
    );
  });

  /** 用服务自己的密钥/issuer 手签一枚 token（验签路径的对照组） */
  const signToken = (
    payload: Record<string, unknown>,
    options: { expiresIn?: number | string } = {},
  ): string =>
    jwtService.sign(payload, {
      secret: ATTACHMENT_URL_SECRET,
      issuer: ATTACHMENT_SIGNED_URL_ISSUER,
      algorithm: 'HS256',
      expiresIn: options.expiresIn ?? 300,
    });

  // ─── 铸造 ────────────────────────────────────────────────────

  describe('mint', () => {
    it('默认 TTL = config 300：token exp-iat=300、响应 expiresAt 与 token 同源、variant 回声 original', async () => {
      const res = await service.mint(ID, ACTOR, {});

      expect(res.variant).toBe('original');
      expect(res.signedUrl.startsWith(`/api/v1/public/attachments/${ID}/content?token=`)).toBe(
        true,
      );

      const token = res.signedUrl.split('token=')[1];
      const decoded = jwtService.verify(token, {
        secret: ATTACHMENT_URL_SECRET,
        issuer: ATTACHMENT_SIGNED_URL_ISSUER,
      }) as { aid: string; var: string; scope: string; iat: number; exp: number };
      expect(decoded).toMatchObject({
        aid: ID,
        var: 'original',
        scope: ATTACHMENT_SIGNED_URL_SCOPE,
      });
      expect(decoded.exp - decoded.iat).toBe(300);
      // expiresAt 取自 token exp（不另算时钟）：秒级对齐
      expect(new Date(res.expiresAt).getTime()).toBe(decoded.exp * 1000);
    });

    it('token 头部 alg=HS256（不得是 none/其它算法）', async () => {
      const res = await service.mint(ID, ACTOR, {});
      const header = JSON.parse(
        Buffer.from(res.signedUrl.split('token=')[1].split('.')[0], 'base64url').toString('utf8'),
      ) as { alg: string };
      expect(header.alg).toBe('HS256');
    });

    it('显式 ttlSeconds 生效（900 → exp-iat=900，审计 ttlSeconds=900）', async () => {
      const res = await service.mint(ID, ACTOR, { ttlSeconds: 900 });
      const decoded = jwtService.decode(res.signedUrl.split('token=')[1]) as {
        exp: number;
        iat: number;
      };
      expect(decoded.exp - decoded.iat).toBe(900);
      expect(auditService.log.mock.calls[0][0].newData.ttlSeconds).toBe(900);
    });

    it('variant=thumbnail 且有缩略图：token var=thumbnail、响应 variant 回声', async () => {
      const res = await service.mint(ID, ACTOR, { variant: 'thumbnail' });
      expect(res.variant).toBe('thumbnail');
      const decoded = jwtService.decode(res.signedUrl.split('token=')[1]) as { var: string };
      expect(decoded.var).toBe('thumbnail');
    });

    it('variant=thumbnail 但无缩略图 → 404·12008，消息逐字指导改用 original', async () => {
      attachmentService.findAccessible.mockResolvedValue(attachmentRow({ thumbKey: null }));

      await expect(service.mint(ID, ACTOR, { variant: 'thumbnail' })).rejects.toMatchObject({
        status: 404,
        response: {
          code: ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE,
          message:
            'No thumbnail available for this attachment (uploaded before v1.75 or generation failed); ' +
            'mint with variant=original instead',
        },
      });
      // fail fast：不签 token、不写审计
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('审计 mint_attachment_url：entityType=attachment/actorId/newData 无 token', async () => {
      const res = await service.mint(ID, ACTOR, { ttlSeconds: 120 });
      const token = res.signedUrl.split('token=')[1];

      expect(auditService.log).toHaveBeenCalledTimes(1);
      const entry = auditService.log.mock.calls[0][0] as {
        action: string;
        entityType: string;
        entityId: string;
        actorId: string;
        newData: Record<string, unknown>;
        source: string;
      };
      expect(entry.action).toBe(AuditAction.MINT_ATTACHMENT_URL);
      expect(entry.action).toBe('mint_attachment_url');
      expect(entry.entityType).toBe('attachment');
      expect(entry.entityId).toBe(ID);
      expect(entry.actorId).toBe(ACTOR.id);
      expect(entry.source).toBe('api');
      expect(entry.newData).toEqual({
        variant: 'original',
        ttlSeconds: 120,
        expiresAt: res.expiresAt,
      });
      // 能力凭证绝不进审计面（键不存在 or 值不含 token 片段）
      expect(Object.hasOwn(entry.newData, 'token')).toBe(false);
      expect(JSON.stringify(entry)).not.toContain(token);
    });

    it('读授权失败（不存在/无权/已软删）原样透传，不签 token 不写审计', async () => {
      attachmentService.findAccessible.mockRejectedValue(
        Object.assign(new Error('Attachment not found'), {
          status: 404,
          response: { code: ErrorCode.ATTACHMENT_NOT_FOUND, message: 'Attachment not found' },
        }),
      );

      await expect(service.mint(ID, ACTOR, {})).rejects.toMatchObject({ status: 404 });
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  // ─── 公开端点：验签与取流 ─────────────────────────────────────

  describe('resolvePublicContent', () => {
    it('合法 token（original）→ 行 + 原图对象流', async () => {
      const token = signToken({ aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE });
      const res = await service.resolvePublicContent(ID, token);

      expect(res.variant).toBe('original');
      expect(res.attachment.id).toBe(ID);
      expect(storage.getObject).toHaveBeenCalledWith('obj-original.png');
    });

    it('合法 token（thumbnail）→ 缩略图对象流', async () => {
      const token = signToken({ aid: ID, var: 'thumbnail', scope: ATTACHMENT_SIGNED_URL_SCOPE });
      const res = await service.resolvePublicContent(ID, token);

      expect(res.variant).toBe('thumbnail');
      expect(storage.getObject).toHaveBeenCalledWith('obj.thumb.webp');
    });

    it('三断言反例①：签名不符（另一密钥签发）→ 401·12006 逐字', async () => {
      const token = jwtService.sign(
        { aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE },
        { secret: 'wrong-secret', issuer: ATTACHMENT_SIGNED_URL_ISSUER, algorithm: 'HS256' },
      );

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 401,
        response: {
          code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID,
          message:
            'Signed URL token is invalid (bad signature, wrong scope, or attachment id mismatch). ' +
            'Mint a new URL via POST /attachments/:id/signed-url; this public URL needs no API key.',
        },
      });
      expect(attachmentRepo.findOne).not.toHaveBeenCalled();
    });

    it('三断言反例②：scope 不符（同一密钥手签）→ 401·12006', async () => {
      const token = signToken({ aid: ID, var: 'original', scope: 'session' });

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 401,
        response: { code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID },
      });
    });

    it('三断言反例③：aid 与路径不符 → 401·12006（张冠李戴）', async () => {
      const token = signToken({
        aid: OTHER_ID,
        var: 'original',
        scope: ATTACHMENT_SIGNED_URL_SCOPE,
      });

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 401,
        response: { code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID },
      });
    });

    it('载荷形状反例：var 不在变体值域 → 401·12006（不猜测分支）', async () => {
      const token = signToken({ aid: ID, var: 'raw', scope: ATTACHMENT_SIGNED_URL_SCOPE });

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 401,
        response: { code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID },
      });
    });

    it('issuer 不符（同一密钥但其它 issuer）→ 401·12006', async () => {
      const token = jwtService.sign(
        { aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE },
        { secret: ATTACHMENT_URL_SECRET, issuer: 'somewhere-else', algorithm: 'HS256' },
      );

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 401,
        response: { code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID },
      });
    });

    it('过期（expiresIn 为负）→ 401·12007 逐字（与 12006 分码）', async () => {
      const token = signToken(
        { aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE },
        { expiresIn: -10 },
      );

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 401,
        response: {
          code: ErrorCode.ATTACHMENT_SIGNATURE_EXPIRED,
          message: 'Signed URL has expired. Mint a new URL via POST /attachments/:id/signed-url.',
        },
      });
    });

    it('顺序不变量：篡改 token + 不存在的 id → 401（不得用 404 探测存在性）', async () => {
      attachmentRepo.findOne.mockResolvedValue(null);
      const token = signToken({ aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE });
      // 篡改末位（签名失效）
      const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'a' ? 'b' : 'a'}`;

      await expect(service.resolvePublicContent(ID, tampered)).rejects.toMatchObject({
        status: 401,
        response: { code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID },
      });
      expect(attachmentRepo.findOne).not.toHaveBeenCalled();
    });

    it('合法 token + 行不存在/已软删（findOne 返回 null）→ 404·12000', async () => {
      attachmentRepo.findOne.mockResolvedValue(null);
      const token = signToken({ aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE });

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.ATTACHMENT_NOT_FOUND, message: 'Attachment not found' },
      });
      expect(storage.getObject).not.toHaveBeenCalled();
    });

    it('thumbnail 变体但 thumbKey 被清空 → 404·12008 逐字（公开端点专属文案）', async () => {
      attachmentRepo.findOne.mockResolvedValue(attachmentRow({ thumbKey: null }));
      const token = signToken({ aid: ID, var: 'thumbnail', scope: ATTACHMENT_SIGNED_URL_SCOPE });

      await expect(service.resolvePublicContent(ID, token)).rejects.toMatchObject({
        status: 404,
        response: {
          code: ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE,
          message: 'No thumbnail available for this signed URL; mint with variant=original instead',
        },
      });
      expect(storage.getObject).not.toHaveBeenCalled();
    });

    it('公开路径不做授权检查（token 即凭证）：不调用 findAccessible', async () => {
      const token = signToken({ aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE });
      await service.resolvePublicContent(ID, token);

      expect(attachmentService.findAccessible).not.toHaveBeenCalled();
    });
  });
});

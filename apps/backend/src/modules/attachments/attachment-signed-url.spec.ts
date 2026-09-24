/**
 * 签名 URL 两端点 HTTP 层单测（P2 批 2 / plan §②.3-§②.6）。
 *
 * 与 service 单测的分工：这里跑**真 DTO 校验 + 真 controller + 真 service**
 * （仅 mock 仓储/存储/授权），验证 HTTP 边界：
 * - mint：ttlSeconds 越界（59/3601）、variant 非法、字符串 ttl → 400 诚实拒；
 *   合法请求 200 + `Cache-Control: no-store`（响应体含能力凭证）；
 * - 公开端点：token 缺失/空串/数组 → 400（DTO 形状层）；篡改 → 401·12006 逐字；
 *   过期 → 401·12007 逐字；合法 → 200 + 响应头（含 thumbnail 变体的 webp/文件名/ETag）；
 *   行缺失 → 404·12000；thumb 缺失 → 404·12008 逐字。
 *
 * 环境复刻：与 main.ts 同款 ValidationPipe（whitelist/forbidNonWhitelisted/transform）
 * + 全局 AllExceptionsFilter（错误信封与生产同形状）；guard 用 stub 注入 actor
 * （认证链本身由 jwt-or-api-key.guard.spec / e2e 覆盖）。
 */
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import request = require('supertest');
import { ActorType, AuditAction, ErrorCode, UserRole } from '@agent-chamber/shared';
import { AttachmentController } from './attachment.controller';
import { AttachmentPublicController } from './attachment-public.controller';
import { AttachmentService } from './attachment.service';
import { AttachmentSignedUrlService } from './attachment-signed-url.service';
import { AttachmentStorageService } from './storage.service';
import { AuditService } from '../audit/audit.service';
import { MulterLimitErrorInterceptor } from './multer-error.interceptor';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';
import { Attachment } from '../../database/entities/attachment.entity';
import { ATTACHMENT_SIGNED_URL_ISSUER, ATTACHMENT_SIGNED_URL_SCOPE } from './attachment.constants';

const ATTACHMENT_URL_SECRET = 'test-attachment-url-secret';
const ID = '11111111-2222-3333-4444-555555555555';
const GUARD_ACTOR = { userId: 'actor-1', name: 'Tester', role: UserRole.EDITOR };

/** 附件行（原图 + 缩略图俱在；逐用例覆写） */
function attachmentRow(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: ID,
    objectKey: 'obj-original.png',
    thumbKey: 'obj.thumb.webp',
    mimeType: 'image/png',
    originalName: '链路 图.png',
    sha256: 'a'.repeat(64),
    thumbSha256: 'b'.repeat(64),
    ...overrides,
  } as Attachment;
}

describe('签名 URL 端点（HTTP 层）', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let repoRow: Attachment | null;
  let attachmentService: { findAccessible: jest.Mock };
  let storage: { getObject: jest.Mock };
  let auditService: { log: jest.Mock };
  let mintResult: { signedUrl: string; expiresAt: string; variant: string } | null;

  /** 用服务同一密钥/issuer 手签 token（正例与篡改对照） */
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

  const validToken = (): string =>
    signToken({ aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE });

  /** 收原始字节（StreamableFile 响应体不是 JSON） */
  function collectBody(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  }

  beforeAll(async () => {
    jwtService = new JwtService({});
    repoRow = attachmentRow();
    attachmentService = { findAccessible: jest.fn(async () => repoRow as Attachment) };
    storage = { getObject: jest.fn(async (key: string) => Readable.from([Buffer.from(key)])) };
    auditService = { log: jest.fn(async () => undefined) };
    mintResult = null;

    const signedUrlService = new AttachmentSignedUrlService(
      { findOne: jest.fn(async () => repoRow) } as never,
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
    // 铸造结果由 service 真实现签出；此处只代理调用以便断言 DTO 透传
    const spyService = {
      mint: jest.fn((id: string, actor: unknown, dto: unknown) => {
        const result = signedUrlService.mint(id, actor as never, dto as never);
        return result.then((r) => {
          mintResult = { ...r };
          return r;
        });
      }),
      resolvePublicContent: signedUrlService.resolvePublicContent.bind(signedUrlService),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AttachmentController, AttachmentPublicController],
      providers: [
        { provide: AttachmentService, useValue: attachmentService },
        { provide: AttachmentSignedUrlService, useValue: spyService },
        { provide: JwtService, useValue: jwtService },
        MulterLimitErrorInterceptor,
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          const req = ctx.switchToHttp().getRequest();
          const headers = req.headers as Record<string, string | undefined>;
          // 认证失败路径的可控开关（mint 必须要求认证）
          if (headers['x-test-unauth']) {
            throw new UnauthorizedException({
              message: 'Authentication required',
              code: ErrorCode.UNAUTHORIZED,
            });
          }
          req.user = { ...GUARD_ACTOR };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    repoRow = attachmentRow();
    mintResult = null;
    attachmentService.findAccessible.mockClear();
    storage.getObject.mockClear();
    auditService.log.mockClear();
  });

  // ─── 铸造端点 ────────────────────────────────────────────────

  describe('POST /attachments/:id/signed-url', () => {
    it('合法请求（空体）→ 200：默认 TTL 300、no-store、响应形状 {signedUrl,expiresAt,variant}', async () => {
      const res = await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .send({})
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.variant).toBe('original');
      expect(res.body.signedUrl).toContain(`/api/v1/public/attachments/${ID}/content?token=`);
      // expiresAt 与签出 token 的 exp 同源（≈ now + 300s）
      const decoded = jwtService.decode(res.body.signedUrl.split('token=')[1]) as { exp: number };
      expect(new Date(res.body.expiresAt).getTime()).toBe(decoded.exp * 1000);
      expect(auditService.log.mock.calls[0][0].action).toBe(AuditAction.MINT_ATTACHMENT_URL);
    });

    it('无请求体 → 仍 200（DTO 全可选；Express json 解析给 {}）', async () => {
      await request(app.getHttpServer()).post(`/attachments/${ID}/signed-url`).expect(200);
    });

    it('ttlSeconds=59 → 400（越界诚实拒，不钳制）', async () => {
      const res = await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .send({ ttlSeconds: 59 })
        .expect(400);
      expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
    });

    it('ttlSeconds=3601 → 400', async () => {
      await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .send({ ttlSeconds: 3601 })
        .expect(400);
    });

    it('ttlSeconds 为字符串 "300" → 400（JSON 体不做类型宽容转换）', async () => {
      await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .send({ ttlSeconds: '300' })
        .expect(400);
    });

    it('variant=webp（非白名单值）→ 400', async () => {
      await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .send({ variant: 'webp' })
        .expect(400);
    });

    it('未知字段（forbidNonWhitelisted）→ 400', async () => {
      await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .send({ variant: 'original', token: 'sneaky' })
        .expect(400);
    });

    it(':id 非 UUID → 400（ParseUUIDPipe 早于 service）', async () => {
      await request(app.getHttpServer())
        .post(`/attachments/not-a-uuid/signed-url`)
        .send({})
        .expect(400);
      expect(attachmentService.findAccessible).not.toHaveBeenCalled();
    });

    it('未认证 → 401（铸造必须先鉴权）', async () => {
      await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .set('x-test-unauth', '1')
        .send({})
        .expect(401);
    });

    it('variant=thumbnail 且无缩略图 → 404·12008 逐字（fail fast）', async () => {
      repoRow = attachmentRow({ thumbKey: null });
      const res = await request(app.getHttpServer())
        .post(`/attachments/${ID}/signed-url`)
        .send({ variant: 'thumbnail' })
        .expect(404);

      expect(res.body.code).toBe(ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE);
      expect(res.body.message).toBe(
        'No thumbnail available for this attachment (uploaded before v1.75 or generation failed); ' +
          'mint with variant=original instead',
      );
      expect(mintResult).toBeNull();
    });
  });

  // ─── 公开端点 ────────────────────────────────────────────────

  describe('GET /public/attachments/:id/content', () => {
    it('合法 token → 200：字节 + 五头（Content-Type 取 DB/Disposition/nosniff/private/ETag）', async () => {
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${validToken()}`)
        .buffer(true)
        .parse(collectBody)
        .expect(200);

      expect((res.body as Buffer).toString()).toBe('obj-original.png');
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toContain("inline; filename*=UTF-8''");
      // 能力 URL 场景：private 且**无 max-age**（共享缓存 = 凭证扩散）
      expect(res.headers['cache-control']).toBe('private');
      expect(res.headers['etag']).toBe(`"${'a'.repeat(64)}"`);
    });

    it('thumbnail token → 200：webp 恒格式 + _thumb.webp 文件名 + thumb ETag', async () => {
      const token = signToken({ aid: ID, var: 'thumbnail', scope: ATTACHMENT_SIGNED_URL_SCOPE });
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${token}`)
        .buffer(true)
        .parse(collectBody)
        .expect(200);

      expect((res.body as Buffer).toString()).toBe('obj.thumb.webp');
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['content-disposition']).toContain('_thumb.webp');
      expect(res.headers['etag']).toBe(`"${'b'.repeat(64)}"`);
      expect(res.headers['cache-control']).toBe('private');
    });

    it('无 Authorization 头也可读（公开端点语义：token 即凭证）', async () => {
      await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${validToken()}`)
        .expect(200);
    });

    it('token 缺失 → 400（DTO 形状层：格式错误不进验签）', async () => {
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content`)
        .expect(400);
      expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
    });

    it('token 为空串 → 400', async () => {
      await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=`)
        .expect(400);
    });

    it('数组形态 ?token=a&token=b → 400（拒数组，不把数组喂给验签器）', async () => {
      await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=a&token=b`)
        .expect(400);
    });

    it('篡改 token → 401·12006 逐字（含行动指引）', async () => {
      const token = validToken();
      const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'a' ? 'b' : 'a'}`;
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${tampered}`)
        .expect(401);

      expect(res.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);
      expect(res.body.message).toBe(
        'Signed URL token is invalid (bad signature, wrong scope, or attachment id mismatch). ' +
          'Mint a new URL via POST /attachments/:id/signed-url; this public URL needs no API key.',
      );
    });

    it('用户会话 token（无 scope，同一密钥手签）→ 401·12006（凭证族隔离）', async () => {
      const sessionToken = signToken({
        sub: GUARD_ACTOR.userId,
        email: 'u@example.com',
        role: 'editor',
      });
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${sessionToken}`)
        .expect(401);
      expect(res.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);
    });

    it('过期 token → 401·12007 逐字', async () => {
      const token = signToken(
        { aid: ID, var: 'original', scope: ATTACHMENT_SIGNED_URL_SCOPE },
        { expiresIn: -10 },
      );
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${token}`)
        .expect(401);

      expect(res.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_EXPIRED);
      expect(res.body.message).toBe(
        'Signed URL has expired. Mint a new URL via POST /attachments/:id/signed-url.',
      );
    });

    it('篡改 token + 附件不存在 → 401 而非 404（不得用 404 探测存在性）', async () => {
      repoRow = null;
      const token = validToken();
      const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'a' ? 'b' : 'a'}`;
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${tampered}`)
        .expect(401);
      expect(res.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);
    });

    it('合法 token + 附件不存在/已软删 → 404·12000', async () => {
      repoRow = null;
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${validToken()}`)
        .expect(404);
      expect(res.body.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);
    });

    it('thumbnail token + thumb 缺失 → 404·12008 逐字（公开端点专属文案）', async () => {
      repoRow = attachmentRow({ thumbKey: null });
      const token = signToken({ aid: ID, var: 'thumbnail', scope: ATTACHMENT_SIGNED_URL_SCOPE });
      const res = await request(app.getHttpServer())
        .get(`/public/attachments/${ID}/content?token=${token}`)
        .expect(404);

      expect(res.body.code).toBe(ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE);
      expect(res.body.message).toBe(
        'No thumbnail available for this signed URL; mint with variant=original instead',
      );
    });

    it(':id 非 UUID → 400（ParseUUIDPipe 早于验签）', async () => {
      await request(app.getHttpServer())
        .get(`/public/attachments/not-a-uuid/content?token=${validToken()}`)
        .expect(400);
    });

    it('路由元数据回归：handler 标 @Public()/@SkipTransform()、类级无守卫（公开端点的存在理由，不得被"顺手加守卫"）', async () => {
      // 全局 JwtAuthGuard 靠 IS_PUBLIC_KEY 放行；类级若挂守卫，浏览器 <img src>
      // （带不了 Authorization 头）将永远 401——这条断言是防回归的机械门。
      const handler = AttachmentPublicController.prototype.getPublicContent;
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata(SKIP_TRANSFORM_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata('__guards__', AttachmentPublicController)).toBeUndefined();
    });
  });
});

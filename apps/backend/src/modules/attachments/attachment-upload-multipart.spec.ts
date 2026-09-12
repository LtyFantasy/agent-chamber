/**
 * multipart 解析实测（全仓首个 FileInterceptor 的落地 proof）
 *
 * 要证明的事（plan 批次 1 验收钉死）：在 main.ts 现有 bodyParser 配置
 * （NestFactory.create(AppModule, { bodyParser: false }) + 手动 json/urlencoded
 * 各 10mb——main.ts:15-17）下，FileInterceptor('file') 的 multipart 解析正常工作。
 * body-parser 从不处理 multipart（multer 独立于它挂在路由层），本套件用
 * supertest + 测试 Nest app 复刻该配置实证，而非靠推理。
 *
 * storage 侧不触及：AttachmentService 整体 mock（解析链路的证据 =
 * controller 收到的 file.buffer 与上传字节逐位相等）。
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import request = require('supertest');
import { ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { MulterLimitErrorInterceptor } from './multer-error.interceptor';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ATTACHMENT_MAX_BYTES } from './attachment.constants';
import { makePngBuffer } from './test-image-fixtures';
import { UnifiedActor } from '../../common/types/actor.types';

const GUARD_ACTOR: UnifiedActor = {
  id: 'actor-1',
  type: ActorType.HUMAN,
  name: 'Tester',
  role: UserRole.EDITOR,
};

describe('AttachmentController multipart 解析实测（复刻 main.ts bodyParser 配置）', () => {
  let app: INestApplication;
  let service: {
    upload: jest.Mock;
    findMine: jest.Mock;
    getMetadata: jest.Mock;
    getContent: jest.Mock;
    remove: jest.Mock;
  };

  beforeAll(async () => {
    service = {
      upload: jest.fn(async () => ({
        id: 'att-1',
        contentUrl: '/api/v1/attachments/att-1/content',
      })),
      findMine: jest.fn(),
      getMetadata: jest.fn(),
      getContent: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AttachmentController],
      providers: [{ provide: AttachmentService, useValue: service }, MulterLimitErrorInterceptor],
    })
      // guard mock：认证通过并把 human 身份塞进 request.user（@CurrentActor 的读取源）
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { userId: GUARD_ACTOR.id, name: GUARD_ACTOR.name, role: GUARD_ACTOR.role };
          return true;
        },
      })
      .compile();

    // 复刻 main.ts:15-17（bodyParser:false + 手动 json/urlencoded 10mb）——
    // 这是"现有 bodyParser 配置下 multipart 正常"命题的对照环境，不是随手搭的默认 app
    app = module.createNestApplication({ bodyParser: false });
    app.use(json({ limit: '10mb' }));
    app.use(urlencoded({ extended: true, limit: '10mb' }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.upload.mockClear();
  });

  it('FileInterceptor 解析成功：buffer 逐位相等、文件名/query/actor 全部到位', async () => {
    const png = makePngBuffer(2, 2);
    await request(app.getHttpServer())
      .post('/attachments?topicId=11111111-2222-3333-4444-555555555555')
      .attach('file', png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);

    expect(service.upload).toHaveBeenCalledTimes(1);
    const [actor, query, file] = service.upload.mock.calls[0];
    expect(actor).toMatchObject({ id: GUARD_ACTOR.id, type: ActorType.HUMAN });
    expect(query).toMatchObject({ topicId: '11111111-2222-3333-4444-555555555555' });
    expect(file.fieldname).toBe('file');
    expect(file.originalname).toBe('photo.png');
    expect(Buffer.compare(file.buffer, png)).toBe(0); // 字节级相等
    expect(file.size).toBe(png.length);
  });

  it('unicode 文件名字节无损到达（latin1 解读形态；mojibake 还原归 service sanitize）', async () => {
    const png = makePngBuffer(2, 2);
    await request(app.getHttpServer())
      .post('/attachments?docId=11111111-2222-3333-4444-555555555555')
      .attach('file', png, { filename: '截图 2026-09-09.png', contentType: 'image/png' })
      .expect(201);
    // busboy defParamCharset=latin1 的现实行为（multer 2.x 无配置入口，源码实证）：
    // controller 收到 latin1 解读形态，UTF-8 字节无损；还原为应用层职责，
    // 由 filename-sanitize.spec / attachment.service.spec 覆盖
    expect(service.upload.mock.calls[0][2].originalname).toBe(
      Buffer.from('截图 2026-09-09.png', 'utf8').toString('latin1'),
    );
  });

  it('超 ATTACHMENT_MAX_BYTES → 413 且 code=12001（MulterLimitErrorInterceptor 映射生效）', async () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1024, 0x61);
    const res = await request(app.getHttpServer())
      .post('/attachments?topicId=11111111-2222-3333-4444-555555555555')
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' })
      .expect(413);
    // 无全局 filter 的测试 app：Nest 默认序列化 exception response = {message, code}
    expect(res.body.code).toBe(ErrorCode.ATTACHMENT_TOO_LARGE);
    // multer 在路由层即拒，service 不被触达
    expect(service.upload).not.toHaveBeenCalled();
  });

  it('不带 file 字段：请求正常抵达 handler（file=undefined 交 service 判定）', async () => {
    await request(app.getHttpServer())
      .post('/attachments?topicId=11111111-2222-3333-4444-555555555555')
      .expect(201);
    expect(service.upload).toHaveBeenCalledTimes(1);
    expect(service.upload.mock.calls[0][2]).toBeUndefined();
  });

  it('字段名错误（非 file）→ 400（multer LIMIT_UNEXPECTED_FILE 经 transformException）', async () => {
    const png = makePngBuffer(2, 2);
    await request(app.getHttpServer())
      .post('/attachments?topicId=11111111-2222-3333-4444-555555555555')
      .attach('wrong', png, { filename: 'a.png', contentType: 'image/png' })
      .expect(400);
    expect(service.upload).not.toHaveBeenCalled();
  });
});

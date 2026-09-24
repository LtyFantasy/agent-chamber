/**
 * AttachmentService 单测：上传校验链全分支 + 读取/分页/删除
 *
 * 校验链顺序（plan §3.1 钉死，测试按链序组织）：
 * 0 文件存在/字节复检(413·12001) → 1 绑定恰好一值(12005) → 2 资源存在+写权限
 * (topic 404·2000 / doc 404·10001 / 无权 403·12004) → 3 魔数(400·12002) →
 * 4 尺寸(400·9000) → 5 配额事务(403·12003) + putObject 锁外 + 失败删对象。
 *
 * 删除顺序不变量（plan §3.1）：先软删行 → 后删对象（失败仅记日志）→ 写 audit；
 * 存在但无权限（非上传者非 admin）一律 404——本文件用 invocationCallOrder 钉死顺序。
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ActorType, AuditAction, ErrorCode, UserRole } from '@agent-chamber/shared';
import { AttachmentService, UploadedMemoryFile } from './attachment.service';
import { Attachment } from '../../database/entities/attachment.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { DataSource } from 'typeorm';
import { AttachmentStorageService } from './storage.service';
import { AttachmentAccessService } from './attachment-access.service';
import { TopicService } from '../topic/topic.service';
import { DocService } from '../docspace/doc.service';
import { DocSpaceService } from '../docspace/docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_QUOTA_BYTES } from './attachment.constants';
import { makePngBuffer, makeRealPngBuffer } from './test-image-fixtures';

const FIXED_DATE = new Date('2026-09-09T01:02:03.000Z');
const ACTOR = { id: 'uploader-1', type: ActorType.HUMAN, role: UserRole.EDITOR } as const;
const OPEN_TOPIC = { id: 'topic-1', creatorId: 'someone', settings: {}, status: 'active' };
const PRIVATE_TOPIC = {
  id: 'topic-1',
  creatorId: 'someone',
  settings: { visibility: 'private' },
  status: 'active',
};

/** 合法上传载荷（2x2 PNG，魔数+IHDR 真实） */
function makeFile(overrides: Partial<UploadedMemoryFile> = {}): UploadedMemoryFile {
  const buffer = makePngBuffer(2, 2);
  return {
    fieldname: 'file',
    originalname: 'photo.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

/**
 * 真实可解码上传载荷（P2 批 1）：走**成功生成缩略图**路径的用例专用。
 * 伪图（makeFile）在 sharp 里解不了码，只能覆盖 fail-open 分支。
 */
async function makeRealFile(
  overrides: Partial<UploadedMemoryFile> = {},
): Promise<UploadedMemoryFile> {
  const buffer = await makeRealPngBuffer(1024, 768);
  return {
    fieldname: 'file',
    originalname: 'photo.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

/** 事务 queryRunner mock：query 按 SQL 分流（advisory lock → []；SUM → 指定 total） */
function makeQueryRunner(sumTotal: string) {
  return {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) => (sql.includes('SUM') ? [{ total: sumTotal }] : [])),
    manager: {
      create: jest.fn((_cls: unknown, obj: object) => ({ ...obj })),
      save: jest.fn(async (obj: object) => ({ ...obj, id: 'att-1', createdAt: FIXED_DATE })),
    },
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
  };
}

describe('AttachmentService', () => {
  let service: AttachmentService;
  let attachmentRepo: { findOne: jest.Mock; findAndCount: jest.Mock };
  let participantRepo: { findOne: jest.Mock };
  let dataSource: { createQueryRunner: jest.Mock; transaction: jest.Mock };
  let storage: {
    putObject: jest.Mock;
    getObject: jest.Mock;
    removeObject: jest.Mock;
    getBucket: jest.Mock;
  };
  let access: { assertCanRead: jest.Mock };
  let topicService: { findById: jest.Mock; hasTopicAccess: jest.Mock };
  let docService: { findById: jest.Mock };
  let docSpaceService: { findById: jest.Mock };
  let permService: { can: jest.Mock };
  let ownerProxy: { isOwnerProxy: jest.Mock };
  let auditService: { log: jest.Mock };
  let queryRunner: ReturnType<typeof makeQueryRunner>;

  beforeEach(async () => {
    attachmentRepo = { findOne: jest.fn(), findAndCount: jest.fn() };
    participantRepo = { findOne: jest.fn() };
    queryRunner = makeQueryRunner('0');
    dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
      transaction: jest.fn(async (cb: (em: unknown) => Promise<unknown>) =>
        cb({ softDelete: jest.fn(async () => undefined) }),
      ),
    };
    storage = {
      putObject: jest.fn(async () => undefined),
      getObject: jest.fn(),
      removeObject: jest.fn(async () => undefined),
      getBucket: jest.fn(() => 'agent-chamber-attachments'),
    };
    access = { assertCanRead: jest.fn(async () => undefined) };
    topicService = { findById: jest.fn(async () => OPEN_TOPIC), hasTopicAccess: jest.fn() };
    docService = { findById: jest.fn() };
    docSpaceService = { findById: jest.fn() };
    permService = { can: jest.fn(async () => true) };
    ownerProxy = { isOwnerProxy: jest.fn(async () => false) };
    auditService = { log: jest.fn(async () => undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentService,
        { provide: getRepositoryToken(Attachment), useValue: attachmentRepo },
        { provide: getRepositoryToken(TopicParticipant), useValue: participantRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: AttachmentStorageService, useValue: storage },
        { provide: AttachmentAccessService, useValue: access },
        { provide: TopicService, useValue: topicService },
        { provide: DocService, useValue: docService },
        { provide: DocSpaceService, useValue: docSpaceService },
        { provide: PermissionService, useValue: permService },
        { provide: OwnerProxyService, useValue: ownerProxy },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get(AttachmentService);
  });

  /** HTTP 异常类 + 业务码双断言（错误码不许说谎） */
  async function expectError(
    p: Promise<unknown>,
    cls: new (...args: never[]) => Error,
    code: ErrorCode,
  ): Promise<void> {
    await expect(p).rejects.toBeInstanceOf(cls);
    await expect(p).rejects.toMatchObject({ response: { code } });
  }

  describe('upload 校验链：0 文件存在与字节复检', () => {
    it('file 缺失 → 400 VALIDATION_ERROR', async () => {
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, undefined),
        BadRequestException,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('空 buffer → 400 VALIDATION_ERROR', async () => {
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, makeFile({ buffer: Buffer.alloc(0) })),
        BadRequestException,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('超 ATTACHMENT_MAX_BYTES → 413 ATTACHMENT_TOO_LARGE（防御性复检）', async () => {
      const big = makeFile({ buffer: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1) });
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, big),
        PayloadTooLargeException,
        ErrorCode.ATTACHMENT_TOO_LARGE,
      );
    });
  });

  describe('upload 校验链：1 绑定恰好一值（12005）', () => {
    it('topicId/docId 双传 → 400 ATTACHMENT_BIND_CONFLICT', async () => {
      await expectError(
        service.upload(ACTOR, { topicId: 't', docId: 'd' }, makeFile()),
        BadRequestException,
        ErrorCode.ATTACHMENT_BIND_CONFLICT,
      );
    });

    it('双缺 → 400 ATTACHMENT_BIND_CONFLICT', async () => {
      await expectError(
        service.upload(ACTOR, {}, makeFile()),
        BadRequestException,
        ErrorCode.ATTACHMENT_BIND_CONFLICT,
      );
    });
  });

  describe('upload 校验链：2 绑定资源存在 + 写权限', () => {
    it('topic 不存在 → findById 的 404 透传', async () => {
      topicService.findById.mockRejectedValue(
        new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND }),
      );
      await expect(service.upload(ACTOR, { topicId: 't' }, makeFile())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('OPEN topic：非 participant 直接放行（sendMessage 语义镜像），不查参与者表', async () => {
      await service.upload(ACTOR, { topicId: 'topic-1' }, makeFile());
      expect(participantRepo.findOne).not.toHaveBeenCalled();
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('PRIVATE topic + active participant → 放行', async () => {
      topicService.findById.mockResolvedValue(PRIVATE_TOPIC);
      participantRepo.findOne.mockResolvedValue({ status: 'active' });
      await expect(
        service.upload(ACTOR, { topicId: 'topic-1' }, makeFile()),
      ).resolves.toMatchObject({ id: 'att-1' });
    });

    it('PRIVATE topic + 非 participant + admin → 放行且不查 owner 代理（性能短路）', async () => {
      topicService.findById.mockResolvedValue(PRIVATE_TOPIC);
      participantRepo.findOne.mockResolvedValue(null);
      const admin = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN } as const;
      await expect(
        service.upload(admin, { topicId: 'topic-1' }, makeFile()),
      ).resolves.toMatchObject({ id: 'att-1' });
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('PRIVATE topic + 非 participant + owner 代理命中 → 放行', async () => {
      topicService.findById.mockResolvedValue(PRIVATE_TOPIC);
      participantRepo.findOne.mockResolvedValue(null);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      await expect(
        service.upload(ACTOR, { topicId: 'topic-1' }, makeFile()),
      ).resolves.toMatchObject({ id: 'att-1' });
      expect(ownerProxy.isOwnerProxy).toHaveBeenCalledWith(PRIVATE_TOPIC.creatorId, ACTOR);
    });

    it('PRIVATE topic + 非 participant 非 admin 非代理 → 403 ATTACHMENT_FORBIDDEN', async () => {
      topicService.findById.mockResolvedValue(PRIVATE_TOPIC);
      participantRepo.findOne.mockResolvedValue(null);
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, makeFile()),
        ForbiddenException,
        ErrorCode.ATTACHMENT_FORBIDDEN,
      );
    });

    it('PRIVATE topic + agent 身份：owner 代理判定不触发（仅 human 有效）→ 403', async () => {
      topicService.findById.mockResolvedValue(PRIVATE_TOPIC);
      participantRepo.findOne.mockResolvedValue(null);
      const agent = { id: 'agent-1', type: ActorType.AGENT } as const;
      await expectError(
        service.upload(agent, { topicId: 'topic-1' }, makeFile()),
        ForbiddenException,
        ErrorCode.ATTACHMENT_FORBIDDEN,
      );
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('doc 不存在 → findById 的 404 透传', async () => {
      docService.findById.mockRejectedValue(
        new NotFoundException({ message: 'Document not found', code: ErrorCode.DOC_NOT_FOUND }),
      );
      await expect(service.upload(ACTOR, { docId: 'd' }, makeFile())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('doc 无 space write 权限 → 403 ATTACHMENT_FORBIDDEN', async () => {
      docService.findById.mockResolvedValue({ id: 'doc-1', spaceId: 'space-1' });
      docSpaceService.findById.mockResolvedValue({ id: 'space-1' });
      permService.can.mockResolvedValue(false);
      await expectError(
        service.upload(ACTOR, { docId: 'doc-1' }, makeFile()),
        ForbiddenException,
        ErrorCode.ATTACHMENT_FORBIDDEN,
      );
      expect(permService.can).toHaveBeenCalledWith({ id: 'space-1' }, ACTOR, 'write');
    });

    it('doc 有 space write 权限 → 放行', async () => {
      docService.findById.mockResolvedValue({ id: 'doc-1', spaceId: 'space-1' });
      docSpaceService.findById.mockResolvedValue({ id: 'space-1' });
      await expect(service.upload(ACTOR, { docId: 'doc-1' }, makeFile())).resolves.toMatchObject({
        id: 'att-1',
        docId: 'doc-1',
        topicId: null,
      });
    });
  });

  describe('upload 校验链：3 魔数 + 4 尺寸', () => {
    it('魔数不命中白名单 → 400 ATTACHMENT_TYPE_NOT_ALLOWED', async () => {
      const file = makeFile({ buffer: Buffer.from('<?xml version="1.0"?><svg/>') });
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, file),
        BadRequestException,
        ErrorCode.ATTACHMENT_TYPE_NOT_ALLOWED,
      );
    });

    it('魔数命中但头部尺寸不可解析 → 400 VALIDATION_ERROR', async () => {
      // PNG 签名 + 截断头（不足 24B）
      const file = makeFile({ buffer: makePngBuffer(2, 2).subarray(0, 16) });
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, file),
        BadRequestException,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('单边超 16384px → 400 VALIDATION_ERROR', async () => {
      const file = makeFile({ buffer: makePngBuffer(16385, 10) });
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, file),
        BadRequestException,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('总像素超 40MP → 400 VALIDATION_ERROR', async () => {
      const file = makeFile({ buffer: makePngBuffer(8000, 5001) });
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, file),
        BadRequestException,
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  describe('upload 校验链：5 配额事务与对象生命周期', () => {
    it('配额超限 → 403 ATTACHMENT_QUOTA_EXCEEDED + 删已传对象 + 回滚', async () => {
      queryRunner.query.mockImplementation(async (sql: string) =>
        sql.includes('SUM') ? [{ total: String(ATTACHMENT_QUOTA_BYTES) }] : [],
      );
      await expectError(
        service.upload(ACTOR, { topicId: 'topic-1' }, makeFile()),
        ForbiddenException,
        ErrorCode.ATTACHMENT_QUOTA_EXCEEDED,
      );
      expect(storage.removeObject).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });

    it('插行失败 → 删已传对象 + 回滚 + 原异常抛出', async () => {
      queryRunner.manager.save.mockRejectedValue(new Error('db write failed'));
      await expect(service.upload(ACTOR, { topicId: 'topic-1' }, makeFile())).rejects.toThrow(
        'db write failed',
      );
      expect(storage.removeObject).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('成功路径：putObject 在事务外先行，advisory lock 先于 SUM，锁持有到提交', async () => {
      await service.upload(ACTOR, { topicId: 'topic-1' }, makeFile());
      // putObject 先于 startTransaction（锁外）
      expect(storage.putObject.mock.invocationCallOrder[0]).toBeLessThan(
        queryRunner.startTransaction.mock.invocationCallOrder[0],
      );
      // query 第一次 = advisory lock，第二次 = SUM
      expect(queryRunner.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
      expect(queryRunner.query.mock.calls[0][0]).toContain('hashtextextended');
      expect(queryRunner.query.mock.calls[1][0]).toContain('SUM(size_bytes)');
      // commit 发生且无回滚；连接释放
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
      // 成功路径不删对象
      expect(storage.removeObject).not.toHaveBeenCalled();
    });

    it('busboy latin1 mojibake 文件名在上传链路端到端还原为 UTF-8', async () => {
      const file = makeFile({
        originalname: Buffer.from('截图.png', 'utf8').toString('latin1'),
      });
      const res = await service.upload(ACTOR, { topicId: 'topic-1' }, file);
      expect(res.originalName).toBe('截图.png');
      const created = queryRunner.manager.create.mock.calls[0][1] as Record<string, unknown>;
      expect(created.originalName).toBe('截图.png');
    });

    it('成功路径：写入行字段与响应形状契约（含 sanitize/sha256/sizeBytes Number）', async () => {
      const file = makeFile({ originalname: 'my\r\nphoto.png' });
      const res = await service.upload(ACTOR, { topicId: 'topic-1' }, file);

      // putObject：uuid.png 键 + 原 buffer + 嗅探 mime（bucket 由 storage 内部
      // 从配置拼装，透传断言归 storage.service.spec）
      const [key, buf, mime] = storage.putObject.mock.calls[0];
      expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
      expect(buf).toBe(file.buffer);
      expect(mime).toBe('image/png');

      // 插行字段
      const created = queryRunner.manager.create.mock.calls[0][1] as Record<string, unknown>;
      expect(created).toMatchObject({
        uploaderId: ACTOR.id,
        bucket: 'agent-chamber-attachments',
        objectKey: key,
        originalName: 'myphoto.png', // CRLF 已剥离
        mimeType: 'image/png',
        sizeBytes: String(file.buffer.length),
        status: 'ready',
        topicId: 'topic-1',
        docId: null,
      });
      expect(created.sha256).toBe(createHash('sha256').update(file.buffer).digest('hex'));

      // 响应形状（plan §3.1 钉死九字段）
      expect(res).toEqual({
        id: 'att-1',
        contentUrl: '/api/v1/attachments/att-1/content',
        originalName: 'myphoto.png',
        mimeType: 'image/png',
        sizeBytes: file.buffer.length, // number，非 string
        sha256: created.sha256,
        topicId: 'topic-1',
        docId: null,
        createdAt: FIXED_DATE,
      });
    });
  });

  describe('缩略图变体（P2 批 1）：生成 / fail-open / 双删', () => {
    it('成功生成：thumb 5 列写完（≤512 webp、sha256/size 自洽）+ 独立 uuid 对象键', async () => {
      const file = await makeRealFile();
      const res = await service.upload(ACTOR, { topicId: 'topic-1' }, file);

      // putObject 两次：原图（嗅探 mime）→ 缩略图（image/webp，独立 uuid 键）
      expect(storage.putObject).toHaveBeenCalledTimes(2);
      const [origKey, origBuf, origMime] = storage.putObject.mock.calls[0];
      expect(origKey).toMatch(/^[0-9a-f-]{36}\.png$/);
      expect(origBuf).toBe(file.buffer);
      expect(origMime).toBe('image/png');
      const [thumbKey, thumbBuf, thumbMime] = storage.putObject.mock.calls[1];
      expect(thumbKey).toMatch(/^[0-9a-f-]{36}\.thumb\.webp$/);
      expect(thumbKey).not.toBe(origKey); // 独立键，不共享原图键
      expect(thumbMime).toBe('image/webp');

      // 插行 5 列（thumb 组同生共死）
      const created = queryRunner.manager.create.mock.calls[0][1] as Record<string, unknown>;
      expect(created.thumbKey).toBe(thumbKey);
      expect(created.thumbWidth).toBe(512);
      expect(created.thumbHeight).toBe(384);
      expect(created.thumbSizeBytes).toBe(String((thumbBuf as Buffer).length));
      expect(created.thumbSha256).toBe(
        createHash('sha256')
          .update(thumbBuf as Buffer)
          .digest('hex'),
      );

      // 上传响应（四表面之一）带条件第 6 键
      expect(res.thumbnailContentUrl).toBe('/api/v1/attachments/att-1/thumbnail');
    });

    it('fail-open：解码失败（伪图）→ thumb 5 列全 null + 结构化 warn + 上传照常 + 不删原图', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const res = await service.upload(ACTOR, { topicId: 'topic-1' }, makeFile());

      // 只落了原图对象；原图保留（fail-open 不触发双删）
      expect(storage.putObject).toHaveBeenCalledTimes(1);
      expect(storage.removeObject).not.toHaveBeenCalled();

      const created = queryRunner.manager.create.mock.calls[0][1] as Record<string, unknown>;
      expect(created.thumbKey).toBeNull();
      expect(created.thumbWidth).toBeNull();
      expect(created.thumbHeight).toBeNull();
      expect(created.thumbSizeBytes).toBeNull();
      expect(created.thumbSha256).toBeNull();

      // 结构化 warn（attachmentId/uploaderId/sniffed mime/error 类 + 累计失败计数）
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Thumbnail generation failed');
      expect(logged).toContain('uploaderId=uploader-1');
      expect(logged).toContain('mime=image/png');
      expect(logged).toContain('failuresSinceStartup=1');

      // 响应缺席语义：无缩略图 = 字面缺键（绝不 null/''）
      expect(Object.hasOwn(res, 'thumbnailContentUrl')).toBe(false);
      warn.mockRestore();
    });

    it('插行失败双删：原图 + 缩略图（幂等删，两个键都清）', async () => {
      const file = await makeRealFile();
      queryRunner.manager.save.mockRejectedValue(new Error('db write failed'));

      await expect(service.upload(ACTOR, { topicId: 'topic-1' }, file)).rejects.toThrow(
        'db write failed',
      );

      const keys = storage.removeObject.mock.calls.map((c) => c[0] as string);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^[0-9a-f-]{36}\.png$/);
      expect(keys[1]).toMatch(/^[0-9a-f-]{36}\.thumb\.webp$/);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('插行失败且缩略图未生成（fail-open）：只删原图', async () => {
      queryRunner.manager.save.mockRejectedValue(new Error('db write failed'));
      await expect(service.upload(ACTOR, { topicId: 'topic-1' }, makeFile())).rejects.toThrow();
      expect(storage.removeObject).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMetadata / getContent（读取路径 404 一致性）', () => {
    const row = {
      id: 'att-1',
      uploaderId: 'uploader-1',
      bucket: 'b',
      objectKey: 'k.png',
      originalName: 'a.png',
      mimeType: 'image/png',
      sizeBytes: '33',
      sha256: 'ab'.repeat(32),
      status: 'ready',
      topicId: 'topic-1',
      docId: null,
      createdAt: FIXED_DATE,
    } as unknown as Attachment;

    it('行不存在 → 404 ATTACHMENT_NOT_FOUND', async () => {
      attachmentRepo.findOne.mockResolvedValue(null);
      await expectError(
        service.getMetadata('att-x', ACTOR),
        NotFoundException,
        ErrorCode.ATTACHMENT_NOT_FOUND,
      );
    });

    it('无权限 → access 的 404 透传（存在但无权限不泄露）', async () => {
      attachmentRepo.findOne.mockResolvedValue(row);
      access.assertCanRead.mockRejectedValue(
        new NotFoundException({
          message: 'Attachment not found',
          code: ErrorCode.ATTACHMENT_NOT_FOUND,
        }),
      );
      await expectError(
        service.getMetadata('att-1', ACTOR),
        NotFoundException,
        ErrorCode.ATTACHMENT_NOT_FOUND,
      );
    });

    it('成功：元数据 DTO（sizeBytes number 转换；无 bucket/objectKey 内部字段）', async () => {
      attachmentRepo.findOne.mockResolvedValue(row);
      const dto = await service.getMetadata('att-1', ACTOR);
      expect(dto).toEqual({
        id: 'att-1',
        originalName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 33,
        sha256: 'ab'.repeat(32),
        topicId: 'topic-1',
        docId: null,
        createdAt: FIXED_DATE,
      });
      expect(access.assertCanRead).toHaveBeenCalledWith(row, ACTOR);
    });

    it('getContent：授权通过后按 objectKey 取流', async () => {
      attachmentRepo.findOne.mockResolvedValue(row);
      const stream = { pipe: jest.fn() };
      storage.getObject.mockResolvedValue(stream);
      const res = await service.getContent('att-1', ACTOR);
      expect(storage.getObject).toHaveBeenCalledWith('k.png');
      expect(res).toEqual({ attachment: row, stream });
    });
  });

  describe('getThumbnail（P2 批 1 缩略图读取）', () => {
    /** 有缩略图的行（thumb 5 列齐全——同生共死不变量） */
    const thumbRow = {
      id: 'att-1',
      uploaderId: 'uploader-1',
      objectKey: 'k.png',
      thumbKey: 'k.thumb.webp',
      thumbWidth: 512,
      thumbHeight: 384,
      thumbSizeBytes: '4096',
      thumbSha256: 'cd'.repeat(32),
      originalName: 'a.png',
      mimeType: 'image/png',
    } as unknown as Attachment;

    it('无缩略图（thumb_key NULL）→ 404 + 12008，消息指导改用 /content', async () => {
      attachmentRepo.findOne.mockResolvedValue({ ...thumbRow, thumbKey: null } as Attachment);
      await expectError(
        service.getThumbnail('att-1', ACTOR),
        NotFoundException,
        ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE,
      );
      await expect(service.getThumbnail('att-1', ACTOR)).rejects.toMatchObject({
        response: {
          message:
            'No thumbnail available for this attachment; use /attachments/:id/content for the original',
        },
      });
      expect(storage.getObject).not.toHaveBeenCalled();
    });

    it('有缩略图 → 按 thumbKey 取流（不是原图 objectKey）', async () => {
      attachmentRepo.findOne.mockResolvedValue(thumbRow);
      const stream = { pipe: jest.fn() };
      storage.getObject.mockResolvedValue(stream);
      const res = await service.getThumbnail('att-1', ACTOR);
      expect(storage.getObject).toHaveBeenCalledWith('k.thumb.webp');
      expect(res).toEqual({ attachment: thumbRow, stream });
    });

    it('无权限 → access 的 404·12000 透传（先于无缩略图判定，不因变体分码泄露存在性）', async () => {
      attachmentRepo.findOne.mockResolvedValue({ ...thumbRow, thumbKey: null } as Attachment);
      access.assertCanRead.mockRejectedValue(
        new NotFoundException({
          message: 'Attachment not found',
          code: ErrorCode.ATTACHMENT_NOT_FOUND,
        }),
      );
      await expectError(
        service.getThumbnail('att-1', ACTOR),
        NotFoundException,
        ErrorCode.ATTACHMENT_NOT_FOUND,
      );
    });
  });

  describe('四表面口径（P2 批 1）：thumbnailContentUrl 有则出现、无则字面缺键', () => {
    const withoutThumb = {
      id: 'att-1',
      uploaderId: 'uploader-1',
      objectKey: 'k.png',
      thumbKey: null,
      originalName: 'a.png',
      mimeType: 'image/png',
      sizeBytes: '33',
      sha256: 'ab'.repeat(32),
      topicId: 'topic-1',
      docId: null,
      createdAt: FIXED_DATE,
    } as unknown as Attachment;
    const withThumb = { ...withoutThumb, thumbKey: 'k.thumb.webp' } as unknown as Attachment;

    it('无缩略图：upload / GET :id / mine 三面均无该键（Object.hasOwn === false，绝不为 null）', async () => {
      // upload：伪图 → fail-open（无缩略图）
      const uploaded = await service.upload(ACTOR, { topicId: 'topic-1' }, makeFile());
      expect(Object.hasOwn(uploaded, 'thumbnailContentUrl')).toBe(false);

      // GET :id
      attachmentRepo.findOne.mockResolvedValue(withoutThumb);
      const meta = await service.getMetadata('att-1', ACTOR);
      expect(Object.hasOwn(meta, 'thumbnailContentUrl')).toBe(false);

      // mine
      attachmentRepo.findAndCount.mockResolvedValue([[withoutThumb], 1]);
      const mine = await service.findMine(ACTOR, {});
      expect(Object.hasOwn(mine.items[0], 'thumbnailContentUrl')).toBe(false);
    });

    it('有缩略图：三面 URL 形状一致（/api/v1/attachments/<id>/thumbnail）', async () => {
      const file = await makeRealFile();
      const uploaded = await service.upload(ACTOR, { topicId: 'topic-1' }, file);
      expect(uploaded.thumbnailContentUrl).toBe('/api/v1/attachments/att-1/thumbnail');

      attachmentRepo.findOne.mockResolvedValue(withThumb);
      const meta = await service.getMetadata('att-1', ACTOR);
      expect(meta.thumbnailContentUrl).toBe('/api/v1/attachments/att-1/thumbnail');

      attachmentRepo.findAndCount.mockResolvedValue([[withThumb], 1]);
      const mine = await service.findMine(ACTOR, {});
      expect(mine.items[0].thumbnailContentUrl).toBe('/api/v1/attachments/att-1/thumbnail');
    });
  });

  describe('findMine', () => {
    it('分页参数与排序（created_at DESC）+ DTO 转换 + totalPages', async () => {
      const rows = [
        {
          id: 'a1',
          sizeBytes: '10',
          originalName: 'x.png',
          mimeType: 'image/png',
          sha256: 's',
          topicId: null,
          docId: 'd',
          createdAt: FIXED_DATE,
        },
      ] as unknown as Attachment[];
      attachmentRepo.findAndCount.mockResolvedValue([rows, 25]);
      const res = await service.findMine(ACTOR, { page: 2, pageSize: 10 });
      expect(attachmentRepo.findAndCount).toHaveBeenCalledWith({
        where: { uploaderId: ACTOR.id },
        order: { createdAt: 'DESC' },
        skip: 10,
        take: 10,
      });
      expect(res.total).toBe(25);
      expect(res.totalPages).toBe(3);
      expect(res.items[0].sizeBytes).toBe(10);
    });
  });

  describe('remove（删除路径）', () => {
    const row = {
      id: 'att-1',
      uploaderId: 'uploader-1',
      objectKey: 'k.png',
      originalName: 'a.png',
      mimeType: 'image/png',
      sizeBytes: '33',
      sha256: 'ab'.repeat(32),
    } as unknown as Attachment;

    it('行不存在 → 404 ATTACHMENT_NOT_FOUND', async () => {
      attachmentRepo.findOne.mockResolvedValue(null);
      await expectError(
        service.remove('att-x', ACTOR),
        NotFoundException,
        ErrorCode.ATTACHMENT_NOT_FOUND,
      );
    });

    it('非上传者非 admin → 404（存在但无权限不泄露）', async () => {
      attachmentRepo.findOne.mockResolvedValue(row);
      await expectError(
        service.remove('att-1', { ...ACTOR, id: 'someone-else' }),
        NotFoundException,
        ErrorCode.ATTACHMENT_NOT_FOUND,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('上传者删除：先软删行（事务）→ 后删对象 → 写 audit（顺序钉死）', async () => {
      attachmentRepo.findOne.mockResolvedValue(row);
      const em = { softDelete: jest.fn(async () => undefined) };
      dataSource.transaction.mockImplementation(async (cb: (e: unknown) => Promise<unknown>) =>
        cb(em),
      );
      await service.remove('att-1', ACTOR);

      expect(em.softDelete).toHaveBeenCalledWith(Attachment, 'att-1');
      // 顺序：softDelete 先于 removeObject（严禁反序产生永久脏行）
      expect(em.softDelete.mock.invocationCallOrder[0]).toBeLessThan(
        storage.removeObject.mock.invocationCallOrder[0],
      );
      expect(storage.removeObject).toHaveBeenCalledWith('k.png');
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.DELETE,
        entityType: AUDIT_ENTITY_TYPE.ATTACHMENT,
        entityId: 'att-1',
        actorId: ACTOR.id,
        newData: {
          originalName: 'a.png',
          mimeType: 'image/png',
          sizeBytes: 33,
          sha256: 'ab'.repeat(32),
        },
        source: 'api',
      });
    });

    it('admin 删他人附件 → 放行', async () => {
      attachmentRepo.findOne.mockResolvedValue(row);
      const admin = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN } as const;
      await expect(service.remove('att-1', admin)).resolves.toBeUndefined();
      expect(storage.removeObject).toHaveBeenCalledWith('k.png');
    });

    it('删对象失败：仅记日志不抛出，audit 仍写（GC 重试语义）', async () => {
      attachmentRepo.findOne.mockResolvedValue(row);
      storage.removeObject.mockRejectedValue(new Error('minio down'));
      await expect(service.remove('att-1', ACTOR)).resolves.toBeUndefined();
      expect(auditService.log).toHaveBeenCalled();
    });

    it('有缩略图的行：软删后原图 + 缩略图双删（thumb 键在软删之后）', async () => {
      const withThumb = { ...row, thumbKey: 'k.thumb.webp' } as unknown as Attachment;
      attachmentRepo.findOne.mockResolvedValue(withThumb);
      const em = { softDelete: jest.fn(async () => undefined) };
      dataSource.transaction.mockImplementation(async (cb: (e: unknown) => Promise<unknown>) =>
        cb(em),
      );

      await service.remove('att-1', ACTOR);

      expect(storage.removeObject).toHaveBeenCalledTimes(2);
      expect(storage.removeObject).toHaveBeenNthCalledWith(1, 'k.png');
      expect(storage.removeObject).toHaveBeenNthCalledWith(2, 'k.thumb.webp');
      expect(em.softDelete.mock.invocationCallOrder[0]).toBeLessThan(
        storage.removeObject.mock.invocationCallOrder[0],
      );
    });

    it('缩略图删失败不牵连原图：两键各自容错（行已软删，GC 兜底）', async () => {
      const withThumb = { ...row, thumbKey: 'k.thumb.webp' } as unknown as Attachment;
      attachmentRepo.findOne.mockResolvedValue(withThumb);
      storage.removeObject.mockImplementation(async (key: string) => {
        if (key === 'k.thumb.webp') throw new Error('minio down');
      });

      await expect(service.remove('att-1', ACTOR)).resolves.toBeUndefined();
      expect(storage.removeObject).toHaveBeenCalledTimes(2); // 原图删照常执行（互不阻塞）
      expect(auditService.log).toHaveBeenCalled();
    });
  });
});

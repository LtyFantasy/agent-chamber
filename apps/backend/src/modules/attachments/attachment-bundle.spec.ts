/**
 * AttachmentService bundle 媒体门面单元测试（P2 批 5 / plan §⑤.4、security B2）
 *
 * 覆盖（§⑤.6 单测清单的 attachments 侧）：
 * - 字节证据校验：伪造 mime + 脚本字节 → failed 不落行（**存储型 XSS 用例**）、
 *   声明 mime 与嗅探不符 → failed、sha256 不符 → failed、sizeBytes 不符 → failed、
 *   非标准 base64 → failed、缩略图非 webp → failed；
 * - union 语义：skipped 标记跳过、必填缺失 → failed、docPath 不在 docs[] → failed；
 * - insert-or-reuse：命中复用键（不落对象、不插行、属性以库内为准）、
 *   本轮未配对（同 sha 两项不得共享一行）、tie-break 的确定性序（ORDER BY createdAt,id）；
 * - 配额：SUM 越界 → failed + 对象清理；成功路径落对象/插行/缩略图 5 列；
 * - 回绑：同 doc no-op、他 doc 拒绝、行缺失 failed；
 * - 只读门面：空数组短路、readObjectBytes 流拼接。
 *
 * 真实 ORM SQL（where 数组 OR / ORDER BY tie-break / advisory 锁并发）与真实对象存储的
 * 覆盖在 docspace-bundle.e2e-spec.ts（铁律 #23：mock 测不出 SQL 生成）。
 */
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ActorType } from '@agent-chamber/shared';
import { AttachmentAccessService } from './attachment-access.service';
import { AttachmentService } from './attachment.service';
import { AttachmentStorageService } from './storage.service';
import { Attachment } from '../../database/entities/attachment.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { TopicService } from '../topic/topic.service';
import { DocService } from '../docspace/doc.service';
import { DocSpaceService } from '../docspace/docspace.service';
import { AuditService } from '../audit/audit.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { ATTACHMENT_QUOTA_BYTES } from './attachment.constants';
import { makePngBuffer, makeWebpVp8Buffer } from './test-image-fixtures';
import type { BundleMediaImportInput, BundleMediaImportItem } from './attachment-bundle.types';

const IMPORTER = 'actor-importer';
const ACTOR = { id: IMPORTER, type: ActorType.AGENT };

/** 真实 PNG 魔数（够嗅探，无需可解码——解码路径不在这条链上） */
const PNG_BYTES = makePngBuffer(10, 10);
/** 真实 WebP 魔数（缩略图必须 webp） */
const WEBP_BYTES = makeWebpVp8Buffer(64, 32);

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function makeRow(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-existing',
    uploaderId: IMPORTER,
    bucket: 'agent-chamber-attachments',
    objectKey: 'existing.png',
    originalName: '库内名.png',
    mimeType: 'image/png',
    sizeBytes: String(PNG_BYTES.length),
    sha256: sha(PNG_BYTES),
    status: 'ready',
    topicId: null,
    docId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    thumbKey: null,
    thumbWidth: null,
    thumbHeight: null,
    thumbSizeBytes: null,
    thumbSha256: null,
    ...overrides,
  } as Attachment;
}

/** 构造合法媒体项（默认 = PNG_BYTES 自洽） */
function makeItem(overrides: Partial<BundleMediaImportItem> = {}): BundleMediaImportItem {
  return {
    sourceAttachmentId: '11111111-1111-4111-8111-111111111111',
    docPath: 'docs/a.md',
    originalName: 'img.png',
    mimeType: 'image/png',
    sizeBytes: PNG_BYTES.length,
    sha256: sha(PNG_BYTES),
    contentBase64: PNG_BYTES.toString('base64'),
    thumbnail: null,
    skipped: null,
    ...overrides,
  };
}

function makeInput(
  items: BundleMediaImportItem[],
  overrides: Partial<BundleMediaImportInput> = {},
): BundleMediaImportInput {
  return {
    items,
    importerId: IMPORTER,
    docPathSet: new Set(['docs/a.md']),
    docIdByPath: new Map(),
    limits: { itemMaxBytes: 6 * 1024 * 1024, budgetBytes: 9 * 1024 * 1024 },
    ...overrides,
  };
}

describe('AttachmentService bundle 媒体门面', () => {
  let service: AttachmentService;
  let attachmentRepo: { find: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let storage: {
    getBucket: jest.Mock;
    putObject: jest.Mock;
    removeObject: jest.Mock;
    getObject: jest.Mock;
  };
  let dataSource: { createQueryRunner: jest.Mock };

  /** 复用候选（`em.find` 的返回值）与配额用量，用例内可改 */
  let reuseCandidates: Attachment[];
  let quotaUsed: number;
  /** 每次 withQuotaLock 的 manager 记录（断言 ORDER BY / where 形状用） */
  const managers: Array<Record<string, jest.Mock>> = [];

  function makeQueryRunner() {
    const manager = {
      find: jest.fn(async (_entity: unknown, _opts: unknown) => reuseCandidates),
      query: jest.fn(async () => [{ total: String(quotaUsed) }]),
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({
        id: `att-new-${managers.length + 1}`,
        ...data,
      })),
      save: jest.fn(async (row: unknown) => row),
    } as unknown as EntityManager & Record<string, jest.Mock>;
    managers.push(manager as unknown as Record<string, jest.Mock>);
    return {
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      query: jest.fn(async () => undefined),
      manager,
    };
  }

  beforeEach(() => {
    reuseCandidates = [];
    quotaUsed = 0;
    managers.length = 0;
    attachmentRepo = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    storage = {
      getBucket: jest.fn(() => 'agent-chamber-attachments'),
      putObject: jest.fn(async () => undefined),
      removeObject: jest.fn(async () => undefined),
      getObject: jest.fn(),
    };
    dataSource = { createQueryRunner: jest.fn(() => makeQueryRunner()) };

    service = new AttachmentService(
      attachmentRepo as unknown as never,
      {} as TopicParticipant as never,
      dataSource as unknown as DataSource,
      storage as unknown as AttachmentStorageService,
      {} as AttachmentAccessService,
      {} as TopicService,
      {} as DocService,
      {} as DocSpaceService,
      {} as PermissionService,
      {} as OwnerProxyService,
      {} as AuditService,
    );
  });

  // ─── 只读门面 ──────────────────────────────────────────────

  describe('只读门面', () => {
    it('空数组短路（TypeORM In([]) 是 SQL 语法错误，绝不能下传）', async () => {
      expect(await service.listByDocIds([])).toEqual([]);
      expect(await service.listByIds([])).toEqual([]);
      expect(attachmentRepo.find).not.toHaveBeenCalled();
    });

    it('readObjectBytes：流分片拼接为完整 Buffer', async () => {
      storage.getObject.mockResolvedValue(
        (async function* () {
          yield Buffer.from('ab');
          yield new Uint8Array([0x63]);
        })(),
      );
      const buf = await service.readObjectBytes('key-1');
      expect(buf.toString()).toBe('abc');
    });
  });

  // ─── 字节证据（安全 B2）─────────────────────────────────

  describe('importFromBundle 字节证据校验', () => {
    it('伪造 mime + 脚本字节 → failed 不落行（存储型 XSS 用例）', async () => {
      const scriptBytes = Buffer.from('<script>alert(1)</script>');
      const result = await service.importFromBundle(
        makeInput([
          makeItem({
            mimeType: 'image/png',
            sizeBytes: scriptBytes.length,
            sha256: sha(scriptBytes),
            contentBase64: scriptBytes.toString('base64'),
          }),
        ]),
      );

      expect(result).toMatchObject({ created: 0, reused: 0, skipped: 0 });
      expect(result.failed).toEqual([
        {
          docPath: 'docs/a.md',
          originalName: 'img.png',
          reason: expect.stringContaining('not an allowed image'),
        },
      ]);
      expect(result.bindings).toEqual([]);
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled(); // 连事务都没起
    });

    it('字节证据与声明 mime 不符（PNG 字节声明 jpeg）→ failed', async () => {
      const result = await service.importFromBundle(
        makeInput([makeItem({ mimeType: 'image/jpeg' })]),
      );

      expect(result.failed[0].reason).toContain("declared mimeType 'image/jpeg'");
      expect(result.failed[0].reason).toContain("'image/png'");
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('sha256 不符 / sizeBytes 不符 / 非标准 base64 → 各自 failed', async () => {
      const shaBad = await service.importFromBundle(
        makeInput([makeItem({ sha256: 'b'.repeat(64) })]),
      );
      expect(shaBad.failed[0].reason).toContain('sha256 does not match');

      const sizeBad = await service.importFromBundle(makeInput([makeItem({ sizeBytes: 999 })]));
      expect(sizeBad.failed[0].reason).toContain('sizeBytes mismatch');

      const base64Bad = await service.importFromBundle(
        makeInput([makeItem({ contentBase64: 'not base64!!' })]),
      );
      expect(base64Bad.failed[0].reason).toContain('not standard padded base64');
    });

    it('缩略图非 webp → failed（导入侧不信声明，thumb 字节同样要证据）', async () => {
      const result = await service.importFromBundle(
        makeInput([
          makeItem({
            thumbnail: {
              width: 64,
              height: 32,
              sizeBytes: PNG_BYTES.length,
              sha256: sha(PNG_BYTES),
              contentBase64: PNG_BYTES.toString('base64'),
            },
          }),
        ]),
      );

      expect(result.failed[0].reason).toContain('thumbnail byte evidence mismatch');
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('skipped 标记 → 计入 skipped，不读字节不落行', async () => {
      const result = await service.importFromBundle(
        makeInput([{ ...makeItem(), skipped: 'too_large', contentBase64: null }]),
      );

      expect(result).toEqual({
        created: 0,
        reused: 0,
        skipped: 1,
        failed: [],
        bindings: [],
      });
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('docPath 不在 docs[] / 缺必填 / 预算超限 → failed，无任何写', async () => {
      const ghost = await service.importFromBundle(
        makeInput([makeItem({ docPath: 'docs/ghost.md' })]),
      );
      expect(ghost.failed[0].reason).toContain('does not appear in bundle docs[]');

      const missing = await service.importFromBundle(makeInput([makeItem({ sha256: null })]));
      expect(missing.failed[0].reason).toContain('missing required media fields');

      const overBudget = await service.importFromBundle(
        makeInput([makeItem()], {
          limits: { itemMaxBytes: 6 * 1024 * 1024, budgetBytes: 1 },
        }),
      );
      expect(overBudget.failed[0].reason).toContain('bundle media budget exceeded');

      expect(storage.putObject).not.toHaveBeenCalled();
    });
  });

  // ─── 落库 / 复用 / 配额 ─────────────────────────────────

  describe('importFromBundle 落库与幂等', () => {
    it('新建：落对象（原图 + 缩略图）+ 插行（文件名 sanitize、mime 取嗅探值、docId 留空）', async () => {
      const thumb = {
        width: 64,
        height: 32,
        sizeBytes: WEBP_BYTES.length,
        sha256: sha(WEBP_BYTES),
        contentBase64: WEBP_BYTES.toString('base64'),
      };
      const result = await service.importFromBundle(
        makeInput([makeItem({ originalName: '../../evil\r\n.png', thumbnail: thumb })]),
      );

      expect(result.created).toBe(1);
      expect(storage.putObject).toHaveBeenCalledTimes(2);
      expect(storage.putObject).toHaveBeenCalledWith(
        expect.stringMatching(/\.png$/),
        PNG_BYTES,
        'image/png',
      );
      expect(storage.putObject).toHaveBeenCalledWith(
        expect.stringMatching(/\.thumb\.webp$/),
        WEBP_BYTES,
        'image/webp',
      );

      const saved = managers.at(-1)!.save.mock.calls[0][0] as Record<string, unknown>;
      expect(saved).toMatchObject({
        uploaderId: IMPORTER,
        bucket: 'agent-chamber-attachments',
        originalName: '.._.._evil.png', // 控制字符剥离 + 路径分隔符替换（与上传同一套 sanitize）
        mimeType: 'image/png',
        sizeBytes: String(PNG_BYTES.length),
        sha256: sha(PNG_BYTES),
        status: 'ready',
        topicId: null,
        docId: null, // 阶段 ④ 才回绑
        thumbWidth: 64,
        thumbHeight: 32,
        thumbSizeBytes: String(WEBP_BYTES.length),
        thumbSha256: sha(WEBP_BYTES),
      });
      expect(result.bindings[0]).toMatchObject({
        sourceAttachmentId: '11111111-1111-4111-8111-111111111111',
        attachmentId: expect.stringMatching(/^att-new-/),
        docPath: 'docs/a.md',
      });
    });

    it('复用：命中复用键 → 不落对象不插行，属性以库内为准（同 sha 不同名不更新）', async () => {
      reuseCandidates = [makeRow({ docId: 'doc-target' })];

      const result = await service.importFromBundle(
        makeInput([makeItem({ originalName: '包内名.png' })], {
          docIdByPath: new Map([['docs/a.md', 'doc-target']]),
        }),
      );

      expect(result).toMatchObject({ created: 0, reused: 1 });
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(managers.every((m) => m.save.mock.calls.length === 0)).toBe(true);
      expect(result.bindings[0]).toMatchObject({
        attachmentId: 'att-existing',
        originalName: '库内名.png', // 库内为准
      });
    });

    it('复用键形状：ORDER BY createdAt,id + where 覆盖（docId IS NULL 或 = 现解析 id）', async () => {
      reuseCandidates = [];

      await service.importFromBundle(
        makeInput([makeItem()], { docIdByPath: new Map([['docs/a.md', 'doc-target']]) }),
      );

      const findCall = managers[0].find.mock.calls[0];
      expect(findCall[1]).toMatchObject({
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      const where = (findCall[1] as { where: unknown[] }).where;
      expect(where).toHaveLength(2);
      expect(JSON.stringify(where)).toContain('"status":"ready"');
      expect(JSON.stringify(where)).toContain('doc-target');
    });

    it('本轮未配对：同 bundle 重复字节的两项各自落一行（不共享）', async () => {
      reuseCandidates = [makeRow({ id: 'att-shared' })];

      const result = await service.importFromBundle(
        makeInput([
          makeItem({ sourceAttachmentId: 'aaaaaaaa-1111-4111-8111-111111111111' }),
          makeItem({ sourceAttachmentId: 'bbbbbbbb-2222-4222-8222-222222222222' }),
        ]),
      );

      // 第一项命中复用；第二项因第一项已配对 → 新建（不得再配同一行）
      expect(result).toMatchObject({ created: 1, reused: 1 });
      expect(result.bindings.map((b) => b.attachmentId)).toEqual([
        'att-shared',
        expect.stringMatching(/^att-new-/),
      ]);
      expect(storage.putObject).toHaveBeenCalledTimes(1);
    });

    it('配额越界 → failed + 删除刚落的对象（不留孤儿）', async () => {
      quotaUsed = ATTACHMENT_QUOTA_BYTES;

      const result = await service.importFromBundle(makeInput([makeItem()]));

      expect(result.created).toBe(0);
      expect(result.failed[0].reason).toContain('Storage quota exceeded');
      expect(storage.removeObject).toHaveBeenCalledTimes(1);
      expect(storage.removeObject).toHaveBeenCalledWith(expect.stringMatching(/\.png$/));
    });

    it('重复 sourceAttachmentId → 第二项 failed（防一个旧 id 映射到两行）', async () => {
      const result = await service.importFromBundle(makeInput([makeItem(), makeItem()]));

      expect(result.created).toBe(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].reason).toContain('duplicate sourceAttachmentId');
    });

    it('单条失败不中止批次（前后项照常落库）', async () => {
      const result = await service.importFromBundle(
        makeInput([
          makeItem({
            sourceAttachmentId: 'cccccccc-3333-4333-8333-333333333333',
            sha256: 'b'.repeat(64),
          }),
          makeItem({ sourceAttachmentId: 'dddddddd-4444-4444-8444-444444444444' }),
        ]),
      );

      expect(result.created).toBe(1);
      expect(result.failed).toHaveLength(1);
    });
  });

  // ─── 回绑 ──────────────────────────────────────────────

  describe('bindBundleMedia', () => {
    it('未绑定行 → 回绑；已绑同一 doc → no-op；已绑他 doc → 拒绝', async () => {
      attachmentRepo.findOne
        .mockResolvedValueOnce(makeRow({ id: 'att-1', docId: null }))
        .mockResolvedValueOnce(makeRow({ id: 'att-2', docId: 'doc-x' }))
        .mockResolvedValueOnce(makeRow({ id: 'att-3', docId: 'doc-other' }));

      const result = await service.bindBundleMedia([
        {
          attachmentId: 'att-1',
          docId: 'doc-x',
          sourceAttachmentId: 's1',
          docPath: 'docs/a.md',
          originalName: 'a.png',
        },
        {
          attachmentId: 'att-2',
          docId: 'doc-x',
          sourceAttachmentId: 's2',
          docPath: 'docs/a.md',
          originalName: 'b.png',
        },
        {
          attachmentId: 'att-3',
          docId: 'doc-x',
          sourceAttachmentId: 's3',
          docPath: 'docs/a.md',
          originalName: 'c.png',
        },
        {
          attachmentId: 'att-missing',
          docId: 'doc-x',
          sourceAttachmentId: 's4',
          docPath: 'docs/a.md',
          originalName: 'd.png',
        },
      ]);

      expect(result.bound).toBe(2);
      // 只有 docId NULL 的行才写（no-op 与拒绝都不写）
      expect(attachmentRepo.update).toHaveBeenCalledTimes(1);
      expect(attachmentRepo.update).toHaveBeenCalledWith({ id: 'att-1' }, { docId: 'doc-x' });
      expect(result.failures).toHaveLength(2);
      expect(result.failures[0].reason).toContain('already bound to another doc');
      expect(result.failures[1].reason).toContain('not found');
    });
  });
});

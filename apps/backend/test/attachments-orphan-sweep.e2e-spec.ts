/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 孤儿对象清扫（P2 批 4）：桶内无行对应的对象回收 + objectKey/thumbKey 双列保护 + 1h grace
 *
 * [代码职责]
 *   - 真 PG + 真 MinIO 验证 `AttachmentGcService.sweepOrphanObjectsOlderThan()`
 *     （cron 入口 `sweepOrphanObjects()` 的 grace 分支亦在此覆盖）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / GC)
 *   - 补充: .kimi/plans/plan-attachments-p2.md §④（规格来源；实现见 attachment-gc.service.ts）
 *
 * [关联代码]
 *   - src/modules/attachments/attachment-gc.service.ts — 被测实现（grace/保护集/计数日志）
 *   - src/modules/attachments/storage.service.ts — listObjects/removeObject 对象层
 *   - src/modules/attachments/attachment-gc.service.spec.ts — 同语义单测（mock 面）
 *
 * [持久踩坑]
 *   ORPHAN-COUNT(共享桶干扰): 本套件**不使用共享主桶**——自建隔离桶（RUN 后缀命名）
 *     承载全部种子对象。理由：graceMs=0 轮次会删掉桶内一切无行对象，若跑在主桶上，
 *     并行 jest worker 里其他套件"对象已落、行未插"的在途上传会被误删（假阴性来源）。
 *   MINIO-ENV: 读 MINIO_* env（默认 127.0.0.1:19000 chamber-minio）。MinIO 或 PG
 *     不可达 → warn + 整套 skip（attachments.e2e-spec.ts 同口径）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增用例必须登记 created.* 清理队列（FK 逆序 + 隔离桶对象/桶）
 *   □ 不得改为共享主桶（ORPHAN-COUNT 踩坑）
 *   □ 已核对 [关联代码] 的影响面
 * =============================================================================
 */

/**
 * 孤儿对象清扫 e2e —— 真 PG + 真 MinIO（隔离桶），plan §④ 验收行。
 *
 * 覆盖：
 * ① 孤儿对象：种对象（无行）→ sweep(graceMs=0) → statObject 消失 + 计数精确（scanned/deleted）；
 * ② grace 保护：全新对象在默认 1h 窗口内不删（`sweepOrphanObjects()` 真实时间戳路径）；
 * ③ 正常附件：行 objectKey + thumbKey 双对象在同一轮里保留（其孤儿邻居照删）；
 * ④ 软删行（30 天保留期内）：objectKey + **thumbKey 双键均保留**（withDeleted 保护集语义），
 *    同轮孤儿照删。
 *
 * 环境约定（telemetry/attachments 范式）：PG 或 MinIO 不可达 → warn + 整套 skip；
 * 隔离桶 RUN 后缀，afterAll 清空对象 + removeBucket（绝不触碰共享主桶）。
 */
import { DataSource } from 'typeorm';
import * as Minio from 'minio';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { AgentStatus, ActorType } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import {
  AttachmentGcService,
  ATTACHMENT_ORPHAN_GRACE_MS,
} from '../src/modules/attachments/attachment-gc.service';
import { AttachmentStorageService } from '../src/modules/attachments/storage.service';
import { Attachment } from '../src/database/entities/attachment.entity';
import { Actor } from '../src/database/entities/actor.entity';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** MinIO 测试实例（chamber-minio @ 19000；env 覆盖） */
const MINIO_CONFIG = {
  endPoint: process.env.MINIO_ENDPOINT ?? '127.0.0.1',
  port: Number(process.env.MINIO_PORT ?? 19000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minio_root_user',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'change-me-minio-secret',
  bucket: process.env.MINIO_BUCKET ?? 'agent-chamber-attachments',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行） */
const runSuffix = (): string =>
  `att-orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 隔离桶（RUN 后缀；MinIO 桶名规范：小写字母/数字/连字符，3–63 字符）。
 * 全部种子对象只落此桶——清扫的列举面完全可控，删除断言不受其他套件干扰
 * （见 Hook [持久踩坑] ORPHAN-COUNT）。
 */
const ISOLATED_BUCKET = `att-e2e-orphan-${Date.now().toString(36)}-${crypto
  .randomBytes(3)
  .toString('hex')}`;

describe('attachment orphan sweep e2e（真 PG + 真 MinIO / 隔离桶）', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let minioAvailable = false;
  let minioClient: Minio.Client;
  let storage: AttachmentStorageService;
  let gc: AttachmentGcService;
  let uploaderId = '';

  /** 本次运行创建的实体与对象（afterAll 清理） */
  const created: { attachmentIds: string[]; actorIds: string[]; objectKeys: string[] } = {
    attachmentIds: [],
    actorIds: [],
    objectKeys: [],
  };

  /** PG/MinIO 双可达守卫（每个用例首行调用） */
  function available(): boolean {
    return dbAvailable && minioAvailable;
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[orphan-sweep e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // MinIO 可达性（主桶存在性即探针；缺则自建，与 StorageService 同语义）
    minioClient = new Minio.Client(MINIO_CONFIG);
    try {
      const exists = await minioClient.bucketExists(MINIO_CONFIG.bucket);
      if (!exists) await minioClient.makeBucket(MINIO_CONFIG.bucket);
      minioAvailable = true;
    } catch (err) {
      console.warn(
        `[orphan-sweep e2e] MinIO unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }

    // 隔离桶 + 服务链（storage 的 bucket 指向隔离桶——清扫只看得见本套件对象）
    const configService = {
      get: (key: string): unknown => {
        if (key === 'minio.endPoint') return MINIO_CONFIG.endPoint;
        if (key === 'minio.port') return MINIO_CONFIG.port;
        if (key === 'minio.useSSL') return MINIO_CONFIG.useSSL;
        if (key === 'minio.accessKey') return MINIO_CONFIG.accessKey;
        if (key === 'minio.secretKey') return MINIO_CONFIG.secretKey;
        if (key === 'minio.bucket') return ISOLATED_BUCKET;
        return undefined;
      },
    } as unknown as ConfigService;
    storage = new AttachmentStorageService(configService);
    await storage.onModuleInit(); // 生产同款自举：bucketExists → makeBucket（private）
    if (!(await minioClient.bucketExists(ISOLATED_BUCKET))) {
      console.warn('[orphan-sweep e2e] isolated bucket unavailable, suite skipped');
      minioAvailable = false;
      return;
    }

    // 上传者身份（attachments.uploader_id FK→actors CASCADE，行种子必须有）
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `ORPHAN E2E uploader ${runSuffix()}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    uploaderId = actor.id;

    gc = new AttachmentGcService(ds.getRepository(Attachment), storage);
  }, 60000);

  afterAll(async () => {
    if (dbAvailable) {
      // FK 逆序兜底清理（附件行 → actor；本运行 RUN 隔离，不碰既有数据）
      for (const id of created.attachmentIds) await ds.getRepository(Attachment).delete({ id });
      for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
      await ds.destroy();
    }
    if (minioAvailable) {
      // 隔离桶整桶回收（清空 → removeBucket）；失败只 warn——绝不触碰共享主桶
      try {
        const keys: string[] = [];
        for await (const item of minioClient.listObjectsV2(ISOLATED_BUCKET, '', true)) {
          if (typeof item.name === 'string') keys.push(item.name);
        }
        for (const key of keys) {
          await minioClient.removeObject(ISOLATED_BUCKET, key).catch(() => undefined);
        }
        await minioClient.removeBucket(ISOLATED_BUCKET);
      } catch (err) {
        console.warn(
          `[orphan-sweep e2e] isolated bucket cleanup failed: ${(err as Error).message}`,
        );
      }
    }
  }, 30000);

  // ─── 造数工具 ────────────────────────────────────────────────

  /** 种一个对象到隔离桶（登记清理队列） */
  async function putObject(key: string, body: Buffer): Promise<string> {
    await minioClient.putObject(ISOLATED_BUCKET, key, body, body.length, {
      'Content-Type': 'image/png',
    });
    created.objectKeys.push(key);
    return key;
  }

  /** 对象是否存在（statObject 语义——清扫后孤儿应为 false） */
  async function objectExists(key: string): Promise<boolean> {
    return minioClient
      .statObject(ISOLATED_BUCKET, key)
      .then(() => true)
      .catch(() => false);
  }

  /** 种一行附件元数据（可带 thumbKey；deleted=true 走软删） */
  async function seedRow(opts: {
    objectKey: string;
    thumbKey?: string;
    deleted?: boolean;
  }): Promise<string> {
    const sha = (seed: string): string => crypto.createHash('sha256').update(seed).digest('hex');
    const row = await ds.getRepository(Attachment).save(
      ds.getRepository(Attachment).create({
        uploaderId,
        bucket: ISOLATED_BUCKET,
        objectKey: opts.objectKey,
        originalName: `${opts.objectKey}.png`,
        mimeType: 'image/png',
        sizeBytes: String(16),
        sha256: sha(opts.objectKey),
        status: 'ready',
        // thumb 5 列同生共死（应用层不变量；这里只为行形态真实，与清扫判定无耦合）
        thumbKey: opts.thumbKey ?? null,
        thumbWidth: opts.thumbKey ? 8 : null,
        thumbHeight: opts.thumbKey ? 8 : null,
        thumbSizeBytes: opts.thumbKey ? '16' : null,
        thumbSha256: opts.thumbKey ? sha(`${opts.objectKey}.thumb`) : null,
      }),
    );
    created.attachmentIds.push(row.id);
    if (opts.deleted) await ds.getRepository(Attachment).softDelete({ id: row.id });
    return row.id;
  }

  // ─── ① 孤儿删除 ──────────────────────────────────────────────

  it('孤儿对象：种对象（无行）→ sweep(graceMs=0) → statObject 消失 + 计数精确', async () => {
    if (!available()) return;
    const s = runSuffix();
    const orphanA = await putObject(`${s}-a.png`, Buffer.from('orphan-a'));
    const orphanB = await putObject(`${s}-b.png`, Buffer.from('orphan-b'));

    const res = await gc.sweepOrphanObjectsOlderThan(0);

    expect(await objectExists(orphanA)).toBe(false);
    expect(await objectExists(orphanB)).toBe(false);
    expect(res).toEqual({
      scanned: 2,
      deleted: 2,
      skippedFresh: 0,
      skippedUnknownAge: 0,
      failures: 0,
    });
  });

  // ─── ② grace 保护（默认 1h，真 MinIO 时间戳）──────────────────

  it('grace 保护：全新对象（模拟在途上传）在默认 1h 窗口内不删', async () => {
    if (!available()) return;
    const fresh = await putObject(`${runSuffix()}-fresh.png`, Buffer.from('fresh'));

    const res = await gc.sweepOrphanObjects(); // cron 入口 = 1h grace

    expect(ATTACHMENT_ORPHAN_GRACE_MS).toBe(60 * 60 * 1000);
    expect(await objectExists(fresh)).toBe(true);
    expect(res).toEqual({
      scanned: 1,
      deleted: 0,
      skippedFresh: 1,
      skippedUnknownAge: 0,
      failures: 0,
    });
    // 让后续用例的扫描面回到零残留（本用例的 fresh 对象显式回收）
    await minioClient.removeObject(ISOLATED_BUCKET, fresh);
  });

  // ─── ③ 正常附件：原图 + 缩略图双键保留 ────────────────────────

  it('正常附件：行 objectKey + thumbKey 双对象保留，同轮孤儿照删', async () => {
    if (!available()) return;
    const s = runSuffix();
    const objectKey = `${s}.png`;
    const thumbKey = `${s}.thumb.webp`;
    await seedRow({ objectKey, thumbKey });
    await putObject(objectKey, Buffer.from('live-original'));
    await putObject(thumbKey, Buffer.from('live-thumb'));
    const orphan = await putObject(`${s}-orphan.png`, Buffer.from('orphan'));

    const res = await gc.sweepOrphanObjectsOlderThan(0);

    expect(await objectExists(objectKey)).toBe(true);
    expect(await objectExists(thumbKey)).toBe(true); // thumbKey 是独立键——漏保护即误删
    expect(await objectExists(orphan)).toBe(false);
    expect(res.deleted).toBe(1);
    expect(res.failures).toBe(0);
  });

  // ─── ④ 软删行（保留期内）：双键均保留 ────────────────────────

  it('软删行（30 天保留期内）：objectKey + thumbKey 双键保留（withDeleted 保护集）', async () => {
    if (!available()) return;
    const s = runSuffix();
    const objectKey = `${s}-soft.png`;
    const thumbKey = `${s}-soft.thumb.webp`;
    await seedRow({ objectKey, thumbKey, deleted: true });
    await putObject(objectKey, Buffer.from('soft-deleted-original'));
    await putObject(thumbKey, Buffer.from('soft-deleted-thumb'));
    const orphan = await putObject(`${s}-soft-orphan.png`, Buffer.from('orphan'));

    const res = await gc.sweepOrphanObjectsOlderThan(0);

    expect(await objectExists(objectKey)).toBe(true);
    expect(await objectExists(thumbKey)).toBe(true);
    expect(await objectExists(orphan)).toBe(false);
    expect(res.deleted).toBe(1);
  });
});

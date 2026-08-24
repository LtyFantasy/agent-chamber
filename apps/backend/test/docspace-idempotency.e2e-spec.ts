/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16（DocSpace 写端点 clientRequestId 幂等契约）
 *   - 补充: plan fire-jericho-she-hulk.md（v1.63.0 Board 任务 7d918c7b）
 *   - 补充: apps/backend/src/modules/docspace/doc-idempotency.helper.ts（幂等 helper）
 *
 * [踩坑索引]
 *   - 58k 字符写丢响应事故（游戏方 Pilot 3，topic msg dd5b90c4）：transport error
 *     后盲重试无法区分未执行/已执行——本套件验收「同 key 重放 = 首次快照 + 零副作用」
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * DocSpace 写族 clientRequestId 幂等 —— 真实 PG 集成套件（v1.63.0，Board 任务 7d918c7b）
 *
 * 覆盖四写入口（upsert / patchSection / patchByMatch / patchMetadata / move）的幂等契约：
 * 重放逐字段一致 + 零副作用（无重复写/无新版本行）、并发同 key 仅一次生效、
 * 同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT、无键旁路回归、
 * 跨实体类型（task/topic/message 旧记录）key 冲突 → 409。
 *
 * 与 docspace-patch.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres，
 * PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { DocMoveService } from '../src/modules/docspace/doc-move.service';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Board } from '../src/database/entities/board.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import type { EventService } from '../src/modules/event/event.service';
import type { RouteHealthService } from '../src/modules/docspace/route-health.service';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据（路径 / 幂等键 / 清理范围） */
const RUN = `idem-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by 为 uuid 列） */
const testActor = { id: '00000000-0000-4000-8000-0000000000aa', type: ActorType.HUMAN };

describe('DocSpace 写族 clientRequestId 幂等 — 真实 PG 集成', () => {
  let ds: DataSource;
  let service: DocService;
  let moveService: DocMoveService;
  let dbAvailable = false;
  let spaceId: string;

  /** 本次运行创建的文档 id（afterAll 清理） */
  const createdDocIds: string[] = [];

  const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** 快捷建文档（无键通道） */
  const seedDoc = async (path: string, content: string): Promise<Doc> => {
    const r = await service.upsert(spaceId, { path, content }, testActor);
    createdDocIds.push(r.id);
    return service.findById(r.id);
  };

  /** 指定 key 的幂等记录查询 */
  const countRecords = async (key: string): Promise<number> =>
    ds.getRepository(IdempotencyRecord).count({
      where: { actorId: testActor.id, clientRequestId: key },
    });

  /** 指定文档的版本行数（零副作用断言：重放不得产生新版本） */
  const countVersions = async (docId: string): Promise<number> =>
    ds.getRepository(DocVersion).count({ where: { docId } });

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(
        `[docspace-idempotency e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    const eventStub = { create: jest.fn().mockResolvedValue({}) } as unknown as EventService;
    const routeHealthStub = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    } as unknown as RouteHealthService;

    service = new DocService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocCategory),
      ds.getRepository(AuditLog),
      ds.getRepository(DocSpace),
      ds.getRepository(Board),
      ds.getRepository(DocVersion),
      eventStub,
      routeHealthStub,
      ds.getRepository(IdempotencyRecord),
    );
    moveService = new DocMoveService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocRoute),
      ds.getRepository(TaskDocLink),
      ds.getRepository(AuditLog),
      ds.getRepository(IdempotencyRecord),
      service,
      eventStub,
    );

    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Idempotency E2E ${RUN}`,
        slug: `idem-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceId = space.id;
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // 幂等记录清理（本运行产生的 key 全带 RUN 前缀）
    await ds
      .getRepository(IdempotencyRecord)
      .createQueryBuilder()
      .delete()
      .where('client_request_id LIKE :prefix', { prefix: `${RUN}%` })
      .execute();
    for (const docId of createdDocIds) {
      await ds.getRepository(DocVersion).delete({ docId });
      await ds.getRepository(DocSection).delete({ docId });
      await ds.getRepository(Doc).delete({ id: docId });
    }
    if (spaceId) {
      await ds.getRepository(DocSpace).delete({ id: spaceId });
    }
    await ds.destroy();
  });

  // ── upsert ─────────────────────────────────────────────────

  it('upsert：同 key 重放返回首次快照 + idempotentReplay，零副作用（无重复文档/无新版本行）', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-upsert-replay`;
    const dto = { path: `tmp/${RUN}-replay.md`, content: '# 重放文档\n\n正文。' };

    const first = await service.upsert(spaceId, dto, testActor, key);
    createdDocIds.push(first.id);
    expect(first.created).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();

    const replay = await service.upsert(spaceId, dto, testActor, key);
    expect(replay.idempotentReplay).toBe(true);
    // 逐字段一致（快照 = 首次响应；idempotentReplay 是唯一附加键）
    expect({ ...replay, idempotentReplay: undefined }).toEqual({
      ...first,
      idempotentReplay: undefined,
    });
    // 零副作用：文档唯一、版本行只有首次创建那一条、幂等记录唯一
    expect(await countVersions(first.id)).toBe(1);
    expect(await countRecords(key)).toBe(1);
  });

  it('upsert：同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT（防静默吞写）', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-upsert-conflict`;
    const first = await service.upsert(
      spaceId,
      { path: `tmp/${RUN}-conflict.md`, content: '# 首次内容' },
      testActor,
      key,
    );
    createdDocIds.push(first.id);

    await expect(
      service.upsert(
        spaceId,
        { path: `tmp/${RUN}-conflict.md`, content: '# 不同内容' },
        testActor,
        key,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT }),
    });
    // 冲突拒绝后第二次写未发生：内容仍是首次的
    const doc = await service.findById(first.id);
    expect(doc.contentHash).toBe(first.contentHash);
    expect(await countVersions(first.id)).toBe(1);
  });

  it('upsert：无 key 旁路回归——同 path 连续写是正常更新语义，无 replay 标记', async () => {
    if (!dbAvailable) return;
    const path = `tmp/${RUN}-nokey.md`;
    const first = await service.upsert(spaceId, { path, content: '# v1' }, testActor);
    createdDocIds.push(first.id);
    const second = await service.upsert(spaceId, { path, content: '# v2' }, testActor);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.idempotentReplay).toBeUndefined();
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('upsert：unchanged 短路也登记幂等——重放返回 unchanged 快照', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-unchanged`;
    const dto = { path: `tmp/${RUN}-unchanged.md`, content: '# 不变文档\n\n正文。' };
    const created = await service.upsert(spaceId, dto, testActor);
    createdDocIds.push(created.id);

    const unchanged = await service.upsert(spaceId, dto, testActor, key);
    expect(unchanged.unchanged).toBe(true);

    const replay = await service.upsert(spaceId, dto, testActor, key);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.unchanged).toBe(true);
    expect(replay.contentHash).toBe(unchanged.contentHash);
    expect(await countVersions(created.id)).toBe(1);
  });

  it('upsert：并发同 key 双写仅一次生效（文档/版本/幂等记录各一）', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-concurrent`;
    const dto = { path: `tmp/${RUN}-concurrent.md`, content: '# 并发文档\n\n正文。' };

    const [r1, r2] = await Promise.all([
      service.upsert(spaceId, dto, testActor, key),
      service.upsert(spaceId, dto, testActor, key),
    ]);
    createdDocIds.push(r1.id);

    // 两个响应指向同一文档；至多一个是「首次」，至少一个带 replay 标记
    expect(r2.id).toBe(r1.id);
    const replayFlags = [r1.idempotentReplay === true, r2.idempotentReplay === true];
    expect(replayFlags.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    // 去掉 flag 后逐字段一致（败者拿到的是胜者的首次快照）
    expect({ ...r1, idempotentReplay: undefined }).toEqual({ ...r2, idempotentReplay: undefined });
    expect(await countVersions(r1.id)).toBe(1);
    expect(await countRecords(key)).toBe(1);
  });

  // ── patchByMatch / patchSection ────────────────────────────

  it('patchByMatch：同 key 重放返回首次快照，文档不被二次 patch', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-match`;
    const doc = await seedDoc(`tmp/${RUN}-match.md`, '# 文档\n\n旧段落。\n\n## 节\n\n节正文。');

    const first = await service.patchByMatch(
      doc.id,
      '旧段落。',
      '新段落。',
      'native',
      testActor,
      key,
    );
    expect(first.idempotentReplay).toBeUndefined();

    // 重放：oldString 已不存在于正文（首次已改），若无幂等会 404——重放必须返回首次快照
    const replay = await service.patchByMatch(
      doc.id,
      '旧段落。',
      '新段落。',
      'native',
      testActor,
      key,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect({ ...replay, idempotentReplay: undefined }).toEqual({
      ...first,
      idempotentReplay: undefined,
    });

    const full = await service.getContent(doc.id, true);
    expect(full.content).toContain('新段落。');
    expect(full.content).not.toContain('旧段落。');
    // 首次 patch 产生一个 patch 版本行，重放零新增
    expect(await countVersions(doc.id)).toBe(2);
    expect(await countRecords(key)).toBe(1);
  });

  it('patchByMatch：同 key 不同 oldString → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-match-conflict`;
    const doc = await seedDoc(`tmp/${RUN}-match-c.md`, '# 文档\n\n甲段落。\n\n乙段落。');

    await service.patchByMatch(doc.id, '甲段落。', '甲改。', 'native', testActor, key);
    await expect(
      service.patchByMatch(doc.id, '乙段落。', '乙改。', 'native', testActor, key),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT }),
    });
    // 第二次写未发生
    const full = await service.getContent(doc.id, true);
    expect(full.content).toContain('乙段落。');
  });

  it('patchSection：同 key 重放返回首次快照', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-section`;
    const doc = await seedDoc(`tmp/${RUN}-section.md`, '# 文档\n\n## 第一节\n\n旧节正文。');

    const first = await service.patchSection(
      doc.id,
      1,
      '## 第一节\n\n新节正文。',
      'native',
      testActor,
      undefined,
      key,
    );
    const replay = await service.patchSection(
      doc.id,
      1,
      '## 第一节\n\n新节正文。',
      'native',
      testActor,
      undefined,
      key,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect({ ...replay, idempotentReplay: undefined }).toEqual({
      ...first,
      idempotentReplay: undefined,
    });
    expect(await countVersions(doc.id)).toBe(2);
  });

  // ── patchMetadata ──────────────────────────────────────────

  it('patchMetadata：同 key 重放返回首次快照（changedFields 保真），无重复写', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-meta`;
    const doc = await seedDoc(`tmp/${RUN}-meta.md`, '# 元数据文档\n\n正文。');

    const dto = { title: '新标题', expectedContentHash: doc.contentHash! };
    const first = await service.patchMetadata(doc.id, dto, testActor, key);
    expect(first.unchanged).toBe(false);
    expect(first.changedFields).toContain('title');

    const replay = await service.patchMetadata(doc.id, dto, testActor, key);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.changedFields).toEqual(first.changedFields);
    expect(replay.unchanged).toBe(false);
    expect(await countRecords(key)).toBe(1);
  });

  it('patchMetadata：同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-meta-conflict`;
    const doc = await seedDoc(`tmp/${RUN}-meta-c.md`, '# 元数据文档\n\n正文。');

    await service.patchMetadata(
      doc.id,
      { title: '标题A', expectedContentHash: doc.contentHash! },
      testActor,
      key,
    );
    const fresh = await service.findById(doc.id);
    await expect(
      service.patchMetadata(
        doc.id,
        { title: '标题B', expectedContentHash: fresh.contentHash! },
        testActor,
        key,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT }),
    });
    const detail = await service.findOne(doc.id, 0);
    expect(detail.title).toBe('标题A');
  });

  // ── move ───────────────────────────────────────────────────

  it('move：同 key 重放返回首次快照，文档不二次移动；dryRun 带 key 不登记', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-move`;
    const doc = await seedDoc(`tmp/${RUN}-move-src.md`, '# 待移动文档\n\n正文。');

    // dryRun 带 key：预演不登记幂等记录（requestHash 也不含 dryRun 字段）
    const dryRun = await moveService.move(
      doc.id,
      { toPath: `tmp/${RUN}-move-dst.md`, dryRun: true, clientRequestId: key },
      testActor,
    );
    expect(dryRun.wouldMove).toBe(true);
    expect(await countRecords(key)).toBe(0);

    // 正式 move（同 key + 同写语义字段：dryRun 不参与指纹，预演不构成冲突）
    const first = await moveService.move(
      doc.id,
      { toPath: `tmp/${RUN}-move-dst.md`, clientRequestId: key },
      testActor,
    );
    expect(first.moved).toBe(true);
    expect(await countRecords(key)).toBe(1);

    // 重放：文档已在目标路径——若无幂等会 409（目标被自己占用/源不在原位），重放返回首次快照
    const replay = await moveService.move(
      doc.id,
      { toPath: `tmp/${RUN}-move-dst.md`, clientRequestId: key },
      testActor,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.moved).toBe(true);
    expect(replay.newPath).toBe(`tmp/${RUN}-move-dst.md`);

    const fresh = await service.findById(doc.id);
    expect(fresh.path).toBe(`tmp/${RUN}-move-dst.md`);
    expect(await countRecords(key)).toBe(1);

    // 同 key 不同 toPath → 409
    await expect(
      moveService.move(
        doc.id,
        { toPath: `tmp/${RUN}-move-other.md`, clientRequestId: key },
        testActor,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT }),
    });
  });

  // ── 跨实体类型 key 冲突 ────────────────────────────────────

  it('跨实体类型：key 被 task 通道旧记录（无 requestHash）占用 → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    if (!dbAvailable) return;
    const key = `${RUN}-cross-entity`;
    // 模拟 task/topic/message 通道的旧格式幂等记录（entityType 非 doc、request_hash NULL）
    const legacy = await ds.getRepository(IdempotencyRecord).save({
      actorId: testActor.id,
      clientRequestId: key,
      entityType: 'task',
      entityId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect(legacy.id).toBeDefined();

    await expect(
      service.upsert(spaceId, { path: `tmp/${RUN}-cross.md`, content: '# 跨实体' }, testActor, key),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT }),
    });
    // 旧记录未被覆盖/篡改
    const record = await ds
      .getRepository(IdempotencyRecord)
      .findOne({ where: { actorId: testActor.id, clientRequestId: key } });
    expect(record?.entityType).toBe('task');
    expect(record?.requestHash ?? null).toBeNull();
  });
});

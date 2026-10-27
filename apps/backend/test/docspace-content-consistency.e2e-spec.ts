/**
 * A2 内容一致性集成：只写本套件创建的全迁移临时库；普通 Promise 调度不穷尽所有交错。
 * 真实 Doc/Section/Version 与 ORM SQL；外围事件、审计、renderer 仅为 stub。
 * metadata 分类视图必须复用父行锁的事务连接；pool1 为有限等待的回归条件，不代表生产池配置。
 */
import { createHash, randomUUID } from 'crypto';
import { DataSource, DataSourceOptions, Logger, QueryRunner } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import { AppDataSource } from '../src/database/data-source';
import { PG_TRGM_SIMILARITY_THRESHOLD } from '../src/database/pg-session-defaults';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { Board } from '../src/database/entities/board.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { HintDedupService } from '../src/modules/hints/hint-dedup.service';
import { chunkMarkdown } from '../src/modules/docspace/markdown-chunker';

/** 独占库名前缀及进程随机后缀；清理只允许本次成功创建的这个名字。 */
const temporaryName = `doc_content_a2_${process.pid}_${Date.now().toString(36)}`;
/** 事务状态在 query 调用时快照；runner 仅作身份比较，禁止序列化连接对象。 */
const queries: {
  query: string;
  parameters: unknown[];
  runner?: QueryRunner;
  pid: number | null;
  active: boolean;
  depth: number;
}[] = [];
/** SQL logger 直接观察 TypeORM 发出的 SQL，供锁定位与操作顺序断言。 */
const sqlLogger: Logger = {
  logQuery(query, parameters, runner) {
    queries.push({
      query,
      parameters: [...(parameters ?? [])],
      runner,
      pid: (runner as any)?.databaseConnection?.processID ?? null,
      active: runner?.isTransactionActive ?? false,
      depth: (runner as any)?.transactionDepth ?? 0,
    });
  },
  logQueryError() {},
  logQuerySlow() {},
  logSchemaBuild() {},
  logMigration() {},
  log() {},
};

/** 克隆唯一 schema 来源，连接维护库或本次临时库，永不使用共享业务库。 */
function options(database: string, admin = false): DataSourceOptions {
  return {
    ...AppDataSource.options,
    host: process.env.TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT ?? 8744),
    username: process.env.TEST_DB_USERNAME ?? 'chamber',
    password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
    database,
    entities: admin ? [] : AppDataSource.options.entities,
    migrations: admin ? [] : AppDataSource.options.migrations,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: !admin,
    logger: sqlLogger,
  } as DataSourceOptions;
}

describe('Doc content consistency (isolated PostgreSQL)', () => {
  let admin: DataSource | undefined;
  let db: DataSource | undefined;
  /** 单独的小池只供 metadata 调用；原 A2 并发 DataSource 的容量保持不变。 */
  let metadataDb: DataSource | undefined;
  let metadataService: DocService;
  /** 记录本套件新增 DataSource 的全部 runner，失败后也逐个释放。 */
  const metadataRunners = new Set<QueryRunner>();
  /** 清理先 drain 请求，再关池和正常 DROP，不靠 FORCE 隐藏未释放连接。 */
  const metadataRequests = new Set<Promise<unknown>>();
  const metadataEvents = { create: jest.fn(async () => ({})) };
  const metadataAudit = {
    create: (row: unknown) => row,
    save: jest.fn(async (row: unknown) => row),
  };
  const metadataRouteHealth = { recheckSpace: jest.fn(async () => ({})) };
  let globalCategoryQuery: jest.SpyInstance;
  let created = false;
  let service: DocService;
  let spaceId: string;
  let migrationCount = 0;
  /** 自建文档作者 UUID，无真实身份、权限或消息资源接入。 */
  const actor = { id: randomUUID(), type: ActorType.HUMAN } as any;
  const events = { create: jest.fn(async () => ({})) };
  const routeHealth = { recheckSpace: jest.fn(async () => ({})) };
  /** 请求内容的原始 payload hash 是版本与当前 doc 的比较基准。 */
  const hash = (body: string) => createHash('sha256').update(body).digest('hex');

  jest.setTimeout(300_000);

  /** initialize 在 isInitialized=true 前失败时，仍关闭已创建的 PostgreSQL driver 池。 */
  async function closeDataSource(source: DataSource | undefined): Promise<void> {
    if (source?.isInitialized) await source.destroy();
    else if ((source?.driver as any)?.master) await source!.driver.disconnect();
  }

  /** setup 或测试失败都可调用；nested finally 确保 drain、断库、删库和维护连接关闭。 */
  async function cleanup(): Promise<void> {
    try {
      await Promise.allSettled([...metadataRequests]);
      expect(metadataRequests.size).toBe(0);
      try {
        for (const runner of metadataRunners) {
          if (runner.isReleased) continue;
          try {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
          } finally {
            await runner.release();
          }
        }
      } finally {
        globalCategoryQuery?.mockRestore();
        try {
          await closeDataSource(metadataDb);
        } finally {
          await closeDataSource(db);
        }
        expect([...metadataRunners].filter((runner) => !runner.isReleased).length).toBe(0);
        expect(metadataDb?.isInitialized ?? false).toBe(false);
        expect(db?.isInitialized ?? false).toBe(false);
        console.info('[metadata cleanup] pending=0; unreleasedRunners=0; poolsClosed=true');
      }
    } finally {
      try {
        if (created && admin?.isInitialized) {
          if (!/^doc_content_a2_\d+_[a-z0-9]+$/.test(temporaryName))
            throw new Error('Unsafe temporary database name');
          await admin.query(`DROP DATABASE "${temporaryName}"`);
          created = false;
          const remaining = await admin.query(
            'SELECT datname FROM pg_database WHERE datname = $1',
            [temporaryName],
          );
          expect(remaining).toHaveLength(0);
          console.info(`[A2 temporary database] dropped ${temporaryName}; remaining=0`);
        }
      } finally {
        await closeDataSource(admin);
      }
    }
  }

  beforeAll(async () => {
    try {
      admin = new DataSource(options(process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres', true));
      await admin.initialize(); // 不可达直接失败，不伪装 skip/pass。
      await admin.query(`CREATE DATABASE "${temporaryName}"`);
      created = true;
      db = new DataSource(options(temporaryName));
      await db.initialize();
      expect((await db.query('SELECT current_database() AS name'))[0].name).toBe(temporaryName);
      migrationCount = (await db.runMigrations()).length;
      expect(migrationCount).toBe(db.migrations.length);
      expect(migrationCount).toBeGreaterThan(0);
      expect(await db.showMigrations()).toBe(false);
      const space = await db.getRepository(DocSpace).save({
        name: 'A2 ordinary fixture',
        slug: `a2-${randomUUID()}`,
        creatorId: actor.id,
        settings: {},
      });
      spaceId = space.id;
      const audit = { create: (row: unknown) => row, save: jest.fn(async (row: unknown) => row) };
      service = new DocService(
        db.getRepository(Doc),
        db.getRepository(DocSection),
        db.getRepository(DocCategory),
        audit as any,
        db.getRepository(DocSpace),
        db.getRepository(Board),
        db.getRepository(DocVersion),
        events as any,
        routeHealth as any,
        db.getRepository(IdempotencyRecord),
        { validateAndRender: jest.fn() } as any,
        new HintDedupService(),
      );
      const metadataOptions = options(temporaryName);
      metadataDb = new DataSource({
        ...metadataOptions,
        poolSize: 1,
        // 保留源 DataSource 的 pg_trgm startup options；有限 acquire 只用于暴露第二次借连接。
        extra: { ...metadataOptions.extra, max: 1, connectionTimeoutMillis: 1_000 },
      } as DataSourceOptions);
      const createRunner = metadataDb.createQueryRunner.bind(metadataDb);
      jest.spyOn(metadataDb, 'createQueryRunner').mockImplementation((mode) => {
        const runner = createRunner(mode);
        metadataRunners.add(runner);
        return runner;
      });
      await metadataDb.initialize();
      expect((metadataDb.driver as any).master.options.max).toBe(1);
      expect((metadataDb.driver as any).master.options.connectionTimeoutMillis).toBe(1_000);
      expect((await metadataDb.query('SELECT current_database() AS name'))[0].name).toBe(
        temporaryName,
      );
      expect(
        Number(
          (
            await metadataDb.query(
              "SELECT current_setting('pg_trgm.similarity_threshold') AS threshold",
            )
          )[0].threshold,
        ),
      ).toBe(PG_TRGM_SIMILARITY_THRESHOLD);
      expect(await metadataDb.showMigrations()).toBe(false);
      metadataService = new DocService(
        metadataDb.getRepository(Doc),
        metadataDb.getRepository(DocSection),
        metadataDb.getRepository(DocCategory),
        metadataAudit as any,
        metadataDb.getRepository(DocSpace),
        metadataDb.getRepository(Board),
        metadataDb.getRepository(DocVersion),
        metadataEvents as any,
        metadataRouteHealth as any,
        metadataDb.getRepository(IdempotencyRecord),
        { validateAndRender: jest.fn() } as any,
        new HintDedupService(),
      );
      globalCategoryQuery = jest.spyOn(metadataDb.getRepository(DocCategory), 'createQueryBuilder');
      console.info(
        `[A2 temporary database] created ${temporaryName}; migrations=${migrationCount}`,
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  });

  afterAll(cleanup);

  /** 每个场景创建自己的文档，不删除或覆盖其他场景的 fixture。 */
  async function fixture() {
    const path = `fixtures/${randomUUID()}.md`;
    const body = '# Base\n\nOriginal body.';
    const result = await service.upsert(spaceId, { path, content: body }, actor);
    return { path, body, result };
  }

  /** 当前正文、position、计数和最后版本必须与同一次已提交 payload 一致。 */
  async function assertStored(id: string, bodies: string[], versionCount: number) {
    const repo = db!.getRepository(Doc);
    const doc = await repo.findOneByOrFail({ id });
    const sections = await db!
      .getRepository(DocSection)
      .find({ where: { docId: id }, order: { position: 'ASC' } });
    const versions = await db!
      .getRepository(DocVersion)
      .find({ where: { docId: id }, order: { version: 'ASC' } });
    const body = bodies.find((value) => hash(value) === doc.contentHash);
    expect(body).toBeDefined();
    const expected = chunkMarkdown(body!, doc.path);
    expect(
      sections.map((section) => ({
        position: section.position,
        headingPath: section.headingPath,
        headingLevel: section.headingLevel,
        content: section.content,
      })),
    ).toEqual(
      expected.map((section) => ({
        position: section.position,
        headingPath: section.headingPath,
        headingLevel: section.headingLevel,
        content: section.content,
      })),
    );
    expect(doc.sectionCount).toBe(sections.length);
    expect(doc.tokenEstimate).toBe(
      sections.reduce((sum, section) => sum + section.tokenEstimate, 0),
    );
    expect(sections.map((section) => section.position)).toEqual(
      expected.map((section) => section.position),
    );
    expect(versions).toHaveLength(versionCount);
    expect(versions.map((version) => version.version)).toEqual(
      Array.from({ length: versionCount }, (_, index) => index + 1),
    );
    expect(versions.every((version) => version.contentHash === hash(version.content))).toBe(true);
    expect(versions[versions.length - 1]).toMatchObject({
      content: body,
      contentHash: doc.contentHash,
    });
    return { doc, sections, versions };
  }

  it('full migrations and actual SQL lock use complete locator before section DELETE', async () => {
    const { path, result } = await fixture();
    queries.length = 0;
    const body = '# SQL\n\nReplacement.';
    await service.upsert(spaceId, { path, content: body }, actor);
    const lockIndex = queries.findIndex((row) => /FOR UPDATE/.test(row.query));
    const deletion = queries.findIndex((row) => /DELETE FROM "doc_sections"/.test(row.query));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(lockIndex);
    const locked = queries[lockIndex];
    const where = locked.query.slice(locked.query.indexOf(' WHERE '));
    expect(where).toContain('"d"."id" = $1');
    expect(where).toContain('"d"."space_id" = $2');
    expect(where).toContain('"d"."path" = $3');
    expect(where).toContain('"d"."deleted_at" IS NULL');
    expect(where).toMatch(/FOR UPDATE$/);
    expect(locked.parameters).toEqual([result.id, spaceId, path]);
    expect(
      queries
        .slice(0, lockIndex)
        .filter(
          (row) => row.runner === locked.runner && !/^(START TRANSACTION|BEGIN)/.test(row.query),
        )
        .map((row) => row.query),
    ).toEqual([]);
    expect(queries[deletion].runner === locked.runner).toBe(true);
    console.info(
      `[A2 SQL] ${JSON.stringify({ lock: locked.query, parameters: locked.parameters, lockIndex, deletion })}`,
    );
    await assertStored(result.id, [body], 2);
  });

  it('ordinary two no-hash calls leave one coherent final body and monotonic versions', async () => {
    const { path, result } = await fixture();
    const bodies = ['# First\n\nFirst body.', '# Second\n\nSecond body.'];
    await Promise.all(bodies.map((content) => service.upsert(spaceId, { path, content }, actor)));
    await assertStored(result.id, bodies, 3);
  });

  it('ordinary two calls sharing an expected hash commit one and reject the stale one', async () => {
    const { path, result } = await fixture();
    const bodies = ['# Guarded one\n\nOne.', '# Guarded two\n\nTwo.'];
    const results = await Promise.allSettled(
      bodies.map((content) =>
        service.upsert(spaceId, { path, content, expectedContentHash: result.contentHash }, actor),
      ),
    );
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((row) => row.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ response: { code: ErrorCode.DOC_CONTENT_CONFLICT } });
    await assertStored(result.id, bodies, 2);
  });

  it('ordinary mixed preconditions preserve all successful versions and final sections', async () => {
    const { path, result } = await fixture();
    const bodies = ['# Unguarded\n\nOrdinary.', '# Guarded\n\nConditional.'];
    const results = await Promise.allSettled([
      service.upsert(spaceId, { path, content: bodies[0] }, actor),
      service.upsert(
        spaceId,
        { path, content: bodies[1], expectedContentHash: result.contentHash },
        actor,
      ),
    ]);
    expect(results[0].status).toBe('fulfilled');
    if (results[1].status === 'rejected')
      expect(results[1].reason).toMatchObject({
        response: { code: ErrorCode.DOC_CONTENT_CONFLICT },
      });
    const successful = results.filter((row) => row.status === 'fulfilled').length;
    console.info(
      `[A2 ordinary mixed scheduling] fulfilled=${successful}; rejected=${2 - successful}`,
    );
    await assertStored(result.id, bodies, 1 + successful);
  });

  it('ordinary equal-content calls create one content version and one unchanged response', async () => {
    const { path, result } = await fixture();
    const content = '# Same\n\nIdentical body.';
    const results = await Promise.all([
      service.upsert(spaceId, { path, content }, actor),
      service.upsert(spaceId, { path, content }, actor),
    ]);
    expect(results.filter((row) => row.unchanged)).toHaveLength(1);
    await assertStored(result.id, [content], 2);
  });

  it('forceRechunk with unchanged hash rebuilds sections without adding a version', async () => {
    const { path, body, result } = await fixture();
    const before = await assertStored(result.id, [body], 1);
    const rebuilt = await service.upsert(
      spaceId,
      { path, content: body, forceRechunk: true },
      actor,
    );
    expect(rebuilt.rechunked).toBe(true);
    const after = await assertStored(result.id, [body], 1);
    expect(after.sections.map((section) => section.id)).not.toEqual(
      before.sections.map((section) => section.id),
    );
  });

  it('failure after real section writes rolls back document, sections and version together', async () => {
    const { path, body, result } = await fixture();
    const before = await assertStored(result.id, [body], 1);
    const manager = db!.getRepository(Doc).manager;
    const transaction = manager.transaction.bind(manager);
    const failure = new Error('A2 fixture version failure');
    const spy = jest.spyOn(manager, 'transaction').mockImplementation(((fn: any) =>
      transaction(async (tx) => {
        jest.spyOn(tx.getRepository(DocVersion), 'save').mockRejectedValueOnce(failure);
        return fn(tx);
      })) as any);
    try {
      await expect(
        service.upsert(spaceId, { path, content: '# Rollback\n\nMust not remain.' }, actor),
      ).rejects.toThrow(failure);
    } finally {
      spy.mockRestore();
    }
    const after = await assertStored(result.id, [body], 1);
    expect(after.sections.map((section) => section.id)).toEqual(
      before.sections.map((section) => section.id),
    );
    expect(after.doc.updatedAt).toEqual(before.doc.updatedAt);
  });

  describe('metadata response transaction connection (pool1)', () => {
    /** 仅 title 进入请求，避免把合法的事务前分类解析误判成锁内读取。 */
    async function metadataFixture(
      category: 'present' | 'none' | 'missing' | 'soft-deleted' = 'present',
    ) {
      const { result } = await fixture();
      let categoryId: string | null = null;
      let categoryName: string | null = null;
      if (category !== 'none') {
        categoryId = randomUUID();
        if (category !== 'missing') {
          categoryName = 'Metadata fixture category';
          await db!.getRepository(DocCategory).save({
            id: categoryId,
            spaceId,
            name: categoryName,
            slug: `metadata-${randomUUID()}`,
          });
          if (category === 'soft-deleted') {
            await db!.getRepository(DocCategory).softDelete(categoryId);
            categoryName = null;
          }
        }
      }
      const metadata = {
        title: 'Metadata original',
        summary: 'Metadata fixture summary',
        docType: 'reference',
        tags: ['metadata-fixture'],
        categoryId,
        categoryName,
      };
      const { categoryName: _name, ...stored } = metadata;
      await db!.getRepository(Doc).update(result.id, stored);
      // 裸 UUID 关联只属于本临时库，非空样本可发现误删/改写引用而非只验证空集合。
      await db!.query(
        'INSERT INTO task_doc_links (task_id, doc_id, created_by) VALUES ($1, $2, $3)',
        [randomUUID(), result.id, actor.id],
      );
      await db!.query(
        'INSERT INTO doc_routes (space_id, intent, primary_doc_id, created_by) VALUES ($1, $2, $3, $4)',
        [spaceId, `metadata fixture ${randomUUID()}`, result.id, actor.id],
      );
      return { id: result.id, contentHash: result.contentHash!, metadata };
    }

    /** 完整持久态快照；正文/版本/引用使用真实行，包含主键及时间戳。 */
    async function storedMetadata(id: string) {
      const [docs, sections, versions, links, routes] = await Promise.all([
        db!.query('SELECT * FROM docs WHERE id = $1', [id]),
        db!.query('SELECT * FROM doc_sections WHERE doc_id = $1 ORDER BY position', [id]),
        db!.query('SELECT * FROM doc_versions WHERE doc_id = $1 ORDER BY version', [id]),
        db!.query('SELECT * FROM task_doc_links WHERE doc_id = $1 ORDER BY task_id', [id]),
        db!.query(
          'SELECT * FROM doc_routes WHERE primary_doc_id = $1 OR secondary_doc_id = $1 ORDER BY id',
          [id],
        ),
      ]);
      expect(docs.length).toBe(1);
      return { doc: docs[0], sections, versions, links, routes };
    }

    /** metadata-only 不改变 hash、正文、版本和两类策展引用。 */
    function assertMetadataOnly(
      before: Awaited<ReturnType<typeof storedMetadata>>,
      after: Awaited<ReturnType<typeof storedMetadata>>,
    ): void {
      for (const key of [
        'id',
        'path',
        'content_hash',
        'section_count',
        'token_estimate',
        'link_health',
      ])
        expect(after.doc[key]).toEqual(before.doc[key]);
      expect(after.sections).toEqual(before.sections);
      expect(after.versions).toEqual(before.versions);
      expect(after.links).toEqual(before.links);
      expect(after.routes).toEqual(before.routes);
    }

    /** 仅保留本次 service 调用的 SQL 与外围 spy 计数。 */
    function resetMetadataObservations(): void {
      queries.length = 0;
      globalCategoryQuery.mockClear();
      metadataAudit.save.mockClear();
      metadataEvents.create.mockClear();
      metadataRouteHealth.recheckSpace.mockClear();
    }

    /** 请求在 finally 移出集合；afterAll 对仍在进行的请求先 await/drain。 */
    async function patchMetadata(
      id: string,
      dto: Parameters<DocService['patchMetadata']>[1],
      clientRequestId?: string,
    ) {
      const request = metadataService.patchMetadata(id, dto, actor, clientRequestId);
      metadataRequests.add(request);
      try {
        return await request;
      } finally {
        metadataRequests.delete(request);
      }
    }

    /** 同时接受 TypeORM 带 public schema 与未限定 schema 的真实 SQL。 */
    function categoryReads(rows = queries) {
      return rows.filter((row) =>
        /\bFROM\s+(?:"[^"]+"\.)?"doc_categories"\s+"dc"/i.test(row.query),
      );
    }

    /** 锁、分类及 COMMIT 的连接和事务状态都使用 logger 调用时快照。 */
    function assertMetadataTransaction(rows = queries, hasCategory = true) {
      const locks = rows.filter(
        (row) =>
          /\bFROM\s+(?:"[^"]+"\.)?"docs"\s+"d"/i.test(row.query) && /FOR UPDATE/.test(row.query),
      );
      expect(locks.length).toBe(1);
      const lock = locks[0];
      const lockIndex = rows.indexOf(lock);
      const starts = rows.filter(
        (row) => row.runner === lock.runner && /^(START TRANSACTION|BEGIN)\b/.test(row.query),
      );
      const commits = rows.filter(
        (row) => row.runner === lock.runner && /^COMMIT\b/.test(row.query),
      );
      expect(starts.length).toBe(1);
      expect(commits.length).toBe(1);
      const start = rows.indexOf(starts[0]);
      const commit = rows.indexOf(commits[0]);
      expect(starts[0].depth).toBe(0); // TypeORM 在 START 查询成功后才把 depth 从 0 加到 1。
      expect(start).toBeLessThan(lockIndex);
      expect(commit).toBeGreaterThan(lockIndex);
      const categories = categoryReads(rows);
      expect(categories.length).toBe(hasCategory ? 1 : 0);
      for (const row of [lock, ...categories, commits[0]]) {
        expect(Number.isInteger(row.pid) && row.pid! > 0).toBe(true);
        expect(row.pid).toBe(lock.pid);
        // 只断言布尔值，失败时不能让 Jest 展开含连接配置的 QueryRunner。
        expect(row.runner !== undefined && row.runner === lock.runner).toBe(true);
        expect(row.active).toBe(true);
        expect(row.depth).toBe(1);
      }
      if (hasCategory) {
        const categoryIndex = rows.indexOf(categories[0]);
        expect(categoryIndex).toBeGreaterThan(lockIndex);
        expect(categoryIndex).toBeLessThan(commit);
        expect(categories[0].query).toContain('"dc"."deleted_at" IS NULL');
        const selected = categories[0].query.split(/\bFROM\b/i)[0];
        expect(selected).toContain('"dc"."id"');
        expect(selected).toContain('"dc"."name"');
        expect(selected).not.toContain('"dc"."description"');
      }
      expect(globalCategoryQuery).toHaveBeenCalledTimes(0);
      return { lock, start, commit };
    }

    /** 聚焦 UPDATE 目标表，避免把 schema 限定名漏掉。 */
    function docUpdates(rows = queries) {
      return rows.filter((row) => /\bUPDATE\s+(?:"[^"]+"\.)?"docs"\s+SET\b/i.test(row.query));
    }

    it.each([true, false])(
      'categorized metadata changed=%s progresses with pool1 on the locked transaction connection',
      async (changed) => {
        const fixture = await metadataFixture();
        const before = await storedMetadata(fixture.id);
        const title = changed ? 'Metadata changed' : fixture.metadata.title;
        resetMetadataObservations();
        const result = await patchMetadata(fixture.id, {
          title,
          expectedContentHash: fixture.contentHash,
        });
        const trace = [...queries];
        expect(result.metadata).toEqual({ ...fixture.metadata, title });
        expect(result.unchanged).toBe(!changed);
        expect(result.changedFields).toEqual(changed ? ['title'] : []);
        expect(result.contentHash).toBe(fixture.contentHash);
        assertMetadataTransaction(trace);
        expect(docUpdates(trace).length).toBe(changed ? 1 : 0);
        const after = await storedMetadata(fixture.id);
        expect(after.doc.title).toBe(title);
        assertMetadataOnly(before, after);
        if (!changed) expect(after.doc).toEqual(before.doc);
        expect(metadataAudit.save).toHaveBeenCalledTimes(changed ? 1 : 0);
        expect(metadataEvents.create).toHaveBeenCalledTimes(changed ? 1 : 0);
        expect(metadataRouteHealth.recheckSpace).toHaveBeenCalledTimes(0);
      },
    );

    it.each([true, false])(
      'uncategorized metadata changed=%s performs zero category SQL',
      async (changed) => {
        const fixture = await metadataFixture('none');
        const before = await storedMetadata(fixture.id);
        const title = changed ? 'Uncategorized changed' : fixture.metadata.title;
        resetMetadataObservations();
        const result = await patchMetadata(fixture.id, {
          title,
          expectedContentHash: fixture.contentHash,
        });
        const trace = [...queries];
        expect(result.metadata).toEqual({ ...fixture.metadata, title });
        expect(result.unchanged).toBe(!changed);
        assertMetadataTransaction(trace, false);
        expect(trace.filter((row) => /"doc_categories"/.test(row.query)).length).toBe(0);
        expect(docUpdates(trace).length).toBe(changed ? 1 : 0);
        assertMetadataOnly(before, await storedMetadata(fixture.id));
      },
    );

    it.each(['missing', 'soft-deleted'] as const)(
      '%s category fixture preserves categoryId and returns categoryName null',
      async (category) => {
        // 仅验证已有兼容回退，不声称此 fixture 证明真实分类删除的并发交错。
        const fixture = await metadataFixture(category);
        resetMetadataObservations();
        const result = await patchMetadata(fixture.id, {
          title: fixture.metadata.title,
          expectedContentHash: fixture.contentHash,
        });
        const trace = [...queries];
        expect(result.metadata).toEqual(fixture.metadata);
        expect(result.metadata.categoryId).not.toBeNull();
        expect(result.metadata.categoryName).toBeNull();
        expect(result.unchanged).toBe(true);
        assertMetadataTransaction(trace);
        expect(docUpdates(trace).length).toBe(0);
      },
    );

    it.each([true, false])(
      'categorized metadata changed=%s replays the first complete idempotency snapshot',
      async (changed) => {
        const fixture = await metadataFixture();
        const clientRequestId = `metadata-${randomUUID()}`;
        const dto = {
          title: changed ? 'First metadata title' : fixture.metadata.title,
          expectedContentHash: fixture.contentHash,
        };
        resetMetadataObservations();
        const first = await patchMetadata(fixture.id, dto, clientRequestId);
        const firstTrace = [...queries];
        expect(first.metadata).toEqual({ ...fixture.metadata, title: dto.title });
        expect(first.unchanged).toBe(!changed);
        expect(first.changedFields).toEqual(changed ? ['title'] : []);
        const { lock, start, commit } = assertMetadataTransaction(firstTrace);
        const inserts = firstTrace.filter((row) =>
          /^INSERT INTO\s+(?:"[^"]+"\.)?"idempotency_records"/i.test(row.query),
        );
        expect(inserts.length).toBe(1);
        const insertion = inserts[0];
        expect(insertion.runner !== undefined && insertion.runner === lock.runner).toBe(true);
        expect(insertion.pid).toBe(lock.pid);
        expect(insertion.active).toBe(true);
        expect(insertion.depth).toBe(1);
        expect(firstTrace.indexOf(insertion)).toBeGreaterThan(start);
        expect(firstTrace.indexOf(insertion)).toBeGreaterThan(
          firstTrace.indexOf(categoryReads(firstTrace)[0]),
        );
        expect(firstTrace.indexOf(insertion)).toBeLessThan(commit);
        expect(docUpdates(firstTrace).length).toBe(changed ? 1 : 0);
        const records = await db!.getRepository(IdempotencyRecord).findBy({
          actorId: actor.id,
          clientRequestId,
        });
        expect(records.length).toBe(1);
        expect(records[0].responseSnapshot).toEqual(first);
        expect(metadataAudit.save).toHaveBeenCalledTimes(changed ? 1 : 0);
        expect(metadataEvents.create).toHaveBeenCalledTimes(changed ? 1 : 0);

        // fixture 改当前文档与分类名；同 actor/key/原始 dto 重放必须返回首完整快照。
        await db!.getRepository(Doc).update(fixture.id, { title: 'Current fixture title' });
        await db!.getRepository(DocCategory).update(fixture.metadata.categoryId!, {
          name: 'Current fixture category',
        });
        const current = await storedMetadata(fixture.id);
        resetMetadataObservations();
        const replay = await patchMetadata(fixture.id, dto, clientRequestId);
        const replayTrace = [...queries];
        expect(replay).toEqual({ ...first, idempotentReplay: true });
        expect(replayTrace.filter((row) => /"doc_categories"/.test(row.query)).length).toBe(0);
        expect(docUpdates(replayTrace).length).toBe(0);
        expect(
          replayTrace.filter((row) => /^(START TRANSACTION|BEGIN)\b/.test(row.query)).length,
        ).toBe(0);
        expect(globalCategoryQuery).toHaveBeenCalledTimes(0);
        expect(metadataAudit.save).toHaveBeenCalledTimes(0);
        expect(metadataEvents.create).toHaveBeenCalledTimes(0);
        expect(await storedMetadata(fixture.id)).toEqual(current);
        expect(
          await db!
            .getRepository(IdempotencyRecord)
            .countBy({ actorId: actor.id, clientRequestId }),
        ).toBe(1);
      },
    );

    it('injected category getOne failure rolls back the real Doc update and idempotency record', async () => {
      const fixture = await metadataFixture();
      const before = await storedMetadata(fixture.id);
      const clientRequestId = `metadata-${randomUUID()}`;
      const failure = new Error('Injected metadata transaction category read failure');
      const manager = metadataDb!.getRepository(Doc).manager;
      const transaction = manager.transaction.bind(manager);
      let categoryBuilder: jest.SpyInstance | undefined;
      let categoryRead: jest.SpyInstance | undefined;
      const transactionSpy = jest.spyOn(manager, 'transaction').mockImplementation(((fn: any) =>
        transaction(async (tx) => {
          const repo = tx.getRepository(DocCategory);
          const createBuilder = repo.createQueryBuilder.bind(repo);
          categoryBuilder = jest.spyOn(repo, 'createQueryBuilder').mockImplementation((...args) => {
            const builder = createBuilder(...args);
            // 只注入目标 getOne 的明确错误；父行锁、Doc UPDATE 与 ROLLBACK 仍为真实 PG。
            categoryRead = jest.spyOn(builder, 'getOne').mockRejectedValueOnce(failure);
            return builder;
          });
          return fn(tx);
        })) as any);
      resetMetadataObservations();
      try {
        await expect(
          patchMetadata(
            fixture.id,
            {
              title: 'Must roll back metadata title',
              expectedContentHash: fixture.contentHash,
            },
            clientRequestId,
          ),
        ).rejects.toThrow(failure);
        expect(categoryRead).toHaveBeenCalledTimes(1);
      } finally {
        categoryRead?.mockRestore();
        categoryBuilder?.mockRestore();
        transactionSpy.mockRestore();
      }
      const trace = [...queries];
      expect(docUpdates(trace).length).toBe(1);
      expect(trace.filter((row) => /^ROLLBACK\b/.test(row.query)).length).toBe(1);
      expect(trace.filter((row) => /^COMMIT\b/.test(row.query)).length).toBe(0);
      expect(globalCategoryQuery).toHaveBeenCalledTimes(0);
      expect(await storedMetadata(fixture.id)).toEqual(before);
      expect(
        await db!.getRepository(IdempotencyRecord).countBy({ actorId: actor.id, clientRequestId }),
      ).toBe(0);
      expect(metadataAudit.save).toHaveBeenCalledTimes(0);
      expect(metadataEvents.create).toHaveBeenCalledTimes(0);
    });
  });
});

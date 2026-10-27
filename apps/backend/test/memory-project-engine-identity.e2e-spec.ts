/**
 * Memory 当前身份唯一约束：全迁移临时库上的真实 PG 守卫。
 * 线上契约：DocSpace docs/database.md §4.35 / docs/architecture.md §3.2.14。
 * 只使用本套件创建的数据库，失败也释放；不修改共享 dev schema。
 */
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppDataSource } from '../src/database/data-source';
import { ActorType, MEMORY_ENGINE } from '@agent-chamber/shared';
import { MemoryProject } from '../src/database/entities/memory-project.entity';
import { MemoryNomination } from '../src/database/entities/memory-nomination.entity';
import { MemoryProjectService } from '../src/modules/memory/memory-project.service';
import type { MemoryAccessService } from '../src/modules/memory/memory-access.service';

/** 唯一本轮临时库名，避免与其他测试进程互相清理。 */
const TEMP_DB_NAME = `mem_identity_${process.pid}_${Date.now().toString(36)}`;
/** 克隆真正迁移入口，只覆盖测试连接与禁止同步的开关。 */
function options(database: string): DataSourceOptions {
  return {
    ...AppDataSource.options,
    host: process.env.TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT ?? 8744),
    username: process.env.TEST_DB_USERNAME ?? 'chamber',
    password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
    database,
    logging: false,
    synchronize: false,
    migrationsRun: false,
  } as DataSourceOptions;
}

describe('Memory 当前引擎身份唯一约束（真实 PG / 独立临时库）', () => {
  let admin: DataSource;
  let db: DataSource;
  let created = false;

  jest.setTimeout(300_000);

  beforeAll(async () => {
    admin = new DataSource({
      ...options(process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres'),
      entities: [],
      migrations: [],
    });
    // 本套件是数据库约束的验收门：PG不可达明确失败，不能把未执行当通过。
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${TEMP_DB_NAME}"`);
    created = true;
    db = new DataSource(options(TEMP_DB_NAME));
    await db.initialize();
    await db.runMigrations();
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (created) await admin.query(`DROP DATABASE "${TEMP_DB_NAME}" WITH (FORCE)`);
    if (admin?.isInitialized) await admin.destroy();
  });

  /** 每例的业务行都属于本临时库；清空不涉及开发库/生产库。 */
  beforeEach(async () => {
    await db.query(`TRUNCATE memory_formation_events, memory_recall_events,
      memory_engine_binding_claims, memory_nominations, memory_projects`);
  });

  /** 原生插入绕过应用层 claim，证明目标表约束本身生效。 */
  async function insert(
    slug: string,
    changes: Partial<MemoryProject> = {},
  ): Promise<MemoryProject> {
    return db.getRepository(MemoryProject).save({
      slug,
      name: slug,
      bindings: [],
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: 'private-ws',
      engineActorId: 'private-actor',
      engineCredentialRef: 'private-ref',
      createdBy: '99999999-9999-4999-8999-999999999999',
      ...changes,
    });
  }

  /** 只替代项目外部资源的权限解析，持久化和事务均用真实 PG。 */
  function service(): MemoryProjectService {
    const access = {
      describeUnreadableBinding: async () => null,
      resolveProjectAccess: async () => ({
        readable: true,
        writable: true,
        isGovernanceViewer: false,
        resolved: [],
      }),
    };
    return new MemoryProjectService(
      db.getRepository(MemoryProject),
      db.getRepository(MemoryNomination),
      access as unknown as MemoryAccessService,
      null,
      null,
    );
  }

  /** 所有原生约束失败都必须精确命中目标索引，不能靠其他约束凑绿。 */
  const indexConflict = { code: '23505', constraint: 'uq_memory_projects_engine_triple' };
  /** 服务调用者只用于通过权限 stub；不创建任何外部 actor。 */
  const actor = { id: '99999999-9999-4999-8999-999999999999', type: ActorType.AGENT };
  /** 与原生插入相同的完整绑定，用于服务路径的真实 23505。 */
  const binding = {
    engine: MEMORY_ENGINE.HUMENT,
    engineWorkspaceId: 'private-ws',
    engineActorId: 'private-actor',
    engineCredentialRef: 'private-ref',
  };

  it.each(['active', 'archived'] as const)('%s 完整身份重复必须由目标索引拒绝', async (status) => {
    await insert('identity-a');
    await expect(insert('identity-b', { status })).rejects.toMatchObject(indexConflict);
  });

  it('UPDATE 不能把不同身份改成已有身份', async () => {
    await insert('identity-a');
    const other = await insert('identity-b', { engineWorkspaceId: 'other-ws' });
    await expect(
      db.getRepository(MemoryProject).update(other.id, { engineWorkspaceId: 'private-ws' }),
    ).rejects.toMatchObject(indexConflict);
    expect(
      (await db.getRepository(MemoryProject).findOneByOrFail({ id: other.id })).engineWorkspaceId,
    ).toBe('other-ws');
  });

  it('索引包含 engine 和三元组各维度，允许不同完整身份', async () => {
    await insert('identity-a');
    for (const [n, changes] of [
      { engine: 'future-engine' },
      { engineWorkspaceId: 'other-ws' },
      { engineActorId: 'other-actor' },
      { engineCredentialRef: 'other-ref' },
    ].entries()) {
      // engine 是裸 varchar；此处只测试索引列序/维度，不声明 API 接受未来引擎名。
      await insert(`identity-${n}`, changes as Partial<MemoryProject>);
    }
    expect(await db.getRepository(MemoryProject).count()).toBe(5);
  });

  it('none/null 及三列任一 null 不参与；软删释放当前位置但不声称释放历史 claim', async () => {
    // UNIQUE 的默认 NULLS DISTINCT 也能放行 null，必须另读真实谓词证明部分索引合同。
    const [{ indexdef }] = await db.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'uq_memory_projects_engine_triple'`);
    for (const column of ['engine_workspace_id', 'engine_actor_id', 'engine_credential_ref']) {
      expect(indexdef).toContain(`${column} IS NOT NULL`);
    }
    expect(indexdef).toContain('deleted_at IS NULL');
    expect(indexdef).not.toMatch(/\bstatus\b/);
    await insert('identity-a', { deletedAt: new Date() });
    await insert('identity-b');
    for (const [n, changes] of [
      {
        engine: MEMORY_ENGINE.NONE,
        engineWorkspaceId: null,
        engineActorId: null,
        engineCredentialRef: null,
      },
      {
        engine: MEMORY_ENGINE.NONE,
        engineWorkspaceId: null,
        engineActorId: null,
        engineCredentialRef: null,
      },
      { engineWorkspaceId: null },
      { engineActorId: null },
      { engineCredentialRef: null },
    ].entries())
      await insert(`nullable-${n}`, changes);
    expect(await db.getRepository(MemoryProject).count()).toBe(6);
  });

  it('create 真实索引冲突返回 409，无项目/claim 半成品或接线泄漏', async () => {
    await insert('identity-a');
    const error = await service()
      .create(actor, {
        slug: 'identity-b',
        name: 'b',
        bindings: [{ type: 'board', id: actor.id }],
        ...binding,
      })
      .catch((err: unknown) => err);
    expect(error).toMatchObject({
      status: 409,
      response: { code: 14002, data: { reason: 'engine_binding_claimed' } },
    });
    for (const secret of ['private-ws', 'private-actor', 'private-ref'])
      expect(JSON.stringify(error)).not.toContain(secret);
    expect(await db.getRepository(MemoryProject).count()).toBe(1);
    expect(
      (await db.query('SELECT count(*)::int AS n FROM memory_engine_binding_claims'))[0].n,
    ).toBe(0);
  });

  it('PATCH 索引冲突返回 409，项目修改与旧身份补 claim 整体回滚', async () => {
    await insert('identity-a');
    const other = await insert('identity-b', { engineWorkspaceId: 'other-ws' });
    await expect(
      service().update(actor, other.id, { name: 'must-rollback', ...binding }),
    ).rejects.toMatchObject({ status: 409, response: { code: 14002 } });
    const unchanged = await db.getRepository(MemoryProject).findOneByOrFail({ id: other.id });
    expect(unchanged.name).toBe('identity-b');
    expect(unchanged.engineWorkspaceId).toBe('other-ws');
    expect(
      (await db.query('SELECT count(*)::int AS n FROM memory_engine_binding_claims'))[0].n,
    ).toBe(0);
  });

  it('历史 active/archived 重复中止迁移，诊断 UUID 且事务无数据/索引/迁移账残留', async () => {
    await db.undoLastMigration();
    const a = await insert('legacy-a');
    const b = await insert('legacy-b', { status: 'archived' });
    const before = await db.query('SELECT * FROM memory_projects ORDER BY id');
    const error = await db.runMigrations().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(a.id);
    expect(message).toContain(b.id);
    for (const secret of ['private-ws', 'private-actor', 'private-ref'])
      expect(message).not.toContain(secret);
    expect(await db.query('SELECT * FROM memory_projects ORDER BY id')).toEqual(before);
    expect(
      await db.query(`SELECT 1 FROM pg_indexes WHERE indexname='uq_memory_projects_engine_triple'`),
    ).toEqual([]);
    expect(
      await db.query(
        `SELECT 1 FROM migrations WHERE name='EnforceMemoryProjectEngineIdentity1792500000000'`,
      ),
    ).toEqual([]);
    await db.getRepository(MemoryProject).delete(b.id);
    await db.runMigrations();
    await expect(insert('after-recovery')).rejects.toMatchObject(indexConflict);
  });

  it('大量历史重复仅列前20个 UUID 并明确截断；up/down/up 往返仍保持约束', async () => {
    await db.undoLastMigration();
    const rows = [];
    for (let n = 0; n < 22; n += 1) rows.push(await insert(`many-${n}`));
    const error = await db.runMigrations().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const ordered = rows.map((row) => row.id).sort();
    for (const id of ordered.slice(0, 20)) expect(message).toContain(id);
    for (const id of ordered.slice(20)) expect(message).not.toContain(id);
    expect(message).toContain('truncated to 20 ids');
    await db.getRepository(MemoryProject).delete(rows.slice(1).map((row) => row.id));
    await db.runMigrations();
    await db.undoLastMigration();
    await db.runMigrations();
    await expect(insert('roundtrip-conflict')).rejects.toMatchObject(indexConflict);
  });
});

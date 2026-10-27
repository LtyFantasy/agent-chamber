/**
 * Memory 数据身份/首次账本的线性化协议：全迁移独立 PG + 受控 FakeEngine。
 * 权威文档：DocSpace docs/architecture.md §3.2.14、docs/api-definition.md §19。
 * Provider 门闩不靠 sleep；pool=1 检出事务内借第二连接，reader 证明网络期不持项目锁。
 */
import { DataSource, type DataSourceOptions } from 'typeorm';
import { ActorType, MEMORY_ENGINE } from '@agent-chamber/shared';
import { AppDataSource } from '../src/database/data-source';
import { MemoryProject } from '../src/database/entities/memory-project.entity';
import { MemoryNomination } from '../src/database/entities/memory-nomination.entity';
import { MemoryFormationEvent } from '../src/database/entities/memory-formation-event.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { Message } from '../src/database/entities/message.entity';
import { Task } from '../src/database/entities/task.entity';
import { TaskComment } from '../src/database/entities/task-comment.entity';
import type { ActorProfileService } from '../src/common/services/actor-profile.service';
import type { MemoryAccessService } from '../src/modules/memory/memory-access.service';
import { MemoryProjectService } from '../src/modules/memory/memory-project.service';
import { MemoryFormationService } from '../src/modules/memory/memory-formation.service';
import { MemoryLedgerRepository } from '../src/modules/memory/ledger.repository';
import { FakeEngine } from '../src/modules/memory/engines/fake.engine';
import type {
  MemoryEngineTarget,
  NominateMemoryInput,
} from '../src/modules/memory/engines/memory-engine.interface';

/** 只建/删本轮临时库，绝不修改共享 dev。 */
const TEMP_DB_NAME = `memory_rebind_${process.pid}_${Date.now().toString(36)}`;
/** 固定调用者，不需要创建平台 actor：本套件替代外围权限而保留真实持久化。 */
const ACTOR = { id: '99999999-9999-4999-8999-999999999999', type: ActorType.AGENT };

/** 两端显式握手；release 可重复调用，失败清理也能放行等待方。 */
function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    pause: async () => {
      enter();
      await released;
    },
  };
}

/** 所有引擎操作只落本进程 FakeEngine，门闩用于构造确定的在途窗口。 */
class ControlledEngine extends FakeEngine {
  /** 实际发送的身份快照，供 namespace 断言；不包含真实凭据。 */
  readonly targets: MemoryEngineTarget[] = [];
  constructor(private readonly providerGate?: ReturnType<typeof gate>) {
    super();
  }
  /** Provider 入口先报告 entered，再等待测试释放；不执行任何真实网络调用。 */
  override async nominate(target: MemoryEngineTarget, input: NominateMemoryInput) {
    this.targets.push({ ...target });
    if (this.providerGate) await this.providerGate.pause();
    return super.nominate(target, input);
  }
}

/** 真实迁移入口 + 单连接池；如果短事务偷偷借全局连接，会及时失败而非无限等候。 */
function options(database: string): DataSourceOptions {
  return {
    ...AppDataSource.options,
    host: process.env.TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT ?? 8744),
    username: process.env.TEST_DB_USERNAME ?? 'chamber',
    password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
    database,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    poolSize: 1,
    extra: { ...AppDataSource.options.extra, max: 1, connectionTimeoutMillis: 2000 },
  } as DataSourceOptions;
}

describe('Memory 数据身份与首次账本一致性（真实 PG / 受控 FakeEngine）', () => {
  let admin: DataSource;
  let db: DataSource;
  let reader: DataSource;
  let created = false;
  const gates: Array<ReturnType<typeof gate>> = [];
  const pending: Promise<unknown>[] = [];
  jest.setTimeout(60_000);

  beforeAll(async () => {
    admin = new DataSource({
      ...options(process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres'),
      entities: [],
      migrations: [],
    });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${TEMP_DB_NAME}"`);
    created = true;
    db = new DataSource(options(TEMP_DB_NAME));
    await db.initialize();
    await db.runMigrations();
    reader = new DataSource({ ...options(TEMP_DB_NAME), migrations: [] });
    await reader.initialize();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE memory_formation_events, memory_recall_events,
      memory_engine_binding_claims, memory_nominations, memory_projects`);
  });
  afterEach(async () => {
    for (const latch of gates.splice(0)) latch.release();
    await Promise.allSettled(pending.splice(0));
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    if (reader?.isInitialized) await reader.destroy();
    if (db?.isInitialized) await db.destroy();
    if (created) await admin.query(`DROP DATABASE "${TEMP_DB_NAME}" WITH (FORCE)`);
    if (admin?.isInitialized) await admin.destroy();
  });

  /** 在本临时库创建尚无账本的、配置完整的项目。 */
  async function project(): Promise<MemoryProject> {
    return db
      .getRepository(MemoryProject)
      .save({
        slug: 'rebind',
        name: 'before',
        bindings: [],
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'workspace-a',
        engineActorId: 'actor-a',
        engineCredentialRef: 'ref-a',
        createdBy: ACTOR.id,
      });
  }
  /** 原始输入保留 clientRequestId；快照冲突没有提交，允许同 key 重新读取后重试。 */
  function claim(key = 'rebind-request') {
    return {
      category: 'ruling',
      subject: 'identity',
      scope: 'project',
      rationale: 'frozen rationale',
      clientRequestId: key,
    };
  }
  /** 替代外围 ACL/来源标签，不替代项目、账本、claim、形成遥测或事务。 */
  function harness(engine = new ControlledEngine(), connection = db) {
    const access = {
      assertProjectWrite: async () => undefined,
      describeUnreadableBinding: async () => null,
      resolveProjectAccess: async () => ({
        readable: true,
        writable: true,
        isGovernanceViewer: false,
        resolved: [],
      }),
      evaluateSourceRefs: async () => [],
    };
    const projects = new MemoryProjectService(
      connection.getRepository(MemoryProject),
      connection.getRepository(MemoryNomination),
      access as unknown as MemoryAccessService,
      engine,
      null,
    );
    const formation = new MemoryFormationService(
      connection.getRepository(MemoryProject),
      connection.getRepository(MemoryNomination),
      connection.getRepository(MemoryFormationEvent),
      connection.getRepository(Doc),
      connection.getRepository(DocSection),
      connection.getRepository(Message),
      connection.getRepository(Task),
      connection.getRepository(TaskComment),
      access as unknown as MemoryAccessService,
      projects,
      new MemoryLedgerRepository(connection.getRepository(MemoryNomination)),
      { resolveProfiles: async () => new Map() } as unknown as ActorProfileService,
      engine,
    );
    return { projects, formation, engine, access };
  }
  /** 立即接住拒绝，避免确定性门闩窗口产生 unhandled rejection。 */
  function capture<T>(operation: Promise<T>) {
    const result = operation.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    pending.push(result);
    return result;
  }
  /** 确认流程进入控制点；若提前结束，立即失败而不依赖测试超时。 */
  async function reached(latch: ReturnType<typeof gate>, operation: Promise<unknown>) {
    await Promise.race([
      latch.entered,
      operation.then(() => {
        throw new Error('operation finished before controlled gate');
      }),
    ]);
  }
  /** 登记门闩，让失败清理同样能够释放 Provider。 */
  function latch() {
    const value = gate();
    gates.push(value);
    return value;
  }

  it('Provider entered 后身份已固定；网络等待期间另一连接仍能锁项目改名', async () => {
    const p = await project();
    const provider = latch();
    const { projects, formation } = harness(new ControlledEngine(provider));
    const nomination = capture(formation.nominate(ACTOR, p.id, claim()));
    await reached(provider, nomination);
    expect(
      (await db.getRepository(MemoryNomination).findOneByOrFail({ projectId: p.id }))
        .formationState,
    ).toBe('submitted');
    // 独立连接 NOWAIT 能拿锁并写入，证明 Provider 期间没有持有长事务/项目锁。
    await reader.transaction(async (manager) => {
      await manager.query('SELECT id FROM memory_projects WHERE id=$1 FOR UPDATE NOWAIT', [p.id]);
      await manager.query('UPDATE memory_projects SET name=$2 WHERE id=$1', [
        p.id,
        'during-provider',
      ]);
    });
    const change = await capture(
      projects.update(ACTOR, p.id, { engineWorkspaceId: 'workspace-b' }),
    );
    provider.release();
    const result = await nomination;
    expect(change.error).toMatchObject({ status: 409, response: { code: 14002 } });
    expect(result.error).toBeUndefined();
    expect(
      (await db.getRepository(MemoryProject).findOneByOrFail({ id: p.id })).engineWorkspaceId,
    ).toBe('workspace-a');
  });

  it('PATCH 先赢后旧 prepare 快照拒绝：零账本、零引擎调用', async () => {
    const p = await project();
    const { projects, formation, engine } = harness();
    const prepared = latch();
    const original = formation.prepareClaim.bind(formation);
    jest.spyOn(formation, 'prepareClaim').mockImplementation(async (...args) => {
      const payload = await original(...args);
      await prepared.pause();
      return payload;
    });
    const nomination = capture(formation.nominate(ACTOR, p.id, claim()));
    await reached(prepared, nomination);
    await projects.update(ACTOR, p.id, { engineWorkspaceId: 'workspace-b' });
    prepared.release();
    const result = await nomination;
    expect(result.error).toMatchObject({ status: 409, response: { code: 14002 } });
    expect(await db.getRepository(MemoryNomination).count()).toBe(0);
    expect(engine.targets).toEqual([]);
    expect((await formation.nominate(ACTOR, p.id, claim())).httpStatus).toBe(201);
    expect(engine.targets[0].workspaceId).toBe('workspace-b');
  });

  it('resumeProject 候选非空后重读项目，不把扫描前旧 target 发给新空间首条账本', async () => {
    const p = await project();
    const { projects, formation, engine } = harness();
    const scan = latch();
    const repo = db.getRepository(MemoryNomination);
    const makeQuery = repo.createQueryBuilder.bind(repo);
    jest.spyOn(repo, 'createQueryBuilder').mockImplementation((...args) => {
      const query = makeQuery(...args);
      const getMany = query.getMany.bind(query);
      query.getMany = async () => {
        await scan.pause();
        return getMany();
      };
      return query;
    });
    const recovery = capture(formation.resumeProject(p, 10));
    await reached(scan, recovery);
    await projects.update(ACTOR, p.id, { engineWorkspaceId: 'workspace-b' });
    const fresh = await db.getRepository(MemoryProject).findOneByOrFail({ id: p.id });
    const dto = claim();
    // 变量的结构类型可兼容 RED 时的旧签名；GREEN 时 required snapshot 没有 optional 旁路。
    const params = {
      projectId: p.id,
      projectSnapshot: fresh,
      actor: ACTOR,
      dto,
      prepared: await formation.prepareClaim(ACTOR, dto),
    };
    await formation.createLedgerRow(params);
    scan.release();
    const result = await recovery;
    expect(result.error).toBeUndefined();
    expect(engine.targets).toHaveLength(1);
    expect(engine.targets[0].workspaceId).toBe('workspace-b');
  });
  /** 只建耐久账本而不发 Provider，便于判别“存在性”而非某个最终状态。 */
  async function ledger(formation: MemoryFormationService, p: MemoryProject) {
    const dto = claim();
    const params = {
      projectId: p.id,
      projectSnapshot: p,
      actor: ACTOR,
      dto,
      prepared: await formation.prepareClaim(ACTOR, dto),
    };
    return formation.createLedgerRow(params);
  }

  it.each([
    ['submitted', 'active', false],
    ['unknown', 'active', false],
    ['failed', 'active', false],
    ['no_memory', 'active', false],
    ['rejected', 'active', false],
    ['conflict', 'active', false],
    ['committed', 'active', false],
    ['committed', 'withdrawn', false],
    ['committed', 'superseded', false],
    ['failed', 'active', true],
  ] as const)(
    '任意历史账本都固定身份：%s/%s/deleted=%s',
    async (formationState, status, deleted) => {
      const p = await project();
      const { projects, formation } = harness();
      const row = await ledger(formation, p);
      await db.query(
        'UPDATE memory_nominations SET formation_state=$2,status=$3,deleted_at=$4 WHERE id=$1',
        [row.id, formationState, status, deleted ? new Date() : null],
      );
      await expect(
        projects.update(ACTOR, p.id, { engineWorkspaceId: 'workspace-b' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 14002 } });
    },
  );

  it.each([{ engineActorId: 'actor-b' }, { engine: MEMORY_ENGINE.NONE }])(
    'actor/engine 同为数据身份：%j',
    async (delta) => {
      const p = await project();
      const { projects, formation } = harness();
      await ledger(formation, p);
      await expect(projects.update(ACTOR, p.id, delta)).rejects.toMatchObject({ status: 409 });
    },
  );

  it('空项目可改身份；有账本仍可同值PATCH/轮换凭据/改元数据，retry用当前凭据与冻结正文', async () => {
    const p = await project();
    const { projects, formation, engine } = harness();
    await projects.update(ACTOR, p.id, { engine: MEMORY_ENGINE.NONE });
    await projects.update(ACTOR, p.id, {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: 'workspace-b',
      engineActorId: 'actor-b',
      engineCredentialRef: 'ref-b',
    });
    const fresh = await projects.findProjectOrThrow(p.id);
    const row = await ledger(formation, fresh);
    await projects.update(ACTOR, p.id, {
      engineWorkspaceId: 'workspace-b',
      engineActorId: 'actor-b',
    });
    await projects.update(ACTOR, p.id, {
      engineCredentialRef: 'ref-rotated',
      name: 'after',
      retainQueryText: false,
    });
    const result = await formation.retry(ACTOR, row.id);
    expect(result.httpStatus).toBe(201);
    expect(engine.targets[0]).toEqual({
      workspaceId: 'workspace-b',
      actorId: 'actor-b',
      credentialRef: 'ref-rotated',
    });
    const after = await db.getRepository(MemoryProject).findOneByOrFail({ id: p.id });
    expect(after).toMatchObject({ name: 'after', retainQueryText: false });
    expect(
      (await db.getRepository(MemoryNomination).findOneByOrFail({ id: row.id })).updatedAt,
    ).toEqual(row.updatedAt);
  });

  it('旧元数据PATCH授权后延迟，不把已改绑且建账的新身份写回旧值', async () => {
    const p = await project();
    const { projects, formation, access } = harness();
    const authorized = latch();
    let calls = 0;
    const original = access.resolveProjectAccess;
    jest.spyOn(access, 'resolveProjectAccess').mockImplementation(async () => {
      const result = await original();
      if (++calls === 1) await authorized.pause();
      return result;
    });
    const metadata = capture(
      projects.update(ACTOR, p.id, { name: 'late-name', retainQueryText: false }),
    );
    await reached(authorized, metadata);
    await projects.update(ACTOR, p.id, {
      engineWorkspaceId: 'workspace-b',
      engineCredentialRef: 'ref-b',
    });
    await ledger(formation, await projects.findProjectOrThrow(p.id));
    authorized.release();
    expect((await metadata).error).toBeUndefined();
    expect(await projects.findProjectOrThrow(p.id)).toMatchObject({
      name: 'late-name',
      retainQueryText: false,
      engineWorkspaceId: 'workspace-b',
      engineCredentialRef: 'ref-b',
    });
  });

  it('授权bindings在锁前变更，旧PATCH必须409重读而不应用旧授权', async () => {
    const p = await project();
    const { projects, access } = harness();
    const authorized = latch();
    let calls = 0;
    const original = access.resolveProjectAccess;
    jest.spyOn(access, 'resolveProjectAccess').mockImplementation(async () => {
      const result = await original();
      if (++calls === 1) await authorized.pause();
      return result;
    });
    const metadata = capture(projects.update(ACTOR, p.id, { name: 'must-not-land' }));
    await reached(authorized, metadata);
    await projects.update(ACTOR, p.id, { bindings: [{ type: 'board', id: ACTOR.id }] });
    authorized.release();
    expect((await metadata).error).toMatchObject({ status: 409 });
    expect((await projects.findProjectOrThrow(p.id)).name).toBe('before');
  });

  it.each([
    { engineCredentialRef: 'ref-rotated' },
    { engineActorId: 'actor-b' },
    { bindings: [{ type: 'board' as const, id: ACTOR.id }] },
  ])('首次建账前的配置/权限快照变更也拒绝：%j', async (delta) => {
    const p = await project();
    const { projects, formation, engine } = harness();
    await projects.update(ACTOR, p.id, delta);
    await expect(ledger(formation, p)).rejects.toMatchObject({
      status: 409,
      response: { code: 14002 },
    });
    expect(await db.getRepository(MemoryNomination).count()).toBe(0);
    expect(engine.targets).toEqual([]);
  });

  it('首条INSERT临界区与PATCH共享项目锁；默认RR连接等待后仍以显式RC看见账本', async () => {
    const p = await project();
    const { formation } = harness();
    const other = harness(new ControlledEngine(), reader);
    const inserting = latch();
    const competingRead = latch();
    const trace: string[] = [];
    const createMainRunner = db.createQueryRunner.bind(db);
    jest.spyOn(db, 'createQueryRunner').mockImplementation((mode) => {
      const runner = createMainRunner(mode);
      const query = runner.query.bind(runner);
      jest
        .spyOn(runner, 'query')
        .mockImplementation(async (sql: string, parameters?: unknown[], structured?: boolean) => {
          if (/^INSERT INTO "memory_nominations"/.test(sql)) await inserting.pause();
          return structured ? query(sql, parameters, true) : query(sql, parameters);
        });
      return runner;
    });
    await reader.query("SET SESSION default_transaction_isolation = 'repeatable read'");
    const nomination = capture(formation.nominate(ACTOR, p.id, claim()));
    try {
      await reached(inserting, nomination);
      // 真实PG的即时拒绝证明首条INSERT前已经持有项目锁，删掉形成侧FOR UPDATE会当场红。
      await expect(
        reader.query('SELECT id FROM memory_projects WHERE id=$1 FOR UPDATE NOWAIT', [p.id]),
      ).rejects.toMatchObject({ code: '55P03' });
      const createOtherRunner = reader.createQueryRunner.bind(reader);
      jest.spyOn(reader, 'createQueryRunner').mockImplementation((mode) => {
        const runner = createOtherRunner(mode);
        const query = runner.query.bind(runner);
        jest
          .spyOn(runner, 'query')
          .mockImplementation(async (sql: string, parameters?: unknown[], structured?: boolean) => {
            trace.push(sql);
            const result = structured ? query(sql, parameters, true) : query(sql, parameters);
            if (
              runner.isTransactionActive &&
              /^SELECT/.test(sql) &&
              sql.includes('"memory_projects"')
            ) {
              // SQL已交给真实驱动，再显式握手，不使用sleep或pg_locks轮询猜时序。
              await competingRead.pause();
            }
            return result;
          });
        return runner;
      });
      const mutation = capture(
        other.projects.update(ACTOR, p.id, { engineWorkspaceId: 'workspace-b' }),
      );
      await reached(competingRead, mutation);
      expect(
        trace.some((sql) => sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')),
      ).toBe(true);
      expect(
        trace.some((sql) => sql.includes('"memory_projects"') && sql.includes('FOR UPDATE')),
      ).toBe(true);
      competingRead.release();
      inserting.release();
      expect((await nomination).error).toBeUndefined();
      expect((await mutation).error).toMatchObject({ status: 409, response: { code: 14002 } });
      expect((await other.projects.findProjectOrThrow(p.id)).engineWorkspaceId).toBe('workspace-a');
    } finally {
      inserting.release();
      competingRead.release();
      await Promise.allSettled(pending);
      await reader.query('RESET default_transaction_isolation');
    }
  });

  it('归档/重新激活只改业务状态，不解除已有账本的数据身份固定', async () => {
    const p = await project();
    const { projects, formation } = harness();
    await ledger(formation, p);
    await projects.update(ACTOR, p.id, { status: 'archived' });
    await projects.update(ACTOR, p.id, { status: 'active' });
    await expect(projects.update(ACTOR, p.id, { engineActorId: 'actor-b' })).rejects.toMatchObject({
      status: 409,
    });
  });
});

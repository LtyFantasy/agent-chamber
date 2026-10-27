/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **提名与形成账本**的服务级单测：提名链路（幂等键预检 → 装配冻结 → 落行 → 提交引擎 →
 *     §7 映射 → 回写 + 遥测）、恢复三通道（`retry` / `recover` / 启动扫描）、
 *     读面（账本列表降级投影 / 详情正文）、更正链接续跑（`completeCorrectionLink`）
 *
 * [代码职责]
 *   - 把"逐态 HTTP 语义由账本态驱动""非 committed 一律不写 ids""alias 镜像 canonical
 *     当前态、无线索落 conflict""系统态写入不顶 updated_at""重放永不重装配"钉成可执行事实
 *
 * [权威文档]
 *   - 判据单源 = `memory-formation.service.ts` 的 [关键不变量] +
 *     `engines/formation-state.mapper.ts` 的 §7 映射表（后者已有自己的逐值单测）
 *
 * [关键不变量]
 *   - **HTTP 状态由账本态驱动**：committed→201 / no_memory→200 / submitted|unknown→202 /
 *     failed→503 / conflict|rejected→409；`hint`/`hintCode` 由子态（recoveryPath/engineCode）
 *     驱动，不由 HTTP 状态一刀切
 *   - **非 committed 一律不写 ids**（含 alias / no_memory / 失败面）——`applyAttempt` 的
 *     裸 SQL 用 `CASE WHEN $6 THEN $7::jsonb ELSE engine_memory_ids END` 承载这条
 *   - **alias 镜像 canonical 行当前态**（含非终态）；**无 canonical 线索 / 查不到 ⇒ conflict**
 *     （fail-safe，绝不落 committed）
 *   - **重放永不重装配**：`retry` / `recover` / 启动扫描一律经 `findForReplay` 取冻结原文
 *   - **系统态写入不顶 `updated_at`**：收敛/回填走裸 SQL，**只有用户动作**走 ORM save/update
 *   - **`recovery_path` 不在账本表上**：扫描排除集必须按"每行最近一次尝试"判（子查询），
 *     且**在 LIMIT 之前**过滤（否则恒错行占满 10 个槽位）
 *   - **启动扫描 fire-and-forget**：失败只 warn，绝不允许阻断应用启动
 *
 * [关联代码]
 *   - ./memory-formation.service.ts — 被测实现
 *   - ./ledger.repository.ts — 重放冻结原文的唯一入口
 *   - ./memory.constants.ts — `buildFormationHint` 与错误构造器（本套件断言其产出）
 *
 * [修改检查]
 *   □ 改 HTTP 语义或 hint 必须同步 e2e ③⑥⑨ 的逐态用例
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { Repository } from 'typeorm';
import {
  ActorType,
  ErrorCode,
  MEMORY_ENGINE,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_PROJECT_STATUS,
  MEMORY_UNAVAILABLE_REASON,
} from '@agent-chamber/shared';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryFormationEvent } from '../../database/entities/memory-formation-event.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import type {
  ActorProfile,
  ActorProfileService,
} from '../../common/services/actor-profile.service';
import { MemoryAccessService } from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryLedgerRepository } from './ledger.repository';
import { MEMORY_RECOVERY_SCAN_LIMIT } from './memory.constants';
import { EXCERPT_AREA_PREFIX } from './memory-content.assembler';
import { MemoryFormationService, type FormationAttemptOutcome } from './memory-formation.service';
import { MEMORY_UNRESUMABLE_RECOVERY_PATHS } from './engines/formation-state.mapper';
import type { MemoryEngine as MemoryEnginePort } from './engines/memory-engine.interface';

const ACTOR_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const LEDGER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OLD_LEDGER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

/** 造一个 agent actor */
function agentActor(): UnifiedActor {
  return { id: ACTOR_ID, type: ActorType.AGENT };
}

/** 造一个 active 且引擎三列齐备的项目 */
function buildProject(overrides: Partial<MemoryProject> = {}): MemoryProject {
  return {
    id: PROJECT_ID,
    slug: 'chamber',
    name: 'Agent Chamber',
    bindings: [{ type: 'board', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    engine: MEMORY_ENGINE.HUMENT,
    engineWorkspaceId: 'ws-1',
    engineActorId: 'act-1',
    engineCredentialRef: 'cred-1',
    status: MEMORY_PROJECT_STATUS.ACTIVE,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as MemoryProject;
}

/** 造一条账本行 */
function buildRow(overrides: Partial<MemoryNomination> = {}): MemoryNomination {
  return {
    id: LEDGER_ID,
    projectId: PROJECT_ID,
    nominatorId: ACTOR_ID,
    nominatorType: ActorType.AGENT,
    category: 'ruling',
    subject: '主体',
    scope: '范围',
    effectiveNote: null,
    content: '冻结正文',
    contentTruncated: false,
    rationale: '冻结理由',
    sourceRefs: [],
    engineNominationId: null,
    engineCanonicalNominationId: null,
    engineJobId: null,
    engineMemoryIds: null,
    formationState: MEMORY_FORMATION_STATE.SUBMITTED,
    deferred: false,
    status: MEMORY_NOMINATION_STATUS.ACTIVE,
    correctionOf: null,
    correctionTargetMemoryId: null,
    engineCorrectionId: null,
    reviewAt: null,
    clientRequestId: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as MemoryNomination;
}

/** 造一次形成尝试的产物 */
function attemptOutcome(overrides: Partial<FormationAttemptOutcome> = {}): FormationAttemptOutcome {
  return {
    formationState: MEMORY_FORMATION_STATE.COMMITTED,
    recoveryPath: null,
    memoryIds: ['mem-1'],
    deferred: false,
    engineNominationId: 'nom-1',
    engineCanonicalNominationId: null,
    signal: {
      duplicate: false,
      deferred: false,
      outcome: 'memory_committed',
      memoryIds: ['mem-1'],
    },
    latencyMs: 7,
    ...overrides,
  };
}

/** 链式 QueryBuilder 替身（覆盖 select/addSelect/where/andWhere/orderBy/limit/getMany/getOne） */
interface ChainQb {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getMany: jest.Mock;
  getOne: jest.Mock;
}

function chainQueryBuilder(rows: unknown[]): ChainQb {
  const qb: Partial<ChainQb> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ] as const) {
    qb[method] = jest.fn().mockReturnThis();
  }
  qb.getMany = jest.fn(async () => rows);
  qb.getOne = jest.fn(async () => rows[0] ?? null);
  return qb as ChainQb;
}

/**
 * 组装被测服务。
 *
 * 所有依赖都是假件：本套件的对象是**编排与判据**（状态→HTTP、不变量、分支顺序），
 * ORM 真语义（jsonb / 部分唯一索引 / 子查询）归 e2e 的真库用例。
 */
function harness(options: {
  project?: Partial<MemoryProject>;
  availability?: { engine: string; available: boolean; reason: string | null };
  engine?: unknown;
  rows?: MemoryNomination[];
  /** 幂等键预检命中（`nominate` 的 replay 分支） */
  existingByKey?: MemoryNomination | null;
  /** `nominations.findOne` 的定制实现（按调用序喂，如 alias 镜像的 canonical 行） */
  findOneImpl?: (options: unknown) => Promise<MemoryNomination | null>;
  /** `ledgerRepository.findForReplay` 的分行实现 */
  replayImpl?: (id: string) => Promise<{ content: string; rationale: string } | null>;
  /**
   * `ActorProfileService.resolveProfiles` 的产出（提名者归属名解析）。
   * 缺省 = 空 Map（等价"所有提名者都是真孤儿" ⇒ 名字 null、deletedAt null）。
   */
  profiles?: Map<string, ActorProfile>;
}) {
  const project = buildProject(options.project ?? {});
  const rows = options.rows ?? [buildRow()];

  const qb = chainQueryBuilder(rows);
  const managerUpdate = jest.fn(async () => undefined);
  // 初次建账与双写都使用同一事务 manager；既有纯单测不替代真实 PG 锁语义。
  const projects = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => project),
    createQueryBuilder: jest.fn(() => chainQueryBuilder([])),
  };
  const manager: any = {
    update: managerUpdate,
    transaction: jest.fn(async (isolationOrRun: unknown, run?: (m: unknown) => Promise<unknown>) =>
      (typeof isolationOrRun === 'function' ? isolationOrRun : run!)(manager),
    ),
    getRepository: jest.fn((entity: unknown) =>
      entity === MemoryProject ? projects : nominations,
    ),
  };
  const nominations = {
    findOne: jest.fn(options.findOneImpl ?? (async () => options.existingByKey ?? null)),
    create: jest.fn((input: Partial<MemoryNomination>) => ({ ...input }) as MemoryNomination),
    save: jest.fn(async (entity: MemoryNomination) => ({
      ...entity,
      id: entity.id ?? LEDGER_ID,
      createdAt: entity.createdAt ?? new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: entity.updatedAt ?? new Date('2026-10-01T00:00:00.000Z'),
    })),
    // 系统态写入（收敛 / ids 回填 / 撤回）一律走裸 SQL，本套件断言的就是这条
    query: jest.fn(async () => undefined),
    createQueryBuilder: jest.fn(() => qb),
    manager,
  };

  const formationEvents = {
    create: jest.fn((payload: unknown) => payload),
    save: jest.fn(async (payload: unknown) => payload),
    count: jest.fn(async () => 0),
    query: jest.fn(async () => [] as unknown[]),
  };

  const engine =
    options.engine === null
      ? null
      : (options.engine ?? {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: true,
            value: {
              engineNominationId: 'nom-1',
              duplicate: false,
              deferred: false,
              outcome: 'memory_committed',
              memoryIds: ['mem-1'],
              durable: true,
            },
          })),
          inspectCorrection: jest.fn(async () => ({
            ok: false,
            failure: { kind: 'http', httpStatus: 404, message: 'not found', latencyMs: 4 },
          })),
          correct: jest.fn(async () => ({
            ok: true,
            value: { engineCorrectionId: 'corr-1', replay: false },
          })),
        });

  const access = {
    assertProjectWrite: jest.fn(async () => undefined),
    assertProjectRead: jest.fn(async () => ({
      readable: true,
      writable: true,
      isGovernanceViewer: false,
      resolved: [],
    })),
    evaluateSourceRefs: jest.fn(async (_actor: unknown, refs: unknown[]) =>
      refs.map(() => ({ visible: true, currentVersionHash: null as string | null })),
    ),
  };

  const projectService = {
    findProjectOrThrow: jest.fn(async () => project),
    engineAvailability: jest.fn(
      (_target: MemoryProject) =>
        options.availability ?? { engine: MEMORY_ENGINE.HUMENT, available: true, reason: null },
    ),
  };

  const ledgerRepository = {
    findForReplay: jest.fn(async (id: string) =>
      options.replayImpl
        ? options.replayImpl(id)
        : {
            id,
            projectId: PROJECT_ID,
            content: '冻结正文',
            rationale: '冻结理由',
            category: 'ruling',
          },
    ),
  };

  const simpleRepo = () => ({ find: jest.fn(async () => []), findOne: jest.fn(async () => null) });

  // 提名者归属名解析（**批量**）：本套件断言的是"调用一次、结果怎么落到投影"，
  // ActorProfileService 自身的 withDeleted+addSelect / 名回退链由其自己的套件守护
  const actorProfiles = {
    resolveProfiles: jest.fn(async (ids: string[]) => {
      const resolved = new Map<string, ActorProfile>();
      for (const id of ids) {
        const profile = options.profiles?.get(id);
        if (profile) resolved.set(id, profile);
      }
      return resolved;
    }),
  };

  const service = new MemoryFormationService(
    projects as unknown as Repository<MemoryProject>,
    nominations as unknown as Repository<MemoryNomination>,
    formationEvents as unknown as Repository<MemoryFormationEvent>,
    simpleRepo() as unknown as Repository<Doc>,
    simpleRepo() as unknown as Repository<DocSection>,
    simpleRepo() as unknown as Repository<Message>,
    simpleRepo() as unknown as Repository<Task>,
    simpleRepo() as unknown as Repository<TaskComment>,
    access as unknown as MemoryAccessService,
    projectService as unknown as MemoryProjectService,
    ledgerRepository as unknown as MemoryLedgerRepository,
    actorProfiles as unknown as ActorProfileService,
    engine as unknown as MemoryEnginePort | null,
  );

  return {
    service,
    project,
    rows,
    qb,
    nominations,
    formationEvents,
    engine,
    access,
    projectService,
    ledgerRepository,
    managerUpdate,
    actorProfiles,
  };
}

/** 提名入参（contentOverride 路径：本套件不重测装配契约，只验链路） */
function nominateDto(overrides: Record<string, unknown> = {}) {
  return {
    category: 'ruling',
    subject: '主体',
    scope: '范围',
    rationale: '理由',
    contentOverride: '正文',
    ...overrides,
  } as never;
}

describe('MemoryFormationService（提名与形成账本）', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 引擎目标与闸门
  // ══════════════════════════════════════════════════════════════════════
  describe('engineTarget（目标全部来自注册表）', () => {
    it('三列缺一 ⇒ 503/14000 project_engine_unbound（不由本层派生 workspace）', () => {
      const { service } = harness({ project: { engineWorkspaceId: null } });

      expect(() => service.engineTarget(buildProject({ engineWorkspaceId: null }))).toThrow();
      try {
        service.engineTarget(buildProject({ engineActorId: '' }));
      } catch (error) {
        expect(error).toMatchObject({
          status: 503,
          response: { data: { reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND } },
        });
      }
    });

    it('三列齐备 ⇒ 逐列取自项目注册表', () => {
      const { service } = harness({});
      expect(service.engineTarget(buildProject())).toEqual({
        workspaceId: 'ws-1',
        actorId: 'act-1',
        credentialRef: 'cred-1',
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // nominate
  // ══════════════════════════════════════════════════════════════════════
  describe('nominate', () => {
    it('归档项目 ⇒ 409/14002（写路径关闭；读面仍开放）', async () => {
      const { service, nominations } = harness({
        project: { status: MEMORY_PROJECT_STATUS.ARCHIVED },
      });

      await expect(service.nominate(agentActor(), PROJECT_ID, nominateDto())).rejects.toMatchObject(
        {
          status: 409,
          response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
        },
      );
      expect(nominations.save).not.toHaveBeenCalled();
    });

    it('引擎不可用 ⇒ 503/14000 project_engine_unbound（**不落账本行**）', async () => {
      const { service, nominations, engine } = harness({
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(service.nominate(agentActor(), PROJECT_ID, nominateDto())).rejects.toMatchObject(
        {
          status: 503,
          response: {
            code: ErrorCode.MEMORY_UNAVAILABLE,
            data: { reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND },
          },
        },
      );
      expect(nominations.save).not.toHaveBeenCalled();
      expect((engine as { nominate: jest.Mock }).nominate).not.toHaveBeenCalled();
    });

    it('幂等键命中既有行 ⇒ replay=true，**不二次形成**（也不落新行）', async () => {
      const existing = buildRow({
        id: 'led-existing',
        formationState: MEMORY_FORMATION_STATE.COMMITTED,
        engineMemoryIds: ['mem-old'],
      });
      const { service, nominations, formationEvents, engine } = harness({
        existingByKey: existing,
      });
      formationEvents.query.mockResolvedValueOnce([
        { ledger_id: 'led-existing', recovery_path: 'same_key_resend', diagnostics: null },
      ]);

      const result = await service.nominate(
        agentActor(),
        PROJECT_ID,
        nominateDto({ clientRequestId: 'key-1' }),
      );

      expect(result.httpStatus).toBe(201); // 账本态 = committed ⇒ 201
      expect(result.body.replay).toBe(true);
      expect(result.body.ledgerId).toBe('led-existing');
      expect(nominations.save).not.toHaveBeenCalled();
      expect((engine as { nominate: jest.Mock }).nominate).not.toHaveBeenCalled();
    });

    it('replay 的 409 与首次响应**同形**：data.engineDiagnostics 取自同一次尝试', async () => {
      const existing = buildRow({
        id: 'led-existing',
        formationState: MEMORY_FORMATION_STATE.CONFLICT,
      });
      const { service, formationEvents } = harness({ existingByKey: existing });
      formationEvents.query.mockResolvedValueOnce([
        {
          ledger_id: 'led-existing',
          recovery_path: null,
          diagnostics: { admissionCause: 'quota_exceeded', requestId: 'req-first' },
        },
      ]);

      let response: { data?: Record<string, unknown> } | undefined;
      try {
        await service.nominate(agentActor(), PROJECT_ID, nominateDto({ clientRequestId: 'key-1' }));
      } catch (error) {
        response = (error as { response?: { data?: Record<string, unknown> } }).response;
      }

      expect(response?.data?.hintCode).toBe('conflict_quota_exceeded');
      expect(response?.data?.engineDiagnostics).toEqual({
        admissionCause: 'quota_exceeded',
        requestId: 'req-first',
      });
    });

    it('幂等查询**必须带 projectId**：同 actor 在别项目用过的 key 不得命中本项目的行', async () => {
      const { service, nominations } = harness({ existingByKey: null });

      await service.nominate(agentActor(), PROJECT_ID, nominateDto({ clientRequestId: 'key-1' }));

      const where = (nominations.findOne as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({
        projectId: PROJECT_ID,
        nominatorId: ACTOR_ID,
        clientRequestId: 'key-1',
      });
    });

    it('committed ⇒ 201 + 采纳 ids；引擎收到的载荷 = 冻结正文 + 账本 id 派生键', async () => {
      const { service, engine, formationEvents, nominations } = harness({});

      const result = await service.nominate(agentActor(), PROJECT_ID, nominateDto());

      expect(result.httpStatus).toBe(201);
      expect(result.body.formationState).toBe(MEMORY_FORMATION_STATE.COMMITTED);
      expect(result.body.engineMemoryIds).toEqual(['mem-1']);
      expect(result.body.hintCode).toBe('committed');

      const nominate = (engine as { nominate: jest.Mock }).nominate;
      const [target, input] = nominate.mock.calls[0];
      expect(target).toEqual({ workspaceId: 'ws-1', actorId: 'act-1', credentialRef: 'cred-1' });
      expect(input).toMatchObject({
        ledgerId: LEDGER_ID, // 幂等键 `chamber-<账本id>` 的来源
        category: 'ruling',
        content: '正文',
        rationale: '理由',
        sourceLocators: [],
      });

      // 遥测每尝试一行，且 outcome 记**引擎原始信号**（不是归一化后的 formation_state）
      expect(formationEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          ledgerId: LEDGER_ID,
          outcome: 'memory_committed',
          retryCount: 0,
          quotaConsumed: true,
          inputTokens: null, // 一期引擎未回传用量——禁写 0
          outputTokens: null,
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // applyAttempt：非 committed 不写 ids（裸 SQL 承载）
  // ══════════════════════════════════════════════════════════════════════
  describe('applyAttempt（不变量：非 committed 一律不写 ids）', () => {
    it.each([
      ['no_memory', MEMORY_FORMATION_STATE.NO_MEMORY, ['should-be-dropped']],
      ['submitted', MEMORY_FORMATION_STATE.SUBMITTED, ['should-be-dropped']],
      ['conflict', MEMORY_FORMATION_STATE.CONFLICT, ['should-be-dropped']],
    ])('%s ⇒ 裸 SQL 的 ids 位为 false / 值为 null，内存行不被改写', async (_label, state, ids) => {
      const { service, nominations, project } = harness({});
      const row = buildRow({ engineMemoryIds: ['mem-prev'] });

      await service.applyAttempt(
        project,
        row,
        attemptOutcome({
          formationState: state as MemoryNomination['formationState'],
          memoryIds: ids,
        }),
        1,
      );

      const [sql, params] = (nominations.query as jest.Mock).mock.calls[0];
      expect(sql).toContain('CASE WHEN $6::boolean THEN $7::jsonb ELSE engine_memory_ids END');
      expect(params[5]).toBe(false);
      expect(params[6]).toBeNull();
      expect(row.engineMemoryIds).toEqual(['mem-prev']); // 内存态也没被顶掉
      expect(row.formationState).toBe(state);
      // 系统态写入走裸 SQL（不顶 updated_at）：ORM 的 save 一次都不该出现
      expect(nominations.save).not.toHaveBeenCalled();
    });

    it('committed ⇒ 写 ids + 内存态同步（响应直接用，省一次读）', async () => {
      const { service, nominations, project } = harness({});
      const row = buildRow({ engineMemoryIds: null });

      await service.applyAttempt(
        project,
        row,
        attemptOutcome({ memoryIds: ['mem-a', 'mem-b'] }),
        3,
      );

      const [, params] = (nominations.query as jest.Mock).mock.calls[0];
      expect(params[5]).toBe(true);
      expect(params[6]).toBe(JSON.stringify(['mem-a', 'mem-b']));
      expect(row.engineMemoryIds).toEqual(['mem-a', 'mem-b']);
    });

    it('遥测 quotaConsumed 与失败分类同口径：timeout/unreachable=false，http/invalid_response=true', async () => {
      const { service, formationEvents, project } = harness({});

      await service.applyAttempt(
        project,
        buildRow(),
        attemptOutcome({
          formationState: MEMORY_FORMATION_STATE.UNKNOWN,
          memoryIds: [],
          recoveryPath: 'same_key_resend',
          signal: { duplicate: false, deferred: false, failureKind: 'timeout' },
        }),
        0,
      );
      expect(formationEvents.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ quotaConsumed: false, recoveryPath: 'same_key_resend' }),
      );

      await service.applyAttempt(
        project,
        buildRow(),
        attemptOutcome({
          formationState: MEMORY_FORMATION_STATE.CONFLICT,
          memoryIds: [],
          signal: { duplicate: false, deferred: false, failureKind: 'http', httpStatus: 409 },
        }),
        1,
      );
      expect(formationEvents.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ quotaConsumed: true, retryCount: 1 }),
      );
    });

    it('遥测 diagnostics：有诊断则写对象，没有则 NULL（append-only，无 UPDATE 路径）', async () => {
      const { service, formationEvents, project } = harness({});

      await service.applyAttempt(
        project,
        buildRow(),
        attemptOutcome({
          formationState: MEMORY_FORMATION_STATE.CONFLICT,
          memoryIds: [],
          signal: { duplicate: false, deferred: false, failureKind: 'http', httpStatus: 409 },
          engineDiagnostics: { admissionCause: 'quota_exceeded', requestId: 'req-1' },
        }),
        0,
      );
      expect(formationEvents.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          diagnostics: { admissionCause: 'quota_exceeded', requestId: 'req-1' },
        }),
      );

      await service.applyAttempt(
        project,
        buildRow(),
        attemptOutcome({
          formationState: MEMORY_FORMATION_STATE.UNKNOWN,
          memoryIds: [],
          signal: { duplicate: false, deferred: false, failureKind: 'timeout' },
        }),
        1,
      );
      expect(formationEvents.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ diagnostics: null }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // submitAttempt：§7 映射 + alias 镜像
  // ══════════════════════════════════════════════════════════════════════
  describe('submitAttempt（映射与 alias 镜像）', () => {
    it.each([
      [
        'timeout',
        'timeout',
        MEMORY_FORMATION_STATE.UNKNOWN,
        'same_key_resend',
        MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT,
      ],
      [
        'unreachable',
        'unreachable',
        MEMORY_FORMATION_STATE.FAILED,
        'same_key_resend',
        MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE,
      ],
      [
        'http 409',
        'http',
        MEMORY_FORMATION_STATE.CONFLICT,
        null,
        MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR,
      ],
    ])('失败面 %s ⇒ %s + recovery_path=%s', async (_label, kind, state, recoveryPath, reason) => {
      const { service, engine, project } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: false,
            failure: {
              kind,
              httpStatus: kind === 'http' ? 409 : undefined,
              message: 'x',
              latencyMs: 9,
            },
          })),
        },
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });

      expect(outcome.formationState).toBe(state);
      expect(outcome.recoveryPath).toBe(recoveryPath);
      expect(outcome.memoryIds).toEqual([]); // 失败面永不采纳 ids
      expect(outcome.unavailableReason).toBe(reason);
      expect((engine as { nominate: jest.Mock }).nominate).toHaveBeenCalled();
    });

    it('alias（duplicate=true）⇒ 镜像 canonical 行的**当前态**（含非终态），且不采纳回执 ids', async () => {
      const canonical = buildRow({
        id: 'led-canonical',
        formationState: MEMORY_FORMATION_STATE.SUBMITTED,
      });
      const { service, project, nominations } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: true,
            value: {
              engineNominationId: 'nom-alias',
              canonicalNominationId: 'nom-canonical',
              duplicate: true,
              deferred: false,
              memoryIds: ['must-not-be-adopted'],
              durable: true,
            },
          })),
        },
        findOneImpl: async () => canonical,
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });

      // 镜像的是 canonical 的**当前态**（非终态也要跟着走，才能进扫描集）
      expect(outcome.formationState).toBe(MEMORY_FORMATION_STATE.SUBMITTED);
      expect(outcome.memoryIds).toEqual([]);
      // 查询按 (projectId, engineNominationId) 定位——canonical 必须**在本项目内**
      expect((nominations.findOne as jest.Mock).mock.calls[0][0].where).toMatchObject({
        projectId: PROJECT_ID,
        engineNominationId: 'nom-canonical',
      });
    });

    it('alias 无 canonical 线索 ⇒ conflict（fail-safe，绝不落 committed）', async () => {
      const { service, project, nominations } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: true,
            value: {
              engineNominationId: 'nom-alias',
              duplicate: true,
              deferred: false,
              memoryIds: ['must-not-be-adopted'],
              durable: true,
            },
          })),
        },
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });

      expect(outcome.formationState).toBe(MEMORY_FORMATION_STATE.CONFLICT);
      expect(outcome.memoryIds).toEqual([]);
      expect(nominations.findOne).not.toHaveBeenCalled(); // 无线索就不查、不猜、不建影子行
    });

    it('alias 的 canonical 查不到（不在本项目）⇒ conflict', async () => {
      const { service, project } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: true,
            value: {
              engineNominationId: 'nom-alias',
              canonicalNominationId: 'nom-elsewhere',
              duplicate: true,
              deferred: false,
              memoryIds: [],
              durable: true,
            },
          })),
        },
        findOneImpl: async () => null,
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });

      expect(outcome.formationState).toBe(MEMORY_FORMATION_STATE.CONFLICT);
    });

    it('终拒 200 回执 ⇒ engineDiagnostics 带 reasonCode/errorDetail/failureClass/requestId', async () => {
      const { service, project } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: true,
            value: {
              engineNominationId: 'nom-rejected',
              duplicate: false,
              deferred: false,
              outcome: 'rejected',
              reasonCode: 'provider_rejected',
              errorDetail: 'provider_decision_evidence_missing',
              failureClass: 'terminal_rejection',
              requestId: 'req-reject-1',
              memoryIds: [],
              durable: true,
            },
          })),
        },
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });

      expect(outcome.formationState).toBe(MEMORY_FORMATION_STATE.REJECTED);
      expect(outcome.engineDiagnostics).toEqual({
        engineReasonCode: 'provider_rejected',
        errorDetail: 'provider_decision_evidence_missing',
        failureClass: 'terminal_rejection',
        requestId: 'req-reject-1',
      });
    });

    it('非 rejected/unknown 的成功回执**不采**诊断（即使带了 reasonCode）', async () => {
      const { service, project } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: true,
            value: {
              engineNominationId: 'nom-committed',
              duplicate: false,
              deferred: false,
              outcome: 'memory_committed',
              reasonCode: 'memory_materialized',
              memoryIds: ['mem-1'],
              durable: true,
            },
          })),
        },
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });
      expect(outcome.engineDiagnostics).toBeUndefined();
    });

    it('失败面 409 带 admissionCause ⇒ engineDiagnostics = {admissionCause, requestId}', async () => {
      const { service, project } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: false,
            failure: {
              kind: 'http',
              message: 'stub',
              httpStatus: 409,
              engineCode: 'conflict',
              retryable: false,
              admissionCause: 'prefix_unresolved',
              requestId: 'req-409-1',
              latencyMs: 3,
            },
          })),
        },
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });

      expect(outcome.formationState).toBe(MEMORY_FORMATION_STATE.CONFLICT);
      expect(outcome.engineDiagnostics).toEqual({
        admissionCause: 'prefix_unresolved',
        requestId: 'req-409-1',
      });
    });

    it('无任何引擎诊断 ⇒ **不产对象**（遥测落 NULL、响应不带键）', async () => {
      const { service, project } = harness({
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: false,
            failure: { kind: 'unreachable', message: 'refused', latencyMs: 2 },
          })),
        },
      });

      const outcome = await service.submitAttempt(project, buildRow(), {
        content: 'c',
        rationale: 'r',
        sourceLocators: [],
      });
      expect(outcome.engineDiagnostics).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // toHttpResult：逐态 HTTP 语义 + hint 由子态驱动
  // ══════════════════════════════════════════════════════════════════════
  describe('toHttpResult（账本态驱动 HTTP）', () => {
    it.each([
      [MEMORY_FORMATION_STATE.COMMITTED, 201, 'committed'],
      [MEMORY_FORMATION_STATE.NO_MEMORY, 200, 'no_memory'],
      [MEMORY_FORMATION_STATE.SUBMITTED, 202, 'same_key_resend'],
    ])('%s ⇒ %i 且 hintCode=%s', (state, status, hintCode) => {
      const { service, project } = harness({});
      const result = service.toHttpResult(project, buildRow({ formationState: state }), {
        replay: false,
        recoveryPath: state === MEMORY_FORMATION_STATE.SUBMITTED ? 'same_key_resend' : null,
      });

      expect(result.httpStatus).toBe(status);
      expect(result.body.hintCode).toBe(hintCode);
      expect(result.body.ledgerId).toBe(LEDGER_ID);
    });

    it('committed + oldClaimStatus=still_current（链接未建立）⇒ correction_link_pending + correctionLinkFailure', () => {
      const { service, project } = harness({});
      const result = service.toHttpResult(
        project,
        buildRow({ formationState: MEMORY_FORMATION_STATE.COMMITTED }),
        {
          replay: false,
          recoveryPath: null,
          oldClaimStatus: 'still_current',
          linkFailure: { kind: 'http', engineCode: 'source_access_denied', httpStatus: 403 },
        },
      );

      expect(result.httpStatus).toBe(201); // 新主张确实形成了
      expect(result.body.hintCode).toBe('correction_link_pending');
      expect(result.body.correctionLinkFailure).toEqual({
        kind: 'http',
        engineCode: 'source_access_denied',
        httpStatus: 403,
      });
      // 呈现必须指向真正的续跑通道，且不得再说"没有下一步"（卡 61688768 的错误呈现）
      expect(result.body.hint).toContain('/memory/nominations/:id/retry');
      expect(result.body.hint).not.toContain('Nothing further to do');
    });

    it('committed + oldClaimStatus=superseded ⇒ 仍是 committed 码，且不挂 correctionLinkFailure（防误伤）', () => {
      const { service, project } = harness({});
      const result = service.toHttpResult(
        project,
        buildRow({ formationState: MEMORY_FORMATION_STATE.COMMITTED }),
        {
          replay: false,
          recoveryPath: null,
          oldClaimStatus: 'superseded',
          // 即便误传，也不得挂：该键的语义是"链接失败"，不是"链接成功"的反向断言
          linkFailure: { kind: 'http' },
        },
      );

      expect(result.body.hintCode).toBe('committed');
      expect(result.body.oldClaimStatus).toBe('superseded');
      expect(result.body).not.toHaveProperty('correctionLinkFailure');
    });

    it('failed ⇒ 503/14000 且**带账本 id**（"可能已提交，查详情或 retry"）', () => {
      const { service, project } = harness({});
      expect(() =>
        service.toHttpResult(project, buildRow({ formationState: MEMORY_FORMATION_STATE.FAILED }), {
          replay: false,
          recoveryPath: 'config_invalid',
          engineCode: 'binding_not_found',
          unavailableReason: MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR,
        }),
      ).toThrow(
        expect.objectContaining({
          status: 503,
          response: expect.objectContaining({
            code: ErrorCode.MEMORY_UNAVAILABLE,
            data: expect.objectContaining({
              ledgerId: LEDGER_ID,
              engineCode: 'binding_not_found',
              hintCode: 'config_invalid',
              formationState: MEMORY_FORMATION_STATE.FAILED,
            }),
          }),
        }),
      );
    });

    it('failed 的三种子态给出不同的 hintCode（同样 503，下一步动作不同）', () => {
      const { service, project } = harness({});
      const row = buildRow({ formationState: MEMORY_FORMATION_STATE.FAILED });
      const codeOf = (recoveryPath: string | null, engineCode?: string) => {
        try {
          service.toHttpResult(project, row, {
            replay: false,
            recoveryPath: recoveryPath as never,
            engineCode,
          });
        } catch (error) {
          return (error as { response: { data: { hintCode: string } } }).response.data.hintCode;
        }
        return null;
      };

      expect(codeOf('config_invalid')).toBe('config_invalid'); // 修注册表，重试无效
      expect(codeOf('param_invalid')).toBe('param_invalid'); // 换新 client_request_id
      expect(codeOf('same_key_resend', undefined)).toBe('not_delivered_resend'); // 请求未到达
      expect(codeOf('same_key_resend', 'overloaded')).toBe('same_key_resend'); // 引擎答了错误 ⇒ 稍后同 key 重试
    });

    it('rejected ⇒ 409（勿重试，需 Owner recovery）；conflict ⇒ 409（稍后查详情）', () => {
      const { service, project } = harness({});
      const codeOf = (state: MemoryNomination['formationState']) => {
        try {
          service.toHttpResult(project, buildRow({ formationState: state }), {
            replay: false,
            recoveryPath: null,
          });
        } catch (error) {
          return (error as { response: { data: { hintCode: string } } }).response.data.hintCode;
        }
        return null;
      };

      expect(codeOf(MEMORY_FORMATION_STATE.REJECTED)).toBe('rejected_hub_manual');
      expect(codeOf(MEMORY_FORMATION_STATE.CONFLICT)).toBe('conflict_manual');
    });

    it('unknown(same_key_resend) ⇒ hintCode 恒 outcome_unknown，正文指向 retry 本行', () => {
      const { service, project } = harness({});
      const row = buildRow({ formationState: MEMORY_FORMATION_STATE.UNKNOWN });
      const result = service.toHttpResult(project, row, {
        replay: false,
        recoveryPath: 'same_key_resend',
      });

      expect(result.httpStatus).toBe(202); // 非终态
      expect(result.body.hintCode).toBe('outcome_unknown');
      expect(result.body.hint).toContain('/memory/nominations/:id/retry');
      // 不能把"同 clientRequestId 重发"写成可推进的续跑动作
      expect(result.body.hint).not.toMatch(/same clientRequestId is safe/i);
    });

    it('unknown(hub_manual_required) ⇒ hintCode 仍是 outcome_unknown，正文要求读账本、勿盲重试', () => {
      const { service, project } = harness({});
      const row = buildRow({ formationState: MEMORY_FORMATION_STATE.UNKNOWN });
      const result = service.toHttpResult(project, row, {
        replay: false,
        recoveryPath: 'hub_manual_required',
      });

      expect(result.httpStatus).toBe(202);
      expect(result.body.hintCode).toBe('outcome_unknown');
      expect(result.body.hint).toContain('Do not blind-retry');
      expect(result.body.hint).toContain(`read the ledger row: ${row.id}`);
      // 不可恢复分支不得给出 retry 本行动作
      expect(result.body.hint).not.toContain('/memory/nominations/:id/retry');
    });

    /** 捕获 409/503 的响应体（message + data；本组多用例复用） */
    const captureError = (
      run: () => unknown,
    ): { message: string; data: Record<string, unknown> } => {
      try {
        run();
      } catch (error) {
        const response = (
          error as { response?: { message?: string; data?: Record<string, unknown> } }
        ).response;
        return { message: response?.message ?? '', data: response?.data ?? {} };
      }
      throw new Error('expected toHttpResult to throw');
    };

    it.each([
      // [cause, hintCode, 文案是否给出 retry 本行动作]
      ['prefix_unresolved', 'conflict_prefix_unresolved', true],
      ['quota_exceeded', 'conflict_quota_exceeded', true],
      // exact_content 刻意不给 retry：条件不自愈，重试只会再撞一次
      ['exact_content', 'conflict_exact_content', false],
    ])(
      '409 cause=%s ⇒ hintCode=%s 且 hint 正文指向正确动作',
      (cause, hintCode, expectsRetryRow) => {
        const { service, project } = harness({});
        const { message, data } = captureError(() =>
          service.toHttpResult(
            project,
            buildRow({ formationState: MEMORY_FORMATION_STATE.CONFLICT }),
            {
              replay: false,
              recoveryPath: null,
              engineDiagnostics: { admissionCause: cause, requestId: 'req-409' },
            },
          ),
        );

        expect(data.hintCode).toBe(hintCode);
        expect(data.engineDiagnostics).toEqual({ admissionCause: cause, requestId: 'req-409' });
        const hint = data.hint as string;
        if (expectsRetryRow) {
          expect(hint).toContain('/memory/nominations/:id/retry');
        } else {
          expect(hint).toContain('does not clear on its own');
          expect(hint).not.toContain('/memory/nominations/:id/retry');
        }
        // 任何 409 文案都不得把"同 clientRequestId 重发"写成可推进的动作
        expect(hint).not.toMatch(/same clientRequestId is safe/i);
        // 错误 data 键集穷举（没有扁平诊断槽漏出来）
        expect(Object.keys(data).sort()).toEqual(
          ['engineDiagnostics', 'formationState', 'hint', 'hintCode', 'ledgerId'].sort(),
        );
        // message 是日志/审计面：通用句，不逐因、不预判来源
        expect(message).toContain('CONFLICT state (409)');
        expect(message).toContain('data.engineDiagnostics');
        expect(message).not.toContain('indistinguishable');
      },
    );

    it('submitted ⇒ 202 hint 指向 retry 本行，且不把同 clientRequestId 重发当动作', () => {
      const { service, project } = harness({});
      const result = service.toHttpResult(
        project,
        buildRow({ formationState: MEMORY_FORMATION_STATE.SUBMITTED }),
        { replay: false, recoveryPath: null },
      );

      expect(result.httpStatus).toBe(202);
      expect(result.body.hintCode).toBe('same_key_resend');
      expect(result.body.hint).toContain('/memory/nominations/:id/retry');
      expect(result.body.hint).not.toMatch(/same clientRequestId is safe/i);
    });

    it.each([
      ['无引擎码（请求未到达）', undefined, 'not_delivered_resend'],
      ['有引擎码（引擎答错）', 'overloaded', 'same_key_resend'],
    ])(
      'failed(%s) ⇒ hint 指向 retry 本行，且不把同 clientRequestId 重发当动作',
      (_label, engineCode, hintCode) => {
        const { service, project } = harness({});
        const { data } = captureError(() =>
          service.toHttpResult(
            project,
            buildRow({ formationState: MEMORY_FORMATION_STATE.FAILED }),
            {
              replay: false,
              recoveryPath: 'same_key_resend',
              engineCode,
            },
          ),
        );

        expect(data.hintCode).toBe(hintCode);
        expect(data.hint).toContain('/memory/nominations/:id/retry');
        expect(data.hint).not.toMatch(/same clientRequestId is safe/i);
      },
    );

    it('409 无 cause（或诊断缺席）⇒ 兜底 conflict_manual；缺席时不带 engineDiagnostics 键', () => {
      const { service, project } = harness({});
      const { data } = captureError(() =>
        service.toHttpResult(
          project,
          buildRow({ formationState: MEMORY_FORMATION_STATE.CONFLICT }),
          {
            replay: false,
            recoveryPath: null,
            engineDiagnostics: { requestId: 'req-only' },
          },
        ),
      );
      expect(data.hintCode).toBe('conflict_manual');
      // 只有 requestId 时对象仍在场（它是引擎证据，不是空值）
      expect(data.engineDiagnostics).toEqual({ requestId: 'req-only' });

      const absent = captureError(() =>
        service.toHttpResult(
          project,
          buildRow({ formationState: MEMORY_FORMATION_STATE.CONFLICT }),
          {
            replay: false,
            recoveryPath: null,
          },
        ),
      );
      expect('engineDiagnostics' in absent.data).toBe(false);
    });

    it('rejected ⇒ data.engineDiagnostics 四字段（证据而非动作；hintCode 仍是 rejected_hub_manual）', () => {
      const { service, project } = harness({});
      const { data, message } = captureError(() =>
        service.toHttpResult(
          project,
          buildRow({ formationState: MEMORY_FORMATION_STATE.REJECTED }),
          {
            replay: false,
            recoveryPath: null,
            engineDiagnostics: {
              engineReasonCode: 'provider_rejected',
              errorDetail: 'provider_decision_evidence_missing',
              failureClass: 'terminal_rejection',
              requestId: 'req-1',
            },
          },
        ),
      );

      expect(data.hintCode).toBe('rejected_hub_manual');
      expect(data.engineDiagnostics).toEqual({
        engineReasonCode: 'provider_rejected',
        errorDetail: 'provider_decision_evidence_missing',
        failureClass: 'terminal_rejection',
        requestId: 'req-1',
      });
      expect(message).toContain('REJECTED state (409)');
    });

    it('503 ⇒ data.engineDiagnostics **只含 requestId**（HTTP 错误体没有另外三个键）', () => {
      const { service, project } = harness({});
      const { data } = captureError(() =>
        service.toHttpResult(project, buildRow({ formationState: MEMORY_FORMATION_STATE.FAILED }), {
          replay: false,
          recoveryPath: 'config_invalid',
          engineCode: 'binding_not_found',
          unavailableReason: MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR,
          engineDiagnostics: { requestId: 'req-503' },
        }),
      );

      expect(data.engineDiagnostics).toEqual({ requestId: 'req-503' });
    });

    it('flow 守卫：correct 的 conflict/rejected 文案含撤回语义；nomination 不含', () => {
      const { service, project } = harness({});
      const conflictOf = (flow: 'nomination' | 'correction') =>
        captureError(() =>
          service.toHttpResult(
            project,
            buildRow({ formationState: MEMORY_FORMATION_STATE.CONFLICT }),
            {
              replay: false,
              recoveryPath: null,
              flow,
              engineDiagnostics: { admissionCause: 'prefix_unresolved' },
            },
          ),
        );
      const rejectedOf = (flow: 'nomination' | 'correction') =>
        captureError(() =>
          service.toHttpResult(
            project,
            buildRow({ formationState: MEMORY_FORMATION_STATE.REJECTED }),
            {
              replay: false,
              recoveryPath: null,
              flow,
            },
          ),
        );

      // correct：两条分支都必须点名"已撤回"（行是 withdrawn，retry 是死路）
      expect(conflictOf('correction').data.hint).toMatch(/withdrawn/i);
      expect(conflictOf('correction').data.hint).toContain('NEW clientRequestId');
      expect(conflictOf('correction').message).toContain(
        'withdrawn and the old claim is still current',
      );
      expect(rejectedOf('correction').data.hint).toMatch(/withdrawn/i);

      // nomination：不得出现撤回语义（没有发生撤回这件事）
      expect(conflictOf('nomination').data.hint).not.toMatch(/withdrawn/i);
      expect(rejectedOf('nomination').data.hint).not.toMatch(/withdrawn/i);
    });

    it('flow 守卫：correct 的**非终态**分支不得出现 WITHDRAWN / NEW clientRequestId', () => {
      const { service, project } = harness({});
      /** 非终态里 `failed` 会抛 503（hint 在 data 里），其余返回 202 body——两边都要取到 */
      const hintOf = (state: MemoryNomination['formationState'], recoveryPath: string | null) => {
        try {
          return (
            service.toHttpResult(project, buildRow({ formationState: state }), {
              replay: false,
              recoveryPath: recoveryPath as never,
              flow: 'correction',
            }).body.hint ?? ''
          );
        } catch (error) {
          return (
            (error as { response?: { data?: { hint?: string | null } } }).response?.data?.hint ?? ''
          );
        }
      };

      for (const [state, recoveryPath] of [
        [MEMORY_FORMATION_STATE.SUBMITTED, null],
        [MEMORY_FORMATION_STATE.UNKNOWN, 'same_key_resend'],
        [MEMORY_FORMATION_STATE.FAILED, 'same_key_resend'],
      ] as Array<[MemoryNomination['formationState'], string | null]>) {
        const hint = hintOf(state, recoveryPath);
        expect(hint).not.toMatch(/withdrawn/i);
        expect(hint).not.toContain('NEW clientRequestId');
      }
    });

    it('缺席语义：202 body 无诊断时**不带** engineDiagnostics 键；有诊断时带上', () => {
      const { service, project } = harness({});
      const row = buildRow({ formationState: MEMORY_FORMATION_STATE.SUBMITTED });

      const bare = service.toHttpResult(project, row, {
        replay: false,
        recoveryPath: 'same_key_resend',
      });
      expect('engineDiagnostics' in bare.body).toBe(false);

      const withDiagnostics = service.toHttpResult(project, row, {
        replay: false,
        recoveryPath: 'same_key_resend',
        engineDiagnostics: { failureClass: 'retryable_transient', requestId: 'req-202' },
      });
      expect(withDiagnostics.body.engineDiagnostics).toEqual({
        failureClass: 'retryable_transient',
        requestId: 'req-202',
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // retry
  // ══════════════════════════════════════════════════════════════════════
  describe('retry', () => {
    it.each([
      [MEMORY_NOMINATION_STATUS.WITHDRAWN, 'withdrawn'],
      [MEMORY_NOMINATION_STATUS.SUPERSEDED, 'superseded'],
    ])(
      '行非 active（%s）⇒ 409/14005（否则会写回 ids，击穿 withdrawn ⇒ ids 空）',
      async (status, word) => {
        const { service, engine } = harness({
          findOneImpl: async () => buildRow({ status }),
        });

        await expect(service.retry(agentActor(), LEDGER_ID)).rejects.toMatchObject({
          status: 409,
          response: {
            code: ErrorCode.MEMORY_NOMINATION_CONFLICT,
            message: expect.stringContaining(word),
          },
        });
        expect((engine as { nominate: jest.Mock }).nominate).not.toHaveBeenCalled();
      },
    );

    it('**更正续跑分支在前**：committed + ids 非空 + 无 correction id ⇒ 续跑 correct，不重新提名', async () => {
      const correctionRow = buildRow({
        correctionOf: OLD_LEDGER_ID,
        formationState: MEMORY_FORMATION_STATE.COMMITTED,
        engineMemoryIds: ['mem-new'],
        engineCorrectionId: null,
      });
      const { service, engine } = harness({ findOneImpl: async () => correctionRow });
      const link = jest
        .spyOn(service, 'completeCorrectionLink')
        .mockResolvedValue({ replay: true, oldClaimStatus: 'superseded' });

      const result = await service.retry(agentActor(), LEDGER_ID);

      expect(link).toHaveBeenCalledWith(LEDGER_ID, expect.anything());
      // 重新提名会把一条已撤回/已取代的链再推一遍；续跑走的是 correct
      expect((engine as { nominate: jest.Mock }).nominate).not.toHaveBeenCalled();
      expect(result.body.oldClaimStatus).toBe('superseded');
      expect(result.body.replay).toBe(true);
    });

    it('更正续跑**又失败** ⇒ 响应仍响亮（correction_link_pending + correctionLinkFailure）', async () => {
      const correctionRow = buildRow({
        correctionOf: OLD_LEDGER_ID,
        formationState: MEMORY_FORMATION_STATE.COMMITTED,
        engineMemoryIds: ['mem-new'],
        engineCorrectionId: null,
      });
      const { service } = harness({ findOneImpl: async () => correctionRow });
      jest.spyOn(service, 'completeCorrectionLink').mockResolvedValue({
        replay: false,
        oldClaimStatus: 'still_current',
        linkFailure: { kind: 'http', engineCode: 'source_access_denied', httpStatus: 403 },
      });

      const result = await service.retry(agentActor(), LEDGER_ID);

      // 续跑也不得回 "Nothing further to do"——retry 是真实动作，失败仍要指回它
      expect(result.body.hintCode).toBe('correction_link_pending');
      expect(result.body.correctionLinkFailure).toEqual({
        kind: 'http',
        engineCode: 'source_access_denied',
        httpStatus: 403,
      });
      expect(result.body.hint).toContain('/memory/nominations/:id/retry');
    });

    it('更正续跑吃**落库目标**（首跑中断：行 committed + 无 correction id + 落库目标非主记忆）', async () => {
      // 模拟首跑中断的形态：新行已 committed（记忆已形成）但 correct 未落地；
      // 首跑解析出的**非主记忆**目标只存在于 `correction_target_memory_id` 列上。
      const correctionRow = buildRow({
        id: LEDGER_ID,
        correctionOf: OLD_LEDGER_ID,
        formationState: MEMORY_FORMATION_STATE.COMMITTED,
        engineMemoryIds: ['mem-new'],
        engineCorrectionId: null,
        correctionTargetMemoryId: 'mem-old-2', // ⚠️ 非主记忆（主记忆 = 'mem-old-1'）
      });
      const oldRow = buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: ['mem-old-1', 'mem-old-2'] });
      const { service, engine } = harness({
        // 按 id 分流：retry 与 completeCorrectionLink 都会重取这两行（多次 findOne）
        findOneImpl: async (options: unknown) => {
          const id = (options as { where?: { id?: string } })?.where?.id;
          return id === OLD_LEDGER_ID ? oldRow : correctionRow;
        },
        engine: {
          name: 'fake',
          nominate: jest.fn(), // 断言"没被调用"用（续跑不该重新提名）
          inspectCorrection: jest.fn(async () => ({
            ok: false,
            failure: { kind: 'http', httpStatus: 404, message: 'x', latencyMs: 3 },
          })),
          correct: jest.fn(async () => ({
            ok: true,
            value: { engineCorrectionId: 'corr-resumed', replay: false },
          })),
        },
      });

      const result = await service.retry(agentActor(), LEDGER_ID);

      // ⚠️ 欠账的回归守卫：续跑必须打到 mem-old-2（落库值），而不是回退到主记忆 mem-old-1
      expect((engine as { correct: jest.Mock }).correct).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ oldMemoryId: 'mem-old-2', newMemoryId: 'mem-new' }),
      );
      // 续跑不重新提名（重新提名会把已形成的链再推一遍）
      expect((engine as { nominate: jest.Mock }).nominate).not.toHaveBeenCalled();
      expect(result.body.oldClaimStatus).toBe('superseded');
    });

    it('普通续跑：用 findForReplay 的**冻结原文**（不重装配），retryCount 来自遥测行数', async () => {
      const failedRow = buildRow({ formationState: MEMORY_FORMATION_STATE.FAILED });
      const { service, engine, formationEvents, nominations } = harness({
        findOneImpl: async () => failedRow,
      });
      formationEvents.count.mockResolvedValueOnce(2);

      await service.retry(agentActor(), LEDGER_ID);

      const [, input] = (engine as { nominate: jest.Mock }).nominate.mock.calls[0];
      expect(input).toMatchObject({ content: '冻结正文', rationale: '冻结理由' });
      expect(formationEvents.count).toHaveBeenCalledWith({ where: { ledgerId: LEDGER_ID } });
      // 第 3 次尝试（0 起算的 retry_count = 2）
      expect((nominations.query as jest.Mock).mock.calls[0][1][0]).toBe(LEDGER_ID);
    });

    it('冻结原文查不到（行已软删）⇒ 404/14003，不发起引擎调用', async () => {
      const { service, engine } = harness({
        findOneImpl: async () => buildRow({ formationState: MEMORY_FORMATION_STATE.FAILED }),
        replayImpl: async () => null,
      });

      await expect(service.retry(agentActor(), LEDGER_ID)).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND },
      });
      expect((engine as { nominate: jest.Mock }).nominate).not.toHaveBeenCalled();
    });

    it('归档项目 ⇒ 409/14002（续跑属写路径）', async () => {
      const { service } = harness({
        project: { status: MEMORY_PROJECT_STATUS.ARCHIVED },
        findOneImpl: async () => buildRow(),
      });

      await expect(service.retry(agentActor(), LEDGER_ID)).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // completeCorrectionLink（双写 + inspect 只读判态）
  // ══════════════════════════════════════════════════════════════════════
  describe('completeCorrectionLink', () => {
    it('新行不是更正行 ⇒ 409/14005（不该被这条路径消费）', async () => {
      const { service } = harness({ findOneImpl: async () => buildRow({ correctionOf: null }) });

      await expect(service.completeCorrectionLink(LEDGER_ID, buildProject())).rejects.toMatchObject(
        {
          status: 409,
          response: { code: ErrorCode.MEMORY_NOMINATION_CONFLICT },
        },
      );
    });

    it('新行尚无引擎记忆 id ⇒ 409（引擎只能链接两个**已形成**的记忆）', async () => {
      const { service } = harness({
        findOneImpl: async () => buildRow({ correctionOf: OLD_LEDGER_ID, engineMemoryIds: [] }),
      });

      await expect(service.completeCorrectionLink(LEDGER_ID, buildProject())).rejects.toMatchObject(
        {
          status: 409,
        },
      );
    });

    it('旧行无引擎记忆 id ⇒ 409（无可更正对象）', async () => {
      const calls = [
        buildRow({ correctionOf: OLD_LEDGER_ID, engineMemoryIds: ['mem-new'] }),
        buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: null }),
      ];
      let index = 0;
      const { service } = harness({ findOneImpl: async () => calls[index++] ?? null });

      await expect(service.completeCorrectionLink(LEDGER_ID, buildProject())).rejects.toMatchObject(
        {
          status: 409,
        },
      );
    });

    it('inspect 命中 ⇒ replay=true（"早已落库"），仍双写（幂等）', async () => {
      const calls = [
        buildRow({ correctionOf: OLD_LEDGER_ID, engineMemoryIds: ['mem-new'] }),
        buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: ['mem-old'] }),
      ];
      let index = 0;
      const { service, engine, managerUpdate } = harness({
        findOneImpl: async () => calls[index++] ?? null,
        engine: {
          name: 'fake',
          inspectCorrection: jest.fn(async () => ({
            ok: true,
            value: { engineCorrectionId: 'corr-known' },
          })),
          correct: jest.fn(),
        },
      });

      const link = await service.completeCorrectionLink(LEDGER_ID, buildProject());

      expect(link).toEqual({ replay: true, oldClaimStatus: 'superseded' });
      // inspect 只读判态 —— 已达成就不该再调 correct
      expect((engine as { correct: jest.Mock }).correct).not.toHaveBeenCalled();
      expect(managerUpdate).toHaveBeenCalledWith(
        MemoryNomination,
        { id: LEDGER_ID },
        { engineCorrectionId: 'corr-known' },
      );
      expect(managerUpdate).toHaveBeenCalledWith(
        MemoryNomination,
        { id: OLD_LEDGER_ID },
        { status: MEMORY_NOMINATION_STATUS.SUPERSEDED },
      );
    });

    it('inspect 未命中 ⇒ 调 correct；成功则双写（新行记 correction id），replay 取回执', async () => {
      const calls = [
        buildRow({ correctionOf: OLD_LEDGER_ID, engineMemoryIds: ['mem-new'] }),
        buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: ['mem-old-1', 'mem-old-2'] }),
      ];
      let index = 0;
      const { service, engine, managerUpdate } = harness({
        findOneImpl: async () => calls[index++] ?? null,
        engine: {
          name: 'fake',
          inspectCorrection: jest.fn(async () => ({
            ok: false,
            failure: { kind: 'http', httpStatus: 404, message: 'x', latencyMs: 3 },
          })),
          correct: jest.fn(async () => ({
            ok: true,
            value: { engineCorrectionId: 'corr-new', replay: false },
          })),
        },
      });

      const link = await service.completeCorrectionLink(LEDGER_ID, buildProject(), 'mem-old-2');

      expect(link).toEqual({ replay: false, oldClaimStatus: 'superseded' });
      // 显式指定的 oldMemoryId 必须**透传**（它可能不是旧行主记忆）
      expect((engine as { correct: jest.Mock }).correct).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ oldMemoryId: 'mem-old-2', newMemoryId: 'mem-new' }),
      );
      expect(managerUpdate).toHaveBeenCalledWith(
        MemoryNomination,
        { id: LEDGER_ID },
        { engineCorrectionId: 'corr-new' },
      );
    });

    // ─── 更正目标三优先级回退链（直传 > 落库 > 旧行主记忆） ───

    /** 造一条"inspect 未命中 + correct 成功"的引擎替身（回退链三条用例共用） */
    function correctingEngine() {
      return {
        name: 'fake',
        inspectCorrection: jest.fn(async () => ({
          ok: false,
          failure: { kind: 'http', httpStatus: 404, message: 'x', latencyMs: 3 },
        })),
        correct: jest.fn(async () => ({
          ok: true,
          value: { engineCorrectionId: 'corr-new', replay: false },
        })),
      };
    }

    it('调用方**直传**优先于落库值（首跑：DTO 是唯一事实源）', async () => {
      const calls = [
        buildRow({
          correctionOf: OLD_LEDGER_ID,
          engineMemoryIds: ['mem-new'],
          correctionTargetMemoryId: 'mem-old-2',
        }),
        buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: ['mem-old-1', 'mem-old-2'] }),
      ];
      let index = 0;
      const { service, engine } = harness({
        findOneImpl: async () => calls[index++] ?? null,
        engine: correctingEngine(),
      });

      await service.completeCorrectionLink(LEDGER_ID, buildProject(), 'mem-old-1');

      expect((engine as { correct: jest.Mock }).correct).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ oldMemoryId: 'mem-old-1' }),
      );
    });

    it('**落库值**优先于旧行主记忆（续跑：retry 拿不到 DTO，只能读账本）', async () => {
      const calls = [
        buildRow({
          correctionOf: OLD_LEDGER_ID,
          engineMemoryIds: ['mem-new'],
          correctionTargetMemoryId: 'mem-old-2', // 非主记忆
        }),
        buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: ['mem-old-1', 'mem-old-2'] }),
      ];
      let index = 0;
      const { service, engine } = harness({
        findOneImpl: async () => calls[index++] ?? null,
        engine: correctingEngine(),
      });

      // 不传第三参 = 续跑形态
      await service.completeCorrectionLink(LEDGER_ID, buildProject());

      // ⚠️ 这里是欠账的回归守卫：缺了中间一级，收到的会是 'mem-old-1'（静默打错目标）
      expect((engine as { correct: jest.Mock }).correct).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ oldMemoryId: 'mem-old-2' }),
      );
    });

    it('落库值为 NULL（列后加的旧行）⇒ 末级兜底仍是旧行主记忆（不因新列而 409）', async () => {
      const calls = [
        buildRow({
          correctionOf: OLD_LEDGER_ID,
          engineMemoryIds: ['mem-new'],
          correctionTargetMemoryId: null,
        }),
        buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: ['mem-old-1', 'mem-old-2'] }),
      ];
      let index = 0;
      const { service, engine } = harness({
        findOneImpl: async () => calls[index++] ?? null,
        engine: correctingEngine(),
      });

      await service.completeCorrectionLink(LEDGER_ID, buildProject());

      expect((engine as { correct: jest.Mock }).correct).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ oldMemoryId: 'mem-old-1' }),
      );
    });

    it('inspect 未命中 + correct 失败 ⇒ 不双写，still_current **并回填 linkFailure**（失败证据必须上行）', async () => {
      const calls = [
        buildRow({ correctionOf: OLD_LEDGER_ID, engineMemoryIds: ['mem-new'] }),
        buildRow({ id: OLD_LEDGER_ID, engineMemoryIds: ['mem-old'] }),
      ];
      let index = 0;
      const { service, managerUpdate } = harness({
        findOneImpl: async () => calls[index++] ?? null,
        engine: {
          name: 'fake',
          inspectCorrection: jest.fn(async () => ({
            ok: false,
            failure: { kind: 'http', httpStatus: 404, message: 'x', latencyMs: 3 },
          })),
          // 生产实证形态：缺 runtime_private_write ⇒ 引擎 authorization 阶段 403
          correct: jest.fn(async () => ({
            ok: false,
            failure: {
              kind: 'http',
              httpStatus: 403,
              engineCode: 'source_access_denied',
              message: 'denied',
              latencyMs: 5,
            },
          })),
        },
      });

      const link = await service.completeCorrectionLink(LEDGER_ID, buildProject());

      // 只打 warn 而不回传 = 响应又会退回"静默 still_current"（卡 61688768）
      expect(link).toEqual({
        replay: false,
        oldClaimStatus: 'still_current',
        linkFailure: { kind: 'http', engineCode: 'source_access_denied', httpStatus: 403 },
      });
      expect(managerUpdate).not.toHaveBeenCalled(); // 双写事务没开
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 恢复通道
  // ══════════════════════════════════════════════════════════════════════
  describe('recover / resumeProject', () => {
    it('候选行按冻结原文有无分流：无 ⇒ skipped，有 ⇒ resent（计数一致）', async () => {
      const candidates = [buildRow({ id: 'led-no-replay' }), buildRow({ id: 'led-ok' })];
      const { service, qb, ledgerRepository, project } = harness({ rows: candidates });
      ledgerRepository.findForReplay.mockImplementation(async (id: string) =>
        id === 'led-no-replay'
          ? null
          : { id, projectId: PROJECT_ID, content: 'c', rationale: 'r', category: 'ruling' },
      );

      const summary = await service.resumeProject(project, MEMORY_RECOVERY_SCAN_LIMIT);

      expect(summary).toMatchObject({ scanned: 2, resumed: 1, skipped: 1 });
      expect(summary.items.map((item) => item.action)).toEqual(['skipped', 'resent']);
      // 扫描上界是**闸门**（防一次扫描烧光配额）
      expect(qb.limit).toHaveBeenCalledWith(MEMORY_RECOVERY_SCAN_LIMIT);
    });

    it('items[].admissionCause：resent 行如实带出本次 409 因（`resent` ≠ 有进展）', async () => {
      const { service, project } = harness({
        rows: [buildRow({ id: 'led-quota' })],
        engine: {
          name: 'fake',
          nominate: jest.fn(async () => ({
            ok: false,
            failure: {
              kind: 'http',
              message: 'stub',
              httpStatus: 409,
              engineCode: 'conflict',
              retryable: false,
              admissionCause: 'quota_exceeded',
              requestId: 'req-recover-1',
              latencyMs: 3,
            },
          })),
        },
      });

      const summary = await service.resumeProject(project, MEMORY_RECOVERY_SCAN_LIMIT);

      expect(summary.items[0]).toMatchObject({
        ledgerId: 'led-quota',
        action: 'resent',
        formationState: MEMORY_FORMATION_STATE.CONFLICT,
        admissionCause: 'quota_exceeded',
      });
    });

    it('扫描集合：active ∧ 非终态 ∧ **最近一次** recovery_path ∉ 排除集（且排除在 LIMIT 之前）', async () => {
      const { service, qb, project } = harness({ rows: [] });

      await service.resumeProject(project, MEMORY_RECOVERY_SCAN_LIMIT);

      const clauses = (qb.andWhere as jest.Mock).mock.calls.map((call) => call[0] as string);
      const params = (qb.andWhere as jest.Mock).mock.calls.map((call) => call[1]);
      expect(clauses.some((clause) => clause.includes('nomination.status = :status'))).toBe(true);
      expect(clauses.some((clause) => clause.includes('formation_state IN'))).toBe(true);
      // `recovery_path` 不在账本表上 ⇒ 必须走 memory_formation_events 的相关子查询（DISTINCT ON）
      const notExists = clauses.find((clause) => clause.includes('NOT EXISTS'));
      expect(notExists).toContain('DISTINCT ON (ev.ledger_id)');
      expect(params.find((param) => param?.excludedPaths)?.excludedPaths).toEqual([
        ...MEMORY_UNRESUMABLE_RECOVERY_PATHS,
      ]);
    });

    it('recover 归档项目 ⇒ 409/14002', async () => {
      const { service } = harness({ project: { status: MEMORY_PROJECT_STATUS.ARCHIVED } });

      await expect(service.recover(agentActor(), PROJECT_ID)).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
    });

    it('recover 引擎不可用 ⇒ 503/14000（不扫空转）', async () => {
      const { service } = harness({
        availability: {
          engine: MEMORY_ENGINE.HUMENT,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(service.recover(agentActor(), PROJECT_ID)).rejects.toMatchObject({
        status: 503,
        response: { code: ErrorCode.MEMORY_UNAVAILABLE },
      });
    });
  });

  describe('runStartupScan / onApplicationBootstrap', () => {
    it('引擎 token 为 null ⇒ 直接返回 {0,0}（连项目都不查）', async () => {
      const { service } = harness({ engine: null });
      await expect(service.runStartupScan()).resolves.toEqual({ scanned: 0, resumed: 0 });
    });

    it('只扫"引擎可用"的项目（未绑引擎的项目不进扫描集）', async () => {
      const bound = buildProject({ id: 'prj-bound' });
      const unbound = buildProject({ id: 'prj-unbound', engine: MEMORY_ENGINE.NONE });
      const { service, projectService } = harness({});
      const projectsRepo = (service as unknown as { projects: { find: jest.Mock } }).projects;
      projectsRepo.find.mockResolvedValue([bound, unbound]);
      projectService.engineAvailability.mockImplementation((target: MemoryProject) =>
        target.id === 'prj-bound'
          ? { engine: MEMORY_ENGINE.HUMENT, available: true, reason: null }
          : {
              engine: MEMORY_ENGINE.NONE,
              available: false,
              reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
            },
      );
      const resume = jest.spyOn(service, 'resumeProject').mockResolvedValue({
        scanned: 1,
        resumed: 1,
        skipped: 0,
        items: [],
      });

      const summary = await service.runStartupScan();

      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledWith(bound, MEMORY_RECOVERY_SCAN_LIMIT);
      expect(summary).toEqual({ scanned: 1, resumed: 1 });
    });

    it('启动扫描是 **fire-and-forget**：同步返回，扫描失败不抛出（memory 是可选增强）', async () => {
      const { service } = harness({});
      const scan = jest.spyOn(service, 'runStartupScan').mockRejectedValue(new Error('boom'));

      // 同步返回 = 不阻塞应用启动（memory 是可选增强）
      expect(service.onApplicationBootstrap()).toBeUndefined();
      // 冲刷微任务：失败只打 warn，绝不变成 unhandled rejection
      await new Promise((resolve) => setImmediate(resolve));
      expect(scan).toHaveBeenCalled();
    });

    it('引擎缺席时启动扫描**根本不发起**', () => {
      const { service } = harness({ engine: null });
      const scan = jest.spyOn(service, 'runStartupScan');
      service.onApplicationBootstrap();
      expect(scan).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 读面：账本列表（降级投影）与详情
  // ══════════════════════════════════════════════════════════════════════
  describe('listNominations / getNomination', () => {
    it('降级投影：绑定全不可读 ⇒ metadata 档，内容面字段**整个键缺席**（不是 null）', async () => {
      const { service, access, qb } = harness({ rows: [buildRow()] });
      access.assertProjectRead.mockResolvedValueOnce({
        readable: false,
        writable: false,
        isGovernanceViewer: true,
        resolved: [],
      });

      const result = await service.listNominations(agentActor(), PROJECT_ID, {});

      expect(result.items[0].projection).toBe('metadata');
      // 键集穷举（响应契约无 swagger schema，唯一的字段面守卫）
      expect(Object.keys(result.items[0]).sort()).toEqual([
        'category',
        'correctionOf',
        'createdAt',
        'formationState',
        'id',
        'nominatorDeletedAt',
        'nominatorId',
        'nominatorName',
        'nominatorType',
        'projectId',
        'projection',
        'reviewAt',
        'status',
        'updatedAt',
      ]);
      // 二期放宽的四键**在 metadata 档就有值**（治理面要能归项目 / 画取代边 / 显示归属）
      expect(result.items[0]).toMatchObject({
        projectId: PROJECT_ID,
        correctionOf: null,
        nominatorName: null, // 缺省 profiles 为空 Map ⇒ 真孤儿形态
        nominatorDeletedAt: null,
      });
      // 内容面（含摘要）在 metadata 档**整个键缺席**——不是 null，`in` 判定必须能区分
      expect('contentExcerpt' in result.items[0]).toBe(false);
      expect('contentTruncated' in result.items[0]).toBe(false);
      // **门控守卫**：metadataOnly ⇒ 一行正文都不取（治理观察者不该为摘要付全量正文 IO）
      expect(qb.addSelect).not.toHaveBeenCalled();
    });

    it('完整投影：可读 + 全源可见 ⇒ 带主张三要素、来源投影、引擎 id 与卡片摘要', async () => {
      const row = buildRow({
        // 真实形态的正文（有锚点 ⇒ 摘要走"取摘录区"分支）
        content: `[ruling] 主体\n范围: 范围\n理由: 冻结理由\n${EXCERPT_AREA_PREFIX}- [chamber://doc/doc-1] 摘要正文`,
        sourceRefs: [{ type: 'doc', id: 'doc-1' }],
      });
      const { service, qb } = harness({ rows: [row] });

      const result = await service.listNominations(agentActor(), PROJECT_ID, {});

      expect(result.items[0]).toMatchObject({
        projection: 'full',
        subject: '主体',
        engineMemoryIds: [],
        sources: [{ type: 'doc', locator: 'chamber://doc/doc-1' }],
      });
      // 列表**不**带正文（正文只在详情给），但**带摘要**（二期 D1②：为它门控 addSelect）
      expect(result.items[0].content).toBeUndefined();
      expect(result.items[0].contentExcerpt).toBe('摘要正文');
      // 可读用户必须显式 addSelect `content`（select:false 漏取 = 摘要恒空串，静默降级）
      expect(qb.addSelect).toHaveBeenCalledWith(['nomination.content']);
      // **恰好一次**：`toHaveBeenCalledWith` 是"任意一次命中即过"，有人再顺手 addSelect
      // `rationale`（列表根本不用它）也照样绿——这条把"只取 content、不带 rationale"钉死
      expect(qb.addSelect).toHaveBeenCalledTimes(1);
      expect(result.engineAvailability).toMatchObject({ available: true, reason: null });
    });

    it('批式切片还原：一行的不可见来源只降级**它自己**', async () => {
      const rows = [
        buildRow({ id: 'led-full', sourceRefs: [{ type: 'doc', id: 'd1' }] }),
        buildRow({ id: 'led-hidden', sourceRefs: [{ type: 'doc', id: 'd2' }] }),
      ];
      const { service, access, formationEvents } = harness({ rows });
      access.evaluateSourceRefs.mockResolvedValueOnce([
        { visible: true, currentVersionHash: null },
        { visible: false, currentVersionHash: null },
      ]);
      formationEvents.query.mockResolvedValueOnce([
        {
          ledger_id: 'led-full',
          recovery_path: null,
          diagnostics: { admissionCause: 'quota_exceeded', requestId: 'req-1' },
        },
        { ledger_id: 'led-hidden', recovery_path: 'same_key_resend', diagnostics: null },
      ]);

      const result = await service.listNominations(agentActor(), PROJECT_ID, {});

      expect(result.items[0].projection).toBe('full');
      // full 档带引擎诊断（与 recoveryPath 同源同档）；metadata 档**整个键缺席**
      expect(result.items[0].engineDiagnostics).toEqual({
        admissionCause: 'quota_exceeded',
        requestId: 'req-1',
      });
      expect(result.items[1].projection).toBe('metadata');
      expect('engineDiagnostics' in result.items[1]).toBe(false);
      // recovery_path 一次批量查（禁止逐行查 = N+1）
      expect(formationEvents.query).toHaveBeenCalledTimes(1);
      // 窄 CTE 改带别名前缀（DISTINCT ON 只输出 ledger_id/id，jsonb 不进排序元组）
      expect(formationEvents.query).toHaveBeenCalledWith(
        expect.stringContaining('DISTINCT ON (ev.ledger_id)'),
        [['led-full', 'led-hidden']],
      );
    });

    it('详情：完整投影时必须显式 addSelect 正文/理由（select:false 漏取 = 静默空正文）', async () => {
      const row = buildRow({
        content: `[ruling] 主体\n范围: 范围\n理由: 冻结理由\n${EXCERPT_AREA_PREFIX}- [chamber://doc/doc-1] 摘要正文`,
        sourceRefs: [{ type: 'doc', id: 'doc-1' }],
      });
      const { service, qb, formationEvents } = harness({ rows: [row], existingByKey: row });
      formationEvents.query.mockResolvedValueOnce([
        {
          ledger_id: LEDGER_ID,
          recovery_path: null,
          diagnostics: {
            engineReasonCode: 'provider_rejected',
            errorDetail: 'provider_decision_evidence_missing',
            failureClass: 'terminal_rejection',
            requestId: 'req-9',
          },
        },
      ]);

      const detail = await service.getNomination(agentActor(), LEDGER_ID);

      expect(qb.addSelect).toHaveBeenCalledWith(['nomination.content', 'nomination.rationale']);
      expect(detail).toMatchObject({
        projection: 'full',
        content: row.content,
        contentExcerpt: '摘要正文',
        recoveryPath: null,
        // 详情 full 档同样带引擎诊断（读面可见 = full 档可见）
        engineDiagnostics: {
          engineReasonCode: 'provider_rejected',
          errorDetail: 'provider_decision_evidence_missing',
          failureClass: 'terminal_rejection',
          requestId: 'req-9',
        },
      });
    });

    it('提名者归属：agent / 软删 human（**保留真名** + deletedAt）/ system / 真孤儿 四态', async () => {
      const AGENT_ID = 'a1111111-1111-4111-8111-111111111111';
      const HUMAN_ID = 'b2222222-2222-4222-8222-222222222222';
      const SYSTEM_ID = 'c3333333-3333-4333-8333-333333333333';
      const ORPHAN_ID = 'd4444444-4444-4444-8444-444444444444';
      const softDeleted = new Date('2026-09-20T00:00:00.000Z');

      const rows = [
        buildRow({ id: 'l-agent', nominatorId: AGENT_ID, nominatorType: ActorType.AGENT }),
        buildRow({ id: 'l-human', nominatorId: HUMAN_ID, nominatorType: ActorType.HUMAN }),
        buildRow({ id: 'l-system', nominatorId: SYSTEM_ID, nominatorType: ActorType.SYSTEM }),
        buildRow({ id: 'l-orphan', nominatorId: ORPHAN_ID, nominatorType: ActorType.AGENT }),
      ];
      const profiles = new Map<string, ActorProfile>([
        [
          AGENT_ID,
          {
            type: ActorType.AGENT,
            name: 'Coder',
            avatarUrl: null,
            description: null,
            deletedAt: null,
          },
        ],
        [
          HUMAN_ID,
          {
            type: ActorType.HUMAN,
            name: 'Admin',
            avatarUrl: null,
            description: null,
            deletedAt: softDeleted,
          },
        ],
        // SYSTEM_ID 刻意不入 Map —— 但 system 类型**根本不查表**（见实现注释），故这条不构成覆盖
      ]);
      const { service, actorProfiles } = harness({ rows, profiles });

      const result = await service.listNominations(agentActor(), PROJECT_ID, {});

      // ① agent：真名
      expect(result.items[0]).toMatchObject({ nominatorName: 'Coder', nominatorDeletedAt: null });
      // ② 软删 human：**名字仍在** + 删除标记（全站 actor 呈现范式：历史归因不丢）
      expect(result.items[1]).toMatchObject({
        nominatorName: 'Admin',
        nominatorDeletedAt: softDeleted.toISOString(),
      });
      // ③ system：哨兵 actor 无表可查，且显示名要按语言渲染 ⇒ 后端给空值对，前端静态文案兜底
      expect(result.items[2]).toMatchObject({ nominatorName: null, nominatorDeletedAt: null });
      // ④ 真孤儿：同样空值对（消费方退 id 前 8 位），本层不发明 'Unknown' 兜底名
      expect(result.items[3]).toMatchObject({ nominatorName: null, nominatorDeletedAt: null });

      // **禁 N+1**：一次请求只解析一次，且 system 不进查询集（它没有 agents/users 档案）
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledTimes(1);
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledWith([AGENT_ID, HUMAN_ID, ORPHAN_ID]);
    });

    it('提名者归属：列表里同一个提名者只解析一次（批量去重）', async () => {
      const rows = [
        buildRow({ id: 'l1', nominatorId: ACTOR_ID, nominatorType: ActorType.AGENT }),
        buildRow({ id: 'l2', nominatorId: ACTOR_ID, nominatorType: ActorType.AGENT }),
      ];
      const { service, actorProfiles } = harness({ rows });

      await service.listNominations(agentActor(), PROJECT_ID, {});

      expect(actorProfiles.resolveProfiles).toHaveBeenCalledTimes(1);
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledWith([ACTOR_ID]);
    });

    it('latestRecoveryPaths：空输入不发查询（省一次无谓往返）', async () => {
      const { service, formationEvents } = harness({});
      await expect(service.latestRecoveryPaths([])).resolves.toEqual(new Map());
      expect(formationEvents.query).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // prepareClaim（字节闸门与来源冻结）
  // ══════════════════════════════════════════════════════════════════════
  describe('prepareClaim', () => {
    it('rationale 按 **UTF-8 字节** 挡（中文一字 3 字节 ⇒ 400 字即超 1024）', async () => {
      const { service } = harness({});

      await expect(
        service.prepareClaim(
          agentActor(),
          nominateDto({ rationale: '由'.repeat(400), contentOverride: 'x' }),
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: ErrorCode.VALIDATION_ERROR,
          message: expect.stringContaining('UTF-8 bytes'),
        },
      });
    });

    it('来源无权 ⇒ 403 **下标级指认**（回取用提名者权限）', async () => {
      const { service, access } = harness({});
      access.evaluateSourceRefs.mockResolvedValueOnce([
        { visible: true, currentVersionHash: null },
        { visible: false, currentVersionHash: null },
      ]);

      await expect(
        service.prepareClaim(
          agentActor(),
          nominateDto({
            sourceRefs: [
              { type: 'doc', id: 'd1' },
              { type: 'message', id: 'm2' },
            ],
          }),
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: { message: expect.stringContaining('source_refs[1]') },
      });
    });

    it('来源条数超上限 ⇒ 只冻结前 4 条（Hument source_locators ≤4 同值）', async () => {
      const { service, access } = harness({});

      await service.prepareClaim(
        agentActor(),
        nominateDto({
          sourceRefs: [
            { type: 'doc', id: 'd1' },
            { type: 'doc', id: 'd2' },
            { type: 'doc', id: 'd3' },
            { type: 'doc', id: 'd4' },
            { type: 'doc', id: 'd5' },
          ],
        }),
      );

      expect((access.evaluateSourceRefs as jest.Mock).mock.calls[0][1]).toHaveLength(4);
    });

    it('固定区（三要素 + 理由）自身超限 ⇒ 400（**不截主张**）', async () => {
      const { service } = harness({});

      await expect(
        service.prepareClaim(
          agentActor(),
          nominateDto({
            subject: '主'.repeat(2000), // 6000 字节
            scope: '范'.repeat(900), // 2700 字节
            rationale: '由'.repeat(400), // 1200 字节 ⇒ 合计 ≈ 9.9KB > 8192
            contentOverride: undefined,
          }),
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { message: expect.stringContaining('never truncated') },
      });
    });

    it('纯著述（无来源）⇒ 不查权限、locator 为空', async () => {
      const { service, access } = harness({});

      const prepared = await service.prepareClaim(agentActor(), nominateDto());

      // 无来源 = 纯著述：不查权限、不冻结摘录
      expect(access.evaluateSourceRefs).not.toHaveBeenCalled();
      expect(prepared).toMatchObject({ sourceLocators: [], sourceRefs: [], content: '正文' });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // createLedgerRow：唯一约束的两种冲突分码
  // ══════════════════════════════════════════════════════════════════════
  describe('createLedgerRow', () => {
    it('初始态 = submitted + active + ids NULL（用户动作 ⇒ 走 ORM save）', async () => {
      const { service, nominations } = harness({});

      await service.createLedgerRow({
        projectId: PROJECT_ID,
        projectSnapshot: buildProject(),
        actor: agentActor(),
        dto: nominateDto(),
        prepared: { content: '正文', contentTruncated: false, sourceRefs: [], sourceLocators: [] },
      });

      expect(nominations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          formationState: MEMORY_FORMATION_STATE.SUBMITTED,
          status: MEMORY_NOMINATION_STATUS.ACTIVE,
          engineMemoryIds: null,
          deferred: false,
          correctionTargetMemoryId: null, // 普通提名恒 null（仅更正行有意义）
        }),
      );
      expect(nominations.save).toHaveBeenCalledTimes(1);
    });

    it('correctionTargetMemoryId：显式值**原样落库**（更正目标 = 续跑同参锚点）', async () => {
      const { service, nominations } = harness({});

      await service.createLedgerRow({
        projectId: PROJECT_ID,
        projectSnapshot: buildProject(),
        actor: agentActor(),
        dto: nominateDto(),
        prepared: { content: '正文', contentTruncated: false, sourceRefs: [], sourceLocators: [] },
        correctionOf: OLD_LEDGER_ID,
        correctionTargetMemoryId: 'mem-old-2',
      });

      expect(nominations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          correctionOf: OLD_LEDGER_ID,
          correctionTargetMemoryId: 'mem-old-2',
        }),
      );
    });

    it.each([
      ['uq_memory_nominations_client_key', '幂等键已用过'],
      ['uq_memory_nominations_correction_of', '同一 old 已有有效更正行'],
    ])('%s 冲突 ⇒ 409/14005（文案各自给出下一步）', async (constraint, word) => {
      const { service, nominations } = harness({});
      nominations.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505', constraint }),
      );

      await expect(
        service.createLedgerRow({
          projectId: PROJECT_ID,
          projectSnapshot: buildProject(),
          actor: agentActor(),
          dto: nominateDto(),
          prepared: {
            content: '正文',
            contentTruncated: false,
            sourceRefs: [],
            sourceLocators: [],
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: ErrorCode.MEMORY_NOMINATION_CONFLICT,
          // 两种冲突的文案各自给出下一步（改 key 绕不过 / 先读那行）
          message: expect.stringContaining(word),
        },
      });
    });

    it('其它 PG 错误原样抛出（不吞成 409）', async () => {
      const { service, nominations } = harness({});
      nominations.save.mockRejectedValueOnce(
        Object.assign(new Error('fk violation'), { code: '23503' }),
      );

      await expect(
        service.createLedgerRow({
          projectId: PROJECT_ID,
          projectSnapshot: buildProject(),
          actor: agentActor(),
          dto: nominateDto(),
          prepared: {
            content: '正文',
            contentTruncated: false,
            sourceRefs: [],
            sourceLocators: [],
          },
        }),
      ).rejects.toThrow('fk violation');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 来源投影（与召回同形）
  // ══════════════════════════════════════════════════════════════════════
  describe('toSourceRefProjection', () => {
    it('doc ⇒ read_doc 入口 + locator 带冻结锚前 12 位；`moved` 在账本读面恒 false', () => {
      const { service } = harness({});

      const projection = service.toSourceRefProjection({
        type: 'doc',
        id: 'doc-1',
        versionHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      });

      expect(projection).toMatchObject({
        type: 'doc',
        id: 'doc-1',
        versionHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        locator: 'chamber://doc/doc-1#habcdef012345',
        // 账本读的是冻结快照，判"来源是否已改"要拿当前 contentHash 比——那是召回路径的事
        moved: false,
        readWith: { tool: 'read_doc', params: { docId: 'doc-1' } },
      });
    });

    it.each([
      ['message', 'get_topic_digest', { topicId: '', markRead: false, maxContentLength: 0 }],
      ['comment', 'task_controller_get_comments', { id: '' }],
    ])('%s ⇒ 回查入口的参数必须是**原样可调**的（不吞副作用）', (type, tool, params) => {
      const { service } = harness({});

      const projection = service.toSourceRefProjection({ type: type as never, id: 'x' });

      expect(projection.readWith.tool).toBe(tool);
      expect(projection.readWith.params).toEqual(params);
    });
  });
});

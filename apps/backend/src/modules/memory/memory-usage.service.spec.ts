/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **Memory Usage 读面服务**的服务级单测：权限矩阵（admin / 全绑定可读 / 部分可读 /
 *     零绑定 / 治理观察者）、共享与 claim 归属（AND + deny 优先、拒绝时 engine 0 调用）、
 *     引擎不可用、版本/数据/身份/cursor/429 的**精确分桶**、响应装配（engine 去 target）、
 *     默认时间窗、并发闸释放
 *
 * [代码职责]
 *   - 把"Usage 权限不是 any-binding""共享扫描含 archived/软删""拒绝时 Hub 0 调用"
 *     "engine.target 不交付""400 不带 cursor 不是 cursor_reset_required"等不变量钉成可执行事实
 *
 * [权威文档]
 *   - 判据单源 = `memory-usage.service.ts` 的 [关键不变量] + 计划 §2.1–2.3/§3.2
 *
 * [关联代码]
 *   - ./memory-usage.service.ts — 被测实现
 *   - ./memory-access.service.ts — `canReadMemoryUsage`（权限判据单源）
 *   - ./memory-engine-access.ts — 可用性闸与 target 派生
 *   - ./memory.constants.ts — 14000/14006/429 构造器
 * =============================================================================
 */
import { ActorType, ErrorCode, MEMORY_UNAVAILABLE_REASON, UserRole } from '@agent-chamber/shared';
import { MemoryUsageService } from './memory-usage.service';
import { MemoryUsageConcurrencyGate } from './memory-usage-concurrency.gate';
import { MemoryUsageRateLimitedException } from './memory.constants';
import type { MemoryAccessService, MemoryProjectAccess } from './memory-access.service';
import type { MemoryFormationService } from './memory-formation.service';
import type { MemoryProjectService } from './memory-project.service';
import type { MemoryProject } from '../../database/entities/memory-project.entity';
import type { MemoryEngineBindingClaim } from '../../database/entities/memory-engine-binding-claim.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import type {
  HumentUsageSummary,
  HumentUsageTrace,
  MemoryEngineFailure,
  MemoryEngine as MemoryEnginePort,
} from './engines/memory-engine.interface';
import type { QueryMemoryUsageSummaryDto, QueryMemoryUsageTraceDto } from './dto/memory-usage.dto';

const ACTOR_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const BINDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const agentActor = (): UnifiedActor => ({ id: ACTOR_ID, type: ActorType.AGENT });
const adminActor = (): UnifiedActor =>
  ({
    id: '88888888-8888-4888-8888-888888888888',
    type: ActorType.AGENT,
    role: UserRole.ADMIN,
  }) as UnifiedActor;

function buildProject(overrides: Partial<MemoryProject> = {}): MemoryProject {
  return {
    id: PROJECT_ID,
    slug: 'usage-project',
    name: 'Usage Project',
    bindings: [{ type: 'topic', id: BINDING_ID }],
    engine: 'hument',
    engineWorkspaceId: 'ws-1',
    engineActorId: 'act-1',
    engineCredentialRef: 'cred-1',
    status: 'active',
    retainQueryText: true,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as MemoryProject;
}

function buildAccess(overrides: Partial<MemoryProjectAccess> = {}): MemoryProjectAccess {
  return {
    readable: true,
    writable: false,
    isGovernanceViewer: false,
    resolved: [{ type: 'topic', id: BINDING_ID, exists: true, readable: true, writable: false }],
    ...overrides,
  };
}

/** 合同 required 的 totals 全文（值刻意与 rows/groups 不等） */
const usageTotals = {
  counts: {
    evidence_rows: 2,
    entities: 2,
    logical_calls: 2,
    generations: 1,
    batches: 0,
    known_physical_calls: 1,
    physical_calls: null,
    unknown_physical_units: 1,
    http_429: 0,
    retries: 0,
    cache_reuses: null,
    replay_count: 0,
  },
  tokens: {
    known_input_tokens: 10,
    input_tokens: null,
    unknown_input_rows: 1,
    known_output_tokens: 20,
    output_tokens: 20,
    unknown_output_rows: 0,
    known_total_tokens: 30,
    total_tokens: null,
    unknown_total_rows: 1,
  },
  cost: {
    status: 'unknown',
    actual_micros: null,
    known_estimated_micros: 7,
    estimated_micros: null,
    unknown_estimated_rows: 1,
  },
  duration: {
    known_physical_ms: 120,
    physical_ms: null,
    unknown_physical_rows: 1,
  },
};

function summaryValue(overrides: Record<string, unknown> = {}): HumentUsageSummary {
  return {
    schema_version: 'hument-usage-v1',
    target: {
      binding_id: 'binding-1',
      namespace_id: 'ns-1',
      workspace_id: 'ws-1',
      actor_id: 'act-1',
      scope: 'actor_private',
    },
    filter: { since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' },
    time_basis: 'physical_started_at',
    snapshot: 'snap-1',
    as_of: '2026-10-02T00:00:00Z',
    totals: structuredClone(usageTotals),
    groups: [],
    coverage: {
      status: 'complete',
      scope: 'actor_private',
      sources: [],
      excluded_untimed_rows: 0,
    },
    ...overrides,
  } as HumentUsageSummary;
}

function traceValue(overrides: Record<string, unknown> = {}): HumentUsageTrace {
  return {
    ...summaryValue(),
    rows: [],
    total_rows: 0,
    limit: 100,
    has_more: false,
    ...overrides,
  } as unknown as HumentUsageTrace;
}

/** 构建被测服务（mock 仓储 + 真实并发闸） */
function buildService(
  options: {
    project?: MemoryProject;
    access?: MemoryProjectAccess;
    availability?: { engine: 'hument'; available: boolean; reason: string | null };
    engine?: Partial<MemoryEnginePort> | null;
    projectRows?: Array<Partial<MemoryProject>>;
    claim?: Partial<MemoryEngineBindingClaim> | null;
    clock?: () => Date;
  } = {},
) {
  const project = options.project ?? buildProject();
  const accessResult = options.access ?? buildAccess();
  const claim =
    options.claim === undefined
      ? ({ id: 'claim-1', projectId: project.id } as Partial<MemoryEngineBindingClaim>)
      : options.claim;
  const projectRows = options.projectRows ?? [
    {
      id: project.id,
      engine: project.engine,
      engineWorkspaceId: project.engineWorkspaceId,
      engineActorId: project.engineActorId,
      engineCredentialRef: project.engineCredentialRef,
    },
  ];

  const access = {
    resolveProjectAccess: jest.fn().mockResolvedValue(accessResult),
  } as unknown as MemoryAccessService;
  const projectService = {
    findProjectOrThrow: jest.fn().mockResolvedValue(project),
    engineAvailability: jest
      .fn()
      .mockReturnValue(options.availability ?? { engine: 'hument', available: true, reason: null }),
  } as unknown as MemoryProjectService;
  const formation = {
    engineTarget: jest.fn().mockReturnValue({
      workspaceId: 'ws-1',
      actorId: 'act-1',
      credentialRef: 'cred-1',
    }),
  } as unknown as MemoryFormationService;

  const claimFindOne = jest.fn().mockResolvedValue(claim);
  const projects = {
    find: jest.fn().mockResolvedValue(projectRows),
    manager: {
      getRepository: jest.fn().mockReturnValue({ findOne: claimFindOne }),
    },
  };

  const engine =
    options.engine === undefined
      ? ({
          getUsageSummary: jest.fn().mockResolvedValue({ ok: true, value: summaryValue() }),
          getUsageTrace: jest.fn().mockResolvedValue({ ok: true, value: traceValue() }),
        } as unknown as MemoryEnginePort)
      : (options.engine as MemoryEnginePort | null);

  const gate = new MemoryUsageConcurrencyGate();
  const service = new MemoryUsageService(
    access,
    projectService,
    formation,
    gate,
    options.clock ?? (() => new Date()),
    engine,
    projects as never,
  );
  return {
    service,
    access,
    projectService,
    formation,
    projects,
    claimFindOne,
    // 只为断言 mock 调用；null 形态的用例不访问它
    engine: engine as unknown as {
      getUsageSummary: jest.Mock;
      getUsageTrace: jest.Mock;
    },
    gate,
    project,
  };
}

const summaryDto = (overrides: Partial<QueryMemoryUsageSummaryDto> = {}) =>
  ({ ...overrides }) as QueryMemoryUsageSummaryDto;
const traceDto = (overrides: Partial<QueryMemoryUsageTraceDto> = {}) =>
  ({ ...overrides }) as QueryMemoryUsageTraceDto;

/** 断言一个 HttpException 的 status/code/data 片段 */
async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: number,
  data: Record<string, unknown> = {},
) {
  try {
    await promise;
    throw new Error(`expected HTTP ${status}`);
  } catch (error) {
    const shaped = error as {
      getStatus?: () => number;
      getResponse?: () => Record<string, unknown>;
    };
    expect(shaped.getStatus?.()).toBe(status);
    const response = shaped.getResponse?.() ?? {};
    expect(response.code).toBe(code);
    if (Object.keys(data).length > 0) {
      expect(response.data).toMatchObject(data);
    }
    return response;
  }
}

describe('MemoryUsageService', () => {
  describe('权限矩阵（拒绝时 engine 0 调用）', () => {
    it('admin 放行（即使零绑定）', async () => {
      const { service, engine } = buildService({
        access: buildAccess({ readable: false, resolved: [] }),
      });
      const result = await service.getSummary(adminActor(), PROJECT_ID, summaryDto());
      expect(result.target).toEqual({
        workspaceId: 'ws-1',
        actorId: 'act-1',
        scope: 'actor_private',
      });
      expect(engine.getUsageSummary).toHaveBeenCalledTimes(1);
    });

    it('非 admin：非空且**每条**绑定可读 ⇒ 放行', async () => {
      const { service, engine } = buildService();
      await service.getSummary(agentActor(), PROJECT_ID, summaryDto());
      expect(engine.getUsageSummary).toHaveBeenCalledTimes(1);
    });

    it('部分可读 ⇒ 403/1009（治理观察者同理），engine 0 调用', async () => {
      for (const access of [
        buildAccess({
          resolved: [
            { type: 'topic', id: BINDING_ID, exists: true, readable: true, writable: false },
            { type: 'board', id: OTHER_PROJECT_ID, exists: true, readable: false, writable: false },
          ],
        }),
        buildAccess({ readable: false, resolved: [], isGovernanceViewer: true }),
      ]) {
        const { service, engine } = buildService({ access });
        await expectHttpError(
          service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
          403,
          ErrorCode.PERMISSION_DENIED,
        );
        expect(engine.getUsageSummary).not.toHaveBeenCalled();
      }
    });

    it('非治理且零绑定/全不可读 ⇒ 404/14001（存在性防泄露），engine 0 调用', async () => {
      const project = buildProject({ createdBy: OTHER_PROJECT_ID });
      const { service, engine } = buildService({
        project,
        access: buildAccess({ readable: false, resolved: [], isGovernanceViewer: false }),
        projectRows: [
          {
            id: project.id,
            engine: project.engine,
            engineWorkspaceId: project.engineWorkspaceId,
            engineActorId: project.engineActorId,
            engineCredentialRef: project.engineCredentialRef,
          },
        ],
      });
      await expectHttpError(
        service.getTrace(agentActor(), PROJECT_ID, traceDto()),
        404,
        ErrorCode.MEMORY_PROJECT_NOT_FOUND,
      );
      expect(engine.getUsageTrace).not.toHaveBeenCalled();
    });
  });

  describe('共享 / claim 归属（AND + deny 优先）', () => {
    it('同一三元组被 archived/软删行引用 ⇒ 409/14006 shared_engine_binding，engine 0 调用', async () => {
      const { service, engine } = buildService({
        projectRows: [
          {
            id: PROJECT_ID,
            engine: 'hument',
            engineWorkspaceId: 'ws-1',
            engineActorId: 'act-1',
            engineCredentialRef: 'cred-1',
          },
          {
            // archived / 软删行（withDeleted 扫描必须看见）
            id: OTHER_PROJECT_ID,
            engine: 'hument',
            engineWorkspaceId: 'ws-1',
            engineActorId: 'act-1',
            engineCredentialRef: 'cred-1',
          },
        ],
      });
      const response = await expectHttpError(
        service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
        409,
        ErrorCode.MEMORY_USAGE_CONFLICT,
      );
      expect((response.data as Record<string, unknown>).hintCode).toBe('shared_engine_binding');
      expect(JSON.stringify(response)).not.toContain('cred-1');
      expect(engine.getUsageSummary).not.toHaveBeenCalled();
    });

    it('claim 缺失 / 他人占用 ⇒ 409/14006（同码），engine 0 调用', async () => {
      for (const claim of [null, { id: 'claim-2', projectId: OTHER_PROJECT_ID }]) {
        const { service, engine } = buildService({ claim });
        await expectHttpError(
          service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
          409,
          ErrorCode.MEMORY_USAGE_CONFLICT,
        );
        expect(engine.getUsageSummary).not.toHaveBeenCalled();
      }
    });

    it('共享扫描与 claim 是 AND：claim 正常但共享 ⇒ 仍 409', async () => {
      const { service } = buildService({
        claim: { id: 'claim-1', projectId: PROJECT_ID },
        projectRows: [
          {
            id: PROJECT_ID,
            engine: 'hument',
            engineWorkspaceId: 'ws-1',
            engineActorId: 'act-1',
            engineCredentialRef: 'cred-1',
          },
          {
            id: OTHER_PROJECT_ID,
            engine: 'hument',
            engineWorkspaceId: 'ws-1',
            engineActorId: 'act-1',
            engineCredentialRef: 'cred-1',
          },
        ],
      });
      await expectHttpError(
        service.getTrace(agentActor(), PROJECT_ID, traceDto()),
        409,
        ErrorCode.MEMORY_USAGE_CONFLICT,
      );
    });
  });

  describe('引擎不可用与错误分桶', () => {
    it('engine token = null ⇒ 503/14000 + project_engine_unbound，engine 0 调用', async () => {
      const { service } = buildService({
        engine: null,
        availability: { engine: 'hument', available: false, reason: 'project_engine_unbound' },
      });
      await expectHttpError(
        service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
        503,
        ErrorCode.MEMORY_UNAVAILABLE,
        { reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND },
      );
    });

    const failureEngine = (failure: MemoryEngineFailure) =>
      buildService({
        engine: {
          getUsageSummary: jest.fn().mockResolvedValue({ ok: false, failure }),
          getUsageTrace: jest.fn().mockResolvedValue({ ok: false, failure }),
        } as unknown as MemoryEnginePort,
      });

    it('旧 Hub 404 / invalid_response schema ⇒ 503 engine_version_unsupported', async () => {
      const cases: MemoryEngineFailure[] = [
        {
          kind: 'http',
          message: 'x',
          httpStatus: 404,
          engineCode: 'resource_not_found',
          latencyMs: 1,
        },
        { kind: 'invalid_response', message: 'x', usageRejection: 'schema_mismatch', latencyMs: 1 },
        { kind: 'invalid_response', message: 'x', usageRejection: 'cursor_invalid', latencyMs: 1 },
        {
          kind: 'http',
          message: 'x',
          httpStatus: 400,
          engineCode: 'invalid_argument',
          latencyMs: 1,
        },
      ];
      for (const failure of cases) {
        const { service } = failureEngine(failure);
        await expectHttpError(
          service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
          503,
          ErrorCode.MEMORY_UNAVAILABLE,
          { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_VERSION_UNSUPPORTED },
        );
      }
    });

    it('schema_incompatible ⇒ engine_data_incompatible（**不是版本**）', async () => {
      const { service } = failureEngine({
        kind: 'http',
        message: 'x',
        httpStatus: 409,
        engineCode: 'schema_incompatible',
        latencyMs: 1,
      });
      await expectHttpError(
        service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
        503,
        ErrorCode.MEMORY_UNAVAILABLE,
        { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_DATA_INCOMPATIBLE },
      );
    });

    it('403 scope_denied / target mismatch ⇒ engine_identity_invalid', async () => {
      const cases: MemoryEngineFailure[] = [
        { kind: 'http', message: 'x', httpStatus: 403, engineCode: 'scope_denied', latencyMs: 1 },
        { kind: 'invalid_response', message: 'x', usageRejection: 'target_mismatch', latencyMs: 1 },
      ];
      for (const failure of cases) {
        const { service } = failureEngine(failure);
        await expectHttpError(
          service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
          503,
          ErrorCode.MEMORY_UNAVAILABLE,
          { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_IDENTITY_INVALID },
        );
      }
    });

    it('409 conflict / 携 cursor 的 400 ⇒ 502/14004 + cursor_reset_required', async () => {
      for (const failure of [
        {
          kind: 'http',
          message: 'x',
          httpStatus: 409,
          engineCode: 'conflict',
          requestId: 'r1',
          latencyMs: 1,
        },
        {
          kind: 'http',
          message: 'x',
          httpStatus: 400,
          engineCode: 'invalid_argument',
          latencyMs: 1,
        },
      ] as MemoryEngineFailure[]) {
        const { service } = failureEngine(failure);
        const response = await expectHttpError(
          service.getTrace(
            agentActor(),
            PROJECT_ID,
            traceDto({
              since: '2026-10-01T00:00:00Z',
              until: '2026-10-02T00:00:00Z',
              cursor: 'c1',
            }),
          ),
          502,
          ErrorCode.MEMORY_ENGINE_ERROR,
        );
        expect((response.data as Record<string, unknown>).hintCode).toBe('cursor_reset_required');
      }
    });

    it('429 ⇒ MemoryUsageRateLimitedException（retryAfterSeconds 透出给 controller）', async () => {
      const { service } = failureEngine({
        kind: 'http',
        message: 'x',
        httpStatus: 429,
        engineCode: 'overloaded',
        retryAfterSeconds: 7,
        latencyMs: 1,
      });
      await expect(service.getTrace(agentActor(), PROJECT_ID, traceDto())).rejects.toMatchObject({
        retryAfterSeconds: 7,
      });
    });

    it('timeout / unreachable ⇒ 503 的通用 reason（不是版本/身份）', async () => {
      for (const [kind, reason] of [
        ['timeout', MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT],
        ['unreachable', MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE],
      ] as const) {
        const { service } = failureEngine({ kind, message: 'x', latencyMs: 1 });
        await expectHttpError(
          service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
          503,
          ErrorCode.MEMORY_UNAVAILABLE,
          { reason },
        );
      }
    });
  });

  describe('响应装配与时间窗', () => {
    it('engine 块去掉 target；外层 target 是 camelCase 且不含 binding/namespace/credential', async () => {
      const { service } = buildService();
      const result = await service.getSummary(agentActor(), PROJECT_ID, summaryDto());
      expect('target' in result.engine).toBe(false);
      expect(result.target).toEqual({
        workspaceId: 'ws-1',
        actorId: 'act-1',
        scope: 'actor_private',
      });
      expect(JSON.stringify(result)).not.toContain('binding-1');
      expect(JSON.stringify(result)).not.toContain('ns-1');
      expect(JSON.stringify(result)).not.toContain('cred-1');
      expect(result.usageCaveat).toContain('null = 未知');
    });

    it('totals 原样透传（不按 rows/groups 重算）', async () => {
      const { service } = buildService();
      const result = await service.getSummary(agentActor(), PROJECT_ID, summaryDto());
      expect(result.engine.totals).toEqual(usageTotals);
    });

    it('省略 since/until ⇒ 服务端物化一次 7 天绝对窗口并原样进 engine query', async () => {
      const { service, engine } = buildService();
      await service.getSummary(agentActor(), PROJECT_ID, summaryDto());

      const query = (engine.getUsageSummary as jest.Mock).mock.calls[0][1] as {
        since: string;
        until: string;
      };
      expect(query.since).toMatch(/Z$/);
      expect(query.until).toMatch(/Z$/);
      const span = Date.parse(query.until) - Date.parse(query.since);
      expect(span).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('默认窗口用注入时钟，且一次请求只调用时钟一次（可判别"重算 now"）', async () => {
      const clock = jest.fn(() => new Date('2026-01-01T02:00:00.000Z'));
      const { service, engine } = buildService({ clock });
      await service.getTrace(agentActor(), PROJECT_ID, traceDto());
      expect(clock).toHaveBeenCalledTimes(1);
      expect((engine.getUsageTrace as jest.Mock).mock.calls[0][1]).toMatchObject({
        since: '2025-12-25T02:00:00.000Z',
        until: '2026-01-01T02:00:00.000Z',
        limit: 100,
      });
    });

    it('带 cursor 的 trace 原样回送显式时间窗（不重新计算"现在"）', async () => {
      const { service, engine } = buildService();
      const dto = traceDto({
        since: '2026-10-01T00:00:00.123Z',
        until: '2026-10-02T00:00:00.456Z',
        cursor: 'c1',
        limit: 200,
      });
      await service.getTrace(agentActor(), PROJECT_ID, dto);
      const query = (engine.getUsageTrace as jest.Mock).mock.calls[0][1] as {
        since: string;
        until: string;
        cursor: string;
        limit: number;
      };
      expect(query).toMatchObject({
        since: '2026-10-01T00:00:00.123Z',
        until: '2026-10-02T00:00:00.456Z',
        cursor: 'c1',
        limit: 200,
      });
    });

    it('服务层防静默改写：只给一侧时间 ⇒ 400，engine 0 调用', async () => {
      const { service, engine } = buildService();
      await expectHttpError(
        service.getSummary(agentActor(), PROJECT_ID, summaryDto({ since: '2026-10-01T00:00:00Z' })),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      await expectHttpError(
        service.getSummary(agentActor(), PROJECT_ID, summaryDto({ until: '2026-10-02T00:00:00Z' })),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(engine.getUsageSummary).not.toHaveBeenCalled();
    });

    it('服务层防静默改写：带 cursor 但缺显式时间窗 ⇒ 400，engine 0 调用', async () => {
      const { service, engine } = buildService();
      await expectHttpError(
        service.getTrace(agentActor(), PROJECT_ID, traceDto({ cursor: 'c1' })),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(engine.getUsageTrace).not.toHaveBeenCalled();
    });

    it('trace 省略 limit ⇒ 显式发 100（不依赖引擎部署默认）', async () => {
      const { service, engine } = buildService();
      await service.getTrace(agentActor(), PROJECT_ID, traceDto());
      expect((engine.getUsageTrace as jest.Mock).mock.calls[0][1]).toMatchObject({ limit: 100 });
    });
  });

  describe('并发闸（所有出口释放）', () => {
    it('两个在飞、第三个 429；完成后槽归零，后续仍可调用', async () => {
      let releaseFn: () => void = () => undefined;
      const blocker = new Promise<void>((resolve) => {
        releaseFn = () => resolve();
      });
      const engine = {
        getUsageSummary: jest.fn(() => blocker.then(() => ({ ok: true, value: summaryValue() }))),
        getUsageTrace: jest.fn(),
      } as unknown as MemoryEnginePort;
      const { service, gate } = buildService({ engine });

      const first = service.getSummary(agentActor(), PROJECT_ID, summaryDto());
      const second = service.getSummary(agentActor(), PROJECT_ID, summaryDto());
      await expect(
        service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
      ).rejects.toBeInstanceOf(MemoryUsageRateLimitedException);

      expect(gate.inFlight).toBe(2);
      releaseFn();
      await Promise.all([first, second]);
      expect(gate.inFlight).toBe(0);
      await expect(
        service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
      ).resolves.toBeDefined();
    });

    it('引擎失败也释放槽（两次失败后仍可继续）', async () => {
      const engine = {
        getUsageSummary: jest.fn().mockResolvedValue({
          ok: false,
          failure: { kind: 'timeout', message: 'x', latencyMs: 1 },
        }),
        getUsageTrace: jest.fn(),
      } as unknown as MemoryEnginePort;
      const { service, gate } = buildService({ engine });
      for (let i = 0; i < 3; i += 1) {
        await expect(
          service.getSummary(agentActor(), PROJECT_ID, summaryDto()),
        ).rejects.toBeDefined();
        expect(gate.inFlight).toBe(0);
      }
    });
  });
});

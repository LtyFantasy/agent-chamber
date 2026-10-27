/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **引擎投影读面**（hument alpha.5 四读面）的服务级单测：闸门顺序（404 先于 503）、
 *     graph 的**逐节点来源过滤链**（映射缺失 / 来源不可见 / 边级联）、`ledgerMapping` 装配、
 *     `engineDataSuspect` 三条件、引擎失败的两档分派（503 vs 502 + engineCode）
 *
 * [代码职责]
 *   - 把"过滤是批式的一次调用""unmapped 与 filtered 是两个出口""engineDataSuspect 禁止简化成
 *     单条件""单记忆族先 404 后 503"钉成可执行事实——这些在 e2e 里只跑得到主链路
 *     （多条件组合要靠本套件）
 *
 * [权威文档]
 *   - 判据单源 = `memory-views.service.ts` 的 [关键不变量] + `memory-access.service.ts`（同源约束）
 *
 * [关键不变量]（本套件的断言在守这些）
 *   - **先 404 后 503**：记忆不存在/来源不可见不该因为"引擎没配"变成"引擎不可用"
 *     （反之则会泄露项目外记忆的存在性）。
 *   - **批式**：一次 `evaluateSourceRefs` 喂**全部**已映射节点的 refs（调用次数断言钉住）——
 *     逐节点调用在 e2e 的小数据量下全绿，只在生产的 200 节点档放大成 200 次全表预载。
 *   - **计数三出口**：`unmappedCount`（映射不到）/ `filteredNodeCount`（来源不可见）/
 *     `filteredEdgeCount`（边随端点级联）——三者互不替代，治理条要分别解释。
 *   - **`engineDataSuspect` 三条件**：`unmapped > 0` ∧ 有 committed ∧ **无在途**——
 *     在途行能解释"映射不到的节点"，此时喊狼来了会让消费方怀疑整批数据。
 *   - **`ledgerMapping` 只含可见节点**：前端拿它做"图 → 详情"钻取，多放一个 = 指向读不到的行。
 *
 * [关联代码]
 *   - ./memory-views.service.ts — 被测实现
 *   - ./memory-access.service.ts — 闸门与可见性判据（本套件以假件替代，只验编排与切片）
 *   - ./memory.constants.ts — 14000/14004 错误构造器
 *
 * [修改检查]
 *   □ 改过滤链必须同步本套件 + `test/memory.e2e-spec.ts`（⑮ 节）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  ActorType,
  ErrorCode,
  MEMORY_ENGINE,
  MEMORY_UNAVAILABLE_REASON,
} from '@agent-chamber/shared';
import { MemoryViewsService } from './memory-views.service';
import type { MemoryAccessService } from './memory-access.service';
import type { MemoryProjectService } from './memory-project.service';
import type { MemoryFormationService } from './memory-formation.service';
import type { MemoryProject } from '../../database/entities/memory-project.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import type {
  HumentGraphEdge,
  HumentGraphNode,
  MemoryEngine as MemoryEnginePort,
} from './engines/memory-engine.interface';
import type { QueryMemoryViewGraphDto } from './dto/memory-view.dto';

const ACTOR_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const LEDGER_1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const LEDGER_2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const DOC_ID = 'dddddddd-4444-4444-8444-444444444444';

/** 造一个 agent actor */
function agentActor(): UnifiedActor {
  return { id: ACTOR_ID, type: ActorType.AGENT };
}

/** 造一个 active 项目（引擎已绑） */
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
    status: 'active',
    retainQueryText: true,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as MemoryProject;
}

/** 造一个 graph 节点（16 个合同字段齐；`label`/`preview` 用 memoryId 便于断言） */
function buildNode(memoryId: string, overrides: Partial<HumentGraphNode> = {}): HumentGraphNode {
  return {
    memory_id: memoryId,
    kind: 'concept',
    scope: 'actor_private',
    status: 'active',
    active_resolution: 'R2',
    available_resolution: 'R2',
    label: `label-${memoryId}`,
    preview: `preview-${memoryId}`,
    label_resolution: 'R2',
    confidence_present: false,
    contradiction_count: 0,
    supersession_count: 0,
    anchor_state: 'none',
    boundary: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 造一条关系边（6 个合同字段齐） */
function buildEdge(fromId: string, toId: string, type = 'part_of'): HumentGraphEdge {
  return {
    relation_id: `rel-${fromId}-${toId}`,
    from_id: fromId,
    to_id: toId,
    type,
    created_at: '2026-01-01T00:00:00.000Z',
    audit_locator: {
      status: 'available',
      journal_event_id: 'jrn-1',
      revision_id: 'rev-1',
      mutation_id: 'mut-1',
    },
  };
}

/** 本套件默认的"本请求引擎记忆 id"（`getMemoryRelations(actor, PROJECT_ID, REQUESTED)`） */
const REQUESTED_MEMORY = 'mem-1';

/**
 * 造一条**键真的缺席**的 case（合同破损的退化路径）。
 *
 * ⚠️ 刻意绕过类型：真实运行期确实可能缺字段（读面归一化只保证 `advisories[].cases` 是**数组**、
 * **不逐字段校验元素**——见 `hument.engine.ts` 的归一化粒度），而 TS 不允许把 `undefined`
 * 赋给 `string` 字段，故这里 `delete` 掉键再断言回原类型（**只在本套件**，用于钉归一化缺口）。
 *
 * @param field 要抹掉的键
 */
function buildCaseMissingField(
  field: 'new_memory_id' | 'old_memory_id',
): ReturnType<typeof buildRelationCase> {
  const item = { ...buildRelationCase('mem-2', 'new-side') } as Record<string, unknown>;
  delete item[field];
  return item as unknown as ReturnType<typeof buildRelationCase>;
}

/**
 * 造一条关系建议的 case（形状对齐 `memory-relations-response.schema.json` 的 `cases[]`）。
 *
 * ⚠️ **必须能表达两个方向**（这是本套件上一版的核心缺陷）：引擎按**读侧方向**决定哪一侧是
 * "另一条"记忆——new 侧读时另一条在 `old_memory_id`，**old 侧读时另一条在 `new_memory_id`**
 * （事实源 = `hument/internal/adapter/sqlite/relation_advisory.go` + 自测
 * `TestRelationAdvisoryReadOldMemoryReturnsOnlyItsPair`）。硬编码 `new = 本记忆` 只能造 new 侧，
 * 于是"过滤键恒取 `old_memory_id`"这个 bug 在旧断言下**永远绿**。
 *
 * @param otherMemoryId **另一条**记忆（平台的来源过滤挂在它身上）
 * @param view `'new-side'` = 本请求是 new 侧（另一条在 `old`）｜`'old-side'` = 本请求是被比较的
 *   旧侧（另一条在 `new`，`old_memory_id` 就是本请求自己）
 * @param requested 本请求的引擎记忆 id
 */
function buildRelationCase(
  otherMemoryId: string,
  view: 'new-side' | 'old-side' = 'new-side',
  requested: string = REQUESTED_MEMORY,
) {
  return {
    case_id: `case-${view}-${otherMemoryId}`,
    new_memory_id: view === 'new-side' ? requested : otherMemoryId,
    old_memory_id: view === 'new-side' ? otherMemoryId : requested,
    label: 'supplement',
    decision: 'advisory',
    reason: `作者自报：与 ${otherMemoryId} 的关系`,
    source_state: 'author_reported',
    advisory_only: true,
  };
}

/**
 * 造一条关系建议块（`advisories[]`；合同的 required 集 + 可选的 `model`/`usage`）。
 *
 * `coverage.candidate_count` 由调用方给（单测里刻意让它与 `cases.length` **不相等**，
 * 以钉住"引擎口径 ≠ 过滤后口径"这条不变量）。
 *
 * ⚠️ `matchedMemoryId` 可覆盖（缺省 = 本块的 `new_memory_id`）：**old 侧读**下引擎产出的块是
 * `matched_memory_id = 本请求`、`new_memory_id = 另一条` —— 两个字段**不相等**，故必须能单独给。
 */
function buildRelationAdvisory(
  newMemoryId: string,
  cases: ReturnType<typeof buildRelationCase>[],
  options: { matchedMemoryId?: string; candidateCount?: number } = {},
) {
  return {
    job_id: `job-${newMemoryId}`,
    matched_memory_id: options.matchedMemoryId ?? newMemoryId,
    new_memory_id: newMemoryId,
    state: 'complete',
    coverage: {
      new_memory_id: newMemoryId,
      status: 'complete',
      candidate_count: options.candidateCount ?? cases.length,
      orient_truncated: false,
      budget_incomplete: false,
    },
    cases,
    usage: {},
    created_at: '2026-01-01T00:00:00.000Z',
    source_state: 'author_reported',
    advisory_only: true,
  };
}

/** 造一个 relations 成功返回（`{ok:true, value}`；与引擎端口的判别式联合同形） */
function buildRelationsResult(
  memoryId: string,
  advisories: ReturnType<typeof buildRelationAdvisory>[],
) {
  return {
    ok: true as const,
    value: {
      schema_version: 'hument-memory-relations-v1',
      memory_id: memoryId,
      truncated: false,
      advisories,
    },
  };
}

/** 一条账本映射行（`loadMemoryIdMapping` 的产物形状；只有本套件用到的字段） */
function buildRow(id: string, refs: unknown[] = []) {
  return {
    id,
    category: 'ruling',
    subject: `主体 ${id}`,
    scope: '范围',
    contentTruncated: false,
    status: 'active',
    formationState: 'committed',
    reviewAt: null,
    sourceRefs: refs,
    engineMemoryIds: [],
  };
}

/** 组装被测服务（access / project / formation / engine 全部以假件注入） */
function buildService(
  options: {
    nodes?: HumentGraphNode[];
    edges?: HumentGraphEdge[];
    /** `loadMemoryIdMapping` 的映射（memory_id → 行） */
    mapping?: Map<string, ReturnType<typeof buildRow>>;
    hasCommitted?: boolean;
    hasInFlight?: boolean;
    /** 逐条来源可见性（按 evaluateSourceRefs 的入参序） */
    visible?: (index: number) => boolean;
    availability?: { engine: string; available: boolean; reason: string | null };
    graphResult?: unknown;
    detailResult?: unknown;
    historyResult?: unknown;
    representationResult?: unknown;
    /** relations（关系建议）的引擎返回；缺省 = 一条 advisory + 一条 case 的最小合法形状 */
    relationsResult?: unknown;
    engine?: unknown;
    project?: MemoryProject;
  } = {},
) {
  const mapping = {
    byMemoryId: options.mapping ?? new Map<string, ReturnType<typeof buildRow>>(),
    hasCommitted: options.hasCommitted ?? true,
    hasInFlight: options.hasInFlight ?? false,
  };
  const access = {
    assertProjectContentRead: jest.fn(async () => undefined),
    loadMemoryIdMapping: jest.fn(async () => mapping),
    evaluateSourceRefs: jest.fn(async (_actor: unknown, refs: unknown[]) =>
      refs.map((_ref, index) => ({
        visible: options.visible ? options.visible(index) : true,
        currentVersionHash: null,
      })),
    ),
  };
  const project = options.project ?? buildProject();
  const projectService = {
    findProjectOrThrow: jest.fn(async () => project),
    engineAvailability: jest.fn(
      () => options.availability ?? { engine: MEMORY_ENGINE.HUMENT, available: true, reason: null },
    ),
  };
  const formation = {
    engineTarget: jest.fn(() => ({
      workspaceId: 'ws-1',
      actorId: 'act-1',
      credentialRef: 'cred-1',
    })),
  };

  const defaultGraph = {
    ok: true,
    value: {
      schema_version: 'memory-view-memory-graph-v1',
      request_id: 'req-1',
      auth_kind: 'binding_credential_ref',
      authority: 'inspect_read',
      target: {
        target_id: 'a'.repeat(64),
        workspace_id: 'ws-1',
        actor_id: 'act-1',
        binding_id: 'bind-1',
        scope: 'actor_private',
      },
      snapshot_digest: 'b'.repeat(64),
      mode: 'browse',
      center_memory_id: '',
      filters: {
        kind: 'any',
        status: 'any',
        active_resolution: 'any',
        available_resolution: 'any',
        anchor_state: 'any',
        created_from: null,
        created_to: null,
        relation_type: 'any',
      },
      budget: {
        node_limit: 200,
        edge_limit: 600,
        neighborhood_limit: 100,
        preview_scalars: 160,
        depth: 1,
      },
      node_page: {
        total: (options.nodes ?? []).length,
        total_kind: 'exact',
        loaded: (options.nodes ?? []).length,
        next_cursor: '',
        partial: false,
        truncated: false,
        truncation_reason: '',
      },
      edge_page: {
        total: (options.edges ?? []).length,
        total_kind: 'exact',
        loaded: (options.edges ?? []).length,
        next_cursor: '',
        partial: false,
        truncated: false,
        truncation_reason: '',
      },
      omitted_edge_count: 0,
      nodes: options.nodes ?? [],
      edges: options.edges ?? [],
      redaction: 'memory-projection-safe-v1',
    },
  };

  /**
   * relations 的最小合法引擎返回（1 条 advisory + 1 条 case）。
   *
   * 单测只验**编排与切片**（过滤链的语义），故形状够用即可——合同逐字段的正确性由
   * `hument.engine.spec` 的归一化用例与 e2e 的字段级断言守。
   */
  const defaultRelations = buildRelationsResult(REQUESTED_MEMORY, [
    buildRelationAdvisory(REQUESTED_MEMORY, [buildRelationCase('mem-2', 'new-side')]),
  ]);

  const engine =
    options.engine === undefined
      ? {
          getGraphView: jest.fn(async () => options.graphResult ?? defaultGraph),
          getMemoryView: jest.fn(
            async () =>
              options.detailResult ?? {
                ok: true,
                value: { memory: { memory_id: 'mem-1' }, sections: {}, snapshot_digest: 'b' },
              },
          ),
          getMemoryViewHistory: jest.fn(
            async () => options.historyResult ?? { ok: true, value: { memory_id: 'mem-1' } },
          ),
          getMemoryViewRepresentation: jest.fn(
            async () => options.representationResult ?? { ok: true, value: { memory_id: 'mem-1' } },
          ),
          getMemoryRelations: jest.fn(async () => options.relationsResult ?? defaultRelations),
        }
      : options.engine;

  const service = new MemoryViewsService(
    access as unknown as MemoryAccessService,
    projectService as unknown as MemoryProjectService,
    formation as unknown as MemoryFormationService,
    engine as unknown as MemoryEnginePort | null,
  );

  return { service, access, projectService, formation, engine, project, mapping };
}

/** graph 入参（默认空 = 全部未传） */
function graphDto(overrides: Partial<QueryMemoryViewGraphDto> = {}): QueryMemoryViewGraphDto {
  return { ...overrides } as QueryMemoryViewGraphDto;
}

describe('MemoryViewsService（引擎投影读面）', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 闸门与错误分派
  // ══════════════════════════════════════════════════════════════════════
  describe('闸门顺序与失败分派', () => {
    it('内容读闸门拒绝 ⇒ 原样抛出，且不调引擎、不查映射', async () => {
      const { service, access, engine } = buildService();
      access.assertProjectContentRead.mockRejectedValueOnce(
        Object.assign(new Error('content closed'), { status: 403 }),
      );

      await expect(service.getGraphView(agentActor(), PROJECT_ID, graphDto())).rejects.toThrow(
        'content closed',
      );
      expect(access.loadMemoryIdMapping).not.toHaveBeenCalled();
      expect((engine as { getGraphView: jest.Mock }).getGraphView).not.toHaveBeenCalled();
    });

    it('graph：引擎未配 ⇒ 503/14000 + reason（**不落遥测**——纯读面没有分母可记）', async () => {
      const { service, access } = buildService({
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(
        service.getGraphView(agentActor(), PROJECT_ID, graphDto()),
      ).rejects.toMatchObject({
        status: 503,
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND },
        },
      });
      expect(access.loadMemoryIdMapping).not.toHaveBeenCalled();
    });

    it('`this.engine === null`（关闭态）⇒ 503，即使 availability 说可用', async () => {
      const { service } = buildService({ engine: null });

      await expect(
        service.getGraphView(agentActor(), PROJECT_ID, graphDto()),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: ErrorCode.MEMORY_UNAVAILABLE },
      });
    });

    it('引擎超时 / 未达 ⇒ 503/14000（reason 两值分开）', async () => {
      for (const [kind, reason] of [
        ['timeout', MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT],
        ['unreachable', MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE],
      ] as const) {
        const { service } = buildService({
          graphResult: { ok: false, failure: { kind, message: 'x', latencyMs: 5 } },
        });

        await expect(
          service.getGraphView(agentActor(), PROJECT_ID, graphDto()),
        ).rejects.toMatchObject({
          status: 503,
          response: { code: ErrorCode.MEMORY_UNAVAILABLE, data: { reason } },
        });
      }
    });

    it.each([
      [
        'http（含 cursor 失效双通道）',
        { kind: 'http', httpStatus: 409, engineCode: 'snapshot_stale' },
      ],
      ['invalid_response', { kind: 'invalid_response', engineCode: undefined }],
      // ⚠️ **引擎侧的 404 也走 502**（不是平台的 404）：平台的 404 只表示"本项目没这条记忆 /
      //    来源不可见"；替引擎断言 404 = 把它的答案翻译成平台的语义（与 19.16 同款）
      [
        'http 404（引擎不认识该 id）',
        { kind: 'http', httpStatus: 404, engineCode: 'resource_not_found' },
      ],
    ])('%s ⇒ 502/14004 + engineCode 逐字透传', async (_label, failure) => {
      const { service } = buildService({
        graphResult: { ok: false, failure: { ...failure, message: 'refused', latencyMs: 5 } },
      });

      await expect(
        service.getGraphView(agentActor(), PROJECT_ID, graphDto()),
      ).rejects.toMatchObject({
        status: 502,
        response: {
          code: ErrorCode.MEMORY_ENGINE_ERROR,
          data: { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR, engineCode: failure.engineCode },
        },
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // graph：逐节点过滤链
  // ══════════════════════════════════════════════════════════════════════
  describe('graph 的逐节点来源过滤', () => {
    it('未映射节点 ⇒ unmappedCount；来源不可见 ⇒ 丢弃 + filteredNodeCount；**边级联** ⇒ filteredEdgeCount', async () => {
      const mapping = new Map([
        ['mem-1', buildRow(LEDGER_1, [{ type: 'doc', id: DOC_ID }])],
        ['mem-2', buildRow(LEDGER_2, [{ type: 'doc', id: DOC_ID }])],
      ]);
      const { service } = buildService({
        nodes: [buildNode('mem-1'), buildNode('mem-2'), buildNode('mem-unmapped')],
        // 三条边：1↔2（两端可见）、1↔unmapped（端点未见）、2↔unmapped
        edges: [
          buildEdge('mem-1', 'mem-2'),
          buildEdge('mem-1', 'mem-unmapped'),
          buildEdge('mem-unmapped', 'mem-2'),
        ],
        mapping,
        // refs 拼平后顺序 = mem-1 的 1 条、mem-2 的 1 条：第一可见、第二不可见
        visible: (index) => index === 0,
      });

      const response = await service.getGraphView(agentActor(), PROJECT_ID, graphDto());

      expect(response.unmappedCount).toBe(1);
      expect(response.filteredNodeCount).toBe(1);
      expect(response.filteredByPermission).toBe(true);
      // 只有 mem-1 活下来 ⇒ 它的两条边都因"另一端不见/未加载"被级联丢弃
      expect(response.engine.nodes.map((node) => node.memory_id)).toEqual(['mem-1']);
      expect(response.engine.edges).toEqual([]);
      expect(response.filteredEdgeCount).toBe(3);
      // ledgerMapping 只含可见节点（mem-2 不可见、mem-unmapped 无映射）
      expect(response.ledgerMapping).toEqual({ 'mem-1': LEDGER_1 });
      // 引擎口径的 page/budget/omitted 不被过滤改写（loaded 仍是引擎加载数）
      expect(response.engine.node_page.loaded).toBe(3);
      expect(response.engine.budget.node_limit).toBe(200);
    });

    it('纯著述（无 sourceRefs）项目级过闸即放行；两端可见时边保留', async () => {
      const mapping = new Map([
        ['mem-1', buildRow(LEDGER_1, [])],
        ['mem-2', buildRow(LEDGER_2, [])],
      ]);
      const { service, access } = buildService({
        nodes: [buildNode('mem-1'), buildNode('mem-2')],
        edges: [buildEdge('mem-1', 'mem-2')],
        mapping,
        // 空 refs ⇒ evaluateSourceRefs 恒返回空数组；此处 visible 不该被调到
        visible: () => false,
      });

      const response = await service.getGraphView(agentActor(), PROJECT_ID, graphDto());

      expect(access.evaluateSourceRefs).toHaveBeenCalledWith(agentActor(), []);
      expect(response.filteredNodeCount).toBe(0);
      expect(response.filteredByPermission).toBe(false);
      expect(response.engine.nodes).toHaveLength(2);
      expect(response.engine.edges).toHaveLength(1);
      expect(response.filteredEdgeCount).toBe(0);
      expect(response.ledgerMapping).toEqual({ 'mem-1': LEDGER_1, 'mem-2': LEDGER_2 });
    });

    it('**批式**：无论多少节点，`evaluateSourceRefs` 只调一次（引用拼平后喂入）', async () => {
      const mapping = new Map([
        ['mem-1', buildRow(LEDGER_1, [{ type: 'doc', id: DOC_ID }])],
        ['mem-2', buildRow(LEDGER_2, [{ type: 'doc', id: DOC_ID }])],
      ]);
      const { service, access } = buildService({
        nodes: [buildNode('mem-1'), buildNode('mem-2')],
        mapping,
      });

      await service.getGraphView(agentActor(), PROJECT_ID, graphDto());

      expect(access.evaluateSourceRefs).toHaveBeenCalledTimes(1);
      expect((access.evaluateSourceRefs as jest.Mock).mock.calls[0][1]).toHaveLength(2);
    });

    it('engineDataSuspect **三条件**：unmapped>0 ∧ 有 committed ∧ 无在途；有在途行时不喊', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1)]]);
      const base = { nodes: [buildNode('mem-1'), buildNode('mem-unmapped')], mapping };

      // ① 有在途行 ⇒ 能解释"映射不到"，**不喊**
      const inFlight = buildService({ ...base, hasCommitted: true, hasInFlight: true });
      expect(
        (await inFlight.service.getGraphView(agentActor(), PROJECT_ID, graphDto()))
          .engineDataSuspect,
      ).toBe(false);

      // ② 无在途 + 有 committed ⇒ 喊
      const suspect = buildService({ ...base, hasCommitted: true, hasInFlight: false });
      expect(
        (await suspect.service.getGraphView(agentActor(), PROJECT_ID, graphDto()))
          .engineDataSuspect,
      ).toBe(true);

      // ③ 无 committed 行 ⇒ 不喊（没有可比对的基准）
      const noCommitted = buildService({ ...base, hasCommitted: false, hasInFlight: false });
      expect(
        (await noCommitted.service.getGraphView(agentActor(), PROJECT_ID, graphDto()))
          .engineDataSuspect,
      ).toBe(false);

      // ④ 全部映射得上 ⇒ 不喊（即使有 committed 且无在途）
      const allMapped = buildService({
        nodes: [buildNode('mem-1')],
        mapping,
        hasCommitted: true,
        hasInFlight: false,
      });
      expect(
        (await allMapped.service.getGraphView(agentActor(), PROJECT_ID, graphDto()))
          .engineDataSuspect,
      ).toBe(false);
    });

    it('camelCase DTO → snake_case 引擎 query：未传即 undefined（引擎默认档生效）', async () => {
      const { service, engine } = buildService();
      await service.getGraphView(
        agentActor(),
        PROJECT_ID,
        graphDto({
          kind: 'belief',
          activeResolution: 'R2',
          createdFrom: '2026-01-01T00:00:00+08:00',
          nodeLimit: 50,
          cursor: 'c1',
        }),
      );

      expect((engine as { getGraphView: jest.Mock }).getGraphView).toHaveBeenCalledWith(
        { workspaceId: 'ws-1', actorId: 'act-1', credentialRef: 'cred-1' },
        {
          kind: 'belief',
          status: undefined,
          active_resolution: 'R2',
          available_resolution: undefined,
          anchor_state: undefined,
          relation_type: undefined,
          created_from: '2026-01-01T00:00:00+08:00',
          created_to: undefined,
          node_limit: 50,
          edge_limit: undefined,
          preview_scalars: undefined,
          cursor: 'c1',
        },
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 单记忆族：两道 404 与信封
  // ══════════════════════════════════════════════════════════════════════
  describe('单记忆三端点', () => {
    it('无映射 ⇒ 404/14003（不确认存在性），且不调引擎', async () => {
      const { service, engine } = buildService({ mapping: new Map() });

      await expect(
        service.getMemoryView(agentActor(), PROJECT_ID, 'mem-absent', {}),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND },
      });
      expect((engine as { getMemoryView: jest.Mock }).getMemoryView).not.toHaveBeenCalled();
    });

    it('任一来源不可见 ⇒ 404/14003（防撤权逃逸）', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1, [{ type: 'doc', id: DOC_ID }])]]);
      const { service } = buildService({ mapping, visible: () => false });

      await expect(
        service.getMemoryView(agentActor(), PROJECT_ID, 'mem-1', {}),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('**404 先于 503**：引擎未配 + 无映射 ⇒ 仍是 404（不泄露项目外的存在性）', async () => {
      const { service } = buildService({
        mapping: new Map(),
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED,
        },
      });

      await expect(
        service.getMemoryView(agentActor(), PROJECT_ID, 'mem-absent', {}),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('映射齐全且全源可见 ⇒ 三端点各自返回引擎块 + 信任框三件套（**无** ledgerId 外层字段）', async () => {
      const detailEngine = {
        getMemoryView: jest.fn(async () => ({
          ok: true,
          value: { memory: { memory_id: 'mem-1' } },
        })),
        getMemoryViewHistory: jest.fn(async () => ({
          ok: true,
          value: { memory_id: 'mem-1', resolution: 'R2' },
        })),
        getMemoryViewRepresentation: jest.fn(async () => ({
          ok: true,
          value: { memory_id: 'mem-1' },
        })),
      };
      const mapping = new Map([['mem-1', buildRow(LEDGER_1)]]);
      const { service } = buildService({ mapping, engine: detailEngine });

      const detail = await service.getMemoryView(agentActor(), PROJECT_ID, 'mem-1', {
        relationLimit: 10,
        relationCursor: 'rc',
      });
      expect(detail).toEqual({
        engine: { memory: { memory_id: 'mem-1' } },
        trustLevel: 'untrusted_advisory',
        decisionAuthority: 'none',
        usageNote: expect.any(String),
      });
      expect(Object.keys(detail)).not.toContain('ledgerId');
      expect(detailEngine.getMemoryView).toHaveBeenCalledWith(expect.anything(), 'mem-1', {
        relation_limit: 10,
        relation_cursor: 'rc',
      });

      const history = await service.getMemoryViewHistory(agentActor(), PROJECT_ID, 'mem-1', 'R2', {
        historyLimit: 5,
      });
      expect(history.engine).toEqual({ memory_id: 'mem-1', resolution: 'R2' });
      expect(detailEngine.getMemoryViewHistory).toHaveBeenCalledWith(
        expect.anything(),
        'mem-1',
        'R2',
        {
          history_limit: 5,
          cursor: undefined,
        },
      );

      const repr = await service.getMemoryViewRepresentation(
        agentActor(),
        PROJECT_ID,
        'mem-1',
        'repr-1',
      );
      expect(repr.engine).toEqual({ memory_id: 'mem-1' });
      expect(detailEngine.getMemoryViewRepresentation).toHaveBeenCalledWith(
        expect.anything(),
        'mem-1',
        'repr-1',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // relations（关系建议）：闸门同档 + **逐 case 来源过滤链**
  // ══════════════════════════════════════════════════════════════════════
  describe('relations 关系建议读面', () => {
    it('无映射 ⇒ 404/14003，且**不调引擎**（存在性先于引擎可用性）', async () => {
      const { service, engine } = buildService({ mapping: new Map() });

      await expect(
        service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-absent'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND },
      });
      expect(
        (engine as { getMemoryRelations: jest.Mock }).getMemoryRelations,
      ).not.toHaveBeenCalled();
    });

    it('该记忆的任一来源不可见 ⇒ 404/14003（与 detail/history/representation 同码同语义）', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1, [{ type: 'doc', id: DOC_ID }])]]);
      const { service, engine } = buildService({ mapping, visible: () => false });

      await expect(
        service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1'),
      ).rejects.toMatchObject({ status: 404 });
      // 自己都读不到 ⇒ 连它的关系建议也不该打引擎
      expect(
        (engine as { getMemoryRelations: jest.Mock }).getMemoryRelations,
      ).not.toHaveBeenCalled();
    });

    it('**404 先于 503**：引擎未配 + 无映射 ⇒ 仍是 404（不泄露项目外的存在性）', async () => {
      const { service } = buildService({
        mapping: new Map(),
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED,
        },
      });

      await expect(
        service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-absent'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('engine=none（token 为 null）⇒ 503/14000 + reason，且不打引擎动词', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1)]]);
      const { service } = buildService({
        mapping,
        engine: null,
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED,
        },
      });

      await expect(
        service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1'),
      ).rejects.toMatchObject({
        status: 503,
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED },
        },
      });
      // ⚠️ 单记忆族的映射查询**在引擎闸之前**（它是 404 判据的一部分，见 resolveMemoryContext）：
      //    故这里断言的是"引擎动词没被打"，而不是"没查映射"（那条只对 graph 成立）。
      //    `engine: null` ⇒ 断言由"没崩在 `this.engine!` 上"承担（真值断言无意义，已删）。
    });

    it('new-side 全可见 ⇒ 引擎块逐字透传 + 三个计数为 0 + 信任框三件套', async () => {
      const mapping = new Map([
        ['mem-1', buildRow(LEDGER_1)],
        ['mem-2', buildRow(LEDGER_2)],
      ]);
      const { service } = buildService({ mapping });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1');

      // 引擎块的**字段与取值**逐字（形状不改：顶层四键 / 块的 required 集 / 两个 const）
      expect(response.engine.schema_version).toBe('hument-memory-relations-v1');
      expect(response.engine.memory_id).toBe('mem-1');
      expect(response.engine.truncated).toBe(false);
      expect(response.engine.advisories).toHaveLength(1);
      expect(response.engine.advisories[0].matched_memory_id).toBe('mem-1');
      expect(response.engine.advisories[0].advisory_only).toBe(true);
      expect(response.engine.advisories[0].cases).toHaveLength(1);
      expect(response.engine.advisories[0].cases[0].new_memory_id).toBe('mem-1');
      expect(response.engine.advisories[0].cases[0].old_memory_id).toBe('mem-2');
      // 平台外层（**不往引擎块里塞**）
      expect(response.filteredByPermission).toBe(false);
      expect(response.filteredCaseCount).toBe(0);
      expect(response.unmappedCaseCount).toBe(0);
      expect(response.droppedAdvisoryCount).toBe(0);
      expect(response.trustLevel).toBe('untrusted_advisory');
      expect(response.decisionAuthority).toBe('none');
      expect(typeof response.usageNote).toBe('string');
    });

    it('空 advisories 透传（合法 200，不是合同破损；三个计数恒 0）', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1)]]);
      const { service } = buildService({
        mapping,
        relationsResult: buildRelationsResult('mem-1', []),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1');
      expect(response.engine.advisories).toEqual([]);
      expect(response.filteredCaseCount).toBe(0);
      expect(response.unmappedCaseCount).toBe(0);
      expect(response.droppedAdvisoryCount).toBe(0);
    });

    // ══════════════════════════════════════════════════════════════════
    // **old-side 读**（本套件上一版的核心缺陷）：本记忆是被比较的旧侧 ⇒ 另一条在 `new_memory_id`
    // 恒取 `old_memory_id` 做过滤键时，这里的三条断言全都会以"过滤 no-op / 越权交付"的方式红
    // ══════════════════════════════════════════════════════════════════
    it('**old-side 读**：另一条在 `new_memory_id` ⇒ 过滤键必须取 new 侧（未映射 + 来源不可见各一条）', async () => {
      // old-side 形状：case.old = 本请求（mem-1）、case.new = 另一条
      const mapping = new Map([
        [REQUESTED_MEMORY, buildRow(LEDGER_1)],
        ['mem-other', buildRow(LEDGER_2, [{ type: 'doc', id: DOC_ID }])],
      ]);
      const { service, access } = buildService({
        mapping,
        visible: () => false, // 唯一那条 ref（mem-other 的 doc）不可见
        relationsResult: buildRelationsResult(REQUESTED_MEMORY, [
          // old-side 块的 matched = 本请求、new = 另一条（两个字段**不等**——引擎就是这样产的）
          buildRelationAdvisory('mem-other', [buildRelationCase('mem-other', 'old-side')], {
            matchedMemoryId: REQUESTED_MEMORY,
            candidateCount: 1,
          }),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, REQUESTED_MEMORY);

      // ① 块被放行（matched === 本请求）
      expect(response.droppedAdvisoryCount).toBe(0);
      expect(response.engine.advisories).toHaveLength(1);
      // ② 过滤键取的是 **new**（mem-other），其来源不可见 ⇒ case 丢弃 + 计数
      expect(response.filteredCaseCount).toBe(1);
      expect(response.unmappedCaseCount).toBe(0);
      expect(response.filteredByPermission).toBe(true);
      expect(response.engine.advisories[0].cases).toEqual([]);
      // ③ 批式喂给 `evaluateSourceRefs` 的 refs 是 **另一条**（mem-other）的，不是本请求的
      const caseRefs = (access.evaluateSourceRefs as jest.Mock).mock.calls[1][1] as unknown[];
      expect(caseRefs).toHaveLength(1);
    });

    it('**old-side 读**：另一条未映射 ⇒ `unmappedCaseCount`（过滤键取 new，而不是恒取 old）', async () => {
      const mapping = new Map([[REQUESTED_MEMORY, buildRow(LEDGER_1)]]); // 另一条**不在**映射里
      const { service, access } = buildService({
        mapping,
        relationsResult: buildRelationsResult(REQUESTED_MEMORY, [
          buildRelationAdvisory('mem-other', [buildRelationCase('mem-other', 'old-side')], {
            matchedMemoryId: REQUESTED_MEMORY,
          }),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, REQUESTED_MEMORY);

      expect(response.unmappedCaseCount).toBe(1);
      expect(response.filteredCaseCount).toBe(0);
      expect(response.engine.advisories[0].cases).toEqual([]);
      // 另一条未映射 ⇒ 它**根本不进**批式过滤：第二次调用喂的是**空数组**
      // （真实现 `evaluateSourceRefs` 对空入参在触库前就返回 ⇒ 零成本；这里钉的是
      //  "没有被授权的另一条不会被卷进来判可见性"）
      expect(access.evaluateSourceRefs).toHaveBeenCalledTimes(2);
      expect((access.evaluateSourceRefs as jest.Mock).mock.calls[1][1] as unknown[]).toHaveLength(
        0,
      );
    });

    it('归因失败（fail-closed）：自指（两侧同真）/ 不属本次请求（两侧同假）⇒ 丢 case + 计入 filteredCaseCount', async () => {
      const mapping = new Map([
        [REQUESTED_MEMORY, buildRow(LEDGER_1)],
        ['mem-2', buildRow(LEDGER_2)],
      ]);
      const { service } = buildService({
        mapping,
        relationsResult: buildRelationsResult(REQUESTED_MEMORY, [
          buildRelationAdvisory(
            REQUESTED_MEMORY,
            [
              // 两侧都等于本请求（自指）
              { ...buildRelationCase('x', 'new-side'), old_memory_id: REQUESTED_MEMORY },
              // 两侧都不是本请求（不属本次请求的块/块内串味）
              {
                ...buildRelationCase('x', 'new-side'),
                new_memory_id: 'mem-2',
                old_memory_id: 'mem-3',
              },
              // 一条正常的 new-side（对照：证明前两条不是"全丢"）
              buildRelationCase('mem-2', 'new-side'),
            ],
            { candidateCount: 3 },
          ),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, REQUESTED_MEMORY);

      expect(response.filteredCaseCount).toBe(2);
      expect(response.unmappedCaseCount).toBe(0);
      expect(response.engine.advisories[0].cases).toHaveLength(1);
      expect(response.engine.advisories[0].cases[0].old_memory_id).toBe('mem-2');
      // 块本身保留（块级归因是另一道闸，见下一条用例）
      expect(response.droppedAdvisoryCount).toBe(0);
    });

    it('**块级归因守卫**：`matched_memory_id` 对不上本请求 ⇒ 整块丢弃 + `droppedAdvisoryCount`', async () => {
      const mapping = new Map([
        [REQUESTED_MEMORY, buildRow(LEDGER_1)],
        ['mem-2', buildRow(LEDGER_2)],
        // 第三条记忆**带来源**：专门挂在"被丢块"的 case 上——若被丢块的 case 仍被纳入批式
        // 过滤，下面那句 refs 计数就会变成 1（这条断言才有牙齿）
        ['mem-3', buildRow('cccccccc-3333-4333-8333-333333333333', [{ type: 'doc', id: DOC_ID }])],
      ]);
      const { service, access } = buildService({
        mapping,
        relationsResult: buildRelationsResult(REQUESTED_MEMORY, [
          // ① 归因对得上 ⇒ 保留（case 的另一侧是**无来源**的 mem-2）
          buildRelationAdvisory(REQUESTED_MEMORY, [buildRelationCase('mem-2', 'new-side')]),
          // ② 归因对不上（matched 指向另一条记忆）⇒ 整块丢弃（连 state/coverage/usage 都不交付）；
          //    块内 case 的另一侧是**带来源**的 mem-3（用于证明它没进批式过滤）
          buildRelationAdvisory('mem-2', [buildRelationCase('mem-3', 'old-side')]),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, REQUESTED_MEMORY);

      expect(response.droppedAdvisoryCount).toBe(1);
      expect(response.engine.advisories).toHaveLength(1);
      expect(response.engine.advisories[0].matched_memory_id).toBe(REQUESTED_MEMORY);
      // 被丢的块里的 case **不会**被计入 case 级计数（它是块级的丢弃）
      expect(response.filteredCaseCount).toBe(0);
      expect(response.unmappedCaseCount).toBe(0);
      // 被丢的块也不该贡献任何批式过滤输入：入参是**空数组**（mem-3 的 1 条 ref 不在里面）
      expect((access.evaluateSourceRefs as jest.Mock).mock.calls[1][1] as unknown[]).toHaveLength(
        0,
      );
    });

    it('**case 字段缺席（合同破损）**⇒ 归因失败，计入 `filteredCaseCount` 而**不是** `unmappedCaseCount`', async () => {
      const mapping = new Map([
        [REQUESTED_MEMORY, buildRow(LEDGER_1)],
        ['mem-2', buildRow(LEDGER_2)],
      ]);
      const { service } = buildService({
        mapping,
        relationsResult: buildRelationsResult(REQUESTED_MEMORY, [
          buildRelationAdvisory(
            REQUESTED_MEMORY,
            [
              // 缺 `new_memory_id`（归一化只保证 `cases` 是数组，不逐字段校验元素）
              buildCaseMissingField('new_memory_id'),
              // 缺 `old_memory_id`
              buildCaseMissingField('old_memory_id'),
              // 对照：一条完整的（证明前两条不是"全丢"）
              buildRelationCase('mem-2', 'new-side'),
            ],
            { candidateCount: 3 },
          ),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, REQUESTED_MEMORY);

      // ⚠️ 两类丢 case 的**成因不同**：合同破损（归因失败）≠ 另一条记忆没有映射（数据可疑）。
      //    若 `otherSideMemoryId` 把 `undefined` 漏出去，前两条会落到 `byMemoryId.get(undefined)`
      //    ⇒ 这里会变成 unmappedCaseCount = 2（这条断言就是那个回归的守卫）。
      expect(response.filteredCaseCount).toBe(2);
      expect(response.unmappedCaseCount).toBe(0);
      expect(response.engine.advisories[0].cases).toHaveLength(1);
    });

    it('case 过滤：另一侧未映射 ⇒ unmappedCaseCount（**丢弃** case，advisory 保留）', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1)]]);
      const { service } = buildService({
        mapping,
        relationsResult: buildRelationsResult('mem-1', [
          buildRelationAdvisory(
            'mem-1',
            [
              buildRelationCase('mem-unknown-1', 'new-side'),
              buildRelationCase('mem-unknown-2', 'new-side'),
            ],
            { candidateCount: 7 },
          ),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1');
      expect(response.unmappedCaseCount).toBe(2);
      expect(response.filteredCaseCount).toBe(0);
      expect(response.filteredByPermission).toBe(false);
      // advisory 块本身保留（它描述的是**已过 404 闸门**的这条记忆的作业）
      expect(response.engine.advisories).toHaveLength(1);
      expect(response.engine.advisories[0].cases).toEqual([]);
      // 引擎口径的候选数**不减**（7 ≠ 0——它不是过滤后 cases 的分母）
      expect(response.engine.advisories[0].coverage.candidate_count).toBe(7);
    });

    it('case 过滤：另一侧来源不可见 ⇒ filteredCaseCount + 布尔；**其余 case 照常保留**（切片不串位）', async () => {
      // 三个 case：mem-2 不可见、mem-3 可见、mem-4 无来源（纯著述 ⇒ 恒可见）
      const mapping = new Map([
        ['mem-1', buildRow(LEDGER_1)],
        ['mem-2', buildRow(LEDGER_2, [{ type: 'doc', id: DOC_ID }])],
        ['mem-3', buildRow('cccccccc-3333-4333-8333-333333333333', [{ type: 'doc', id: DOC_ID }])],
        ['mem-4', buildRow('dddddddd-4444-4444-8444-444444444444')],
      ]);
      // 可见性按 `evaluateSourceRefs` 的入参序：mem-2 的 1 条 ref 不可见，mem-3 的 1 条可见，
      // mem-4 无 ref（不进 verdicts）⇒ 只有 index 0 判 false
      const { service, access } = buildService({
        mapping,
        visible: (index) => index !== 0,
        relationsResult: buildRelationsResult('mem-1', [
          buildRelationAdvisory('mem-1', [
            buildRelationCase('mem-2', 'new-side'),
            buildRelationCase('mem-3', 'new-side'),
            buildRelationCase('mem-4', 'new-side'),
          ]),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1');

      expect(response.filteredByPermission).toBe(true);
      expect(response.filteredCaseCount).toBe(1);
      expect(response.unmappedCaseCount).toBe(0);
      const kept = response.engine.advisories[0].cases;
      expect(kept.map((item) => item.old_memory_id)).toEqual(['mem-3', 'mem-4']);
      // 批式：**两次**调用——① 该记忆自己的 404 闸门（`resolveMemoryContext`）② 全部候选 case
      // 的**一次**批式过滤。逐 case 调用会是 1 + N 次（N 次 8 表预载），而 N 在引擎侧是有界的
      // 大数——这条断言 + 下一条"入参拼平"的断言合起来才是"批式"的证据。
      expect(access.evaluateSourceRefs).toHaveBeenCalledTimes(2);
      const caseRefs = (access.evaluateSourceRefs as jest.Mock).mock.calls[1][1] as unknown[];
      expect(caseRefs).toHaveLength(2); // mem-2 与 mem-3 各 1 条 ref；mem-4 是纯著述（0 条）
    });

    it('**多 advisory 交叉切片不串位**：new-side 与 old-side 混排 + 每块 refs 条数不同 ⇒ 切片按各自长度推进', async () => {
      // 块①（new-side）case 依次指向：m2（1 ref，不可见）、m3（2 refs，可见）、m4（0 ref，可见）
      // 块②（old-side）case 指向：m5（1 ref，可见）
      // refs 拼平后的顺序 = [m2.r0, m3.r0, m3.r1, m5.r0]，可见性只让 m2 那条 false
      const mapping = new Map([
        [REQUESTED_MEMORY, buildRow(LEDGER_1)],
        ['m2', buildRow(LEDGER_2, [{ type: 'doc', id: DOC_ID }])],
        [
          'm3',
          buildRow('cccccccc-3333-4333-8333-333333333333', [
            { type: 'doc', id: DOC_ID },
            { type: 'doc', id: DOC_ID },
          ]),
        ],
        ['m4', buildRow('dddddddd-4444-4444-8444-444444444444')],
        ['m5', buildRow('eeeeeeee-5555-4555-8555-555555555555', [{ type: 'doc', id: DOC_ID }])],
      ]);
      const { service, access } = buildService({
        mapping,
        visible: (index) => index !== 0,
        relationsResult: buildRelationsResult(REQUESTED_MEMORY, [
          buildRelationAdvisory(REQUESTED_MEMORY, [
            buildRelationCase('m2', 'new-side'),
            buildRelationCase('m3', 'new-side'),
            buildRelationCase('m4', 'new-side'),
          ]),
          buildRelationAdvisory('m5', [buildRelationCase('m5', 'old-side')], {
            matchedMemoryId: REQUESTED_MEMORY,
          }),
        ]),
      });

      const response = await service.getMemoryRelations(agentActor(), PROJECT_ID, REQUESTED_MEMORY);

      // ⚠️ 关键：m3 的**两条** refs 必须整体判可见（切片按行推进），否则会把 m5 的 ref 当成
      //    m3 的第二条 ⇒ 串位后可见性判定张冠李戴（这里 m3 可见 / m5 可见 ⇒ 两块都留 case）
      expect(access.evaluateSourceRefs).toHaveBeenCalledTimes(2);
      expect((access.evaluateSourceRefs as jest.Mock).mock.calls[1][1] as unknown[]).toHaveLength(
        4,
      );
      expect(response.filteredCaseCount).toBe(1);
      expect(response.engine.advisories).toHaveLength(2);
      expect(response.engine.advisories[0].cases.map((item) => item.old_memory_id)).toEqual([
        'm3',
        'm4',
      ]);
      expect(response.engine.advisories[1].cases.map((item) => item.new_memory_id)).toEqual(['m5']);
      // 块②的 matched 是本请求（old-side 形状）⇒ 不该被块级守卫丢
      expect(response.droppedAdvisoryCount).toBe(0);
    });

    it('两档错误分派：`http`/`invalid_response` ⇒ 502/14004 + engineCode；`timeout`/`unreachable` ⇒ 503/14000', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1)]]);

      for (const failure of [
        {
          kind: 'http',
          message: 'boom',
          httpStatus: 403,
          engineCode: 'scope_denied',
          latencyMs: 1,
        },
        { kind: 'invalid_response', message: 'broken', latencyMs: 1 },
      ]) {
        const { service } = buildService({
          mapping,
          relationsResult: { ok: false, failure },
        });
        await expect(
          service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1'),
        ).rejects.toMatchObject({
          status: 502,
          response: {
            code: ErrorCode.MEMORY_ENGINE_ERROR,
            data: { engineCode: failure.engineCode },
          },
        });
      }

      const timeout = buildService({
        mapping,
        relationsResult: {
          ok: false,
          failure: { kind: 'timeout', message: 'slow', latencyMs: 1 },
        },
      });
      await expect(
        timeout.service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1'),
      ).rejects.toMatchObject({
        status: 503,
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT },
        },
      });

      const unreachable = buildService({
        mapping,
        relationsResult: {
          ok: false,
          failure: { kind: 'unreachable', message: 'down', latencyMs: 1 },
        },
      });
      await expect(
        unreachable.service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1'),
      ).rejects.toMatchObject({
        status: 503,
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE },
        },
      });
    });

    it('引擎调用形状：`(target, engineMemoryId)`——**没有** query 参数可传', async () => {
      const mapping = new Map([['mem-1', buildRow(LEDGER_1)]]);
      const { service, engine } = buildService({ mapping });

      await service.getMemoryRelations(agentActor(), PROJECT_ID, 'mem-1');

      expect((engine as { getMemoryRelations: jest.Mock }).getMemoryRelations).toHaveBeenCalledWith(
        { workspaceId: 'ws-1', actorId: 'act-1', credentialRef: 'cred-1' },
        'mem-1',
      );
    });
  });
});

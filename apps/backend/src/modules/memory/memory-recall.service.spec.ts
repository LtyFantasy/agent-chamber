/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **召回与记忆详情**的服务级单测：`engine_memory_ids → canonical 账本行` 映射构建、
 *     来源权限批式过滤、`emptyReason` 三值互斥、`engineDataSuspect` 三件套、信任框信封、
 *     召回的失败分派（503 vs 502）与"失败也落遥测"
 *
 * [代码职责]
 *   - 把"映射只认 canonical 行""任一来源不可见 ⇒ 整项丢弃""`moved` 只对 doc 有定义"
 *     "`query` 摘要恒落 + 原文随项目开关"钉成可执行事实——这些在 e2e 里只跑得到主链路，
 *     同 id 冲突 / 在途行 / 三值分支要靠本套件
 *
 * [权威文档]
 *   - 判据单源 = `memory-recall.service.ts` 的 [关键不变量]
 *
 * [关键不变量]
 *   - **alias 行天然排除**：`engine_memory_ids` 恒空 ⇒ 按 ids 建映射天然不认它；
 *     **同一 id 出现在两行 ⇒ fail-closed**（删映射 + warn，宁可过滤也不指向不确定的行）
 *   - **`engineDataSuspect` 三件套**：`unmapped>0` ∧ 有 committed 行 ∧ **无在途行**
 *     （在途行能解释"映射不到的条目"，此时喊狼来了会让消费方怀疑整批数据）
 *   - **`emptyReason` 三值互斥**：有结果 `none` / 引擎零结果 `no_matches` /
 *     有结果但全被过滤 `all_filtered`
 *   - **`filtered_count` 只落遥测**（精确条数会泄露"有多少条你看不到"），响应只给布尔
 *   - **`query` 的两列语义**：`query_hash`（sha256）**恒落**；`query_text`（原文）当且仅当
 *     `project.retain_query_text=true` 时落原文，否则 **NULL（不是空串）**。
 *     失败行同样适用（失败也落遥测 = 引擎可用性率的分母）
 *   - **召回失败也落遥测**（本表是引擎可用性率的分母）：不可用 = `unavailable`，
 *     超时 = `timeout`；拿到错误体 ⇒ 502/14004（本端点无账本态可回报），
 *     超时/不可达 ⇒ 503/14000
 *
 * [关联代码]
 *   - ./memory-recall.service.ts — 被测实现
 *   - ./memory-access.service.ts — 可见性判据（本套件以假件替代，只验编排与切片）
 *   - ./memory.constants.ts — 信任框与 14000/14004 错误构造器
 *
 * [修改检查]
 *   □ 改过滤/映射必须同步三处同源 e2e（召回 / 账本 / 详情）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { createHash } from 'node:crypto';
import type { Repository } from 'typeorm';
import {
  ActorType,
  ErrorCode,
  MEMORY_ENGINE,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_RECALL_EMPTY_REASON,
  MEMORY_RECALL_VIEW,
  MEMORY_UNAVAILABLE_REASON,
} from '@agent-chamber/shared';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryRecallEvent } from '../../database/entities/memory-recall-event.entity';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import { MemoryAccessService } from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryFormationService } from './memory-formation.service';
import { MemoryRecallService } from './memory-recall.service';
import { MEMORY_DECISION_AUTHORITY, MEMORY_TRUST_LEVEL } from './dto/memory-contract';
import type {
  HumentRecallItem,
  MemoryEngine as MemoryEnginePort,
} from './engines/memory-engine.interface';

const ACTOR_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const LEDGER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DOC_ID = 'dddddddd-4444-4444-8444-444444444444';
const FROZEN_HASH = 'frozenhash000000000000000000000000000000000000000000000000000000';
const CURRENT_HASH = 'currenthash00000000000000000000000000000000000000000000000000000';

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
    // 库侧默认 true（`memory_projects.retain_query_text`）：假件必须带上它，
    // 否则"原文落库"分支在单测里恒走 NULL 侧，测不出默认开的行为
    retainQueryText: true,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as MemoryProject;
}

/** 造一条账本行（默认 = committed + 一个 doc 来源 + 两个引擎记忆 id） */
function buildLedgerRow(overrides: Partial<MemoryNomination> = {}): MemoryNomination {
  return {
    id: LEDGER_ID,
    projectId: PROJECT_ID,
    category: 'ruling',
    subject: '主体',
    scope: '范围',
    contentTruncated: false,
    status: MEMORY_NOMINATION_STATUS.ACTIVE,
    formationState: MEMORY_FORMATION_STATE.COMMITTED,
    reviewAt: null,
    sourceRefs: [{ type: 'doc', id: DOC_ID, versionHash: FROZEN_HASH, parentId: 'space-1' }],
    engineMemoryIds: ['mem-1', 'mem-2'],
    ...overrides,
  } as MemoryNomination;
}

/** 造一个 Hument 召回条目（合同镜像；本套件只消费其中几个字段） */
function recallItem(memoryId: string, overrides: Record<string, unknown> = {}): HumentRecallItem {
  return {
    memory_id: memoryId,
    namespace_id: 'ns-1',
    representation_id: 'rep-1',
    kind: 'ruling',
    scope: 'scope',
    resolution: 'chosen',
    available_resolution: 'chosen',
    active_resolution: 'chosen',
    body: '引擎侧正文（不应被采纳）',
    digest: 'digest',
    score: 1,
    byte_estimate: 10,
    token_estimate: 10,
    anchor_state: 'fresh',
    current: true,
    memory_status: 'active',
    currentness_digest: 'd',
    anchor_projection_digest: 'd',
    ...overrides,
  } as HumentRecallItem;
}

/** 组装被测服务（access / project / formation / engine 全部以假件注入） */
function buildService(
  options: {
    rows?: MemoryNomination[];
    contents?: Array<{ id: string; content: string }>;
    visible?: (index: number) => boolean;
    currentVersionHash?: string | null;
    recallResult?: unknown;
    readResult?: unknown;
    availability?: { engine: string; available: boolean; reason: string | null };
    engine?: unknown;
    /** 项目实体覆盖（默认 `buildProject()` = 原文留存开关为 true） */
    project?: MemoryProject;
  } = {},
) {
  const rows = options.rows ?? [buildLedgerRow()];

  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  const nominations = {
    createQueryBuilder: jest.fn(() => qb),
    query: jest.fn(async () => options.contents ?? [{ id: LEDGER_ID, content: '账本冻结正文' }]),
  };
  const recallEvents = {
    create: jest.fn((payload: unknown) => payload),
    save: jest.fn(async (payload: unknown) => payload),
  };
  const access = {
    assertProjectContentRead: jest.fn(async () => undefined),
    // ⚠️ 映射表现在由 **access 层**提供（`loadMemoryIdMapping` 已下沉）：本套件只按
    //   "ids → 行" 建一份**最小**映射（撤回行排除，照实现的 SQL 谓词），映射语义的细节
    //   （冲突 fail-closed / flags）由 `memory-access.service.spec.ts` 承担——两处各测一份
    //   就等于把第二份实现搬回测试里。
    loadMemoryIdMapping: jest.fn(async () => {
      const byMemoryId = new Map<string, MemoryNomination>();
      let hasCommitted = false;
      let hasInFlight = false;
      for (const row of rows) {
        if (row.status === MEMORY_NOMINATION_STATUS.WITHDRAWN) continue;
        if (row.formationState === MEMORY_FORMATION_STATE.COMMITTED) hasCommitted = true;
        if (row.formationState === MEMORY_FORMATION_STATE.SUBMITTED) hasInFlight = true;
        for (const memoryId of row.engineMemoryIds ?? []) {
          // 冲突 fail-closed 的**可见后果**（条目落 unmapped ⇒ emptyReason=all_filtered）由本套件
          // 的用例守着，故这条规则在假件里保留；映射本身的其他语义见 access spec。
          if (byMemoryId.has(memoryId)) {
            byMemoryId.delete(memoryId);
            continue;
          }
          byMemoryId.set(memoryId, row);
        }
      }
      return { byMemoryId, hasCommitted, hasInFlight };
    }),
    evaluateSourceRefs: jest.fn(
      async (_actor: unknown, refs: Array<{ type: string; id: string }>) =>
        refs.map((_ref, index) => ({
          visible: options.visible ? options.visible(index) : true,
          currentVersionHash:
            options.currentVersionHash === undefined ? null : options.currentVersionHash,
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
    toSourceRefProjection: jest.fn((ref: { type: string; id: string; versionHash?: string }) => ({
      type: ref.type,
      id: ref.id,
      parent: null,
      versionHash: ref.versionHash ?? null,
      headingPath: null,
      locator: `chamber://${ref.type}/${ref.id}`,
      moved: false,
      readWith: { tool: 'read_doc', params: { docId: ref.id } },
    })),
  };

  const service = new MemoryRecallService(
    nominations as unknown as Repository<MemoryNomination>,
    recallEvents as unknown as Repository<MemoryRecallEvent>,
    access as unknown as MemoryAccessService,
    projectService as unknown as MemoryProjectService,
    formation as unknown as MemoryFormationService,
    (options.engine === undefined
      ? {
          recall: jest.fn(
            async () =>
              options.recallResult ?? {
                ok: true,
                value: { recallId: 'recall-1', presentationEventId: 'pe-1', items: [], trace: {} },
              },
          ),
          readMemory: jest.fn(
            async () =>
              options.readResult ?? {
                ok: true,
                value: {
                  memory: { memory_id: 'mem-1' },
                  representations: [],
                  anchors: [],
                  partial: false,
                },
              },
          ),
        }
      : options.engine) as unknown as MemoryEnginePort | null,
  );

  return { service, nominations, qb, recallEvents, access, projectService, formation, project };
}

/** 召回入参（query 只有本套件用得到） */
function recallDto(overrides: Record<string, unknown> = {}) {
  return {
    query: '权限前移到内容返回边界',
    contextIdentity: 'ctx',
    contextEpoch: 1,
    ...overrides,
  } as never;
}

/** 取最近一次落库的召回遥测载荷 */
function lastRecallEvent(recallEvents: { create: jest.Mock }) {
  const calls = recallEvents.create.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

describe('MemoryRecallService（召回与记忆详情）', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 映射表构建已**迁出**：`loadMemoryIdMapping` 下沉 `memory-access.service.ts`
  // （读面是第二个消费方）；它的三个用例与铁律 #23 列名断言随之迁到
  // `memory-access.service.spec.ts` 的 `loadMemoryIdMapping` describe。
  // ══════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════
  // 引擎闸与失败分派
  // ══════════════════════════════════════════════════════════════════════
  describe('recall 的失败面', () => {
    it('引擎不可用 ⇒ **先落一行遥测**（unavailable / 全零）再 503/14000', async () => {
      const { service, recallEvents, access } = buildService({
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(service.recall(agentActor(), PROJECT_ID, recallDto())).rejects.toMatchObject({
        status: 503,
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND },
        },
      });

      // 失败也是分母：本表是引擎可用性率的来源
      expect(lastRecallEvent(recallEvents)).toMatchObject({
        projectId: PROJECT_ID,
        outcome: 'unavailable',
        itemCount: 0,
        filteredCount: 0,
        unmappedCount: 0,
        engineRecallId: null,
      });
      // 内容闸门在引擎闸之前（治理观察者不该走到这里）
      expect(access.assertProjectContentRead).toHaveBeenCalled();
    });

    it('内容读闸门拒绝（治理观察者 / 无权）⇒ 不落遥测、不调引擎', async () => {
      const { service, access, recallEvents } = buildService({});
      access.assertProjectContentRead.mockRejectedValueOnce(
        Object.assign(new Error('content closed'), { status: 403 }),
      );

      await expect(service.recall(agentActor(), PROJECT_ID, recallDto())).rejects.toThrow(
        'content closed',
      );
      expect(recallEvents.save).not.toHaveBeenCalled();
    });

    it('客户端超时 ⇒ 遥测 timeout + 503/14000 reason=engine_timeout（**不是 502**）', async () => {
      const { service, recallEvents } = buildService({
        recallResult: {
          ok: false,
          failure: { kind: 'timeout', message: 'timed out', latencyMs: 90000 },
        },
      });

      await expect(service.recall(agentActor(), PROJECT_ID, recallDto())).rejects.toMatchObject({
        status: 503,
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT },
        },
      });
      expect(lastRecallEvent(recallEvents)).toMatchObject({ outcome: 'timeout' });
    });

    it('连接未达 ⇒ 遥测 unavailable + 503 reason=engine_unreachable', async () => {
      const { service, recallEvents } = buildService({
        recallResult: {
          ok: false,
          failure: { kind: 'unreachable', message: 'ECONNREFUSED', latencyMs: 3 },
        },
      });

      await expect(service.recall(agentActor(), PROJECT_ID, recallDto())).rejects.toMatchObject({
        status: 503,
        response: { data: { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE } },
      });
      expect(lastRecallEvent(recallEvents)).toMatchObject({ outcome: 'unavailable' });
    });

    it.each([
      ['http（拿到错误体）', { kind: 'http', httpStatus: 409, engineCode: 'quota_exceeded' }],
      ['invalid_response（2xx 但体不可解析）', { kind: 'invalid_response' }],
    ])('%s ⇒ 502/14004（本端点无账本态可回报）+ requestId 落遥测', async (_label, failure) => {
      const { service, recallEvents } = buildService({
        recallResult: {
          ok: false,
          failure: { ...failure, message: 'engine refused', requestId: 'req-1', latencyMs: 5 },
        },
      });

      await expect(service.recall(agentActor(), PROJECT_ID, recallDto())).rejects.toMatchObject({
        status: 502,
        response: { code: ErrorCode.MEMORY_ENGINE_ERROR },
      });
      expect(lastRecallEvent(recallEvents)).toMatchObject({
        outcome: 'unavailable',
        requestId: 'req-1',
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 成功路径：映射 → 权限过滤 → 装配
  // ══════════════════════════════════════════════════════════════════════
  describe('recall 的成功路径', () => {
    it('正文取**账本冻结原文**（不是引擎条目 body），并带信任框三件套', async () => {
      const { service } = buildService({
        recallResult: {
          ok: true,
          value: {
            recallId: 'recall-1',
            presentationEventId: 'pe-1',
            // `score` 刻意取一个**不同于引擎缺省/兜底常量**的值（7）：这是唯一能区分
            // "原值透传"与"本层造了个常量"的位置（e2e 的 fake 引擎恒 1，区分不出来）
            items: [recallItem('mem-1', { score: 7 })],
            trace: {},
          },
        },
      });

      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());

      expect(response.items).toHaveLength(1);
      expect(response.items[0].body).toBe('账本冻结正文');
      // 引擎词面排序权重**原值透传**（不归一化、不兜底）
      expect(response.items[0].score).toBe(7);
      expect(response.items[0]).toMatchObject({
        memoryId: 'mem-1',
        ledgerId: LEDGER_ID,
        category: 'ruling',
        subject: '主体',
        derivation: 'sourced',
        reviewDue: false,
      });
      expect(response).toMatchObject({
        emptyReason: MEMORY_RECALL_EMPTY_REASON.NONE,
        filteredByPermission: false,
        recallId: 'recall-1',
        presentationEventId: 'pe-1',
        trustLevel: MEMORY_TRUST_LEVEL,
        decisionAuthority: MEMORY_DECISION_AUTHORITY,
      });
      expect(response.usageNote.length).toBeGreaterThan(0);
    });

    it('纯著述（无来源）⇒ derivation=authorship', async () => {
      const { service } = buildService({
        rows: [buildLedgerRow({ sourceRefs: [] })],
        contents: [{ id: LEDGER_ID, content: '纯著述正文' }],
        recallResult: {
          ok: true,
          value: { recallId: 'r', items: [recallItem('mem-1')], trace: {} },
        },
      });

      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());

      expect(response.items[0].derivation).toBe('authorship');
      expect(response.items[0].sources).toEqual([]);
    });

    it('来源不可见 ⇒ 整项丢弃 + filteredByPermission=true（精确条数只落遥测）', async () => {
      const { service, recallEvents } = buildService({
        visible: () => false,
        recallResult: {
          ok: true,
          value: { recallId: 'r', items: [recallItem('mem-1')], trace: {} },
        },
      });

      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());

      expect(response.items).toEqual([]);
      expect(response.emptyReason).toBe(MEMORY_RECALL_EMPTY_REASON.ALL_FILTERED);
      expect(response.filteredByPermission).toBe(true);
      // 计数不进响应体（防反推不可见资源的存在性）
      expect(response).not.toHaveProperty('filteredCount');
      expect(lastRecallEvent(recallEvents)).toMatchObject({
        outcome: 'ok',
        itemCount: 1, // 过滤**前**的引擎条数
        filteredCount: 1,
        unmappedCount: 0,
      });
    });

    it('引擎零结果 ⇒ emptyReason=no_matches（200 不是错误）', async () => {
      const { service, recallEvents } = buildService({
        recallResult: { ok: true, value: { recallId: 'r', items: [], trace: {} } },
      });

      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());

      expect(response.emptyReason).toBe(MEMORY_RECALL_EMPTY_REASON.NO_MATCHES);
      expect(response.filteredByPermission).toBe(false);
      expect(lastRecallEvent(recallEvents)).toMatchObject({ outcome: 'ok', itemCount: 0 });
    });

    it('映射不到的条目只算 unmapped（不计入 filtered）', async () => {
      const { service, recallEvents } = buildService({
        recallResult: {
          ok: true,
          value: {
            recallId: 'r',
            items: [recallItem('mem-1'), recallItem('mem-unknown')],
            trace: {},
          },
        },
      });

      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());

      expect(response.items).toHaveLength(1);
      expect(response.emptyReason).toBe(MEMORY_RECALL_EMPTY_REASON.NONE);
      expect(response.filteredByPermission).toBe(false);
      expect(lastRecallEvent(recallEvents)).toMatchObject({ unmappedCount: 1, filteredCount: 0 });
    });

    it('同一 memory_id 冲突 ⇒ 该条目落到 unmapped（fail-closed 的可见后果）', async () => {
      const { service } = buildService({
        rows: [
          buildLedgerRow({ id: 'led-a', engineMemoryIds: ['mem-1'] }),
          buildLedgerRow({ id: 'led-b', engineMemoryIds: ['mem-1'] }),
        ],
        recallResult: {
          ok: true,
          value: { recallId: 'r', items: [recallItem('mem-1')], trace: {} },
        },
      });

      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());

      expect(response.items).toEqual([]);
      expect(response.emptyReason).toBe(MEMORY_RECALL_EMPTY_REASON.ALL_FILTERED);
    });

    it('`moved` 只对 doc 有定义：当前 hash ≠ 冻结 ⇒ true，且**不**改写非 doc 类型', async () => {
      const messageRow = buildLedgerRow({
        id: 'led-msg',
        sourceRefs: [{ type: 'message', id: 'msg-1' }],
        engineMemoryIds: ['mem-msg'],
      });
      const { service } = buildService({
        rows: [buildLedgerRow(), messageRow],
        contents: [
          { id: LEDGER_ID, content: 'a' },
          { id: 'led-msg', content: 'b' },
        ],
        currentVersionHash: CURRENT_HASH,
        recallResult: {
          ok: true,
          value: { recallId: 'r', items: [recallItem('mem-1'), recallItem('mem-msg')], trace: {} },
        },
      });

      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());

      // doc：当前 hash ≠ 冻结 versionHash ⇒ moved
      expect(response.items[0].sources[0].moved).toBe(true);
      expect(response.items[0].sources[0].versionHash).toBe(FROZEN_HASH);
      // message：无版本列 ⇒ 恒 false（给它编 hash = "来源未改"永假）
      expect(response.items[1].sources[0].moved).toBe(false);
      expect(response.items[1].sources[0].versionHash).toBeNull();
    });

    it('遥测：query_hash 恒落 sha256；项目开关开 ⇒ 同时落原文', async () => {
      const query = '含业务隐私的查询词';
      const { service, recallEvents } = buildService({
        recallResult: { ok: true, value: { recallId: 'r', items: [], trace: {} } },
      });

      await service.recall(agentActor(), PROJECT_ID, recallDto({ query }));

      const payload = lastRecallEvent(recallEvents);
      expect(payload.queryHash).toBe(createHash('sha256').update(query, 'utf8').digest('hex'));
      expect(payload.actorId).toBe(ACTOR_ID);
      expect(payload.view).toBe(MEMORY_RECALL_VIEW.CURRENT); // 缺省视图
      // 开关默认开（buildProject 带 retainQueryText=true）⇒ 原文**照落**：
      // 这正是"会话压缩后排障不再断链"的那一条
      expect(payload.queryText).toBe(query);
    });

    it('项目关掉 retainQueryText ⇒ query_text 落 **NULL**（不是空串），query_hash 照旧', async () => {
      const query = '关掉开关也要能对账的查询词';
      const { service, recallEvents } = buildService({
        project: buildProject({ retainQueryText: false }),
        recallResult: { ok: true, value: { recallId: 'r', items: [], trace: {} } },
      });

      await service.recall(agentActor(), PROJECT_ID, recallDto({ query }));

      const payload = lastRecallEvent(recallEvents);
      // NULL 而非 ''：空串会被读成"查了一个空查询"，与"没留存"必须一眼可分
      expect(payload.queryText).toBeNull();
      expect(payload.queryHash).toBe(createHash('sha256').update(query, 'utf8').digest('hex'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 召回遥测的 query 两列：原文规则**没有"成功路径特例"**
  // ══════════════════════════════════════════════════════════════════════

  describe('召回遥测 query_text 规则（失败行同样受开关支配）', () => {
    it('引擎不可用（失败也落遥测）⇒ 关开关时原文列同样为 NULL', async () => {
      const query = '引擎不可用时的查询词';
      const { service, recallEvents } = buildService({
        project: buildProject({ retainQueryText: false }),
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(
        service.recall(agentActor(), PROJECT_ID, recallDto({ query })),
      ).rejects.toMatchObject({ status: 503 });

      expect(lastRecallEvent(recallEvents)).toMatchObject({
        outcome: 'unavailable',
        queryText: null,
      });
    });

    it('开关开着时失败行也落原文（排障最需要的就是"引擎挂了时我问的是什么"）', async () => {
      const query = '引擎不可用时的查询词（留存开）';
      const { service, recallEvents } = buildService({
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(
        service.recall(agentActor(), PROJECT_ID, recallDto({ query })),
      ).rejects.toMatchObject({ status: 503 });

      expect(lastRecallEvent(recallEvents)).toMatchObject({
        outcome: 'unavailable',
        queryText: query,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // engineDataSuspect：三件套（unmapped>0 ∧ 有 committed ∧ 无在途行）
  // ══════════════════════════════════════════════════════════════════════
  describe('engineDataSuspect', () => {
    /** 引擎返回一条映射不到的条目 + 本项目的行集合 */
    function suspectHarness(rows: MemoryNomination[]) {
      return buildService({
        rows,
        recallResult: {
          ok: true,
          value: { recallId: 'r', items: [recallItem('mem-orphan')], trace: {} },
        },
      });
    }

    it('unmapped>0 ∧ 有 committed 行 ∧ 无在途行 ⇒ true', async () => {
      const { service } = suspectHarness([buildLedgerRow()]);
      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());
      expect(response.engineDataSuspect).toBe(true);
    });

    it('存在在途行（submitted）⇒ **不喊狼来了**（在途能解释未映射）', async () => {
      const { service } = suspectHarness([
        buildLedgerRow(),
        buildLedgerRow({
          id: 'inflight',
          engineMemoryIds: null,
          formationState: MEMORY_FORMATION_STATE.SUBMITTED,
        }),
      ]);
      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());
      expect(response.engineDataSuspect).toBe(false);
    });

    it('本项目无 committed 行 ⇒ false（可能是刚绑定引擎、还没形成过记忆）', async () => {
      const { service } = suspectHarness([
        buildLedgerRow({ engineMemoryIds: null, formationState: MEMORY_FORMATION_STATE.FAILED }),
      ]);
      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());
      expect(response.engineDataSuspect).toBe(false);
    });

    it('unmapped=0 ⇒ false（正常召回不该触发可疑标记）', async () => {
      const { service } = buildService({
        recallResult: {
          ok: true,
          value: { recallId: 'r', items: [recallItem('mem-1')], trace: {} },
        },
      });
      const response = await service.recall(agentActor(), PROJECT_ID, recallDto());
      expect(response.engineDataSuspect).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 记忆详情：双 404 + 引擎三层透传
  // ══════════════════════════════════════════════════════════════════════
  describe('getMemory', () => {
    it('本项目没有映射该 memory_id 的行 ⇒ 404/14003（不确认存在性）', async () => {
      const { service } = buildService({});

      await expect(
        service.getMemory(agentActor(), PROJECT_ID, 'mem-unknown'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND },
      });
    });

    it('**任一来源不可见 ⇒ 404**（防撤权逃逸：授权过 → 撤权 → 仍能读冻结正文）', async () => {
      const { service, formation } = buildService({ visible: () => false });
      const engine = (service as unknown as { engine: { readMemory: jest.Mock } }).engine;

      await expect(service.getMemory(agentActor(), PROJECT_ID, 'mem-1')).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND },
      });
      // 权限判定在引擎调用**之前**：撤权后连引擎都不该问
      expect(engine.readMemory).not.toHaveBeenCalled();
      expect(formation.engineTarget).not.toHaveBeenCalled();
    });

    it('引擎不可用 ⇒ 503/14000（在映射与权限判定之后）', async () => {
      const { service } = buildService({
        availability: {
          engine: MEMORY_ENGINE.HUMENT,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(service.getMemory(agentActor(), PROJECT_ID, 'mem-1')).rejects.toMatchObject({
        status: 503,
        response: { data: { reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND } },
      });
    });

    it.each([
      [
        'http',
        { kind: 'http', httpStatus: 404, engineCode: 'memory_not_found' },
        502,
        ErrorCode.MEMORY_ENGINE_ERROR,
      ],
      ['timeout', { kind: 'timeout' }, 503, ErrorCode.MEMORY_UNAVAILABLE],
      ['unreachable', { kind: 'unreachable' }, 503, ErrorCode.MEMORY_UNAVAILABLE],
    ])('readMemory 失败（%s）⇒ %s/%s', async (_label, failure, status, code) => {
      const { service } = buildService({
        readResult: { ok: false, failure: { ...failure, message: 'engine failed', latencyMs: 9 } },
      });

      await expect(service.getMemory(agentActor(), PROJECT_ID, 'mem-1')).rejects.toMatchObject({
        status,
        response: { code },
      });
    });

    it('成功 ⇒ 账本元数据 + 引擎三层**逐字透传** + 冻结来源投影 + reviewDue', async () => {
      const { service } = buildService({
        rows: [buildLedgerRow({ reviewAt: new Date('2026-09-01T00:00:00.000Z') })],
        readResult: {
          ok: true,
          value: {
            memory: { memory_id: 'mem-1', status: 'active' },
            representations: [{ representation_id: 'rep-1' }],
            anchors: [{ anchor_id: 'anchor-1' }],
            partial: true,
          },
        },
      });

      const detail = await service.getMemory(agentActor(), PROJECT_ID, 'mem-1');

      expect(detail).toMatchObject({
        memoryId: 'mem-1',
        ledgerId: LEDGER_ID,
        category: 'ruling',
        subject: '主体',
        scope: '范围',
        reviewDue: true, // reviewAt 已到 ⇒ 仅提醒
        engine: {
          memory: { memory_id: 'mem-1', status: 'active' },
          representations: [{ representation_id: 'rep-1' }],
          anchors: [{ anchor_id: 'anchor-1' }],
          partial: true, // 引擎声明被裁剪 ⇒ 透出，不吞
        },
        trustLevel: MEMORY_TRUST_LEVEL,
        decisionAuthority: MEMORY_DECISION_AUTHORITY,
      });
      expect(detail.sources).toHaveLength(1);
      expect(detail.sources[0]).toMatchObject({
        type: 'doc',
        id: DOC_ID,
        versionHash: FROZEN_HASH,
      });
    });
  });
});

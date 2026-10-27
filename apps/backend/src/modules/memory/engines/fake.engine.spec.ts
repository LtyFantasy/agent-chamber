/**
 * `fake.engine` 单测（进程内确定性；**仅 test/e2e**）。
 *
 * 设计意图：FakeEngine 是 e2e 的可预测替身，**确定性是唯一硬指标**——
 * `memory_id = 'mem_' + sha256(workspaceId:content)[:16]`（同 workspace + 同正文 ⇒ 同 id，
 * 跨实例可复现），幂等键语义对齐 Hument（同键重发返回同一回执，不二次形成），
 * **内容级去重**（同正文的第二个账本键 ⇒ `duplicate=true` 的 alias 回执，不形成第二记忆、
 * 不覆盖既有记录——alias 镜像路径的引擎侧底座），更正记录 supersession
 * （§8 e2e"更正后 current 不命中旧主张"的判据来源）。
 */
import { createHash } from 'node:crypto';
import { FakeEngine } from './fake.engine';
import type { MemoryEngineTarget } from './memory-engine.interface';

const TARGET: MemoryEngineTarget = {
  workspaceId: 'ws-1',
  actorId: 'actor-1',
  credentialRef: 'cred-1',
};

/**
 * 期望的确定性 memory id（与实现同算法，但**独立写一遍**：同一份 sha256 派生）。
 *
 * ⚠️ 派生输入是 **`workspaceId:content`**，不是裸 content：方案 §1 的"每项目独立 workspace"
 * 意味着**同内容在两个 workspace 里是两条记忆**——只按 content 派生会让后一条顶掉前一条
 * （`memories` 表以 id 为键），换绑/越界用例的隔离语义随之失真。
 */
function expectedMemoryId(content: string, workspaceId: string = TARGET.workspaceId): string {
  return `mem_${createHash('sha256')
    .update(`${workspaceId}:${content}`, 'utf8')
    .digest('hex')
    .slice(0, 16)}`;
}

/** 提名入参基线 */
function nominateInput(overrides: Partial<{ ledgerId: string; content: string; category: string }> = {}) {
  return {
    ledgerId: overrides.ledgerId ?? 'led-1',
    category: overrides.category ?? 'ruling',
    content: overrides.content ?? '[ruling] 裁决正文',
    rationale: '因为',
    sourceLocators: [],
  };
}

describe('FakeEngine', () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine();
  });

  it('name=fake（与 config 值域同域）', () => {
    expect(engine.name).toBe('fake');
  });

  it('确定性：memory_id = mem_ + sha256(workspaceId:content)[:16]（跨实例同正文同 id）', async () => {
    const content = '[ruling] 同样一段正文';
    const first = await engine.nominate(TARGET, nominateInput({ content }));
    const other = new FakeEngine();
    const second = await other.nominate(TARGET, nominateInput({ ledgerId: 'led-other', content }));

    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(first.value.memoryIds).toEqual([expectedMemoryId(content)]);
    expect(second.value.memoryIds).toEqual([expectedMemoryId(content)]);

    // 同内容 + **不同 workspace** ⇒ 两条互不干扰的记忆（换绑/越界用例的隔离底座）
    const otherWorkspace: MemoryEngineTarget = { ...TARGET, workspaceId: 'ws-2' };
    const crossWorkspace = await engine.nominate(
      otherWorkspace,
      nominateInput({ ledgerId: 'led-ws2', content }),
    );
    if (!crossWorkspace.ok) throw new Error('unreachable');
    expect(crossWorkspace.value.memoryIds).toEqual([expectedMemoryId(content, 'ws-2')]);
    expect(crossWorkspace.value.memoryIds[0]).not.toBe(expectedMemoryId(content));
    // 后者的形成**没有顶掉**前者：ws-1 仍能按原 id 读回
    const firstMemoryId = first.value.memoryIds[0];
    const readBack = await engine.readMemory(TARGET, firstMemoryId);
    if (!readBack.ok) throw new Error('unreachable');
    expect(readBack.value.memory.memory_id).toBe(firstMemoryId);
    expect(readBack.value.memory.workspace_id).toBe('ws-1');

    // 不同正文 ⇒ 不同 id（不同 ledgerId 也不影响 id 的派生：id 只由 workspace+正文决定）
    const third = await engine.nominate(TARGET, nominateInput({ ledgerId: 'led-3', content: '别的正文' }));
    if (!third.ok) throw new Error('unreachable');
    expect(third.value.memoryIds[0]).not.toBe(expectedMemoryId(content));
  });

  it('提名即 committed（durable=true + 诊断轴齐全）', async () => {
    const result = await engine.nominate(TARGET, nominateInput());
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toMatchObject({
      duplicate: false,
      jobState: 'committed',
      deferred: false,
      outcome: 'memory_committed',
      reasonCode: 'memory_materialized',
      durable: true,
    });
    expect(result.value.engineNominationId).toMatch(/^nom_[0-9a-f]{16}$/);
  });

  it('幂等：同账本位 id 重发返回同一回执（不二次形成）', async () => {
    const first = await engine.nominate(TARGET, nominateInput());
    const second = await engine.nominate(TARGET, nominateInput());
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.value).toEqual(first.value);
  });

  it('内容级去重：同 workspace + 同正文的第二个账本键 ⇒ alias 回执（不形成第二记忆、不覆盖既有记录）', async () => {
    const content = '[ruling] 同一段正文';
    const canonical = await engine.nominate(
      TARGET,
      nominateInput({ ledgerId: 'l-canonical', content }),
    );
    if (!canonical.ok) throw new Error('unreachable');
    const canonicalMemoryId = canonical.value.memoryIds[0];

    const alias = await engine.nominate(TARGET, nominateInput({ ledgerId: 'l-alias', content }));
    if (!alias.ok) throw new Error('unreachable');
    expect(alias.value).toMatchObject({
      duplicate: true,
      // 镜像源 = canonical 的引擎提名 id；自己的提名 id 仍是**本条**账本派生
      canonicalNominationId: canonical.value.engineNominationId,
      memoryIds: [], // alias 恒不采纳 ids（引擎不形成记忆）
      deferred: false,
    });
    expect(alias.value.engineNominationId).not.toBe(canonical.value.engineNominationId);
    expect(alias.value.engineNominationId).toBe(
      `nom_${createHash('sha256').update('l-alias', 'utf8').digest('hex').slice(0, 16)}`,
    );

    // 判序：**幂等短路在去重之前**——同键重发拿到的是同一份 alias 回执（不是重新判一次）
    const replayed = await engine.nominate(TARGET, nominateInput({ ledgerId: 'l-alias', content }));
    if (!replayed.ok) throw new Error('unreachable');
    expect(replayed.value).toEqual(alias.value);

    // 既有记录**没被 alias 顶掉**：按 memoryId 反查仍指向 canonical 那条回执
    const inspected = await engine.inspectNomination(TARGET, { memoryId: canonicalMemoryId });
    if (!inspected.ok) throw new Error('unreachable');
    expect(inspected.value.engineNominationId).toBe(canonical.value.engineNominationId);
    expect(inspected.value.duplicate).toBe(false);

    // 召回面：同正文仍只有**一条**记忆（alias 不新增）
    const recalled = await engine.recall(TARGET, {
      query: '同一段正文',
      contextIdentity: 'ctx',
      contextEpoch: 0,
    });
    if (!recalled.ok) throw new Error('unreachable');
    expect(recalled.value.items.map((item) => item.memory_id)).toEqual([canonicalMemoryId]);

    // 换 workspace ⇒ **不判重复**（同正文在两个 workspace 是两条互不干扰的记忆）
    const otherWorkspace = await engine.nominate(
      { ...TARGET, workspaceId: 'ws-2' },
      nominateInput({ ledgerId: 'l-ws2', content }),
    );
    if (!otherWorkspace.ok) throw new Error('unreachable');
    expect(otherWorkspace.value.duplicate).toBe(false);
    expect(otherWorkspace.value.memoryIds).toHaveLength(1);
  });

  it('inspectNomination：按 nominationId / memoryId 反查；找不到 → 404（http）', async () => {
    const nominate = await engine.nominate(TARGET, nominateInput());
    if (!nominate.ok) throw new Error('unreachable');

    const byNomination = await engine.inspectNomination(TARGET, {
      nominationId: nominate.value.engineNominationId,
    });
    if (!byNomination.ok) throw new Error('unreachable');
    expect(byNomination.value).toEqual(nominate.value);

    const byMemory = await engine.inspectNomination(TARGET, {
      memoryId: nominate.value.memoryIds[0],
    });
    if (!byMemory.ok) throw new Error('unreachable');
    expect(byMemory.value.engineNominationId).toBe(nominate.value.engineNominationId);

    const missing = await engine.inspectNomination(TARGET, { nominationId: 'nom_absent' });
    if (missing.ok) throw new Error('unreachable');
    expect(missing.failure).toMatchObject({
      kind: 'http',
      httpStatus: 404,
      engineCode: 'resource_not_found',
      retryable: false,
    });
  });

  it('recall：content 子串匹配 + 同 workspace 隔离 + 确定性排序', async () => {
    await engine.nominate(TARGET, nominateInput({ ledgerId: 'l1', content: '裁决 A：用 ds flash' }));
    await engine.nominate(TARGET, nominateInput({ ledgerId: 'l2', content: '裁决 B：分支不合 main' }));
    await engine.nominate(
      { ...TARGET, workspaceId: 'ws-other' },
      nominateInput({ ledgerId: 'l3', content: '裁决 A 在别的项目' }),
    );

    const hit = await engine.recall(TARGET, {
      query: '裁决 A',
      contextIdentity: 'ctx',
      contextEpoch: 0,
    });
    if (!hit.ok) throw new Error('unreachable');
    expect(hit.value.items).toHaveLength(1);
    expect(hit.value.items[0].body).toBe('裁决 A：用 ds flash');
    // 合同 required 字段必须齐（e2e 直接消费这些字段）
    expect(hit.value.items[0]).toMatchObject({
      memory_id: expectedMemoryId('裁决 A：用 ds flash'),
      kind: 'concept',
      scope: 'workspace_shared',
      current: true,
      memory_status: 'active',
      anchor_state: 'none',
    });
    expect(hit.value.trace.selected_item_ids).toEqual([expectedMemoryId('裁决 A：用 ds flash')]);

    const noMatch = await engine.recall(TARGET, {
      query: '不存在的词',
      contextIdentity: 'ctx',
      contextEpoch: 0,
    });
    if (!noMatch.ok) throw new Error('unreachable');
    expect(noMatch.value.items).toEqual([]);
  });

  it('recall：预算截断（maxItems / maxTokens / maxBytes，确定性）', async () => {
    await engine.nominate(TARGET, nominateInput({ ledgerId: 'l1', content: '共同前缀 一' }));
    await engine.nominate(TARGET, nominateInput({ ledgerId: 'l2', content: '共同前缀 二' }));

    const limited = await engine.recall(TARGET, {
      query: '共同前缀',
      maxItems: 1,
      contextIdentity: 'ctx',
      contextEpoch: 0,
    });
    if (!limited.ok) throw new Error('unreachable');
    expect(limited.value.items).toHaveLength(1);

    const tiny = await engine.recall(TARGET, {
      query: '共同前缀',
      maxBytes: 1,
      contextIdentity: 'ctx',
      contextEpoch: 0,
    });
    if (!tiny.ok) throw new Error('unreachable');
    expect(tiny.value.items).toEqual([]);
  });

  it('correct：记录 supersession（旧记忆转 superseded）+ 幂等 replay + 404', async () => {
    const oldClaim = await engine.nominate(TARGET, nominateInput({ ledgerId: 'l-old', content: '旧主张' }));
    const newClaim = await engine.nominate(TARGET, nominateInput({ ledgerId: 'l-new', content: '新主张' }));
    if (!oldClaim.ok || !newClaim.ok) throw new Error('unreachable');
    const oldId = oldClaim.value.memoryIds[0];
    const newId = newClaim.value.memoryIds[0];

    const correction = await engine.correct(TARGET, {
      newLedgerId: 'l-correction',
      oldMemoryId: oldId,
      newMemoryId: newId,
      rationale: '被新裁决取代',
    });
    if (!correction.ok) throw new Error('unreachable');
    expect(correction.value.engineCorrectionId).toMatch(/^corr_[0-9a-f]{16}$/);
    expect(correction.value.replay).toBe(false);

    // 幂等重放：同键第二次 replay=true（中断续跑靠它判"已达成"）
    const replay = await engine.correct(TARGET, {
      newLedgerId: 'l-correction',
      oldMemoryId: oldId,
      newMemoryId: newId,
      rationale: '被新裁决取代',
    });
    if (!replay.ok) throw new Error('unreachable');
    expect(replay.value.replay).toBe(true);
    expect(replay.value.engineCorrectionId).toBe(correction.value.engineCorrectionId);

    // supersession 记录在**记忆内部**，且旧记忆状态转 superseded
    const read = await engine.readMemory(TARGET, oldId);
    if (!read.ok) throw new Error('unreachable');
    expect(read.value.memory.supersession).toEqual([newId]);
    expect(read.value.memory.status).toBe('superseded');

    // 默认视图不再召回旧主张；history 视图仍可见（§8 "更正后 current 不命中旧主张"）
    const current = await engine.recall(TARGET, {
      query: '主张',
      view: 'current',
      contextIdentity: 'ctx',
      contextEpoch: 0,
    });
    if (!current.ok) throw new Error('unreachable');
    expect(current.value.items.map((item) => item.body)).toEqual(['新主张']);

    const history = await engine.recall(TARGET, {
      query: '主张',
      view: 'history',
      contextIdentity: 'ctx',
      contextEpoch: 0,
    });
    if (!history.ok) throw new Error('unreachable');
    expect(history.value.items.map((item) => item.body).sort()).toEqual(['新主张', '旧主张']);

    const missing = await engine.correct(TARGET, {
      newLedgerId: 'l-x',
      oldMemoryId: 'mem_absent',
      newMemoryId: newId,
      rationale: 'x',
    });
    if (missing.ok) throw new Error('unreachable');
    expect(missing.failure.httpStatus).toBe(404);
  });

  it('inspectCorrection：按 correctionId / 幂等键反查', async () => {
    const oldClaim = await engine.nominate(TARGET, nominateInput({ ledgerId: 'l-old', content: 'A' }));
    const newClaim = await engine.nominate(TARGET, nominateInput({ ledgerId: 'l-new', content: 'B' }));
    if (!oldClaim.ok || !newClaim.ok) throw new Error('unreachable');
    const created = await engine.correct(TARGET, {
      newLedgerId: 'l-corr',
      oldMemoryId: oldClaim.value.memoryIds[0],
      newMemoryId: newClaim.value.memoryIds[0],
      rationale: 'r',
    });
    if (!created.ok) throw new Error('unreachable');

    const byId = await engine.inspectCorrection(TARGET, {
      correctionId: created.value.engineCorrectionId,
    });
    if (!byId.ok) throw new Error('unreachable');
    expect(byId.value.newMemoryId).toBe(newClaim.value.memoryIds[0]);

    const byKey = await engine.inspectCorrection(TARGET, { idempotencyKey: 'chamber-correct-l-corr' });
    if (!byKey.ok) throw new Error('unreachable');
    expect(byKey.value.engineCorrectionId).toBe(created.value.engineCorrectionId);
  });

  it('readMemory：返回存储内容 + 固定一条 current 表示；找不到 → 404', async () => {
    const content = '[ruling] 可读回正文';
    const nominate = await engine.nominate(TARGET, nominateInput({ content }));
    if (!nominate.ok) throw new Error('unreachable');

    const read = await engine.readMemory(TARGET, nominate.value.memoryIds[0]);
    if (!read.ok) throw new Error('unreachable');
    expect(read.value.memory.memory_id).toBe(expectedMemoryId(content));
    expect(read.value.representations).toHaveLength(1);
    expect(read.value.representations[0].body).toBe(content);
    expect(read.value.representations[0].current).toBe(true);
    expect(read.value.anchors).toEqual([]);
    expect(read.value.partial).toBe(false);

    const missing = await engine.readMemory(TARGET, 'mem_absent');
    if (missing.ok) throw new Error('unreachable');
    expect(missing.failure.kind).toBe('http');
  });

  it('reset()：清空内存状态（测试夹具）', async () => {
    await engine.nominate(TARGET, nominateInput());
    engine.reset();
    const after = await engine.recall(TARGET, { query: '裁决', contextIdentity: 'c', contextEpoch: 0 });
    if (!after.ok) throw new Error('unreachable');
    expect(after.value.items).toEqual([]);
    // 幂等表也清空：同键重发应重新形成（而不是回放旧回执）
    const renominated = await engine.nominate(TARGET, nominateInput());
    expect(renominated.ok).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════
  // alpha.5 投影读面（四读面）——确定性 + 合同 required 集自检
  // ══════════════════════════════════════════════════════════════════════
  describe('投影读面（graph / detail / history / representation）', () => {
    /** 提两条记忆并取回它们的 id（读面需要两个节点才谈得上"边"） */
    async function seedTwoMemories(instance: FakeEngine = engine): Promise<[string, string]> {
      const first = await instance.nominate(TARGET, nominateInput({ ledgerId: 'l-1', content: '第一条记忆正文' }));
      const second = await instance.nominate(TARGET, nominateInput({ ledgerId: 'l-2', content: '第二条记忆正文' }));
      if (!first.ok || !second.ok) throw new Error('unreachable');
      return [first.value.memoryIds[0], second.value.memoryIds[0]];
    }

    /**
     * 提 n 条记忆并取回 id（按提名顺序）。
     *
     * rationale：`seedTwoMemories` 的账本键是**固定的**（`l-1`/`l-2`，靠同键幂等保证可重复），
     * 而"n 条"要的是 n 条**互不相同**的记忆——故键与正文都带 `count` 维度，同一测试内多次
     * 调用不会撞幂等表（撞了就拿回同一条记忆，节点数少一个，断言会以难查的方式红）。
     */
    async function seedMemories(count: number, instance: FakeEngine = engine): Promise<string[]> {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const result = await instance.nominate(
          TARGET,
          nominateInput({ ledgerId: `l-${count}-${index}`, content: `第 ${index} 条记忆正文（共 ${count}）` }),
        );
        if (!result.ok) throw new Error('unreachable');
        ids.push(result.value.memoryIds[0]);
      }
      return ids;
    }

    it('graph：确定性（两个实例同结果）+ 合同 required 集齐 + scope=actor_private', async () => {
      const other = new FakeEngine();
      await seedTwoMemories();
      await seedTwoMemories(other);

      const first = await engine.getGraphView(TARGET, {});
      const again = await other.getGraphView(TARGET, {});
      if (!first.ok || !again.ok) throw new Error('unreachable');

      // 确定性：同一份"状态"（两个实例各自种了同样的两条记忆）⇒ 同一张图
      expect(first.value).toEqual(again.value);

      // 16 个顶层 required 字段齐（合同 memory-view-memory-graph-response）
      expect(Object.keys(first.value).sort()).toEqual(
        [
          'auth_kind',
          'authority',
          'budget',
          'center_memory_id',
          'edge_page',
          'edges',
          'filters',
          'mode',
          'node_page',
          'nodes',
          'omitted_edge_count',
          'redaction',
          'request_id',
          'schema_version',
          'snapshot_digest',
          'target',
        ].sort(),
      );

      // 节点：16 个 required 字段 + scope 与平台恒传一致（**不是** workspace_shared）
      expect(first.value.nodes).toHaveLength(2);
      expect(first.value.nodes[0].scope).toBe('actor_private');
      expect(first.value.target.scope).toBe('actor_private');
      expect(Object.keys(first.value.nodes[0]).sort()).toEqual(
        [
          'active_resolution',
          'anchor_state',
          'available_resolution',
          'boundary',
          'confidence_present',
          'contradiction_count',
          'created_at',
          'kind',
          'label',
          'label_resolution',
          'memory_id',
          'preview',
          'scope',
          'status',
          'supersession_count',
          'updated_at',
        ].sort(),
      );

      // 预算回声 = **引擎默认档**（平台不设自己的默认值 ⇒ 未传即默认）
      expect(first.value.budget).toEqual({
        node_limit: 200,
        edge_limit: 600,
        neighborhood_limit: 100,
        preview_scalars: 160,
        depth: 1,
      });
      // 响应 filters 回声比请求域多 `any`
      expect(first.value.filters.kind).toBe('any');
      expect(first.value.filters.created_from).toBeNull();
      // 分页块恒带 total_kind（合同 const: exact）
      expect(first.value.node_page.total_kind).toBe('exact');
      expect(first.value.node_page.total).toBe(2);

      // ≥1 条**非 supersedes** 边（合成规则：除首个外各连一条到首个；首个 = id 升序的第一个）
      expect(first.value.edges.length).toBeGreaterThanOrEqual(1);
      expect(first.value.edges[0].type).not.toBe('supersedes');
      // 节点按 id 升序 ⇒ nodes[0] 是"根"，合成边从 nodes[1] 指向它
      expect(first.value.edges[0].to_id).toBe(first.value.nodes[0].memory_id);
      expect(first.value.edges[0].from_id).toBe(first.value.nodes[1].memory_id);
      // 边的 6 个 required 字段（含 audit_locator 四键）
      expect(Object.keys(first.value.edges[0]).sort()).toEqual(
        ['audit_locator', 'created_at', 'from_id', 'relation_id', 'to_id', 'type'].sort(),
      );
      expect(Object.keys(first.value.edges[0].audit_locator).sort()).toEqual(
        ['journal_event_id', 'mutation_id', 'revision_id', 'status'].sort(),
      );
    });

    it('graph：node_limit / edge_limit 生效 + omitted_edge_count + next_cursor', async () => {
      await seedTwoMemories();

      const page = await engine.getGraphView(TARGET, { node_limit: 1 });
      if (!page.ok) throw new Error('unreachable');
      expect(page.value.nodes).toHaveLength(1);
      // browse 边只取两端点**同页**的边 ⇒ 单节点页里那条合成边两端点分属两页，故 0 条边
      expect(page.value.edges).toEqual([]);
      expect(page.value.node_page.loaded).toBe(1);
      expect(page.value.node_page.truncated).toBe(true);
      expect(page.value.node_page.next_cursor).not.toBe('');
      expect(page.value.omitted_edge_count).toBe(0);

      // 第二页：`loaded` 是引擎口径，与"过滤后的 nodes.length"无关（此处相等只因没被权限砍）
      const second = await engine.getGraphView(TARGET, {
        node_limit: 1,
        cursor: page.value.node_page.next_cursor,
      });
      if (!second.ok) throw new Error('unreachable');
      expect(second.value.nodes).toHaveLength(1);
      expect(second.value.node_page.truncated).toBe(false);
      expect(second.value.node_page.next_cursor).toBe('');
    });

    it('graph：过滤器生效（kind / created_from-to 区间 / relation_type 只影响边）', async () => {
      await seedTwoMemories();

      // kind：fake 的节点 kind 恒 'concept'
      const byKind = await engine.getGraphView(TARGET, { kind: 'belief' });
      if (!byKind.ok) throw new Error('unreachable');
      expect(byKind.value.nodes).toEqual([]);
      expect(byKind.value.filters.kind).toBe('belief');

      // 时间区间：下界推到未来 ⇒ 空；上界放到过去 ⇒ 空
      const future = await engine.getGraphView(TARGET, { created_from: '2099-01-01T00:00:00Z' });
      if (!future.ok) throw new Error('unreachable');
      expect(future.value.nodes).toEqual([]);
      const past = await engine.getGraphView(TARGET, { created_to: '2000-01-01T00:00:00Z' });
      if (!past.ok) throw new Error('unreachable');
      expect(past.value.nodes).toEqual([]);

      // relation_type 只筛边：节点集不变，边清空
      const byRelation = await engine.getGraphView(TARGET, { relation_type: 'supersedes' });
      if (!byRelation.ok) throw new Error('unreachable');
      expect(byRelation.value.nodes).toHaveLength(2);
      expect(byRelation.value.edges).toEqual([]);
    });

    it('graph **游标双通道**：过滤器变 ⇒ 400 invalid_argument；快照变 ⇒ 409 snapshot_stale', async () => {
      await seedTwoMemories();
      const page1 = await engine.getGraphView(TARGET, { node_limit: 1 });
      if (!page1.ok) throw new Error('unreachable');
      const cursor = page1.value.node_page.next_cursor;

      // ① 携 cursor 改 kind（过滤器元组变了）⇒ 400（cursor 绑 query_digest）
      const changedFilter = await engine.getGraphView(TARGET, { node_limit: 1, kind: 'concept', cursor });
      if (changedFilter.ok) throw new Error('unreachable');
      expect(changedFilter.failure).toMatchObject({
        kind: 'http',
        httpStatus: 400,
        engineCode: 'invalid_argument',
      });

      // ② 携 cursor 改页大小（limit 也在 digest 里）⇒ 同样 400
      const changedLimit = await engine.getGraphView(TARGET, { node_limit: 2, cursor });
      if (changedLimit.ok) throw new Error('unreachable');
      expect(changedLimit.failure.engineCode).toBe('invalid_argument');

      // ③ 过滤器不变、但快照变了（又形成了一条记忆）⇒ 409
      await engine.nominate(TARGET, nominateInput({ ledgerId: 'l-3', content: '第三条记忆正文' }));
      const stale = await engine.getGraphView(TARGET, { node_limit: 1, cursor });
      if (stale.ok) throw new Error('unreachable');
      expect(stale.failure).toMatchObject({
        kind: 'http',
        httpStatus: 409,
        engineCode: 'snapshot_stale',
      });

      // ④ 不可解析的游标 ⇒ 400（不是 500、也不是静默忽略）
      const garbage = await engine.getGraphView(TARGET, { cursor: 'not-a-cursor' });
      if (garbage.ok) throw new Error('unreachable');
      expect(garbage.failure.engineCode).toBe('invalid_argument');
    });

    it('五类关系边覆盖：四类合成边（确定性轮转）+ correct 产生的真实 supersedes', async () => {
      const ids = await seedMemories(5);

      const before = await engine.getGraphView(TARGET, {});
      if (!before.ok) throw new Error('unreachable');
      const syntheticTypes = new Set(before.value.edges.map((edge) => edge.type));
      // 合成边按 id 序轮转四类 ⇒ 5 个节点必然覆盖全部四类（前端五类线型/图例的确定性输入）
      for (const type of ['derived_from', 'supports', 'contradicts', 'part_of']) {
        expect(syntheticTypes.has(type)).toBe(true);
      }
      // ⚠️ `supersedes` **不在合成池里**：它只可能来自真实的 `correct`——伪造取代边会让
      //    "谁是当前主张"这个语义在测试里失真（fake 的 `contradiction_count` / 召回过滤都依赖它）
      expect(syntheticTypes.has('supersedes')).toBe(false);

      const corrected = await engine.correct(TARGET, {
        newLedgerId: 'l-5-corr',
        oldMemoryId: ids[0],
        newMemoryId: ids[1],
        rationale: 'r',
      });
      expect(corrected.ok).toBe(true);

      const after = await engine.getGraphView(TARGET, {});
      if (!after.ok) throw new Error('unreachable');
      const types = new Set(after.value.edges.map((edge) => edge.type));
      // 五类齐
      expect([...types].sort()).toEqual(
        ['contradicts', 'derived_from', 'part_of', 'supersedes', 'supports'].sort(),
      );
      // 真实那条边的方向 = 新 → 旧（逐字对齐 hument `memory_corrections.go`）
      expect(after.value.edges.find((edge) => edge.type === 'supersedes')).toMatchObject({
        from_id: ids[1],
        to_id: ids[0],
      });
    });

    it('detail 关系翻页：**第 2 页可用**（游标自身不进 query digest —— 进了就恒 400）', async () => {
      await seedMemories(3);
      const graph = await engine.getGraphView(TARGET, {});
      if (!graph.ok) throw new Error('unreachable');
      // 节点按 id 升序 ⇒ [0] 是合成边的汇聚点（它的入边 = 其余每个节点各一条 ⇒ 3 节点时 2 条）
      const rootId = graph.value.nodes[0].memory_id;

      const page1 = await engine.getMemoryView(TARGET, rootId, { relation_limit: 1 });
      if (!page1.ok) throw new Error('unreachable');
      expect(page1.value.sections.relations.items).toHaveLength(1);
      expect(page1.value.sections.relations.page.truncated).toBe(true);
      const cursor = page1.value.sections.relations.page.next_cursor;
      expect(cursor).not.toBe('');

      // ⚠️ **本用例是 blocker-1 的回归守卫**：修复前，第 1 页写出的摘要里没有 `relation_cursor`
      //    （未传 ⇒ 被 `digestOfQuery` 丢掉），而第 2 页会带着它重算 ⇒ 摘要必然不等 ⇒ 自己的
      //    防重放闸门判 `400 invalid_argument`——表现为"关系翻页整体失效"，且看起来像引擎在拒。
      const page2 = await engine.getMemoryView(TARGET, rootId, {
        relation_limit: 1,
        relation_cursor: cursor,
      });
      if (!page2.ok) throw new Error('unreachable');
      expect(page2.value.sections.relations.items).toHaveLength(1);
      expect(page2.value.sections.relations.page.truncated).toBe(false);
      expect(page2.value.sections.relations.page.next_cursor).toBe('');
      // 两页是**两条不同的边**（不是把同一页重放回来）
      expect(page2.value.sections.relations.items[0].relation_id).not.toBe(
        page1.value.sections.relations.items[0].relation_id,
      );
    });

    it('detail：provenance 7 键齐 + ladder 恒 5 槽（恰一槽 active）+ 边方向 new→old', async () => {
      const [oldId, newId] = await seedTwoMemories();
      const corrected = await engine.correct(TARGET, {
        newLedgerId: 'l-c',
        oldMemoryId: oldId,
        newMemoryId: newId,
        rationale: 'r',
      });
      if (!corrected.ok) throw new Error('unreachable');

      const detail = await engine.getMemoryView(TARGET, newId, {});
      if (!detail.ok) throw new Error('unreachable');

      // provenance：合同 required 的 7 键必须都在（旧实现的 `{}` 不达标）
      for (const key of [
        'source_type',
        'source_ref',
        'source_revision',
        'provider',
        'provider_version',
        'receipt_digest',
        'policy_version',
      ]) {
        expect(detail.value.memory.provenance[key]).toBeDefined();
      }
      expect(detail.value.memory.scope).toBe('actor_private');

      // ladder：恒 5 槽 R0..R4，恰一槽 active
      expect(detail.value.sections.representations.ladder).toHaveLength(5);
      expect(detail.value.sections.representations.ladder.map((slot) => slot.resolution)).toEqual([
        'R0',
        'R1',
        'R2',
        'R3',
        'R4',
      ]);
      expect(detail.value.sections.representations.ladder.filter((slot) => slot.active)).toHaveLength(1);
      expect(detail.value.sections.representations.ladder[2].state).toBe('current_materialized');
      // R3/R4 高于 available ⇒ beyond_available 且 current 为 null
      expect(detail.value.sections.representations.ladder[3]).toMatchObject({
        state: 'beyond_available',
        current: null,
      });
      // "有当前 + 有旧版本"并存：R2 的 historical_count = 1
      expect(detail.value.sections.representations.ladder[2].historical_count).toBe(1);

      // relations：correct 产生的 supersedes 边方向 = **新 → 旧**（逐字对齐 hument）
      const supersedes = detail.value.sections.relations.items.find(
        (edge) => edge.type === 'supersedes',
      );
      expect(supersedes).toMatchObject({ from_id: newId, to_id: oldId });

      // 找不到的记忆 ⇒ 404（不确认存在性）
      const missing = await engine.getMemoryView(TARGET, 'mem_absent', {});
      if (missing.ok) throw new Error('unreachable');
      expect(missing.failure.httpStatus).toBe(404);
    });

    it('history：R2 有旧版本（current 恒 false）；其他分辨率是**合法空页**；未知记忆 404', async () => {
      const [memoryId] = await seedTwoMemories();

      const r2 = await engine.getMemoryViewHistory(TARGET, memoryId, 'R2', {});
      if (!r2.ok) throw new Error('unreachable');
      expect(r2.value.items).toHaveLength(1);
      // ⚠️ 引擎只查 `is_current = 0` ⇒ current **恒 false**（前端不渲染这个标记）
      expect(r2.value.items[0].current).toBe(false);
      expect(r2.value.resolution).toBe('R2');
      expect(r2.value.page.total_kind).toBe('exact');

      const r0 = await engine.getMemoryViewHistory(TARGET, memoryId, 'R0', {});
      if (!r0.ok) throw new Error('unreachable');
      expect(r0.value.items).toEqual([]);

      const missing = await engine.getMemoryViewHistory(TARGET, 'mem_absent', 'R2', {});
      if (missing.ok) throw new Error('unreachable');
      expect(missing.failure.httpStatus).toBe(404);
    });

    it('representation：当前正文 = 存储内容；历史 id 可读；未知 id / 跨 workspace 404', async () => {
      const [memoryId] = await seedTwoMemories();

      const detail = await engine.getMemoryView(TARGET, memoryId, {});
      if (!detail.ok) throw new Error('unreachable');
      const currentId = detail.value.sections.representations.ladder[2].current?.representation_id;
      expect(currentId).toBeDefined();

      const current = await engine.getMemoryViewRepresentation(TARGET, memoryId, currentId!);
      if (!current.ok) throw new Error('unreachable');
      expect(current.value.representation.body).toBe('第一条记忆正文');
      expect(current.value.representation.current).toBe(true);
      // representation 端点**不改 active resolution**（纯读）：再读一次 detail 仍相同
      const after = await engine.getMemoryView(TARGET, memoryId, {});
      if (!after.ok) throw new Error('unreachable');
      expect(after.value.memory.active_resolution).toBe(detail.value.memory.active_resolution);

      const history = await engine.getMemoryViewHistory(TARGET, memoryId, 'R2', {});
      if (!history.ok) throw new Error('unreachable');
      const historical = await engine.getMemoryViewRepresentation(
        TARGET,
        memoryId,
        history.value.items[0].representation_id,
      );
      if (!historical.ok) throw new Error('unreachable');
      expect(historical.value.representation.current).toBe(false);

      const unknown = await engine.getMemoryViewRepresentation(TARGET, memoryId, 'repr_absent');
      if (unknown.ok) throw new Error('unreachable');
      expect(unknown.failure.httpStatus).toBe(404);

      const crossWorkspace = await engine.getMemoryViewRepresentation(
        { ...TARGET, workspaceId: 'ws-other' },
        memoryId,
        currentId!,
      );
      if (crossWorkspace.ok) throw new Error('unreachable');
      expect(crossWorkspace.failure.httpStatus).toBe(404);
    });

    it('relations：确定性 + 合同 required 集齐 + **两个方向**的块（另一侧各在 old / new）', async () => {
      const other = new FakeEngine();
      const [first, second] = await seedTwoMemories();
      await seedTwoMemories(other);

      const result = await engine.getMemoryRelations(TARGET, first);
      if (!result.ok) throw new Error('unreachable');

      // 确定性（两个实例同结果——e2e 断言成立的前提）
      const mirrored = await other.getMemoryRelations(TARGET, first);
      if (!mirrored.ok) throw new Error('unreachable');
      expect(mirrored.value).toEqual(result.value);

      expect(result.value.schema_version).toBe('hument-memory-relations-v1');
      expect(result.value.memory_id).toBe(first);
      expect(result.value.truncated).toBe(false);

      // ⚠️ **恒两块**：① new-side（另一条在 `old_memory_id`）② old-side（另一条在 `new_memory_id`）
      //    ——只产一块的话，"平台的过滤键取哪一侧"这件事在 e2e 里证不了（见实现注释）。
      expect(result.value.advisories).toHaveLength(2);
      const [newSide, oldSide] = result.value.advisories;

      // ① new-side：matched = new = 本记忆；case 的另一条在 old
      expect(newSide.matched_memory_id).toBe(first);
      expect(newSide.new_memory_id).toBe(first);
      expect(newSide.state).toBe('complete');
      expect(newSide.source_state).toBe('author_reported');
      expect(newSide.advisory_only).toBe(true);
      expect(newSide.coverage.candidate_count).toBe(1);
      expect(newSide.coverage.orient_truncated).toBe(false);
      expect(newSide.coverage.budget_incomplete).toBe(false);
      expect(newSide.cases).toHaveLength(1);
      expect(newSide.cases[0].new_memory_id).toBe(first);
      expect(newSide.cases[0].old_memory_id).toBe(second);
      expect(newSide.cases[0].decision).toBe('advisory');
      expect(newSide.cases[0].source_state).toBe('author_reported');
      expect(newSide.cases[0].advisory_only).toBe(true);
      // ⚠️ 合成 label 池**刻意不含 supersedes**（那一类只有真实 correct 才有）
      expect(newSide.cases[0].label).not.toBe('supersedes');

      // ② old-side：matched = 本记忆、`new_memory_id` = **另一条**（两个字段不相等）；
      //    case 的 `old_memory_id` 就是本记忆本身
      expect(oldSide.matched_memory_id).toBe(first);
      expect(oldSide.new_memory_id).toBe(second);
      expect(oldSide.cases).toHaveLength(1);
      expect(oldSide.cases[0].new_memory_id).toBe(second);
      expect(oldSide.cases[0].old_memory_id).toBe(first);

      // 跨 workspace / 未知记忆 ⇒ 404（"找不到就是找不到"）
      const cross = await engine.getMemoryRelations({ ...TARGET, workspaceId: 'ws-other' }, first);
      if (cross.ok) throw new Error('unreachable');
      expect(cross.failure.httpStatus).toBe(404);
      const unknown = await engine.getMemoryRelations(TARGET, 'mem_absent');
      if (unknown.ok) throw new Error('unreachable');
      expect(unknown.failure.httpStatus).toBe(404);
    });

    it('relations：workspace 内**只有这一条**记忆 ⇒ 合法的空 advisories（不是缺陷）', async () => {
      const lonely = new FakeEngine();
      const [only] = await seedMemories(1, lonely);

      const result = await lonely.getMemoryRelations(TARGET, only);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.advisories).toEqual([]);
      expect(result.value.memory_id).toBe(only);
    });

    it('relations：合成 case 数**有界**（≤ 3 条候选，与真引擎的 truncated 语义无关）', async () => {
      const many = new FakeEngine();
      const ids = await seedMemories(6, many);

      const result = await many.getMemoryRelations(TARGET, ids[0]);
      if (!result.ok) throw new Error('unreachable');
      // new-side 块的候选有界（3）；old-side 块恒 1 条（它表达的是"本记忆被谁比较"）
      expect(result.value.advisories[0].cases).toHaveLength(3);
      expect(result.value.advisories[0].coverage.candidate_count).toBe(3);
      expect(result.value.advisories[1].cases).toHaveLength(1);
      expect(result.value.truncated).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Usage 读面（alpha.19）
  // ══════════════════════════════════════════════════════════════════════
  describe('usage 读面（summary / trace）', () => {
    /** fake 的确定性时钟起点（见 fakeTimestamp） */
    const WINDOW = {
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-01-02T00:00:00.000Z',
    };

    async function seed(count: number, instance: FakeEngine = engine): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        await instance.nominate(
          TARGET,
          nominateInput({ ledgerId: `usage-l-${index}`, content: `usage 记忆 ${index}` }),
        );
      }
    }

    it('summary：全匹配 totals / groups；target 回声 workspace+actor+actor_private', async () => {
      await seed(3);
      const result = await engine.getUsageSummary(TARGET, WINDOW);
      if (!result.ok) throw new Error('unexpected failure');

      expect(result.value.schema_version).toBe('hument-usage-v1');
      expect(result.value.time_basis).toBe('physical_started_at');
      expect(result.value.target).toMatchObject({
        workspace_id: TARGET.workspaceId,
        actor_id: TARGET.actorId,
        scope: 'actor_private',
      });
      expect(result.value.filter).toEqual(WINDOW);
      expect(result.value.totals.counts.evidence_rows).toBe(3);
      expect(result.value.totals.counts.entities).toBe(3);
      expect(result.value.groups.length).toBeGreaterThan(0);
      // actual 恒未知（不是 0）；estimated 部分行已知
      expect(result.value.totals.cost.actual_micros).toBeNull();
    });

    it('trace：过滤 + 分页（limit 1）+ totals 与页大小无关', async () => {
      await seed(3);
      const first = await engine.getUsageTrace(TARGET, { ...WINDOW, limit: 1 });
      if (!first.ok) throw new Error('unexpected failure');
      expect(first.value.rows).toHaveLength(1);
      expect(first.value.total_rows).toBe(3);
      expect(first.value.limit).toBe(1);
      expect(first.value.has_more).toBe(true);
      expect(first.value.next_cursor).toBeTruthy();
      // totals 覆盖全匹配集（=3），不是本页 1
      expect(first.value.totals.counts.evidence_rows).toBe(3);

      const second = await engine.getUsageTrace(TARGET, {
        ...WINDOW,
        limit: 1,
        cursor: first.value.next_cursor,
      });
      if (!second.ok) throw new Error('unexpected failure');
      expect(second.value.rows).toHaveLength(1);
      expect(second.value.rows[0].id).not.toBe(first.value.rows[0].id);

      // 过滤（provider_operation）会缩小全匹配集
      const filtered = await engine.getUsageSummary(TARGET, {
        ...WINDOW,
        provider_operation: 'generation',
      });
      if (!filtered.ok) throw new Error('unexpected failure');
      expect(filtered.value.totals.counts.evidence_rows).toBe(2);
    });

    it('null / 0 三态在 rows 与 totals 中都不归并', async () => {
      await seed(4);
      const result = await engine.getUsageTrace(TARGET, { ...WINDOW, limit: 100 });
      if (!result.ok) throw new Error('unexpected failure');

      const inputs = result.value.rows.map((row) => row.input_tokens);
      expect(inputs).toContain(null);
      expect(inputs).toContain(0);
      expect(result.value.totals.tokens.unknown_input_rows).toBeGreaterThan(0);
      // 有未知行 ⇒ 合计是 null（不是把已知小计当合计）
      expect(result.value.totals.tokens.input_tokens).toBeNull();
      expect(result.value.totals.tokens.known_input_tokens).toBeGreaterThan(0);
    });

    it('游标双通道：改 limit ⇒ 400 invalid_argument；数据变 ⇒ 409 conflict', async () => {
      await seed(3);
      const first = await engine.getUsageTrace(TARGET, { ...WINDOW, limit: 1 });
      if (!first.ok || !first.value.next_cursor) throw new Error('unexpected failure');
      const cursor = first.value.next_cursor;

      const changed = await engine.getUsageTrace(TARGET, { ...WINDOW, limit: 2, cursor });
      if (changed.ok) throw new Error('expected failure');
      expect(changed.failure).toMatchObject({
        kind: 'http',
        httpStatus: 400,
        engineCode: 'invalid_argument',
      });

      // 形成一条新记忆 ⇒ 快照变
      await engine.nominate(
        TARGET,
        nominateInput({ ledgerId: 'usage-new', content: 'usage 记忆 new' }),
      );
      const stale = await engine.getUsageTrace(TARGET, { ...WINDOW, limit: 1, cursor });
      if (stale.ok) throw new Error('expected failure');
      expect(stale.failure).toMatchObject({
        kind: 'http',
        httpStatus: 409,
        engineCode: 'conflict',
      });
    });
  });
});

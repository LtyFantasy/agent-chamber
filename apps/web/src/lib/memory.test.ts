/**
 * memory.test.ts — Memory 契约翻译层单测
 *
 * 这一层的每个函数都是"后端契约 ↔ 展示"的翻译点，坏掉的表现都是**静默错误**
 * （配色撞车、降级被读成空、引擎故障被读成无结果），故逐条钉住：
 * ① category 配色：静态字面量（禁模板拼接）、同值恒同色、钉死槽位不被 hash 复用；
 * ② 状态/形成态 → Badge 变体三档分叉；
 * ③ 归属四态（活/软删/system 哨兵/真孤儿）；
 * ④ `metadata` 档的"整键缺席"判定（`in` 而非 `=== undefined`/`!== null`）；
 * ⑤ 参数装配（空值不发键）与分页派生；
 * ⑥ 引擎不可用 / 错误码 / recoveryPath 三个白名单映射（文案分叉的唯一来源）；
 * ⑦ 多路合并（createdAt DESC + 去重 + 稳定决胜）与字面匹配面。
 */

import {
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_RECALL_EMPTY_REASON,
  MEMORY_UNAVAILABLE_REASON,
} from '@agent-chamber/shared';
import enMessages from '@/i18n/messages/en.json';
import zhMessages from '@/i18n/messages/zh-CN.json';
import {
  MEMORY_CONTEXT_EPOCH_MAX,
  MEMORY_EPOCH_ORIGIN,
  MEMORY_EXCERPT_TRUNCATION_MARKER,
  MEMORY_MAX_PAGE_SIZE,
  buildMemoryGraphQueryParams,
  buildMemoryNominationQueryParams,
  memoryCategoryChipClass,
  memoryContextEpoch,
  memoryContextIdentity,
  memoryErrorKind,
  memoryExcerptOf,
  memoryFormationStateBadgeVariant,
  memoryHasField,
  memoryIsMetadataProjection,
  memoryLiteralMatch,
  memoryMergeByCreatedAt,
  memoryNominatorLabel,
  memoryPagination,
  memoryRecallEmptyKind,
  memoryRecoveryKind,
  memoryStatusBadgeVariant,
  memoryStatusIsDimmed,
  memoryUnavailableReasonKind,
  memoryUnavailableReasonOf,
  memoryLadderActiveResolution,
  memoryLadderSlotKind,
  memoryViewEdgeVisual,
  memoryViewEngineMemoryId,
  memoryViewErrorKind,
  memoryViewKindVisual,
  memoryViewLabelLines,
  memoryViewLabelSingleLine,
  memoryViewLineWidthPx,
  MEMORY_GRAPH_LABEL_LINE_PX,
  memoryViewNeedsReset,
  memoryViewResetKind,
  emptyMemoryGraphPages,
  mergeMemoryGraphPages,
  type MemoryGraphPages,
  type MemoryGraphViewResponse,
  type MemoryNominationDto,
  type MemoryViewEdge,
  type MemoryViewGraphNode,
  type MemoryViewLadderSlot,
} from './memory';

/** 造一行账本投影（缺省 = full 档「生效中 + 已形成」） */
function nomination(overrides: Partial<MemoryNominationDto> = {}): MemoryNominationDto {
  return {
    projection: 'full',
    id: 'n1',
    category: 'ruling',
    formationState: MEMORY_FORMATION_STATE.COMMITTED,
    status: MEMORY_NOMINATION_STATUS.ACTIVE,
    nominatorId: 'a1b2c3d4-0000-4000-8000-000000000001',
    nominatorType: 'agent',
    nominatorName: 'Agent One',
    nominatorDeletedAt: null,
    projectId: 'p1',
    correctionOf: null,
    reviewAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    subject: 'Claim',
    scope: 'Everywhere',
    effectiveNote: null,
    contentExcerpt: 'excerpt',
    deferred: false,
    ...overrides,
  };
}

/** 造一行 metadata（治理白名单）投影：**full 档字段整键缺席** */
function metadataNomination(overrides: Partial<MemoryNominationDto> = {}): MemoryNominationDto {
  const base = nomination(overrides);
  delete base.subject;
  delete base.scope;
  delete base.effectiveNote;
  delete base.contentExcerpt;
  delete base.sources;
  delete base.recoveryPath;
  delete base.deferred;
  return { ...base, projection: 'metadata' };
}

describe('memoryCategoryChipClass', () => {
  it('同一 category 恒同色，不同 category 有区分度', () => {
    expect(memoryCategoryChipClass('ruling')).toBe(memoryCategoryChipClass('ruling'));
    // 至少不是"所有类别一个颜色"（哈希池非退化）
    const distinct = new Set(
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((c) => memoryCategoryChipClass(c)),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('ruling 钉死在固定槽位（青色，主光色相）', () => {
    expect(memoryCategoryChipClass('ruling')).toBe('bg-cyan-500/15 text-cyan-300');
  });

  it('钉死槽位**从 hash 池排除**：其它类别永不复用 ruling 的类名', () => {
    // 大量取值扫一遍，确认没有别的 category 撞上钉死色（防撞色的全部意义所在）
    const offenders = Array.from({ length: 200 }, (_, i) => `cat-${i}`).filter(
      (c) => memoryCategoryChipClass(c) === memoryCategoryChipClass('ruling'),
    );
    expect(offenders).toEqual([]);
  });

  it('返回静态字面量类名（禁模板拼接：含空格分隔的完整类，且不含变量残片）', () => {
    const cls = memoryCategoryChipClass('anything');
    expect(cls).toMatch(/^bg-[a-z]+-500\/15 text-[a-z]+-300$/);
  });
});

describe('状态 / 形成态展示映射', () => {
  it('active → success；superseded → subtle；withdrawn → outline + 降权', () => {
    expect(memoryStatusBadgeVariant(MEMORY_NOMINATION_STATUS.ACTIVE)).toBe('success');
    expect(memoryStatusBadgeVariant(MEMORY_NOMINATION_STATUS.SUPERSEDED)).toBe('subtle');
    expect(memoryStatusBadgeVariant(MEMORY_NOMINATION_STATUS.WITHDRAWN)).toBe('outline');
    expect(memoryStatusIsDimmed(MEMORY_NOMINATION_STATUS.WITHDRAWN)).toBe(true);
    // 只有 withdrawn 降权：superseded 是正常历史，不该被当"废数据"淡化
    expect(memoryStatusIsDimmed(MEMORY_NOMINATION_STATUS.SUPERSEDED)).toBe(false);
  });

  it('形成态七态各有变体，「是否还在动」是分档依据', () => {
    expect(memoryFormationStateBadgeVariant(MEMORY_FORMATION_STATE.SUBMITTED)).toBe('default');
    expect(memoryFormationStateBadgeVariant(MEMORY_FORMATION_STATE.COMMITTED)).toBe('success');
    expect(memoryFormationStateBadgeVariant(MEMORY_FORMATION_STATE.NO_MEMORY)).toBe('subtle');
    expect(memoryFormationStateBadgeVariant(MEMORY_FORMATION_STATE.FAILED)).toBe('warning');
    expect(memoryFormationStateBadgeVariant(MEMORY_FORMATION_STATE.CONFLICT)).toBe('warning');
    expect(memoryFormationStateBadgeVariant(MEMORY_FORMATION_STATE.REJECTED)).toBe('destructive');
    expect(memoryFormationStateBadgeVariant(MEMORY_FORMATION_STATE.UNKNOWN)).toBe('outline');
  });
});

describe('归属四态（对齐全站 experienceActorLabel 范式）', () => {
  it('活态：真名 + 不灰化 + 非孤儿', () => {
    const label = memoryNominatorLabel({
      id: 'a1',
      name: 'Agent One',
      deletedAt: null,
      type: 'agent',
    });
    expect(label).toMatchObject({
      visible: true,
      name: 'Agent One',
      deleted: false,
      orphan: false,
      system: false,
    });
    expect(label.title).toBe('a1');
  });

  it('软删：真名保留 + deleted 标记（历史归因不丢）', () => {
    const label = memoryNominatorLabel({
      id: 'a1',
      name: 'Bob',
      deletedAt: '2026-08-01T00:00:00.000Z',
      type: 'human',
    });
    expect(label).toMatchObject({
      visible: true,
      name: 'Bob',
      deleted: true,
      orphan: false,
      system: false,
    });
  });

  it('system 哨兵（无名字 + nominatorType=system）→ system 标记，名字位交给 i18n', () => {
    const label = memoryNominatorLabel({
      id: 'system',
      name: null,
      deletedAt: null,
      type: 'system',
    });
    expect(label.visible).toBe(true);
    expect(label.system).toBe(true);
  });

  it('真孤儿（无名字 + 非 system）→ 退 id 前 8 位，**不加兜底词**且不是 system', () => {
    const label = memoryNominatorLabel({
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      name: null,
      deletedAt: null,
      type: 'agent',
    });
    expect(label.name).toBe('a1b2c3d4');
    expect(label.orphan).toBe(true);
    expect(label.system).toBe(false);
    // 完整 UUID 留在 title（唯一排查通道）
    expect(label.title).toBe('a1b2c3d4-0000-4000-8000-000000000001');
  });

  it('有名字时即便 type=system 也按名字渲染（system 只在没名字时兜底）', () => {
    const label = memoryNominatorLabel({ id: 's1', name: 'System', type: 'system' });
    expect(label.system).toBe(false);
    expect(label.name).toBe('System');
  });
});

describe('metadata 档的字段存在性判定', () => {
  it('memoryHasField 用 `in` 判定：metadata 行整键缺席，不是 null', () => {
    const full = nomination();
    const meta = metadataNomination();
    expect(memoryHasField(full, 'contentExcerpt')).toBe(true);
    expect(memoryHasField(meta, 'contentExcerpt')).toBe(false);
    expect(memoryHasField(meta, 'subject')).toBe(false);
    expect(memoryIsMetadataProjection(meta)).toBe(true);
    expect(memoryIsMetadataProjection(full)).toBe(false);
  });

  it('memoryExcerptOf：键缺席 → null；空串 → null（显式"抽不出摘要"）；有值原样返回', () => {
    expect(memoryExcerptOf(metadataNomination())).toBeNull();
    expect(memoryExcerptOf(nomination({ contentExcerpt: '' }))).toBeNull();
    expect(
      memoryExcerptOf(nomination({ contentExcerpt: `line${MEMORY_EXCERPT_TRUNCATION_MARKER}` })),
    ).toBe(`line${MEMORY_EXCERPT_TRUNCATION_MARKER}`);
  });
});

describe('查询参数装配 / 分页派生', () => {
  it('空值不发键（`?status=` 会撞后端 @IsIn 400）', () => {
    expect(buildMemoryNominationQueryParams({})).toEqual({});
    expect(
      buildMemoryNominationQueryParams({
        status: undefined,
        formationState: undefined,
        page: 1,
        pageSize: MEMORY_MAX_PAGE_SIZE,
      }),
    ).toEqual({ page: 1, pageSize: MEMORY_MAX_PAGE_SIZE });
  });

  it('有值时逐键透传（词表单值语义）', () => {
    expect(
      buildMemoryNominationQueryParams({
        status: MEMORY_NOMINATION_STATUS.ACTIVE,
        formationState: MEMORY_FORMATION_STATE.FAILED,
        page: 2,
      }),
    ).toEqual({ status: 'active', formationState: 'failed', page: 2 });
  });

  it('分页派生：totalPages 至少 1，边界正确', () => {
    expect(memoryPagination(0, 1, 20)).toEqual({ totalPages: 1, hasPrev: false, hasNext: false });
    expect(memoryPagination(21, 1, 20)).toEqual({ totalPages: 2, hasPrev: false, hasNext: true });
    expect(memoryPagination(21, 2, 20)).toEqual({ totalPages: 2, hasPrev: true, hasNext: false });
    expect(memoryPagination(100, 1, 100)).toEqual({
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
    });
  });
});

describe('recall 上下文身份', () => {
  it('形态 = web:user:<id>:project:<id>，且不含用户正文', () => {
    const identity = memoryContextIdentity('u-1', 'p-1');
    expect(identity).toBe('web:user:u-1:project:p-1');
    expect(identity.length).toBeLessThanOrEqual(256);
  });

  it('userId 缺失时用 anonymous 占位（仍满足 1~256 长度闸门）', () => {
    expect(memoryContextIdentity(undefined, 'p-1')).toBe('web:user:anonymous:project:p-1');
  });
});

/**
 * 上下文世代取值（秒级相对纪元）。
 *
 * 这组断言的核心是**上限**：现状"typeof number && > 0"恰好放过了 `Date.now()`（1.76e12），
 * 而后端 DTO 已按引擎运行时契约加了 `@Max(1e9)`（backend `c5758ece`）——把上限钉在测试里，
 * 下次有人改回毫秒/Unix 秒会**当场红**，不用打真引擎。
 */
describe('memoryContextEpoch（引擎 0..1e9 区间）', () => {
  const REAL_NOW = Date.now();

  afterEach(() => {
    jest.spyOn(Date, 'now').mockRestore();
  });

  it('返回整数且落在 0..1e9（毫秒与 Unix 秒都超限，必须被挡住）', () => {
    const epoch = memoryContextEpoch();
    expect(Number.isInteger(epoch)).toBe(true);
    expect(epoch).toBeGreaterThanOrEqual(0);
    expect(epoch).toBeLessThanOrEqual(MEMORY_CONTEXT_EPOCH_MAX);
    // 反向哨兵：真实时钟下这个值就是"距 2026-01-01 的秒数"，量级远小于毫秒/Unix 秒
    expect(epoch).toBeLessThan(REAL_NOW / 1000);
    expect(epoch).not.toBe(REAL_NOW);
  });

  it('同秒内唯一、跨秒递增（满足 D7「每次提交取新值」且不回退）', () => {
    // 同一秒的两次调用：值相同（秒级精度，见实现注释的取舍）
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const sameSecondA = memoryContextEpoch();
    const sameSecondB = memoryContextEpoch();
    expect(sameSecondA).toBe(sameSecondB);

    // 下一秒：严格 +1（单调前进 ⇒ 跨会话不会复位去撞历史上下文）
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_001_000);
    expect(memoryContextEpoch()).toBe(sameSecondA + 1);
  });

  it('与基准的关系：基准时刻 = 0，基准 + 1e9 秒 = 上限且此后钳位不溢出', () => {
    jest.spyOn(Date, 'now').mockReturnValue(MEMORY_EPOCH_ORIGIN * 1000);
    expect(memoryContextEpoch()).toBe(0);

    jest
      .spyOn(Date, 'now')
      .mockReturnValue((MEMORY_EPOCH_ORIGIN + MEMORY_CONTEXT_EPOCH_MAX) * 1000);
    expect(memoryContextEpoch()).toBe(MEMORY_CONTEXT_EPOCH_MAX);

    // 越过上限（≈31.7 年后）：钳到上限而不是让请求 400
    jest
      .spyOn(Date, 'now')
      .mockReturnValue((MEMORY_EPOCH_ORIGIN + MEMORY_CONTEXT_EPOCH_MAX + 999) * 1000);
    expect(memoryContextEpoch()).toBe(MEMORY_CONTEXT_EPOCH_MAX);
  });

  it('时钟被拨到基准之前：钳到 0（负数会被 DTO @Min(0) 拒，宁可世代不前进）', () => {
    jest.spyOn(Date, 'now').mockReturnValue((MEMORY_EPOCH_ORIGIN - 10) * 1000);
    expect(memoryContextEpoch()).toBe(0);
  });

  it('上限常量与后端单源同值（改一侧必须同步另一侧）', () => {
    // backend `MEMORY_CONTEXT_EPOCH_MAX` = 1_000_000_000（引擎运行时实证）
    expect(MEMORY_CONTEXT_EPOCH_MAX).toBe(1_000_000_000);
  });
});

describe('引擎不可用 / 错误码 / recoveryPath 映射（文案分叉的唯一来源）', () => {
  it('reason 三分叉：not_configured / project_engine_unbound / 其余', () => {
    expect(memoryUnavailableReasonKind(MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED)).toBe(
      'notConfigured',
    );
    expect(memoryUnavailableReasonKind(MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND)).toBe(
      'projectUnbound',
    );
    for (const reason of [
      MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE,
      MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT,
      MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR,
    ]) {
      expect(memoryUnavailableReasonKind(reason)).toBe('engineUnavailable');
    }
    expect(memoryUnavailableReasonKind(null)).toBe('engineUnavailable');
  });

  it('memoryUnavailableReasonOf 只认 503/14000 的 data.reason', () => {
    const err = (status: number, code: number, reason?: string) => ({
      response: { status, data: { code, data: reason ? { reason } : {} } },
    });
    expect(
      memoryUnavailableReasonOf(err(503, 14000, MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE)),
    ).toBe(MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE);
    // 非 503 / 非 14000 / 无 reason ⇒ null（不误报引擎故障）
    expect(memoryUnavailableReasonOf(err(500, 14000, 'engine_error'))).toBeNull();
    expect(memoryUnavailableReasonOf(err(503, 9999, 'engine_error'))).toBeNull();
    expect(memoryUnavailableReasonOf(err(503, 14000))).toBeNull();
    expect(memoryUnavailableReasonOf(new Error('network'))).toBeNull();
  });

  it('memoryErrorKind 三分叉：403/1009、404/14003、503/14000', () => {
    const err = (status: number, code?: number) => ({ response: { status, data: { code } } });
    expect(memoryErrorKind(err(403, 1009))).toMatchObject({
      permissionDenied: true,
      notFound: false,
      engineUnavailable: false,
    });
    expect(memoryErrorKind(err(404, 14003))).toMatchObject({ notFound: true });
    expect(memoryErrorKind(err(503, 14000))).toMatchObject({ engineUnavailable: true });
    // 通用错误：三个分叉全 false（页面据此走"重试"而不是死胡同文案）
    expect(memoryErrorKind(err(500))).toMatchObject({
      permissionDenied: false,
      notFound: false,
      engineUnavailable: false,
    });
  });

  it('recoveryPath 白名单映射；未映射/空值走 unknown（**不裸渲染机器码**）', () => {
    expect(memoryRecoveryKind('same_key_resend')).toBe('sameKeyResend');
    expect(memoryRecoveryKind('inspect_backfill')).toBe('inspectBackfill');
    expect(memoryRecoveryKind('hub_manual_required')).toBe('hubManualRequired');
    expect(memoryRecoveryKind('config_invalid')).toBe('configInvalid');
    expect(memoryRecoveryKind('param_invalid')).toBe('paramInvalid');
    expect(memoryRecoveryKind('brand_new_code')).toBe('unknown');
    expect(memoryRecoveryKind(null)).toBe('unknown');
    expect(memoryRecoveryKind(undefined)).toBe('unknown');
  });

  it('emptyReason 三值：all_filtered 与 no_matches 必须分清', () => {
    expect(memoryRecallEmptyKind(MEMORY_RECALL_EMPTY_REASON.NONE)).toBe('none');
    expect(memoryRecallEmptyKind(MEMORY_RECALL_EMPTY_REASON.NO_MATCHES)).toBe('noMatches');
    expect(memoryRecallEmptyKind(MEMORY_RECALL_EMPTY_REASON.ALL_FILTERED)).toBe('allFiltered');
  });
});

describe('多路合并（六路/两路）', () => {
  it('按 createdAt 倒序合并 + 同 id 去重 + 同刻用 id 决胜（顺序稳定）', () => {
    const older = nomination({ id: 'a', createdAt: '2026-10-01T00:00:00.000Z' });
    const newer = nomination({ id: 'b', createdAt: '2026-10-03T00:00:00.000Z' });
    const middle = nomination({ id: 'c', createdAt: '2026-10-02T00:00:00.000Z' });
    const merged = memoryMergeByCreatedAt([[older], [newer, middle]]);
    expect(merged.map((row) => row.id)).toEqual(['b', 'c', 'a']);

    // 同一行出现在两路（防御性去重）：只保留一条，且不因到达顺序改变位置
    expect(memoryMergeByCreatedAt([[newer], [newer, older]]).map((r) => r.id)).toEqual(['b', 'a']);

    // 同一毫秒：id 升序决胜（两次调用结果一致 = 稳定）
    const sameA = nomination({ id: 'x1', createdAt: '2026-10-04T00:00:00.000Z' });
    const sameB = nomination({ id: 'x2', createdAt: '2026-10-04T00:00:00.000Z' });
    expect(memoryMergeByCreatedAt([[sameA, sameB]]).map((r) => r.id)).toEqual(['x1', 'x2']);
    expect(memoryMergeByCreatedAt([[sameB, sameA]]).map((r) => r.id)).toEqual(['x1', 'x2']);
  });

  it('空输入 → 空数组（各路都没就绪时不该崩）', () => {
    expect(memoryMergeByCreatedAt([[], []])).toEqual([]);
  });
});

describe('字面匹配（纯客户端、零配额）', () => {
  it('匹配面 = 主张/范围/类别/摘要（列表投影里**没有正文**，故不假装搜正文）', () => {
    const row = nomination({
      subject: 'Docker port mapping',
      scope: 'WSL2',
      category: 'ruling',
      contentExcerpt: 'port-unreachable',
    });
    expect(memoryLiteralMatch(row, 'docker')).toBe(true);
    expect(memoryLiteralMatch(row, 'WSL2')).toBe(true);
    expect(memoryLiteralMatch(row, 'ruling')).toBe(true);
    expect(memoryLiteralMatch(row, 'port-unreachable')).toBe(true);
    expect(memoryLiteralMatch(row, 'kubernetes')).toBe(false);
  });

  it('大小写不敏感；空白查询恒命中（调用方据此跳过过滤）', () => {
    expect(memoryLiteralMatch(nomination({ subject: 'Docker' }), 'DOCKER')).toBe(true);
    expect(memoryLiteralMatch(nomination({ subject: 'Docker' }), '   ')).toBe(true);
  });

  it('metadata 行没有摘要位：只匹配得到的字段，不因缺字段崩', () => {
    const meta = metadataNomination();
    expect(memoryLiteralMatch(meta, 'ruling')).toBe(true);
    expect(memoryLiteralMatch(meta, 'Claim')).toBe(false);
  });
});

/**
 * 语言包契约（**形状断言**，不渲染）。
 *
 * 为什么不是"用真实格式化器渲染一遍"：jest 经 `next/jest` 只转译应用代码，
 * `next-intl` 的 ESM 入口（`dist/esm/production/index.react-client.js`）在 node 里
 * `require` 不进去（实测 SyntaxError: Unexpected token 'export'），而它的传递依赖
 * `intl-messageformat` 在 pnpm strict 布局下**不可解析**（未声明依赖，禁偷用）。
 * 故这里钉的是"语言包写法合法"这半边（拼错 `other` 分支/写成普通插值都会被拦住），
 * 另外半边（真实渲染结果）由列表页测试里**带 ICU 子集实现**的 mock 覆盖，
 * 完整链路由主脑 dev 实机走查收口。
 */
describe('memory 语言包（形状契约）', () => {
  it('card.sourceCount 是合法 ICU plural：单数/复数两分支齐全（评审 m12）', () => {
    const raw = enMessages.memory.card.sourceCount;
    // 形如 `{count, plural, one {# source} other {# sources}}`
    expect(raw).toMatch(/^\{count,\s*plural,\s*one \{#[^{}]*\} other \{#[^{}]*\}\}$/);
    // 单数分支只说一个、复数分支带 s（拼反了会让 "1 sources" 出现在界面上）
    expect(raw).toContain('one {# source}');
    expect(raw).toContain('other {# sources}');
  });

  it('中文侧无单复数变化：普通 `{count}` 插值即可（不硬套英文 plural）', () => {
    expect(zhMessages.memory.card.sourceCount).toContain('{count}');
    expect(zhMessages.memory.card.sourceCount).not.toContain('plural');
  });

  it('图页带计数的文案在 en 侧也是 ICU plural（否则界面会出现 "1 nodes"）', () => {
    /*
      真机冒烟实证：治理条一开始渲染成 "1 nodes hidden because a source is not visible"。
      中文没有单复数变化，故这一族只对 en 侧成立——zh 侧保持普通插值（下面的 zh 断言是反向钉子）。
    */
    for (const key of [
      'graph.governance.summary',
      'graph.governance.hiddenNodes',
      'graph.governance.omittedEdges',
      'graph.canvas.roleStatus',
      'graph.status.outOfView',
      'graph.node.contradictions',
      'graph.node.supersessions',
      'resolution.historicalCount',
      'representations.bytes',
    ]) {
      const raw = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)[part],
          enMessages.memory,
        );
      expect(raw).toMatch(/plural,\s*one \{/);
    }
    // 中文侧不套 ICU plural（中文无单复数）
    expect(JSON.stringify(zhMessages.memory.graph)).not.toContain('plural');
    expect(JSON.stringify(zhMessages.memory.resolution)).not.toContain('plural');
    expect(JSON.stringify(zhMessages.memory.representations)).not.toContain('plural');
  });

  it('信任框/降级文案不出现机器码（人话是产品诚实性要求）', () => {
    for (const text of [
      enMessages.memory.search.trustNote,
      enMessages.memory.search.filteredByPermission,
      enMessages.memory.search.engineDataSuspect,
      enMessages.memory.degraded.pageBanner,
      enMessages.memory.degraded.rowLockedHint,
    ]) {
      expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 引擎投影读面（views 族；关系图批次）
//
// 这一族坏掉的表现同样是**静默错误**：配色撞车、线型漂移（图例与画布说两套编码）、
// 累积页合并漏掉映射（翻页后早期页节点点不开详情）。故逐条钉住。
// ══════════════════════════════════════════════════════════════════════════

/** 造一个 graph 节点（只填布局/视觉消费的字段） */
function viewNode(id: string, kind = 'observation'): MemoryViewGraphNode {
  return {
    memory_id: id,
    kind,
    scope: 'actor_private',
    status: 'active',
    active_resolution: 'R0',
    available_resolution: 'R0',
    label: id,
    preview: `preview ${id}`,
    label_resolution: 'R0',
    confidence_present: false,
    contradiction_count: 0,
    supersession_count: 0,
    anchor_state: 'fresh',
    boundary: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

/** 造一条边 */
function viewEdge(id: string, from: string, to: string, type: string): MemoryViewEdge {
  return {
    relation_id: id,
    from_id: from,
    to_id: to,
    type,
    created_at: '2026-10-01T00:00:00.000Z',
    audit_locator: { status: 'ok', journal_event_id: 'j', revision_id: 'r', mutation_id: 'm' },
  };
}

/** 造一页 graph 响应（只覆盖合并关心的字段） */
function graphPage(options: {
  nodes: MemoryViewGraphNode[];
  edges?: MemoryViewEdge[];
  ledgerMapping?: Record<string, string>;
  nextCursor?: string;
  filteredNodeCount?: number;
  filteredEdgeCount?: number;
  unmappedCount?: number;
  omittedEdgeCount?: number;
  partial?: boolean;
  truncated?: boolean;
}): MemoryGraphViewResponse {
  return {
    engine: {
      omitted_edge_count: options.omittedEdgeCount ?? 0,
      nodes: options.nodes,
      edges: options.edges ?? [],
      node_page: {
        total: options.nodes.length,
        total_kind: 'exact',
        loaded: options.nodes.length,
        next_cursor: options.nextCursor ?? '',
        partial: options.partial ?? false,
        truncated: options.truncated ?? false,
        truncation_reason: '',
      },
      edge_page: {
        total: (options.edges ?? []).length,
        total_kind: 'exact',
        loaded: (options.edges ?? []).length,
        next_cursor: '',
        partial: options.partial ?? false,
        truncated: options.truncated ?? false,
        truncation_reason: '',
      },
    } as MemoryGraphViewResponse['engine'],
    filteredByPermission: (options.filteredNodeCount ?? 0) > 0,
    filteredNodeCount: options.filteredNodeCount ?? 0,
    filteredEdgeCount: options.filteredEdgeCount ?? 0,
    unmappedCount: options.unmappedCount ?? 0,
    engineDataSuspect: (options.unmappedCount ?? 0) > 0,
    ledgerMapping: options.ledgerMapping ?? {},
    trustLevel: 'untrusted_advisory',
    decisionAuthority: 'none',
    usageNote: 'note',
  };
}

describe('views 族：节点 / 边视觉（静态字面量池，图例与画布同源）', () => {
  it('五个 kind 各有不同色相，且类名全是静态字面量（无模板拼接痕迹）', () => {
    const kinds = ['observation', 'episode', 'concept', 'belief', 'procedure'];
    const fills = kinds.map((kind) => memoryViewKindVisual(kind).fill);
    expect(new Set(fills).size).toBe(5);
    // `fill-${hue}-500/15` 这种拼接在 Tailwind 里不生成 CSS 且零报错，故必须逐条字面量
    for (const visual of kinds.map((kind) => memoryViewKindVisual(kind))) {
      expect(visual.fill).toMatch(/^fill-[a-z]+-\d+\/\d+$/);
      expect(visual.stroke).toMatch(/^stroke-[a-z]+-\d+$/);
    }
  });

  it('域外 kind 回落中性灰，**不借用**任何已知 kind 的色（避免把新概念误读成旧概念）', () => {
    const known = ['observation', 'episode', 'concept', 'belief', 'procedure'].map(
      (kind) => memoryViewKindVisual(kind).fill,
    );
    expect(known).not.toContain(memoryViewKindVisual('brand_new_kind').fill);
  });

  it('五类边的线型互不相同；语义色只给 supersedes / contradicts，其余共享中性色', () => {
    const types = ['derived_from', 'supports', 'contradicts', 'supersedes', 'part_of'];
    const dashes = types.map((type) => memoryViewEdgeVisual(type).dash);
    // supersedes 用实线（null），其余四类各有不同 dasharray
    expect(dashes[3]).toBeNull();
    expect(new Set(dashes.filter((dash) => dash !== null)).size).toBe(4);
    expect(memoryViewEdgeVisual('supersedes').stroke).toBe('stroke-primary');
    expect(memoryViewEdgeVisual('contradicts').stroke).toBe('stroke-destructive');
    const neutral = ['derived_from', 'supports', 'part_of'].map(
      (type) => memoryViewEdgeVisual(type).stroke,
    );
    expect(new Set(neutral).size).toBe(1);
  });

  it('域外边类型回落点线 + 中性色（**不用实线**——实线是 supersedes 的专属编码）', () => {
    const visual = memoryViewEdgeVisual('brand_new_relation');
    expect(visual.dash).not.toBeNull();
    expect(visual.stroke).toBe('stroke-muted-foreground');
  });

  it('label 切片（px 预算）：短 label 一行、长 label 两行且第二行补省略号', () => {
    expect(memoryViewLabelLines('short')).toEqual(['short']);
    // 拉丁硬切：116px ÷ 6.5px('a') = 17 字；第二行预算 116−11(省略号)=105 → 16 字 + …
    expect(memoryViewLabelLines('a'.repeat(40))).toEqual(['a'.repeat(17), `${'a'.repeat(16)}…`]);
    // CJK：11px/字 ⇒ 10 字 = 110px 放得下，11 字 = 121px 必切（旧字符数口径在这里溢出）
    const cjk = memoryViewLabelLines('记忆召回上限适用于平台全部调用方');
    expect(cjk).toEqual(['记忆召回上限适用于平', '台全部调用方']);
  });

  it('label 切片：断词偏好命中——断在窗口尾部 25% 内的最后断点', () => {
    // 空格断点在 88.5px ≥ 114.5×0.75 ⇒ 断在第三个空格后（不是硬切在 18 字处）
    expect(memoryViewLabelLines('aaaa bbbb cccc dddd eeee ffff g')).toEqual([
      'aaaa bbbb cccc',
      'dddd eeee ffff g',
    ]);
  });

  it('label 切片：断点在 75% 窗口之外 ⇒ 放弃断词硬切（不吃掉大半行）', () => {
    const lines = memoryViewLabelLines(`${'a'.repeat(10)} ${'a'.repeat(30)}`);
    expect(lines[0]).toBe(`${'a'.repeat(10)} ${'a'.repeat(7)}`);
    expect(lines[1]).toBe(`${'a'.repeat(16)}…`);
  });

  it('label 切片：开括号前断词（行尾不挂「（」）', () => {
    // 断点窗口内唯一候选 = 「（」前的 BREAK_BEFORE（全文无 BREAK_AFTER 字符）——删掉
    // BREAK_BEFORE 分支本例必红（旧断言是恒真式，终审 P2-3 重写）
    const lines = memoryViewLabelLines(`${'a'.repeat(15)}（${'b'.repeat(20)}`);
    expect(lines[0]).toBe('a'.repeat(15));
    expect(lines[1]).toBe(`（${'b'.repeat(14)}…`);
  });

  it('label 切片：非 CJK 非 ASCII 不再低估（终审 P1-1）——西里尔/emoji 必截断带省略号', () => {
    // 修复前它们落 3.5 窄字符桶：估算 ≤ 预算 ⇒ 走「无需截断」原样返回、无 …，
    // clip 在 116px 竖切字形（静默半字）。修复后：西里尔/拉丁扩展 6.5、emoji/未知非 ASCII 13 上界。
    const cyrillic = memoryViewLabelSingleLine('Привет мир Привет мир Привет');
    expect(cyrillic.endsWith('…')).toBe(true);
    expect(memoryViewLineWidthPx(cyrillic)).toBeLessThanOrEqual(MEMORY_GRAPH_LABEL_LINE_PX);
    const emoji = memoryViewLabelSingleLine('🚀'.repeat(10));
    expect(emoji.endsWith('…')).toBe(true);
    expect(memoryViewLineWidthPx(emoji)).toBeLessThanOrEqual(MEMORY_GRAPH_LABEL_LINE_PX);
    // 两行档同享估算器：每行 ≤ 预算
    for (const line of memoryViewLabelLines('Привет мир Привет мир Привет')) {
      expect(memoryViewLineWidthPx(line)).toBeLessThanOrEqual(MEMORY_GRAPH_LABEL_LINE_PX);
    }
  });

  it('label 切片：全大写/数字长串按宽字形保守估算（W 实测 10.38px）', () => {
    const lines = memoryViewLabelLines('W'.repeat(12));
    expect(lines[0]).toBe('W'.repeat(11)); // 11×10.5=115.5 ≤ 116；12×10.5=126 超
    expect(lines[1]).toBe('W');
  });

  it('label 切片：无断点 URL 硬切且估算宽恒不超预算', () => {
    const url = 'https://example.com/some/very/long/path?with=params';
    const lines = memoryViewLabelLines(url);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    for (const line of lines) {
      expect(memoryViewLineWidthPx(line)).toBeLessThanOrEqual(MEMORY_GRAPH_LABEL_LINE_PX);
    }
  });

  it('label 切片：估算器恒不等式——任意语料下每行估算宽 ≤ 预算（含省略号）', () => {
    const corpus = [
      '裁决（2026-10-11 起生效，替代旧表述，适用于 chamber 平台全部 recall 调用方，含 web 与 agent 通道）：记忆召回 conte',
      'Chamber Topic 消息系统的一项裁决：消息 immutable 原则。范围是 Chamber Topic 消息系统；消息不可编辑',
      '网络框架代码必须做统一拦截器（请求前 + 响应后），适用于用户的客户端/前端网络层代码，全项目通用',
      'Ruling (effective 2026-10-11): across all chamber Topic/Board message and comment',
      'MEMORY_GRAPH_LABEL_LINE_UNITS_CONSTANT_NAME_LIKE_THIS_ONE',
      '',
      '一',
    ];
    for (const label of corpus) {
      for (const line of memoryViewLabelLines(label)) {
        expect(memoryViewLineWidthPx(line)).toBeLessThanOrEqual(MEMORY_GRAPH_LABEL_LINE_PX);
      }
      expect(memoryViewLabelLines(label).length).toBeLessThanOrEqual(2);
    }
  });

  it('单行档：截断显式补省略号（P0-3 静默丢字修复），短串原样返回', () => {
    expect(memoryViewLabelSingleLine('short')).toBe('short');
    const single = memoryViewLabelSingleLine('b'.repeat(60));
    expect(single.endsWith('…')).toBe(true);
    expect(single).toBe(`${'b'.repeat(16)}…`); // (116−11)÷6.5 = 16 字
    expect(memoryViewLineWidthPx(single)).toBeLessThanOrEqual(MEMORY_GRAPH_LABEL_LINE_PX);
  });
});

describe('views 族：阶梯槽位与引擎记忆 id', () => {
  it('四态各归各档（missing 与 beyond **不得合并**——前者是异常信号）', () => {
    expect(memoryLadderSlotKind('current_materialized')).toBe('current');
    expect(memoryLadderSlotKind('historical_only')).toBe('historical');
    expect(memoryLadderSlotKind('missing_within_available')).toBe('missing');
    expect(memoryLadderSlotKind('beyond_available')).toBe('beyond');
    // 域外值回落到最保守的 beyond（不声称"有正文"、也不声称"数据不完整"）
    expect(memoryLadderSlotKind('something_new')).toBe('beyond');
  });

  it('默认呈现层级 = active 槽（缺失回落 null，由调用方给 R0）', () => {
    const ladder = (active: string) =>
      ['R0', 'R1', 'R2', 'R3', 'R4'].map<MemoryViewLadderSlot>((resolution) => ({
        resolution,
        state: 'current_materialized',
        active: resolution === active,
        current: null,
        historical_count: 0,
      }));
    expect(memoryLadderActiveResolution(ladder('R2'))).toBe('R2');
    expect(memoryLadderActiveResolution([])).toBeNull();
  });

  it('engineMemoryIds 取 [0]（与 completeCorrectionLink 兜底同口径）；空数组 ⇒ null', () => {
    expect(memoryViewEngineMemoryId({ engineMemoryIds: ['m1', 'm2'] })).toBe('m1');
    expect(memoryViewEngineMemoryId({ engineMemoryIds: [] })).toBeNull();
    expect(memoryViewEngineMemoryId({})).toBeNull();
  });
});

describe('views 族：累积页合并（节点 / 边 / ledgerMapping 三者同步）', () => {
  it('第二页只带自己的映射时，第一页的节点仍能钻取（N3 的核心断言）', () => {
    const first = mergeMemoryGraphPages(
      emptyMemoryGraphPages(),
      graphPage({ nodes: [viewNode('m1')], ledgerMapping: { m1: 'n1' }, nextCursor: 'c1' }),
    );
    const second = mergeMemoryGraphPages(
      first,
      graphPage({ nodes: [viewNode('m2')], ledgerMapping: { m2: 'n2' } }),
    );
    expect(second.nodes.map((item) => item.memory_id)).toEqual(['m1', 'm2']);
    expect(second.ledgerMapping).toEqual({ m1: 'n1', m2: 'n2' });
    expect(second.nextCursor).toBe('');
  });

  it('去重保序：同 id 不重复累积（防御引擎跨页重复）', () => {
    const first = mergeMemoryGraphPages(
      emptyMemoryGraphPages(),
      graphPage({
        nodes: [viewNode('m1')],
        edges: [viewEdge('e1', 'm1', 'm2', 'supports')],
        ledgerMapping: { m1: 'n1' },
      }),
    );
    const again = mergeMemoryGraphPages(
      first,
      graphPage({
        nodes: [viewNode('m1'), viewNode('m2')],
        edges: [viewEdge('e1', 'm1', 'm2', 'supports')],
        ledgerMapping: { m1: 'n1', m2: 'n2' },
      }),
    );
    expect(again.nodes).toHaveLength(2);
    expect(again.edges).toHaveLength(1);
  });

  it('平台计数取**最大值**而不是相加（相加会把同批过滤数重复计入）', () => {
    const first = mergeMemoryGraphPages(
      emptyMemoryGraphPages(),
      graphPage({ nodes: [viewNode('m1')], filteredNodeCount: 5, unmappedCount: 2 }),
    );
    const second = mergeMemoryGraphPages(
      first,
      graphPage({ nodes: [viewNode('m2')], filteredNodeCount: 3, unmappedCount: 0 }),
    );
    expect(second.filteredNodeCount).toBe(5);
    expect(second.unmappedCount).toBe(2);
  });

  it('partial / truncated 一旦为真就保持为真（任一分页为真即整体为真）', () => {
    const partial: MemoryGraphPages = mergeMemoryGraphPages(
      emptyMemoryGraphPages(),
      graphPage({ nodes: [viewNode('m1')], partial: true }),
    );
    expect(partial.partial).toBe(true);
    const next = mergeMemoryGraphPages(partial, graphPage({ nodes: [viewNode('m2')] }));
    expect(next.partial).toBe(true);
  });
});

describe('views 族：错误分叉与重置谓词', () => {
  it('404 / 503 / 502 各归各档，engineCode 原样读出', () => {
    const notFound = memoryViewErrorKind({
      response: { status: 404, data: { code: 14003 } },
    });
    expect(notFound.notFound).toBe(true);

    const unavailable = memoryViewErrorKind({
      response: { status: 503, data: { code: 14000, data: { reason: 'unreachable' } } },
    });
    expect(unavailable.engineUnavailable).toBe(true);

    const engineError = memoryViewErrorKind({
      response: { status: 502, data: { code: 14004, data: { engineCode: 'snapshot_stale' } } },
    });
    expect(engineError.engineError).toBe(true);
    expect(engineError.engineCode).toBe('snapshot_stale');
  });

  it('重置谓词只看 502/14004（**不看 engineCode**——cursor 失效是双通道）', () => {
    // invalid_argument 是第二个通道：把谓词写窄成只看 snapshot_stale 会把它漏掉
    expect(
      memoryViewNeedsReset({
        response: { status: 502, data: { code: 14004, data: { engineCode: 'invalid_argument' } } },
      }),
    ).toBe(true);
    expect(
      memoryViewNeedsReset({
        response: { status: 502, data: { code: 14004, data: { engineCode: 'something_else' } } },
      }),
    ).toBe(true);
    // 503 不触发重置（引擎不可用是另一档，重拉也没用）
    expect(memoryViewNeedsReset({ response: { status: 503, data: { code: 14000 } } })).toBe(false);
  });

  it('状态条文案按 engineCode 分叉（统一谓词下两种成因的下一步动作不同）', () => {
    expect(memoryViewResetKind('snapshot_stale')).toBe('stale');
    expect(memoryViewResetKind('invalid_argument')).toBe('stale');
    // 非 stale 的 502 不能套用"数据已变化"的文案（那是说假话）
    expect(memoryViewResetKind('engine_error')).toBe('other');
    expect(memoryViewResetKind(null)).toBe('other');
  });
});

describe('views 族：查询参数装配（后端 DTO 是 camelCase，禁 snake_case）', () => {
  it('relationType 必须发 camelCase —— 发送 `relation_type` 会被 forbidNonWhitelisted 当场 400', () => {
    /*
      真机回归：选任一关系过滤器曾把整页打进 400。根因是两侧名字不同——
      后端 `QueryMemoryViewGraphDto` 的属性名是 `relationType`，`relation_type` 是**服务层
      翻译给引擎**的名字；URL 参数名用 `relation_type` 只是 web 内部约定。
    */
    const params = buildMemoryGraphQueryParams({ relationType: 'supersedes' });
    expect(params).toEqual({ relationType: 'supersedes' });
    // 反向钉子：snake_case 一个都不许出现（出现了就是 400）
    expect(Object.keys(params)).not.toContain('relation_type');
  });

  it('三个过滤器都是 camelCase 且空值不发键（平台不设默认值，未传即引擎默认档）', () => {
    expect(buildMemoryGraphQueryParams({})).toEqual({});
    expect(buildMemoryGraphQueryParams({ kind: '', status: '', relationType: '' })).toEqual({});
    expect(
      buildMemoryGraphQueryParams({ kind: 'episode', status: 'active', relationType: 'part_of' }),
    ).toEqual({ kind: 'episode', status: 'active', relationType: 'part_of' });
  });
});

describe('views 族：omitted_edge_count 并入累积态（m2）', () => {
  it('取最大值合并——不读"最后一页的响应"，否则翻页时治理条数字会跳变', () => {
    const first = mergeMemoryGraphPages(
      emptyMemoryGraphPages(),
      graphPage({ nodes: [viewNode('m1')], omittedEdgeCount: 12 }),
    );
    expect(first.omittedEdgeCount).toBe(12);
    // 第二页自己算出来 3（各页各自口径）：合并后**不回落**到 3
    const second = mergeMemoryGraphPages(
      first,
      graphPage({ nodes: [viewNode('m2')], omittedEdgeCount: 3 }),
    );
    expect(second.omittedEdgeCount).toBe(12);
    // 反向：更大的值要抬上去
    const third = mergeMemoryGraphPages(
      second,
      graphPage({ nodes: [viewNode('m3')], omittedEdgeCount: 20 }),
    );
    expect(third.omittedEdgeCount).toBe(20);
  });

  it('空累积态从 0 起（重置 / 过滤器变更后不残留上一份数据的省略量）', () => {
    expect(emptyMemoryGraphPages().omittedEdgeCount).toBe(0);
  });
});

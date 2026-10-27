/**
 * doc-hints.helper 单测（2 期，v1.92.0-dev；阶段一抽核后）
 *
 * 覆盖矩阵（plan §5 unit）：全函数触发/不触发、trigram 阈值与 ci 精确命中排除、
 * pathTypes 最长前缀优先、路径形态判定、suggest_relaxing 的参数白名单
 * （sort/limit/offset 不算筛选）、**本文件与 hints/hint-registry 的同源守卫**、
 * `DOC_HINT_PROFILE` 的装配正确性。
 *
 * 排序 / ≤3 截尾 / 去重顺序 / makeHintCandidate 的形状纪律随内核迁到
 * `modules/hints/hint-core.spec.ts`（内核不认识领域 code，用假词表测）。
 */
import {
  buildCategoryNearDupHint,
  buildDocsOverviewRoutesTruncatedHint,
  buildDocsOverviewTruncatedHint,
  buildMetadataHints,
  buildPathTypeMismatchHint,
  buildQueryLooksLikePathHint,
  buildRouteAnchorBrokenHint,
  buildRouteAnchorRecheckHint,
  buildRouteTargetExcludedHint,
  buildSuggestRelaxingHint,
  buildTagNearDupHints,
  buildTagsNormalizedHint,
  DOC_HINT_PRIORITY,
  DOC_HINT_PROFILE,
  findNearDuplicates,
  hasUndeclaredTag,
  hintFamilyOf,
  HINT_TRIGRAM_THRESHOLD,
  isEntityAnchorTag,
  isPathLikeQuery,
  makeLegacySearchHintCandidate,
  matchPathType,
  shouldLoadTagPool,
  trigramSimilarity,
  type HintCandidate,
} from './doc-hints.helper';
// 同源守卫的另一端（docspace → hints 是允许方向；hints 不得反向 import 本域）
import { hintPriorityIndex, hintTtlOf, listHintDefinitions } from '../hints/hint-registry';
import { makeHintCandidate } from '../hints/hint-core';
import {
  DOC_HINT_CODES,
  DOC_HINT_MESSAGES,
  DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE,
} from '@agent-chamber/shared';

describe('doc-hints.helper', () => {
  // ─── 常量单源一致性 ─────────────────────────────────────────

  describe('常量单源', () => {
    it('DOC_HINT_PRIORITY 覆盖全部 code 且无重复（新增 code 必须同步优先级表）', () => {
      expect([...DOC_HINT_PRIORITY].sort()).toEqual([...DOC_HINT_CODES].sort());
      expect(new Set(DOC_HINT_PRIORITY).size).toBe(DOC_HINT_PRIORITY.length);
    });

    it('DOC_HINT_MESSAGES 对每个 code 都有非空文案', () => {
      for (const code of DOC_HINT_CODES) {
        expect(typeof DOC_HINT_MESSAGES[code]).toBe('string');
        expect(DOC_HINT_MESSAGES[code].length).toBeGreaterThan(0);
      }
    });

    it('hintFamilyOf：写侧族归属正确，tags_normalized 无族', () => {
      expect(hintFamilyOf('missing_category')).toBe('metadata');
      expect(hintFamilyOf('path_type_mismatch')).toBe('pathType');
      expect(hintFamilyOf('route_anchor_broken')).toBe('routes');
      expect(hintFamilyOf('query_looks_like_path')).toBe('read');
      expect(hintFamilyOf('tags_normalized')).toBeNull();
    });
  });

  // ─── trigram 相似度 ─────────────────────────────────────────

  describe('trigramSimilarity', () => {
    it('完全相等 → 1；任一侧为空串 → 0（双侧填充后仍无 gram）', () => {
      expect(trigramSimilarity('openviking', 'openviking')).toBe(1);
      expect(trigramSimilarity('', 'abc')).toBe(0);
    });

    it('对称且大小写不敏感', () => {
      expect(trigramSimilarity('OpenViking', 'openviking')).toBe(1);
      expect(trigramSimilarity('openviking', 'openviking2')).toBeCloseTo(
        trigramSimilarity('openviking2', 'openviking'),
        10,
      );
    });

    it('拼写近似 → 高于阈值；无关词 → 低于阈值', () => {
      expect(trigramSimilarity('openviking', 'openvikng')).toBeGreaterThan(HINT_TRIGRAM_THRESHOLD);
      expect(trigramSimilarity('openviking', 'database')).toBeLessThan(HINT_TRIGRAM_THRESHOLD);
    });
  });

  describe('findNearDuplicates', () => {
    const pool = [
      { value: 'openviking', count: 5 },
      { value: 'openvikng', count: 1 },
      { value: 'database', count: 9 },
      { value: 'OpenViking', count: 3 },
    ];

    it('阈值过滤 + 排除 ci 精确命中 + 相似度降序', () => {
      const out = findNearDuplicates('openviking', pool);
      // ci 精确命中（openviking / OpenViking）被排除，只剩拼写近似项
      expect(out.map((e) => e.value)).toEqual(['openvikng']);
    });

    it('top-N 截断（默认 3）', () => {
      const wide = [
        { value: 'aaaa1', count: 1 },
        { value: 'aaaa2', count: 2 },
        { value: 'aaaa3', count: 3 },
        { value: 'aaaa4', count: 4 },
      ];
      expect(findNearDuplicates('aaaa', wide, { threshold: 0.1 }).length).toBe(3);
      expect(findNearDuplicates('aaaa', wide, { threshold: 0.1, top: 2 }).length).toBe(2);
    });

    it('同相似度时 count 高者优先', () => {
      const same = [
        { value: 'zzzz1', count: 1 },
        { value: 'zzzz2', count: 9 },
      ];
      const out = findNearDuplicates('zzzz', same, { threshold: 0.1 });
      expect(out.map((e) => e.value)).toEqual(['zzzz2', 'zzzz1']);
    });

    it('空池 / 全不相似 → 空数组', () => {
      expect(findNearDuplicates('openviking', [])).toEqual([]);
      expect(findNearDuplicates('openviking', [{ value: 'database', count: 1 }])).toEqual([]);
    });
  });

  // ─── pathTypes 与路径形态 ───────────────────────────────────

  describe('matchPathType / isPathLikeQuery', () => {
    it('matchPathType：最长前缀优先；无命中 → null；null 词表 → null', () => {
      const pathTypes = [
        { pathPrefix: 'memory/', docType: 'memory' },
        { pathPrefix: 'memory/daily/', docType: 'diary' },
      ];
      expect(matchPathType('memory/daily/2026-10-05.md', pathTypes)?.docType).toBe('diary');
      expect(matchPathType('memory/2026-10-05.md', pathTypes)?.docType).toBe('memory');
      expect(matchPathType('docs/a.md', pathTypes)).toBeNull();
      expect(matchPathType('memory/a.md', null)).toBeNull();
    });

    it('isPathLikeQuery：含 / 且全字符合法且不以空白收尾', () => {
      expect(isPathLikeQuery('docs/architecture.md')).toBe(true);
      expect(isPathLikeQuery('memory/2026-10-05')).toBe(true);
      expect(isPathLikeQuery('文档/架构.md')).toBe(true);
      // 无斜杠
      expect(isPathLikeQuery('architecture')).toBe(false);
      // 含空白（内部/收尾）
      expect(isPathLikeQuery('docs/arch itecture.md')).toBe(false);
      expect(isPathLikeQuery('docs/architecture.md ')).toBe(false);
      // 含其他标点
      expect(isPathLikeQuery('docs/a?b')).toBe(false);
      expect(isPathLikeQuery('')).toBe(false);
    });
  });

  // ─── 写侧构造器 ─────────────────────────────────────────────

  describe('buildMetadataHints', () => {
    it('三项全缺 → 三条 suggestion；全有 → 空数组', () => {
      const all = buildMetadataHints({ categoryId: null, tags: [], summary: null }, 'doc-1');
      expect(all.map((c) => c.code).sort()).toEqual([
        'empty_summary',
        'empty_tags',
        'missing_category',
      ]);
      expect(all.every((c) => c.status === 'suggestion')).toBe(true);
      expect(all.every((c) => c.resourceKey === 'doc-1')).toBe(true);
      // 空白 summary 也算空
      expect(
        buildMetadataHints({ categoryId: 'c1', tags: ['a'], summary: '   ' }, 'doc-1').map(
          (c) => c.code,
        ),
      ).toEqual(['empty_summary']);
      expect(buildMetadataHints({ categoryId: 'c1', tags: ['a'], summary: 'ok' }, 'doc-1')).toEqual(
        [],
      );
    });
  });

  describe('buildPathTypeMismatchHint', () => {
    const pathTypes = [{ pathPrefix: 'memory/', docType: 'memory' }];

    it('命中前缀且 docType 不一致 → check_failed + data 三键', () => {
      const hint = buildPathTypeMismatchHint('memory/a.md', 'note', pathTypes, 'doc-1');
      expect(hint).not.toBeNull();
      expect(hint!.status).toBe('check_failed');
      expect(hint!.data).toEqual({ pathPrefix: 'memory/', expected: 'memory', actual: 'note' });
    });

    it('docType 一致 → 不发；docType 为空 → 发（actual null）', () => {
      expect(buildPathTypeMismatchHint('memory/a.md', 'memory', pathTypes, 'doc-1')).toBeNull();
      expect(buildPathTypeMismatchHint('memory/a.md', null, pathTypes, 'doc-1')?.data).toEqual({
        pathPrefix: 'memory/',
        expected: 'memory',
        actual: null,
      });
    });

    it('未声明 pathTypes / 前缀不命中 → null', () => {
      expect(buildPathTypeMismatchHint('memory/a.md', 'note', null, 'doc-1')).toBeNull();
      expect(buildPathTypeMismatchHint('docs/a.md', 'note', pathTypes, 'doc-1')).toBeNull();
    });
  });

  describe('buildTagNearDupHints', () => {
    const pool = [
      { value: 'openviking', count: 5 },
      { value: 'npc', count: 2 },
    ];

    it('词表外 tag 命中近义 → suggestion + 候选（只出候选不判同）', () => {
      const out = buildTagNearDupHints(['OpenVikings'], null, pool, 'doc-1');
      expect(out.length).toBe(1);
      expect(out[0].code).toBe('tag_near_dup');
      expect(out[0].status).toBe('suggestion');
      expect((out[0].data as { candidates: unknown[] }).candidates).toEqual([
        { value: 'openviking', count: 5 },
      ]);
    });

    it('词表内 tag（canonical/alias ci 命中）不再判近义（已被归一吸收）', () => {
      const vocabulary = [{ value: 'openviking', aliases: ['OpenViking'] }];
      expect(buildTagNearDupHints(['openviking'], vocabulary, pool, 'doc-1')).toEqual([]);
      expect(buildTagNearDupHints(['OpenViking'], vocabulary, pool, 'doc-1')).toEqual([]);
    });

    it('同 tag 重复只出一条；空 tags / 空池 → 空数组', () => {
      expect(buildTagNearDupHints(['OpenVikings', 'openvikings'], null, pool, 'doc-1').length).toBe(
        1,
      );
      expect(buildTagNearDupHints([], null, pool, 'doc-1')).toEqual([]);
      expect(buildTagNearDupHints(['x'], null, [], 'doc-1')).toEqual([]);
    });

    it('hasUndeclaredTag：词表外预判（池查询闸门）', () => {
      expect(hasUndeclaredTag(['foo'], null)).toBe(true);
      expect(hasUndeclaredTag(['foo'], [{ value: 'foo' }])).toBe(false);
      expect(hasUndeclaredTag(['FOO'], [{ value: 'foo' }])).toBe(false);
      expect(hasUndeclaredTag([], null)).toBe(false);
    });

    // ── 实体锚点抑制（批 1 回归，plan nightwing-polaris-phil-coulson 改动 2）─────

    it('实体锚点抑制：输入 tag / 池条目两侧都不参与近义比对', () => {
      // 判别力前置：下列相似度均已过阈（修复前必然误报 → 才证明本用例有判别力）
      expect(trigramSimilarity('V1.2.3', 'V1.2.4')).toBeGreaterThanOrEqual(HINT_TRIGRAM_THRESHOLD);
      expect(trigramSimilarity('2026-10-05-x', '2026-10-05')).toBeGreaterThanOrEqual(
        HINT_TRIGRAM_THRESHOLD,
      );

      // ① 输入 tag 命中锚点 → 该 tag 不比对（池里存在近义锚点也不出）
      expect(
        buildTagNearDupHints(['V1.2.4'], null, [{ value: 'V1.2.3', count: 1 }], 'doc-1'),
      ).toEqual([]);
      // ② 池条目命中锚点 → 池预过滤（输入非锚点也不再命中）；且**不是** candidates:[] 假阳性
      expect(
        buildTagNearDupHints(['2026-10-05-x'], null, [{ value: '2026-10-05', count: 1 }], 'doc-1'),
      ).toEqual([]);
      // ③ **输入过滤判别性锚**（唯一能证伪「输入过滤是死码」的用例）：池候选换成非锚点
      // `2026-10-05-x`（池预过滤放行），则只有输入过滤能拦下锚点 tag `2026-10-05`。
      // ①② 对此**零判别力**：两侧皆锚点时池预过滤先清空池 → 函数早退，输入过滤未执行。
      // 自检：删掉 doc-hints.helper.ts 的输入过滤 → 本断言出 1 条 hint → 红。
      expect(
        buildTagNearDupHints(['2026-10-05'], null, [{ value: '2026-10-05-x', count: 1 }], 'doc-1'),
      ).toEqual([]);
    });

    it('实体锚点抑制（混合）：只出非锚点 tag 的候选，锚点不出现在任何 hint / candidate', () => {
      const out = buildTagNearDupHints(
        ['release-v2', '2026-10-05'],
        null,
        [
          { value: 'release-v3', count: 1 }, // vs release-v2 = 0.6923（过阈）
          { value: '2026-05-05', count: 1 }, // vs 2026-10-05 = 0.5000（压线）
        ],
        'doc-1',
      );
      expect(out.length).toBe(1);
      expect(out[0].data).toEqual({
        tag: 'release-v2',
        candidates: [{ value: 'release-v3', count: 1 }],
      });
      // 闸门锚点预判与输入过滤同源的锁：日期既不出 hint，也不出 candidate
      expect(JSON.stringify(out)).not.toContain('2026-10-05');
      expect(JSON.stringify(out)).not.toContain('2026-05-05');
    });
  });

  // ─── 实体锚点谓词 / tag 池加载闸门（批 1）─────────────────────

  describe('实体锚点与 tag 池闸门（批 1）', () => {
    it('isEntityAnchorTag：5 类形态命中（含大写）；合法词 / 全字母 hex 不命中', () => {
      // 命中：ISO 日期 / 斜杠日期 / 纯数字（含紧凑日期 yyyyMMdd）/ 版本号 / hex ≥8 且含数字
      for (const hit of [
        '2026-10-05',
        '2026/10/05',
        '20261005',
        '1234',
        '1.2',
        'v1.2.3',
        'V1.2.3',
        'abcdef12',
        'ABCDEF12',
        'A1B2C3D4',
        '0123456789abcdef',
      ]) {
        expect(isEntityAnchorTag(hit)).toBe(true);
      }
      // 不命中（**逐条即取舍说明**）：
      // - 合法英文词与带非数字分隔符的复合词（复合形态本批不治，见常量注释 ②）
      // - 全字母 hex ≥8：判别点是 `(?=.*\d)` 而非 `{8,}`——`deadbeef` 是 8 位却无数字，
      //   刻意不抑制（防误伤合法词）；**别拿 `facade` 当反例**（6 位死于 `{8,}`，非判别点）
      // - 7 位 short SHA：`{8,}` 下界取舍（已知残余，见下条用例）
      // - 4 段版本号：模式只收 1~3 段
      for (const miss of [
        'npc',
        'world-b1',
        'openvikings',
        'deadbeef',
        'cafebabe',
        'DEADBEEF',
        'a1b2c3d',
        'V1.2.3.4',
        'release-2026-10-05',
      ]) {
        expect(isEntityAnchorTag(miss)).toBe(false);
      }
      // 确定性契约：连续调用恒同结果（正则禁 g/y 旗标——lastIndex 残留会翻盘）
      expect(isEntityAnchorTag('2026-10-05')).toBe(true);
      expect(isEntityAnchorTag('2026-10-05')).toBe(true);
    });

    it('shouldLoadTagPool 边界矩阵：族关 / 未携带 / 空数组 / 全声明 / 全锚点 → false', () => {
      const vocab = [{ value: 'npc', aliases: ['NPC'] }];
      const on = { tags: true, metadata: true };
      const off = { metadata: true };

      expect(shouldLoadTagPool(['foo'], off, vocab)).toBe(false); // 族关
      expect(shouldLoadTagPool(undefined, on, vocab)).toBe(false); // 未携带（批 1 核心语义）
      expect(shouldLoadTagPool([], on, vocab)).toBe(false); // 空数组
      expect(shouldLoadTagPool(['npc'], on, vocab)).toBe(false); // 全声明（canonical）
      expect(shouldLoadTagPool(['NPC'], on, vocab)).toBe(false); // 全声明（alias 形态）
      expect(shouldLoadTagPool(['2026-10-05', '1234'], on, vocab)).toBe(false); // 全锚点
      expect(shouldLoadTagPool(['npc', '2026-10-05'], on, vocab)).toBe(false); // 声明 + 锚点
      expect(shouldLoadTagPool(['foo'], null, vocab)).toBe(false); // toggles null = 全关

      expect(shouldLoadTagPool(['foo'], on, null)).toBe(true); // 无词表 → 全部词表外
      expect(shouldLoadTagPool(['foo'], on, vocab)).toBe(true); // 含词表外非锚点
      expect(shouldLoadTagPool(['npc', '2026-10-05', 'foo'], on, vocab)).toBe(true); // 混入即开
    });

    it('取舍留痕：邻日漂移 / 短 SHA 的真实相似度（防未来阈值微调后静默空转）', () => {
      // 本批**真实付出的代价**：同格式邻日 0.6923 明显过线，却是逐值唯一的实体锚点
      // —— 若未来有人把阈值上调到 0.7 以上，本用例会红，提醒重新评估该取舍
      expect(trigramSimilarity('2026-10-05', '2026-10-06')).toBeGreaterThan(HINT_TRIGRAM_THRESHOLD);
      // 可达样例的判别力前置（集成断言只该用 ≥ 阈值的夹具，否则是假覆盖）
      expect(trigramSimilarity('2026-10-05', '2026-05-05')).toBeGreaterThanOrEqual(
        HINT_TRIGRAM_THRESHOLD,
      );
      expect(trigramSimilarity('abcdef12', 'abcdef13')).toBeGreaterThanOrEqual(
        HINT_TRIGRAM_THRESHOLD,
      );
      // hex ≥8 含数字：两侧均被抑制
      expect(
        buildTagNearDupHints(['abcdef13'], null, [{ value: 'abcdef12', count: 1 }], 'doc-1'),
      ).toEqual([]);
      // 4 位纯数字对 0.4286 **不过阈** → 该形态只能由谓词直测覆盖（紧凑日期同理走 `^\d+$`）
      expect(trigramSimilarity('1234', '1235')).toBeLessThan(HINT_TRIGRAM_THRESHOLD);
      // 对照（**可达形态**）：8 位紧凑日期 yyyyMMdd 对 0.6364 **过阈** → 该形态真实可误报，
      // 抑制全靠 `^\d+$`（与上一行 0.4286 不可达形态成对留痕）。若未来有人收窄 `^\d+$`
      // （如限定位数），本断言会红 —— 提醒紧凑日期失去抑制、误报将复活。
      expect(trigramSimilarity('20261005', '20261006')).toBeGreaterThanOrEqual(
        HINT_TRIGRAM_THRESHOLD,
      );
      expect(
        buildTagNearDupHints(['20261005'], null, [{ value: '20261006', count: 1 }], 'doc-1'),
      ).toEqual([]);
      // 已知残余④：7 位 short SHA 不覆盖，0.6000 过线 → 仍会报（模式膨胀需观测支撑）
      expect(isEntityAnchorTag('a1b2c3d')).toBe(false);
      expect(trigramSimilarity('a1b2c3d', 'a1b2c3e')).toBeGreaterThanOrEqual(
        HINT_TRIGRAM_THRESHOLD,
      );
      expect(
        buildTagNearDupHints(['a1b2c3d'], null, [{ value: 'a1b2c3e', count: 1 }], 'doc-1').length,
      ).toBe(1);
    });
  });

  describe('buildTagsNormalizedHint', () => {
    it('无归一 → null；有归一 → status=normalized + mappings', () => {
      expect(buildTagsNormalizedHint([], 'doc-1')).toBeNull();
      const hint = buildTagsNormalizedHint([{ from: 'OpenViking', to: 'openviking' }], 'doc-1');
      expect(hint!.status).toBe('normalized');
      expect(hint!.data).toEqual({ mappings: [{ from: 'OpenViking', to: 'openviking' }] });
    });
  });

  describe('buildCategoryNearDupHint', () => {
    it('近义分类 → suggestion + created + 候选带 slug', () => {
      // 阈值 0.5 下 Design/Designs ≈ 0.67 过线（Desgin/Design ≈ 0.27 不过线——宁高勿低防误报）
      const pool = [{ value: 'Design', count: 3, extra: { slug: 'design' } }];
      const hint = buildCategoryNearDupHint('Designs', pool, 'cat-1');
      expect(hint!.code).toBe('category_near_dup');
      expect(hint!.data).toEqual({
        created: 'Designs',
        candidates: [{ name: 'Design', slug: 'design' }],
      });
    });

    it('无近义 / 空池 / 相似度不足阈值 → null', () => {
      expect(buildCategoryNearDupHint('Designs', [], 'cat-1')).toBeNull();
      // Desgin/Design ≈ 0.27 不过阈值 → 不出候选（宁高勿低）
      expect(
        buildCategoryNearDupHint('Desgin', [{ value: 'Design', count: 1 }], 'cat-1'),
      ).toBeNull();
      expect(
        buildCategoryNearDupHint('Design', [{ value: 'Design', count: 1 }], 'cat-1'),
      ).toBeNull();
    });
  });

  describe('buildRouteTargetExcludedHint', () => {
    it('docType 命中 excludeTypes → matchedExclusion.kind=type', () => {
      const hint = buildRouteTargetExcludedHint('r1', 'memory/a.md', 'memory', null, {
        excludeTypes: ['memory'],
      });
      expect(hint!.resourceKey).toBe('r1');
      expect(hint!.data).toEqual({
        routeId: 'r1',
        docPath: 'memory/a.md',
        matchedExclusion: { kind: 'type', value: 'memory' },
      });
    });

    it('category slug 命中 excludeCategories → kind=category', () => {
      const hint = buildRouteTargetExcludedHint('r1', 'docs/a.md', 'guide', 'archive', {
        excludeCategories: ['archive'],
      });
      expect((hint!.data as { matchedExclusion: unknown }).matchedExclusion).toEqual({
        kind: 'category',
        value: 'archive',
      });
    });

    it('未配过滤 / 无命中 / 脏形状 → null', () => {
      expect(buildRouteTargetExcludedHint('r1', 'a.md', 'memory', null, null)).toBeNull();
      expect(
        buildRouteTargetExcludedHint('r1', 'a.md', 'guide', 'x', { excludeTypes: ['memory'] }),
      ).toBeNull();
      expect(
        buildRouteTargetExcludedHint('r1', 'a.md', 'memory', null, { excludeTypes: 'memory' }),
      ).toBeNull();
    });
  });

  describe('buildRouteAnchorRecheckHint / buildRouteAnchorBrokenHint', () => {
    it('recheck：有路由 → suggestion + routeIds；无路由 → null', () => {
      expect(buildRouteAnchorRecheckHint([], 'doc-1')).toBeNull();
      const hint = buildRouteAnchorRecheckHint(['r1', 'r2'], 'doc-1');
      expect(hint!.status).toBe('suggestion');
      expect(hint!.data).toEqual({ routeIds: ['r1', 'r2'] });
    });

    it('recheck skipped 变体：check_skipped + reason + 专用文案（未检查 ≠ 健康）', () => {
      const hint = buildRouteAnchorRecheckHint([], 'doc-1', { skipped: true, total: 25 });
      expect(hint!.status).toBe('check_skipped');
      expect(hint!.data).toEqual({ count: 25, reason: 'too_many_affected' });
      expect(hint!.message).toBe(DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE);
    });

    it('broken：有 routeIds → check_failed + anchors；无 → null', () => {
      expect(buildRouteAnchorBrokenHint([], [], 'doc-1')).toBeNull();
      const hint = buildRouteAnchorBrokenHint(
        ['r1'],
        [{ routeId: 'r1', headingPath: 'A § B' }],
        'doc-1',
      );
      expect(hint!.status).toBe('check_failed');
      expect(hint!.data).toEqual({
        routeIds: ['r1'],
        anchors: [{ routeId: 'r1', headingPath: 'A § B' }],
      });
    });
  });

  // ─── 读侧构造器 ─────────────────────────────────────────────

  describe('buildQueryLooksLikePathHint / buildSuggestRelaxingHint', () => {
    it('query_looks_like_path：data = {path, docId}，resourceKey = path', () => {
      const hint = buildQueryLooksLikePathHint('docs/a.md', 'doc-1', 'docs/a.md');
      expect(hint.status).toBe('suggestion');
      expect(hint.resourceKey).toBe('docs/a.md');
      expect(hint.data).toEqual({ path: 'docs/a.md', docId: 'doc-1' });
    });

    it('suggest_relaxing：只列真实用过的可筛参数；sort/limit/offset 不算筛选', () => {
      const hint = buildSuggestRelaxingHint(
        { type: 'memory', createdAfter: '2026-01-01T00:00:00.000Z' },
        'space-1:sig',
      );
      expect(hint!.data).toEqual({
        appliedFilters: { type: 'memory', createdAfter: '2026-01-01T00:00:00.000Z' },
        removableParams: ['type', 'createdAfter'],
        note: 'relaxing filters is not guaranteed to produce hits',
      });
      // 只有非筛选参数 → 不发
      expect(
        buildSuggestRelaxingHint({ sort: 'createdAt_desc', limit: 5 }, 'space-1:sig'),
      ).toBeNull();
      expect(buildSuggestRelaxingHint({}, 'space-1:sig')).toBeNull();
    });

    it('docs_overview_truncated（阶段三）：data 四字段 + resourceKey = spaceId（去重键语义）', () => {
      const hint = buildDocsOverviewTruncatedHint('space-1', 12, 50);

      expect(hint.code).toBe('docs_overview_truncated');
      expect(hint.status).toBe('suggestion');
      // resourceKey = spaceId（同一空间 24h 内提醒一次）
      expect(hint.resourceKey).toBe('space-1');
      expect(hint.data).toEqual({
        section: 'docs',
        returnedCount: 12,
        totalCount: 50,
        suggestedTool: 'get_docs_overview',
        // 最便宜下一步：catalog 投影豁免截断（一次请求拿全目录）
        suggestedParams: { catalog: true },
      });
    });

    it('docs_overview_routes_truncated：data 五字段 + resourceKey = spaceId（与 docs 段码独立）', () => {
      const hint = buildDocsOverviewRoutesTruncatedHint('space-1', 50, 353);

      expect(hint.code).toBe('docs_overview_routes_truncated');
      expect(hint.status).toBe('suggestion');
      // resourceKey = spaceId（同一空间 24h 内提醒一次；与 docs 段码同键但 code 不同 ⇒
      // 去重键 (actor, code, resourceKey) 互不干扰）
      expect(hint.resourceKey).toBe('space-1');
      expect(hint.data).toEqual({
        section: 'routes',
        returnedCount: 50,
        totalCount: 353,
        suggestedTool: 'list_doc_routes',
        // 分页拉全的起点（单页上限 100；按 q/category 定位是后续可选精化）
        suggestedParams: { page: 1, pageSize: 100 },
      });
    });
  });

  // ─── 旧三态双写候选（领域语义；排序/截尾已随内核迁走）─────────

  describe('makeLegacySearchHintCandidate', () => {
    it('noDedup 标记 + suggestion + data 原样（迁移期双写）', () => {
      const legacy = makeLegacySearchHintCandidate('weak_hit', 'space-1:abc', {
        topScore: 0.2,
        threshold: 0.9,
      });
      expect(legacy).toMatchObject({
        code: 'weak_hit',
        status: 'suggestion',
        resourceKey: 'space-1:abc',
        noDedup: true,
        data: { topScore: 0.2, threshold: 0.9 },
      });
      // 常规构造器不携带 noDedup（只有旧三态豁免窗口）
      expect(makeHintCandidate('empty_tags', 'suggestion', 'k')).not.toHaveProperty('noDedup');
    });

    it('候选形状纪律：空 data 对象不落键', () => {
      const candidate: HintCandidate = makeHintCandidate('empty_tags', 'suggestion', 'k1', {});
      expect(candidate).not.toHaveProperty('data');
    });
  });

  // ─── 与 hints/hint-registry 的同源守卫（阶段一抽核）──────────

  describe('hints/hint-registry 同源守卫', () => {
    it('注册表的 docspace 名次序 == DOC_HINT_PRIORITY（两处漂移 = 排序静默改变）', () => {
      const rankOrder = [...DOC_HINT_PRIORITY];
      const registryOrder = [...hintPriorityIndex().entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([code]) => code);
      expect(registryOrder).toEqual(rankOrder);
    });

    it('注册表的族归属 == CODE_FAMILY（hintFamilyOf 单源）', () => {
      for (const code of DOC_HINT_CODES) {
        const definition = listHintDefinitions().find((entry) => entry.code === code);
        expect(definition?.family).toBe(hintFamilyOf(code));
      }
    });

    it('注册表的 messageSource 指向 shared 文案单源（禁写正文）', () => {
      // 只校验 **docspace 段**：memory / task / board 段的文案单源在各自领域文件
      // （本 spec 是 docspace 侧的守卫；全域指针齐备由 hint-registry.spec 的非空断言覆盖）
      for (const code of DOC_HINT_CODES) {
        const definition = listHintDefinitions().find((entry) => entry.code === code);
        expect(definition?.messageSource).toContain('DOC_HINT_MESSAGES');
      }
    });
  });

  // ─── DOC_HINT_PROFILE（内核的领域侧配置单源）───────────────

  describe('DOC_HINT_PROFILE', () => {
    it('priority 就是 D6 优先级序（内核排序执行的唯一输入）', () => {
      expect(DOC_HINT_PROFILE.priority).toBe(DOC_HINT_PRIORITY);
    });

    it('resolveMessage：缺省取 DOC_HINT_MESSAGES 单源；候选自带 message 时覆盖优先', () => {
      const plain = makeHintCandidate('missing_category', 'suggestion', 'k1');
      expect(DOC_HINT_PROFILE.resolveMessage(plain)).toBe(DOC_HINT_MESSAGES.missing_category);

      const overridden = makeHintCandidate(
        'route_anchor_recheck',
        'check_skipped',
        'k2',
        undefined,
        DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE,
      );
      expect(DOC_HINT_PROFILE.resolveMessage(overridden)).toBe(
        DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE,
      );
    });

    it('familyOf：转发 hintFamilyOf（埋点族维度与排序/文案同源）', () => {
      for (const code of DOC_HINT_CODES) {
        expect(DOC_HINT_PROFILE.familyOf!(code)).toBe(hintFamilyOf(code));
      }
    });

    it('ttlOf：转发注册表 hintTtlOf（窗口长度单源；缺此钩子 ⇒ 24h 教学码静默落 6h 缺省）', () => {
      for (const code of DOC_HINT_CODES) {
        expect(DOC_HINT_PROFILE.ttlOf!(code)).toBe(hintTtlOf(code));
      }
    });
  });
});

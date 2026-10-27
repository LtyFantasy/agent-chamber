/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 空间 settings 四键（docTypes / canonicalTags / pathTypes / hintToggles）的
 *     **读侧形状闸门**单测（2 期补齐 parseHintToggles 边界；前三个解析器同文件同约）；
 *     3 期补两个存量治理纯函数（applyTagRenameToVocabulary / expandTagQueryValues）矩阵。
 *
 * [代码职责]
 *   - 钉住「脏 jsonb 永不抛」与「null = 无配置」两条不变量：非 object/数组/全异形 →
 *     null；异形元素逐条剔除；**只认 boolean**（真值化猜测会让族闸门意外打开）。
 *   - 钉住词表变换的两条不变量：**无条件生成 alias**（词表未声明则创建）与**幂等重入**
 *     （同一 rename 跑两遍第二遍零变化）；以及读侧展开的**集合语义**（未命中原样单元素）。
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §16.4（hintToggles 六族 + 词表三键）
 *   - 补充: docs/spec.md §4.1a（空间词表类型）
 *
 * [踩坑索引]
 *   - VOCAB-SHAPE-1：只挡「非数组」不挡元素形状 → 读面 500 / 静默错归一
 *     （见 doc-vocabulary.helper.ts [持久踩坑]）
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #21(双层校验)
 *
 * [修改检查]
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 行为/契约变化时同步更新代码侧 AGENT-CODE-HOOK 与本文
 * =============================================================================
 */
import type { DocSpaceCanonicalTag } from '@agent-chamber/shared';
import { DOC_SPACE_TAG_ALIASES_MAX } from '@agent-chamber/shared';
import {
  applyTagRenameToVocabulary,
  expandTagQueryValues,
  normalizeTagRenameValues,
  parseCanonicalTags,
  parseHintToggles,
  parsePathTypes,
  parseStringList,
} from './doc-vocabulary.helper';

describe('doc-vocabulary.helper', () => {
  // ─── parseHintToggles（2 期 m2 补齐）────────────────────────────────────

  describe('parseHintToggles', () => {
    it('非 object（null / undefined / 标量 / 字符串 / 数组）→ null（= 全关）', () => {
      for (const raw of [null, undefined, 'metadata', 42, true, ['metadata'], () => {}]) {
        expect(parseHintToggles(raw)).toBeNull();
      }
    });

    it('空对象 / 全异形值 → null；false 值保留（合法的「显式关」）', () => {
      expect(parseHintToggles({})).toBeNull();
      expect(parseHintToggles({ metadata: 'yes', tags: 1, routes: null })).toBeNull();
      expect(parseHintToggles({ metadata: false })).toEqual({ metadata: false });
      expect(parseHintToggles({ metadata: false, tags: true })).toEqual({
        metadata: false,
        tags: true,
      });
    });

    it('未知族键剔除（合法键保留；全未知 → null）', () => {
      expect(parseHintToggles({ metadata: true, bogus: true, future: false })).toEqual({
        metadata: true,
      });
      expect(parseHintToggles({ bogus: true })).toBeNull();
    });

    it('合法六族原样返回（不做真值化、不补缺键）', () => {
      const all = {
        metadata: true,
        tags: false,
        categories: true,
        pathType: false,
        routes: true,
        read: false,
      };
      expect(parseHintToggles(all)).toEqual(all);
      // 缺键不补（消费方一律 `=== true` 判定，缺键与 false 同义）
      expect(parseHintToggles({ routes: true })).toEqual({ routes: true });
    });

    it('混合脏形状：只留合法 boolean 键（其余静默剔除，永不抛）', () => {
      expect(parseHintToggles({ metadata: true, tags: 'on', categories: false, x: 1 })).toEqual({
        metadata: true,
        categories: false,
      });
    });

    it('数组形态（typeof object 的陷阱）被显式挡下', () => {
      expect(parseHintToggles([])).toBeNull();
      expect(parseHintToggles([{ metadata: true }])).toBeNull();
    });
  });

  // ─── 三个既有解析器（同文件同约，补最小回归）────────────────────────────

  describe('既有三键解析器（回归）', () => {
    it('parseStringList：非数组/空/全异形 → null；非空字符串保留', () => {
      expect(parseStringList(null)).toBeNull();
      expect(parseStringList([])).toBeNull();
      expect(parseStringList([1, '', '  ', null])).toBeNull();
      expect(parseStringList(['guide', 1, 'memory'])).toEqual(['guide', 'memory']);
    });

    it('parseCanonicalTags：元素级闸门；aliases 缺省合法、存在但异形整条剔除', () => {
      expect(parseCanonicalTags(['openviking'])).toBeNull();
      expect(parseCanonicalTags([{ value: 'npc' }])).toEqual([{ value: 'npc', aliases: [] }]);
      expect(parseCanonicalTags([{ value: 'npc', aliases: 'NPC' }])).toBeNull();
      expect(parseCanonicalTags([{ value: 'npc', aliases: ['NPC', 1] }])).toBeNull();
    });

    it('parsePathTypes：pathPrefix/docType 双必填非空', () => {
      expect(parsePathTypes(null)).toBeNull();
      expect(parsePathTypes([{ pathPrefix: 'memory/' }])).toBeNull();
      expect(parsePathTypes([{ pathPrefix: 'memory/', docType: 'memory' }])).toEqual([
        { pathPrefix: 'memory/', docType: 'memory' },
      ]);
    });
  });

  // ─── normalizeTagRenameValues（3 期：from 归一单源）────────────────────

  describe('normalizeTagRenameValues', () => {
    it('trim + 去空 + 字节精确去重（保序）', () => {
      expect(normalizeTagRenameValues([' NPC ', '', '  ', 'npc-old'], 'target')).toEqual([
        'NPC',
        'npc-old',
      ]);
    });

    it('ci 等价于 to 但字节不同的值保留（存量变体，A1）；字节全等的自映射剔除', () => {
      expect(normalizeTagRenameValues(['NPC', 'npc'], 'npc')).toEqual(['NPC']);
      expect(normalizeTagRenameValues(['npc'], 'npc')).toEqual([]);
      expect(normalizeTagRenameValues(['NPC'], 'npc')).toEqual(['NPC']);
    });

    it('字节精确去重：ci 变体**全保留**（评审 M1——它们是不同的存量存储值）', () => {
      expect(normalizeTagRenameValues(['npc', 'NpC', 'NPC'], 'npc-canon')).toEqual([
        'npc',
        'NpC',
        'NPC',
      ]);
      // 同一字节形态的重复才去重（含 trim 后同形）
      expect(normalizeTagRenameValues(['NPC', 'NPC', ' NPC '], 'npc-canon')).toEqual(['NPC']);
    });
  });

  // ─── applyTagRenameToVocabulary（3 期 D6 矩阵）──────────────────────────

  describe('applyTagRenameToVocabulary', () => {
    it('词表未声明（null / 空数组）→ 创建词表键（created=true，from 全进 aliases）', () => {
      const cases: Array<DocSpaceCanonicalTag[] | null | undefined> = [null, undefined, []];
      for (const vocabulary of cases) {
        const out = applyTagRenameToVocabulary(vocabulary, ['NPC', 'npc '], 'npc');
        expect(out.created).toBe(true);
        expect(out.next).toEqual([{ value: 'npc', aliases: ['NPC'] }]);
        expect(out.addedAliases).toEqual(['NPC']);
        expect(out.removedCanonicals).toEqual([]);
        expect(out.movedAliases).toEqual([]);
      }
    });

    it('to 不在词表 → 追加 canonical 条目（created=false，from 并入其 aliases）', () => {
      const out = applyTagRenameToVocabulary([{ value: 'guide', aliases: [] }], ['NPC'], 'npc');
      expect(out.created).toBe(false);
      expect(out.next).toEqual([
        { value: 'guide', aliases: [] },
        { value: 'npc', aliases: ['NPC'] },
      ]);
      expect(out.addedAliases).toEqual(['NPC']);
    });

    it('from 本身是 canonical → 删除该条目，条目值 + 其 aliases 并入 to（merge 两 canonical）', () => {
      const out = applyTagRenameToVocabulary(
        [
          { value: 'NPC', aliases: ['npc-old'] },
          { value: 'npc', aliases: [] },
        ],
        ['NPC'],
        'npc',
      );
      expect(out.removedCanonicals).toEqual(['NPC']);
      expect(out.next).toEqual([{ value: 'npc', aliases: ['NPC', 'npc-old'] }]);
      expect(out.addedAliases).toEqual(['NPC', 'npc-old']);
      expect(out.movedAliases).toEqual([]);
    });

    it('from 是其他 canonical 的 alias → 摘除并迁入 to（movedAliases 记归属迁移）', () => {
      const out = applyTagRenameToVocabulary(
        [
          { value: 'guide', aliases: ['docs'] },
          { value: 'npc', aliases: [] },
        ],
        ['docs'],
        'npc',
      );
      expect(out.movedAliases).toEqual([
        { alias: 'docs', fromCanonical: 'guide', toCanonical: 'npc' },
      ]);
      expect(out.next).toEqual([
        { value: 'guide', aliases: [] },
        { value: 'npc', aliases: ['docs'] },
      ]);
      expect(out.addedAliases).toEqual(['docs']);
    });

    it('from 不在词表 → 直接加入 to.aliases；ci 等价于 to 的值跳过', () => {
      const out = applyTagRenameToVocabulary(
        [{ value: 'npc', aliases: [] }],
        ['NPC', 'unknown', 'npc'],
        'npc',
      );
      expect(out.next).toEqual([{ value: 'npc', aliases: ['NPC', 'unknown'] }]);
      expect(out.addedAliases).toEqual(['NPC', 'unknown']);
    });

    it('to 已存在（大小写变体）→ 复用既有条目，不新建（声明形态不变）', () => {
      const out = applyTagRenameToVocabulary([{ value: 'NPC', aliases: [] }], ['old-npc'], 'npc');
      expect(out.next).toEqual([{ value: 'NPC', aliases: ['old-npc'] }]);
      expect(out.addedAliases).toEqual(['old-npc']);
    });

    it('幂等重入：同一 rename 跑两遍，第二遍零变化', () => {
      const first = applyTagRenameToVocabulary(
        [{ value: 'guide', aliases: ['docs'] }],
        ['docs', 'NPC'],
        'npc',
      );
      const second = applyTagRenameToVocabulary(first.next, ['docs', 'NPC'], 'npc');
      expect(second.created).toBe(false);
      expect(second.addedAliases).toEqual([]);
      expect(second.removedCanonicals).toEqual([]);
      expect(second.movedAliases).toEqual([]);
      expect(second.next).toEqual(first.next);
    });

    it('三字节变体全进 aliases（评审 M1：ci 变体不合并，且幂等重入零变化）', () => {
      const out = applyTagRenameToVocabulary(null, ['npc', 'NpC', 'NPC'], 'npc-canon');
      expect(out.next).toEqual([{ value: 'npc-canon', aliases: ['npc', 'NpC', 'NPC'] }]);
      expect(out.addedAliases).toEqual(['npc', 'NpC', 'NPC']);

      // 幂等重入：三个变体都已就位 → 第二遍零变化
      const again = applyTagRenameToVocabulary(out.next, ['npc', 'NpC', 'NPC'], 'npc-canon');
      expect(again.addedAliases).toEqual([]);
      expect(again.next).toEqual(out.next);
    });

    it('别名上限：超 DOC_SPACE_TAG_ALIASES_MAX 截尾部并回报 truncatedAliases（minor-1）', () => {
      const existing = Array.from({ length: DOC_SPACE_TAG_ALIASES_MAX - 1 }, (_, i) => `old-${i}`);
      const out = applyTagRenameToVocabulary(
        [{ value: 'cap', aliases: existing }],
        ['n1', 'n2', 'n3'],
        'cap',
      );
      // 保「先旧后新、截断溢出」：旧 19 个原样保留，只收下第 1 个新别名
      const cappedAliases = out.next.find((e) => e.value === 'cap')?.aliases ?? [];
      expect(cappedAliases).toHaveLength(DOC_SPACE_TAG_ALIASES_MAX);
      expect(cappedAliases.slice(0, DOC_SPACE_TAG_ALIASES_MAX - 1)).toEqual(existing);
      expect(out.addedAliases).toEqual(['n1']);
      expect(out.truncatedAliases).toEqual(['n2', 'n3']);
    });

    it('遗留超限词表：rename 后收敛到上限（编辑面不再被 @ArrayMaxSize 锁死）', () => {
      const legacy = Array.from({ length: DOC_SPACE_TAG_ALIASES_MAX + 5 }, (_, i) => `legacy-${i}`);
      const out = applyTagRenameToVocabulary([{ value: 'cap', aliases: legacy }], ['n1'], 'cap');
      expect(out.next.find((e) => e.value === 'cap')?.aliases ?? []).toEqual(
        legacy.slice(0, DOC_SPACE_TAG_ALIASES_MAX),
      );
      expect(out.truncatedAliases).toEqual([...legacy.slice(DOC_SPACE_TAG_ALIASES_MAX), 'n1']);
      // 被裁的新别名从 addedAliases 摘除（addedAliases ⊆ next 里真实存在的 alias）
      expect(out.addedAliases).toEqual([]);
    });

    it('未触上限：truncatedAliases 恒存在且为空数组', () => {
      const out = applyTagRenameToVocabulary(null, ['a'], 'b');
      expect(out.truncatedAliases).toEqual([]);
    });

    it('产物不变量：alias 不撞任何其他 canonical（即使 from 目标与既有 canonical 同名）', () => {
      // from 里既有 canonical 条目 'npc'，又有指向它的别名——产物中 'npc' 只作为 to 的 canonical
      const out = applyTagRenameToVocabulary(
        [
          { value: 'npc', aliases: ['NPC'] },
          { value: 'legacy', aliases: ['npc'] },
        ],
        ['legacy'],
        'npc',
      );
      const canonicalValues = out.next.map((e) => e.value.toLowerCase());
      expect(new Set(canonicalValues).size).toBe(canonicalValues.length);
      for (const entry of out.next) {
        for (const alias of entry.aliases ?? []) {
          // 字节全等于自身 canonical 的 alias 无意义（已被跳过）
          expect(alias).not.toBe(entry.value);
          // 不得 ci 撞**其他**条目的 canonical（写侧 validateVocabulary 的 422 红线）
          for (const other of out.next) {
            if (other === entry) continue;
            expect(alias.toLowerCase()).not.toBe(other.value.toLowerCase());
          }
        }
      }
      expect(out.next).toEqual([{ value: 'npc', aliases: ['NPC', 'legacy'] }]);
    });
  });

  // ─── expandTagQueryValues（3 期 D3/A1 矩阵）─────────────────────────────

  describe('expandTagQueryValues', () => {
    const vocabulary = [{ value: 'npc', aliases: ['NPC', 'npc-old'] }];

    it('命中 canonical（含大小写变体）→ 返回全集 [canonical, ...aliases]', () => {
      expect(expandTagQueryValues(vocabulary, 'npc')).toEqual(['npc', 'NPC', 'npc-old']);
      expect(expandTagQueryValues(vocabulary, 'NPC')).toEqual(['npc', 'NPC', 'npc-old']);
    });

    it('命中 alias（ci）→ 返回同一全集', () => {
      expect(expandTagQueryValues(vocabulary, 'npc-old')).toEqual(['npc', 'NPC', 'npc-old']);
      expect(expandTagQueryValues(vocabulary, 'npc-OLD')).toEqual(['npc', 'NPC', 'npc-old']);
    });

    it('未命中 → 原样单元素（行为逐字节不变）', () => {
      expect(expandTagQueryValues(vocabulary, 'unknown')).toEqual(['unknown']);
    });

    it('词表为 null/空 → 原样单元素', () => {
      expect(expandTagQueryValues(null, 'npc')).toEqual(['npc']);
      expect(expandTagQueryValues([], 'npc')).toEqual(['npc']);
    });

    it('aliases 缺省 → 只返回 canonical 单元素', () => {
      expect(expandTagQueryValues([{ value: 'npc' }], 'NPC')).toEqual(['npc']);
    });

    it('精确字符串去重：alias 与 canonical 仅大小写不同时**两者都保留**（存量变体不漏召回）', () => {
      expect(expandTagQueryValues([{ value: 'npc', aliases: ['NPC', 'npc'] }], 'npc')).toEqual([
        'npc',
        'NPC',
      ]);
    });

    it('多字节变体：展开集全含（评审 M1 的读侧对称面）', () => {
      const vocabulary = [{ value: 'npc-canon', aliases: ['npc', 'NpC', 'NPC'] }];
      expect(expandTagQueryValues(vocabulary, 'NPC')).toEqual(['npc-canon', 'npc', 'NpC', 'NPC']);
      expect(expandTagQueryValues(vocabulary, 'npc-canon')).toEqual([
        'npc-canon',
        'npc',
        'NpC',
        'NPC',
      ]);
    });
  });
});

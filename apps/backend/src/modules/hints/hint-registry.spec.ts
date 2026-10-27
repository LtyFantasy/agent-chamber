/**
 * hint 注册表（code 元数据目录）单测（阶段一抽核 / 阶段二扩码 / v1.94.0-dev 两族扩码）
 *
 * 覆盖：全表完整性（码唯一，docspace 18 + memory formation 13 + memory nomination 1
 * + memory usage 1 + task hygiene 4 + board digest 1 + security 1 = 39）/
 * 按 code 查表 / 优先级索引（名次连续且无重复）/ ttl 覆盖（docspace 有窗口者 = 6h 缺省、
 * 豁免者无 ttl；memory nomination = **10min 显式覆盖**、截断续读码 = **24h 显式覆盖**、
 * 两个新族 = **6h 显式覆盖**）/
 * 族归属 / 过滤查询 /
 * `HintRegistry` 门面与纯函数一致 / **ttlMs 直接驱动去重窗口**（阶段三的 10min 收紧与 24h 放宽语义）。
 */
import { DOC_HINT_CODES } from '@agent-chamber/shared';
import { HINT_DEDUP_TTL_MS, HintDedupService } from './hint-dedup.service';
import {
  BOARD_DIGEST_DEFINITIONS,
  DOC_HINT_DEFINITIONS,
  getHintDefinition,
  hintFamilyOf,
  hintPriorityIndex,
  hintTtlOf,
  HintRegistry,
  HINT_DEFINITIONS,
  listHintDefinitions,
  MEMORY_HINT_DEFINITIONS,
  MEMORY_NOMINATION_DEFINITIONS,
  MEMORY_USAGE_DEFINITIONS,
  SECURITY_HINT_DEFINITIONS,
  TASK_HYGIENE_DEFINITIONS,
} from './hint-registry';

/** 豁免去重的 4 个 docspace code：1 个 normalized 事实回显 + 3 个旧三态双写 */
const DEDUP_EXEMPT_CODES = ['tags_normalized', 'zero_hit', 'weak_hit', 'positional_order'];

/** 拦截器通道码的显式去重窗口（10min；与注册表内联值逐字一致，阶段三由 24h 收紧） */
const NOMINATION_TTL_MS = 10 * 60 * 1000;

describe('hint-registry（code 元数据目录）', () => {
  describe('表完整性', () => {
    it('全表 = docspace 18 + memory formation 13 + memory nomination 1 + memory usage 1 + task hygiene 4 + board digest 1 + security 1，且 code 全局唯一', () => {
      expect(DOC_HINT_DEFINITIONS).toHaveLength(18);
      expect(MEMORY_HINT_DEFINITIONS).toHaveLength(13);
      expect(MEMORY_NOMINATION_DEFINITIONS).toHaveLength(1);
      expect(MEMORY_USAGE_DEFINITIONS).toHaveLength(1);
      expect(TASK_HYGIENE_DEFINITIONS).toHaveLength(4);
      expect(BOARD_DIGEST_DEFINITIONS).toHaveLength(1);
      expect(SECURITY_HINT_DEFINITIONS).toHaveLength(1);
      expect(HINT_DEFINITIONS).toHaveLength(39);

      const codes = HINT_DEFINITIONS.map((definition) => definition.code);
      expect(new Set(codes).size).toBe(codes.length);
    });

    it('docspace 段与 shared DOC_HINT_CODES 同集合（无遗漏、无多出）', () => {
      expect(DOC_HINT_DEFINITIONS.map((d) => d.code).sort()).toEqual([...DOC_HINT_CODES].sort());
    });

    it('每条元数据都有非空 ownerSurface 与 messageSource 指针（禁正文）', () => {
      for (const definition of HINT_DEFINITIONS) {
        expect(definition.ownerSurface.length).toBeGreaterThan(0);
        expect(definition.messageSource.length).toBeGreaterThan(0);
      }
    });
  });

  describe('查表 API', () => {
    it('getHintDefinition：命中返回该条、未登记返回 undefined', () => {
      expect(getHintDefinition('empty_tags')?.family).toBe('metadata');
      expect(getHintDefinition('same_key_resend')?.ownerSurface).toBe('memory_formation');
      expect(getHintDefinition('nope_not_a_code')).toBeUndefined();
    });

    it('listHintDefinitions：全表 / 按 ownerSurface 过滤 / 按 family 过滤', () => {
      expect(listHintDefinitions()).toHaveLength(39);
      // search 面：读侧三条 + 零命中引流（阶段三新增）——docs_overview_truncated 属
      // `docs_overview` 面（overview 是不同端点），不在本过滤内
      expect(listHintDefinitions({ ownerSurface: 'search' }).map((d) => d.code)).toEqual([
        'query_looks_like_path',
        'suggest_relaxing',
        'zero_hit',
        'search_experiences_suggested',
        'weak_hit',
        'positional_order',
      ]);
      // family='memory' = formation 13 + 拦截器通道 1（两条通道同族，但产出面不同）
      expect(listHintDefinitions({ family: 'memory' })).toHaveLength(14);
      expect(listHintDefinitions({ ownerSurface: 'memory_formation' })).toHaveLength(13);
      expect(listHintDefinitions({ ownerSurface: 'memory_nomination' }).map((d) => d.code)).toEqual(
        ['memory_nomination_suggested'],
      );
      expect(listHintDefinitions({ ownerSurface: 'search', family: 'read' })).toHaveLength(6);
      // 阶段三新面：task 纪律族（family='board'）+ board digest 截断 + docspace overview 截断
      expect(listHintDefinitions({ ownerSurface: 'task_hygiene' })).toHaveLength(4);
      expect(listHintDefinitions({ family: 'board' })).toHaveLength(4);
      expect(listHintDefinitions({ ownerSurface: 'board_digest' }).map((d) => d.code)).toEqual([
        'board_digest_truncated',
      ]);
      expect(listHintDefinitions({ ownerSurface: 'docs_overview' }).map((d) => d.code)).toEqual([
        'docs_overview_truncated',
        'docs_overview_routes_truncated',
      ]);
      // alpha.19：usage 读面动作码（独立 memory_read family，不进 formation 的 MEMORY_HINT）
      expect(listHintDefinitions({ ownerSurface: 'memory_usage' }).map((d) => d.code)).toEqual([
        'cursor_reset_required',
      ]);
      expect(listHintDefinitions({ family: 'memory_read' })).toHaveLength(1);
      // v1.94.0-dev：security 族（新族）单码
      expect(listHintDefinitions({ ownerSurface: 'credential_scan' }).map((d) => d.code)).toEqual([
        'sensitive_credential_suspected',
      ]);
      expect(listHintDefinitions({ family: 'security' })).toHaveLength(1);
    });

    it('hintFamilyOf / hintTtlOf：未登记 code 分别返回 null / undefined', () => {
      expect(hintFamilyOf('route_anchor_broken')).toBe('routes');
      expect(hintFamilyOf('tags_normalized')).toBeNull();
      expect(hintFamilyOf('nope')).toBeNull();
      expect(hintTtlOf('empty_tags')).toBe(HINT_DEDUP_TTL_MS);
      expect(hintTtlOf('tags_normalized')).toBeUndefined();
      expect(hintTtlOf('nope')).toBeUndefined();
    });

    it('拦截器通道码：登记在表内、族 memory、10min 显式窗口、产出面与文案指针齐备', () => {
      expect(getHintDefinition('memory_nomination_suggested')).toMatchObject({
        code: 'memory_nomination_suggested',
        family: 'memory',
        priorityRank: null,
        ttlMs: NOMINATION_TTL_MS,
        ownerSurface: 'memory_nomination',
        messageSource: 'modules/memory/memory.constants.ts MEMORY_NOMINATION_HINT_MESSAGE',
      });
      expect(hintTtlOf('memory_nomination_suggested')).toBe(NOMINATION_TTL_MS);
    });

    it('三个运行期附挂族：登记在表内 / 族正确 / 不参与排序 / 文案指针指向各自领域单源', () => {
      for (const definition of TASK_HYGIENE_DEFINITIONS) {
        expect(definition.family).toBe('board');
        expect(definition.priorityRank).toBeNull();
        expect(definition.ownerSurface).toBe('task_hygiene');
        expect(definition.messageSource).toBe(
          'modules/task/task-hint.constants.ts TASK_HINT_MESSAGES[code]',
        );
        // 平台级码不参与 docspace 排序（与 memory 两通道同款）
        expect(hintPriorityIndex().has(definition.code)).toBe(false);
      }
      for (const definition of BOARD_DIGEST_DEFINITIONS) {
        expect(definition.family).toBe('read');
        expect(definition.priorityRank).toBeNull();
        expect(definition.ownerSurface).toBe('board_digest');
        expect(definition.messageSource).toBe(
          'modules/board/board-hint.constants.ts BOARD_HINT_MESSAGES[code]',
        );
        expect(hintPriorityIndex().has(definition.code)).toBe(false);
      }
      // v1.94.0-dev：security 族（新族）——文案单源在 hints 模块内（不是领域模块）
      for (const definition of SECURITY_HINT_DEFINITIONS) {
        expect(definition.family).toBe('security');
        expect(definition.priorityRank).toBeNull();
        expect(definition.ownerSurface).toBe('credential_scan');
        expect(definition.messageSource).toBe(
          'modules/hints/security-hint.constants.ts SECURITY_HINT_MESSAGES[code]',
        );
        expect(hintPriorityIndex().has(definition.code)).toBe(false);
      }
      // 两条 docspace 新码**参与**排序（18 码连续名次的组成部分）
      expect(hintPriorityIndex().get('search_experiences_suggested')).toBe(13);
      expect(hintPriorityIndex().get('docs_overview_truncated')).toBe(16);
      // overview routes 截断码 = 新的末位（让位款排在 docs 截断之后）
      expect(hintPriorityIndex().get('docs_overview_routes_truncated')).toBe(17);
    });
  });

  describe('优先级索引', () => {
    it('docspace 18 码名次连续（0..17）且无重复', () => {
      const index = hintPriorityIndex();
      expect(index.size).toBe(18);

      const ranks = [...index.values()].sort((a, b) => a - b);
      expect(ranks).toEqual([...Array(18).keys()]);
    });

    it('名次首尾与 D6 语义一致（破坏性信号优先、截断续读垫底）', () => {
      const index = hintPriorityIndex();
      // 名次 0 = route_anchor_broken；名次 17 = docs_overview_routes_truncated（新末位：
      // docs 截断码 16 之后——routes 版连 catalog 这层最便宜下步都没有，只是抓全教学）
      expect([...index.entries()].find(([, rank]) => rank === 0)?.[0]).toBe('route_anchor_broken');
      expect([...index.entries()].find(([, rank]) => rank === 17)?.[0]).toBe(
        'docs_overview_routes_truncated',
      );
      // 事实回显 tags_normalized 排在读侧两条之前、知悉型 recheck 之后
      expect(index.get('tags_normalized')).toBeGreaterThan(index.get('route_anchor_recheck')!);
      expect(index.get('tags_normalized')).toBeLessThan(index.get('query_looks_like_path')!);
      // 引流码**刻意排在 zero_hit 之后**（旧三态双写的逐响应等价依赖 zero_hit 恒占名额）
      expect(index.get('search_experiences_suggested')).toBeGreaterThan(index.get('zero_hit')!);
      expect(index.get('search_experiences_suggested')).toBeLessThan(index.get('weak_hit')!);
    });

    it('memory 码不参与排序（priorityRank 恒 null，故不入索引）——两条通道都如此', () => {
      for (const definition of [...MEMORY_HINT_DEFINITIONS, ...MEMORY_NOMINATION_DEFINITIONS]) {
        expect(definition.priorityRank).toBeNull();
        expect(hintPriorityIndex().has(definition.code)).toBe(false);
      }
    });
  });

  describe('去重窗口元数据（ttlMs）', () => {
    it('有窗口的 14 个 docspace code：12 个落 6h 缺省、两条截断续读码显式 24h；豁免去重的 4 个无 ttlMs', () => {
      const windowed = DOC_HINT_DEFINITIONS.filter((d) => d.ttlMs !== undefined);
      expect(windowed).toHaveLength(14);
      // 两条截断续读码（docs / routes 段）是 docspace 段**仅有的**显式非 6h 覆盖
      // （教学定位 24h，决策 9）
      const day = 24 * 60 * 60 * 1000;
      const nonDefault = windowed.filter((d) => d.ttlMs !== HINT_DEDUP_TTL_MS);
      expect(nonDefault.map((d) => d.code)).toEqual([
        'docs_overview_truncated',
        'docs_overview_routes_truncated',
      ]);
      for (const definition of nonDefault) {
        expect(definition.ttlMs).toBe(day);
      }
      for (const definition of windowed.filter((d) => d.ttlMs === HINT_DEDUP_TTL_MS)) {
        expect(definition.ttlMs).toBe(HINT_DEDUP_TTL_MS);
      }

      for (const code of DEDUP_EXEMPT_CODES) {
        expect(getHintDefinition(code)?.ttlMs).toBeUndefined();
      }
    });

    it('memory formation 码无去重窗口（单值附挂，逐响应送达）', () => {
      for (const definition of MEMORY_HINT_DEFINITIONS) {
        expect(definition.ttlMs).toBeUndefined();
      }
    });

    it('memory **nomination** 码有 10min 显式窗口（拦截器通道走去重，不是单值附挂）', () => {
      for (const definition of MEMORY_NOMINATION_DEFINITIONS) {
        expect(definition.ttlMs).toBe(NOMINATION_TTL_MS);
        // 与缺省 6h 不同源（10min 是显式收紧，不是落缺省）
        expect(definition.ttlMs).not.toBe(HINT_DEDUP_TTL_MS);
      }
    });

    it('阶段三新码窗口：task 纪律族 6h / board digest 24h / 引流 6h / 截断续读 24h', () => {
      expect(hintTtlOf('task_done_without_report')).toBe(6 * 60 * 60 * 1000);
      // v1.94.0-dev 依赖引导码：与同族另两码同窗口长度（6h 显式，不落缺省——「显式」这件事
      // 由本条与 constants.spec 的注册表断言共同钉）
      expect(hintTtlOf('task_dependents_pending')).toBe(6 * 60 * 60 * 1000);
      expect(hintTtlOf('comment_on_done_task')).toBe(6 * 60 * 60 * 1000);
      expect(hintTtlOf('board_digest_truncated')).toBe(24 * 60 * 60 * 1000);
      expect(hintTtlOf('search_experiences_suggested')).toBe(HINT_DEDUP_TTL_MS);
      // 截断续读码同为教学面 ⇒ 同为 24h（决策 9）
      expect(hintTtlOf('docs_overview_truncated')).toBe(24 * 60 * 60 * 1000);
      // overview routes 截断码同款 24h（教学面；与 docs 截断码各自独立去重）
      expect(hintTtlOf('docs_overview_routes_truncated')).toBe(24 * 60 * 60 * 1000);
      // v1.94.0-dev security 族：同一资源 6h 提醒一次
      expect(hintTtlOf('sensitive_credential_suspected')).toBe(6 * 60 * 60 * 1000);
    });

    it('**注册表的 ttlMs 直接驱动去重窗口**：声明的窗口生效、缩短立即生效、放宽不追溯', () => {
      jest.useFakeTimers();
      const dedup = new HintDedupService();
      const declaredTtl = hintTtlOf('empty_tags')!;

      dedup.mark('a1', 'empty_tags', 'doc-1', declaredTtl);
      jest.advanceTimersByTime(declaredTtl - 1);
      expect(dedup.isSuppressed('a1', 'empty_tags', 'doc-1', declaredTtl)).toBe(true);
      jest.advanceTimersByTime(2);
      expect(dedup.isSuppressed('a1', 'empty_tags', 'doc-1', declaredTtl)).toBe(false);

      // 阶段二的 24h 覆盖：同一张表换一个 ttlMs 即可，无需改窗口实现
      const day = 24 * 60 * 60 * 1000;
      dedup.mark('a1', 'empty_tags', 'doc-2', day);
      jest.advanceTimersByTime(7 * 60 * 60 * 1000);
      expect(dedup.isSuppressed('a1', 'empty_tags', 'doc-2', day)).toBe(true);
      // 同一标记按缺省 6h 判定 → 已失效（「缩短立即生效」）
      expect(dedup.isSuppressed('a1', 'empty_tags', 'doc-2')).toBe(false);

      jest.useRealTimers();
    });

    it('真实覆盖点：memory_nomination_suggested 的窗口 = 注册表声明的 10min（≠ 缺省 6h）', () => {
      jest.useFakeTimers();
      const dedup = new HintDedupService();
      const ttl = hintTtlOf('memory_nomination_suggested')!;

      // 声明值本身与缺省不同源（10min 是显式收紧，不是落 6h 缺省）
      expect(ttl).toBe(10 * 60 * 1000);
      expect(ttl).not.toBe(HINT_DEDUP_TTL_MS);

      dedup.mark('a1', 'memory_nomination_suggested', 'task-1', ttl);
      jest.advanceTimersByTime(ttl - 1);
      expect(dedup.isSuppressed('a1', 'memory_nomination_suggested', 'task-1', ttl)).toBe(true);
      jest.advanceTimersByTime(2);
      // 10min 已过 ⇒ 不再压制（「缩短立即生效」：窗口长度按 mark 时的声明值结算）
      expect(dedup.isSuppressed('a1', 'memory_nomination_suggested', 'task-1', ttl)).toBe(false);

      jest.useRealTimers();
    });
  });

  describe('HintRegistry 门面', () => {
    it('与模块级纯函数逐项一致（同一份静态表，两个入口）', () => {
      const registry = new HintRegistry();
      expect(registry.get('empty_tags')).toEqual(getHintDefinition('empty_tags'));
      expect(registry.list()).toHaveLength(listHintDefinitions().length);
      expect(registry.familyOf('empty_tags')).toBe(hintFamilyOf('empty_tags'));
      expect(registry.ttlOf('empty_tags')).toBe(hintTtlOf('empty_tags'));
      expect(registry.priorityIndex().get('empty_tags')).toBe(
        hintPriorityIndex().get('empty_tags'),
      );
    });
  });
});

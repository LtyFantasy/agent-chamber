/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Formation content **装配器**的单测：§4 模板、**截断不变式**（只截摘录区）、
 *     locator 形态、UTF-8 字节闸门，以及**读面摘要反抽**（`extractContentExcerpt`）
 *
 * [代码职责]
 *   - 用纯函数级别的用例把"哪些内容永不截断"钉成可执行事实（方案 §4 是活文档）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §4 Formation content 装配契约
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **三要素 + 理由永不截**：断言里逐项核对（不是"看起来还在"——长摘录场景下必须逐字段
 *     相等），因为这条一旦破了，形成的记忆会"少一截主张"而引擎侧毫无察觉。
 *   - **固定区超限 = `overflow`（400），不是静默截断**：用例同时覆盖"刚好不超"与"超一点"。
 *   - **`[truncated]` 必须出现**：消费方据此知道摘录不全（P8 的可见性契约）。
 *   - **字节而非字符**：中文用例（一字 3 字节）是这条闸门的**唯一**有效守卫。
 *   - **摘要的期望值一律从 `assembleFormationContent()` 的真实输出派生**（先断言真实输出里
 *     确有喂进去的片段，再断言摘要）：手打模板字面量 = 模板改了用例却"跟着对"，守卫失效。
 *   - **读面摘要的截断与 `contentTruncated` 无关**：用例里长摘录**未触发**装配器截断
 *     （`truncated === false`）却仍被摘要封顶——这条同时守住"两者不共用一个信号"。
 *
 * [关联代码]
 *   - ../../src/modules/memory/memory-content.assembler.ts — 被测实现
 *   - ../../src/modules/memory/memory.constants.ts — 上限常量单源
 *
 * [修改检查]
 *   □ 改装配模板必须同步本用例的期望串（用例即 §4 活文档的可执行副本）
 *   □ 改模板行序/行数必须同步 `TEMPLATE_HEAD_ROW_ONE` / `TEMPLATE_HEAD_ROW_TWO`
 *     （本套件的"形状耦合"用例会红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  EXCERPT_AREA_PREFIX,
  applyContentOverride,
  assembleFormationContent,
  buildSourceLocator,
  extractContentExcerpt,
  truncateUtf8Bytes,
  utf8ByteLength,
} from './memory-content.assembler';
import type { MemorySourceRef } from '../../database/entities/memory-nomination.entity';
import {
  MEMORY_CONTENT_EXCERPT_MAX_CHARS,
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_EXCERPT_TRUNCATION_MARKER,
} from './memory.constants';

/** 造一个 doc 来源（带冻结版本锚） */
function docRef(overrides: Partial<MemorySourceRef> = {}): MemorySourceRef {
  return {
    type: 'doc',
    id: '11111111-1111-4111-8111-111111111111',
    parent: { type: 'docSpace', id: '22222222-2222-4222-8222-222222222222' },
    parentId: '22222222-2222-4222-8222-222222222222',
    versionHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    headingPath: '架构 § 权限',
    excerpt: '来源摘录正文',
    ...overrides,
  };
}

describe('memory-content.assembler（§4 装配与截断不变式）', () => {
  describe('assembleFormationContent', () => {
    it('装配三要素 + 理由 + 摘录区（逐行形态）', () => {
      const result = assembleFormationContent({
        category: 'ruling',
        subject: '权限前移到内容返回边界',
        scope: '适用于本仓所有 Memory 提名',
        effectiveNote: '自 2026-10-06 起生效',
        rationale: 'Hument 定论⑤：混源摘要取交集',
        sourceRefs: [docRef()],
      });

      expect(result.overflow).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.content).toBe(
        [
          '[ruling] 权限前移到内容返回边界',
          '范围: 适用于本仓所有 Memory 提名',
          '生效/撤销: 自 2026-10-06 起生效',
          '理由: Hument 定论⑤：混源摘要取交集',
          // 锚点走常量单源（它自带尾换行；这里在 join 的每个元素里，故去掉）
          EXCERPT_AREA_PREFIX.trimEnd(),
          '- [chamber://doc/11111111-1111-4111-8111-111111111111#habcdef012345] 来源摘录正文',
        ].join('\n'),
      );
    });

    it('无 effectiveNote 时该行整体缺席（不留空行）', () => {
      const result = assembleFormationContent({
        category: 'ruling',
        subject: 's',
        scope: 'sc',
        effectiveNote: null,
        rationale: 'r',
        sourceRefs: [],
      });

      expect(result.content).toBe('[ruling] s\n范围: sc\n理由: r');
    });

    it('纯著述（无 sourceRefs）不带摘录区', () => {
      const result = assembleFormationContent({
        category: 'note',
        subject: 's',
        scope: 'sc',
        effectiveNote: null,
        rationale: 'r',
        sourceRefs: [],
      });

      // 锚点常量单源（写侧模板与读侧摘要共用同一份文字）
      expect(result.content).not.toContain(EXCERPT_AREA_PREFIX);
      expect(result.truncated).toBe(false);
    });

    it('摘录超限时**只截摘录区**：三要素与理由逐字保全 + 标 [truncated]', () => {
      const longExcerpt = '摘'.repeat(4000); // 3 字节/字 ⇒ 12000 字节，必然超 8192
      const result = assembleFormationContent({
        category: 'ruling',
        subject: '主体不可截',
        scope: '范围不可截',
        effectiveNote: '生效不可截',
        rationale: '理由不可截',
        sourceRefs: [docRef({ excerpt: longExcerpt })],
      });

      expect(result.truncated).toBe(true);
      expect(result.overflow).toBe(false);
      // 三要素 + 理由**逐字**还在（不是"包含"——必须整段相等）
      expect(result.content).toContain('[ruling] 主体不可截');
      expect(result.content).toContain('范围: 范围不可截');
      expect(result.content).toContain('生效/撤销: 生效不可截');
      expect(result.content).toContain('理由: 理由不可截');
      expect(result.content).toContain(EXCERPT_AREA_PREFIX);
      expect(result.content.endsWith('[truncated]')).toBe(true);
      // 总字节不超闸门（标记也算在内）
      expect(utf8ByteLength(result.content)).toBeLessThanOrEqual(MEMORY_CONTENT_MAX_BYTES);
    });

    it('固定区（三要素+理由）自身超限 ⇒ overflow=true 且**不截主张**', () => {
      const result = assembleFormationContent({
        category: 'ruling',
        subject: '主'.repeat(2000), // 6000 字节
        scope: '范'.repeat(900), // 2700 字节
        effectiveNote: null,
        rationale: '由'.repeat(400), // 1200 字节 ⇒ 合计 ≈ 9.9KB > 8192
        sourceRefs: [docRef()],
      });

      expect(result.overflow).toBe(true);
      expect(result.truncated).toBe(false);
      // 内容 = 完整固定区（调用方据此 400；绝不返回"截了一半的主张"）
      expect(result.content).toContain('主'.repeat(2000));
      expect(result.content).toContain('范'.repeat(900));
      expect(result.content).toContain('由'.repeat(400));
    });
  });

  describe('buildSourceLocator（§4 形态）', () => {
    it('doc 带冻结版本锚的前 12 位', () => {
      expect(buildSourceLocator(docRef())).toBe(
        'chamber://doc/11111111-1111-4111-8111-111111111111#habcdef012345',
      );
    });

    it('doc 无 versionHash 时不带锚（不编造 hash）', () => {
      expect(buildSourceLocator(docRef({ versionHash: undefined }))).toBe(
        'chamber://doc/11111111-1111-4111-8111-111111111111',
      );
    });

    it('message / task / comment 恒不带锚（无版本列）', () => {
      for (const type of ['message', 'task', 'comment'] as const) {
        expect(buildSourceLocator({ type, id: 'x', versionHash: 'deadbeefdeadbeef' })).toBe(
          `chamber://${type}/x`,
        );
      }
    });
  });

  describe('applyContentOverride（同闸门）', () => {
    it('未超限时原样返回', () => {
      const result = applyContentOverride('短正文');
      expect(result).toEqual({ content: '短正文', truncated: false });
    });

    it('超限时截断并标 [truncated]（不静默丢弃）', () => {
      const result = applyContentOverride('长'.repeat(4000));
      expect(result.truncated).toBe(true);
      expect(result.content.endsWith('[truncated]')).toBe(true);
      expect(utf8ByteLength(result.content)).toBeLessThanOrEqual(MEMORY_CONTENT_MAX_BYTES);
    });
  });

  describe('truncateUtf8Bytes / utf8ByteLength（字节而非字符）', () => {
    it('中文按 3 字节计（不是按字符数）', () => {
      expect(utf8ByteLength('中')).toBe(3);
      expect(utf8ByteLength('ab中')).toBe(5);
    });

    it('截断不切开代理对（emoji 不产生半个字符）', () => {
      const emoji = '😀'; // 4 字节
      const truncated = truncateUtf8Bytes(`a${emoji}b`, 5); // a(1) + emoji(4) 刚好
      expect(truncated).toBe(`a${emoji}`);
      expect(utf8ByteLength(truncated)).toBe(5);

      // 只给 4 字节 ⇒ 放不下 emoji，回退到 'a'（而不是 'a\uFFFD'）
      expect(truncateUtf8Bytes(`a${emoji}b`, 4)).toBe('a');
    });

    it('未超限时原样返回（含空串边界）', () => {
      expect(truncateUtf8Bytes('abc', 3)).toBe('abc');
      expect(truncateUtf8Bytes('abc', 0)).toBe('');
    });
  });

  /**
   * 读面摘要（Memory web 二期 D1③④）。
   *
   * ⚠️ 期望值**一律从 `assembleFormationContent()` 的真实输出派生**：每个用例先断言
   * "真实输出里确实有我喂进去的那段内容"（前置守卫），再断言摘要等于它。手打模板字面量
   * 会让"模板改了、摘要也跟着错"的用例永远绿。
   */
  describe('extractContentExcerpt（读面摘要反抽）', () => {
    const SUBJECT = '主体不可进摘要';
    const SCOPE = '适用范围不可进摘要';
    const EFFECTIVE = '自某日起生效';
    const RATIONALE = '理由是摘要的来源';
    const EXCERPT_A = '权限前移到内容返回边界：先判权限再定投影';
    const EXCERPT_B = '第二条佐证';

    it('有锚点：取锚点之后的内容并**剔除每行 locator 前缀**（形态已由 sources[].locator 提供）', () => {
      const assembled = assembleFormationContent({
        category: 'ruling',
        subject: SUBJECT,
        scope: SCOPE,
        effectiveNote: null,
        rationale: RATIONALE,
        sourceRefs: [docRef({ excerpt: EXCERPT_A }), docRef({ id: 'msg-1', type: 'message', excerpt: EXCERPT_B })],
      });

      // 前置守卫：真实输出里确实有锚点 + 带 locator 的摘录行（否则下面的期望值无从谈起）
      expect(assembled.content).toContain(EXCERPT_AREA_PREFIX);
      expect(assembled.content).toContain(`- [chamber://doc/${docRef().id}`);

      const excerpt = extractContentExcerpt(assembled.content);

      expect(excerpt).toBe(`${EXCERPT_A}\n${EXCERPT_B}`);
      expect(excerpt).not.toContain('chamber://'); // locator 不占摘要预算（≈66 字符/条）
      expect(excerpt).not.toContain(SUBJECT); // 摘录区不含主张三要素（它们在上一段里）
    });

    it('无锚点（纯著述）退化：跳过模板头两行，从 `理由:` 起截（三要素不复述）', () => {
      const assembled = assembleFormationContent({
        category: 'note',
        subject: SUBJECT,
        scope: SCOPE,
        effectiveNote: null,
        rationale: RATIONALE,
        sourceRefs: [],
      });

      // 前置守卫：纯著述**没有**摘录区（模板只在有 sourceRefs 时才产生锚点）
      expect(assembled.content).not.toContain(EXCERPT_AREA_PREFIX);

      const excerpt = extractContentExcerpt(assembled.content);

      expect(excerpt).toBe(`理由: ${RATIONALE}`);
      expect(excerpt).not.toContain(SUBJECT);
      expect(excerpt).not.toContain(SCOPE);
    });

    it('无锚点退化 + 有 effectiveNote：`生效/撤销:` 行也在摘要里（跳的是头两行，不是固定三行）', () => {
      const assembled = assembleFormationContent({
        category: 'note',
        subject: SUBJECT,
        scope: SCOPE,
        effectiveNote: EFFECTIVE,
        rationale: RATIONALE,
        sourceRefs: [],
      });

      const excerpt = extractContentExcerpt(assembled.content);

      expect(excerpt).toBe(`生效/撤销: ${EFFECTIVE}\n理由: ${RATIONALE}`);
    });

    it('退化抽取与 `fixedLines()` 头两行**形状耦合**（模板头形态变了本用例必红）', () => {
      // 期望值从真实装配产物派生：把"真实的头两行"切掉，剩下的就应该是摘要。
      // 只要形状判据与 fixedLines() 的头两行对不上（改了顺序/加了行/换了前缀），
      // 判定就会落空 ⇒ 摘要变成整段正文 ⇒ 本断言当场红。
      const assembled = assembleFormationContent({
        category: 'note',
        subject: SUBJECT,
        scope: SCOPE,
        effectiveNote: EFFECTIVE,
        rationale: RATIONALE,
        sourceRefs: [],
      });
      const rows = assembled.content.split('\n');

      expect(extractContentExcerpt(assembled.content)).toBe(
        rows
          .slice(2)
          .map((row) => row.trim())
          .filter((row) => row.length > 0)
          .join('\n'),
      );
    });

    it('自由正文（`contentOverride` 写路径）：**单行**正文不被吞成空摘要', () => {
      // content 的第二条一等公民写路径：客户端自由正文（无模板头、无锚点）。
      // 期望值从真实的 `applyContentOverride()` 输出派生（未超限 ⇒ 原样落库）。
      const stored = applyContentOverride('客户端自写的一行正文');
      expect(stored.content).toBe('客户端自写的一行正文');

      expect(extractContentExcerpt(stored.content)).toBe(stored.content);
    });

    it('自由正文：多行**全行保留**（不被误判为模板头而丢前两行）', () => {
      const stored = applyContentOverride('第一行自由正文\n第二行自由正文\n第三行自由正文');

      const excerpt = extractContentExcerpt(stored.content);

      expect(excerpt).toBe(stored.content);
      expect(excerpt.split('\n')).toHaveLength(3);
    });

    it('形状判定：只中一半（像模板头但不是）⇒ **整段照用**，行数不作数', () => {
      // 只有第 1 行像模板头（`[category] subject`），第 2 行不是 `范围:` ⇒ 不跳
      const firstLikeOnly = '[ruling] 像模板头的第一行\n但不是范围行\n第三行';
      expect(extractContentExcerpt(firstLikeOnly)).toBe(firstLikeOnly);

      // 只有第 2 行像（第 1 行不是 `[..] ..`）⇒ 不跳
      const secondLikeOnly = '不像模板头的第一行\n范围: 但第二行像\n第三行';
      expect(extractContentExcerpt(secondLikeOnly)).toBe(secondLikeOnly);

      // 两行都像形状但**其后没有内容**（真实模板产物必有 `理由:` 行）⇒ 视为巧合，不跳
      const twoRowsOnly = '[ruling] 第一行\n范围: 第二行';
      expect(extractContentExcerpt(twoRowsOnly)).toBe(twoRowsOnly);
    });

    it(`超长摘要按**码点**封顶 ${MEMORY_CONTENT_EXCERPT_MAX_CHARS} 并补截断标记`, () => {
      const longExcerpt = '摘'.repeat(400); // 400 字符 ≈ 1200 字节 ⇒ **远未**触发装配器的 8192 字节闸门
      const assembled = assembleFormationContent({
        category: 'ruling',
        subject: SUBJECT,
        scope: SCOPE,
        effectiveNote: null,
        rationale: RATIONALE,
        sourceRefs: [docRef({ excerpt: longExcerpt })],
      });

      // 落库未截（摘录区装得下）——摘要却封顶了：两条信号互不影响（见用例末条断言）
      expect(assembled.truncated).toBe(false);

      const excerpt = extractContentExcerpt(assembled.content);

      expect(excerpt).toBe(
        `${longExcerpt.slice(0, MEMORY_CONTENT_EXCERPT_MAX_CHARS)}${MEMORY_EXCERPT_TRUNCATION_MARKER}`,
      );
      expect(excerpt.length).toBe(
        MEMORY_CONTENT_EXCERPT_MAX_CHARS + MEMORY_EXCERPT_TRUNCATION_MARKER.length,
      );
    });

    it('封顶不切开代理对（emoji 按码点算，不留半个字符）', () => {
      const emoji = '😀'; // 2 个 UTF-16 码元 / 1 个码点
      const assembled = assembleFormationContent({
        category: 'ruling',
        subject: SUBJECT,
        scope: SCOPE,
        effectiveNote: null,
        rationale: RATIONALE,
        sourceRefs: [docRef({ excerpt: emoji.repeat(300) })],
      });

      const excerpt = extractContentExcerpt(assembled.content);

      // 期望值 = 300 个 emoji 截到 280 个（**不是** 140 个——按码元切会少一半且留半个字符）
      expect(excerpt).toBe(`${emoji.repeat(MEMORY_CONTENT_EXCERPT_MAX_CHARS)}${MEMORY_EXCERPT_TRUNCATION_MARKER}`);
    });

    it('空内容边界：空串 / 纯空白 一律空串（**不是** null）', () => {
      expect(extractContentExcerpt('')).toBe('');
      expect(extractContentExcerpt('  \n\t\n')).toBe('');
    });

    it('锚点存在但摘录区**全空** ⇒ 回落退化分支（`理由:` 还在正文里，不该丢）', () => {
      // 来源无摘录 ⇒ 摘录行只剩 `- [locator]`，剥掉 locator 后什么都不剩。
      // 但同一篇正文里 `理由:` 仍然有展示价值 ⇒ 回落到形状感知的退化分支，而不是返回空串。
      const assembled = assembleFormationContent({
        category: 'ruling',
        subject: SUBJECT,
        scope: SCOPE,
        effectiveNote: null,
        rationale: RATIONALE,
        sourceRefs: [docRef({ excerpt: '' })],
      });
      expect(assembled.content).toContain(`- [chamber://doc/${docRef().id}`);
      expect(assembled.content).toContain(EXCERPT_AREA_PREFIX);

      expect(extractContentExcerpt(assembled.content)).toBe(`理由: ${RATIONALE}`);
    });
  });
});

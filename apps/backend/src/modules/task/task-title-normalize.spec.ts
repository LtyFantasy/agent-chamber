/**
 * task 标题归一化 / 撞重匹配 —— 判定矩阵（**活文档**，铁律 #19）
 *
 * 本文件是 `task_near_duplicate_suspected`（卡 c007f6c4）判据的**规格说明**：正例表
 * （什么算撞题）与**负例护栏**（什么绝不算——这些用例就是「白名单不许乱扩」的守卫）
 * 都是可执行文档。改检测器前先读这里的表，改完表必须与代码同向。
 *
 * 标定的诚实陈述（真库 435 open 标题 / 13,899 pair）：模糊族（trgm / Jaccard /
 * Levenshtein）**无可工作点**——系列编号（`批量任务X1/X2`）的误报得分恒高于真重复对；
 * 3 对真重复全部是「归一化后也不完全同名」的语义对，模糊层才抓得到，但那要付整片 FP。
 * 故本层只做**确定性重复**（tier1 + 白名单 tier2a），实测对构造性场景
 * （「修 bug」vs「修bug」）有效、对系列编号零命中。语义模糊层归 v3 embedding。
 */
import {
  findDuplicateTitles,
  normalizeTaskTitle,
  stripLeadingWhitelistedDecorations,
  TITLE_DECORATION_WHITELIST,
} from './task-title-normalize';

/** 造候选（最小形状；id 便于断言「命中的是哪一条」） */
function candidates(...titles: string[]): { id: string; title: string }[] {
  return titles.map((title, index) => ({ id: `c-${index}`, title }));
}

describe('normalizeTaskTitle（归一化）', () => {
  it('全角/半角（NFKC）、大小写、空白、标点全部抹平', () => {
    const key = normalizeTaskTitle('修复登录 Bug');
    expect(normalizeTaskTitle('修复登录bug')).toBe(key);
    expect(normalizeTaskTitle('修复登录 ｂｕｇ')).toBe(key); // 全角 NFKC
    expect(normalizeTaskTitle('修复登录BUG')).toBe(key); // 大小写
    expect(normalizeTaskTitle('修复 登录\tBug')).toBe(key); // 空白
    expect(normalizeTaskTitle('修复登录-bug')).toBe(key); // 标点
    expect(normalizeTaskTitle('修复登录：bug。')).toBe(key);
    expect(normalizeTaskTitle('「修复登录」bug')).toBe(key); // 括号属 \p{P}，一并抹掉
  });

  it('非字符串 / 空串 → 空键（永不抛）', () => {
    expect(normalizeTaskTitle(undefined as unknown as string)).toBe('');
    expect(normalizeTaskTitle(42 as unknown as string)).toBe('');
    expect(normalizeTaskTitle('')).toBe('');
    expect(normalizeTaskTitle('【。（）】')).toBe('');
  });
});

describe('stripLeadingWhitelistedDecorations（白名单前导装饰剥离）', () => {
  it('只剥白名单内的前导括号段（ci + 去空白）', () => {
    expect(stripLeadingWhitelistedDecorations('「Bug」冒烟支付修复')).toBe('冒烟支付修复');
    expect(stripLeadingWhitelistedDecorations('【 bug 】冒烟支付修复')).toBe('冒烟支付修复');
    expect(stripLeadingWhitelistedDecorations('[debt] 冒烟支付修复')).toBe('冒烟支付修复');
    expect(stripLeadingWhitelistedDecorations('（紧急）冒烟支付修复')).toBe('冒烟支付修复');
  });

  it('循环剥多段装饰', () => {
    expect(stripLeadingWhitelistedDecorations('「Bug」「缓行」冒烟支付修复')).toBe('冒烟支付修复');
  });

  it('**非白名单词一律不剥**（P0~P3 / 序号 / 承载区分语义的词）', () => {
    for (const raw of [
      '【P0】冒烟X',
      '【P1】冒烟X',
      '「前端」冒烟重构',
      '「后端」冒烟重构',
      '[WIP] 冒烟修复',
      'V2:发布',
    ]) {
      expect(stripLeadingWhitelistedDecorations(raw)).toBe(raw);
    }
  });

  it('段长超限 / 括号不闭合 / 非前导 → 不剥', () => {
    const long = `「${'很长的正文'.repeat(10)}」冒烟`;
    expect(stripLeadingWhitelistedDecorations(long)).toBe(long);
    expect(stripLeadingWhitelistedDecorations('「Bug冒烟修复')).toBe('「Bug冒烟修复');
    // 句中括号不是装饰位（只剥前导）
    expect(stripLeadingWhitelistedDecorations('冒烟（Bug）修复')).toBe('冒烟（Bug）修复');
  });

  it('非字符串 → 空串（永不抛）', () => {
    expect(stripLeadingWhitelistedDecorations(undefined as unknown as string)).toBe('');
  });

  it('白名单词表的收录判据：全是本仓真实标题前缀，且不含承载区分语义的词', () => {
    // 「前端/后端」是标定实证的真 FP 反例 ⇒ 必须不在表内
    expect(TITLE_DECORATION_WHITELIST).not.toContain('前端');
    expect(TITLE_DECORATION_WHITELIST).not.toContain('后端');
    // 优先级形态不在表内（含数字/字母序号的形态一律不剥）
    for (const word of TITLE_DECORATION_WHITELIST) {
      expect(word).toBe(word.toLowerCase());
      expect(word).not.toMatch(/\d/);
    }
  });
});

describe('findDuplicateTitles（两层判据）', () => {
  it('tier1：归一化等值命中（空格 / 大小写 / 标点差异）', () => {
    const found = findDuplicateTitles('修复登录 bug', candidates('修复登录bug', '别的任务'));

    expect(found).toHaveLength(1);
    expect(found[0].candidate.id).toBe('c-0');
    expect(found[0].matchedBy).toBe('tier1');
  });

  it('tier2a：白名单装饰剥离后核心等值命中（跨括号形态）', () => {
    const found = findDuplicateTitles(
      '「Bug」冒烟支付修复',
      candidates('冒烟支付修复', '【紧急】冒烟支付修复'),
    );

    expect(found.map((match) => match.matchedBy)).toEqual(['tier2a', 'tier2a']);
  });

  it('tier1 优先于 tier2a（同一候选只出现一次）', () => {
    const found = findDuplicateTitles('「Bug」冒烟支付修复', candidates('「bug」冒烟支付修复'));

    expect(found).toHaveLength(1);
    expect(found[0].matchedBy).toBe('tier1');
  });

  it('保序 + 空候选 → 空数组', () => {
    const found = findDuplicateTitles('冒烟修复', candidates('甲', '冒烟 修复', '乙', '冒烟修复'));

    expect(found.map((match) => match.candidate.id)).toEqual(['c-1', 'c-3']);
    expect(findDuplicateTitles('冒烟修复', [])).toEqual([]);
  });

  it('核心 < 4 字符不剥（宁可漏报不误报）', () => {
    expect(findDuplicateTitles('「Bug」ab', candidates('ab'))).toEqual([]);
    // 但 tier1 不受核心长度限制（归一化等值本身就是强信号）
    expect(findDuplicateTitles('「Bug」ab', candidates('「bug」ab'))).toHaveLength(1);
  });

  it('空键不可比对（标题全是标点时不会「互相命中」）', () => {
    expect(findDuplicateTitles('【。】', candidates('「」'))).toEqual([]);
  });

  /**
   * ⚠️ **负例护栏**（标定 FP 族 → 活文档）：这些是**刻意**不命中的形态。
   * 任何一条变红 = 检测器把系列编号/优先级/承载区分语义的词当成了装饰 ⇒ 立即回退，
   * **不要**去改用例（那等于承认误报）。
   */
  it('负例护栏：系列编号 / 优先级 / 版本 / 承载区分语义的词 一律不命中', () => {
    const cases: [string, string][] = [
      ['批量任务1', '批量任务2'],
      ['M6-TALENT', 'M6-SCENE'],
      ['v0.4-A', 'v0.4-B'],
      ['【P0】X', '【P1】X'],
      ['【P0】冒烟X', '【P1】冒烟X'],
      ['「前端」重构', '「后端」重构'],
      ['「前端」冒烟重构', '「后端」冒烟重构'],
      ['V2:发布', 'V3:发布'],
      ['「候选」批量任务1', '「候选」批量任务2'],
      ['冒烟缓存清理', '冒烟缓存清理二期'],
    ];

    for (const [left, right] of cases) {
      expect(findDuplicateTitles(left, candidates(right))).toHaveLength(0);
    }
  });

  it('非字符串 / 畸形输入永不抛（空标题 + 候选带非字符串 title）', () => {
    expect(findDuplicateTitles(undefined as unknown as string, candidates('冒烟'))).toEqual([]);
    expect(
      findDuplicateTitles('冒烟修复', [{ id: 'x', title: 42 as unknown as string }]),
    ).toEqual([]);
  });
});

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: doc history MVP——diff 读时现算不落库，行级 LCS 无外部依赖（2026-08-18）
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { computeLineDiff } from './doc-version-diff';

describe('computeLineDiff（行级 LCS，无外部依赖）', () => {
  it('完全相同文本 → added=0/removed=0，unified 只有头部两行', () => {
    const r = computeLineDiff('a\nb\nc', 'a\nb\nc', 'doc v1', 'doc v2');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.unified).toBe('--- doc v1\n+++ doc v2');
  });

  it('尾部追加行 → added=1（前缀剥离后只多一行）', () => {
    const r = computeLineDiff('a\nb', 'a\nb\nc', 'doc v1', 'doc v2');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.unified).toContain('+c');
  });

  it('删除中间行 → removed=1', () => {
    const r = computeLineDiff('a\nb\nc', 'a\nc', 'doc v1', 'doc v2');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(1);
    expect(r.unified).toContain('-b');
  });

  it('修改一行（删+增）→ added=1/removed=1，且 keep 上下文正确', () => {
    const r = computeLineDiff('line1\nline2\nline3', 'line1\nline2-modified\nline3', 'doc v1', 'doc v2');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.unified).toContain(' line1');
    expect(r.unified).toContain('-line2');
    expect(r.unified).toContain('+line2-modified');
    expect(r.unified).toContain(' line3');
  });

  it('插入行到中间（LCS 回溯保序：ins 插在后续 keep 行之前）', () => {
    // 回归守卫：a=[A,B,C] b=[A,X,C]——公共前缀 A、后缀 C 剥离后中间段
    // B→X 是「删旧增新」，X 必须出现在 keep C 之前，B 在 X 之前（unified 行序）
    const r = computeLineDiff('A\nB\nC', 'A\nX\nC', 'doc v1', 'doc v2');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1); // -B +X
    const out = r.unified;
    // 行序断言：-B 在 +X 前，+X 在 keep 的 C（' C'）前
    expect(out.indexOf('-B')).toBeLessThan(out.indexOf('+X'));
    expect(out.indexOf('+X')).toBeLessThan(out.indexOf(' C'));
  });

  it('空文本输入 → 0 行语义（双引号空串不产生空行噪音）', () => {
    const r = computeLineDiff('', 'a\nb', 'doc v0', 'doc v1');
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.unified).toContain('+a');
    expect(r.unified).toContain('+b');

    const r2 = computeLineDiff('a\nb', '', 'doc v1', 'doc v2');
    expect(r2.added).toBe(0);
    expect(r2.removed).toBe(2);
  });

  it('两处间隔较远的编辑 → 拆分为两个 hunk（各自带行号）', () => {
    // 编辑点之间夹 10 行 keep（> 2×3 上下文）→ 两个 hunk
    const mid = Array.from({ length: 10 }, (_, i) => `mid${i}`);
    const from = ['h1', 'old1', ...mid, 'old2'];
    const to = ['h1', 'new1', ...mid, 'new2'];
    const r = computeLineDiff(from.join('\n'), to.join('\n'), 'v1', 'v2');
    expect(r.added).toBe(2);
    expect(r.removed).toBe(2);
    const headers = r.unified.match(/^@@ /gm) ?? [];
    expect(headers).toHaveLength(2);
  });

  it('hunk header 行号正确（首行删除场景）', () => {
    const from = 'first\nkeep1\nkeep2';
    const to = 'keep1\nkeep2\nnewlast';
    const r = computeLineDiff(from, to, 'v1', 'v2');
    // 首行删除 + 尾部追加 → hunk 覆盖 3 旧行 / 3 新行（git 惯例：keep 两侧都计数）
    expect(r.unified).toContain('-first');
    expect(r.unified).toContain('+newlast');
    expect(r.unified).toContain('@@ -1,3 +1,3 @@');
  });

  it('整段替换（无公共行）→ 全部 removed + added', () => {
    const r = computeLineDiff('a\nb', 'x\ny\nz', 'v1', 'v2');
    expect(r.removed).toBe(2);
    expect(r.added).toBe(3);
    expect(r.unified).toContain('-a');
    expect(r.unified).toContain('+z');
  });

  it('规模保护：超过 LCS_MAX_CELLS 时退化为整段替换（不炸内存）', () => {
    // 2200×2200 = 4.84M cell > 4M 阈值 → fallback 全删全增；行数巨大但结果仍正确
    const fromLines = Array.from({ length: 2200 }, (_, i) => `from-${i}`);
    const toLines = Array.from({ length: 2200 }, (_, i) => `to-${i}`);
    const r = computeLineDiff(fromLines.join('\n'), toLines.join('\n'), 'v1', 'v2');
    expect(r.removed).toBe(2200);
    expect(r.added).toBe(2200);
    // 全量变化 → 单 hunk
    expect((r.unified.match(/^@@ /gm) ?? []).length).toBe(1);
  });
});
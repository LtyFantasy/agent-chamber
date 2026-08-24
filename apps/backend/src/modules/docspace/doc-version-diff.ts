/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: doc history MVP（doc_versions 表）——diff 读时现算不落库（2026-08-18）
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import type { DocVersionDiff } from '@agent-chamber/shared';

/**
 * 行级 LCS 规模保护阈值（cell 数上限，约 4M cells ≈ 16MB Int32Array）
 *
 * rationale：LCS DP 的时空开销 = O(m×n)。正常文档几百行的 diff 矩阵在毫秒级内完成；
 * 但 doc_versions.content 是 text 大字段，恶意/极端输入可构造数万行的对比，直接 DP
 * 会打爆内存。超限时退化为「整段替换」（全部 removed + 全部 added）——结果仍是
 * 语义正确的行级 diff，只是不追求最少编辑距离。
 */
const LCS_MAX_CELLS = 4_000_000;

/**
 * LCS 回溯中允许留在同一 hunk 内的上下文行数（unified diff 惯例的 3 行上下文）。
 * 变更区间之间 keep 行 ≤ 2×CTX 时合并为同一 hunk，否则分 hunk（header 重新给出行号）。
 */
const HUNK_CONTEXT = 3;

/**
 * 计算两个文本之间的行级 diff（简易 unified 格式，无外部依赖）。
 *
 * 算法：公共前缀/后缀剥离 → LCS DP（保护阈值见 LCS_MAX_CELLS）→ 回溯生成
 * keep/delete/insert 操作序列 → 按 HUNK_CONTEXT 分组为 unified hunks。
 *
 * 为空输入约定：空文本视为 0 行（不产生「一个空行」的噪音行）。
 * 行边界约定：按 '\n' 切分，diff 行保留行内容，拼接时每行自带 '\n'；
 * 末行无换行符的差异不会单独标注（\ No newline 标注不做——MVP 简化）。
 *
 * @param fromText 旧文本（前一版本的全文）
 * @param toText   新文本（目标版本的全文）
 * @param fromLabel diff 头部的旧侧标签（如 "doc v3"）
 * @param toLabel   diff 头部的新侧标签（如 "doc v4"）
 * @returns { added, removed, unified }（fromVersion 由调用方基于语义填充）
 */
export function computeLineDiff(
  fromText: string,
  toText: string,
  fromLabel: string,
  toLabel: string,
): Omit<DocVersionDiff, 'fromVersion'> {
  const fromLines = splitLines(fromText);
  const toLines = splitLines(toText);

  const m = fromLines.length;
  const n = toLines.length;

  // 公共前缀/后缀剥离：把 DP 只留给真正变化的中间段（文档编辑通常局部小改，
  // 前缀/后缀常常占文档全文大部分——先剥掉可把矩阵缩小几个数量级）
  let prefix = 0;
  while (prefix < m && prefix < n && fromLines[prefix] === toLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < m - prefix &&
    suffix < n - prefix &&
    fromLines[m - 1 - suffix] === toLines[n - 1 - suffix]
  ) {
    suffix++;
  }

  const midFrom = fromLines.slice(prefix, m - suffix);
  const midTo = toLines.slice(prefix, n - suffix);

  // 中间段 LCS：keepJ[k] = midFrom[k] 在 midTo 中消费的下标（keep）；-1 = 该行删除
  const keepJ = lcsKeepIndexes(midFrom, midTo);

  // 组装全局操作序列（prefix keep 段 + 中间段 + suffix keep 段）：
  // midFrom 每行 → keep（消费 midTo[keepJ[k]]）或 del；与被 keep 行之间的
  // midTo 空洞行 → ins（按序），保证 b 侧行序与 keep 消费严格对应。
  const ops: Array<{ type: 'keep' | 'del' | 'ins'; line: string }> = [];
  for (let i = 0; i < prefix; i++) ops.push({ type: 'keep', line: fromLines[i] });
  let tj = 0;
  for (let k = 0; k < midFrom.length; k++) {
    const keepAt = keepJ[k];
    if (keepAt >= 0) {
      // 该行保留：先补上 b 侧在它之前未被消费的行（insert），再消费本行
      while (tj < keepAt) {
        ops.push({ type: 'ins', line: midTo[tj] });
        tj++;
      }
      ops.push({ type: 'keep', line: midFrom[k] });
      tj = keepAt + 1;
    } else {
      ops.push({ type: 'del', line: midFrom[k] });
    }
  }
  while (tj < midTo.length) {
    ops.push({ type: 'ins', line: midTo[tj] });
    tj++;
  }
  for (let i = m - suffix; i < m; i++) ops.push({ type: 'keep', line: fromLines[i] });

  return formatUnified(ops, fromLabel, toLabel);
}

/** 空文本 = 0 行；其余按 '\n' 切分（保留空行语义） */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/**
 * 中间段 LCS 回溯：返回 keepJ（对齐 midFrom 下标）。
 *
 * keepJ[k] = midFrom[k] 在 midTo 中消费的下标（沿对角路径被选中的行）；-1 = 该行被删除。
 * 标准 LCS 回溯（从 dp[m][n] 反推）：字符相等走对角（LCS 单调性保证对角最优）、
 * 否则取 up/left 中 dp 值较大的一侧。
 */
function lcsKeepIndexes(a: string[], b: string[]): Int32Array {
  const m = a.length;
  const n = b.length;
  const keepJ = new Int32Array(m).fill(-1);

  if (m === 0 || n === 0) return keepJ; // 一侧为空：无 keep 行

  if (m * n > LCS_MAX_CELLS) {
    // 规模保护：不跑 DP，全部删旧增新（见 LCS_MAX_CELLS rationale）
    return keepJ;
  }

  // dp[i][j] = a[0..i) 与 b[0..j) 的 LCS 长度；行化一维数组 ([m+1] rows × [n+1] cols)
  const cols = n + 1;
  const dp = new Int32Array((m + 1) * cols);
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const idx = i * cols + j;
      if (ai === b[j - 1]) {
        dp[idx] = dp[(i - 1) * cols + (j - 1)] + 1;
      } else {
        const up = dp[(i - 1) * cols + j];
        const left = dp[i * cols + (j - 1)];
        dp[idx] = up >= left ? up : left;
      }
    }
  }

  // 回溯：i 行被 keep 当且仅当沿对角路径被选中（a[i-1] === b[j-1] 且 dp 满足匹配递推）
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const idx = i * cols + j;
    if (a[i - 1] === b[j - 1] && dp[idx] === dp[(i - 1) * cols + (j - 1)] + 1) {
      keepJ[i - 1] = j - 1; // 记录该行在 b 侧消费的下标
      i--;
      j--;
    } else if (dp[(i - 1) * cols + j] >= dp[i * cols + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }
  return keepJ;
}

/**
 * 把 keep/del/ins 操作序列格式化为 unified diff 文本 + 增删计数。
 *
 * 分 hunk 规则：变更（del/ins）区间之间夹着的 keep 行 ≤ 2×HUNK_CONTEXT 时合并
 * 为同一 hunk；否则独立 hunk（首尾各补 HUNK_CONTEXT 行上下文）。
 * 计数语义：added = ins 行数（新文本净增），removed = del 行数（旧文本净删）。
 */
function formatUnified(
  ops: Array<{ type: 'keep' | 'del' | 'ins'; line: string }>,
  fromLabel: string,
  toLabel: string,
): Omit<DocVersionDiff, 'fromVersion'> {
  let added = 0;
  let removed = 0;
  const changeIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.type === 'ins') {
      added++;
      changeIdx.push(idx);
    } else if (op.type === 'del') {
      removed++;
      changeIdx.push(idx);
    }
  });

  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];

  if (changeIdx.length > 0) {
    // 分组：变更下标 gap ≤ 2×CTX 合并（相邻编辑点间上下文很短时共享一个 hunk）
    const groups: Array<{ start: number; end: number }> = [];
    let gStart = changeIdx[0];
    let gEnd = changeIdx[0];
    for (let k = 1; k < changeIdx.length; k++) {
      if (changeIdx[k] - gEnd <= HUNK_CONTEXT * 2) {
        gEnd = changeIdx[k];
      } else {
        groups.push({ start: gStart, end: gEnd });
        gStart = changeIdx[k];
        gEnd = changeIdx[k];
      }
    }
    groups.push({ start: gStart, end: gEnd });

    for (const g of groups) {
      const rangeStart = Math.max(0, g.start - HUNK_CONTEXT);
      const rangeEnd = Math.min(ops.length - 1, g.end + HUNK_CONTEXT);
      // 组内起始行号：rangeStart 之前的 old/new 行数 + 1（keep 行在两侧都计数）
      let oldLine = 1;
      let newLine = 1;
      for (let i = 0; i < rangeStart; i++) {
        if (ops[i].type === 'ins') newLine++;
        else oldLine++;
      }
      let oldCount = 0;
      let newCount = 0;
      for (let i = rangeStart; i <= rangeEnd; i++) {
        if (ops[i].type === 'ins') newCount++;
        else if (ops[i].type === 'del') oldCount++;
        else {
          // keep 行同时属于旧文件与新文件（unified 惯例：两侧都计入）
          oldCount++;
          newCount++;
        }
      }
      // unified hunk header（与 git 惯例对齐：count=0 时 start 记 0 且显式 ",0"；
      // count=1 时简写为单行号）
      const oldHdr =
        oldCount === 0
          ? `${oldLine - 1},0`
          : oldCount === 1
            ? `${oldLine}`
            : `${oldLine},${oldCount}`;
      const newHdr =
        newCount === 0
          ? `${newLine - 1},0`
          : newCount === 1
            ? `${newLine}`
            : `${newLine},${newCount}`;
      lines.push(`@@ -${oldHdr} +${newHdr} @@`);
      for (let i = rangeStart; i <= rangeEnd; i++) {
        const op = ops[i];
        if (op.type === 'keep') lines.push(` ${op.line}`);
        else if (op.type === 'del') lines.push(`-${op.line}`);
        else lines.push(`+${op.line}`);
      }
    }
  }

  return { added, removed, unified: lines.join('\n') };
}

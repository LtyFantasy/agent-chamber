/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌输入 @ 补全与高亮）
 *   - 补充: docs/roundtable-design.md §6（会话层规则：mention 唤醒与 token 边界）
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * 圆桌输入框 @ 自动补全 + 命中 token 高亮的纯函数工具（无 React 依赖，可单测）。
 *
 * ⚠️ 视觉镜像契约：本文件的 token 边界 / 剥噪语义是后端文本路由
 * （apps/backend/src/modules/roundtable/mention.ts —— findMentionedLabels /
 * hasAllMention / stripMentionNoise）的**前端视觉镜像**，只负责「看起来与后端唤醒
 * 口径一致」；**后端才是唯一路由事实源**——本文件不产生任何结构化 mention 数据，
 * 补全插入的是纯文本 `@label `，落库/路由仍走后端文本解析（roundtable-design §12 r11）。
 */

/** token 边界字符集：@label 前后不得为这些字符才算独立提及（对齐后端 TOKEN_BOUNDARY_CHARS） */
const TOKEN_BOUNDARY_CHARS = 'A-Za-z0-9_-';

/** 边界字符判定正则（与后端同字符集，单字符 test 用） */
const TOKEN_BOUNDARY_RE = new RegExp(`[${TOKEN_BOUNDARY_CHARS}]`);

/** label 正则特殊字符转义（对齐后端 findMentionedLabels 的转义表 `[.*+?^${}()|[\]\\]`） */
function escapeRegExp(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @ 查询命中：start = @ 下标，query = @ 与 caret 之间的待过滤串（可为空 = 刚输入 @） */
export interface MentionQuery {
  start: number;
  query: string;
}

/** 高亮分段：text = 原文切片，highlight = 是否命中可路由 @token */
export interface HighlightSegment {
  text: string;
  highlight: boolean;
}

/**
 * 探测 caret 处是否处于「@ 补全输入态」：
 * ① caret 前最近一个 @ 的前一字符非 [A-Za-z0-9_-]（字符串首合法）
 * ② @ 到 caret 之间全是 [A-Za-z0-9_-]（即 query，可为空串）
 * ③ caret 紧贴 query 尾部（从 caret 前一位回扫天然保证）
 * 全部满足返回 { start, query }，否则 null。
 *
 * @param text 输入框全文
 * @param caretPos caret 下标（selectionStart）
 */
export function detectMentionQuery(text: string, caretPos: number): MentionQuery | null {
  if (caretPos <= 0 || caretPos > text.length) return null;
  // 从 caret 前一位向左回扫 token 字符，停在第一个非边界字符（或串首）
  let i = caretPos - 1;
  while (i >= 0 && TOKEN_BOUNDARY_RE.test(text[i])) i--;
  // 紧贴 query 尾部的前驱必须是 @（caret 必须紧跟 @ 输入的 token）
  if (i < 0 || text[i] !== '@') return null;
  // @ 前一字符不得是边界字符（`x@kimi` 不触发；字符串首合法）
  if (i - 1 >= 0 && TOKEN_BOUNDARY_RE.test(text[i - 1])) return null;
  return { start: i, query: text.slice(i + 1, caretPos) };
}

/**
 * 候选座位过滤：大小写不敏感前缀匹配，保持 labels 原顺序；query 为空返回全部。
 *
 * @param query @ 后的待过滤串（detectMentionQuery.query）
 * @param labels 全部候选座位 label
 */
export function filterMentionTargets(query: string, labels: string[]): string[] {
  if (!query) return [...labels];
  const q = query.toLowerCase();
  return labels.filter((l) => l.toLowerCase().startsWith(q));
}

/**
 * @all 令牌检测（M3 阶段 3，r13 @all 闸门确认框用）：后端 `hasAllMention` 的视觉
 * 镜像——仅在可路由区间（代码块/inline code/引用行外）内按同一边界正则
 * `(?<![A-Za-z0-9_-])@all(?![A-Za-z0-9_-])`（大小写敏感）检测，与高亮口径一致：
 * 「看起来会唤醒全部」的消息才弹确认框（后端是唯一路由事实源，本函数不产生
 * 结构化数据）。复用本文件既有 routableRanges 与 TOKEN_BOUNDARY_CHARS，不另造正则。
 *
 * @param text 输入框全文（未剥噪原文）
 * @returns 可路由区间内是否含 @all 提及
 */
export function hasAllMention(text: string): boolean {
  // matchAll 要求全局正则（g）；边界语义与后端 hasAllMention 的 .test() 完全一致
  const re = new RegExp(`(?<![${TOKEN_BOUNDARY_CHARS}])@all(?![${TOKEN_BOUNDARY_CHARS}])`, 'g');
  const ranges = routableRanges(text);
  for (const m of text.matchAll(re)) {
    const start = m.index as number;
    const end = start + m[0].length;
    if (ranges.some(([rs, reEnd]) => start >= rs && end <= reEnd)) return true;
  }
  return false;
}

/**
 * 计算可路由区间（后端 stripMentionNoise 逐行判定语义的坐标版）：
 * fenced code block（```/~~~ 包裹，含围栏行本身）整段、blockquote 行（^\s*>）整行、
 * inline code 片段（`...`）均不可路由；返回 [start, end) 区间数组。
 *
 * 为什么坐标版：高亮要渲染原文，而 stripMentionNoise 输出的是剥噪后的新字符串，
 * 字符坐标与原文不对齐——按行/区间标注可路由区域，命中判定与渲染坐标统一在原文上。
 */
function routableRanges(text: string): Array<[number, number]> {
  const lines = text.split('\n');
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let inFence = false;
  let fenceMarker = '';
  for (const line of lines) {
    const lineStart = offset;
    const lineLen = line.length;
    offset += lineLen + 1; // 行内容 + 换行符；末行多算 1 不影响区间（只用 lineStart/lineLen）
    const fence = line.trimStart().match(/^(```+|~~~+)/);
    if (fence) {
      // 围栏行本身不可路由；开启/闭合按行首字符匹配（```` 可闭合 ```，反之亦然）
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (fence[1][0] === fenceMarker[0]) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue; // 围栏内整段不可路由（代码里的 @ 不算提及）
    if (/^\s*>/.test(line)) continue; // blockquote 行整行不可路由
    // inline code 片段剔除：`[^`]*` 区间之外的可路由子区间逐段收集
    let cursor = 0;
    for (const m of line.matchAll(/`[^`]*`/g)) {
      const idx = m.index as number;
      if (idx > cursor) ranges.push([lineStart + cursor, lineStart + idx]);
      cursor = idx + m[0].length;
    }
    if (cursor < lineLen) ranges.push([lineStart + cursor, lineStart + lineLen]);
  }
  return ranges;
}

/**
 * 把输入框全文切成「高亮 / 不高亮」分段（供 backdrop 渲染）：
 * - 先按后端剥噪语义剔除不可路由区域（代码块/inline code/引用）
 * - 在可路由区域内按边界正则 `(?<![A-Za-z0-9_-])@(all|label)(?![A-Za-z0-9_-])` 匹配
 *   （大小写敏感，label 正则转义——对齐后端 findMentionedLabels / hasAllMention）
 * - 重叠命中合并（@all 固定候选与名为 all 的座位 label 可能重复命中同一段）
 * 不在可路由区域的 @token 原样输出不高亮（视觉镜像：后端同样不路由）。
 *
 * @param text 输入框全文（未剥噪原文）
 * @param labels 座位 label 候选（topic 内 active 座位）
 */
export function buildHighlightSegments(text: string, labels: string[]): HighlightSegment[] {
  const ranges = routableRanges(text);
  // 逐候选（@all + 各 label）在可路由区间内收集命中 [start, end)
  const hits: Array<[number, number]> = [];
  const patterns = ['all', ...labels.filter((l) => l.length > 0).map(escapeRegExp)];
  for (const pattern of patterns) {
    const re = new RegExp(
      `(?<![${TOKEN_BOUNDARY_CHARS}])@${pattern}(?![${TOKEN_BOUNDARY_CHARS}])`,
      'g',
    );
    for (const m of text.matchAll(re)) {
      const start = m.index as number;
      const end = start + m[0].length;
      if (ranges.some(([rs, reEnd]) => start >= rs && end <= reEnd)) hits.push([start, end]);
    }
  }
  // 排序 + 合并重叠/相邻命中
  hits.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h[0] <= last[1]) {
      last[1] = Math.max(last[1], h[1]);
    } else {
      merged.push([h[0], h[1]]);
    }
  }
  // 按合并后命中切段
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) segments.push({ text: text.slice(cursor, s), highlight: false });
    segments.push({ text: text.slice(s, e), highlight: true });
    cursor = e;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlight: false });
  return segments;
}

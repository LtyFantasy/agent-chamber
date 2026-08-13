/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §6 (会话层规则: 路由与唤醒策略)
 *   - 补充: docs/roundtable-design.md §6 r5 (唤醒规则人机一致 + @all 显式广播令牌)
 *           docs/roundtable-design.md §6 r6 (mention 路由落地: system 不唤醒)
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
 * token 边界字符集：@label 前后不得为这些字符才算独立提及（R5 token 级精确，
 * `@kimi-1x` 不命中 `@kimi-1`；`@kimi-1。`/`@kimi-1,` 命中；字符串首尾视为合法边界）。
 * 字母/数字/下划线/连字符外的字符（空格、标点、CJK 等）天然构成边界。
 */
const TOKEN_BOUNDARY_CHARS = 'A-Za-z0-9_-';

/**
 * 剥离不可路由的 @ 噪声（R5：代码块/引用内的 @ 不算提及）：
 * - fenced code block（``` 或 ~~~ 包裹的段落，含围栏行本身）整段剥离；
 *   闭合判定 = 围栏行首字符与开启相同（~~~ 与 ``` 不互相闭合，尽力而为不误伤正文）
 * - inline code（`...` 片段）剥离；反引号不配对时保留原文（匹配尽力而为）
 * - blockquote 行（行首 > 开头，允许前导空白）整行剥离
 * @param text 消息原文（自然 markdown）
 * @returns 仅剩可路由正文（mention 匹配在其上进行）
 */
export function stripMentionNoise(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  for (const line of lines) {
    const fence = line.trimStart().match(/^(```+|~~~+)/);
    if (fence) {
      // 围栏行本身不算正文；开启/闭合按行首字符匹配（```` 可闭合 ```，反之亦然）
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (fence[1][0] === fenceMarker[0]) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue; // 围栏内整段剥离（代码里的 @ 不算提及）
    if (/^\s*>/.test(line)) continue; // blockquote 行整行剥离（引用里的 @ 不算提及）
    // inline code 片段剥离（`...` 内的 @ 不算提及）；剥完可能留下空行，不影响匹配
    kept.push(line.replace(/`[^`]*`/g, ''));
  }
  return kept.join('\n');
}

/**
 * 检测正文中的 @label 提及（token 级精确，R5）：
 * - 边界 = @ 前/后均非 [A-Za-z0-9_-]（负 lookbehind/lookahead；字符串首尾视为合法边界）
 * - label 按正则特殊字符转义（label 含 `.` `+` `(` `)` 等仍可精确寻址，不受转义误伤）
 * - 大小写敏感（@Kimi-1 不命中 label kimi-1）
 * @param text 已剥噪正文（stripMentionNoise 的输出）
 * @param labels 候选座位 label 列表（topic 内 active 座位）
 * @returns 命中的 label 集合（无序）
 */
export function findMentionedLabels(text: string, labels: string[]): Set<string> {
  const hit = new Set<string>();
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(?<![${TOKEN_BOUNDARY_CHARS}])@${escaped}(?![${TOKEN_BOUNDARY_CHARS}])`,
      'g',
    );
    if (re.test(text)) hit.add(label);
  }
  return hit;
}

/**
 * 检测显式广播令牌 @all（R1 用户拍板：mention 模式下人机皆可用，唤醒全部 active 座位）
 * - 与座位 label 同边界规则 + 大小写敏感（@All / @allx 均不命中）
 * - 保留令牌注记：若座位起名叫 all，@all 永远按广播语义处理（无法单独寻址，
 *   不阻断——广播本就会唤醒该座位）
 * @param text 已剥噪正文（stripMentionNoise 的输出）
 * @returns 是否含 @all 提及
 */
export function hasAllMention(text: string): boolean {
  return new RegExp(`(?<![${TOKEN_BOUNDARY_CHARS}])@all(?![${TOKEN_BOUNDARY_CHARS}])`).test(
    text,
  );
}

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan §4.4 (chunking 规格)
 *   - 补充: docs/architecture.md §3.2 (DocSpace 模块)
 *
 * [踩坑索引]
 *   - bug f2549375：围栏代码块内的 `# 注释`（curl/bash 示例）曾被识别为 ATX 标题，
 *     导致 section 切错 + headingPath 顶层误植；标题扫描必须先走围栏状态机（见 step 1）
 *   - 任务 e6eaf06d：空正文标题曾不产 chunk（仅入祖先栈），「全文读 + upsert 回写」往返
 *     永久丢失空标题行（典型 H2 分组标题），文档结构渐进退化；空标题现在也产 content='' 的 chunk
 *   - 任务 e6eaf06d 第二张脸：单 section >4000 字符按段落二次切分时，子 chunk 共用同一
 *     headingPath/headingLevel（step 4 正确设计，勿改）——reconstruct 侧（doc.service.ts
 *     reconstructContent）靠 run-dedup 保证兄弟 chunk 只插回一次标题，修改两侧任一侧前先跑
 *     docspace 测试验证往返幂等
 *
 * [铁律关联] #11(注释) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * Markdown 文档分块器
 *
 * 纯函数，零依赖注入，可独立单测。
 * 输入 content + title → 输出 Array<{headingPath, headingLevel, position, content, tokenEstimate}>
 *
 * 规格严格按 plan §4.4：
 * - 按 ATX 标题 (#{1,6}) 切段；文首无标题内容 → level 0 段，headingPath=文档 title
 * - 空正文标题（无自身正文，后紧跟下一标题或 EOF）同样产出 content='' 的 chunk——
 *   保证「全文读 + upsert 回写」往返不丢标题行（丢空标题 = 静默数据损耗，见 AGENT-HOOK e6eaf06d）
 * - 围栏代码块（``` / ~~~）内的行不识别为标题（防代码注释污染标题栈）
 * - headingPath=祖先标题链 "父 § 子" 拼接（截断 512）
 * - 单 section >4000 字符按段落二次切分；子 chunk 共用同一 headingPath/headingLevel，
 *   reconstruct 侧（doc.service.ts reconstructContent）靠 run-dedup 保证标题只插回一次
 *   （任务 e6eaf06d 第二张脸）
 * - CJK 感知 tokenEstimate：cjkCharCount + ceil(nonCjkLength / 4)
 * - 防御性跳过开头 "---...---" frontmatter 块
 */

/** CJK Unicode 区间正则（中文/日文/韩文） */
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g;

/** ATX 标题：行首 #{1,6} + 空格 + 标题文本 */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** 代码围栏行：行首（可缩进）≥3 个反引号或波浪号（可带 info string，如 ```bash） */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** frontmatter 分隔符正则：行首 ---（可含空格） */
const FRONTMATTER_DELIM = /^---\s*$/;

/** 单个 section 硬上限字符数，超出按段落二次切分 */
const SECTION_CHAR_LIMIT = 4000;

/** headingPath 最大长度 */
const HEADING_PATH_MAX = 512;

/** 段落分隔：连续的换行符 */
const PARAGRAPH_SEP = /\n\s*\n/;

// ─── 公共类型 ────────────────────────────────────────────────

/** 单个分块结果 */
export interface ChunkResult {
  /** 层级标题路径（祖先链拼接，最大 512 字符） */
  headingPath: string;
  /** 标题层级 0-6（0=文首无标题段） */
  headingLevel: number;
  /** 篇内顺序（从 0 开始） */
  position: number;
  /** 正文内容 */
  content: string;
  /** CJK 感知 token 估算 */
  tokenEstimate: number;
}

// ─── 辅助函数 ────────────────────────────────────────────────

/**
 * CJK 感知 token 估算
 *
 * 算法：cjkCharCount + ceil(nonCjkLength / 4)
 * 其中 CJK 区间正则计数（中文 1 字≈1 token，英文 ~4 字符≈1 token）。
 *
 * rationale：本功能核心卖点数据——纯 len/4 对中文低估 ~4 倍不可接受。
 * 此为应用层估算值，实际 tokenization 由下游 LLM 决定，仅作计数参考。
 */
export function estimateTokens(text: string): number {
  // 需要单独统计 CJK 和非 CJK 字符，因为 replace 会修改字符串
  let cjkCount = 0;
  while (CJK_RE.exec(text) !== null) {
    cjkCount++;
  }
  // 重置 lastIndex
  CJK_RE.lastIndex = 0;

  const nonCjkLength = text.length - cjkCount;
  return cjkCount + Math.ceil(nonCjkLength / 4);
}

/**
 * 截断 headingPath 到最大长度
 */
function truncateHeadingPath(path: string): string {
  if (path.length <= HEADING_PATH_MAX) return path;
  return path.slice(0, HEADING_PATH_MAX);
}

/**
 * 构建 headingPath：祖先链 "父 § 子" 拼接
 */
function buildHeadingPath(ancestors: string[], currentTitle: string): string {
  const parts = [...ancestors, currentTitle];
  return truncateHeadingPath(parts.join(' § '));
}

// ─── 核心导出 ────────────────────────────────────────────────

/**
 * 将 Markdown 内容切分为 section 数组。
 *
 * @param content - Markdown 原始内容
 * @param title   - 文档标题（用于 level 0 段的 headingPath，缺省取首个 heading 或文件名）
 * @returns 分块结果数组
 */
export function chunkMarkdown(content: string, title: string): ChunkResult[] {
  // Normalize CRLF → LF
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  // ── 0. 防御性跳过开头 frontmatter ──────────────────────────
  // 剥离是 ingest 适配器的职责，此处仅做兜底防护
  // 当文件以 --- 开头时，寻找闭合的 ---，跳过中间的 YAML
  let startLine = 0;
  if (lines.length > 0 && FRONTMATTER_DELIM.test(lines[0])) {
    for (let i = 1; i < lines.length; i++) {
      if (FRONTMATTER_DELIM.test(lines[i])) {
        startLine = i + 1;
        break;
      }
    }
  }

  // ── 1. 第一遍扫描：识别标题位置（围栏代码块内的行除外）────────────
  // 围栏状态机：开围栏后的所有行（含 `# 注释`、异种围栏标记）都是代码内容，
  // 不得识别为 ATX 标题——否则 curl/bash 示例里的 `# xxx` 注释会切错 section
  // 并污染标题祖先栈（api-definition.md headingPath 顶层误植「只搜索消息」教训，
  // bug f2549375）。闭合规则（CommonMark）：同字符且长度 ≥ 开围栏；未闭合围栏
  // 到 EOF 为止全部视为代码内容。
  interface HeadingInfo {
    lineIndex: number;
    level: number;
    title: string;
  }

  const headings: HeadingInfo[] = [];
  let openFence: string | null = null;
  for (let i = startLine; i < lines.length; i++) {
    const fence = FENCE_RE.exec(lines[i]);
    if (openFence !== null) {
      if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
        openFence = null;
      }
      continue;
    }
    if (fence) {
      openFence = fence[1];
      continue;
    }
    const m = HEADING_RE.exec(lines[i]);
    if (m) {
      headings.push({
        lineIndex: i,
        level: m[1].length,
        title: m[2].trim(),
      });
    }
  }

  // ── 2. 无标题文档：整篇作为一个 section ──────────────────
  if (headings.length === 0) {
    const allContent = lines.slice(startLine).join('\n').trim();
    const chunk: ChunkResult = {
      headingPath: truncateHeadingPath(title),
      headingLevel: 0,
      position: 0,
      content: allContent,
      tokenEstimate: estimateTokens(allContent),
    };
    return [chunk];
  }

  // ── 3. 按标题切段 ────────────────────────────────────────
  const chunks: ChunkResult[] = [];

  // 文首无标题内容 → level 0 段，headingPath=文档 title
  if (headings[0].lineIndex > startLine) {
    const preContent = lines.slice(startLine, headings[0].lineIndex).join('\n').trim();
    if (preContent) {
      chunks.push({
        headingPath: truncateHeadingPath(title),
        headingLevel: 0,
        position: 0,
        content: preContent,
        tokenEstimate: estimateTokens(preContent),
      });
    }
  }

  // 处理各 heading section
  const ancestors: { level: number; title: string }[] = [];

  for (let hi = 0; hi < headings.length; hi++) {
    const h = headings[hi];
    const nextLine = hi + 1 < headings.length ? headings[hi + 1].lineIndex : lines.length;
    const bodyLines = lines.slice(h.lineIndex + 1, nextLine);
    const body = bodyLines.join('\n').trim();

    // 更新祖先链：移除 >= 当前层级的标题
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= h.level) {
      ancestors.pop();
    }

    if (!body) {
      // 空正文标题（heading 后紧跟下一标题或 EOF）也产出 content='' 的 chunk。
      // rationale: 分块与 reconstructContent 重建互逆——若不产 chunk，doc_sections 缺失该
      // 标题行，任何「全文读 + upsert 回写」往返都会永久丢失空标题（典型 H2 分组标题），
      // 文档结构渐进退化（任务 e6eaf06d）。heading 位于 EOF 的无 body 情形由同一分支天然覆盖。
      chunks.push({
        headingPath: buildHeadingPath(
          ancestors.map((a) => a.title),
          h.title,
        ),
        headingLevel: h.level,
        position: chunks.length,
        content: '',
        tokenEstimate: 0,
      });
      // 当前标题入祖先栈（供后续子标题使用）
      ancestors.push({ level: h.level, title: h.title });
      continue;
    }

    // headingPath = 祖先链拼接（ancestors 是父辈，不含自身）
    const headingPath = buildHeadingPath(
      ancestors.map((a) => a.title),
      h.title,
    );

    // 当前标题入祖先栈（供后续子标题使用）
    ancestors.push({ level: h.level, title: h.title });

    // ── 4. 超大段按段落二次切分 ─────────────────────────
    if (body.length > SECTION_CHAR_LIMIT) {
      // rationale: 单 section 过长时按段落（连续的换行符）拆分，
      // 避免下游 LLM 一次摄入过大的上下文块
      const paragraphs = body.split(PARAGRAPH_SEP).filter((p) => p.trim());
      for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;
        chunks.push({
          headingPath,
          headingLevel: h.level,
          position: chunks.length,
          content: trimmed,
          tokenEstimate: estimateTokens(trimmed),
        });
      }
    } else {
      chunks.push({
        headingPath,
        headingLevel: h.level,
        position: chunks.length,
        content: body,
        tokenEstimate: estimateTokens(body),
      });
    }
  }

  return chunks;
}

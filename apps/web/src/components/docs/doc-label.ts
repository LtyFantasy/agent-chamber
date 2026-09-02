/**
 * 文档行标签（左栏目录树/分类树/扁平列表共用，2026-09-02 用户拍板）：
 * 文件名为主标签（定位键——doc_routes / AGENTS.md / skill 等一切引用都走 path），
 * 标题为辅标签（语义补充）。标题与文件名实质相同（忽略大小写与 .md 后缀）时
 * 去重不显示辅标签；无标题就只显示文件名。
 */

/** 行标签输入（DocSummary / DocTreeDoc 的公共子集） */
export interface DocLabelInput {
  /** 文档路径（如 memory/2026-09-02.md） */
  path: string;
  /** 文档标题（可空） */
  title?: string | null;
}

/** 行标签：primary = 文件名；secondary = 标题（去重后可为 null） */
export interface DocLabel {
  primary: string;
  secondary: string | null;
}

/** 从路径取展示文件名：最后一段 + 去 .md 后缀（大小写不敏感；视觉降噪，路径语义不受影响） */
export function fileBaseName(path: string): string {
  const seg = path.split('/').pop() ?? path;
  return seg.replace(/\.md$/i, '');
}

/** 归一化比较键（trim + 小写 + 去 .md 后缀）：判定标题与文件名是否实质相同 */
function normalizeLabelKey(s: string): string {
  return s.trim().toLowerCase().replace(/\.md$/, '');
}

/** 计算行标签：标题非空且与文件名实质不同才进 secondary（如 'Readme'≈README.md 去重） */
export function docDisplayLabel(doc: DocLabelInput): DocLabel {
  const primary = fileBaseName(doc.path);
  const title = (doc.title ?? '').trim();
  const secondary =
    title !== '' && normalizeLabelKey(title) !== normalizeLabelKey(primary) ? title : null;
  return { primary, secondary };
}

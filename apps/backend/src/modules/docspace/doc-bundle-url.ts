/**
 * bundle 正文附件 URL 的识别与重写（P2 批 5 / plan §⑤.4 第 ③ 步、§0 arch m8）。
 *
 * 为什么单独成文件：这是纯字符串逻辑（可穷举单测），与编排/IO 解耦后
 * "两形态正则"的边界（相对 / 同源绝对）能被独立钉死。
 *
 * 两形态（plan §0 arch m8 钉死）：
 * - 相对：`/api/v1/attachments/<uuid>/content`（buildContentUrl 的产物，web/Agent 常态）；
 * - 同源绝对：`https://<host>[:port]/api/v1/attachments/<uuid>/content`（正文里手写的平台地址）。
 * 重写保留原形态（有 origin 前缀就保留该前缀，只换 id），因此消费方拿到的 URL 形态不变。
 *
 * 无映射不重写（plan §0 PM M4）：id 不在映射表里时**原样返回**——这是刻意的：
 * 旧 URL 是"断链但可见"，比换成错误 URL（指向别人的附件）安全得多。
 */

import { API_PREFIX } from '@agent-chamber/shared';

/** UUID 字面（大小写都收：URL 里出现大写形态时同样要能识别） */
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * 每次调用新建正则实例：带 `g` 标志的正则对象有可变 `lastIndex` 状态，
 * 模块级共享会在"同一 content 连续两次扫描"时静默漏匹配（经典踩坑）。
 */
function attachmentContentUrlRegex(): RegExp {
  // RegExp 构造器路线（非字面量）：API_PREFIX 里的 '/' 无需转义，单一事实源拼装
  return new RegExp(
    `(https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?)?(${API_PREFIX}/attachments/(${UUID_PATTERN})/content)`,
    'g',
  );
}

/**
 * 提取正文引用的附件 id（按出现顺序去重，统一小写）。
 *
 * 用途：导出侧反查"正文引用了哪些附件"→ topic 绑定项落 mediaOmitted 清单
 * （plan §⑤.1 informational mediaOmitted）。
 */
export function extractAttachmentContentIds(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(attachmentContentUrlRegex())) {
    const id = match[3]?.toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 按 `旧附件 id → 新附件 id` 映射重写正文中的附件 URL。
 *
 * @param content 文档原文（导出产物）
 * @param idMap 映射键**统一小写**（调用侧负责归一；查表前这里再 toLowerCase 兜底）
 * @returns 重写后的原文；无命中/无映射时逐字节返回原文
 */
export function rewriteAttachmentContentUrls(
  content: string,
  idMap: ReadonlyMap<string, string>,
): string {
  if (idMap.size === 0) return content;
  return content.replace(
    attachmentContentUrlRegex(),
    (match, origin: string | undefined, _path, oldId: string) => {
      const newId = idMap.get(oldId.toLowerCase());
      if (!newId) return match; // 无映射不重写：保留旧 URL（断链可见优于错链）
      return `${origin ?? ''}${API_PREFIX}/attachments/${newId}/content`;
    },
  );
}

/**
 * ts_headline 产物的单字化痕迹清理（检索中文根治计划 v1.5 §2.2 snippet 契约）。
 *
 * 背景：`ts_headline('simple', cjk_unigram_text(content), …)` 作用于**单字化文本**，
 * 产物带单字化内部表示——CJK 字间**双空格**（`' 出  境 '` 形态），`<<<>>>` 通道还会
 * 出现相邻命中标记夹空格（`<<<出>>>  <<<境>>>`）。清理三步（顺序钉死）：
 *   ① `>>>\s+<<<` → `>>><<<`：标记边界并合（双空格与用户原生空格两态都并），
 *      使剥标记后命中文本连续可读（`<<<出>>><<<境>>>` → 出境）；
 *   ② 连续空格 → 单空格：单字化字间双空格归并（**原生单空格保留**——不把所有空格
 *      删光，英文/混排 snippet 单词不粘连）；
 *   ③ trim：首尾剥净——**先剥空格再比长度/截断**（消费方按清理后文本计
 *      SNIPPET_MAX_CHARS，截断不腰斩标记的前提）。
 *
 * 空标记通道（doc-search `StartSel=""` 是刻意设计）无 ① 可并，②③ 同样生效。
 * 契约三态（双空格 / 标记边界 / 用户原生空格）由 test/snippet-cleanup.e2e-spec.ts 钉死。
 */

/**
 * 清理 ts_headline 产物（无 `>>> <<<` 残留、无连续空格、首尾无空格）。
 * @param raw ts_headline 原始输出（空标记或 `<<<>>>` 通道均可）
 * @returns 清理后 snippet 文本（长度比较与截断必须在本产物上进行）
 */
export function cleanupHeadlineSnippet(raw: string): string {
  return raw
    .replace(/>>>\s+<<</g, '>>><<<')
    .replace(/ {2,}/g, ' ')
    .trim();
}

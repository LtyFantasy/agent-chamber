/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §i18n
 *   - 补充: docs/i18n.md（Phase 2 补齐）
 *
 * [踩坑索引] 无
 *
 * [铁律关联] #11(注释强制) #20(契约即设计)
 *
 * [详细踩坑]
 *   无
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, normalizeLocale } from './locale';
import { messagesMap } from './api-messages';

/**
 * next-intl 请求配置（createNextIntlPlugin 的查找入口，缺省路径即 src/i18n/request.ts）。
 * URL 不带 locale 前缀：语言唯一来源是 NEXT_LOCALE cookie，非法值收敛为英文默认。
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  return { locale, messages: messagesMap[locale] };
});

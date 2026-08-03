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
 * [铁律关联] #11(注释强制) #21(双层校验)
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

import en from './messages/en.json';
import zhCN from './messages/zh-CN.json';
import { DEFAULT_LOCALE, getLocaleFromClientCookie, type Locale } from './locale';

/**
 * 文案表注册中心：layout.tsx（服务端）与 api-messages（非 React 模块）共用。
 * 新增语言时必须在此注册，否则 normalizeLocale 通过但无文案可用。
 */
export const messagesMap: Record<Locale, typeof en> = {
  en,
  'zh-CN': zhCN,
};

/**
 * 非 React 模块（如 lib/api.ts 的错误 fallback）的文案入口。
 * 已知折中（见 i18n plan §架构师复查）：api 层理想状态不持有用户可见文案，
 * 本期保留此工具函数，docs/i18n.md 中标注为已知债务。
 *
 * @param key api 命名空间下的文案 key（类型安全，写错编译报错）
 * @returns 当前 cookie locale 对应文案；缺 key 时回退英文，再缺回退 DEFAULT_LOCALE 兜底
 */
export function getApiMessage(key: keyof typeof en.api): string {
  const locale = getLocaleFromClientCookie();
  return messagesMap[locale]?.api?.[key] ?? messagesMap[DEFAULT_LOCALE].api[key];
}

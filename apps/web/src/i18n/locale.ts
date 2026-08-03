/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §i18n
 *   - 补充: docs/i18n.md（Phase 2 补齐，key 命名与新增语言流程）
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

/**
 * 支持的语言列表。新增语言时：① 此处追加 ② messages/ 下新增同名 JSON ③ messages/index 注册。
 * 'zh-CN' 带地区码是因为简/繁未来可能并存，保持 BCP 47 形态。
 */
export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;

/** 语言类型（契约即设计：开源默认语言为英文） */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 默认语言：英文（开源 fallback，见 i18n plan 已确认决策） */
export const DEFAULT_LOCALE: Locale = 'en';

/** 语言偏好 cookie 名；URL 不带 locale 前缀，全靠它记忆用户选择 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/** cookie 有效期：1 年（秒） */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * 把任意输入收敛为合法 Locale；非法/空值一律回落 DEFAULT_LOCALE。
 * 服务端（layout 读 cookie）与客户端（document.cookie）共用此归一化入口。
 */
export function normalizeLocale(value: string | undefined | null): Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value ?? '')
    ? (value as Locale)
    : DEFAULT_LOCALE;
}

/**
 * 客户端写入语言 cookie 并配合 router.refresh() 生效（调用方负责 refresh）。
 * 副作用：写 document.cookie。
 */
export function setLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * 客户端读取当前语言 cookie（非 React 模块专用，如 lib/api.ts 的错误 fallback）。
 * SSR 环境（无 document）返回 DEFAULT_LOCALE。
 */
export function getLocaleFromClientCookie(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  return normalizeLocale(match?.[1] ? decodeURIComponent(match[1]) : undefined);
}

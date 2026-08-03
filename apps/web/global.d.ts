import type { Locale } from '@/i18n/locale';
import type en from '@/i18n/messages/en.json';

/**
 * next-intl v4 全局类型增强：useTranslations 的 key 与 locale 获得编译期校验。
 * en.json 是文案唯一真相源（fallback 语言），key 写错即编译报错。
 */
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof en;
  }
}

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { type Locale } from '@/i18n/locale';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 按当前语言格式化绝对时间（年月日 时分，24 小时制）。
 * @param date 时间值；空值返回 '-'。
 * @param locale 当前语言（必选，禁止硬编码 'zh-CN'）。
 */
export function formatDate(date: string | Date | undefined, locale: Locale): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * 按当前语言格式化相对时间（Intl.RelativeTimeFormat，双语自动）。
 * 档位：<60s → "现在/now"；分/时/天对称档位；未来时间（seconds<0）走对称档位（"N 分钟后/in N minutes"）；>30 天回落 formatDate。
 * @param date 时间值；空值返回 '-'。
 * @param locale 当前语言（必选，禁止硬编码 'zh-CN'）。
 */
export function formatRelativeTime(date: string | Date | null | undefined, locale: Locale): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  // 未来时间（seconds < 0）：按对称档位输出（Intl 正数 = 未来，传 -seconds 等取正；
  // 自动 "N 秒后/分钟后" / "in N seconds/minutes"），禁止落入 format(0)
  if (seconds < 0) {
    if (Math.abs(seconds) < 60) return rtf.format(-seconds, 'second');
    if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
    if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
    if (Math.abs(days) < 30) return rtf.format(-days, 'day');
    return formatDate(date, locale);
  }
  if (seconds < 60) return rtf.format(0, 'second');
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  if (hours < 24) return rtf.format(-hours, 'hour');
  if (days < 30) return rtf.format(-days, 'day');
  return formatDate(date, locale);
}

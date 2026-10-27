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
 * searchParams 值 → UUID（**形状校验**，三个页面共用的唯一实现）。
 *
 * 为什么要拦：后端凡带 `:id` 的路径参数都是 `@IsUUID()`，脏值会被 400 **把整页打进错误态**
 * （旧链接 / 手输 / 外部分享都可能带脏值）。这里只保证"放进后端 URL 的一定是 UUID 形态的串"，
 * 合法性与存在性仍由后端裁决（铁律 #21：格式在边界层拦，业务存在性在服务层判）。
 *
 * ⚠️ 正则与后端 `@IsUUID()`（validator 的 `all` 模式）等价：版本位 `[1-8]` + variant 位 `[89ab]`，
 * 外加 nil / max 两个例外——**比后端宽**会让形状像 UUID 的脏值漏过去吃 400，
 * **比后端严**会误杀合法值。两侧不许各自演化。
 *
 * 历史：本函数曾有**三份逐字复制**（`memory/page.tsx`、`memory/[id]/page.tsx`、
 * `experiences/page.tsx`）。复制体的危险在于"改一处忘两处"表现为静默的行为分歧，
 * 故提取到通用工具层（本文件不属于任何业务域）。
 *
 * @param raw - URL 参数原值（`null` = 未提供）
 * @returns 合法 UUID 或 `null`（调用方回落"不过滤"/"不选中"）
 */
export function parseUuidParam(raw: string | null): string | null {
  if (!raw) return null;
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
    raw,
  )
    ? raw
    : null;
}

/**
 * searchParams 值 → 白名单枚举（脏值回落 `null`，由调用方选缺省）。
 *
 * 为什么要拦：把任意字符串当过滤值发给后端会撞 `@IsIn` 400，**把整页打进错误态**
 * （旧链接、手输、外部分享的参数都可能带脏值）。这里只做"在不在值域里"的判定，
 * 值域本身取自 shared 单源常量。
 *
 * 历史：与 `parseUuidParam` 一样曾有**两份逐字复制**（`memory/page.tsx`、
 * `experiences/page.tsx`），图页要用第三次时一并提取（三处副本 = 改一处忘两处的静默分歧）。
 *
 * @param raw - URL 参数原值（`null` = 未提供）
 * @param allowed - 该参数的合法值域（shared 单源常量）
 * @returns 合法值或 `null`
 */
export function parseEnumParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | null {
  if (!raw) return null;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
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

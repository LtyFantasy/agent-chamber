import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import './globals.css';
import { Providers } from './providers';
import { GridBeams } from '@/components/layout/grid-beams';
import { LOCALE_COOKIE, normalizeLocale, type Locale } from '@/i18n/locale';
import { messagesMap } from '@/i18n/api-messages';

const inter = Inter({ subsets: ['latin'] });

/**
 * 从请求 cookie 解析当前语言（URL 不带 locale 前缀，cookie 是唯一记忆通道）。
 * 非法/缺失值由 normalizeLocale 收敛为英文默认。
 */
async function getRequestLocale(): Promise<Locale> {
  const store = await cookies();
  return normalizeLocale(store.get(LOCALE_COOKIE)?.value);
}

/** 浏览器标签页标题/描述随语言走（layout 是服务端组件，直读 messages 零成本） */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const { title, description } = messagesMap[locale].metadata;
  return { title, description };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getRequestLocale();
  // dark-only：服务端硬编码 dark class（详见 docs/ui-design-system.md）。
  // 作用：① globals.css 令牌收敛为 :root 单份暗色值；② 保住 `dark:` 变体（如 skills 页 dark:prose-invert）；
  // ③ 消灭主题切换的 hydration 闪烁。suppressHydrationWarning 保留以容忍浏览器插件改 html 属性。
  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body className={inter.className}>
        {/* i18n provider 置于最外层：全站页面均为客户端组件，统一经 useTranslations 消费文案 */}
        <NextIntlClientProvider locale={locale} messages={messagesMap[locale]}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
        {/* 全局网格光线流动：纯 CSS 氛围动效，fixed -z-10 压在所有内容之下 */}
        <GridBeams />
      </body>
    </html>
  );
}

import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置 — 「Mission Control」深空暗色主题
 *
 * 关键约定（详见 docs/ui-design-system.md）：
 * 1. 所有颜色映射必须带 `<alpha-value>` 占位符（hsl(var(--x) / <alpha-value>)），
 *    否则 `bg-primary/10` 这类透明度修饰符会被 Tailwind 静默忽略；
 *    CSS 变量值保持空格分隔的 HSL 通道格式（如 `187 92% 55%`）。
 * 2. 发光阴影（boxShadow.glow-*）引用 CSS 变量而非写死色值，令牌改色即全局跟随。
 * 3. 氛围动效（drift / breathing）只允许 transform / opacity，避免触发 layout 重排。
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    // lib 下存在以字面量类字符串为内容的模块（markdown-classes.ts、animations.ts），
    // 必须纳入扫描，否则其中的 Tailwind 类不会生成 CSS 且无任何编译期报错
    './src/lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        // 辅助光色（紫）：命名 violet-glow 避免覆盖 Tailwind 内置 violet 色板
        'violet-glow': 'hsl(var(--violet) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        // 发光投影：双层（近场亮 + 远场扩散），仅用于焦点/选中/CTA 等点缀元素
        'glow-cyan':
          '0 0 20px hsl(var(--primary) / 0.35), 0 0 48px hsl(var(--primary) / 0.15)',
        'glow-violet':
          '0 0 20px hsl(var(--violet) / 0.35), 0 0 48px hsl(var(--violet) / 0.15)',
        // 小号发光：logo 图标、状态点等小元素
        'glow-sm': '0 0 12px hsl(var(--primary) / 0.35)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        // 光斑漂移：translate 百分比相对元素自身尺寸，位移刻意小（光斑很大，小百分比已足够）
        drift: {
          '0%': { transform: 'translate3d(0, 0, 0)' },
          '50%': { transform: 'translate3d(4%, -3%, 0)' },
          '100%': { transform: 'translate3d(-3%, 4%, 0)' },
        },
        // 呼吸：状态点 / logo 点缀的明暗脉动，仅 transform/opacity
        breathing: {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        // 光斑漂移 20-30s 级慢速，alternate 往返避免跳变
        drift: 'drift 24s ease-in-out infinite alternate',
        'drift-slow': 'drift 32s ease-in-out infinite alternate-reverse',
        breathing: 'breathing 3.6s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')],
};

export default config;

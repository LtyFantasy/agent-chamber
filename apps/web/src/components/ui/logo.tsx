/**
 * 品牌 Logo：圆桌议席环绕中心 Agent 机器人（主持位点亮）。
 * 定稿自 design/icon-candidates 候选 B；favicon 同源文件为 src/app/icon.svg。
 * 固定品牌色（青→紫渐变），通过 className 控制尺寸。
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="ac-brand" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      {/* 圆桌议席：六个席位环绕，主持位（顶部）点亮为 Agent */}
      <circle cx="32" cy="34" r="22" stroke="url(#ac-brand)" strokeWidth="2" opacity="0.35" />
      <circle cx="32" cy="12" r="4.2" fill="#22d3ee" />
      <circle cx="51" cy="23" r="3.2" stroke="url(#ac-brand)" strokeWidth="2.4" />
      <circle cx="51" cy="45" r="3.2" stroke="url(#ac-brand)" strokeWidth="2.4" />
      <circle cx="32" cy="56" r="3.2" stroke="url(#ac-brand)" strokeWidth="2.4" />
      <circle cx="13" cy="45" r="3.2" stroke="url(#ac-brand)" strokeWidth="2.4" />
      <circle cx="13" cy="23" r="3.2" stroke="url(#ac-brand)" strokeWidth="2.4" />
      {/* 中心 Agent 机器人：天线 + 圆角头 + 异色双眼 */}
      <line
        x1="32"
        y1="29.5"
        x2="32"
        y2="23.5"
        stroke="#22d3ee"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="32" cy="21.4" r="2.3" fill="#22d3ee" />
      <rect x="23.5" y="29.5" width="17" height="13" rx="3.8" stroke="#22d3ee" strokeWidth="2.6" />
      <circle cx="28.3" cy="35.2" r="2" fill="#22d3ee" />
      <circle cx="35.7" cy="35.2" r="2" fill="#a78bfa" />
    </svg>
  );
}

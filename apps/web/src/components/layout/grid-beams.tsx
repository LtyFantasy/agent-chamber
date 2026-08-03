/**
 * GridBeams — 全局网格光线流动（纯视觉，无逻辑）。
 *
 * 在全局网格底纹（globals.css `body::before`，40px 网格）上叠加沿网格线流动的光斑：
 * 3 条横向 + 3 条纵向，top/left 取 40 的倍数以对齐网格线，
 * duration/delay 错开模拟随机分布，linear 循环两端都在屏外无跳变。
 * 纯 CSS 动画（仅 transform/opacity，红线见 docs/ui-design-system.md §5）；
 * prefers-reduced-motion 下整体隐藏（globals.css 媒体查询兜底）。
 * fixed + -z-10 + pointer-events-none：压在 body 底色之上、网格纹与所有内容之下。
 */
export function GridBeams() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* 横向光束：沿网格横线流动 */}
      <div
        className="grid-beam grid-beam-x"
        style={{ top: 160, animationDuration: '14s', animationDelay: '-4s' }}
      />
      <div
        className="grid-beam grid-beam-x"
        style={{ top: 400, animationDuration: '19s', animationDelay: '-11s' }}
      />
      <div
        className="grid-beam grid-beam-x"
        style={{ top: 640, animationDuration: '16s', animationDelay: '-8s' }}
      />
      {/* 纵向光束：沿网格纵线流动 */}
      <div
        className="grid-beam grid-beam-y"
        style={{ left: 240, animationDuration: '18s', animationDelay: '-6s' }}
      />
      <div
        className="grid-beam grid-beam-y"
        style={{ left: 520, animationDuration: '23s', animationDelay: '-15s' }}
      />
      <div
        className="grid-beam grid-beam-y"
        style={{ left: 800, animationDuration: '16s', animationDelay: '-2s' }}
      />
    </div>
  );
}

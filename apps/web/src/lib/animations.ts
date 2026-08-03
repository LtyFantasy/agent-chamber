/**
 * animations.ts — framer-motion 编排动效库（Batch 2 起用）
 *
 * 约定（详见 docs/ui-design-system.md §5 动效规范，视觉唯一真相源）：
 * - 只动画 transform / opacity（variants 里只用 opacity + y 位移），
 *   禁止 width/height/top/left 等触发 layout 的属性；
 * - 交互动效时长 200-400ms，缓动 ease-out；
 * - 尊重 prefers-reduced-motion：页面级在组件树根部包 <MotionConfig reducedMotion="user">，
 *   useCountUp 内部用 useReducedMotion() 兜底（reduced 时直接落终值，不播放）。
 */

import { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion, type Variants } from 'framer-motion';

/**
 * 区块级 stagger 容器：子元素按 80ms 间隔依次入场。
 * 用法：父级 <motion.div variants={staggerContainer} initial="hidden" animate="show">，
 * 子级挂 fadeSlideUp。
 */
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
};

/**
 * 淡入 + 轻微上移（12px）：页面/区块/卡片的统一入场变体。
 * 仅 opacity + transform，符合动效红线。
 */
export const fadeSlideUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: 'easeOut' },
  },
};

/**
 * useCountUp — 数字滚动动画 hook（统计卡大数字用）。
 *
 * 行为契约：
 * - 仅在【首次播放】时从 0 滚到 target；之后 target 变化（如 react-query refetch）
 *   直接落新值，不重播动画——避免后台刷新时数字反复抽动；
 * - prefers-reduced-motion 时跳过动画，直接显示终值；
 * - 返回值已 Math.round 取整（统计数字均为整数）。
 *
 * 注意：调用方应在数据加载完成后再挂载使用本 hook 的组件，
 * 否则首次播放会以 loading 期的 0 为目标值，真实数据到达时不再重播。
 *
 * @param target 目标数值
 * @param duration 动画时长（秒），默认 0.9s
 */
export function useCountUp(target: number, duration = 0.9): number {
  const shouldReduce = useReducedMotion();
  // 首帧：reduced 直接给终值，否则从 0 起滚
  const [display, setDisplay] = useState(() => (shouldReduce ? target : 0));
  // 是否已播放过首次动画：refetch 导致 target 变化时不再重播
  const playedRef = useRef(false);

  useEffect(() => {
    if (shouldReduce || playedRef.current) {
      setDisplay(target);
      return;
    }
    playedRef.current = true;
    const controls = animate(0, target, {
      duration,
      ease: 'easeOut',
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [target, duration, shouldReduce]);

  return display;
}

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plans/magik-pantha-static.md §方案A 步骤1（useTilt hook）
 *   - 补充: plans/magik-pantha-static.md §Review 修正记录（P1 分相 transition / P1-2 异常复位）
 *
 * [踩坑索引]
 *   - pointermove 期间必须关 transition 直接跟手写 transform，否则 300ms 追帧迟滞；
 *     transition 只在 enter/leave 时开启（平滑入场与回落）
 *   - jsdom 无 matchMedia / getBoundingClientRect 全零，测试须自行 mock（见 use-tilt.test.ts）
 *
 * [铁律关联] #11（新代码注释强制）、设计系统动效红线：只动 transform/opacity
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

'use client';

import { useEffect, useRef } from 'react';

/** useTilt 可调参数 */
export interface TiltOptions {
  /** 最大倾斜角（度），列表卡建议 ≤6，展示卡 ≤10。默认 6 */
  max?: number;
  /** 悬停放大倍率。默认 1.01 */
  scale?: number;
  /** 透视距离（px），越大形变越弱。默认 1000 */
  perspective?: number;
  /** enter/leave 过渡时长（ms）。默认 300 */
  speed?: number;
}

const DEFAULTS = { max: 6, scale: 1.01, perspective: 1000, speed: 300 } as const;

/**
 * useTilt — 3D 悬停倾斜 hook（vanilla-tilt 风格，手写零依赖）。
 *
 * 行为契约：
 * - 守卫（任一不满足则完全不挂 listener，SSR/触屏/reduced-motion 零副作用）：
 *   ① 非浏览器环境；② `prefers-reduced-motion: reduce`（动效红线 §5）；
 *   ③ 非精密指针 `(hover: hover) and (pointer: fine)` 不命中（触屏不倾斜）；
 * - transition 分相控制：pointerenter/pointerleave 开 transition（平滑入场/回落），
 *   pointermove 期间关 transition 跟手写 transform（防追帧迟滞）；
 * - 异常复位：pointercancel / window blur 与 pointerleave 同路径清空 transform；
 * - 只写 `style.transform` 与 `style.transition`，不碰其他属性；
 * - 卸载/依赖变化：removeEventListener + cancelAnimationFrame 全清理。
 *
 * 坐标约定（CSS y 轴向下）：cursor 上方 → rotateX 负（顶边倒向观察者），
 * cursor 右方 → rotateY 负（右边倒向观察者），即「卡片倒向鼠标」经典效果。
 *
 * @param options 倾斜参数（见 TiltOptions）
 * @param disabled 为 true 时不挂任何 listener（供 Card 等组件无条件调用 hook、按 prop 开关）
 * @returns 挂到目标元素上的 ref
 */
export function useTilt<T extends HTMLElement = HTMLDivElement>(
  options?: TiltOptions,
  disabled = false,
) {
  const ref = useRef<T>(null);
  // 最新参数经 ref 透传进 listener，避免 options 变化重挂 listener
  const optsRef = useRef({ ...DEFAULTS, ...options });
  optsRef.current = { ...DEFAULTS, ...options };

  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    // jsdom 等环境无 matchMedia，防御性判函数存在
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    let rafId = 0;
    /** move 期间缓存的最新指针坐标（rAF 节流：每帧最多写一次 transform） */
    let lastEvent: PointerEvent | null = null;
    /** enter 后首帧标记：首帧保留 transition 平滑入场，后续 move 关 transition 跟手 */
    let justEntered = false;

    const applyTilt = () => {
      rafId = 0;
      if (!lastEvent) return;
      const { max, scale, perspective } = optsRef.current;
      const rect = el.getBoundingClientRect();
      // rect 为零（jsdom/隐藏元素）时除零防御
      if (rect.width === 0 || rect.height === 0) return;
      const px = (lastEvent.clientX - rect.left) / rect.width - 0.5;
      const py = (lastEvent.clientY - rect.top) / rect.height - 0.5;
      // 分相控制核心：入场首帧保留 transition（平滑），之后 move 关 transition（跟手防迟滞）
      if (justEntered) {
        justEntered = false;
      } else {
        el.style.transition = 'none';
      }
      el.style.transform = `perspective(${perspective}px) rotateX(${(py * 2 * max).toFixed(
        2,
      )}deg) rotateY(${(-px * 2 * max).toFixed(2)}deg) scale(${scale})`;
    };

    const onEnter = () => {
      justEntered = true;
      el.style.transition = `transform ${optsRef.current.speed}ms ease-out`;
    };

    const onMove = (e: PointerEvent) => {
      lastEvent = e;
      if (rafId === 0) rafId = requestAnimationFrame(applyTilt);
    };

    const onReset = () => {
      lastEvent = null;
      justEntered = false;
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      // leave/cancel/blur：开 transition 平滑回落后清空 transform
      el.style.transition = `transform ${optsRef.current.speed}ms ease-out`;
      el.style.transform = '';
    };

    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onReset);
    el.addEventListener('pointercancel', onReset);
    window.addEventListener('blur', onReset);

    return () => {
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onReset);
      el.removeEventListener('pointercancel', onReset);
      window.removeEventListener('blur', onReset);
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [disabled]);

  return ref;
}

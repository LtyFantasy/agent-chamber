/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图的**画布视口**：滚轮缩放 / 指针拖拽平移 / 双指捏合 + 视口适配与焦点跟随
 *
 * [代码职责]
 *   - 把指针与滚轮事件翻译成一枚 `{ scale, x, y }` 变换（由画布的 `<g transform>` 消费）
 *   - 提供 `fitTo` / `centerOn` 两类"程序性移动"（首屏适配、Tab 到视口外节点时的跟随）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §5（动效：仅 transform/opacity、200-400ms、ease-out）
 *   - 实现蓝本: plan §4.1「新写 `use-graph-viewport` hook」段 + N5（auto-fit 时机）+ N9（点击判定）
 *
 * [关键不变量]
 *   - **禁止抄 `use-tilt`**（U/M15）：那个是 3D 悬停倾斜，带 hover / pointer 双守卫，
 *     照抄会让触屏全废——本 hook 是 2D 平移缩放，与悬停无关
 *   - **缩放钳制 [0.2, 2.5]**：下界来自"描边几何在小缩放下失真"（故画布另加
 *     `vector-effect="non-scaling-stroke"`），上界防止把单个节点放到糊
 *   - **`wheel` 必须原生非被动监听**：React 的 `onWheel` 在根节点上是 passive 的，
 *     `preventDefault()` 会被忽略 ⇒ 滚轮缩放会连带把整页滚动一遍
 *   - **点击 vs 拖拽的判据是位移 < 4px**（N9）：用"是否触发过 pointermove"判定会让每次
 *     平移收手都误清选中（手一抖就是一次 move）
 *   - **`smooth` 只给程序性移动**：拖拽/滚轮期间必须关掉 CSS transition，否则指针与画面
 *     之间会拖出一条橡皮筋；`prefers-reduced-motion` 下恒为 false（瞬时到位）
 *   - 变换用 rAF 合帧：`pointermove` 一次手势可达上百次，逐次 setState 会把画布拖垮
 *
 * [关联代码]
 *   - ./memory-graph-canvas.tsx — 唯一消费方（把 transform 写进 `<g>`）
 *   - ./memory-graph-layout.ts — 缩放钳制常量与内容包围盒的来源
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增交互仍是"变换"而不是"动画"
 *   □ 改动阈值（4px / 0.0015 / 320ms）必须同步注释里的理由
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  MEMORY_GRAPH_SCALE_MAX,
  MEMORY_GRAPH_SCALE_MIN,
  computeFitTransform,
} from './memory-graph-layout';

/** 画布变换（`<g transform="translate(x y) scale(scale)">` 的三个分量） */
export interface GraphViewportTransform {
  scale: number;
  x: number;
  y: number;
}

/** 点击判定阈值（px）：`pointerup` 相对 `pointerdown` 的位移小于它 = 点击，否则是拖拽 */
export const GRAPH_CLICK_SLOP_PX = 4;

/** 滚轮灵敏系数（`deltaY` 每 100 约合 1.16 倍缩放；太大一滚就飞、太小滚不动） */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** 程序性移动的过渡时长（ms；与设计系统的 200-400ms 档一致） */
export const GRAPH_SMOOTH_MS = 300;

/** 缩放钳制 */
function clampScale(scale: number): number {
  return Math.min(MEMORY_GRAPH_SCALE_MAX, Math.max(MEMORY_GRAPH_SCALE_MIN, scale));
}

/**
 * 关系图画布视口。
 *
 * @returns 变换、事件处理器与程序性移动入口；`containerRef` 是**回调 ref**（挂在画布外层
 *   div 上），用回调而不是 `useRef` 是因为所有监听都在 effect 里绑定，需要元素进 state
 *   才能触发一次重绑。
 */
export function useGraphViewport() {
  const reduceMotion = useReducedMotion();
  /** 画布外层元素（监听绑定与尺寸测量都在它上面） */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<GraphViewportTransform>({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  /** 是否开启 CSS 过渡（只给 `fitTo` / `centerOn`；拖拽与滚轮期间恒 false） */
  const [smooth, setSmooth] = useState(false);

  const transformRef = useRef(transform);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  /** rAF 合帧（渲染每帧最多一次；**ref 才是数学上的真值来源**，见 commit） */
  const frameRef = useRef<number | null>(null);
  const smoothTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 活跃指针（单指 = 平移，双指 = 捏合） */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  /** 本次手势起点（点击判定用） */
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(0);
  /** 捏合基准（双指距离与当时的缩放） */
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null);

  /**
   * 提交一枚新变换。
   *
   * ⚠️ **同步写 `transformRef`**（M1）：一帧内可能连发多次 pointermove / wheel，
   * 每次的增量都基于 `transformRef.current` 推导。只把结果塞进"下一帧待渲染值"而不回写 ref，
   * 第二次手势读到的还是**本次手势之前**的值，前一次增量就丢了（表现 = 快速拖动时画面跟不上手）。
   * rAF 只保证"每帧渲染一次"，不保证"一帧只调用一次 commit"。
   */
  const commit = useCallback((next: GraphViewportTransform) => {
    transformRef.current = next;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // 读 ref 而不是捕获值：本帧内最后一次 commit 的结果才是要画的
      setTransform(transformRef.current);
    });
  }, []);

  /** 程序性移动：短暂开启过渡（reduced-motion 下不开） */
  const moveSmoothly = useCallback(
    (next: GraphViewportTransform) => {
      if (!reduceMotion) {
        setSmooth(true);
        if (smoothTimerRef.current) clearTimeout(smoothTimerRef.current);
        smoothTimerRef.current = setTimeout(() => setSmooth(false), GRAPH_SMOOTH_MS + 20);
      }
      transformRef.current = next;
      setTransform(next);
    },
    [reduceMotion],
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (smoothTimerRef.current) clearTimeout(smoothTimerRef.current);
    },
    [],
  );

  // ── 尺寸测量（ResizeObserver 缺席时退回 window resize）────────────────────────
  useEffect(() => {
    if (!container) return;
    const measure = () => {
      const rect = container.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  /** 以容器坐标 (cx, cy) 为锚点缩放：锚点下的世界坐标保持不动 */
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const current = transformRef.current;
      const scale = clampScale(current.scale * factor);
      const ratio = scale / current.scale;
      commit({
        scale,
        x: cx - (cx - current.x) * ratio,
        y: cy - (cy - current.y) * ratio,
      });
    },
    [commit],
  );

  // ── 滚轮缩放（原生非被动监听：React 的 onWheel 在根节点上是 passive 的）────────
  useEffect(() => {
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setSmooth(false);
      const rect = container.getBoundingClientRect();
      zoomAt(
        Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [container, zoomAt]);

  // ── 指针：单指平移 / 双指捏合；记录位移供"点击 vs 拖拽"判定 ────────────────────
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // 只接主键（右键/中键留给浏览器菜单与滚动）
    if (event.button !== 0) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 1) {
      originRef.current = { x: event.clientX, y: event.clientY };
      movedRef.current = 0;
      setSmooth(false);
      setPanning(true);
    } else if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale: transformRef.current.scale,
      };
    }
    // 注意：**不** setPointerCapture——捕获会让节点上的 click 事件丢失，
    // 节点要能收到自己的 click 才能开抽屉
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pointersRef.current.has(event.pointerId)) return;
      const previous = pointersRef.current.get(event.pointerId) as { x: number; y: number };
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (originRef.current) {
        movedRef.current = Math.max(
          movedRef.current,
          Math.hypot(event.clientX - originRef.current.x, event.clientY - originRef.current.y),
        );
      }
      if (pointersRef.current.size >= 2) {
        // 双指捏合：以两指中点 + 基准距离的比例缩放（服务 ≥xl 的触屏设备）
        const [a, b] = Array.from(pointersRef.current.values());
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const base = pinchRef.current;
        const rect = container?.getBoundingClientRect();
        if (base && distance > 0 && rect) {
          const target = clampScale(base.scale * (distance / base.distance));
          const current = transformRef.current;
          const factor = target / current.scale;
          const cx = (a.x + b.x) / 2 - rect.left;
          const cy = (a.y + b.y) / 2 - rect.top;
          commit({
            scale: target,
            x: cx - (cx - current.x) * factor,
            y: cy - (cy - current.y) * factor,
          });
        }
        return;
      }
      if (pointersRef.current.size === 1 && (dx !== 0 || dy !== 0)) {
        const current = transformRef.current;
        commit({ scale: current.scale, x: current.x + dx, y: current.y + dy });
      }
    },
    [commit, container],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) setPanning(false);
  }, []);

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    if (pointersRef.current.size === 0) setPanning(false);
  }, []);

  /**
   * **画布外抬指针的兜底**（M2）。
   *
   * 指针事件对鼠标没有隐式捕获：从画布内按下、拖到画布外松手时，容器收不到 `pointerup`，
   * `pointersRef` 会一直留着那枚指针 ⇒ `panning` 永真（光标卡在 grabbing）、下一次按下
   * 还会被当成第二指走捏合分支。故 pointerup / pointercancel 再挂一层 window 监听。
   * 与容器上的 React 处理器重复执行是幂等的（delete 同一 key 无害）。
   */
  useEffect(() => {
    const release = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      if (pointersRef.current.size === 0) setPanning(false);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  /** 最近一次手势是否为点击（位移 < `GRAPH_CLICK_SLOP_PX`）——点空白清选中的判据 */
  const isClick = useCallback(() => movedRef.current < GRAPH_CLICK_SLOP_PX, []);

  /**
   * 视口适配：把内容包围盒放进容器（不放大——`scale ≤ 1`，避免少数几个节点被拉成巨块）。
   *
   * @param content - 内容包围盒（`layoutMemoryGraph` 的 `width` / `height`）
   * @param instant - true = 不做过渡（reduced-motion 或首帧）
   */
  const fitTo = useCallback(
    (content: { width: number; height: number }, instant = false) => {
      // 几何收在纯函数里（可单测；见 layout 模块的 computeFitTransform）
      const next = computeFitTransform(content, sizeRef.current);
      if (!next) return;
      if (instant) {
        transformRef.current = next;
        setTransform(next);
      } else {
        moveSmoothly(next);
      }
    },
    [moveSmoothly],
  );

  /**
   * 把某个世界坐标点移到容器中心（Tab 到视口外节点时的跟随）。
   *
   * @param worldX - 世界坐标 x
   * @param worldY - 世界坐标 y
   */
  const centerOn = useCallback(
    (worldX: number, worldY: number) => {
      const view = sizeRef.current;
      const current = transformRef.current;
      if (view.width <= 0 || view.height <= 0) return;
      moveSmoothly({
        scale: current.scale,
        x: view.width / 2 - worldX * current.scale,
        y: view.height / 2 - worldY * current.scale,
      });
    },
    [moveSmoothly],
  );

  return {
    transform,
    smooth: smooth && !reduceMotion,
    panning,
    containerRef: setContainer,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    zoomAt,
    fitTo,
    centerOn,
    isClick,
    size,
  };
}

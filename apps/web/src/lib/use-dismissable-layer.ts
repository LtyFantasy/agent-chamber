/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **层关闭语义**的共享原语：Esc 关闭 + 关闭后焦点幂等还原
 *
 * [代码职责]
 *   - 把"打开时记录触发元素、关闭时还回去""Esc 关层"这两件在仓内反复出现的事收成一份：
 *     已迁入 = `alert-dialog`（`confirm()` 的宿主）/ 记忆正文 Dialog / 关系图节点抽屉。
 *     ⚠️ **`memory-project-create-dialog.tsx` 尚未迁移**（它捆绑了 `dismissBlocked` 三态门控
 *     与自绘遮罩，且没有 Esc 的测试网）——它仍自带一份 Esc 监听，迁移是独立的一批
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §3（组件基线）
 *   - 实现蓝本: plan §4.1「焦点回归照 alert-dialog.tsx:57-72 + 第三处复制抽 useDismissableLayer」
 *
 * [关键不变量]
 *   - **焦点还原必须幂等**：目标可能已经不在 DOM 里（触发器所在列表被重渲染），
 *     此时 `focus?.()` 静默失败即可，**不要**退化成把焦点塞给 `document.body`
 *   - **`restoreFocusTo` 在"关闭那一刻"求值**（不是打开时）：调用方要按**当时的** DOM
 *     查当前元素（列表翻页 / 重挂后旧引用已失效）；本 hook 内部也走 ref 取最新闭包，
 *     否则"开着层换目标再关闭"会把焦点送回上一个目标
 *   - **Esc 监听挂 window 而不是面板**：这些层都没有 focus trap，焦点跑到背后时
 *     挂在面板上的监听就收不到按键了（先例 `components/ui/sheet.tsx`）
 *   - **不传 `onDismiss` = 本 hook 不接管 Esc**：非模态层（关系图抽屉）的 Esc 语义由外层
 *     统一持有（"开→关抽屉，关→清选中"），两处都监听会让一次 Esc 触发两个动作
 *   - `ready` 用于"portal 挂载 / 数据就绪后才能真正聚焦"的场景：首帧目标 ref 还是 null，
 *     不把它放进 deps 会让 autoFocus 永远落空
 *
 * [关联代码]
 *   - ../components/ui/alert-dialog.tsx — 迁移前的参考实现（本 hook 的行为基准）
 *   - ../components/memory/graph/graph-node-drawer.tsx — 不传 `onDismiss` 的用法（Esc 归容器）
 *   - ../components/memory/representation-body-dialog.tsx — `initialFocus` 的用法
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认改动不改变"关闭后焦点回到触发元素"这条契约
 *   □ 新增配置项必须有默认值，默认行为不得与迁移前产生可观测差异
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useEffect, useRef, type RefObject } from 'react';

interface DismissableLayerOptions {
  /** 层是否打开（false 时不监听、不还原焦点） */
  open: boolean;
  /** 被动关闭（Esc）。**不传则 Esc 不生效**（非模态层由外层持有语义） */
  onDismiss?: () => void;
  /**
   * 关闭后要聚焦的元素求值函数。
   *
   * 缺省 = 打开时记录的 `document.activeElement`。返回 `null` 时也回落到它。
   */
  restoreFocusTo?: () => HTMLElement | null;
  /** 打开时要自动聚焦的元素（缺省不抢焦点） */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 首帧是否已就绪（portal 挂载等）：为 false 时不记录焦点、不 autoFocus */
  ready?: boolean;
}

/**
 * 层关闭语义（Esc + 焦点还原）。
 *
 * @param options - 见 `DismissableLayerOptions`
 */
export function useDismissableLayer({
  open,
  onDismiss,
  restoreFocusTo,
  initialFocus,
  ready = true,
}: DismissableLayerOptions): void {
  /** 打开前的焦点元素（关闭时的兜底还原目标） */
  const restoreRef = useRef<HTMLElement | null>(null);
  /** 最新 onDismiss（keydown 监听在 open 期间挂载，用 ref 免重挂） */
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  /**
   * 最新的 `restoreFocusTo`（m1）。
   *
   * 还原发生在 **cleanup**，而 cleanup 只捕获"打开那一刻"那次渲染的闭包。调用方常写成
   * `() => document.querySelector('#' + currentId)`——闭包里的 id 就永远停在第一个值上，
   * 于是"开着抽屉换一个节点再关闭"会把焦点送回**上一个**节点。走 ref 求值即取当前值。
   */
  const restoreFocusToRef = useRef(restoreFocusTo);
  restoreFocusToRef.current = restoreFocusTo;

  // Esc 关闭：keydown 挂 window（层内没有 focus trap，挂面板会漏键）
  useEffect(() => {
    if (!open || !onDismissRef.current) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDismissRef.current?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  /*
    焦点：打开时记录触发元素 + autoFocus；关闭**或卸载**时幂等还原。
    还原写在 cleanup 里（而不是 `!open` 分支里）：层通常是"open=false 就卸载"的写法，
    卸载路径没有 `!open` 分支可走，只有 cleanup 一定会执行。
    `initialFocus` 只在打开那一刻求值，取闭包值即可；`restoreFocusTo` 走 ref（见上）。
  */
  useEffect(() => {
    if (!open || !ready) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    initialFocus?.current?.focus();
    return () => {
      const target = restoreFocusToRef.current ? restoreFocusToRef.current() : null;
      (target ?? restoreRef.current)?.focus?.();
      restoreRef.current = null;
    };
    // initialFocus 是"每次渲染新建的对象"也应当被忽略：它只在打开那一刻求值一次，
    // 进 deps 会让每次重渲染都还原一次焦点
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);
}

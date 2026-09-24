'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 全局图片预览（Lightbox）宿主：markdown 渲染图片点击放大的唯一渲染点
 *
 * [代码职责]
 *   - 订阅 image-preview.store 的 src/alt，open 时渲染 fixed overlay（最高 z）
 *   - 预览 pin 持有（plan §③ 键空间契约）：open 时按 store.pinKey acquireRef、
 *     close/换图时 releaseRef——预览期间组件滚出视口/卸载不会 revoke 掉正在显示的 blob
 *   - 交互：背板点击关闭 / ESC 关闭 / 适应↔原始尺寸切换 / 关闭按钮
 *   - 打开时锁 body 滚动（overflow hidden，关闭恢复）
 *
 * [权威文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（消息渲染）— 图片预览宿主挂载
 *   - 补充: docs/ui-design-system.md §6.1（markdown 图片渲染层级）
 *
 * [关键不变量]
 *   - 全站唯一挂载点 = app/providers.tsx（NotificationHost 旁），禁止重复挂载
 *   - pin 键是 store.pinKey（附件内容 URL），**不是** store.src（blob URL）——
 *     acquireRef(blobUrl) 必 miss（blobCache 按附件 URL 键控），pin 静默失效即预览裂图；
 *     pin 的 acquire/release 必须成对（放 effect 清理里，天然覆盖 close 与换图两种路径）
 *   - 背板点击关闭：overlay onClick=close，工具栏/图片区必须 stopPropagation
 *     （点图片/按钮不关）
 *   - body 滚动锁必须保存并恢复原值（prev overflow），不能硬编码 '' 覆盖
 *   - 全部按钮 aria-label（图标按钮可访问名基线）
 *
 * [关联代码]
 *   - src/stores/image-preview.store.ts — 状态契约（open(displaySrc, alt, pinKey)/close）
 *   - src/components/attachments/attachment-image.tsx — 唯一触发点
 *     + acquireRef/releaseRef 模块 API（blob 引用计数）
 *
 * [持久踩坑]
 *   - 无
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Maximize, Minimize, X } from 'lucide-react';
import { useImagePreviewStore } from '@/stores/image-preview.store';
import { acquireRef, releaseRef } from '@/components/attachments/attachment-image';

/** 缩放模式：fit = object-contain 适应 90vw/90vh；actual = 原始尺寸 + 容器滚动 */
type ZoomMode = 'fit' | 'actual';

/**
 * ImagePreviewHost — 全局图片预览宿主（挂 app/providers.tsx，全站唯一挂载点）。
 *
 * 订阅 store.src：null 不渲染；非 null 渲染 fixed overlay（z-[100] 高于现有
 * z-50 弹层档位）。交互：
 * - 背板点击关闭（overlay onClick；工具栏/图片区 stopPropagation 防误关）
 * - ESC 关闭（window keydown，open 期间挂载）
 * - 适应/原始尺寸切换：fit = object-contain 居中适应 90vw/90vh；
 *   actual = 原始尺寸 + 容器 overflow-auto 可滚动
 * - 关闭按钮（X）
 * 打开时锁 body 滚动（保存原值，关闭恢复）。
 */
export function ImagePreviewHost() {
  const src = useImagePreviewStore((s) => s.src);
  const alt = useImagePreviewStore((s) => s.alt);
  const pinKey = useImagePreviewStore((s) => s.pinKey);
  const close = useImagePreviewStore((s) => s.close);
  const t = useTranslations('attachments');
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');

  // 预览 pin（plan §③ 键空间契约）：open 时按 pinKey（附件内容 URL，非 blobUrl）
  // acquireRef 持有 blob，close/换图（pinKey 变化或清空）时 releaseRef——
  // 预览期间组件滚出视口/卸载都不会 revoke 掉正在显示的 blob。
  useEffect(() => {
    if (!pinKey) return;
    acquireRef(pinKey);
    return () => releaseRef(pinKey);
  }, [pinKey]);

  // ESC 关闭（open 期间挂载，关闭即卸载）
  useEffect(() => {
    if (!src) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [src, close]);

  // body 滚动锁：打开时 overflow hidden，关闭恢复原值（不能硬编码 '' 覆盖）
  useEffect(() => {
    if (!src) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [src]);

  if (!src) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('preview')}
      className="fixed inset-0 z-[100] flex flex-col bg-black/85"
      onClick={close}
    >
      {/* 工具栏：适应/原始切换 + 关闭（stopPropagation：点按钮不触发背板关闭） */}
      <div
        className="flex shrink-0 items-center justify-end gap-2 p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setZoomMode((m) => (m === 'fit' ? 'actual' : 'fit'))}
          aria-label={zoomMode === 'fit' ? t('zoomActual') : t('zoomFit')}
          title={zoomMode === 'fit' ? t('zoomActual') : t('zoomFit')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {zoomMode === 'fit' ? <Maximize className="h-4 w-4" /> : <Minimize className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t('closePreview')}
          title={t('closePreview')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* 图片区：fit = 居中 object-contain；actual = 原始尺寸 + 滚动
          （stopPropagation：点图片不触发背板关闭） */}
      <div
        className={
          zoomMode === 'fit'
            ? 'flex min-h-0 flex-1 items-center justify-center p-4'
            : 'min-h-0 flex-1 overflow-auto p-4'
        }
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt={alt ?? ''}
          className={
            zoomMode === 'fit'
              ? 'max-h-[90vh] max-w-[90vw] object-contain'
              : 'h-auto w-auto max-w-none'
          }
        />
      </div>
    </div>
  );
}

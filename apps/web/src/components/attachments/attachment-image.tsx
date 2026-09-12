'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台媒体附件（MinIO）在 markdown 渲染中的鉴权图片加载器（plan §0.2/§5.2）
 *
 * [代码职责]
 *   - 识别附件内容 URL（精确前缀 /api/v1/attachments/ 或同源绝对 URL）→ 经
 *     axiosInstance（拦截器自动带 token）拉 blob → createObjectURL 渲染；
 *     其余 URL 一律原生 <img>，绝不走 axios（防 token 出站）
 *   - 模块级 blob 缓存（引用计数）：同图多处引用复用，归零 revoke
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Attachments（读取链路全鉴权，拒绝 capability URL）
 *   - 补充: docs/architecture.md §3.2（Attachments 模块）
 *
 * [关键不变量]
 *   - src 识别钉死：精确前缀 startsWith('/api/v1/attachments/')，或同源绝对 URL
 *     （new URL(src, location.origin) 解析后 origin 相同且 pathname 前缀命中）；
 *     其余一律原生 <img>——https://evil.com/api/v1/attachments/x 这类外部 URL
 *     若走 axios 会把 Bearer token 带出站（安全红线）
 *   - 空 src → 占位，不渲染 <img src="">（浏览器会请求页面自身）
 *   - blob 缓存 = 模块级 Map<src, {blobUrl, refs}> 引用计数：组件挂载 refs+1、
 *     卸载 refs-1、归零 revokeObjectURL；无缓存则同图多处引用重复 fetch + 内存翻倍
 *   - 401 走 axiosInstance 全局跳登录（既有拦截器行为），组件不特殊处理
 *   - 请求路径必须剥离 API_PREFIX（axiosInstance.baseURL 已含前缀，双拼 404——
 *     主脑 Playwright 实测抓出，回归断言见测试）
 *   - 图片预览触发点（批 3 追加）：仅渲染态 <img> 可点击放大（open 当前显示
 *     src——attachment 分支为 blob URL）；裂图占位/骨架不触发；键盘可达
 *     （role=button + tabIndex + Enter/Space）
 *
 * [关联代码]
 *   - src/lib/markdown-components.tsx — markdownComponents 工厂 img → 本组件
 *   - src/lib/api.ts（axiosInstance）— 鉴权 blob 拉取通道
 *   - src/stores/image-preview.store.ts + src/components/attachments/image-preview-host.tsx
 *     — 全局图片预览（点击放大）
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
import { ImageOff } from 'lucide-react';
import { API_PREFIX } from '@agent-chamber/shared';
import { axiosInstance } from '@/lib/api';
import { useImagePreviewStore } from '@/stores/image-preview.store';

/**
 * 附件内容 URL 前缀（与后端 buildContentUrl 同源：API_PREFIX + /attachments/<id>/content）。
 * API_PREFIX 单源 = shared（api.ts:104 同源引入），禁止硬编码 '/api/v1'——前缀演进
 * 只改 shared 一处。
 */
const ATTACHMENT_CONTENT_PREFIX = `${API_PREFIX}/attachments/`;

/**
 * 模块级 blob 缓存（引用计数语义，plan §5.2 钉死）：
 * Map<src, { blobUrl, refs }>——同图多处引用（同一消息/文档内重复出现）复用同一
 * blob URL，避免重复 fetch + 内存翻倍；refs 在组件挂载时 +1、卸载时 -1，
 * 归零 = 无任何组件引用 → revokeObjectURL 释放 + 删除条目。
 * 竞态说明：fetch 在途时组件卸载 → 成功回调被 cancelled 短路，不建条目不计数；
 * 并发同 src 双组件 → 后完成者发现已有条目则复用（refs+1），不重复建 URL。
 */
const blobCache = new Map<string, { blobUrl: string; refs: number }>();

/**
 * 解析附件 src → axios 请求路径（判定 + 剥离合一，安全红线 plan §5.2）：
 * ① 相对形态 `/api/v1/attachments/<id>/content` → 剥离 API_PREFIX → `/attachments/<id>/content`
 * ② 同源绝对形态 `http://host/api/v1/attachments/<id>/content` → 取 pathname 再剥前缀
 * 其余（外部 URL、//evil.com、data:、blob:、空）→ null = 非附件，调用方走原生
 * <img>，绝不走 axios——外部 URL 若走 axios 会把 Bearer token 带出站。
 *
 * 剥离原因（主脑 Playwright 实测抓出）：axiosInstance.baseURL 已含 API_PREFIX
 * （dev=http://localhost:8743/api/v1，prod=/api/v1），src 再带前缀会双拼成
 * /api/v1/api/v1/attachments/... 404。请求路径必须交给 baseURL 补前缀与 host——
 * 不能用 location.origin 拼绝对 URL（dev 下页面 8742 与 API 8743 不同源）。
 */
export function resolveAttachmentRequestPath(src: string): string | null {
  if (src.startsWith(ATTACHMENT_CONTENT_PREFIX)) {
    return src.slice(API_PREFIX.length);
  }
  try {
    const url = new URL(src, window.location.origin);
    if (
      url.origin === window.location.origin &&
      url.pathname.startsWith(ATTACHMENT_CONTENT_PREFIX)
    ) {
      return url.pathname.slice(API_PREFIX.length);
    }
  } catch {
    // 非法 URL → 非附件
  }
  return null;
}

/** 判定 src 是否为平台附件内容 URL（安全红线，plan §5.2；判定与剥离共用单函数防漂移） */
export function isAttachmentContentUrl(src: string): boolean {
  return resolveAttachmentRequestPath(src) !== null;
}

/** 释放一个引用：refs-1，归零 revoke + 删条目（组件卸载时调用） */
function releaseRef(src: string): void {
  const entry = blobCache.get(src);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.blobUrl);
    blobCache.delete(src);
  }
}

/** 加载失败/空 src 的 i18n 裂图占位（不渲染 <img src="">） */
function BrokenImagePlaceholder({ alt }: { alt?: string }) {
  const t = useTranslations('attachments');
  return (
    <span
      role="img"
      aria-label={alt || t('brokenImage')}
      className="inline-flex h-24 w-48 max-w-full items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 text-xs text-muted-foreground"
    >
      <ImageOff className="h-4 w-4 shrink-0" />
      {t('brokenImage')}
    </span>
  );
}

/** react-markdown img 覆盖会透传 node（hast 节点），必须剥离避免 DOM 警告 */
type AttachmentImageProps = React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };

/**
 * 附件鉴权图片（plan §0.2/§5.2 钉死）：
 * - 'use client' + useEffect 挂载后加载：SSR 输出占位骨架（水合安全——
 *   server 与首次 client 渲染一致，加载逻辑只在挂载后跑）
 * - 附件 URL → resolveAttachmentRequestPath 剥离 API_PREFIX 后
 *   axiosInstance.get(path, { responseType: 'blob' })（baseURL 补前缀与 host，
 *   拦截器自动带 token）→ createObjectURL → 渲染；401 走 axiosInstance 全局
 *   跳登录（既有拦截器行为），组件不特殊处理
 * - 非附件 URL → 原生 <img>（浏览器直连，无 token）
 * - 空 src → 占位（不渲染 <img src="">，浏览器会请求页面自身）
 */
export function AttachmentImage({ src, alt, node: _node, ...rest }: AttachmentImageProps) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isAttachment, setIsAttachment] = useState(false);
  const openPreview = useImagePreviewStore((s) => s.open);
  const t = useTranslations('attachments');

  /** 点击放大：open 当前显示 src（attachment 分支为 blob URL，外部图为原始 URL） */
  const handlePreviewClick = () => {
    const displaySrc = isAttachment && blobUrl ? blobUrl : src;
    if (displaySrc) openPreview(displaySrc, alt);
  };

  /** 键盘触发（role=button + tabIndex 语义，Enter/Space 与点击等价） */
  const handlePreviewKeyDown = (e: React.KeyboardEvent<HTMLImageElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlePreviewClick();
    }
  };

  useEffect(() => {
    // 空 src → 占位（不渲染 <img src="">）
    if (!src) {
      setState('error');
      return;
    }
    // 非附件 URL → 原生 <img>（绝不走 axios，防 token 出站）
    const requestPath = resolveAttachmentRequestPath(src);
    if (requestPath === null) {
      setIsAttachment(false);
      setState('loaded');
      return;
    }
    setIsAttachment(true);
    setState('loading');
    let cancelled = false;
    let refHeld = false;
    const cached = blobCache.get(src);
    if (cached) {
      // 缓存命中：复用 blob URL，refs+1（本组件持有引用）
      cached.refs += 1;
      refHeld = true;
      setBlobUrl(cached.blobUrl);
      setState('loaded');
    } else {
      axiosInstance
        .get(requestPath, { responseType: 'blob' })
        .then((res) => {
          if (cancelled) return;
          const existing = blobCache.get(src);
          if (existing) {
            // 并发竞态：另一组件已先建条目——复用，refs+1（本组件持有引用）
            existing.refs += 1;
            refHeld = true;
            setBlobUrl(existing.blobUrl);
            setState('loaded');
            return;
          }
          const url = URL.createObjectURL(res.data as Blob);
          blobCache.set(src, { blobUrl: url, refs: 1 });
          refHeld = true;
          setBlobUrl(url);
          setState('loaded');
        })
        .catch(() => {
          // 404 等 → i18n 裂图占位；401 由 axiosInstance 全局跳登录，不特殊处理
          if (!cancelled) setState('error');
        });
    }
    return () => {
      cancelled = true;
      if (refHeld) releaseRef(src);
    };
  }, [src]);

  if (!src || state === 'error') {
    return <BrokenImagePlaceholder alt={alt} />;
  }
  if (state === 'loading') {
    // SSR/挂载后加载前的占位骨架（水合安全：server 与首次 client 渲染一致）
    return (
      <span
        aria-hidden
        className="inline-flex h-24 w-48 max-w-full animate-pulse items-center justify-center rounded-md bg-muted/40"
      />
    );
  }
  if (isAttachment && blobUrl) {
    return (
      <img
        src={blobUrl}
        alt={alt ?? ''}
        {...rest}
        onClick={handlePreviewClick}
        onKeyDown={handlePreviewKeyDown}
        role="button"
        tabIndex={0}
        aria-label={alt || t('preview')}
        className={`cursor-zoom-in ${rest.className ?? ''}`}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt ?? ''}
      {...rest}
      onClick={handlePreviewClick}
      onKeyDown={handlePreviewKeyDown}
      role="button"
      tabIndex={0}
      aria-label={alt || t('preview')}
      className={`cursor-zoom-in ${rest.className ?? ''}`}
    />
  );
}

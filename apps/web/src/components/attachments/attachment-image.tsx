'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台媒体附件（MinIO）在 markdown 渲染中的鉴权图片加载器 + 视口门控
 *     （plan §0.2/§5.2；视口门控 plan 附件 P2 §③）
 *
 * [代码职责]
 *   - 识别附件内容 URL（精确前缀 /api/v1/attachments/ 或同源绝对 URL）→ 经
 *     axiosInstance（拦截器自动带 token）拉 blob → createObjectURL 渲染；
 *     其余 URL 一律原生 <img>，绝不走 axios（防 token 出站）
 *   - 模块级 blob 缓存（引用计数 + 条目级 defer 释放）：同图多处引用复用，
 *     可见性/预览 pin 共同计数，归零后 300ms revoke
 *   - IntersectionObserver 视口门控：滚出视口 defer 释放 blob + 占位，滚回重取
 *   - 预览 pin 的键空间契约：向外导出 acquireRef/releaseRef 供 image-preview-host
 *     按「附件内容 URL」持有/归还（见 [关键不变量]）
 *
 * [权威文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（消息渲染）— 附件图片加载与预览宿主
 *   - 补充: docs/api-definition.md §Attachments（读取链路全鉴权，拒绝 capability URL）
 *
 * [关键不变量]
 *   - src 识别钉死：精确前缀 startsWith('/api/v1/attachments/')，或同源绝对 URL
 *     （new URL(src, location.origin) 解析后 origin 相同且 pathname 前缀命中）；
 *     其余一律原生 <img>——https://evil.com/api/v1/attachments/x 这类外部 URL
 *     若走 axios 会把 Bearer token 带出站（安全红线）
 *   - 空 src → 占位，不渲染 <img src="">（浏览器会请求页面自身）
 *   - 缓存条目 = 模块级 Map<key, {blobUrl, refs, deferTimer}>；**refs 是统一持有者
 *     计数**（组件可见持有 + 预览 pin 共用 acquireRef/releaseRef），归零 **不立即
 *     revoke**，而是挂 300ms defer——快速往复滚动/预览开关在同一窗口内复用同一 blob；
 *     acquireRef 取消 pending defer（漏了这条 = 复用失效 + 抖动式重复 fetch）
 *   - **键空间契约**：blobCache 按「附件内容 URL」键控，而预览显示的是 blob URL——
 *     宿主必须 acquireRef(pinKey=附件内容 URL)，acquireRef(blobUrl) 必 miss（B-2 教训）
 *   - 视口门控只作用于附件分支（外部图交浏览器原生行为）；observer root = 最近的
 *     [data-scroll-container] 祖先，无则视口（root:null）——嵌套滚动容器必须显式标注，
 *     否则 rootMargin 预取被容器裁切 neuter；rootMargin 恒 400px
 *   - 在途加载完成时**聚合全部等待者**判定丢弃：任一等待者仍可见就建条目，全不可用
 *     才不建条目直接 revoke——少聚合一个就会误 revoke 别人的 blob；已存在条目
 *     （含被预览 pin 持有的）一律保留既有条目、丢弃本次产物（防顶掉别人持有的 blob）
 *   - 等待者全清（组件卸载/滚出）时摘除在途登记，让后续挂载重新发起
 *     （不挂在可能永不 settle 的旧请求上；代价 = 极窄竞态下重复一次请求）
 *   - error 为终态：同一 src 失败后滚入滚出不重试（避免 404 图被反复请求），src 变更才重试
 *   - 401 走 axiosInstance 全局跳登录（既有拦截器行为），组件不特殊处理
 *   - 请求路径必须剥离 API_PREFIX（axiosInstance.baseURL 已含前缀，双拼 404——
 *     主脑 Playwright 实测抓出，回归断言见测试）
 *   - 图片预览触发点：仅渲染态 <img> 可点击放大（open 传 pinKey = 附件内容 URL）；
 *     裂图占位/骨架/门控占位不触发；键盘可达（role=button + tabIndex + Enter/Space）
 *
 * [关联代码]
 *   - src/lib/markdown-components.tsx — markdownComponents 工厂 img → 本组件
 *   - src/lib/api.ts（axiosInstance）— 鉴权 blob 拉取通道
 *   - src/stores/image-preview.store.ts + src/components/attachments/image-preview-host.tsx
 *     — 全局图片预览（宿主 open 时 acquireRef(pinKey)、close/换图 releaseRef）
 *   - topic 消息容器 / docs 正文容器 / doc-editor 预览面板 — 显式 data-scroll-container
 *
 * [持久踩坑]
 *   - PIN-KEYSPACE（预览 pin 键空间）: store.src 是 blobUrl，blobCache 按附件 URL 键控，
 *     直接 acquireRef(blobUrl) 必 miss（pin 静默失效 → 预览裂图）。安全方向：pin 走
 *     独立第三参 pinKey=附件内容 URL。详情: plan 附件 P2 §③ / §0 arch M7 行
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
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
 * 滚动容器锚点属性（plan PM M1）：AttachmentImage 用 closest 找最近的滚动容器作
 * observer root。嵌套滚动容器（topic 消息区 / docs 正文 / doc-editor 预览面板）
 * 必须显式标注——root:null（视口）在嵌套滚动下预取会被容器裁切 neuter。
 */
const SCROLL_CONTAINER_ATTR = 'data-scroll-container';

/** 视口预取边距（plan §③ 钉死）：提前 400px 加载/保持，太小会闪骨架、太大门控失效 */
const VIEWPORT_PREFETCH_MARGIN = '400px';

/**
 * 条目级 defer 释放延迟（ms，plan §③ 钉死）：refs 归零后延迟 revoke，
 * 给「快速往复滚动」「预览快速开关」一个复用窗口；期间任何 acquireRef 取消 pending defer。
 */
const BLOB_RELEASE_DEFER_MS = 300;

/** blob 缓存条目（模块级，同图多处引用共享；refs 计数跨组件与预览 pin） */
interface BlobEntry {
  /** createObjectURL 产物（同图多处引用共享同一 URL） */
  blobUrl: string;
  /** 持有者计数：组件可见持有 + 预览 pin（同一计数器，见 [关键不变量]） */
  refs: number;
  /** pending 的 defer 释放计时器（null = 无）；refs 归零挂上，acquireRef 取消 */
  deferTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 模块级 blob 缓存（引用计数语义，plan §5.2 钉死 + P2 §③ defer 化）：
 * Map<key, BlobEntry>——key = 附件内容 URL；同图多处引用（同一消息/文档内重复出现）
 * 复用同一 blob URL，避免重复 fetch + 内存翻倍。refs 归零 → 300ms defer revoke
 * （defer 窗口内 acquireRef 取消释放，天然处理多组件引用与预览 pin）。
 */
const blobCache = new Map<string, BlobEntry>();

/** 等待者：该持有者此刻是否仍需这个 blob（可见性判定，异步回调即时读） */
type Waiter = () => boolean;

/** 在途加载登记：pending 级去重 + 完成时聚合判定丢弃（plan §③ 中间态规格） */
interface PendingLoad {
  promise: Promise<void>;
  waiters: Set<Waiter>;
}

/** 在途加载表（src → PendingLoad）：同 src 多组件并发只发一次请求 */
const inFlight = new Map<string, PendingLoad>();

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

/** 挂上 defer 释放（refs 归零后 300ms revoke + 删条目）；已有 pending 计时器则复用 */
function scheduleDeferredRelease(src: string, entry: BlobEntry): void {
  if (entry.deferTimer !== null) return;
  entry.deferTimer = setTimeout(() => {
    entry.deferTimer = null;
    URL.revokeObjectURL(entry.blobUrl);
    // 仅当条目未被后来者替换时删除（防误删同名新条目）
    if (blobCache.get(src) === entry) blobCache.delete(src);
  }, BLOB_RELEASE_DEFER_MS);
}

/**
 * 取得一个引用（组件进入视口 / 预览打开 / 缓存命中），并取消 pending defer。
 * 返回 false = 条目不存在（键空间不匹配或已释放）——调用方不得假定拿到 blob。
 *
 * 预览宿主必须传「附件内容 URL」而非 store.src（blob URL），见 [持久踩坑] PIN-KEYSPACE。
 */
export function acquireRef(key: string): boolean {
  const entry = blobCache.get(key);
  if (!entry) return false;
  if (entry.deferTimer !== null) {
    clearTimeout(entry.deferTimer);
    entry.deferTimer = null;
  }
  entry.refs += 1;
  return true;
}

/** 归还一个引用（滚出视口/卸载/预览关闭）：refs-1，归零 → defer 释放（300ms 后 revoke） */
export function releaseRef(key: string): void {
  const entry = blobCache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) scheduleDeferredRelease(key, entry);
}

/**
 * 加载 src 的 blob 并按需建条目（plan §③）：pending 级 in-flight 去重（同 src 多组件
 * 只发一次请求）+ 完成时**聚合全部等待者**的丢弃判定。
 *
 * 丢弃判定：全部等待者都已不可见/已离开（且无 pin 持有）→ 不建条目、直接 revoke——
 * 多等待者中只要还有一个可见/持有，就保留（少聚合一个 = 误 revoke 别人的 blob）。
 * 建条目后即挂 defer（等待者的 acquireRef 会取消它）；若无人接管则 300ms 回收。
 */
function loadBlob(src: string, requestPath: string, waiter: Waiter): Promise<void> {
  const pending = inFlight.get(src);
  if (pending) {
    // 在途去重：并入既有等待者集合（不重复发请求），共享同一 promise
    pending.waiters.add(waiter);
    return pending.promise;
  }
  const waiters = new Set<Waiter>([waiter]);
  const promise = axiosInstance.get(requestPath, { responseType: 'blob' }).then((res) => {
    const blobUrl = URL.createObjectURL(res.data as Blob);
    // 已有条目（罕见竞态：在途登记曾被摘除后重发，或本条已被 pin 场景接管）→
    // 保留既有条目，丢弃本次产物（否则会顶掉别人持有的 blob，泄漏一个 object URL）
    if (blobCache.has(src)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    if (![...waiters].some((live) => live())) {
      // 在途完成时已无任何可用等待者 → 不建缓存条目，直接 revoke 丢弃
      URL.revokeObjectURL(blobUrl);
      return;
    }
    const entry: BlobEntry = { blobUrl, refs: 0, deferTimer: null };
    blobCache.set(src, entry);
    scheduleDeferredRelease(src, entry);
  });
  const created: PendingLoad = { promise, waiters };
  inFlight.set(src, created);
  // 拒绝由各等待者的 catch 处理；此处只为清表 + 避免未处理拒绝（ESLint no-floating-promises）
  void promise
    .catch(() => {})
    .finally(() => {
      if (inFlight.get(src) === created) inFlight.delete(src);
    });
  return promise;
}

/**
 * 摘除等待者（组件卸载/滚出视口时）；等待者全清 → 同时丢弃在途登记。
 *
 * 丢弃理由：登记里只剩一个可能永不 settle 的请求时，后续挂载会一直挂在它上面
 * （图片永远不出现）；摘掉登记让新挂载重新发起。代价 = 极窄竞态下可能重复一次
 * 图片请求（旧请求的产物由 loadBlob 的丢弃判定 revoke），换取「重进视口可自愈」。
 */
function detachWaiter(src: string, waiter: Waiter): void {
  const pending = inFlight.get(src);
  if (!pending) return;
  pending.waiters.delete(waiter);
  if (pending.waiters.size === 0) inFlight.delete(src);
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

/**
 * 未加载过 / 加载中的骨架占位（水合安全：server 与首次 client 渲染一致）。
 * 同时是视口门控的观察节点（滚回视口据此重取），故必须透传 ref。
 */
const ImageSkeleton = forwardRef<HTMLSpanElement>(function ImageSkeleton(_props, ref) {
  return (
    <span
      ref={ref}
      aria-hidden
      className="inline-flex h-24 w-48 max-w-full animate-pulse items-center justify-center rounded-md bg-muted/40"
    />
  );
});

/** react-markdown img 覆盖会透传 node（hast 节点），必须剥离避免 DOM 警告 */
type AttachmentImageProps = React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };

/**
 * 附件鉴权图片（plan §0.2/§5.2 + P2 §③ 视口门控）：
 * - 'use client' + useEffect 挂载后加载：SSR 输出占位骨架（水合安全——
 *   server 与首次 client 渲染一致，加载逻辑只在挂载后跑）
 * - 视口门控：IntersectionObserver（root = 最近 [data-scroll-container] 祖先，
 *   无则视口；rootMargin 400px）——不可见不加载、不持有 blob；滚出 defer 释放 +
 *   占位（已加载过用 naturalWidth/Height 宽高比盒，未加载过用固定骨架）；滚回重取
 * - 附件 URL → resolveAttachmentRequestPath 剥离 API_PREFIX 后
 *   axiosInstance.get(path, { responseType: 'blob' })（baseURL 补前缀与 host，
 *   拦截器自动带 token）→ createObjectURL → 渲染；401 走 axiosInstance 全局
 *   跳登录（既有拦截器行为），组件不特殊处理
 * - 非附件 URL → 原生 <img>（浏览器直连，无 token；不做门控）
 * - 空 src → 占位（不渲染 <img src="">，浏览器会请求页面自身）
 */
export function AttachmentImage({ src, alt, node: _node, ...rest }: AttachmentImageProps) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isAttachment, setIsAttachment] = useState(false);
  // 无 IntersectionObserver 的环境（极老浏览器 / jsdom 测试）降级为常驻可见 = 不门控
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');
  // 已加载过的尺寸（滚出视口的宽高比占位）；按 src 关联，src 变更自动失效
  const [loadedSize, setLoadedSize] = useState<{
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const openPreview = useImagePreviewStore((s) => s.open);
  const t = useTranslations('attachments');

  /** 可见态的 ref 镜像：异步回调（在途完成/等待者判定）要读「此刻」而非闭包快照 */
  const inViewRef = useRef(inView);
  /** 已失败的 src（error 终态标记）：同一 src 滚入滚出不重试，src 变更才重试 */
  const failedSrcRef = useRef<string | null>(null);
  /** 当前 observer（节点替换/卸载时 disconnect 防泄漏） */
  const observerRef = useRef<IntersectionObserver | null>(null);

  /** 更新可见态：state 驱动加载 effect 重跑，ref 供异步回调即时判定 */
  const updateInView = useCallback((next: boolean) => {
    inViewRef.current = next;
    setInView(next);
  }, []);

  /**
   * 观察节点挂点（IntersectionObserver）：节点就位即建 observer 并 observe；
   * 节点替换（骨架 ↔ img）与卸载时先 disconnect。root = 最近的滚动容器祖先
   * （closest）；无则 null = 视口，行为与未标容器时一致。
   */
  const setObservedNode = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node) return;
      if (typeof IntersectionObserver === 'undefined') {
        updateInView(true);
        return;
      }
      const root = node.closest(`[${SCROLL_CONTAINER_ATTR}]`);
      const observer = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1];
          if (last) updateInView(last.isIntersecting);
        },
        { root, rootMargin: VIEWPORT_PREFETCH_MARGIN },
      );
      observerRef.current = observer;
      observer.observe(node);
    },
    [updateInView],
  );

  useEffect(() => {
    // 空 src → 占位（不渲染 <img src="">）
    if (!src) {
      setState('error');
      return;
    }
    // 非附件 URL → 原生 <img>（绝不走 axios，防 token 出站；不做视口门控）
    const requestPath = resolveAttachmentRequestPath(src);
    if (requestPath === null) {
      setIsAttachment(false);
      setState('loaded');
      return;
    }
    setIsAttachment(true);
    // error 终态：同一 src 已失败过 → 滚入滚出都直接占位，src 变更才重试
    if (failedSrcRef.current === src) {
      setState('error');
      return;
    }
    // 视口门控：不可见不加载、不持有；滚回时本 effect 因 inView 变化重跑 → re-acquire
    if (!inView) {
      setBlobUrl(null);
      setState('loading');
      return;
    }
    let cancelled = false;
    let held = false;
    /** 本组件的等待者身份（仅在途分支登记；丢弃判定聚合的一员） */
    let waiter: Waiter | null = null;
    const cached = blobCache.get(src);
    if (cached) {
      // 缓存命中（含 defer 窗口内的条目）：acquireRef 取消 pending defer 并 refs+1
      acquireRef(src);
      held = true;
      setBlobUrl(cached.blobUrl);
      setState('loaded');
    } else {
      setState('loading');
      setBlobUrl(null);
      // 可见才需要这个 blob：cancelled（卸载/滚出）后即视为不需要
      waiter = () => !cancelled && inViewRef.current;
      loadBlob(src, requestPath, waiter)
        .then(() => {
          // 在途完成时本组件已卸载/已不可见 → 不持有（条目由 defer 回收或被聚合判定丢弃）
          if (cancelled || !inViewRef.current) return;
          if (!acquireRef(src)) return;
          held = true;
          setBlobUrl(blobCache.get(src)?.blobUrl ?? null);
          setState('loaded');
        })
        .catch(() => {
          // 404 等 → i18n 裂图占位；401 由 axiosInstance 全局跳登录，不特殊处理
          if (cancelled) return;
          failedSrcRef.current = src;
          setState('error');
        });
    }
    return () => {
      cancelled = true;
      if (waiter) detachWaiter(src, waiter);
      if (held) releaseRef(src);
    };
  }, [src, inView]);

  /** 记录 naturalWidth/Height（滚出视口的宽高比占位用）；透传调用方 onLoad */
  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    rest.onLoad?.(e);
    const img = e.currentTarget;
    if (src && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setLoadedSize({ src, width: img.naturalWidth, height: img.naturalHeight });
    }
  };

  /**
   * 点击放大：open 传三参（plan §③ 键空间契约）——
   * displaySrc = 当前显示 URL（attachment 分支为 blob URL，外部图为原始 URL）；
   * pinKey = 附件内容 URL（与 blobCache 同键空间，宿主据此 acquireRef 持有 blob）；
   * 外部图无 blob → pinKey 留空（宿主不做引用计数）。
   */
  const handlePreviewClick = () => {
    const displaySrc = isAttachment && blobUrl ? blobUrl : src;
    if (displaySrc) openPreview(displaySrc, alt, isAttachment && src ? src : undefined);
  };

  /** 键盘触发（role=button + tabIndex 语义，Enter/Space 与点击等价） */
  const handlePreviewKeyDown = (e: React.KeyboardEvent<HTMLImageElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlePreviewClick();
    }
  };

  const size = loadedSize && loadedSize.src === src ? loadedSize : null;

  if (!src || state === 'error') {
    return <BrokenImagePlaceholder alt={alt} />;
  }
  // 视口门控占位（仅附件分支）：已加载过 → 宽高比盒（保持滚动高度，回滚不跳）；
  // 未加载过 → 固定骨架（首载位移为已登记残留，plan PM M3）
  if (isAttachment && !inView) {
    return size ? (
      <span
        ref={setObservedNode}
        aria-hidden
        className="inline-block max-w-full rounded-md bg-muted/40"
        style={{
          width: `min(${size.width}px, 100%)`,
          aspectRatio: `${size.width} / ${size.height}`,
        }}
      />
    ) : (
      <ImageSkeleton ref={setObservedNode} />
    );
  }
  if (state === 'loading') {
    return <ImageSkeleton ref={setObservedNode} />;
  }
  if (isAttachment && blobUrl) {
    return (
      <img
        ref={setObservedNode}
        src={blobUrl}
        alt={alt ?? ''}
        {...rest}
        onLoad={handleLoad}
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

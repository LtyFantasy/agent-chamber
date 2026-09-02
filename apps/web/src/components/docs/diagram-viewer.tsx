/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1 的 web 只读预览（D11：iframe srcDoc + sandbox 挂载）
 *
 * [代码职责]
 *   - web 阅读页中栏的图渲染组件：axios 拉 /docs/:id/diagram.html 快照 →
 *     iframe srcdoc（text/html 直出通道，不走统一信封，responseType:'text'）
 *   - 三态（loading/error/loaded）复用页面 Loading/EmptyState 模式
 *
 * [权威文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §5.2（安全论证 + R9）
 *   - 补充: 线上 docs/api-definition.md diagram 小节（read_doc）
 *
 * [关键不变量]
 *   - sandbox 授予 allow-scripts + allow-downloads，永不授予 allow-same-origin /
 *     allow-top-navigation / allow-modals / allow-popups（不透明源 = 无
 *     cookie/localStorage/父 DOM 访问；授予 allow-same-origin 即销毁不透明源语义）
 *   - allow-downloads 是导出必需（2026-09-01 导出修复）：模板 download() 依赖
 *     a[download] 触发保存，sandbox 默认拦截该属性（console 报 "Download is
 *     disallowed ... 'allow-downloads' is not set"）——不授则 SVG/PNG 下载静默失败。
 *   - allow="clipboard-write" 是复制必需（2026-09-02 复制修复）：Permissions-Policy
 *     委托——clipboard-write 默认 allowlist=self，sandbox iframe 不透明源不匹配
 *     被拦（复制图片静默失败；本地 A/B 实证：无 allow 报 "blocked because of a
 *     permissions policy"，有 allow 写入成功）。风险有界：只写不读剪贴板、
 *     需 document focus + 用户手势。
 *     威胁模型（DIAGRAM-WEB-005）：增量有界——下载内容为本页脚本生成的 blob 内存
 *     对象，不新增网络通道；利用前提是 IR 文本注入先绕过模板 esc() 转义（第一道
 *     防线），当前无已知绕过。
 *   - web 端 v1 只读（Q5 已拍板）：编辑入口在 page.tsx 对 diagram doc 隐藏，
 *     IR 写入只走 MCP/Agent upsert_diagram / patch_diagram
 *
 * [关联代码]
 *   - page.tsx 中栏分支 — diagram doc 挂本组件、右栏图信息卡（doc.diagram 摘要）
 *   - lib/api.ts#getDiagramHtml — 快照拉取通道（text/html）
 *   - 后端 GET /docs/:id/diagram.html — CSP/nosniff 直出（纵深防御第二道）
 *
 * [持久踩坑]
 *   - DIAGRAM-WEB-001(srcdoc 来源): iframe 无法携带 Authorization/JWT 头，
 *     快照必须经 axios 拉到前端塞 srcDoc，禁止 <iframe src="/api/v1/docs/..."> 直挂。
 *   - DIAGRAM-WEB-002(sandbox 授权): 加 allow-same-origin 会让 srcdoc 获得父源，
 *     localStorage 防御（template.html try/catch）只是兜底，不是豁免。
 *   - DIAGRAM-WEB-003(快照整形): srcdoc 是不透明源——无 URL 参数、localStorage
 *     抛 SecurityError，模板三级主题解析（URL → localStorage → OS）必然落到 OS
 *     prefers-color-scheme，OS 浅色用户会在深色 app 里看到浅色图。修复 =
 *     塞 srcDoc 前注入 matchMedia 桩钉死 dark + 设 data-embed 进纯画布模式
 *     （见 prepareSnapshotForEmbed），禁止改授 allow-same-origin 来"让
 *     localStorage 能用"（击穿 DIAGRAM-WEB-002）。
 *   - DIAGRAM-WEB-004(文案语言): viewer 文案是渲染期按 IR meta.locale 烘焙进
 *     快照的（模板 i18n 节点 + SVG 文本），前端运行时换不了——语言跟随靠
 *     queryKey 带 locale + 后端 ?lang= 读时重渲染（不落库，失败降级存储快照）。
 *     禁止尝试在前端 patch 快照文本换语言（SVG 烘焙文本无 key 可循）。
 *   - DIAGRAM-WEB-005(allow-downloads 威胁模型): 授予 allow-downloads 的增量
 *     风险 = 下载内容为本页脚本生成的 blob 内存对象（无新增网络通道）；IR 文本
 *     注入经模板 esc() 转义为第一道防线，sandbox 是第二道；srcdoc 不透明源无
 *     CSP 不封网是既有状态（web 应用本身无 CSP 头），非本次引入。禁止为"更安全"
 *     移除 allow-downloads（导出会静默失败），也禁止加 allow-modals 等其余授权。
 *   - DIAGRAM-WEB-006(clipboard-write 委托): 剪贴板写入三要素齐备才成功——
 *     Permissions-Policy allow 委托 + document focus + 用户手势。缺 allow= 时
 *     模板 canCopyImage() 仍为 true（API 面探测探不出权限策略），写入才
 *     reject（copyFailed toast）——禁止删 allow="clipboard-write"，
 *     也禁止加 clipboard-read（读剪贴板是隐私面，无需求）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Maximize, Minimize } from 'lucide-react';
import { Api } from '@/lib/api';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';

interface DiagramViewerProps {
  /** 文档 ID（docType='diagram' 的 doc；非 diagram doc 由 page.tsx 分支保证不挂本组件） */
  docId: string;
}

/**
 * web 预览快照整形（DIAGRAM-WEB-003）：主题钉死 dark + embed 纯画布模式。
 *
 * srcdoc iframe 是不透明源：无 URL 参数可读、localStorage 访问抛 SecurityError，
 * 模板内主题三级解析（?theme= → localStorage → OS prefers-color-scheme）必然
 * 落到 OS——OS 浅色用户会在深色 app 里看到浅色图。修复在塞 srcDoc 前往 <head>
 * 注入 matchMedia 桩：仅拦截 '(prefers-color-scheme: light)' 查询返回
 * matches:false（其余查询透传原生实现），三级解析稳定落 dark；工具栏手动
 * 切换不受影响（toggle 只读写 data-theme 属性，不依赖 matchMedia）。
 *
 * embed 模式（2026-08-30 用户拍板"纯画布 + 保留工具栏"）：同一注入脚本再设置
 * data-embed="true"，模板内建 embed CSS 隐藏 header/guided-views/cards/diagram-nav
 * 等 viewer chrome（等价于模板 URL 参数 embed=1 的效果）；再用注入 <style> 把
 * 工具栏捞回（模板 embed 规则带 !important，覆盖也必须 !important），并隐藏
 * btn-present——present 模式的 CSS 全部以 :not([data-embed]) 为门槛，embed 下
 * 该按钮点了无效，留着是死按钮。
 *
 * 选注入方案而非模板改造：对存量快照（旧渲染产物）同样生效，且模板升级零维护。
 *
 * @param html 后端 /docs/:id/diagram.html 返回的自包含快照
 * @returns 注入桩后的 HTML；找不到 <head> 时原样返回（防御非模板来源快照）
 */
function prepareSnapshotForEmbed(html: string): string {
  const marker = '<head>';
  // 桩对象只需覆盖模板用到的 matchMedia 面：matches / addEventListener / addListener
  // （模板对媒体监听全程 try/catch 兜底，缺 onchange 等属性无副作用）
  const pin =
    '<script>(function(){var orig=window.matchMedia.bind(window);' +
    "window.matchMedia=function(q){return q==='(prefers-color-scheme: light)'" +
    '?{matches:false,media:q,addEventListener:function(){},removeEventListener:function(){},addListener:function(){},removeListener:function(){}}' +
    ':orig(q);};' +
    "document.documentElement.setAttribute('data-embed','true');})();</script>" +
    // 注入 <style> 在模板大 <style> 之前，同优先级 !important 后声明者胜——
    // 故捞回规则加 body 提权重（0,2,3 > 模板 0,2,2），与声明顺序无关
    '<style>html[data-embed="true"] body .toolbar{display:flex !important;}' +
    'html[data-embed="true"] #btn-present{display:none !important;}' +
    // 捞回右下角缩放条（zoom out/reset/in 与拖拽平移是 canvas 基础交互）；
    // 同条的 route/radar/lens/finder/guide 按钮面板被 embed 隐藏，留着是死按钮 → 藏掉
    'html[data-embed="true"] body .diagram-nav{display:inline-flex !important;}' +
    'html[data-embed="true"] body .diagram-nav > button:not([data-view]){display:none !important;}</style>';
  const idx = html.indexOf(marker);
  return idx === -1
    ? html
    : html.slice(0, idx + marker.length) + pin + html.slice(idx + marker.length);
}

/**
 * 图文档只读预览（Diagram IR v1）：拉 HTML 快照 → iframe srcDoc 挂载。
 *
 * 安全模型（plan §5.2）：快照自包含（内联 CSS/JS/SVG，无网络请求）；sandbox
 * 授予 allow-scripts + allow-downloads 保留 viewer 交互（搜索/聚焦/追踪/导出）
 * 同时给不透明源；IR 文本注入 HTML 已经 vendor esc() 转义，sandbox 是第二道防线。
 * allow-downloads 是导出必需（a[download] 触发保存，sandbox 默认拦截），
 * 威胁模型见文件头 DIAGRAM-WEB-005。
 * 高度语义：wrapper flex-1 撑满中栏剩余高度（page.tsx diagram 分支给
 * contentRef 上 flex h-full flex-col 链），min-h-[560px] 兜底——窗口不足时
 * main overflow-y-auto 滚动；全屏下 flex 上下文消失，h-full（fullscreen
 * 元素 containing block = 视口）接力保证撑满。
 * 全屏：父侧 Fullscreen API（wrapper requestFullscreen）——iframe 是不透明源，
 * 模板 Present 舞台模式又在 embed 下被 CSS 门槛禁用，故全屏由父页面实现；
 * 全屏后 iframe 内缩放条/工具栏照常可用（交互都在不透明源内部）。
 */
function DiagramViewer({ docId }: DiagramViewerProps) {
  const t = useTranslations('docs.diagram');
  const tGlobal = useTranslations();
  // 图内 viewer 文案跟随 app 语言（DIAGRAM-WEB-004）：viewer 文案是渲染期烘焙进
  // 快照的，locale 进 queryKey——切语言（cookie + router.refresh）即自动重取，
  // 后端 lang 与存储 IR 语言不一致时读时重渲染（不落库；失败降级存储快照）
  const locale = useLocale();
  // 父侧全屏状态（fullscreenchange 跟踪，Esc 退出也能正确复位图标）
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  /** 全屏开关：父侧请求/退出（iframe 无 allowfullscreen，子文档自身不可发起） */
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void wrapperRef.current?.requestFullscreen();
    }
  };
  const {
    data: html,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['docs', 'diagram-html', docId, locale],
    // 快照整形后再入缓存（DIAGRAM-WEB-003）：渲染侧拿到的即是可直挂 srcDoc 的产物
    queryFn: () => Api.docs.getDiagramHtml(docId, locale).then(prepareSnapshotForEmbed),
  });

  // loading 态：复用页面 Loading（min-h 撑住版面，避免挂载瞬间高度塌陷）
  if (isLoading) {
    return <Loading className="min-h-[560px]" />;
  }

  // error 态：404/409（无快照）/网络失败统一走 EmptyState + 重试（复用页面错误态模式）
  if (isError || !html) {
    return (
      <EmptyState
        title={t('loadFailed')}
        description={t('loadFailedDesc')}
        action={
          <Button variant="outline" onClick={() => void refetch()}>
            {tGlobal('common.retry')}
          </Button>
        }
      />
    );
  }

  // loaded 态：srcdoc 挂载（referrerPolicy 兜底防 Referer 泄漏；border-0 交还页面边框）。
  // 全屏按钮浮在左下角（iframe 内工具栏在右上、缩放条在右下，避开重叠）；
  // 全屏容器必须自带背景（fullscreen 默认背景透明）
  return (
    <div ref={wrapperRef} className="relative h-full min-h-[560px] flex-1 bg-background">
      <iframe
        title={t('viewerTitle')}
        sandbox="allow-scripts allow-downloads"
        allow="clipboard-write"
        srcDoc={html}
        referrerPolicy="no-referrer"
        className="h-full min-h-[560px] w-full rounded-md border-0"
      />
      <button
        type="button"
        onClick={toggleFullscreen}
        title={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
        aria-label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
        className="bg-background/80 text-muted-foreground hover:text-foreground hover:bg-accent absolute bottom-3 left-3 z-10 rounded-md border p-1.5 backdrop-blur transition-colors"
      >
        {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
      </button>
    </div>
  );
}

export { DiagramViewer };

'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆只读视图（/memory）：项目切换 + 三 Tab 卡片墙 + 语义/字面双模式搜索
 *
 * [代码职责]
 *   - 把**账本**（列表读面，不依赖引擎）与**召回**（引擎动词，有副作用）两条动线放在
 *     同一页面上，并保证两者互不拖累：引擎挂了卡片墙照常，召回空了账本照常
 *   - 页头带**关系图入口**（`/memory/graph?project=<当前项目>`）：恒带 project id，
 *     ≥xl 才可点（<xl 渲染成说明态）——图页是纯引擎面，窄屏没有可用形态
 *   - 状态分层（plan §1 D11）：`project/tab/v` 走 `router.push`（位置语义，后退有意义）；
 *     `q/mode/page` 走 `router.replace`（瞬时浏览态，可刷新恢复/分享）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §3/§4/§5（工具类红线 / 组件基线 / 动效规范）
 *   - 实现蓝本: Memory web 二期 plan v2.1 §1 决策表（D6/D7/D9/D11）+ §5 四十八条 UX 清单
 *   - 合同源: apps/backend/src/modules/memory/dto/memory-contract.ts（响应形状）
 *
 * [关键不变量]
 *   - **召回是 `useQuery({enabled:false, retry:false, refetchOnWindowFocus:false})` +
 *     提交时手动 `refetch()`**（D7）。禁用 mutation 的理由是全局 `mutations.retry=1`
 *     （`app/providers.tsx`）会**重发**这个有副作用的 POST——烧配额 + 重复结果。
 *     `contextEpoch` 入 payload **不入 queryKey**（入 key 则缓存永远打不中，
 *     "返回详情再回来结果仍在"就废了）。取值走 `memoryContextEpoch()`（秒级相对纪元）——
 *     **不是** `Date.now()`：引擎硬上限 1e9，毫秒与 Unix 秒都超（详见 lib/memory 注释）。
 *   - **URL 恢复的 `q` 只回填输入框，永不自动执行**：分享一条链接不该替接收者烧一次配额。
 *     恢复态与"刚提交"用 `submitToken` 区分（token=0 表示本会话没提交过）。
 *   - **列表类 query 显式 `refetchOnWindowFocus:false + retry:1`**（第 41 条）：全局默认
 *     `true/2` 会让每次切回标签页变成 6 路全表扫描 + 计数闪动。
 *   - **切项目 = 清召回结果（含丢弃在途响应）+ 回第 1 页 + 回默认 tab**（第 37 条）；
 *     queryKey 含 projectId，结果态按项目键控。
 *   - **Tab 归属互斥按 `status` 判**：「提名记录」只收 `status=active`，`withdrawn` 行
 *     即使 formationState=failed 也只进「已失效」（DB 不变量 withdrawn⇒记忆 id 为空）。
 *   - **`total` 是裁剪前全量行数**（服务端内存分页）：它既是 tab 计数的权威来源，
 *     也是"这条路的 100 条是否被截断"的判据 —— 截断必须显式写出来，不许静默少画。
 *
 * [关联代码]
 *   - ../../lib/memory.ts — 类型镜像 / 参数装配 / 展示映射 / 错误分叉的唯一实现
 *   - ../../components/memory/* — 卡片 / 锁态行 / 元数据表 / 搜索条 / 引擎灯与横幅
 *   - [id]/page.tsx — 详情页（D8 串链与 `?v=` 寻址）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，逐条核对 §5 清单（本页是 1-26 条的主要落点）
 *   □ 新增 query 必须显式写 retry / refetchOnWindowFocus（不要吃全局默认）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, MotionConfig } from 'framer-motion';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import {
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  type MemoryFormationState,
} from '@agent-chamber/shared';
import { Api } from '@/lib/api';
import { errorMessageOf } from '@/lib/error-message';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MemoryCard, MemoryLockedRow, MemoryMetadataList } from '@/components/memory/memory-card';
import { MemorySearchBar } from '@/components/memory/memory-search-bar';
import { MemoryProjectCreateDialog } from '@/components/memory/memory-project-create-dialog';
import { MemoryEngineBanner, MemoryEngineLight } from '@/components/memory/engine-status';
import { MemoryCategoryChip, MemoryDerivationBadge } from '@/components/memory/memory-badges';
import { fadeSlideUp, staggerContainer } from '@/lib/animations';
import { toast } from '@/lib/notify';
import {
  MEMORY_DEFAULT_PAGE_SIZE,
  MEMORY_INACTIVE_STATUSES,
  MEMORY_MAX_PAGE_SIZE,
  MEMORY_NOMINATIONS_FORMATION_STATES,
  MEMORY_RECALL_MAX_ITEMS,
  MEMORY_SEARCH_MODE,
  MEMORY_SEARCH_MODES,
  MEMORY_TAB,
  MEMORY_TABS,
  memoryContextEpoch,
  memoryContextIdentity,
  memoryEngineAvailable,
  memoryErrorKind,
  memoryIsMetadataProjection,
  memoryLiteralMatch,
  memoryMergeByCreatedAt,
  memoryPagination,
  memoryProvisioningAvailable,
  memoryRecallEmptyKind,
  memoryRecallHasItems,
  memoryRecallItemScore,
  memoryRecallScoresInformative,
  memoryTrustDebugRows,
  memoryUnavailableReasonKind,
  memoryUnavailableReasonOf,
  type MemoryNominationDto,
  type MemoryProjectDto,
  type MemoryRecallResponse,
  type MemorySearchMode,
  type MemoryTab,
} from '@/lib/memory';
import { cn, parseEnumParam, parseUuidParam } from '@/lib/utils';

/** `q` 写入 URL 的防抖窗口（ms）：与仓内其它搜索面同取 300（避免逐字符触发路由更新） */
const MEMORY_URL_Q_DEBOUNCE_MS = 300;

export default function MemoryPage() {
  const t = useTranslations('memory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);

  // ── URL 初值（**一律白名单校验**：脏参数不能把整页打进错误态）──────────────────
  const urlProject = parseUuidParam(searchParams.get('project'));
  const urlTab = parseEnumParam(searchParams.get('tab'), MEMORY_TABS) ?? MEMORY_TAB.COMMITTED;
  const urlMode =
    parseEnumParam(searchParams.get('mode'), MEMORY_SEARCH_MODES) ?? MEMORY_SEARCH_MODE.SEMANTIC;
  const urlQuery = searchParams.get('q') ?? '';
  const urlPage = parsePositiveIntParam(searchParams.get('page')) ?? 1;

  const [projectId, setProjectId] = useState<string | null>(urlProject);
  const [tab, setTab] = useState<MemoryTab>(urlTab);
  const [mode, setMode] = useState<MemorySearchMode>(urlMode);
  /** 输入框内容（URL 恢复的 q 只到这里） */
  const [input, setInput] = useState(urlQuery);
  /** 已提交的语义查询词（**进 queryKey**；空串 = 本会话没有语义结果可展示） */
  const [submitted, setSubmitted] = useState(urlQuery.trim());
  /** 提交计数器：>0 才触发手动 refetch（URL 恢复时保持 0 ⇒ 永不自动执行召回） */
  const [submitToken, setSubmitToken] = useState(0);
  const [page, setPage] = useState(urlPage);
  /** 「提名记录」子标签 chip 选中态（null = 全部六态；chip 本身即真筛选器） */
  const [formationFilter, setFormationFilter] = useState<MemoryFormationState | null>(null);
  /** 召回返回 403（无内容读权限）后**常驻**的说明态（第 39 条：禁用必须可见可读） */
  const [recallForbidden, setRecallForbidden] = useState(false);
  /** 项目创建 Dialog 开关（入口双位：工具栏 + 空态 CTA） */
  const [createOpen, setCreateOpen] = useState(false);

  /**
   * 写入时刻的 searchParams（`updateUrl` 的基底，见该函数注释）；另配一份 URL 快照
   * 供"M5 URL→state 同步"判断 URL 侧是否真的变了。
   *
   * 用 effect 更新而不是渲染期赋值：渲染期写 ref 在并发渲染下可能保留一个被丢弃的
   * 渲染的值（React 明确不建议）；effect 在本帧提交后写入，点击/定时器都在其后执行。
   */
  const searchParamsRef = useRef(searchParams);
  const lastUrlRef = useRef({
    tab: urlTab,
    mode: urlMode,
    page: urlPage,
    project: urlProject,
    query: urlQuery,
  });
  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);

  // ── 项目列表（含 engineAvailability，横幅免额外请求）─────────────────────────
  const projectsQuery = useQuery({
    queryKey: ['memory', 'projects'],
    queryFn: () => Api.memory.projects({ page: 1, pageSize: MEMORY_MAX_PAGE_SIZE }),
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const projects = useMemo(() => projectsQuery.data?.items ?? [], [projectsQuery.data]);
  /**
   * 部署级自助开通开关（**三态读法**，N2：`undefined`/`false` 一律按不可用——默认不承诺）。
   * 缺失（旧后端 / 名单未取到）时按不可用渲染，绝不把"没拿到"当"可用"。
   */
  const provisioningAvailable = memoryProvisioningAvailable(
    projectsQuery.data?.provisioningAvailable,
  );
  /**
   * 生效项目：显式选择优先；未选择（URL 无 `?project=`）时取列表首项。
   * URL 指定的项目**不在列表里**时不静默回退——照旧请求，让服务端裁决
   * （403/404 会走项目级错误态，比"悄悄换成另一个项目"诚实）。
   */
  const activeProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? (projectId ? null : (projects[0] ?? null)),
    [projects, projectId],
  );
  const activeProjectId = activeProject?.id ?? projectId;

  /** 引擎可用性（项目投影里恒带；缺失按"可用"处理——不谎报故障） */
  const engineAvailability = activeProject?.engineAvailability;

  /**
   * searchParams 回写工具（D11 分层）。
   *
   * ⚠️ **基底必须在写入时刻读取**（`searchParamsRef`），不能闭包捕获渲染时的 `searchParams`：
   * `q` 的写入是 300ms 防抖后执行的，若期间发生 `selectProject`/`selectTab` 的 push，
   * 用旧快照当基底会把那次 push 的结果盖掉（新 tab 被抹回旧 tab）。
   *
   * @param next - 要合并进 URL 的键值（`null` = 删除该键）
   * @param replace - true = 瞬时浏览态（q/mode/page）；false = 位置语义（project/tab）
   */
  const updateUrl = (next: Record<string, string | null>, replace: boolean) => {
    const params = new URLSearchParams(Array.from(searchParamsRef.current.entries()));
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };

  /**
   * URL → state 单向同步（D11 的 push 语义要兑现在"后退真的能回上一个视图"上）。
   *
   * 触发条件刻意窄：**只在 URL 侧的值发生变化时**投影回 state（用 `lastUrlRef` 记上一次看到的
   * URL 快照）。若不加这道守卫，会踩两个坑：
   * ① 用户打字期间 state 领先于 URL（`q` 有 300ms 防抖）→ 无守卫的同步会把输入框清空；
   * ② 自己写入 URL 后立刻回灌 → 与 `q` 的防抖写入互相拉扯。
   *
   * ⚠️ 安全属性（与初次挂载完全一致）：同步恢复的 `q` 只回填 `input`/`submitted` 展示态，
   * `submitToken` 归 0 ⇒ **永不自动执行召回**（后退到一条带 q 的历史 ≠ 重新烧一次配额）。
   * 只有**外部导航**（后退/前进/外链）才能改 `submitted`：判据 = URL 的 q 与当前输入框
   * 不一致（自己防抖写进去的 q 恒等于输入框内容，不算外部）。
   */
  useEffect(() => {
    const last = lastUrlRef.current;
    const navigated =
      last.tab !== urlTab ||
      last.mode !== urlMode ||
      last.page !== urlPage ||
      last.project !== urlProject ||
      last.query !== urlQuery;
    lastUrlRef.current = {
      tab: urlTab,
      mode: urlMode,
      page: urlPage,
      project: urlProject,
      query: urlQuery,
    };
    if (!navigated) return;

    setTab(urlTab);
    setMode(urlMode);
    setPage(urlPage);
    // project：URL 里**显式给了**才跟随（URL 无 project 时保留"默认取列表首项"的语义，
    // 不把解析结果反向写死成 state，否则切换语言/刷新会漂移）
    if (urlProject) setProjectId(urlProject);
    /**
     * q：**两个条件同时成立**才回灌 ——
     * ① `last.query !== urlQuery`：URL 里的 q 本身变了（外部导航的特征）；
     * ② `urlQuery !== input`：新值确实不是输入框现在的内容（排除"我自己防抖写进去的"）。
     *
     * 少掉①会把"我自己写的路由把 q 带丢了"（如切 Tab 时 q 还没防抖落地）误判成外部导航，
     * 反手把用户正在打的字清空；少掉②会把"打字 → 防抖写 q → URL 变了"当成外部导航，
     * 让 `submitted` 跟着变、语义结果区在没点搜索时就自己跳出来。
     * 归 0 的 `submitToken` 是安全底线：**后退到一条带 q 的历史 ≠ 重新烧一次配额**。
     */
    if (last.query !== urlQuery && urlQuery !== input) {
      setInput(urlQuery);
      setSubmitted(urlQuery.trim());
      setSubmitToken(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 URL 侧变化时投影；state 入 deps 会让打字触发回灌
  }, [urlTab, urlMode, urlPage, urlProject, urlQuery]);

  // ── 三 Tab 的账本查询 ────────────────────────────────────────────────────────
  // 「已记住」：server 过滤（status=active + formationState=committed）+ 传统分页器
  const committedQuery = useQuery({
    queryKey: ['memory', 'nominations', 'committed', activeProjectId, page],
    queryFn: () =>
      Api.memory.nominations(activeProjectId as string, {
        status: MEMORY_NOMINATION_STATUS.ACTIVE,
        formationState: MEMORY_FORMATION_STATE.COMMITTED,
        page,
        pageSize: MEMORY_DEFAULT_PAGE_SIZE,
      }),
    enabled: !!activeProjectId,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  /** 「提名记录」：6 路并行（每路各自 total 即子标签计数；单路失败只影响该路子标签） */
  const formationQueries = useQueries({
    queries: MEMORY_NOMINATIONS_FORMATION_STATES.map((state) => ({
      queryKey: ['memory', 'nominations', 'formation', activeProjectId, state],
      queryFn: () =>
        Api.memory.nominations(activeProjectId as string, {
          status: MEMORY_NOMINATION_STATUS.ACTIVE,
          formationState: state,
          page: 1,
          pageSize: MEMORY_MAX_PAGE_SIZE,
        }),
      enabled: !!activeProjectId,
      refetchOnWindowFocus: false,
      retry: 1,
    })),
  });

  /** 「已失效」：2 路并行（superseded / withdrawn；按 `status` 而非 formationState 归属） */
  const inactiveQueries = useQueries({
    queries: MEMORY_INACTIVE_STATUSES.map((status) => ({
      queryKey: ['memory', 'nominations', 'inactive', activeProjectId, status],
      queryFn: () =>
        Api.memory.nominations(activeProjectId as string, {
          status,
          page: 1,
          pageSize: MEMORY_MAX_PAGE_SIZE,
        }),
      enabled: !!activeProjectId,
      refetchOnWindowFocus: false,
      retry: 1,
    })),
  });

  /** 提名记录合并集（createdAt DESC；各路未就绪的自动跳过） */
  const nominationRows = useMemo(
    () => memoryMergeByCreatedAt(formationQueries.map((q) => q.data?.items ?? [])),
    [formationQueries],
  );
  /** 已失效合并集 */
  const inactiveRows = useMemo(
    () => memoryMergeByCreatedAt(inactiveQueries.map((q) => q.data?.items ?? [])),
    [inactiveQueries],
  );

  /**
   * Tab 计数：committed 取自身 total；另两 Tab 取各路 total 之和（**裁剪前全量**）。
   *
   * ⚠️ 某一路请求失败时，那个 Tab 的计数是**下界**（失败路贡献 0）——所以"计数与列表条数
   * 不符"在失败态下是预期现象，不是数据错乱；Tab 内会另出显式失败提示（第 21 条）。
   */
  const committedTotal = committedQuery.data?.total ?? 0;
  const nominationsTotal = formationQueries.reduce((sum, q) => sum + (q.data?.total ?? 0), 0);
  const inactiveTotal = inactiveQueries.reduce((sum, q) => sum + (q.data?.total ?? 0), 0);

  // ── 语义召回（D7：enabled:false + 手动 refetch；结果按 projectId+query 键控）────────
  /** 最近一次提交的（项目, 查询词）：queryFn 从 ref 读，避免闭包读到旧的渲染值 */
  const submittedRef = useRef<{ projectId: string; query: string } | null>(null);
  const recallQuery = useQuery({
    queryKey: ['memory', 'recall', activeProjectId ?? '', submitted],
    queryFn: () => {
      const pending = submittedRef.current;
      if (!pending) throw new Error('recall submitted without a pending query');
      return Api.memory.recall(pending.projectId, {
        query: pending.query,
        contextIdentity: memoryContextIdentity(user?.id, pending.projectId),
        // epoch 每次提交取新值（**入 payload 不入 key**）；同词重搜可复现但不会命中缓存。
        // 取值 = memoryContextEpoch()（秒级相对纪元，恒在引擎 0..1e9 区间内）——
        // 这里**禁止**改回 Date.now()：毫秒 ≈1.76e12 / Unix 秒 ≈1.76e9 都会被后端 DTO
        // @Max 当场 400（引擎运行时实证上限）。测试里有一条 ≤1e9 断言守着这一点。
        contextEpoch: memoryContextEpoch(),
        maxItems: MEMORY_RECALL_MAX_ITEMS,
      });
    },
    // 三个禁用项缺一不可：enabled:false（不自动打）、retry:false（不重发有副作用的 POST）、
    // refetchOnWindowFocus:false（切回标签页不该再烧一次配额）
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
  });

  /**
   * 提交后的手动触发（key 已随 `submitted` 更新，故 refetch 打在**新 key** 上）。
   *
   * 用 effect 而不是在点击 handler 里直接调：handler 里 `refetch()` 时 observer 还挂在
   * 旧的 queryKey 上，结果会落进旧 key 的缓存槽（界面读的是新 key ⇒ 永远转圈）。
   */
  useEffect(() => {
    if (submitToken === 0) return;
    void recallQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch 每次渲染重建身份，入 deps 会自触发重查
  }, [submitToken]);

  /** 语义结果是否正在展示（第 12 条：此时 Tab 栏与卡片墙让位） */
  const showSemanticResults = mode === MEMORY_SEARCH_MODE.SEMANTIC && submitted !== '';

  /**
   * 召回 403：置常驻禁用态（第 39 条）。
   *
   * 本 effect 的主职责是**搜索禁用兜底**——403 是服务端对"无内容读权限"的权威判定，
   * 即使项目投影里的 `canReadContent` 因时序/缓存还是 true，这一步也必须把搜索关掉。
   *
   * （原"仅元数据"观测集已随 A3 改成**数据驱动**：项目投影自带 `canReadContent`，
   * 观测集"只增不减"的旧 bug 被天然修掉；403 分支本身不可删。）
   */
  const recallPermissionDenied = memoryErrorKind(recallQuery.error).permissionDenied;
  useEffect(() => {
    if (!recallPermissionDenied) return;
    setRecallForbidden(true);
  }, [recallPermissionDenied]);

  /** runtime 503 的 reason（与 engineAvailability.reason 共用同一套文案映射，第 18/25 条） */
  const runtimeUnavailableReason =
    memoryUnavailableReasonOf(committedQuery.error) ??
    memoryUnavailableReasonOf(formationQueries.find((q) => q.error)?.error) ??
    // 另两 Tab 也可能先撞上引擎不可用（六路/两路里任何一路都算），漏掉会把"引擎挂了"
    // 显示成"本地数据请求失败"，用户按重试也修不好
    memoryUnavailableReasonOf(inactiveQueries.find((q) => q.error)?.error) ??
    memoryUnavailableReasonOf(recallQuery.error);

  const engineOk = memoryEngineAvailable(engineAvailability) && !runtimeUnavailableReason;
  /**
   * 内容面不可读（A3）：`canReadContent === false` 是**项目级**数据驱动判定（预置禁用），
   * `recallForbidden` 是 403 通道的兜底（服务端权威）。两者任一成立都禁用搜索。
   */
  const contentReadDenied = recallForbidden || activeProject?.canReadContent === false;
  const searchDisabled = !activeProjectId || !engineOk || contentReadDenied;

  // ── 当前 Tab 的行（字面过滤与降级判定都基于它）────────────────────────────────
  const activeRows = useMemo((): MemoryNominationDto[] => {
    if (tab === MEMORY_TAB.COMMITTED) return committedQuery.data?.items ?? [];
    if (tab === MEMORY_TAB.NOMINATIONS) return nominationRows;
    return inactiveRows;
  }, [tab, committedQuery.data, nominationRows, inactiveRows]);

  /**
   * 整片降级判定：已加载 ≥1 行且**全部**是 metadata 投影。
   *
   * 逐行降级（混合）不走这里，而是让那些行各自渲染紧凑锁态行（第 19 条）。
   */
  const allMetadata =
    activeRows.length > 0 && activeRows.every((row) => memoryIsMetadataProjection(row));

  /** 字面过滤（纯客户端、零配额；第 11 条里的 N 与这里的候选集同源） */
  const literalActive = mode === MEMORY_SEARCH_MODE.LITERAL && input.trim().length > 0;
  const literalRows = useMemo(
    () => (literalActive ? activeRows.filter((row) => memoryLiteralMatch(row, input)) : activeRows),
    [literalActive, activeRows, input],
  );

  /** 子标签过滤（六态 chip 即真筛选器；字面过滤叠加其上） */
  const visibleRows = useMemo(() => {
    const base = literalActive ? literalRows : activeRows;
    if (tab !== MEMORY_TAB.NOMINATIONS || !formationFilter) return base;
    return base.filter((row) => row.formationState === formationFilter);
  }, [tab, formationFilter, literalActive, literalRows, activeRows]);

  // ── 交互：切项目 / 切 Tab / 提交 ─────────────────────────────────────────────
  /**
   * 切项目（第 37 条）：清召回结果（丢弃在途响应）+ 回第 1 页 + 回默认 tab。
   *
   * `cancelQueries` 是"丢弃在途响应"的实现：旧项目的召回请求被 abort，其结果既不会
   * 落缓存也不会到达界面（结果态本就按 projectId 键控，这是第二道保险）。
   */
  const selectProject = (nextId: string) => {
    if (nextId === activeProjectId) return;
    if (activeProjectId) {
      void queryClient.cancelQueries({ queryKey: ['memory', 'recall', activeProjectId] });
    }
    submittedRef.current = null;
    setSubmitted('');
    setSubmitToken(0);
    setRecallForbidden(false);
    setPage(1);
    setTab(MEMORY_TAB.COMMITTED);
    setFormationFilter(null);
    setProjectId(nextId);
    /**
     * project/tab 是位置语义 ⇒ push（后退能回上一个项目的视图）；page 从 URL 移除。
     *
     * ⚠️ `q` 必须**一并清掉**：召回结果按 `(projectId, query)` 键控，留着上一个项目的
     * 查询词会让"换项目后刷新页面"重新长出一次语义搜索的展示态（而那个查询词属于旧项目）。
     * 与 `clearSemantic` 同口径。
     */
    updateUrl({ project: nextId, tab: MEMORY_TAB.COMMITTED, page: null, q: null }, false);
  };

  /**
   * 项目创建成功 → 刷新名单 → 选中新项目（**时序铁律**）。
   *
   * `await refetch()` **必须**在 `selectProject` 之前：若先选中再刷新，选择器的 options
   * 里还没有这个新 id，`value` 会短暂落在一个不存在的 option 上（浏览器把 select 显示成
   * 空值），用户会以为"没建成"而再建一次 —— 而 slug 唯一，第二次必 409（R-6 的实测后果）。
   *
   * ⚠️ **refetch 失败必须显式判**（m-4/R-1）：TanStack v5 的 `refetch()` 失败是 **resolve**
   * （不是 reject），`await` 会照常往下走 —— 于是"关窗 + 选中一个列表里不存在的 id"，
   * 用户零提示。失败分支的处置 = **toast 说明 + 直接关窗**（R-1 裁决）：
   * 此时"创建"本身已成功（`submitError === null` ⇒ `dismissBlocked === false`、提交按钮可用），
   * 留下 Dialog 等于把**重复提交**变成唯一可用动作（再点必 409 → slug 红字 → 诱导换 slug
   * 造重复/孤儿）。关窗 + 不选中，用户按 toast 指引手动刷新后自行选择。
   */
  const handleProjectCreated = async (created: MemoryProjectDto) => {
    const refreshed = await projectsQuery.refetch();
    if (refreshed.isError) {
      toast.error({ title: t('project.refreshFailedAfterCreate'), description: created.name });
      setCreateOpen(false);
      return;
    }
    setCreateOpen(false);
    selectProject(created.id);
  };

  /** 切 Tab：回第 1 页；**非「已记住」Tab 从 URL 移除 page**（另两 Tab 没有分页器） */
  const selectTab = (nextTab: MemoryTab) => {
    if (nextTab === tab) return;
    setTab(nextTab);
    setPage(1);
    setFormationFilter(null);
    updateUrl({ tab: nextTab, page: nextTab === MEMORY_TAB.COMMITTED ? '1' : null }, false);
  };

  /** 切分页（仅「已记住」有分页器）：replace（瞬时浏览态，可刷新恢复/分享） */
  const selectPage = (nextPage: number) => {
    setPage(nextPage);
    updateUrl({ page: String(nextPage) }, true);
  };

  /** 切搜索模式：**不重置查询词**（切模式就清空输入框是纯粹的惩罚，第 10 条） */
  const selectMode = (nextMode: MemorySearchMode) => {
    setMode(nextMode);
    updateUrl({ mode: nextMode }, true);
  };

  /** 提交查询词：语义 = 打一次引擎（每次强制）；字面 = 输入即过滤，无提交语义 */
  const submitSearch = () => {
    const query = input.trim();
    if (!query || !activeProjectId) return;
    if (mode === MEMORY_SEARCH_MODE.LITERAL) return;
    submittedRef.current = { projectId: activeProjectId, query };
    setSubmitted(query);
    setSubmitToken((token) => token + 1);
    updateUrl({ q: query, mode }, true);
  };

  /** 清空语义结果，回到账本（每个状态都要有下一步） */
  const clearSemantic = () => {
    submittedRef.current = null;
    setSubmitted('');
    setSubmitToken(0);
    setInput('');
    updateUrl({ q: null }, true);
  };

  /** 输入 → URL 的 `q`（replace + 300ms 防抖；与当前 URL 值相同则跳过，避免无谓路由更新） */
  useEffect(() => {
    // 从 ref 读（写入时刻的 URL），不用闭包里的旧渲染值——与 `updateUrl` 同一理由：
    // 防抖窗口内可能发生过 push，旧基底会把那次导航盖掉
    if (input === (searchParamsRef.current.get('q') ?? '')) return;
    const timer = setTimeout(() => {
      updateUrl({ q: input.trim() ? input : null }, true);
    }, MEMORY_URL_Q_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateUrl 读 ref（不入 deps），入 deps 会每帧重置定时器
  }, [input]);

  /** 首次入场动效只播一次（翻页/切 Tab 不重播，第 35 条） */
  const entrancePlayedRef = useRef(false);
  const wallReady =
    !projectsQuery.isLoading &&
    (tab !== MEMORY_TAB.COMMITTED || !committedQuery.isLoading) &&
    visibleRows.length > 0;
  useEffect(() => {
    if (wallReady) entrancePlayedRef.current = true;
  }, [wallReady]);

  // ── 渲染分支：项目列表本身的四态（加载 / 错误 / 空 / 正常）────────────────────
  if (projectsQuery.isLoading) {
    return (
      <div className="space-y-4 p-4 md:p-6" data-testid="memory-projects-loading">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-12 w-full rounded-md" />
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            // h-40：贴近真实卡片高度（第 23 条）
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  /**
   * 项目名单的整页错误态只在**从未成功过**（`data === undefined`）时接管。
   *
   * ⚠️ 判据**不能**写成 `projects.length === 0`（R-2 实证）：TanStack v5 的 refetch 失败会
   * **保留旧 data**，零项目用户（`data = {items: []}`）刷新失败时 `isError && length === 0`
   * 成立 ⇒ 错误分支把空态（含创建 CTA 与 Dialog）整棵卸载，而零项目用户恰是空态入口的主目标。
   * `isError && data` 一律走「有旧数据/空态」分支（两条路径一致）。
   */
  if (projectsQuery.isError && projectsQuery.data === undefined) {
    return (
      <div className="space-y-4 p-4 md:p-6" data-testid="memory-projects-error">
        <EmptyState
          title={t('project.errorTitle')}
          description={errorMessageOf(projectsQuery.error, MEMORY_ERROR_FALLBACK)}
          action={
            <Button variant="outline" onClick={() => void projectsQuery.refetch()}>
              {t('project.retry')}
            </Button>
          }
        />
      </div>
    );
  }

  if (projects.length === 0) {
    // 项目列表为空 ≠ 项目无记忆（第 24 条）：两件事的下一步动作完全不同
    return (
      <div className="space-y-4 p-4 md:p-6" data-testid="memory-projects-empty">
        <header>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
        </header>
        {/* 零项目用户是本次优化的最大断点：空态必须自带"创建"入口（PM Q1-a） */}
        <EmptyState
          title={t('project.emptyTitle')}
          description={t('project.emptyDesc')}
          action={
            <Button
              data-testid="memory-project-create-empty"
              aria-haspopup="dialog"
              onClick={() => setCreateOpen(true)}
            >
              {t('project.create')}
            </Button>
          }
        />
        <MemoryProjectCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          provisioningAvailable={provisioningAvailable}
          onCreated={handleProjectCreated}
        />
      </div>
    );
  }

  const pagination = memoryPagination(
    committedTotal,
    page,
    committedQuery.data?.pageSize ?? MEMORY_DEFAULT_PAGE_SIZE,
  );

  /**
   * 本 Tab 的失败信息（每一路都取自己那一路的错误；**单 Tab 失败只在该 Tab 内报错**，第 21 条）。
   *
   * 为什么必须显式渲染：`lib/api.ts` 的拦截器对失败只写 console（不弹 toast），
   * 静默失败会被读成"空数据"——"这条路的台账为空"与"这条路的请求挂了"是两件事。
   */
  const tabError =
    tab === MEMORY_TAB.COMMITTED
      ? committedQuery.isError
        ? errorMessageOf(committedQuery.error, MEMORY_ERROR_FALLBACK)
        : null
      : tab === MEMORY_TAB.NOMINATIONS
        ? (() => {
            const failed = formationQueries.find((q) => q.isError);
            return failed ? errorMessageOf(failed.error, MEMORY_ERROR_FALLBACK) : null;
          })()
        : (() => {
            const failed = inactiveQueries.find((q) => q.isError);
            return failed ? errorMessageOf(failed.error, MEMORY_ERROR_FALLBACK) : null;
          })();

  const tabLoading =
    tab === MEMORY_TAB.COMMITTED
      ? committedQuery.isLoading
      : tab === MEMORY_TAB.NOMINATIONS
        ? formationQueries.every((q) => q.isLoading)
        : inactiveQueries.every((q) => q.isLoading);

  /**
   * 本 Tab 的重试：按 Tab 分派到**真正失败的那几路**。
   *
   * 「已记住」只有一路；另两 Tab 是 N 路并行（六路/两路），只重打失败路既是"重试"
   * 的准确语义，也避免把好的那几路再打一遍（多路全表扫描不是免费的）。
   * 全部失败时就是全打——那种情况下本来也没有可复用的数据。
   */
  const retryTab = () => {
    if (tab === MEMORY_TAB.COMMITTED) {
      void committedQuery.refetch();
      return;
    }
    const failed =
      tab === MEMORY_TAB.NOMINATIONS
        ? formationQueries.filter((q) => q.isError)
        : inactiveQueries.filter((q) => q.isError);
    void Promise.all(failed.map((q) => q.refetch()));
  };

  return (
    // 页面根包 MotionConfig reducedMotion="user"（第 34 条；先例 admin-dashboard.tsx）
    <MotionConfig reducedMotion="user">
      <div className="space-y-4 p-4 md:p-6">
        <header className="space-y-3">
          <h1 className="text-xl font-semibold">{t('title')}</h1>

          {/*
            头部顺序（窄屏重排非缩放，第 1 条）：标题 → 搜索框 → Tab → 卡片墙。
            项目切换器 + Hub 状态灯是**次级信息**，与搜索框同一区块、窄屏占一行。
          */}
          <MemorySearchBar
            mode={mode}
            onModeChange={selectMode}
            value={input}
            onValueChange={setInput}
            onSubmit={submitSearch}
            searching={recallQuery.isFetching}
            disabled={searchDisabled}
            // 禁用说明：内容面不可读（预置 canReadContent=false 或 403 兜底）必须常驻可见；
            // 引擎不可用由横幅解释（第 25/39 条）
            disabledNote={contentReadDenied ? t('search.forbidden') : undefined}
            literalCount={activeRows.length}
            maxItems={MEMORY_RECALL_MAX_ITEMS}
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <label className="inline-flex items-center gap-2">
              <span>{t('project.label')}</span>
              <select
                data-testid="memory-project-select"
                aria-label={t('project.aria')}
                value={activeProjectId ?? ''}
                onChange={(e) => selectProject(e.target.value)}
                className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {/*
                      标注改为**数据驱动**（A3）：`canReadContent === false` 是项目级可读性，
                      取代旧的"已观测"集合（数据源单在项目投影本身，不再靠访问过才标）。
                      形态保持**负向单侧纯文本无着色**（N1：不加正向标注，option 无法着色）。
                    */}
                    {`${project.name} (${project.slug})${
                      project.canReadContent === false ? ` · ${t('project.metadataOnlyBadge')}` : ''
                    }`}
                  </option>
                ))}
              </select>
            </label>
            {/*
              创建入口（N6）：`size="sm"` + h-8 对齐工具行（Button 默认 h-10 会冒高一档）；
              `aria-haspopup="dialog"` 让读屏知道它会开一个对话框。
            */}
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs"
              data-testid="memory-project-create"
              aria-haspopup="dialog"
              onClick={() => setCreateOpen(true)}
            >
              {t('project.create')}
            </Button>
            {/*
              关系图入口（plan §4.1）：**恒带当前 project id**——不带就会退化成"图页自己
              再猜一次项目"，两个页面看到的可能不是同一个项目（无意义往返的另一种形态）。
              ≥xl 是可用门槛：<xl 渲染成不可点的说明态（`span` 不是控件，不进 Tab 序），
              点一个必然跳去"屏宽不足"页的按钮比说清楚更浪费时间。
            */}
            <Link
              href={activeProjectId ? `/memory/graph?project=${activeProjectId}` : '/memory/graph'}
              title={t('graph.openTitle')}
              data-testid="memory-graph-entry"
              className="hidden h-8 items-center rounded-md border border-input px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background xl:inline-flex"
            >
              {t('graph.open')}
            </Link>
            <span
              title={t('graph.openTitle')}
              data-testid="memory-graph-entry-narrow"
              className="inline-flex h-8 items-center rounded-md border border-input px-2.5 text-xs text-muted-foreground/60 xl:hidden"
            >
              {`${t('graph.open')} · ${t('graph.openNarrow')}`}
            </span>
            {/*
              用量深链（/usage?tab=hument&project=<uuid>）：恒带当前项目 id。
              Hument Tab 按项目 canReadUsage 分权，入口本身不预判权限（点了由端点/页内面板裁决）。
            */}
            <Link
              href={
                activeProjectId
                  ? `/usage?tab=hument&project=${activeProjectId}`
                  : '/usage?tab=hument'
              }
              title={t('usage.openTitle')}
              data-testid="memory-usage-entry"
              className="inline-flex h-8 items-center rounded-md border border-input px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t('usage.open')}
            </Link>
            <MemoryEngineLight availability={engineAvailability} />
          </div>
        </header>

        {/* 引擎不可用：**只降级搜索区**（横幅 + 禁用搜索框），卡片墙照常（第 18 条） */}
        {!engineOk && (
          <MemoryEngineBanner
            kind={memoryUnavailableReasonKind(
              runtimeUnavailableReason ?? engineAvailability?.reason ?? null,
            )}
            runtime={!!runtimeUnavailableReason}
          />
        )}

        {showSemanticResults ? (
          <SemanticResults
            recall={recallQuery}
            projectId={activeProjectId ?? ''}
            forbidden={recallForbidden}
            onBack={clearSemantic}
            onRetry={() => void recallQuery.refetch()}
          />
        ) : (
          <>
            {/* Tab 栏：窄屏 grid grid-cols-3 w-full 等分（第 48 条） */}
            <Tabs value={tab} onValueChange={(value) => selectTab(value as MemoryTab)}>
              <TabsList
                data-testid="memory-tabs"
                className="grid w-full grid-cols-3 xl:inline-flex xl:w-auto"
              >
                <TabsTrigger
                  value={MEMORY_TAB.COMMITTED}
                  data-testid="memory-tab-committed"
                  className="flex-1"
                >
                  {`${t('tabs.committed')} (${committedTotal})`}
                </TabsTrigger>
                <TabsTrigger
                  value={MEMORY_TAB.NOMINATIONS}
                  data-testid="memory-tab-nominations"
                  className="flex-1"
                >
                  {`${t('tabs.nominations')} (${nominationsTotal})`}
                </TabsTrigger>
                <TabsTrigger
                  value={MEMORY_TAB.INACTIVE}
                  data-testid="memory-tab-inactive"
                  className="flex-1"
                >
                  {`${t('tabs.inactive')} (${inactiveTotal})`}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* 整片降级（治理观察者 / 无内容读权限）：横幅 + 紧凑三列表，不渲染 N 张锁态卡 */}
            {allMetadata && (
              <p
                data-testid="memory-degraded-banner"
                className="flex items-start gap-2 rounded-md border border-border/60 bg-foreground/5 p-2.5 text-xs text-muted-foreground"
              >
                <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('degraded.pageBanner')}
              </p>
            )}

            {/* 「提名记录」子标签 chip（**真筛选器**：各自带 total，点了就过滤合并集） */}
            {tab === MEMORY_TAB.NOMINATIONS && (
              <div
                className="flex flex-wrap items-center gap-1.5"
                data-testid="memory-formation-chips"
              >
                <button
                  type="button"
                  aria-pressed={formationFilter === null}
                  data-testid="memory-formation-chip-all"
                  onClick={() => setFormationFilter(null)}
                  className={chipClass(formationFilter === null)}
                >
                  {formationFilter === null && <Check className="mr-1 h-3 w-3 shrink-0" />}
                  {t('filterAll')}
                </button>
                {MEMORY_NOMINATIONS_FORMATION_STATES.map((state, index) => {
                  const total = formationQueries[index]?.data?.total ?? 0;
                  const active = formationFilter === state;
                  return (
                    <button
                      key={state}
                      type="button"
                      aria-pressed={active}
                      data-testid={`memory-formation-chip-${state}`}
                      onClick={() => setFormationFilter(state)}
                      className={chipClass(active)}
                    >
                      {/* 选中态双通道：Check 图标 + 主光色描边（同模式切换器/locale-switcher） */}
                      {active && <Check className="mr-1 h-3 w-3 shrink-0" />}
                      {`${formationStateLabel(t, state)} (${total})`}
                    </button>
                  );
                })}
              </div>
            )}

            {/*
              部分失败：本 Tab 的某一路挂了但另几路有数据 —— 必须**显式**说出来
              （第 21 条：`lib/api.ts` 的拦截器对失败只写 console，"静默失败"会被读成"空数据"，
              而"这条路的台账为空"与"这条路的请求挂了"是两件事）。
              零行时才升级为阻塞式错误态（见下一个分支）。
            */}
            {tabError !== null && visibleRows.length > 0 && (
              <p className="text-xs text-amber-300" data-testid="memory-tab-partial-error">
                {t('tabError', { message: tabError })}
              </p>
            )}

            {/* 三态优先级：加载 → 错误 → 空 → 列表（零命中是成功态，走空态文案而非报错） */}
            {tabLoading ? (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="memory-loading">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-40 w-full rounded-lg" />
                ))}
              </div>
            ) : tabError !== null && visibleRows.length === 0 ? (
              <div
                className="flex flex-col items-center gap-3 py-12"
                data-testid="memory-tab-error"
              >
                <p className="text-sm text-destructive">{t('tabError', { message: tabError })}</p>
                {/*
                  重试必须**按 Tab 分派**：另两 Tab 没有单一路 query 可刷，而是 N 路并行，
                  只刷 committed 会让按钮在这两个 Tab 上变成空操作（点了没反应 =
                  比没有按钮更糟，用户会以为"重试也没用"）。
                */}
                <Button variant="outline" data-testid="memory-tab-error-retry" onClick={retryTab}>
                  {t('retry')}
                </Button>
              </div>
            ) : visibleRows.length === 0 ? (
              literalActive ? (
                // 字面过滤空 = "这一页里没匹配"，不是"没有记忆"（两种空的下一步不同）
                <p
                  className="py-10 text-center text-sm text-muted-foreground"
                  data-testid="memory-literal-empty"
                >
                  {t('search.literalEmpty', { query: input })}
                </p>
              ) : (
                <div className="space-y-2" data-testid="memory-empty">
                  {tab === MEMORY_TAB.COMMITTED ? (
                    <>
                      <EmptyState
                        title={t('empty.committedTitle')}
                        description={t('empty.committedDesc')}
                      />
                      {/*
                        条件化路标（第 15 条）：有待处理提名 → 指向那个 Tab（有下一步）；
                        没有 → 只留上面那句"记忆由 agent 提名后由引擎形成"，**不指向另一个空态**
                      */}
                      {nominationsTotal > 0 && (
                        <div className="mx-auto max-w-xl space-y-2 text-center">
                          <p
                            className="text-xs text-muted-foreground"
                            data-testid="memory-empty-roadmap"
                          >
                            {t('empty.committedRoadmap', { count: nominationsTotal })}
                          </p>
                          <Button
                            variant="outline"
                            data-testid="memory-empty-roadmap-link"
                            onClick={() => selectTab(MEMORY_TAB.NOMINATIONS)}
                          >
                            {t('empty.committedRoadmapLink')}
                          </Button>
                        </div>
                      )}
                    </>
                  ) : tab === MEMORY_TAB.NOMINATIONS ? (
                    <EmptyState
                      title={t('empty.nominationsTitle')}
                      description={t('empty.nominationsDesc')}
                    />
                  ) : (
                    <EmptyState
                      title={t('empty.inactiveTitle')}
                      description={t('empty.inactiveDesc')}
                    />
                  )}
                </div>
              )
            ) : (
              <>
                {/*
                  整片降级 → 紧凑三列表（不渲染 N 张锁态卡）；否则走卡片墙。
                  入场动效只在**首次加载**播一次（翻页/切 Tab 不重播，第 35 条）。
                */}
                {allMetadata ? (
                  <MemoryMetadataList entries={visibleRows} />
                ) : (
                  <motion.div
                    variants={staggerContainer}
                    initial={entrancePlayedRef.current ? false : 'hidden'}
                    animate="show"
                    className="grid grid-cols-1 gap-3 xl:grid-cols-2"
                    data-testid="memory-card-wall"
                  >
                    {visibleRows.map((entry) => (
                      <motion.div key={entry.id} variants={fadeSlideUp}>
                        {/* 逐行降级：metadata 行渲染同高紧凑锁态行（占一个网格单元，第 19 条） */}
                        {memoryIsMetadataProjection(entry) ? (
                          <MemoryLockedRow entry={entry} />
                        ) : (
                          <MemoryCard entry={entry} />
                        )}
                      </motion.div>
                    ))}
                  </motion.div>
                )}

                {/*
                  「已记住」有真分页器；另两 Tab 是合并集，截断靠「已显示最近 100 条 · 共 N 条」说明
                  （第 44 条：禁"请用筛选"类死胡同路标——这里没有可用的筛选器）
                */}
                {tab === MEMORY_TAB.COMMITTED ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground" data-testid="memory-pagination">
                      {t('pagination', {
                        page,
                        totalPages: pagination.totalPages,
                        total: committedTotal,
                      })}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="memory-prev-page"
                        aria-label={t('paginationPrev')}
                        disabled={!pagination.hasPrev}
                        onClick={() => selectPage(Math.max(1, page - 1))}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="memory-next-page"
                        aria-label={t('paginationNext')}
                        disabled={!pagination.hasNext}
                        onClick={() => selectPage(page + 1)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <TruncationNotices
                    tab={tab}
                    totals={tabTotals(tab, formationQueries, inactiveQueries)}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
      {/* 创建 Dialog 挂载在页面根（正常分支）：入口在工具栏，空态分支另有自己的实例 */}
      <MemoryProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        provisioningAvailable={provisioningAvailable}
        onCreated={handleProjectCreated}
      />
    </MotionConfig>
  );
}

/**
 * 某一 Tab 各路查询的 `total` 列表（截断提示的判据来源）。
 *
 * @param tab - 当前 Tab
 * @param formationQueries - 六路形成态查询
 * @param inactiveQueries - 两路失效状态查询
 * @returns 按路顺序排列的 total（裁剪前全量行数）
 */
function tabTotals(
  tab: MemoryTab,
  formationQueries: { data?: { total?: number } }[],
  inactiveQueries: { data?: { total?: number } }[],
): number[] {
  if (tab === MEMORY_TAB.NOMINATIONS) return formationQueries.map((q) => q.data?.total ?? 0);
  if (tab === MEMORY_TAB.INACTIVE) return inactiveQueries.map((q) => q.data?.total ?? 0);
  return [];
}

/**
 * 截断提示（第 44 条）：**每一路**各自判断"是不是只显示了最近 100 条"。
 *
 * 为什么必须逐路写：`total` 是裁剪前全量行数，而每路只取 page=1 / pageSize=100 ——
 * 某一路 total>100 时那一列**不是全集**。静默少画会让读者把"已显示的最新的 100 条"
 * 读成"全部"，而"这条更早的提名不存在"是一个**错误的治理结论**。
 */
function TruncationNotices({ tab, totals }: { tab: MemoryTab; totals: readonly number[] }) {
  const t = useTranslations('memory');
  const keys =
    tab === MEMORY_TAB.NOMINATIONS ? MEMORY_NOMINATIONS_FORMATION_STATES : MEMORY_INACTIVE_STATUSES;
  const truncated = keys
    .map((key, index) => ({ key, total: totals[index] ?? 0 }))
    .filter((item) => item.total > MEMORY_MAX_PAGE_SIZE);
  if (truncated.length === 0) return null;
  return (
    <ul className="space-y-1" data-testid="memory-truncated-notices">
      {truncated.map((item) => (
        <li
          key={item.key}
          className="text-xs text-muted-foreground/80"
          data-testid={`memory-truncated-${item.key}`}
        >
          {t('truncated', { shown: MEMORY_MAX_PAGE_SIZE, total: item.total })}
        </li>
      ))}
    </ul>
  );
}

/**
 * 语义召回结果区（D7 的展示面）。
 *
 * 顶栏是**信任框的人类版**（第 14 条）：一句人话 + 本次 recallId + 条数上限 + 顺序说明 +
 * 权限过滤提示 + 引擎数据可疑徽章；原始 `usageNote/trustLevel/decisionAuthority` 进折叠调试区
 * （对人类读者是噪音，对排障是唯一线索，两者都要留）。
 */
function SemanticResults({
  recall,
  projectId,
  forbidden,
  onBack,
  onRetry,
}: {
  recall: { data?: MemoryRecallResponse; isFetching: boolean; isError: boolean };
  projectId: string;
  forbidden: boolean;
  onBack: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations('memory');
  const emptyKind = recall.data ? memoryRecallEmptyKind(recall.data.emptyReason) : 'none';
  const hasItems = memoryRecallHasItems(recall.data);
  /**
   * 主列表是否展示分数（守卫）：缺值 / 全同值 → 不展示。
   * **钻取区不受此限**（C-3：调试区恒显原值，排障需要看真实分布）。
   */
  const showScores = memoryRecallScoresInformative(recall.data?.items ?? []);

  return (
    <section className="space-y-3" data-testid="memory-recall-results">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t('search.resultCount', { count: recall.data?.items.length ?? 0 })}
        </h2>
        {/* 每个状态都要有下一步：语义结果占位时给一条明确的"回账本"出口 */}
        <Button variant="outline" size="sm" data-testid="memory-recall-back" onClick={onBack}>
          {t('search.clear')}
        </Button>
      </div>

      {/*
        失败但**有旧数据**：TanStack v5 的 refetch 失败会保留上一次的 `data` 并把 status 置
        error ⇒ `isError && !data` 的旧守卫会让这里"照常显示旧结果、零失败反馈"，
        读者会以为看到的是刚提交那一次的结果。故此处独立出一条常驻告警 + 重试：
        旧结果仍在（不白丢），但必须明说"这次刷新没成功"（第 13 条：新结果 resolve 前保留旧结果，
        前提是**旧结果被标记为旧**）。
      */}
      {recall.isError && recall.data && (
        <div
          role="status"
          data-testid="memory-recall-stale-warning"
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{t('search.staleResults')}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2"
            data-testid="memory-recall-stale-retry"
            onClick={onRetry}
          >
            {t('search.retry')}
          </Button>
        </div>
      )}

      <div className="glass-flat space-y-1.5 rounded-lg border border-border/60 p-3 text-xs text-muted-foreground">
        <p data-testid="memory-recall-trust-note">{t('search.trustNote')}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span data-testid="memory-recall-max-items">
            {t('search.maxItemsNote', { max: MEMORY_RECALL_MAX_ITEMS })}
          </span>
          <span data-testid="memory-recall-order-note">{t('search.orderNote')}</span>
          {recall.data?.recallId && (
            <span className="font-mono text-[10px]" data-testid="memory-recall-id">
              {t('search.recallId', { id: recall.data.recallId })}
            </span>
          )}
        </p>
        {recall.data?.filteredByPermission === true && (
          <p className="text-amber-300" data-testid="memory-recall-filtered">
            {t('search.filteredByPermission')}
          </p>
        )}
        {recall.data?.engineDataSuspect === true && (
          <p
            className="inline-flex items-center gap-1.5 text-amber-300"
            data-testid="memory-recall-suspect"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {t('search.engineDataSuspect')}
          </p>
        )}
        {recall.data && (
          <details data-testid="memory-recall-debug">
            <summary className="cursor-pointer text-[11px] text-muted-foreground/70">
              {t('search.debug.summary')}
            </summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground/70">
              {memoryTrustDebugRows(recall.data).map((row) => (
                <li key={row.key}>
                  <span>{row.key}: </span>
                  <span>{row.value}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/*
        搜索中：按钮 loading + 禁用（第 13 条），结果区骨架**形状与卡片墙不同**（横向条）；
        `recall.data` 在 refetch 期间由 react-query 保留 ⇒ 新结果 resolve 前旧结果仍在。
      */}
      {recall.isFetching && !recall.data && (
        <div className="space-y-2" data-testid="memory-recall-loading">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="glass-flat flex items-center gap-3 rounded-lg border border-border/60 p-3"
            >
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      )}

      {recall.isError && !recall.data && (
        <div className="flex flex-col items-center gap-3 py-10" data-testid="memory-recall-error">
          <p className="text-sm text-destructive">
            {forbidden ? t('search.forbidden') : t('search.errorTitle')}
          </p>
          {/* 权限不足是死胡同（重试还是 403），不给重试按钮——只给"回账本"这条路 */}
          {!forbidden && (
            <Button variant="outline" onClick={onRetry}>
              {t('search.retry')}
            </Button>
          )}
        </div>
      )}

      {/* URL 恢复但本次会话没提交过：**不自动执行**，给一句说明指路（不是死胡同） */}
      {!recall.data && !recall.isFetching && !recall.isError && (
        <p
          className="py-8 text-center text-xs text-muted-foreground"
          data-testid="memory-recall-restored"
        >
          {t('search.restoredHint')}
        </p>
      )}

      {recall.data && !hasItems && (
        <p
          className="py-8 text-center text-sm text-muted-foreground"
          data-testid="memory-recall-empty"
        >
          {/* all_filtered ≠ no_matches：前者要申请来源权限，后者要换问法（第 17 条） */}
          {emptyKind === 'allFiltered'
            ? t('search.empty.allFiltered')
            : t('search.empty.noMatches')}
        </p>
      )}

      {recall.data && hasItems && (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="memory-recall-list">
          {recall.data.items.map((item) => {
            // 单条守卫：缺 score（旧后端/引擎漏字段）时**只不渲染行尾元素**（W-5 措辞：
            // 不是隐藏整条召回结果）；全同值抑制由 showScores 统一处理。
            const score = memoryRecallItemScore(item);
            return (
              <li key={item.memoryId}>
                <Link
                  href={`/memory/${item.ledgerId}?project=${projectId}`}
                  data-testid="memory-recall-item"
                  className="glass-flat block rounded-lg border border-border/60 p-4 transition-colors hover:border-primary/40"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <MemoryCategoryChip category={item.category} />
                    {/* 条目级只留差异化的出处徽章（有出处 N 条 / 无出处（自述）） */}
                    <MemoryDerivationBadge
                      derivation={item.derivation}
                      sourceCount={item.sources.length}
                    />
                  </div>
                  <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">
                    {item.subject}
                  </h3>
                  <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">{item.body}</p>
                  {/*
                    行尾弱文本（ux 1c 裁决）：分数是**量不是状态** ⇒ 不做 Badge、不做条形；
                    与 scope 行同档（text-[11px] / muted-foreground/80）、右对齐、**零动效**。
                  */}
                  <p className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground/80">
                    <span>{item.scope}</span>
                    {showScores && score !== null && (
                      <span data-testid="memory-recall-score" className="shrink-0 tabular-nums">
                        {t('search.relevance', { score })}
                      </span>
                    )}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** chip 类名（子标签用；选中态走主光色，未选中走中性边框 + focus 环） */
function chipClass(active: boolean): string {
  return cn(
    'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    active
      ? 'border-primary bg-primary/10 text-primary'
      : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  );
}

/** 形成态 → 标签（显式字面量：next-intl key 有编译期校验，禁动态拼 key） */
function formationStateLabel(
  t: ReturnType<typeof useTranslations<'memory'>>,
  state: MemoryFormationState,
): string {
  switch (state) {
    case MEMORY_FORMATION_STATE.SUBMITTED:
      return t('formationState.submitted');
    case MEMORY_FORMATION_STATE.COMMITTED:
      return t('formationState.committed');
    case MEMORY_FORMATION_STATE.NO_MEMORY:
      return t('formationState.no_memory');
    case MEMORY_FORMATION_STATE.REJECTED:
      return t('formationState.rejected');
    case MEMORY_FORMATION_STATE.FAILED:
      return t('formationState.failed');
    case MEMORY_FORMATION_STATE.UNKNOWN:
      return t('formationState.unknown');
    default:
      return t('formationState.conflict');
  }
}

/**
 * 记忆页错误文案的兜底（**保持迁移前的既有语义**：旧本地 helper 的字面量就是这句）。
 *
 * 刻意不新增 i18n 键：本批对 memory 页只做「通道分级」迁移（改用 `lib/error-message.ts`
 * 的单源实现），文案层的国际化归 F3 的 errorMessageOf 全量迁移统一处理——在这里顺手
 * 加键会让"哪些页面的兜底文案已 i18n 化"变成一本糊涂账。
 */
const MEMORY_ERROR_FALLBACK = 'request failed';

/** searchParams 值 → 正整数（页码） */
function parsePositiveIntParam(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

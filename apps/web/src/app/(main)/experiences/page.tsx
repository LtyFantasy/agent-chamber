'use client';

/**
 * 经验库列表页（/experiences）
 *
 * 一句话：搜索框（300ms 防抖）+ intent/quality/domain/录入者 分面过滤 + sort + 卡片流 +
 * 录入 Dialog 入口 + 加载/错误/空三态 + 分页。
 *
 * 契约要点：
 * 1. **分面候选不带过滤拉取**（`facets()` 无参）：选中某过滤值后候选列表不塌缩，
 *    否则用户一旦选了 intent 就再也切不回去（docs 页 facets 同款决策）。
 * 2. **`?quality=unverified` 等 searchParams 直达**：初始化过滤态用（例如从待终审
 *    角标/文档链接跳进来直接落到"未终审"面）。刻意**只读不写回 URL**——列表页过滤
 *    是瞬时浏览态，回写会让浏览器历史被每次点击污染。
 * 3. **most_used 排序必须标注「自报数据可操纵」**：distinct_helped_count 是自报反馈
 *    的去重计数，可被刷；标注是产品诚实性要求（plan §5），不是装饰。
 * 4. 零命中是**成功态**（后端返回空 items + hint），不是错误——空态下展示
 *    后端 hint 的本地化引导语，而不是报错。
 * 5. **录入者过滤（v1.81.0）**：选项源 = `facets.byCreator`（top-20）；因为它是**截断**
 *    列表，已选值必须**强制并入选项**（详见 `creatorOptions` 与 `parseUuidParam`）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, Search, Users } from 'lucide-react';
import {
  EXPERIENCE_INTENTS,
  EXPERIENCE_QUALITIES,
  EXPERIENCE_QUALITY,
  EXPERIENCE_SORT_VALUES,
  UserRole,
  AgentStatus,
  ActorType,
  type ExperienceCreatorFacet,
  type ExperienceIntent,
  type ExperienceListResponse,
  type ExperienceMemberDto,
  type ExperienceMemberRole,
  type ExperienceQuality,
  type ExperienceSort,
} from '@/types';
import { Api } from '@/lib/api';
import {
  EXPERIENCE_BY_CREATOR_LIMIT,
  EXPERIENCE_DEFAULT_PAGE_SIZE,
  EXPERIENCE_QUERY_MAX_LENGTH,
  EXPERIENCE_SEARCH_DEBOUNCE_MS,
  experienceActorLabel,
  experiencePagination,
  type ExperienceListFilters,
} from '@/lib/experience';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ExperienceCard } from '@/components/experiences/experience-card';
import { ExperienceFormDialog } from '@/components/experiences/experience-form-dialog';
import { MembersSheet } from '@/components/members/members-sheet';
import type { MemberItem, MembersSheetLabels } from '@/components/members/types';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/lib/notify';

export default function ExperiencesPage() {
  const t = useTranslations('experiences');
  // 跨命名空间复用既有「已删除」标记文案（member-row 同款），不在 experiences 命名空间重复
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  /** 成员管理入口的可见性（服务端另有闸门；web 只决定"给不给入口"） */
  const isAdmin = user?.role === UserRole.ADMIN;

  /**
   * searchParams 直达的初值（URL 是唯一初值来源；后续过滤变更不回写 URL）。
   *
   * **必须白名单校验**（评审 minor 6）：旧链接/手输的 `?quality=xxx` 若原样透传，
   * 后端 `@IsIn` 会 400 把整页打成错误态；非法值一律回落缺省（= 不过滤）。
   */
  const initialQuality = parseEnumParam(searchParams.get('quality'), EXPERIENCE_QUALITIES) ?? '';
  const initialIntent = parseEnumParam(searchParams.get('intent'), EXPERIENCE_INTENTS) ?? '';
  const initialSort = parseEnumParam(searchParams.get('sort'), EXPERIENCE_SORT_VALUES) ?? 'recent';
  // 录入者 id 不是枚举，用 UUID 形校验（同样出于"脏参数不能打整页"的理由，见 parseUuidParam）
  const initialCreatedById = parseUuidParam(searchParams.get('createdById')) ?? '';

  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  /** 防抖后的查询串（真正进 queryKey/请求的那个） */
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [intent, setIntent] = useState<ExperienceIntent | ''>(initialIntent);
  const [quality, setQuality] = useState<ExperienceQuality | ''>(initialQuality);
  const [domain, setDomain] = useState(searchParams.get('domain') ?? '');
  const [createdById, setCreatedById] = useState(initialCreatedById);
  const [sort, setSort] = useState<ExperienceSort>(initialSort);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 搜索输入 → 防抖（300ms，仓内 search 页同款实现：仓里没有共享 debounce hook） */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
      // 关键词变化必须回到第 1 页，否则会落在"新查询的第 N 页"这种空页上
      setPage(1);
    }, EXPERIENCE_SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  /** 过滤态 → 请求参数（useMemo：对象身份稳定，避免 queryKey 每渲染变化导致重复请求） */
  const filters = useMemo<ExperienceListFilters>(
    () => ({
      q: debouncedQuery,
      intent,
      quality,
      domains: domain ? [domain] : [],
      createdById,
      sort,
      page,
      pageSize: EXPERIENCE_DEFAULT_PAGE_SIZE,
    }),
    // 新增过滤维度必须同步进 deps——漏 dep = 选了不重查（queryKey 不变 → 命中旧缓存）
    [debouncedQuery, intent, quality, domain, createdById, sort, page],
  );

  /** 列表查询（queryKey 约定：['experiences','list',filters]） */
  const { data, isLoading, isError, refetch } = useQuery<ExperienceListResponse>({
    queryKey: ['experiences', 'list', filters],
    queryFn: () => Api.experiences.list(filters),
  });

  /** 分面（计数 + 开放领域词表 + 录入者候选）：不带过滤，保证候选不塌缩 */
  const {
    data: facets,
    isLoading: facetsLoading,
    isError: facetsError,
  } = useQuery({
    queryKey: ['experiences', 'facets'],
    queryFn: () => Api.experiences.facets(),
  });

  /** 录入者候选是否可用（未就绪/失败 → 禁用下拉，见下方 select） */
  const creatorOptionsReady = !facetsLoading && !facetsError;

  /**
   * 录入者下拉选项（facets.byCreator 为源 + **已选值强制并入**）。
   *
   * 为什么必须强制并入：`byCreator` 是**截断**列表（top-20，`byCreatorTruncated` 标记），
   * 受控 `<select value={x}>` 的 x 若不在选项里，浏览器会渲染成空选中并可能回写空值
   * ——用户以为"筛选中"实际已丢过滤。两条会走到这里：① `?createdById=` 直达（该录入者
   * 不在 top-20）；② 选中后分面失效重取（如录入后 `['experiences']` 前缀被 invalidate）
   * 且该录入者跌出 top-20。
   *
   * 并入项的展示走同一三态规则（`experienceActorLabel`）：只有 UUID 可用 → 显示 id 前 8 位
   * + `title` 完整 UUID；计数用 `filter.countUnknown` 占位（**不写假 0**——与 quality 的
   * suspect 计数同一纪律：无权威数字时不能编一个）。
   */
  const creatorOptions = useMemo((): {
    id: string;
    name: string;
    title?: string;
    deleted: boolean;
    orphan: boolean;
    count?: number;
  }[] => {
    const fromFacets = (facets?.byCreator ?? []).map((facet: ExperienceCreatorFacet) => ({
      ...experienceActorLabel({
        id: facet.createdById,
        name: facet.createdByName,
        deletedAt: facet.createdByDeletedAt,
      }),
      id: facet.createdById,
      count: facet.count,
    }));
    if (!createdById || fromFacets.some((o) => o.id === createdById)) return fromFacets;
    return [
      {
        ...experienceActorLabel({ id: createdById }),
        id: createdById,
        count: undefined,
      },
      ...fromFacets,
    ];
  }, [facets, createdById]);

  /**
   * quality 选项的计数（评审 M2）。
   *
   * **suspect 是结构性例外**：facets 与列表同一 baseQuery（默认排除 suspect）⇒
   * `byQuality.suspect` 恒为 0，直接显示会误导"没有可疑条目"。真实数字只在 admin
   * 请求时的 `suspectCount`（后端放开 suspect 排除单独数）。非 admin 没有该键 ⇒
   * 显示占位符而非假 0。
   *
   * @param value - quality 取值
   * @returns 展示用计数字符串（含括号）；无权威计数时返回 undefined（调用方用占位）
   */
  const qualityCountOf = (value: ExperienceQuality): number | undefined => {
    if (value === EXPERIENCE_QUALITY.SUSPECT) return facets?.suspectCount;
    return facets?.byQuality?.[value] ?? 0;
  };

  const pagination = experiencePagination(
    data?.total ?? 0,
    page,
    data?.pageSize ?? EXPERIENCE_DEFAULT_PAGE_SIZE,
  );
  const items = data?.items ?? [];

  /** 过滤项变更后统一回第 1 页（分页与过滤联动，避免空页） */
  const resetPage = () => setPage(1);

  /** 是否有生效中的过滤（空态「清除全部筛选」入口的显隐门——无过滤时不摆无用按钮） */
  const hasActiveFilters =
    query.trim() !== '' || intent !== '' || quality !== '' || domain !== '' || createdById !== '';

  /**
   * 清除全部过滤（空态退路）。**不含 sort**：排序不参与"筛掉了什么"的因果，且它自带
   * "recent" 缺省与独立控件；把它一起重置会让用户"只想清过滤"却丢了排序选择。
   * 同时回第 1 页（清过滤后落在第 N 页同样会空页）。
   */
  const clearAllFilters = () => {
    setQuery('');
    setDebouncedQuery('');
    setIntent('');
    setQuality('');
    setDomain('');
    setCreatedById('');
    resetPage();
  };

  // ── 空间成员（第二期：终审权委托面的管理入口）────────────────────────────
  //
  // 权限与信息取舍（plan §6）：
  // - **入口仅 admin 可见**（"仅 admin 可见；owner 走 REST"——人类 owner 的 web 管理面
  //   缺口已在 plan §13 登记；后端对 owner 另有双约束闸门，本页不复制那份权限逻辑）；
  // - 候选**仅 agent**（人类 reviewer 无法从 UI 指派——同样登记在 §13；API 层不限制）；
  // - 成员清单的 `invitedBy` 只有 admin/owner 才非空（服务端判定，web 只渲染）。

  /** 成员管理 Sheet 开合（受控；仅 admin 能打开） */
  const [membersOpen, setMembersOpen] = useState(false);

  /** 成员清单（打开 Sheet 且是 admin 才拉——避免每次列表页渲染都多打一次后端） */
  const { data: membersData } = useQuery({
    queryKey: ['experiences', 'members'],
    queryFn: () => Api.experiences.members(),
    enabled: isAdmin && membersOpen,
  });

  /** agent 候选来源（queryKey 与详情页/topics/boards/docs 共享缓存） */
  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => Api.agents.listAll(),
    enabled: isAdmin && membersOpen,
  });

  /** 授权（默认 reviewer——plan §6：邀请面板不动，默认角色在调用方落库） */
  const addMemberMutation = useMutation({
    mutationFn: (data: { actorId: string; role: ExperienceMemberRole }) =>
      Api.experiences.addMember(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['experiences', 'members'] });
    },
  });

  /** 改角色（行内 menu → PATCH；owner 双约束由服务端裁决，403 时本页只提示） */
  const updateMemberRoleMutation = useMutation({
    mutationFn: (data: { actorId: string; role: ExperienceMemberRole }) =>
      Api.experiences.updateMemberRole(data.actorId, { role: data.role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['experiences', 'members'] });
    },
  });

  /** 夺权（物理删，即时生效） */
  const removeMemberMutation = useMutation({
    mutationFn: (actorId: string) => Api.experiences.removeMember(actorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['experiences', 'members'] });
    },
  });

  /** 成员行 → MemberItem（DTO 的 name/type/avatarUrl 由服务端档案解析填充） */
  const memberItems = useMemo((): MemberItem[] => {
    return (membersData?.items ?? []).map((m: ExperienceMemberDto) => ({
      actorId: m.actorId,
      // 真孤儿（档案解析不到）兜底显示 actorId 前 8 位，不显示空行
      name: m.actorName || m.actorId.slice(0, 8),
      actorType: m.actorType ?? 'agent',
      role: m.role,
      avatarUrl: m.avatarUrl ?? undefined,
      deletedAt: m.deletedAt ?? null,
      status: 'active',
    }));
  }, [membersData]);

  /** 可邀请候选：全量 active agent 排除现有成员（人类候选不提供，见上方取舍） */
  const candidateItems = useMemo((): MemberItem[] => {
    const memberIds = new Set((membersData?.items ?? []).map((m) => m.actorId));
    return (agentsData ?? [])
      .filter((a) => a.status === AgentStatus.ACTIVE && !memberIds.has(a.id))
      .map((a) => ({
        actorId: a.id,
        name: a.name,
        actorType: 'agent' as const,
        role: 'reviewer',
        avatarUrl: a.avatarUrl ?? undefined,
        status: 'active',
      }));
  }, [agentsData, membersData]);

  /** 成员 Sheet 文案：角色中文标签按 plan 钉死（owner=空间管理员 / reviewer=终审人） */
  const memberLabels: MembersSheetLabels = {
    title: t('members.title'),
    roleLabels: {
      owner: t('members.owner'),
      reviewer: t('members.reviewer'),
    },
    typeLabels: {
      human: t('members.human'),
      agent: t('members.agent'),
    },
  };

  /** R2 邀请 Promise 契约（组件 await）：全部成功 → 组件切回主视图；任一失败 → 汇总 toast */
  const handleInvite = async (actorIds: string[], kind: 'agent' | 'human') => {
    if (kind !== ActorType.AGENT) {
      // 人类候选本批不提供（plan §13 登记的 UI 缺口）。静默 return 会让组件 resolve →
      // 切回主视图+清空选择（用户误以为已授权而服务端零写入）——reject 对齐失败语义，
      // 组件留在邀请视图；未来接入人类候选时本守卫整体移除。
      throw new Error('human candidates are not supported for the experience space yet');
    }
    const results = await Promise.allSettled(
      actorIds.map((actorId) =>
        // 新成员默认 reviewer（终审人）——与 plan §6 的默认角色口径一致
        addMemberMutation.mutateAsync({ actorId, role: 'reviewer' }),
      ),
    );
    // eslint-disable-next-line rulesdir/no-magic-string-compare -- PromiseSettledResult 内置状态（'fulfilled'|'rejected'）
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    if (failed > 0) {
      toast.error({ title: t('members.inviteFailed', { succeeded, failed }) });
      throw new Error(`invite member partial failure: ${failed}/${results.length}`);
    }
  };

  /** 行内改角色（既有 changeRole 机制）→ PATCH */
  const handleChangeRole = (actorId: string, newRole: string) => {
    updateMemberRoleMutation.mutate({ actorId, role: newRole as ExperienceMemberRole });
  };

  /** 行内移除 → DELETE（组件 AlertDialog 已确认） */
  const handleRemoveMember = (actorId: string) => {
    removeMemberMutation.mutate(actorId);
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* 成员管理入口：**仅 admin 可见**（plan §6；owner 走 REST——UI 缺口登记 §13） */}
          {isAdmin && (
            <Button
              variant="outline"
              data-testid="experience-members-button"
              onClick={() => setMembersOpen(true)}
            >
              <Users className="mr-1.5 h-4 w-4" />
              {t('members.title')}
            </Button>
          )}
          <Button data-testid="experience-record-button" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('record')}
          </Button>
        </div>
      </header>

      {/* 过滤条：xl 以下单栏堆叠（响应式），xl 以上一行排开（6 控件 → 6 列） */}
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-6"
        data-testid="experience-filters"
      >
        <div className="relative sm:col-span-2 xl:col-span-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="experience-search-input"
            value={query}
            maxLength={EXPERIENCE_QUERY_MAX_LENGTH}
            placeholder={t('searchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>

        <select
          data-testid="experience-intent-filter"
          aria-label={t('filter.intent')}
          value={intent}
          onChange={(e) => {
            setIntent(e.target.value as ExperienceIntent | '');
            resetPage();
          }}
          className="h-10 rounded-md border border-input bg-background/60 px-2 text-sm"
        >
          <option value="">{t('filter.all')}</option>
          {/* 候选来自 facets 的键全量词表（shared 单源）+ counts */}
          {EXPERIENCE_INTENTS.map((value) => (
            <option key={value} value={value}>
              {`${intentLabelOf(t, value)} (${facets?.byIntent?.[value] ?? 0})`}
            </option>
          ))}
        </select>

        <select
          data-testid="experience-quality-filter"
          aria-label={t('filter.quality')}
          value={quality}
          onChange={(e) => {
            setQuality(e.target.value as ExperienceQuality | '');
            resetPage();
          }}
          className="h-10 rounded-md border border-input bg-background/60 px-2 text-sm"
        >
          <option value="">{t('filter.all')}</option>
          {EXPERIENCE_QUALITIES.map((value) => {
            const count = qualityCountOf(value);
            return (
              <option key={value} value={value}>
                {`${qualityLabelOf(t, value)} (${
                  // 非 admin 的 suspect 计数无权威来源（见 qualityCountOf）→ 用占位符，
                  // 不用假 0（0 会被读成"没有可疑条目"）
                  count === undefined ? t('filter.countUnknown') : count
                })`}
              </option>
            );
          })}
        </select>

        <select
          data-testid="experience-domain-filter"
          aria-label={t('filter.domain')}
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value);
            resetPage();
          }}
          className="h-10 rounded-md border border-input bg-background/60 px-2 text-sm"
        >
          <option value="">{t('filter.all')}</option>
          {/* 领域是开放词表：候选由 facets.availableDomains 回显（写入者枚举的唯一通道） */}
          {(facets?.availableDomains ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <select
          data-testid="experience-sort-filter"
          aria-label={t('filter.sort')}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as ExperienceSort);
            resetPage();
          }}
          className="h-10 rounded-md border border-input bg-background/60 px-2 text-sm"
        >
          {EXPERIENCE_SORT_VALUES.map((value) => (
            <option key={value} value={value}>
              {value === 'recent' ? t('sort.recent') : t('sort.most_used')}
            </option>
          ))}
        </select>

        {/*
          录入者过滤（v1.81.0，第 6 控件）。`sm:col-span-2` 是**布局约束**：sm 网格 2 列时
          前 5 个控件占 6 格（search 已 span2），本项只有占满剩余 2 格，末行才不留空洞
          （xl 单行 6 等分）。@<sm 单列会让过滤条多一行（明文接受，与仓内其它筛选条一致）。

          禁用与提示：候选来自异步分面，未就绪/失败时禁用（继承本页"分面静默"的既有模式，
          但**区分空态**——静默的后果在这里更重：可选的选项集为空会让用户以为"没有录入者"）。
        */}
        <select
          data-testid="experience-creator-filter"
          aria-label={t('filter.creator')}
          value={createdById}
          disabled={!creatorOptionsReady}
          title={creatorOptionsReady ? undefined : t('filter.creatorUnavailable')}
          onChange={(e) => {
            setCreatedById(e.target.value);
            resetPage();
          }}
          className="h-10 rounded-md border border-input bg-background/60 px-2 text-sm disabled:opacity-50 sm:col-span-2 xl:col-span-1"
        >
          <option value="">{t('filter.all')}</option>
          {/* 选项 = byCreator（名字 + 计数 + 软删标记）；名字三态规则同卡片/详情 */}
          {creatorOptions.map((option) => (
            <option key={option.id} value={option.id} title={option.title}>
              {`${option.name}${option.deleted ? ` · ${tCommon('deleted')}` : ''} (${
                option.count === undefined ? t('filter.countUnknown') : option.count
              })`}
            </option>
          ))}
        </select>
      </div>

      {/* 录入者候选截断提示：截断时下拉**不是**全部录入者（不许把它读成全集） */}
      {creatorOptionsReady && facets?.byCreatorTruncated === true && (
        <p className="text-xs text-muted-foreground/80" data-testid="experience-creator-truncated">
          {t('filter.creatorTruncated', { count: EXPERIENCE_BY_CREATOR_LIMIT })}
        </p>
      )}

      {/* most_used 标注：自报计数可操纵（产品诚实性要求，plan §5） */}
      {sort === 'most_used' && (
        <p
          data-testid="experience-most-used-notice"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('sort.mostUsedNotice')}
        </p>
      )}

      {/* 三态：加载骨架 / 错误重试 / 空态（零命中是成功态，展示引导而非报错） */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="experience-loading">
          {[0, 1, 2, 3].map((i) => (
            // h-40（160px）：v1.81.0 卡片新增归属元信息行（≈28px）后从 h-32 上调的最近档，
            // 骨架高度与真实卡片差太多会在加载→完成切换时跳版
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 py-12" data-testid="experience-error">
          <p className="text-sm text-destructive">{t('listError')}</p>
          <Button variant="outline" onClick={() => void refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="space-y-2">
          <EmptyState
            title={t('empty')}
            description={t('emptyDesc')}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={() => setDialogOpen(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  {t('record')}
                </Button>
                {/* 空页退路（评审 minor 11）：page 不在 URL，第 N 页空掉时只能刷整页——
                    给一个"回到第 1 页"的显式出口 */}
                {page > 1 && (
                  <Button
                    variant="outline"
                    data-testid="experience-back-to-first-page"
                    onClick={resetPage}
                  >
                    {t('backToFirstPage')}
                  </Button>
                )}
                {/* 过滤退路（v1.81.0）：零命中最常见的成因是**过滤叠加**（尤其新加的录入者
                    维度），而过滤控件分布在 6 个格子里、"哪个把结果筛没了"并不显然——给一个
                    一键清空的出口。无过滤时不渲染（摆一个点了没反应的按钮是噪音）。 */}
                {hasActiveFilters && (
                  <Button
                    variant="outline"
                    data-testid="experience-clear-filters"
                    onClick={clearAllFilters}
                  >
                    {t('clearFilters')}
                  </Button>
                )}
              </div>
            }
          />
          {/* 后端零命中引导（hint 原文是给 Agent 的行为指令）→ 人类版的本地化引导 */}
          {data?.hint && (
            <p
              className="mx-auto max-w-xl text-center text-xs text-muted-foreground/80"
              data-testid="experience-empty-hint"
            >
              {t('emptyHint')}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {items.map((entry) => (
              <ExperienceCard key={entry.id} entry={entry} />
            ))}
          </div>

          {/* 分页：后端只给 items/total/page/pageSize，totalPages/hasNext 由前端派生 */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground" data-testid="experience-pagination">
              {t('pagination', {
                page,
                totalPages: pagination.totalPages,
                pageSize: data?.pageSize ?? EXPERIENCE_DEFAULT_PAGE_SIZE,
                total: data?.total ?? 0,
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="experience-prev-page"
                aria-label={t('paginationPrev')}
                disabled={!pagination.hasPrev}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="experience-next-page"
                aria-label={t('paginationNext')}
                disabled={!pagination.hasNext}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}

      <ExperienceFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        // 失效 ['experiences'] 前缀（评审 M1）：list + detail + facets 一起刷——只 refetch
        // 列表会让分面计数（quality 下拉）与 sidebar 待终审角标陈旧到 staleTime 过期为止。
        // 详情页的编辑出口已是同一口径（[id]/page.tsx 三处 invalidate）
        onSaved={() => void queryClient.invalidateQueries({ queryKey: ['experiences'] })}
      />

      {/*
        空间成员管理（第二期，复用共享 MembersSheet）：**仅 admin 能打开**（入口按钮同样
        仅 admin 渲染）。最小侵入纪律——invite-panel / types 的 onInvite 签名零变更，
        经验库只提供数据装配与三个回调：
        - 邀请默认 `role='reviewer'`（终审人；owner 由 admin 事后在行内升级）；
        - 行内改角色走既有 changeRole 机制 → PATCH（角色中文标签：空间管理员/终审人）；
        - 候选**仅 agent**（人类 reviewer 的 UI 指派缺口登记在 plan §13）。
      */}
      <MembersSheet
        open={membersOpen}
        onOpenChange={setMembersOpen}
        labels={memberLabels}
        members={memberItems}
        candidates={candidateItems}
        capabilities={{
          invite: isAdmin,
          remove: isAdmin,
          changeRole: [
            { fromRole: 'reviewer', toRole: 'owner', label: t('members.setOwner') },
            { fromRole: 'owner', toRole: 'reviewer', label: t('members.setReviewer') },
          ],
        }}
        onInvite={handleInvite}
        onRemove={handleRemoveMember}
        onChangeRole={handleChangeRole}
        inviting={addMemberMutation.isPending}
      />
    </div>
  );
}

/**
 * searchParams 值 → 白名单枚举（评审 minor 6）
 *
 * 非法值返回 null 由调用方回落缺省：直接把任意字符串当过滤值发给后端会撞 `@IsIn`
 * 400，把整页打进错误态（旧链接、手输、外部分享的参数都可能带脏值）。
 *
 * @param raw - URL 参数原值（null = 未提供）
 * @param allowed - 该参数的合法值域（shared 单源常量）
 * @returns 合法值或 null
 */
function parseEnumParam<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  if (!raw) return null;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * searchParams 值 → UUID（v1.81.0：`?createdById=` 直达）
 *
 * 与 `parseEnumParam` 同一理由，只是值域不是有限枚举：后端该参数是 `@IsUUID()`，脏值
 * 会被 400 **把整页打进错误态**（旧链接/手输/外部分享都可能带脏值）。这里做**形状**校验
 * （只放到后端的一定是 UUID 形态的串），合法性与存在性仍由后端裁决（铁律 #21：格式在
 * 边界层拦，业务存在性在服务层判）。
 *
 * @param raw - URL 参数原值（null = 未提供）
 * @returns 合法 UUID 或 null（调用方回落"不过滤"）
 */
function parseUuidParam(raw: string | null): string | null {
  if (!raw) return null;
  // 与后端 @IsUUID()（validator `all` 模式）等价：版本位 [1-8] + variant 位 [89ab]，
  // 外加 nil / max 两个例外——比后端宽会让形状像 UUID 的脏值漏过去吃 400 把整页打进错误态，
  // 比后端严会误杀合法值
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
    raw,
  )
    ? raw
    : null;
}

/**
 * intent 值 → 标签（显式字面量：next-intl v4 的 key 有编译期校验，禁动态拼）
 *
 * 抽成模块级纯函数（而非组件内闭包）：两个 select 的 option 渲染共用，避免同一套
 * 分支写两遍；`t` 由调用方注入（与 `useTranslations` 返回值同型）。
 */
function intentLabelOf(
  t: ReturnType<typeof useTranslations<'experiences'>>,
  value: ExperienceIntent,
): string {
  switch (value) {
    case 'pitfall':
      return t('intent.pitfall');
    case 'repair':
      return t('intent.repair');
    case 'howto':
      return t('intent.howto');
    case 'optimize':
      return t('intent.optimize');
    default:
      return t('intent.decision');
  }
}

/** quality 值 → 标签（同上：显式字面量 + 下拉 option 共用） */
function qualityLabelOf(
  t: ReturnType<typeof useTranslations<'experiences'>>,
  value: ExperienceQuality,
): string {
  switch (value) {
    case 'verified':
      return t('quality.verified');
    case 'suspect':
      return t('quality.suspect');
    default:
      return t('quality.unverified');
  }
}

'use client';

/**
 * 经验详情页（/experiences/[id]）
 *
 * 一句话：正文全文（markdown 现栈渲染）+ 质量/过期标记 + 「帮到了/没帮到」反馈 +
 * 编辑/删除（作者或 owner 代理或 admin）+ **终审按钮组**（角色门：人类 admin 或经验空间
 * owner/reviewer——v1.81.0 禁自审四态退役后，本人所录条目也可由自己终审）。
 *
 * 契约要点：
 * 1. **详情端点的可见性与列表不同**：按 id 只过滤软删——suspect 与已过期条目
 *    **照常可见并带标记**（这是复核/申诉动线的必要条件）。UI **不得藏 suspect 条目**，
 *    终审按钮组必须双向可用（suspect → verified 也允许）。
 * 2. **owner 代理判定**：`isCreatorOrOwner(entry.createdById, user.id, myAgentIds)`，
 *    其中 `myAgentIds` 由**页面级** `['agents','list']` useQuery（`Api.agents.listAll`）
 *    派生并向下传——与 topics/boards/docs 页共享同一缓存，组件内禁止重复 fetch。
 * 3. **反馈语义**：回答的是「**应用后**是否有效」，不是「搜索是否命中」；`clientRequestId`
 *    每次点击用 `crypto.randomUUID()` 新生成——改判是**新的 outcome**，复用旧键会被
 *    后端判成 409/9002 重放冲突。
 * 4. **markdown 安全**：只用 react-markdown 现栈（**禁 rehype-raw / dangerouslySetInnerHTML**）。
 * 5. 编辑走录入 Dialog 的编辑模式（同一组件两模式），`expectedUpdatedAt` = 当前详情
 *    `updatedAt`；409 = 期间他人改过 → 提示重新加载后重试。
 * 6. 响应式：xl 以下单栏堆叠（正文在上、元信息在下），xl 以上两栏。
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Clock, Pencil, ShieldCheck, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import {
  EXPERIENCE_QUALITY,
  ActorType,
  UserRole,
  type ExperienceFeedbackOutcome,
  type ExperienceQuality,
} from '@/types';
import { Api } from '@/lib/api';
import { isCreatorOrOwner } from '@/lib/is-resource-owner';
import { MARKDOWN_CLASSES } from '@/lib/markdown-classes';
import { createMarkdownComponents } from '@/lib/markdown-components';
import { confirm, toast } from '@/lib/notify';
import { cn, formatDate } from '@/lib/utils';
import {
  experienceActorLabel,
  experienceEnvRows,
  experienceIntentBadgeVariant,
  experienceQualityBadgeVariant,
  newClientRequestId,
} from '@/lib/experience';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ExperienceFormDialog } from '@/components/experiences/experience-form-dialog';

/**
 * 准入建议（`admissionSuggestion`）三态的着色。
 *
 * 是**文案增强**，不是行为分支：只决定这一行用什么颜色，不参与任何"拒绝/改写/升降 quality"
 * 判断（observe-only，见 shared `ExperienceJudgment.admissionSuggestion` 契约）。
 * 正向 emerald（同页内既有正向色）/ 警告 amber（同页内既有告警色）/ 负向 destructive（全局负向色）。
 */
const JUDGMENT_ADMISSION_TONE_CLASS = {
  admit: 'font-medium text-emerald-300',
  needs_human: 'font-medium text-amber-300',
  reject: 'font-medium text-destructive',
} as const;

/** 机器初评面板的一行（`tone` = 准入建议三态着色；`highlight` = 既有六维的"可行动"加重） */
type JudgmentPanelRow = {
  label: string;
  value: string;
  /** 既有六维的"可行动"加重（建议值 / none_fits） */
  highlight?: boolean;
  /** 准入建议三态着色（observe-only 文案增强，不改行为） */
  tone?: keyof typeof JUDGMENT_ADMISSION_TONE_CLASS;
};

export default function ExperienceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('experiences');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.role === UserRole.ADMIN;

  const [editOpen, setEditOpen] = useState(false);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewPending, setReviewPending] = useState<ExperienceQuality | null>(null);
  const [feedbackPending, setFeedbackPending] = useState(false);
  /** 我的反馈结果（详情端点不返回"我的反馈"，故由本地响应态承载） */
  const [myOutcome, setMyOutcome] = useState<ExperienceFeedbackOutcome | null>(null);

  const {
    data: entry,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['experiences', 'detail', id],
    queryFn: () => Api.experiences.get(id),
    enabled: !!id,
  });

  /**
   * Agent 列表（owner 代理判定用）：queryKey 与 topics/boards/docs 页共享缓存，
   * 非 admin 只返回自己拥有的 agents ⇒ 即「我的 agent id 集合」。
   */
  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => Api.agents.listAll(),
  });
  const myAgentIds = useMemo(() => (agentsData ?? []).map((a) => a.id), [agentsData]);

  /** 可管理（编辑/删除）= admin | creator | owner 代理 */
  const canManage =
    !!user && (isAdmin || isCreatorOrOwner(entry?.createdById, user.id, myAgentIds));

  /**
   * markdown 渲染组件（共享工厂，零参形态）：经验正文是全员可读的自由 markdown，
   * 链接/图片行为必须与 docs 正文一致（外链 noreferrer、附件图走鉴权加载）。
   */
  const markdownComponents = useMemo(() => createMarkdownComponents(), []);

  /** 类型/质量标签（显式字面量：next-intl key 有编译期校验，禁动态拼） */
  const intentLabel = entry
    ? {
        pitfall: t('intent.pitfall'),
        repair: t('intent.repair'),
        howto: t('intent.howto'),
        optimize: t('intent.optimize'),
        decision: t('intent.decision'),
      }[entry.intent]
    : '';
  const qualityLabel = entry
    ? {
        unverified: t('quality.unverified'),
        verified: t('quality.verified'),
        suspect: t('quality.suspect'),
      }[entry.quality]
    : '';

  /**
   * 机器初评面板的渲染行（第二期；v1.82.0 起含第 7 维准入建议）。
   *
   * 四条渲染纪律：
   * - **七维均可为 null**（批 3 起 shared 类型可空：非法/缺失维度服务端按白名单置 null）→
   *   逐维判空，缺该维就**整行不渲染**（不显示占位符——"评分是空的"与"没有这一项评分"
   *   在读者眼里是两件事）；
   * - 档位/结论文案走**显式字面量映射**（next-intl 的 key 有编译期校验，禁动态拼 key）；
   * - intent/domain 的**建议值**加视觉加重（对录入者可行动），`keep`/`none_fits` 不加重；
   * - `admissionSuggestion`（准入建议）是**三态着色**而非加重：admit 正向 / needs_human
   *   警告 / reject 负向——它只帮录入者自省，**不触发任何自动动作**（observe-only）。
   */
  const judgmentRows = useMemo((): JudgmentPanelRow[] => {
    const j = entry?.judgment;
    if (!j) return [];

    /** 档位文案（缺映射回退原始档位值——数据异常时仍可读，不崩） */
    const levelLabels: Record<string, string> = {
      missing: t('judgment.level.missing'),
      thin: t('judgment.level.thin'),
      partial: t('judgment.level.partial'),
      complete: t('judgment.level.complete'),
      one_off: t('judgment.level.one_off'),
      narrow: t('judgment.level.narrow'),
      broad: t('judgment.level.broad'),
      noise: t('judgment.level.noise'),
      weak: t('judgment.level.weak'),
      distinctive: t('judgment.level.distinctive'),
    };
    /** 结论文案（重复度三态；建议类另见下方 value 分支） */
    const verdictLabels: Record<string, string> = {
      distinct: t('judgment.verdict.distinct'),
      possible_duplicate: t('judgment.verdict.possible_duplicate'),
      likely_duplicate: t('judgment.verdict.likely_duplicate'),
      keep: t('judgment.verdict.keep'),
      none_fits: t('judgment.verdict.none_fits'),
    };
    /** 准入建议三态文案（显式字面量：next-intl key 有编译期校验，禁动态拼 key） */
    const admissionLabels: Record<string, string> = {
      admit: t('judgment.admission.admit'),
      needs_human: t('judgment.admission.needs_human'),
      reject: t('judgment.admission.reject'),
    };
    /** 置信度展示（0~1 两位小数；服务端已 clamp，这里只格式化） */
    const withConfidence = (label: string, confidence: number) =>
      `${label} (${confidence.toFixed(2)})`;

    const rows: JudgmentPanelRow[] = [];
    if (j.completeness) {
      rows.push({
        label: t('judgment.dimension.completeness'),
        value: withConfidence(
          levelLabels[j.completeness.level] ?? j.completeness.level,
          j.completeness.confidence,
        ),
      });
    }
    if (j.reusability) {
      rows.push({
        label: t('judgment.dimension.reusability'),
        value: withConfidence(
          levelLabels[j.reusability.level] ?? j.reusability.level,
          j.reusability.confidence,
        ),
      });
    }
    if (j.signalQuality) {
      rows.push({
        label: t('judgment.dimension.signalQuality'),
        value: withConfidence(
          levelLabels[j.signalQuality.level] ?? j.signalQuality.level,
          j.signalQuality.confidence,
        ),
      });
    }
    if (j.duplicate) {
      rows.push({
        label: t('judgment.dimension.duplicate'),
        value: withConfidence(
          verdictLabels[j.duplicate.verdict] ?? j.duplicate.verdict,
          j.duplicate.confidence,
        ),
      });
    }
    if (j.intentSuggestion) {
      const { verdict, value, confidence } = j.intentSuggestion;
      rows.push({
        label: t('judgment.dimension.intentSuggestion'),
        value:
          verdict === 'suggested' && value
            ? withConfidence(t('judgment.verdict.suggested', { value }), confidence)
            : withConfidence(verdictLabels[verdict] ?? verdict, confidence),
        highlight: verdict === 'suggested' && !!value,
      });
    }
    if (j.domainSuggestion) {
      const { verdict, value, confidence } = j.domainSuggestion;
      rows.push({
        label: t('judgment.dimension.domainSuggestion'),
        value:
          verdict === 'suggested' && value
            ? withConfidence(t('judgment.verdict.suggested', { value }), confidence)
            : withConfidence(verdictLabels[verdict] ?? verdict, confidence),
        // none_fits 也算"可行动"（对词表维护者可行动——可能该扩词表）
        highlight: verdict === 'suggested' || verdict === 'none_fits',
      });
    }
    if (j.admissionSuggestion) {
      const { verdict, confidence } = j.admissionSuggestion;
      rows.push({
        label: t('judgment.dimension.admissionSuggestion'),
        // 档位文案缺映射时回退原始档位值（数据异常仍可读，与 levelLabels 同纪律）
        value: withConfidence(admissionLabels[verdict] ?? verdict, confidence),
        // 三态着色（observe-only：只帮录入者自省，不触发任何自动动作）
        tone: verdict,
      });
    }
    return rows;
  }, [entry, t]);

  /**
   * 提交使用反馈：每次点击生成新的幂等键（改判 = 新 outcome，不能复用旧键）。
   *
   * @param outcome - 应用后是否有帮助（helped / not_helpful）
   */
  const submitFeedback = async (outcome: ExperienceFeedbackOutcome) => {
    setFeedbackPending(true);
    try {
      const res = await Api.experiences.feedback(id, {
        outcome,
        clientRequestId: newClientRequestId(),
      });
      setMyOutcome(res.outcome);
      // 响应携带事务提交后的三计数 → 直接回写缓存，无需二次查询
      queryClient.setQueryData(
        ['experiences', 'detail', id],
        (prev: Record<string, unknown> | undefined) =>
          prev
            ? {
                ...prev,
                helpedCount: res.helpedCount,
                notHelpfulCount: res.notHelpfulCount,
                distinctHelpedCount: res.distinctHelpedCount,
              }
            : prev,
      );
      // 列表卡片的信任信号（distinctHelpedCount）与 most_used 排序口径也要保鲜：
      // 只回写详情缓存会让列表在 staleTime 内仍显示旧计数（评审 minor 3）
      await queryClient.invalidateQueries({ queryKey: ['experiences', 'list'] });
      await queryClient.invalidateQueries({ queryKey: ['experiences', 'facets'] });
      toast.success({ title: t('feedback.thanks') });
    } catch (err) {
      const axiosErr = err as { response?: { status?: number; data?: { message?: string } } };
      toast.error({
        title:
          axiosErr?.response?.status === 409
            ? t('feedback.expiredNotice')
            : axiosErr?.response?.data?.message || t('feedback.failed'),
      });
    } finally {
      setFeedbackPending(false);
    }
  };

  /**
   * admin 终审（verified / suspect 双向门）。
   *
   * @param quality - 判定结果（verified = 通过加权；suspect = 默认检索排除但详情可见可改回）
   */
  const submitReview = async (quality: ExperienceQuality) => {
    // 终审只接受 verified / suspect（DTO 白名单同值；用 shared 命名常量比较，见 no-magic-string-compare）
    if (quality !== EXPERIENCE_QUALITY.VERIFIED && quality !== EXPERIENCE_QUALITY.SUSPECT) return;
    if (!reviewReason.trim()) {
      setReviewError(t('review.reasonRequired'));
      return;
    }
    setReviewError(null);
    setReviewPending(quality);
    try {
      await Api.experiences.updateQuality(id, { quality, reason: reviewReason.trim() });
      setReviewReason('');
      await queryClient.invalidateQueries({ queryKey: ['experiences', 'detail', id] });
      // 侧栏待终审角标（facets.byQuality.unverified）+ 列表口径都要跟着变
      await queryClient.invalidateQueries({ queryKey: ['experiences', 'facets'] });
      await queryClient.invalidateQueries({ queryKey: ['experiences', 'list'] });
      toast.success({
        title:
          quality === EXPERIENCE_QUALITY.VERIFIED ? t('review.verified') : t('review.suspected'),
      });
    } catch (err) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setReviewError(axiosErr?.response?.data?.message || t('review.failed'));
    } finally {
      setReviewPending(null);
    }
  };

  /** 删除（软删）：确认后 DELETE 并跳回列表 */
  const handleDelete = async () => {
    const ok = await confirm({
      title: t('detail.deleteConfirmTitle'),
      description: t('detail.deleteConfirmDesc'),
      confirmText: tCommon('delete'),
      cancelText: tCommon('cancel'),
      // 破坏性操作 → 红色确认钮（AlertDialog 契约）
      confirmVariant: 'danger',
    });
    if (!ok) return;
    try {
      await Api.experiences.remove(id);
      toast.success({ title: t('detail.deleted') });
      await queryClient.invalidateQueries({ queryKey: ['experiences'] });
      router.push('/experiences');
    } catch (err) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      toast.error({
        title: axiosErr?.response?.data?.message || t('detail.deleteFailed'),
      });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4 p-4 md:p-6" data-testid="experience-detail-loading">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !entry) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          title={t('detail.notFound')}
          description={t('detail.notFoundDesc')}
          action={
            <Button onClick={() => router.push('/experiences')}>{t('detail.notFoundBack')}</Button>
          }
        />
      </div>
    );
  }

  const envRows = experienceEnvRows(entry.env);

  /** 录入者 / 终审人三态（规则唯一实现在 `lib/experience`，卡片/详情/筛选下拉共用一份） */
  const creator = experienceActorLabel({
    id: entry.createdById,
    name: entry.createdByName,
    deletedAt: entry.createdByDeletedAt,
  });
  const verifier = experienceActorLabel({
    id: entry.verifiedBy,
    name: entry.verifiedByName,
    deletedAt: entry.verifiedByDeletedAt,
  });
  /** 录入者类型小字（显式字面量映射：next-intl 的 key 有编译期校验，禁动态拼） */
  const creatorTypeLabel = entry.createdByType
    ? {
        [ActorType.HUMAN]: t('creator.type.human'),
        [ActorType.AGENT]: t('creator.type.agent'),
        [ActorType.SYSTEM]: t('creator.type.system'),
      }[entry.createdByType]
    : '';
  /**
   * 头像 actorType（Avatar 只认 human/agent）：agent 叠 Bot 角标，human 与未传同档。
   * `system` 没有"身份角标"的视觉语义 → 按不传处理（类型仍由旁边文字表达，不丢信息）。
   */
  const creatorAvatarType =
    entry.createdByType === ActorType.AGENT || entry.createdByType === ActorType.HUMAN
      ? entry.createdByType
      : undefined;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link
        href="/experiences"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('detail.back')}
      </Link>

      <header className="space-y-3">
        <h1 className="text-xl font-semibold leading-snug">{entry.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={experienceIntentBadgeVariant(entry.intent)}>{intentLabel}</Badge>
          {/* 质量标记：verified = 加权可信 / unverified = 缺省 / suspect = 默认检索排除 */}
          <Badge
            variant={experienceQualityBadgeVariant(entry.quality)}
            data-testid="experience-detail-quality"
          >
            {qualityLabel}
          </Badge>
          {/* 过期标记：过期条目在列表默认隐藏，但详情照常可见（复核动线） */}
          {entry.expired && (
            <Badge variant="destructive" data-testid="experience-detail-expired">
              <Clock className="mr-1 h-3 w-3" />
              {t('expired')}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">{entry.summary}</span>
        </div>

        {/* 反馈区：语义是「应用后是否有效」；过期条目后端拒绝反馈（409） */}
        <div className="flex flex-wrap items-center gap-2" data-testid="experience-feedback">
          <Button
            variant={myOutcome === 'helped' ? 'default' : 'outline'}
            size="sm"
            data-testid="experience-feedback-helped"
            disabled={feedbackPending || entry.expired}
            onClick={() => void submitFeedback('helped')}
          >
            <ThumbsUp className="mr-1.5 h-3.5 w-3.5" />
            {t('feedback.helped')}
          </Button>
          <Button
            variant={myOutcome === 'not_helpful' ? 'default' : 'outline'}
            size="sm"
            data-testid="experience-feedback-not-helpful"
            disabled={feedbackPending || entry.expired}
            onClick={() => void submitFeedback('not_helpful')}
          >
            <ThumbsDown className="mr-1.5 h-3.5 w-3.5" />
            {t('feedback.notHelpful')}
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="experience-feedback-counts">
            {t('feedback.helpedCount', { count: entry.helpedCount })} ·{' '}
            {/* 「没帮到」计数也要展示（评审 minor 10）：只看 helped 会让读者误判效果 */}
            {t('feedback.notHelpfulCount', { count: entry.notHelpfulCount })} ·{' '}
            {t('feedback.distinctCount', { count: entry.distinctHelpedCount })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {entry.expired ? t('feedback.expiredNotice') : t('feedback.hint')}
        </p>

        {/* 编辑/删除：仅 admin | creator | owner 代理可见（后端同权，越权必 403/13001） */}
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="experience-edit-button"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              {t('detail.edit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="experience-delete-button"
              onClick={() => void handleDelete()}
              className="text-destructive"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('detail.delete')}
            </Button>
          </div>
        )}
      </header>

      {/* xl 以上两栏（正文 + 元信息），xl 以下单栏堆叠 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <article className="glass-flat rounded-lg border border-border/60 p-4">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">{t('detail.content')}</h2>
          {/* markdown 现栈渲染：禁 rehype-raw / dangerouslySetInnerHTML（全员可读内容的安全红线）。
              components 走共享工厂（评审 minor 4）：docs 页/消息气泡/doc-editor 三处统一，
              img 覆盖为 AttachmentImage（附件 URL 裸 <img> 会 401）、外链补 rel=noreferrer */}
          <div className={`text-sm ${MARKDOWN_CLASSES}`} data-testid="experience-detail-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {entry.content}
            </ReactMarkdown>
          </div>
        </article>

        <aside className="space-y-3">
          {/* 元信息：信号 / 领域 / 环境指纹 / 来源 / 时间线 */}
          <section className="glass-flat space-y-2 rounded-lg border border-border/60 p-4 text-xs">
            <div>
              <p className="text-muted-foreground">{t('detail.signals')}</p>
              <p className="mt-1 font-mono text-[11px]">
                {entry.signals.join(' · ') || t('detail.none')}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">{t('detail.domains')}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {entry.domains.length > 0
                  ? entry.domains.map((d) => (
                      <span key={d} className="rounded-full bg-foreground/10 px-2 py-0.5">
                        {d}
                      </span>
                    ))
                  : t('detail.none')}
              </div>
            </div>
            <div>
              <p className="text-muted-foreground">{t('detail.env')}</p>
              <ul className="mt-1 space-y-0.5">
                {envRows.length > 0
                  ? envRows.map((row) => (
                      <li key={row.key}>
                        <span className="text-muted-foreground">{row.key}:</span> {row.value}
                      </li>
                    ))
                  : t('detail.none')}
              </ul>
            </div>
            <div>
              <p className="text-muted-foreground">{t('detail.sourceProject')}</p>
              <p className="mt-1">{entry.sourceProject || t('detail.none')}</p>
            </div>
            {/*
              录入者行（v1.81.0）：sm 头像 + 名字 + 类型小字（sm 头像带 Bot 角标 → 类型
              文字是补充而非重复：角标只说"是 agent"，文字覆盖 human/system 与可读性）。
              三态同规则（`experienceActorLabel`）：软删保留真名 + 「已删除」小字（title 解释）；
              孤儿显示 id 前 8 位 + 头像 title 解释；**双缺失整行隐藏**（连"录入者"标签一起）。
            */}
            {creator.visible && (
              <div data-testid="experience-detail-creator">
                <p className="text-muted-foreground">{t('detail.createdBy')}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Avatar
                    size="sm"
                    seed={entry.createdById}
                    actorType={creatorAvatarType}
                    fallback={creator.name}
                    deleted={creator.deleted}
                    title={creator.orphan ? t('creator.orphanHint') : undefined}
                  />
                  <span
                    className={cn('min-w-0 truncate text-[11px]', creator.deleted && 'opacity-60')}
                    title={creator.title}
                    data-testid="experience-detail-creator-name"
                  >
                    {creator.name}
                  </span>
                  {creator.deleted && (
                    <span
                      className="shrink-0 text-[10px] text-muted-foreground/70"
                      title={t('creator.deletedHint')}
                      data-testid="experience-detail-creator-deleted"
                    >
                      {tCommon('deleted')}
                    </span>
                  )}
                  {creatorTypeLabel && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {creatorTypeLabel}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div>
              {/* 录入时间：i18n 键自第二期就存在但一直没渲染（归属信息缺一环，v1.81.0 补上） */}
              <p className="text-muted-foreground">{t('detail.createdAt')}</p>
              <p className="mt-1" data-testid="experience-detail-created-at">
                {formatDate(entry.createdAt, locale)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">{t('detail.updatedAt')}</p>
              <p className="mt-1" data-testid="experience-detail-updated-at">
                {formatDate(entry.updatedAt, locale)}
              </p>
            </div>
            <div>
              {/* 终审人：未终审 → 「—」；三态同规则（软删保留真名 + 标记，title 给完整 UUID） */}
              <p className="text-muted-foreground">{t('detail.verifiedBy')}</p>
              <p className="mt-1" data-testid="experience-detail-verified-by">
                {verifier.visible ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn('truncate text-[11px]', verifier.deleted && 'opacity-60')}
                      title={verifier.title}
                    >
                      {verifier.name}
                    </span>
                    {verifier.deleted && (
                      <span
                        className="shrink-0 text-[10px] text-muted-foreground/70"
                        title={t('creator.deletedHint')}
                        data-testid="experience-detail-verified-deleted"
                      >
                        {tCommon('deleted')}
                      </span>
                    )}
                  </span>
                ) : (
                  t('detail.none')
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">{t('detail.verifiedAt')}</p>
              <p className="mt-1">
                {entry.verifiedAt ? formatDate(entry.verifiedAt, locale) : t('detail.none')}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">{t('form.expiresAt')}</p>
              <p className="mt-1">
                {entry.expiresAt ? formatDate(entry.expiresAt, locale) : t('neverExpires')}
              </p>
            </div>
          </section>

          {/*
            终审区（v1.81.0：**服务端单源两态**）。
            `viewerCanReview` 由后端判定（禁自审四态已退役，现为**纯角色判定**：人类 admin
            或经验空间 owner/reviewer）——web **不做任何成员/自审匹配计算**，只按结论渲染：
              ① true  → 按钮组（双向门；suspect 条目照常显示本区，UI 不得藏入口）。
                        自审权已放开：本人所录条目也可在此终审（verified 语义随之降级为
                        "至少一位终审人确认过"，卡片质量徽章的释义文案同批改过）；
              ② false → "仅 admin 或经验库终审人可终审"（缺角色；错误码 13004）。
                        `false` 只代表缺角色，**不再**代表"你不能审自己的条目"。
              undefined（旧响应/迁移窗口）→ **fail-closed**：按 ② 同档处理、不显示按钮组——
                                  宁可少给一个入口，也不猜权限（按钮点了必 403，且误显示会让
                                  用户以为有权限）。取舍写在这里，便于后来人复核。

            ⚠️ 已移除字段：`viewerReviewBlockReason` 自 v1.81.0 停发。它的消失**不等于**
            你不能审——旧客户端若仍在读它只会落进 undefined 分支，与本区两态判定自洽。
          */}
          <section
            className="glass-flat space-y-2 rounded-lg border border-border/60 p-4"
            data-testid="experience-review-panel"
          >
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <ShieldCheck className="h-4 w-4" />
              {t('review.title')}
            </p>
            {entry.viewerCanReview === true ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t('review.current', { quality: qualityLabel })}
                </p>
                <Input
                  data-testid="experience-review-reason"
                  value={reviewReason}
                  placeholder={t('review.reasonPlaceholder')}
                  onChange={(e) => setReviewReason(e.target.value)}
                />
                {reviewError && (
                  <p className="text-xs text-destructive" data-testid="experience-review-error">
                    {reviewError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    data-testid="experience-review-verify"
                    disabled={reviewPending !== null}
                    onClick={() => void submitReview('verified')}
                  >
                    {t('review.verify')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="experience-review-suspect"
                    disabled={reviewPending !== null}
                    onClick={() => void submitReview('suspect')}
                  >
                    {t('review.suspect')}
                  </Button>
                </div>
              </>
            ) : (
              // 缺角色（含 viewerCanReview 缺失的 fail-closed 档）：只说明资格要求，不给入口。
              // 自 v1.81.0 起这里是**唯一**的"不可审"文案——禁自审态整体退役，原先的
              // 身份分叉（admin 去指派 / 非 admin 联系 admin）连同 `review.selfReviewForbidden*`
              // 与跳转按钮一并删除（plan 工作流 0：规则不再制造死锁，缺角色走 13004）。
              <p className="text-xs text-muted-foreground" data-testid="experience-review-denied">
                {t('review.onlyAdmin')}
              </p>
            )}
          </section>

          {/*
            机器初评（judgment）面板：**人类终审为主、机器初评为辅**（故置于终审区之后）。
            三条渲染纪律：
            - 七维**均可为 null**（批 3 起 shared 类型可空：非法/缺失维度服务端置 null）→ 逐维判空，
              无该维就整行不渲染（不显示"—"占位，避免读成"评分是空的"）；
            - `judgmentSuppressed === true`（可审人 + 条目未终审）→ 服务端已把 judgment 置 null，
              web 只渲染标记文案（防锚定主防线在服务端，这里不做任何"要不要展示"的判断）；
            - rubric 代际小字（v1.82.0）只在快照带 `rubricVersion` 时渲染：v1 旧快照无该字段，
              不显示比显示 "v1" 更诚实（缺省语义见 shared 类型的 rubricVersion 注释）。
          */}
          <section
            className="glass-flat space-y-2 rounded-lg border border-border/60 p-4 text-xs"
            data-testid="experience-judgment-panel"
          >
            <p className="flex items-baseline gap-2 font-medium">
              {t('judgment.title')}
              {/*
                rubric 代际小字（v1.82.0 起）：只在快照带 rubricVersion 时显示——
                v1 旧快照无该字段（缺省语义 = 六维代际），此时不显示比显示 "v1" 更诚实。
              */}
              {entry.judgment?.rubricVersion ? (
                <span
                  className="text-[10px] font-normal text-muted-foreground"
                  data-testid="experience-judgment-rubric-version"
                >
                  {t('judgment.rubricVersion', { version: entry.judgment.rubricVersion })}
                </span>
              ) : null}
            </p>
            {entry.judgmentSuppressed === true ? (
              <p className="text-muted-foreground" data-testid="experience-judgment-suppressed">
                {t('judgment.suppressed')}
              </p>
            ) : entry.judgment ? (
              <ul className="space-y-1" data-testid="experience-judgment-body">
                {judgmentRows.map((row) => (
                  <li key={row.label} className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">{row.label}</span>
                    {/* tone（准入三态）优先于 highlight（既有六维加重）：两者不会同时出现 */}
                    <span
                      className={
                        row.tone
                          ? JUDGMENT_ADMISSION_TONE_CLASS[row.tone]
                          : row.highlight
                            ? 'font-medium text-amber-300'
                            : ''
                      }
                    >
                      {row.value}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground" data-testid="experience-judgment-none">
                {t('detail.none')}
              </p>
            )}
          </section>
        </aside>
      </div>

      {/* 编辑：复用录入 Dialog 的编辑模式（同组件两模式）；onSaved 后失效详情/列表/分面 */}
      <ExperienceFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        entry={entry}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['experiences', 'detail', id] });
          void queryClient.invalidateQueries({ queryKey: ['experiences', 'list'] });
          void queryClient.invalidateQueries({ queryKey: ['experiences', 'facets'] });
        }}
      />
    </div>
  );
}

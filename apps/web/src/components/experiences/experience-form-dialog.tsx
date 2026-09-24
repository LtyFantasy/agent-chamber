'use client';

/**
 * 经验库录入 / 编辑 Dialog（一个组件两种模式）
 *
 * 模式判定：`entry` 为空 = **录入**（POST /experiences，恒 unverified）；传入详情 =
 * **编辑**（PATCH /experiences/:id，必带 `expectedUpdatedAt` 乐观锁）。
 *
 * 关键设计：
 * 1. **表单体按 key 重挂载**（`key={entry?.id ?? 'create'}`）：初始值走 `useState`
 *    初始化器，不用「打开时 setState 的 useEffect」——那种写法在 `t` 等不稳定依赖下会
 *    每次渲染重跑 effect，触发 Maximum update depth（实测踩过）。重挂载语义还天然正确：
 *    换条目/切模式 = 换一份表单，不存在残留脏值。
 * 2. **四节模板预填**（Symptom / Root cause / Fix / How verified，按当前语言生成）——
 *    后端对缺「验证方式」节只软告警不拒绝，预填即让默认路径不产生无意义告警。
 * 3. **幂等键按 payload 派生**（`idempotencyKeyFor`）：同 payload 重试沿用同一个
 *    `clientRequestId`（超时重发 → 后端重放首次响应，不会产生重复条目）；一旦用户
 *    改了内容就换新键（同键不同 payload 会被后端 409/9002 拒绝——把"改了再交"
 *    误判成重放是更坏的失败）。
 * 4. **软提示不阻断**：录入响应里的 `warnings`（如缺验证方式节）与
 *    `possibleDuplicates`（疑似重复）都展示在成功面板里，条已落库、可继续。收口动作
 *    （onSaved 刷新 + 成功 toast）在**落库成功时立即完成**，结果面板只负责展示提示。
 * 5. 编辑 409 = 期间他人改过 → 重读最新版本（invalidate detail，父级 entry 更新）+
 *    提示「已重载最新版本，确认后重新提交」；表单内容保留，重提交用新的
 *    `expectedUpdatedAt`（禁止同 token 盲重试）。
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  EXPERIENCE_CONTENT_MAX_LENGTH,
  EXPERIENCE_INTENT,
  EXPERIENCE_INTENTS,
  EXPERIENCE_SUMMARY_MAX_LENGTH,
  EXPERIENCE_TITLE_MAX_LENGTH,
  type ExperienceDetail,
  type ExperienceEnv,
  type ExperienceEnvKey,
  type ExperienceIntent,
  type RecordExperienceResponse,
} from '@/types';
import { Api } from '@/lib/api';
import { toast } from '@/lib/notify';
import {
  EXPERIENCE_ENV_KEY_ORDER,
  EXPERIENCE_MAX_DOMAINS,
  EXPERIENCE_MAX_SIGNALS,
  EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH,
  buildExperienceContentTemplate,
  newClientRequestId,
} from '@/lib/experience';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ExperienceChipInput } from './experience-chip-input';

interface ExperienceFormDialogProps {
  /** 开关（受控） */
  open: boolean;
  /** 开关回调 */
  onOpenChange: (open: boolean) => void;
  /** 传入 = 编辑模式（预填 + PATCH）；不传/传 null = 录入模式 */
  entry?: ExperienceDetail | null;
  /**
   * 写入成功即触发（父组件据此失效查询）。
   *
   * 时序：**落库成功立刻回调**，不等结果面板关闭——用户经遮罩关窗也必须已完成刷新
   * （评审 B2：结果面板是"读软提示"的停留层，不是收口条件）。
   */
  onSaved?: () => void;
}

/** env 四键的空初值（键固定不可改，值可空） */
const EMPTY_ENV: Record<ExperienceEnvKey, string> = { os: '', tool: '', version: '', runtime: '' };

/** 表单错误信息（优先透传服务端 message；409 走专用文案） */
function formErrorMessage(err: unknown, fallback: string, conflictText: string): string {
  const axiosErr = err as { response?: { status?: number; data?: { message?: string } } };
  if (axiosErr?.response?.status === 409) return conflictText;
  return axiosErr?.response?.data?.message || fallback;
}

/**
 * 表单体（仅在 Dialog 打开时挂载；`key` 变化即整份重挂载 = 重新初始化）
 *
 * 拆成独立组件是为了让初始值走 `useState` 初始化器而非 effect——见文件头第 1 条。
 */
function ExperienceFormBody({
  entry,
  onClose,
  onSaved,
}: {
  entry?: ExperienceDetail | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useTranslations('experiences');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const isEdit = !!entry;

  /** intent 值 → 展示标签（显式字面量：next-intl v4 的 key 有编译期校验，禁动态拼） */
  const INTENT_LABELS: Record<ExperienceIntent, string> = {
    pitfall: t('intent.pitfall'),
    repair: t('intent.repair'),
    howto: t('intent.howto'),
    optimize: t('intent.optimize'),
    decision: t('intent.decision'),
  };

  const [title, setTitle] = useState(entry?.title ?? '');
  const [summary, setSummary] = useState(entry?.summary ?? '');
  const [content, setContent] = useState(() =>
    entry
      ? entry.content
      : buildExperienceContentTemplate({
          symptom: t('form.sectionSymptom'),
          rootCause: t('form.sectionRootCause'),
          fix: t('form.sectionFix'),
          howVerified: t('form.sectionHowVerified'),
        }),
  );
  const [intent, setIntent] = useState<ExperienceIntent>(entry?.intent ?? EXPERIENCE_INTENT.REPAIR);
  const [signals, setSignals] = useState<string[]>(entry?.signals ?? []);
  const [domains, setDomains] = useState<string[]>(entry?.domains ?? []);
  const [env, setEnv] = useState<Record<ExperienceEnvKey, string>>(() =>
    entry
      ? {
          os: entry.env?.os ?? '',
          tool: entry.env?.tool ?? '',
          version: entry.env?.version ?? '',
          runtime: entry.env?.runtime ?? '',
        }
      : EMPTY_ENV,
  );
  const [expiresAt, setExpiresAt] = useState(() =>
    entry?.expiresAt ? new Date(entry.expiresAt).toISOString().slice(0, 10) : '',
  );
  const [sourceProject, setSourceProject] = useState(entry?.sourceProject ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 录入成功后的响应（含 warnings/possibleDuplicates 软提示；命中时展示结果面板） */
  const [result, setResult] = useState<RecordExperienceResponse | null>(null);
  /** 幂等键缓存：{ 本次 payload 签名, 对应 clientRequestId } */
  const idempotencyRef = useRef<{ signature: string; key: string }>({ signature: '', key: '' });

  /**
   * payload 签名 → 幂等键（同签名复用、异签名换新）
   *
   * @param signature - 本次提交 payload 的稳定序列化
   * @returns 该 payload 专属的 clientRequestId
   */
  const idempotencyKeyFor = (signature: string): string => {
    if (idempotencyRef.current.signature !== signature) {
      idempotencyRef.current = { signature, key: newClientRequestId() };
    }
    return idempotencyRef.current.key;
  };

  /** env 表单一 → 提交用 env 对象（只保留非空值；空对象不发送） */
  const buildEnv = (): ExperienceEnv | undefined => {
    const payload: ExperienceEnv = {};
    for (const key of EXPERIENCE_ENV_KEY_ORDER) {
      const value = env[key].trim();
      if (value) payload[key] = value;
    }
    return Object.keys(payload).length > 0 ? payload : undefined;
  };

  /**
   * 过期日期（date input 的 yyyy-mm-dd）→ ISO 8601
   *
   * 语义：用户选的是"哪一天到期"，取该日 **UTC 当日末刻**（23:59:59.999Z）——既避免
   * 选当天却被判"已过期"（后端要求 expiresAt > now），也避免把一天解释成零点带来的
   * 一整天的意外提前过期。
   *
   * @param value - date input 值（空串 = 永不过期）
   * @returns ISO 8601 字符串或 null（编辑态清空 → 显式 null 让后端置为永不过期）
   */
  const buildExpiresAt = (): string | null => {
    if (!expiresAt) return null;
    return new Date(`${expiresAt}T23:59:59.999Z`).toISOString();
  };

  /** 提交（录入 / 编辑分派） */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !summary.trim() || !content.trim() || signals.length === 0) {
      setError(t('form.requiredHint'));
      return;
    }

    const envPayload = buildEnv();
    const expiresPayload = buildExpiresAt();
    setIsSubmitting(true);
    try {
      if (entry) {
        await Api.experiences.update(entry.id, {
          title: title.trim(),
          summary: summary.trim(),
          content,
          intent,
          signals,
          domains,
          env: envPayload ?? {},
          // 清空来源项目 → 显式 null（后端语义 = 清除该字段；空串不是合法值）
          sourceProject: sourceProject.trim() ? sourceProject.trim() : null,
          expiresAt: expiresPayload,
          // 提交时读**最新 props** 的 updatedAt：409 重读后父级 entry 已更新而表单体
          // 不重挂载（key 不含 updatedAt），故本次取到的就是服务端最新版本时间戳
          expectedUpdatedAt: String(entry.updatedAt),
        });
        toast.success({ title: t('form.updateSuccess') });
        onClose();
        onSaved?.();
        return;
      }

      // 幂等键从**实际发送的载荷**派生（评审 minor 8）：签名若用未 trim 的输入，
      // 首尾空白一改就换新键 —— 同效载荷会被判成新录入，幂等性形同虚设
      const payload = {
        title: title.trim(),
        summary: summary.trim(),
        content,
        intent,
        signals,
        domains: domains.length > 0 ? domains : undefined,
        env: envPayload,
        sourceProject: sourceProject.trim() || undefined,
        expiresAt: expiresPayload ?? undefined,
      };
      const created = await Api.experiences.create({
        ...payload,
        clientRequestId: idempotencyKeyFor(JSON.stringify(payload)),
      });
      // 条目已落库 ⇒ **立刻**收口：通知父级刷新（列表/分面）+ 成功提示。
      // 结果面板只是"读软提示"的停留层，用户经遮罩关闭（不走 closeResult）时
      // 也必须已完成刷新与提示（评审 B2）
      onSaved?.();
      toast.success({ title: t('form.createSuccess') });
      // 结果面板切换条件（第二期扩展）：软提示 warnings/possibleDuplicates 任一非空，
      // **或**机器初评 judgment 非 null（observe 期软判定——同样是"录入已成功、还有话要说"）
      if (created.warnings?.length || created.possibleDuplicates?.length || created.judgment) {
        setResult(created);
        return;
      }
      onClose();
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // 乐观锁冲突的恢复路径（评审 M3）：重读最新版本（invalidate → 父级 entry 更新），
      // 用户本次编辑内容保留在表单里，确认后重新提交即用新的 expectedUpdatedAt。
      // 不做这一步的话详情缓存 staleTime 5 分钟，关窗再开仍是旧 token → 永远 409。
      if (status === 409 && entry) {
        await queryClient.invalidateQueries({ queryKey: ['experiences', 'detail', entry.id] });
      }
      setError(
        formErrorMessage(
          err,
          isEdit ? t('form.updateFailed') : t('form.createFailed'),
          t('form.conflict'),
        ),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  /** 关闭结果面板（收口动作已在录入成功时完成，此处只关窗） */
  const closeResult = () => {
    onClose();
  };

  // ── 录入成功后的软提示面板（warnings / possibleDuplicates 都不阻断——条已落库） ──
  if (result) {
    return (
      <div className="mt-4 space-y-3" data-testid="experience-form-result">
        <p className="text-sm text-emerald-300">{t('form.createSuccess')}</p>
        {result.warnings && result.warnings.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs font-medium text-amber-300">{t('form.warnings')}</p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {result.possibleDuplicates && result.possibleDuplicates.length > 0 && (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3">
            <p className="text-xs font-medium">{t('form.possibleDuplicates')}</p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {result.possibleDuplicates.map((dup) => (
                <li key={dup.id}>{dup.title}</li>
              ))}
            </ul>
          </div>
        )}
        {result.judgment && (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3">
            <p className="text-xs font-medium">{t('judgment.title')}</p>
            {/* 只列"可行动的"软提示（低分维度 + 归类建议）——全量七维在详情页看，
                录入结果面板的任务是"告诉你还有哪里值得改"，不是复刻详情页 */}
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {result.judgment.completeness &&
                (result.judgment.completeness.level === 'missing' ||
                  result.judgment.completeness.level === 'thin') && (
                  <li data-testid="experience-result-judgment-completeness">
                    {t('judgment.dimension.completeness')}:{' '}
                    {result.judgment.completeness.level === 'missing'
                      ? t('judgment.level.missing')
                      : t('judgment.level.thin')}
                  </li>
                )}
              {result.judgment.signalQuality &&
                (result.judgment.signalQuality.level === 'noise' ||
                  result.judgment.signalQuality.level === 'weak') && (
                  <li data-testid="experience-result-judgment-signal">
                    {t('judgment.dimension.signalQuality')}:{' '}
                    {result.judgment.signalQuality.level === 'noise'
                      ? t('judgment.level.noise')
                      : t('judgment.level.weak')}
                  </li>
                )}
              {result.judgment.duplicate && result.judgment.duplicate.verdict !== 'distinct' && (
                <li data-testid="experience-result-judgment-duplicate">
                  {t('judgment.dimension.duplicate')}:{' '}
                  {result.judgment.duplicate.verdict === 'likely_duplicate'
                    ? t('judgment.verdict.likely_duplicate')
                    : t('judgment.verdict.possible_duplicate')}
                </li>
              )}
              {result.judgment.intentSuggestion?.verdict === 'suggested' &&
                result.judgment.intentSuggestion.value && (
                  <li data-testid="experience-result-judgment-intent">
                    {t('judgment.dimension.intentSuggestion')}:{' '}
                    {t('judgment.verdict.suggested', {
                      value: result.judgment.intentSuggestion.value,
                    })}
                  </li>
                )}
              {result.judgment.domainSuggestion?.verdict === 'suggested' &&
                result.judgment.domainSuggestion.value && (
                  <li data-testid="experience-result-judgment-domain">
                    {t('judgment.dimension.domainSuggestion')}:{' '}
                    {t('judgment.verdict.suggested', {
                      value: result.judgment.domainSuggestion.value,
                    })}
                  </li>
                )}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">{t('judgment.resultHint')}</p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={closeResult}>
            {tCommon('close')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-4">
      {/* 密钥警告：经验库对所有认证主体可读，密钥/PII 是硬红线（后端另有模式闸门兜底） */}
      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300">
        {t('form.secretWarning')}
      </p>

      <div className="space-y-1.5">
        <label htmlFor="exp-title" className="text-sm font-medium">
          {t('form.title')}
        </label>
        <Input
          id="exp-title"
          data-testid="experience-form-title"
          value={title}
          maxLength={EXPERIENCE_TITLE_MAX_LENGTH}
          placeholder={t('form.titlePlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="exp-summary" className="text-sm font-medium">
          {t('form.summary')}
        </label>
        <textarea
          id="exp-summary"
          data-testid="experience-form-summary"
          value={summary}
          maxLength={EXPERIENCE_SUMMARY_MAX_LENGTH}
          placeholder={t('form.summaryPlaceholder')}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          className="flex w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          required
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="exp-intent" className="text-sm font-medium">
          {t('form.intent')}
        </label>
        <select
          id="exp-intent"
          data-testid="experience-form-intent"
          value={intent}
          onChange={(e) => setIntent(e.target.value as ExperienceIntent)}
          className="h-10 w-full rounded-md border border-input bg-background/60 px-2 text-sm"
        >
          {/* 类型下拉：五值受控词表（shared 单源），标签经 INTENT_LABELS 显式映射 */}
          {EXPERIENCE_INTENTS.map((value) => (
            <option key={value} value={value}>
              {INTENT_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <ExperienceChipInput
        label={t('form.signals')}
        hint={t('form.signalsHint')}
        placeholder={t('form.signalsPlaceholder')}
        values={signals}
        onChange={setSignals}
        max={EXPERIENCE_MAX_SIGNALS}
        testId="experience-form-signals"
      />

      <ExperienceChipInput
        label={t('form.domains')}
        hint={t('form.domainsHint')}
        placeholder={t('form.domainsPlaceholder')}
        values={domains}
        onChange={setDomains}
        max={EXPERIENCE_MAX_DOMAINS}
        testId="experience-form-domains"
      />

      <div className="space-y-1.5">
        <label htmlFor="exp-content" className="text-sm font-medium">
          {t('form.content')}
        </label>
        <textarea
          id="exp-content"
          data-testid="experience-form-content"
          value={content}
          maxLength={EXPERIENCE_CONTENT_MAX_LENGTH}
          placeholder={t('form.contentPlaceholder')}
          onChange={(e) => setContent(e.target.value)}
          rows={10}
          className="flex w-full rounded-md border border-input bg-background/60 px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          required
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('form.env')}</legend>
        <p className="text-xs text-muted-foreground">{t('form.envHint')}</p>
        {/* env 四键固定行：键不可改（受控键是匹配语义的基础），值可空 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="exp-env-os" className="text-xs text-muted-foreground">
              {t('form.envOs')}
            </label>
            <Input
              id="exp-env-os"
              value={env.os}
              onChange={(e) => setEnv((prev) => ({ ...prev, os: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="exp-env-tool" className="text-xs text-muted-foreground">
              {t('form.envTool')}
            </label>
            <Input
              id="exp-env-tool"
              value={env.tool}
              onChange={(e) => setEnv((prev) => ({ ...prev, tool: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="exp-env-version" className="text-xs text-muted-foreground">
              {t('form.envVersion')}
            </label>
            <Input
              id="exp-env-version"
              value={env.version}
              onChange={(e) => setEnv((prev) => ({ ...prev, version: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="exp-env-runtime" className="text-xs text-muted-foreground">
              {t('form.envRuntime')}
            </label>
            <Input
              id="exp-env-runtime"
              value={env.runtime}
              onChange={(e) => setEnv((prev) => ({ ...prev, runtime: e.target.value }))}
            />
          </div>
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="exp-expires" className="text-sm font-medium">
            {t('form.expiresAt')}
          </label>
          <Input
            id="exp-expires"
            data-testid="experience-form-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('form.expiresAtHint')}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="exp-source" className="text-sm font-medium">
            {t('form.sourceProject')}
          </label>
          <Input
            id="exp-source"
            data-testid="experience-form-source-project"
            value={sourceProject}
            maxLength={EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH}
            placeholder={t('form.sourceProjectPlaceholder')}
            onChange={(e) => setSourceProject(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" data-testid="experience-form-error">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
          {tCommon('cancel')}
        </Button>
        <Button type="submit" data-testid="experience-form-submit" disabled={isSubmitting}>
          {isSubmitting
            ? t('form.submitting')
            : isEdit
              ? t('form.submitEdit')
              : t('form.submitCreate')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ExperienceFormDialog({ open, onOpenChange, entry, onSaved }: ExperienceFormDialogProps) {
  const t = useTranslations('experiences');
  const isEdit = !!entry;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>{isEdit ? t('form.editTitle') : t('form.createTitle')}</DialogTitle>
        {isEdit && <DialogDescription>{t('form.editIntro')}</DialogDescription>}
      </DialogHeader>
      {/* key = 条目 id / 'create'：换条目或切模式即整份重挂载，初始值由 useState 初始化器给出 */}
      {open && (
        <ExperienceFormBody
          key={entry?.id ?? 'create'}
          entry={entry}
          onClose={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

export { ExperienceFormDialog };

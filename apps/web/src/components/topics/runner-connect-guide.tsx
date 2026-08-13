'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §8c（最后一公里连接向导）
 *   - 补充: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位管理 UI）
 *
 * [踩坑索引]
 *   - 启动命令的 platform-url 曾取 window.location.origin（dev 是 8742 web）——
 *     runner 要连 backend（8743），必须经 lib/platform-url.ts 推导
 *   - 座位 presence 只在「活动事件」时由 chamber 写入（认领不写）——验收环③
 *     presence 缺失不得视为不存活，否则用户永远等不到「去 @ 它试试」
 *   - web 无 toast 体系：复制反馈用内联瞬态文案（message-bubble「已复制」同款）
 *   - API Key 仅存 React state，不落盘不发请求（密钥不落 UI 的既有纪律）
 *
 * [铁律关联] #7(视觉克制) #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { Api, type RoundtableSeatItem } from '@/lib/api';
import { getRunnerPlatformUrl } from '@/lib/platform-url';
import { useSeatPresence } from '@/lib/use-seat-presence';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** 验收环轮询间隔（ms）：与 useSeatPresence 同节奏的轻量心跳 */
const GUIDE_POLL_INTERVAL_MS = 5000;

/**
 * R5 卡死诊断超时：runner 已在线但座位持续不被认领的判定时长（ms）。
 * 认领条件 = runner hello.vendors 含座位 vendor + runner agent 与座位 bindActorId
 * 匹配——超过此时长大概率是 API Key 不属于座位绑定的 agent。
 */
const CLAIM_TIMEOUT_MS = 90_000;

/** API Key 未填写时注入指令/命令的占位符（与 install-runner.sh 占位同风格） */
const API_KEY_PLACEHOLDER = '<AGENT_API_KEY>';

interface RunnerConnectGuideProps {
  /** 座位（management 场景 = seats 轮询列表中的未认领实体；dialog 场景 = 刚创建的实体）。runnerId/presence 为初始值，验收环以轮询 live 数据为准 */
  seat: RoundtableSeatItem;
  /** 圆桌 topic UUID（seats 轮询 key） */
  topicId: string;
  /** 初始展开态；false = 收起成「连接指引」常驻按钮（轮询随展开启停） */
  defaultOpen?: boolean;
  /** 验收全绿后「去 @ 它试试」的附加动作（如关闭外层面板）；可选 */
  onExit?: () => void;
}

/**
 * 圆桌「最后一公里」连接向导（v1.51.0，plan §1.3）：
 * 全新用户在 Web 端建好座位后不再卡在「然后怎么办」——UI 内嵌双路径
 * （A 复制给 Agent 的指令 / B 人类一行命令）+ 平台数据自动验收连接结果。
 *
 * 数据契约（全部按座位 vendor 感知）：
 * - runners：GET /roundtable/runners 5s 轮询（open 才启，与 seat-management
 *   同 key 共享缓存）；
 * - seats：useSeatPresence 同 key 5s 轮询（与 SeatPresenceBar 同源，零额外请求），
 *   按 seat.id 匹配 live 实体——只认本座位 runnerId/presence 变化（误报防护）。
 *
 * 验收环三级递进：① 匹配 vendor 的 runner 上线 → ② 座位被认领（runnerId != null）
 * → ③ presence 存活（非 offline；缺失 = 从未活动，不算不存活——presence 只在
 * 活动事件时写入，认领不写，严格口径会永久卡在③）。全绿后「去 @ 它试试」=
 * 复制 `@label ` 到剪贴板 + 提示（话题页 composer 无预填机制，见汇报选型）。
 *
 * R5 卡死诊断：runner 在线但 90s 未认领 → amber 提示检查 API Key 归属。
 */
export function RunnerConnectGuide({
  seat,
  topicId,
  defaultOpen = true,
  onExit,
}: RunnerConnectGuideProps) {
  const t = useTranslations('topics');
  const locale = useLocale();

  // ── 展开态（轮询生命周期开关：展开才轮询，收起/卸载即停）──
  const [expanded, setExpanded] = useState(defaultOpen);

  // ── API Key（可选，仅存 React state——不落盘不发请求，密钥不落 UI 纪律）──
  const [apiKey, setApiKey] = useState('');

  // ── 复制反馈（内联瞬态文案，web 无 toast 体系；prompt/命令/提及三路独立）──
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [mentionCopied, setMentionCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);
  /** 复制成功瞬态反馈（3s 消隐，与 seat-management「已复制」克制模式同款） */
  const flashCopied = (setter: (v: boolean) => void) => {
    setter(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopiedPrompt(false);
      setCopiedCommand(false);
      setMentionCopied(false);
    }, 3000);
  };

  // ── 验收环数据：runners 5s 轮询（open 才启）──
  const { data: runners } = useQuery({
    queryKey: ['roundtable', 'runners'],
    queryFn: () => Api.roundtable.listRunners(),
    enabled: expanded,
    refetchInterval: GUIDE_POLL_INTERVAL_MS,
  });

  // ── 验收环数据：seats 5s 轮询（与 SeatPresenceBar/页面同 key 共享缓存）──
  const { data: seats } = useSeatPresence(topicId, { enabled: expanded });

  // ── live 座位：轮询列表按 id 匹配（prop seat 是初始快照；列表未刷新时回落）──
  const liveSeat = seats?.find((s) => s.id === seat.id) ?? seat;
  const runnerId = liveSeat.runnerId ?? null;
  const presence = liveSeat.presence;

  // ── 三级信号推导（vendor 感知：runner 必须支持本座位 vendor）──
  const runnerOnline = (runners ?? []).some(
    (r) => r.status === 'online' && Array.isArray(r.vendors) && r.vendors.includes(seat.vendor),
  );
  const claimed = runnerId !== null;
  // presence 缺失 = 座位从未活动（chamber 只在活动事件时写入，认领不写）——
  // 不算「不存活」，避免验收环永久卡死在③；显式 offline 才判定未存活
  const alive = presence === undefined || presence.phase !== 'offline';
  const allGreen = runnerOnline && claimed && alive;

  // ── R5 卡死诊断：runner 在线但座位 90s 不认领 → 计时越界提示 ──
  const [claimWatchActive, setClaimWatchActive] = useState(false);
  const [claimTimedOut, setClaimTimedOut] = useState(false);
  useEffect(() => {
    // 「等待认领」态 = 展开 && 有匹配 runner 在线 && 座位未被认领
    if (expanded && runnerOnline && !claimed) {
      if (!claimWatchActive) setClaimWatchActive(true);
    } else {
      // 认领成功 / runner 离线 / 收起 → 重置计时（状态离开即清零）
      setClaimWatchActive(false);
      setClaimTimedOut(false);
    }
  }, [expanded, runnerOnline, claimed, claimWatchActive]);
  useEffect(() => {
    if (!claimWatchActive) return;
    const timer = setTimeout(() => setClaimTimedOut(true), CLAIM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [claimWatchActive]);

  // ── 指令/命令文本装配（platform URL 经 getRunnerPlatformUrl 推导：dev 8743 非 8742）──
  const platformUrl = getRunnerPlatformUrl();
  const effectiveKey = apiKey.trim() || API_KEY_PLACEHOLDER;
  // 指南 URL 按 vendor + 界面语言选文件（zh 界面指 zh-CN 镜像；vendor 是协议值直接拼）
  const guideFile = locale === 'zh-CN' ? `${seat.vendor}.zh-CN.md` : `${seat.vendor}.md`;
  const guideUrl = `${platformUrl}/api/v1/downloads/integrations/${guideFile}`;
  const promptText = t('seatGuide.promptText', {
    label: seat.label,
    vendor: seat.vendor,
    platformUrl,
    apiKey: effectiveKey,
    guideUrl,
  });
  const curlCommand = `curl -fsSL ${platformUrl}/api/v1/downloads/install-runner.sh | bash -s -- --platform-url ${platformUrl} --api-key ${effectiveKey} --start`;
  const repoCommand = `./scripts/install-runner.sh --platform-url ${platformUrl} --api-key ${effectiveKey}`;

  const handleCopy = async (text: string, setter: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(setter);
    } catch {
      // 剪贴板权限被拒：静默——文本本身可选中手动复制
    }
  };

  /** R10 闭环：复制 `@label ` 进剪贴板 + 触发外层动作（如关 Sheet）+ 瞬态提示 */
  const handleGoMention = async () => {
    try {
      await navigator.clipboard.writeText(`@${seat.label} `);
      flashCopied(setMentionCopied);
    } catch {
      // 剪贴板不可用也不阻断跳转：用户可手动输入 @label
    }
    onExit?.();
  };

  // ── 收起态：常驻「连接指引」入口（轮询不启）──
  if (!expanded) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setExpanded(true)}
        data-testid="connect-guide-expand"
        className="w-full justify-start"
      >
        <ChevronRight className="h-3.5 w-3.5" />
        {t('seatGuide.expandButton', { label: seat.label })}
      </Button>
    );
  }

  return (
    <div className="space-y-3" data-testid="runner-connect-guide">
      {/* 一句话模型说明：runner 从装有 CLI 的机器拨出连接平台，不一定是部署平台那台 */}
      <p className="text-xs text-muted-foreground">{t('seatGuide.model')}</p>

      {/* API Key（可选，仅存 state；附重置入口——agent 密钥页路由 /agents/[id]/keys） */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium">{t('seatGuide.apiKeyLabel')}</label>
        <Input
          data-testid="seat-guide-api-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('seatGuide.apiKeyPlaceholder')}
          className="h-8 text-xs"
        />
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">{t('seatGuide.apiKeyHint')}</p>
          {seat.config?.bindActorId && (
            <Link
              href={`/agents/${seat.config.bindActorId}/keys`}
              className="text-[10px] text-primary hover:underline"
            >
              {t('seatGuide.forgotKey')}
            </Link>
          )}
        </div>
      </div>

      {/* 路径 A（推荐）：复制给 Agent 的指令——含幂等声明（座位已建好，勿重复创建） */}
      <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
        <p className="text-xs font-medium">{t('seatGuide.pathATitle')}</p>
        <p className="text-[10px] text-muted-foreground">{t('seatGuide.pathADesc')}</p>
        <pre className="whitespace-pre-wrap break-all rounded bg-background/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground/70">
          {promptText}
        </pre>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            data-testid="seat-guide-copy-prompt"
            onClick={() => void handleCopy(promptText, setCopiedPrompt)}
          >
            {copiedPrompt ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
            {copiedPrompt ? t('seatGuide.copied') : t('seatGuide.copyPrompt')}
          </Button>
          {copiedPrompt && (
            <p className="text-[10px] text-emerald-400" data-testid="seat-guide-prompt-copied">
              {t('seatGuide.copied')}
            </p>
          )}
        </div>
      </div>

      {/* 路径 B：人类一行命令（standalone 安装）+ 已 clone 仓库的 repo 模式备选 */}
      <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
        <p className="text-xs font-medium">{t('seatGuide.pathBTitle')}</p>
        <p className="text-[10px] text-muted-foreground">{t('seatGuide.pathBDesc')}</p>
        <code className="block break-all rounded bg-background/60 px-2 py-1.5 font-mono text-[10px] text-foreground/70">
          {curlCommand}
        </code>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            data-testid="seat-guide-copy-command"
            onClick={() => void handleCopy(curlCommand, setCopiedCommand)}
          >
            {copiedCommand ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
            {copiedCommand ? t('seatGuide.copied') : t('seatGuide.copyCommand')}
          </Button>
          {copiedCommand && (
            <p className="text-[10px] text-emerald-400" data-testid="seat-guide-command-copied">
              {t('seatGuide.copied')}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">{t('seatGuide.repoAltTitle')}</p>
          <p className="text-[10px] text-muted-foreground">{t('seatGuide.repoAltDesc')}</p>
          <code className="block break-all rounded bg-background/60 px-2 py-1.5 font-mono text-[10px] text-foreground/70">
            {repoCommand}
          </code>
          <code className="block break-all rounded bg-background/60 px-2 py-1.5 font-mono text-[10px] text-foreground/70">
            ./start-runner.sh
          </code>
        </div>
      </div>

      {/* 验收环：三级信号递进（① runner 上线 → ② 认领 → ③ presence 存活） */}
      <div
        className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3"
        data-testid="seat-guide-verify"
      >
        <p className="text-xs font-medium">{t('seatGuide.verifyTitle')}</p>
        <ul className="space-y-1.5 text-xs">
          <li
            data-testid="verify-step-runner"
            className={`flex items-center gap-1.5 ${runnerOnline ? 'text-emerald-400' : 'text-muted-foreground'}`}
          >
            <Check className="h-3 w-3" />
            {runnerOnline
              ? t('seatGuide.stepRunnerOk', { vendor: seat.vendor })
              : t('seatGuide.stepRunner', { vendor: seat.vendor })}
          </li>
          <li
            data-testid="verify-step-claim"
            className={`flex items-center gap-1.5 ${claimed ? 'text-emerald-400' : 'text-muted-foreground'}`}
          >
            <Check className="h-3 w-3" />
            {claimed
              ? t('seatGuide.stepClaimOk', { label: seat.label })
              : t('seatGuide.stepClaim', { label: seat.label })}
          </li>
          <li
            data-testid="verify-step-alive"
            className={`flex items-center gap-1.5 ${alive ? 'text-emerald-400' : 'text-muted-foreground'}`}
          >
            <Check className="h-3 w-3" />
            {alive ? t('seatGuide.stepAliveOk') : t('seatGuide.stepAlive')}
          </li>
        </ul>

        {/* R5 卡死诊断：runner 在线但 90s 未认领 → amber 提示查 API Key 归属 */}
        {claimTimedOut && (
          <div
            className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5"
            data-testid="seat-guide-stuck"
          >
            <p className="text-xs text-amber-300">{t('seatGuide.stuckTitle')}</p>
            <p className="text-[10px] text-amber-300/80">
              {t('seatGuide.stuckHint', { vendor: seat.vendor })}
            </p>
          </div>
        )}

        {/* 全绿：连接完成 + R10 闭环按钮（复制 @label + 触发外层动作） */}
        {allGreen && (
          <div
            className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5"
            data-testid="seat-guide-all-green"
          >
            <p className="text-xs text-emerald-300">{t('seatGuide.allGreen')}</p>
            <Button
              size="sm"
              className="h-7 text-[11px]"
              data-testid="seat-guide-go-mention"
              onClick={() => void handleGoMention()}
            >
              {t('seatGuide.goMention')}
            </Button>
            {mentionCopied && (
              <p
                className="text-[10px] text-emerald-300/80"
                data-testid="seat-guide-mention-copied"
              >
                {t('seatGuide.mentionCopied', { label: seat.label })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

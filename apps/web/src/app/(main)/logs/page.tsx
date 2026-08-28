/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md /logs 节（线上 DocSpace，活动日志系统
 *     Phase 4，plan shadowcat-sunspot-catwoman.md）
 *   - 补充: docs/api-definition.md Audit 节（GET /activity-logs 契约）
 *
 * [踩坑索引] SCOP(非admin响应剔除ip字段) R12(真孤儿actorName=null)
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #26(文档联动)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   SCOP: 非 admin 的 /activity-logs 响应不包含 ipAddress/userAgent/sessionId
 *          字段（服务端最小披露，决策 7）——IP 列必须按字段存在性渲染，且整列
 *          仅 admin 可见，禁止裸用 log.ipAddress（类型上有、运行时 undefined）。
 *   R12: actor 真孤儿（actors 表无行）时 actorName=null——显示 Unknown 兜底，
 *        与 System（actorId=null）区分开，禁止统一写死 '-'。
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
'use client';

import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { AuditAction, UserRole } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  SearchSelectPopover,
  type SearchSelectOption,
} from '@/components/ui/search-select-popover';
import { formatDate } from '@/lib/utils';
import { buildLogsQuery } from '@/lib/logs-query';
import { ChevronDown, ChevronLeft, ChevronRight, RotateCcw, ShieldCheck, User } from 'lucide-react';

/**
 * 实体类型白名单：后端 entityType 为 varchar 自由取值（决策 5，无枚举），
 * 本表与插桩点实际取值同步维护（Phase 2 全量插桩后快照）——新增插桩实体时
 * 需同步补充，否则过滤器缺项。取值证据：task/topic/agent/user/board/…
 * 各模块 audit 插桩点（grep `entityType: '` 于 apps/backend/src）。
 */
const ENTITY_TYPES = [
  'user',
  'agent',
  'topic',
  'topic_participant',
  'message',
  'task',
  'task_comment',
  'task_description',
  'task_report',
  'task_dependency',
  'doc_link',
  'board',
  'board_list',
  'board_member',
  'milestone',
  'doc',
  'doc_space',
  'doc_space_member',
  'doc_category',
  'doc_route',
  'api_key',
  'roundtable_seat',
  'roundtable_request',
  'webhook_delivery',
] as const;

/** 时间预设档（毫秒跨度）；custom = 自定义 datetime-local 起止 */
type TimePreset = '1h' | '24h' | '7d' | 'custom';
const TIME_PRESET_SPANS: Record<Exclude<TimePreset, 'custom'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

/** 行内 JSON 详情（newData/oldData/diff 均可能为 null，缺失段不渲染） */
function RowDetail({ log }: { log: { newData: unknown; oldData: unknown; diff: unknown } }) {
  const t = useTranslations('logs.detail');
  const sections = [
    { key: 'diff', label: t('diff'), value: log.diff },
    { key: 'newData', label: t('newData'), value: log.newData },
    { key: 'oldData', label: t('oldData'), value: log.oldData },
  ].filter((s) => s.value != null);
  if (sections.length === 0) return null;
  return (
    <div className="space-y-3">
      {sections.map((s) => (
        <div key={s.key}>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{s.label}</div>
          {/* JSON pretty 展示：白名单子集快照（决策 6），非原始请求体 */}
          <pre className="max-h-64 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed">
            {JSON.stringify(s.value, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

/**
 * 活动日志查询页（GET /activity-logs 的 Web 落点，活动日志系统 Phase 4）
 *
 * 权限边界与数据源（plan 决策 4 / Phase 4）：
 * - admin    → actor 选择器 = /admin/users + /agents（全量）；
 * - human    → actor 选择器 = 自己（authStore）+ /agents?ownerId=<me>，
 *              禁止调用 /admin/users；
 * - agent    → 不在 web 登录体系内（API key 场景），由 API/MCP 层覆盖。
 *
 * 非 admin 响应服务端剔除 ipAddress（最小披露，决策 7）→ IP 列按字段存在性
 * 渲染（SCOP 踩坑）。actorId=null 的系统行仅 admin 可见 → System 显示。
 */
export default function LogsPage() {
  const t = useTranslations('logs');
  const tFilter = useTranslations('logs.filter');
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.role === UserRole.ADMIN;

  // ── 过滤器状态 ──
  const [actor, setActor] = useState<SearchSelectOption | null>(null);
  const [actorOpen, setActorOpen] = useState(false);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [timePreset, setTimePreset] = useState<TimePreset>('24h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [page, setPage] = useState(1);
  /** 展开的行 id（详情 = newData/oldData/diff JSON pretty） */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /**
   * 时间范围派生：预设档只产生 from（now - 跨度，to 不限）；
   * custom 档用 datetime-local 起止（本地时区，toISOString 转 UTC ISO 8601）。
   */
  const timeRange = useMemo<{ from?: string; to?: string }>(() => {
    if (timePreset === 'custom') {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : undefined,
        to: customTo ? new Date(customTo).toISOString() : undefined,
      };
    }
    return { from: new Date(Date.now() - TIME_PRESET_SPANS[timePreset]).toISOString() };
  }, [timePreset, customFrom, customTo]);

  /** 任一过滤器变化 → 回到第一页（避免停在越界页） */
  const resetPage = useCallback(() => setPage(1), []);

  /**
   * actor 选择器搜索（零新接口，plan Phase 4 v2 定案）：
   * admin → /admin/users + /agents 并行；human → 自己 + /agents?ownerId=<me>。
   * 非 admin 分支绝不触碰 /admin/users（该端点 admin-only，会 403）。
   */
  const searchActors = useCallback(
    async (q: string): Promise<SearchSelectOption[]> => {
      const keyword = q.trim() || undefined;
      if (isAdmin) {
        const [usersRes, agentsRes] = await Promise.all([
          Api.users.list({ q: keyword, pageSize: 20 }),
          Api.agents.list({ q: keyword, pageSize: 20 }),
        ]);
        return [
          ...usersRes.items.map((u) => ({
            id: u.id,
            label: u.name,
            hint: `${u.email} · ${u.role}`,
          })),
          ...agentsRes.items.map((a) => ({
            id: a.id,
            label: a.name,
            hint: `${tFilter('actorAgentHint')} · ${a.status}`,
          })),
        ];
      }
      if (!user) return [];
      const res = await Api.agents.list({ q: keyword, ownerId: user.id, pageSize: 20 });
      return [
        { id: user.id, label: user.name, hint: user.email },
        ...res.items.map((a) => ({
          id: a.id,
          label: a.name,
          hint: `${tFilter('actorAgentHint')} · ${a.status}`,
        })),
      ];
    },
    [isAdmin, user, tFilter],
  );

  const query = buildLogsQuery({
    actorId: actor?.id,
    entityType,
    action,
    ...timeRange,
    page,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['logs', 'list', query],
    queryFn: () => Api.logs.list(query),
  });

  const handleReset = () => {
    setActor(null);
    setEntityType('');
    setAction('');
    setTimePreset('24h');
    setCustomFrom('');
    setCustomTo('');
    setExpandedId(null);
    resetPage();
  };

  const handleSelectChange =
    (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => {
      setter(e.target.value);
      resetPage();
    };

  /** IP 列可见性：仅 admin，且首个条目带 ipAddress 字段（SCOP——非 admin 响应无此字段） */
  const canShowIp = isAdmin && (data?.items ?? []).some((log) => 'ipAddress' in log);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
      </div>

      {/* ── 过滤器栏 ── */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          {/* actor 选择器（SearchSelectPopover 先例：doc-picker / task-picker） */}
          <div className="relative w-56">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {tFilter('actor')}
            </label>
            <div className="flex h-10 w-full items-center overflow-hidden rounded-md border border-input bg-background text-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
              <button
                type="button"
                onClick={() => setActorOpen((v) => !v)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className={actor ? 'truncate' : 'truncate text-muted-foreground'}>
                  {actor ? actor.label : tFilter('actorPlaceholder')}
                </span>
              </button>
              {/* 已选 actor 的清空按钮：触发按钮的兄弟节点（嵌套 button 非法，React 会告警） */}
              {actor && (
                <button
                  type="button"
                  aria-label={tFilter('actorClear')}
                  onClick={() => {
                    setActor(null);
                    resetPage();
                  }}
                  className="shrink-0 px-2 text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              )}
            </div>
            <SearchSelectPopover
              open={actorOpen}
              onClose={() => setActorOpen(false)}
              onSearch={searchActors}
              onSelect={(option) => {
                setActor(option);
                resetPage();
              }}
              placeholder={tFilter('actorSearchPlaceholder')}
              emptyText={tFilter('actorEmpty')}
            />
          </div>

          {/* entityType（原生 select，users 页先例） */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {tFilter('entityType')}
            </label>
            <select
              className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={entityType}
              onChange={handleSelectChange(setEntityType)}
            >
              <option value="">{tFilter('entityTypeAll')}</option>
              {ENTITY_TYPES.map((et) => (
                <option key={et} value={et}>
                  {et}
                </option>
              ))}
            </select>
          </div>

          {/* action（原生 select，取值 = shared AuditAction 枚举，与后端同源） */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {tFilter('action')}
            </label>
            <select
              className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={action}
              onChange={handleSelectChange(setAction)}
            >
              <option value="">{tFilter('actionAll')}</option>
              {Object.values(AuditAction).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          {/* 时间范围：预设档 + 自定义 datetime-local 起止 */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {tFilter('timeRange')}
            </label>
            <div className="flex items-center gap-2">
              <select
                className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={timePreset}
                onChange={(e) => {
                  setTimePreset(e.target.value as TimePreset);
                  resetPage();
                }}
              >
                <option value="1h">{tFilter('timePresets.1h')}</option>
                <option value="24h">{tFilter('timePresets.24h')}</option>
                <option value="7d">{tFilter('timePresets.7d')}</option>
                <option value="custom">{tFilter('timePresets.custom')}</option>
              </select>
              {timePreset === 'custom' && (
                <>
                  <input
                    type="datetime-local"
                    aria-label={tFilter('from')}
                    value={customFrom}
                    onChange={(e) => {
                      setCustomFrom(e.target.value);
                      resetPage();
                    }}
                    className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <input
                    type="datetime-local"
                    aria-label={tFilter('to')}
                    value={customTo}
                    onChange={(e) => {
                      setCustomTo(e.target.value);
                      resetPage();
                    }}
                    className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </>
              )}
            </div>
          </div>

          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {tFilter('reset')}
          </Button>
        </CardContent>
      </Card>

      {/* ── 权限边界提示（响应 scope 回声：null=全量 / 数组=受限白名单） ── */}
      {data && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          {data.scope === null ? (
            <Badge variant="default">{t('scope.admin')}</Badge>
          ) : (
            <Badge variant="secondary">{t('scope.restricted', { count: data.scope.length })}</Badge>
          )}
          <span className="text-xs">{t('scope.scopeHint')}</span>
        </div>
      )}

      {/* ── 日志表格 ── */}
      <Card>
        <CardHeader>
          <CardTitle>{t('table.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Loading />
          ) : !data || data.items.length === 0 ? (
            <EmptyState title={t('noLogs')} description={t('noLogsDesc')} />
          ) : (
            <div className="space-y-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>{t('table.time')}</TableHead>
                    <TableHead>{t('table.actor')}</TableHead>
                    <TableHead>{t('table.action')}</TableHead>
                    <TableHead>{t('table.entity')}</TableHead>
                    {canShowIp && <TableHead>{t('table.ip')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((log) => {
                    const hasDetail =
                      log.diff != null || log.newData != null || log.oldData != null;
                    const isExpanded = expandedId === log.id;
                    return (
                      <Fragment key={log.id}>
                        <TableRow
                          className={hasDetail ? 'cursor-pointer' : undefined}
                          onClick={() => hasDetail && setExpandedId(isExpanded ? null : log.id)}
                        >
                          <TableCell>
                            {/* 行展开触发器：无详情数据时禁用（空 chevron 占位保持列对齐） */}
                            <button
                              type="button"
                              disabled={!hasDetail}
                              aria-label={t('table.expand')}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedId(isExpanded ? null : log.id);
                              }}
                              className={
                                hasDetail
                                  ? 'text-muted-foreground hover:text-foreground'
                                  : 'text-muted-foreground/30'
                              }
                            >
                              <ChevronDown
                                className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                              />
                            </button>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(String(log.createdAt))}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {/* actorId=null → System（决策 10，仅 admin 全量可见）；
                                actorName=null 真孤儿 → Unknown（R12 兜底，与 System 区分） */}
                              {log.actorId === null ? (
                                <span className="text-muted-foreground">{t('systemActor')}</span>
                              ) : (
                                <>
                                  <span>{log.actorName ?? t('unknownActor')}</span>
                                  {/* 执行者已软删：历史归因保留（actorDeletedAt 非空），降级角标提示 */}
                                  {log.actorDeletedAt && (
                                    <Badge variant="outline" className="text-[10px]">
                                      {t('deletedActor')}
                                    </Badge>
                                  )}
                                </>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-xs">{log.action}</span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className="font-mono text-[10px]">
                                {log.entityType}
                              </Badge>
                              <span className="font-mono text-xs max-w-[160px] truncate text-muted-foreground">
                                {log.entityId}
                              </span>
                            </div>
                          </TableCell>
                          {canShowIp && (
                            <TableCell className="font-mono text-xs">
                              {/* SCOP：字段存在性兜底（非 admin 响应无此字段，本列已按 isAdmin 门控） */}
                              {'ipAddress' in log ? (log.ipAddress ?? '-') : '-'}
                            </TableCell>
                          )}
                        </TableRow>
                        {/* 行展开详情：紧随被展开行渲染（不在表尾汇总），colSpan 随 IP 列门控 */}
                        {isExpanded && (
                          <TableRow key={`${log.id}-detail`}>
                            <TableCell colSpan={canShowIp ? 6 : 5} className="bg-muted/30">
                              <RowDetail log={log} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  {t('pagination', {
                    page: data.page,
                    totalPages: data.totalPages,
                    pageSize: data.pageSize,
                    total: data.total,
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p - 1)}
                    disabled={!data.hasPrev}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!data.hasNext}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

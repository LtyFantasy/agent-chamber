'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页消息流——输入区提示）
 *   - 补充: docs/roundtable-design.md §6（路由与唤醒策略：mention 默认省钱语义）
 *
 * [踩坑索引]
 *   - wakePolicy 是详情视图派生字段（topic.service findOneWithParticipants，
 *     roundtable.service resolveWakePolicy 同规）：normal topic 后端不输出该字段，
 *     kind 也未定义时 undefined——组件用「kind 必须精确等于 roundtable && wakePolicy
 *     精确等于 mention」双条件，任何缺省态都不渲染（宁可少提示不误导）
 *   - 提示文案必须走 i18n（topics.message.mentionHint），禁止硬编码；「@座位名 /
 *     @all」令牌本身保持原样不翻译（令牌是协议符号）
 *
 * [铁律关联] #7（视觉克制：text-xs 次级色，不抢输入框） #11（注释强制）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useTranslations } from 'next-intl';
import { TopicKind, WakePolicy } from '@agent-chamber/shared';

interface RoundtableMentionHintProps {
  /** 话题类型（TopicDetail.kind；normal/未定义 = 不渲染） */
  kind?: string;
  /** 圆桌唤醒策略 effective 值（TopicDetail.wakePolicy；broadcast/未定义 = 不渲染） */
  wakePolicy?: string;
}

/**
 * 圆桌 mention 模式输入框提示（review 代价一缓解，M2 阶段 6）：
 * 仅 kind='roundtable' && wakePolicy='mention' 时渲染一条克制的小字提示
 * 「@座位名 唤醒对应座位，@all 唤醒全部」——提醒用户「唤醒是稀缺资源，
 * 看见 ≠ 唤醒」（roundtable-design §6）：未 @ 的消息只入可见集不唤醒座位。
 */
export function RoundtableMentionHint({ kind, wakePolicy }: RoundtableMentionHintProps) {
  const t = useTranslations('topics');

  if (kind !== TopicKind.ROUNDTABLE || wakePolicy !== WakePolicy.MENTION) {
    return null;
  }

  return (
    <p className="mt-1 text-xs text-muted-foreground/80 select-none">{t('message.mentionHint')}</p>
  );
}

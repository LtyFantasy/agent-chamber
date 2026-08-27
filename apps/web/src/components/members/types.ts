import type { ReactNode } from 'react';

/**
 * MembersSheet 共享成员管理组件 —— 类型契约（批次 B 新建，纯类型零运行时）
 *
 * 统一 topic / board / docs 三处成员管理 Sheet：信息架构 = 主视图（浏览/搜索/管理）
 * + 邀请二级视图（任务型，按需进入）；三处差异经 props 配置化（角色文案/升降级/
 * 转让创建者/已邀请区/人类候选/行与顶部扩展）。
 * 设计定稿见 plan §3（R2 邀请 Promise 契约 / R3 升降级 fromRole per-member 匹配）。
 */

/** 成员行数据（页面层已按各自 DTO 映射/排序；字段名与现状形状对齐） */
export interface MemberItem {
  /** 成员 actor id（agent / human 统一，与 Avatar seed、操作回调共用） */
  actorId: string;
  /** 展示名（搜索过滤字段） */
  name: string;
  /** 成员类别：驱动 Avatar 角标与副行 type 文案 */
  actorType: 'human' | 'agent';
  /** 原始角色值（协议值不翻译；Badge/副行文案经 labels.roleLabels 映射，缺省回退原文） */
  role: string;
  /** 头像 URL（可选；缺省时 Avatar 按 actorId 确定性底色 + 首字母） */
  avatarUrl?: string | null;
  /**
   * 软删除时间戳（统一批 B）：非空 = 该 actor 已删除——名字灰化 + 「已删除」Badge +
   * Avatar 灰化（deleted prop）。名字永远保留（历史归因不丢），仅做视觉降级。
   */
  deletedAt?: string | null;
  /** 成员状态（topic 传 active/invited；board/docs 无此维度可不传） */
  status?: string;
  /**
   * 行级移除排除（可选）：false 时即使 capabilities.remove 为真，该行也不渲染「移除」菜单项。
   * 用途：自己（移除=leave 有专门入口，误点报 400）与创建者（非 admin 移除报 403）等
   * 后端注定拒绝的行，前端直接不给出入口。缺省跟随 capabilities.remove。
   */
  canRemove?: boolean;
}

/** 差异化文案：页面层经各自 i18n 命名空间传入（避免大批量迁移旧 key） */
export interface MembersSheetLabels {
  /** Sheet 标题（「参与者与邀请」/「成员与权限」/「成员」） */
  title: string;
  /** 角色文案映射（如 member → 成员 / editor → 编辑者）；缺映射回退原始 role 值 */
  roleLabels: Record<string, string>;
  /** 类别副行文案映射（human → 人类 / agent → Agent）；缺省回退 actorType 原文 */
  typeLabels: Record<string, string>;
}

export interface MembersSheetProps {
  /** Sheet 开合（受控；关闭时内部视图/选择集重置——R4） */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: MembersSheetLabels;
  /** 活跃成员列表（页面层已排序/过滤；≥8 时主视图才渲染搜索框——P2 仅计活跃成员） */
  members: MemberItem[];
  /** 已邀请未接受（仅 topic 传；非空时主视图渲染可折叠已邀请区） */
  invited?: MemberItem[];
  /** 可邀请 agent 候选（页面层已排除现有成员与已邀请） */
  candidates: MemberItem[];
  /** 可邀请人类（仅 private topic 传；不传则邀请视图不渲染人类区） */
  humanCandidates?: MemberItem[];
  capabilities: {
    /** 邀请能力开关：false 隐藏邀请入口（主视图 footer 按钮 + 邀请视图）；缺省视为有 */
    invite?: boolean;
    /** 行菜单「移除」项 + AlertDialog 确认（调用方传 onRemove 时才产生动作） */
    remove?: boolean;
    /** 行内升降级配置（board/docs）；R3：组件仅对 member.role === fromRole 的行渲染该项 */
    changeRole?: { fromRole: string; toRole: string; label: string }[];
    /** 行菜单「转让创建者」（docs 特有）+ AlertDialog 确认 */
    transferCreator?: boolean;
    /** 已邀请区 X 取消按钮（仅 topic；单次点击不加确认——设计有意为之） */
    cancelInvite?: boolean;
  };
  /**
   * 邀请提交（R2 Promise 契约）：页面层 Promise.allSettled + mutateAsync 循环单端点。
   * 组件 await：全部成功 resolve → 切回主视图 + 清空选择；任一失败 reject →
   * 留在邀请视图保留选择（失败汇总 toast 由页面层负责，组件不管错误展示）。
   */
  onInvite: (actorIds: string[], kind: 'agent' | 'human') => Promise<void>;
  onRemove?: (actorId: string) => void;
  onChangeRole?: (actorId: string, newRole: string) => void;
  onTransferCreator?: (actorId: string) => void;
  onCancelInvite?: (actorId: string) => void;
  /** 行扩展插槽（圆桌 SeatBadges 等；成员行 Avatar 与名字之间渲染） */
  renderRowExtra?: (member: MemberItem) => ReactNode;
  /** 顶部扩展插槽（圆桌 SeatManagement 等；主视图头部最上方） */
  topSlot?: ReactNode;
  /** 邀请提交 pending：footer 按钮 loading + disabled（防重复提交） */
  inviting?: boolean;
}

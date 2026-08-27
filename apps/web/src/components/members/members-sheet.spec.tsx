/**
 * members-sheet.spec.tsx — MembersSheet 共享成员管理组件渲染契约测试（批次 B）。
 *
 * 覆盖（任务清单 8 点 + 补充）：
 * 1. 主视图渲染（标题/计数/成员行结构与副行文案）
 * 2. 主视图搜索阈值 ≥8（仅活跃成员计数，invited 不计入）+ 客户端过滤
 * 3. 空态（无成员虚线框 + 引导文案）
 * 4. 已邀请区（可折叠 / X 单次点击即取消——无确认弹窗，设计有意为之）
 * 5. capabilities 显隐（remove / changeRole fromRole per-member 匹配 / transferCreator /
 *    无任何能力 → 无菜单按钮）
 * 6. AlertDialog 确认流（移除 + 转让创建者：取消不回调 / 确认后回调并关闭）
 * 7. 视图切换（main ↔ invite 内容替换）+ Sheet 关闭重置视图与选择（R4）
 * 8. 邀请视图：候选搜索过滤 / checkbox 选择 → footer 计数与禁用态
 * 9. onInvite Promise 契约（R2）：resolve 切回主视图 + 清空选择；reject 留在邀请视图
 *    保留选择；agent + human 混合按 kind 分组两次调用
 * 10. 候选空态（P3：全部 agent 已成员 / 人类区空 / 无人类区）
 * 11. renderRowExtra / topSlot 插槽渲染
 *
 * 文案断言用 en.json 快照；next-intl 直接 mock（同 seat-badges.test.tsx 模式）。
 */

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MembersSheet } from './members-sheet';
import type { MemberItem, MembersSheetLabels, MembersSheetProps } from './types';

/** members 命名空间 + 组件依赖的 common key 英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.deleted': 'Deleted',
  'members.invite': 'Invite members',
  'members.back': 'Back',
  'members.searchMembers': 'Search members…',
  'members.searchCandidates': 'Search…',
  'members.selectedCount': 'Selected {count}',
  'members.inviteCount': 'Invite {count}',
  'members.remove': 'Remove',
  'members.removeConfirmTitle': 'Remove member',
  'members.removeConfirmDesc': 'Remove {name}? They will lose access immediately.',
  'members.transferCreator': 'Transfer creator',
  'members.transferConfirmTitle': 'Transfer creator',
  'members.transferConfirmDesc':
    'Transfer the creator role to {name}? You will lose creator permissions afterwards.',
  'members.emptyTitle': 'No members yet',
  'members.emptyDesc': 'Tap "Invite members" below to add the first member.',
  'members.candidatesEmpty': 'All agents are already members',
  'members.humansEmpty': 'No users available to invite',
  'members.invitedSection': 'Invited ({count})',
  'members.agentSection': 'Agents',
  'members.humanSection': 'Humans',
  'members.cancelInviteAria': 'Cancel invitation for {name}',
  'members.menuAria': 'Actions for {name}',
  'members.countSummary': '{count} members',
  'members.countSummaryWithInvited': '{count} members · {invited} invited',
  'members.noSearchResults': 'No matching members',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    let text = messages[fullKey] ?? fullKey;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split(`{${k}}`).join(String(v));
      }
    }
    return text;
  },
  useLocale: () => 'en',
}));

const LABELS: MembersSheetLabels = {
  title: 'Board members',
  roleLabels: { editor: 'Editor', member: 'Member' },
  typeLabels: { human: 'Human', agent: 'Agent' },
};

/** 成员构造（agent 快捷：name 缺省 = actorId） */
const member = (
  actorId: string,
  role: string = 'member',
  name?: string,
  actorType: 'human' | 'agent' = 'agent',
): MemberItem => ({ actorId, name: name ?? actorId, actorType, role });

/** N 个活跃成员（搜索阈值用例） */
const manyMembers = (n: number): MemberItem[] =>
  Array.from({ length: n }, (_, i) => member(`m${i}`, 'member', `M${i}`));

interface RenderOpts {
  open?: boolean;
  members?: MemberItem[];
  invited?: MemberItem[];
  candidates?: MemberItem[];
  humanCandidates?: MemberItem[];
  capabilities?: MembersSheetProps['capabilities'];
  onInvite?: jest.Mock;
  onRemove?: jest.Mock;
  onChangeRole?: jest.Mock;
  onTransferCreator?: jest.Mock;
  onCancelInvite?: jest.Mock;
  onOpenChange?: jest.Mock;
  renderRowExtra?: (m: MemberItem) => React.ReactNode;
  topSlot?: React.ReactNode;
  inviting?: boolean;
}

function renderSheet(opts: RenderOpts = {}) {
  const props: MembersSheetProps = {
    open: opts.open ?? true,
    onOpenChange: opts.onOpenChange ?? jest.fn(),
    labels: LABELS,
    members: opts.members ?? [],
    invited: opts.invited,
    candidates: opts.candidates ?? [],
    humanCandidates: opts.humanCandidates,
    capabilities: opts.capabilities ?? {},
    onInvite: opts.onInvite ?? jest.fn().mockResolvedValue(undefined),
    onRemove: opts.onRemove,
    onChangeRole: opts.onChangeRole,
    onTransferCreator: opts.onTransferCreator,
    onCancelInvite: opts.onCancelInvite,
    renderRowExtra: opts.renderRowExtra,
    topSlot: opts.topSlot,
    inviting: opts.inviting,
  };
  const utils = render(<MembersSheet {...props} />);
  return { ...utils, props };
}

/** 打开行菜单的快捷操作 */
const openMenu = (actorId: string) => fireEvent.click(screen.getByTestId(`member-menu-${actorId}`));

describe('MembersSheet 主视图', () => {
  it('渲染标题 + 计数 + 成员行（Avatar/名字/type·role 副行/Badge）；invited 存在时计数含已邀请', () => {
    renderSheet({
      members: [member('a1', 'member', 'Alice'), member('a2', 'editor', 'Bob')],
      invited: [member('i1', 'member', 'Invitee')],
      capabilities: { cancelInvite: true },
    });

    expect(screen.getByText('Board members')).toBeInTheDocument();
    expect(screen.getByTestId('members-count')).toHaveTextContent('2 members · 1 invited');

    const row = screen.getByTestId('member-row-a1');
    expect(within(row).getByText('Alice')).toBeInTheDocument();
    // 副行：type 文案 · role 文案（labels 映射）
    expect(within(row).getByText('Agent · Member')).toBeInTheDocument();
    // 角色 Badge（纯展示）
    expect(within(row).getAllByText('Member').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('member-row-a2')).getByText('Editor')).toBeInTheDocument();
  });

  it('成员为空 → 虚线框空态（标题 + 引导文案，无成员行）', () => {
    renderSheet({ members: [], capabilities: { invite: true } });

    expect(screen.getByText('No members yet')).toBeInTheDocument();
    expect(
      screen.getByText('Tap "Invite members" below to add the first member.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(/^member-row-/)).not.toBeInTheDocument();
  });

  it('主视图搜索阈值（P2）：活跃成员 ≥8 才渲染；invited 不计入阈值', () => {
    // 7 活跃：无搜索框
    const { unmount } = renderSheet({ members: manyMembers(7) });
    expect(screen.queryByTestId('members-search')).not.toBeInTheDocument();
    unmount();

    // 7 活跃 + 3 已邀请：仍无搜索框（阈值仅计活跃成员）
    const second = renderSheet({
      members: manyMembers(7),
      invited: manyMembers(3).map((m, i) => ({ ...m, actorId: `inv${i}`, name: `Inv${i}` })),
      capabilities: { cancelInvite: true },
    });
    expect(screen.queryByTestId('members-search')).not.toBeInTheDocument();
    second.unmount();

    // 8 活跃：有搜索框
    renderSheet({ members: manyMembers(8) });
    expect(screen.getByTestId('members-search')).toBeInTheDocument();
  });

  it('主视图搜索：客户端过滤 name（只作用于活跃成员行）', () => {
    renderSheet({ members: manyMembers(8) });

    fireEvent.change(screen.getByTestId('members-search'), { target: { value: 'M3' } });

    expect(screen.getByText('M3')).toBeInTheDocument();
    expect(screen.queryByText('M1')).not.toBeInTheDocument();
    // 清空恢复全量
    fireEvent.change(screen.getByTestId('members-search'), { target: { value: '' } });
    expect(screen.getByText('M1')).toBeInTheDocument();
  });

  it('主视图搜索无结果 → 虚线框提示', () => {
    renderSheet({ members: manyMembers(8) });

    fireEvent.change(screen.getByTestId('members-search'), { target: { value: 'Nope' } });

    expect(screen.getByText('No matching members')).toBeInTheDocument();
  });

  it('已邀请区：有内容才显示、可折叠；X 单次点击即取消（无确认弹窗——有意设计）', () => {
    const onCancelInvite = jest.fn();
    renderSheet({
      members: [member('a1')],
      invited: [member('i1', 'invited', 'Invitee')],
      capabilities: { cancelInvite: true },
      onCancelInvite,
    });

    expect(screen.getByText('Invited (1)')).toBeInTheDocument();
    expect(screen.getByTestId('invited-row-i1')).toBeInTheDocument();

    // 折叠（ChevronDown 收起）→ 行消失；再展开恢复
    fireEvent.click(screen.getByTestId('invited-toggle'));
    expect(screen.queryByTestId('invited-row-i1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invited-toggle'));
    expect(screen.getByTestId('invited-row-i1')).toBeInTheDocument();

    // X 取消：单次点击直接回调，不弹 AlertDialog
    fireEvent.click(screen.getByTestId('cancel-invite-i1'));
    expect(onCancelInvite).toHaveBeenCalledWith('i1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('capabilities 显隐：无任何操作能力 → 行无菜单按钮', () => {
    renderSheet({ members: [member('a1')], capabilities: {} });

    expect(screen.queryByTestId('member-menu-a1')).not.toBeInTheDocument();
  });

  it('capabilities 显隐：changeRole 按 fromRole per-member 匹配（R3）；点击回调 newRole', () => {
    const onChangeRole = jest.fn();
    renderSheet({
      members: [member('a1', 'member'), member('a2', 'editor')],
      capabilities: {
        changeRole: [{ fromRole: 'member', toRole: 'editor', label: 'Set as editor' }],
      },
      onChangeRole,
    });

    // member 行：菜单含「Set as editor」
    openMenu('a1');
    const menu = screen.getByTestId('row-menu');
    expect(within(menu).getByText('Set as editor')).toBeInTheDocument();
    expect(within(menu).queryByText('Transfer creator')).not.toBeInTheDocument();
    // 非危险项：点击直接回调（无 AlertDialog）
    fireEvent.click(within(menu).getByText('Set as editor'));
    expect(onChangeRole).toHaveBeenCalledWith('a1', 'editor');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // editor 行：fromRole 不匹配 → 无菜单按钮（无任何可操作项，纯展示行）
    expect(screen.queryByTestId('member-menu-a2')).not.toBeInTheDocument();
  });

  it('capabilities 显隐：remove / transferCreator 菜单项渲染（危险项）', () => {
    renderSheet({
      members: [member('a1')],
      capabilities: { remove: true, transferCreator: true },
    });

    openMenu('a1');
    const menu = screen.getByTestId('row-menu');
    expect(within(menu).getByText('Remove')).toBeInTheDocument();
    expect(within(menu).getByText('Transfer creator')).toBeInTheDocument();
  });

  it('canRemove=false 的行不渲染移除项（行级排除：自己/创建者等后端注定拒绝的行）', () => {
    renderSheet({
      members: [{ ...member('a1'), canRemove: false }],
      capabilities: { remove: true },
    });

    // 唯一菜单项被行级排除 → 整行变纯展示（无三点菜单按钮）
    expect(screen.queryByTestId('member-menu-a1')).not.toBeInTheDocument();
  });

  it('移除确认流：取消不回调；确认后调 onRemove 并关闭弹窗', () => {
    const onRemove = jest.fn();
    renderSheet({ members: [member('a1')], capabilities: { remove: true }, onRemove });

    // 取消路径
    openMenu('a1');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    let dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Remove member')).toBeInTheDocument();
    expect(within(dialog).getByText(/lose access immediately/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('Cancel'));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // 确认路径
    openMenu('a1');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Remove'));
    expect(onRemove).toHaveBeenCalledWith('a1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('转让创建者确认流：确认 → onTransferCreator（危险项弹窗文案带成员名）', () => {
    const onTransferCreator = jest.fn();
    renderSheet({
      members: [member('a1', 'member', 'Alice')],
      capabilities: { transferCreator: true },
      onTransferCreator,
    });

    openMenu('a1');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Transfer creator' }));
    const dialog = screen.getByRole('alertdialog');
    // 弹窗内 title 与确认按钮同名（均为「Transfer creator」）——title 断言用 getAllByText
    expect(within(dialog).getAllByText('Transfer creator').length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Alice/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer creator' }));
    expect(onTransferCreator).toHaveBeenCalledWith('a1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('已删除成员降级渲染（统一批 B）：deletedAt 非空 → 名字灰化 + 「已删除」Badge + Avatar 灰化（Bot 角标隐藏）', () => {
    renderSheet({
      members: [{ ...member('a1', 'member', 'Alice'), deletedAt: '2026-08-01T00:00:00Z' }],
      capabilities: { remove: true },
    });

    const row = screen.getByTestId('member-row-a1');
    // 「已删除」Badge（secondary 低调标记）
    expect(within(row).getByText('Deleted')).toBeInTheDocument();
    // 名字灰化（opacity-60）——名字保留（历史归因不丢）
    expect(within(row).getByText('Alice').className).toContain('opacity-60');
    // Avatar 灰化（grayscale + opacity-50）且隐藏 Bot 角标
    expect(row.querySelector('.grayscale')).not.toBeNull();
    expect(row.querySelector('.lucide-bot')).toBeNull();
    // 行操作菜单不受删除状态影响（移除/菜单仍可用——写入口由后端拦截）
    expect(screen.getByTestId('member-menu-a1')).toBeInTheDocument();
  });

  it('未删除成员不受影响：无「已删除」Badge、名字不灰化', () => {
    renderSheet({ members: [member('a1', 'member', 'Alice')] });

    const row = screen.getByTestId('member-row-a1');
    expect(within(row).queryByText('Deleted')).not.toBeInTheDocument();
    expect(within(row).getByText('Alice').className).not.toContain('opacity-60');
  });

  it('renderRowExtra / topSlot 插槽渲染', () => {
    renderSheet({
      members: [member('a1')],
      renderRowExtra: (m) => <span data-testid="row-extra">{m.actorId}-extra</span>,
      topSlot: <div data-testid="top-slot">seat-management</div>,
    });

    expect(screen.getByTestId('top-slot')).toHaveTextContent('seat-management');
    expect(screen.getByTestId('row-extra')).toHaveTextContent('a1-extra');
  });
});

describe('MembersSheet 视图切换与邀请流程', () => {
  it('主视图 ↔ 邀请视图切换：点「邀请成员」进入（返回 + 标题 + 候选区），返回回到主视图', () => {
    renderSheet({
      members: [member('a1')],
      candidates: [member('c1', 'candidate', 'Candidate One')],
      capabilities: { invite: true },
    });

    // 主视图 footer 邀请按钮
    expect(screen.getByTestId('open-invite')).toHaveTextContent('Invite members');
    fireEvent.click(screen.getByTestId('open-invite'));

    // 邀请视图：返回 + 标题 + 候选行
    expect(screen.getByTestId('invite-back')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Candidate One')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('invite-back'));
    expect(screen.getByTestId('open-invite')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-back')).not.toBeInTheDocument();
  });

  it('邀请视图搜索：客户端过滤候选行（agent + 人类两区同步过滤）', () => {
    renderSheet({
      candidates: [member('c1', 'candidate', 'Alpha'), member('c2', 'candidate', 'Beta')],
      humanCandidates: [member('h1', 'member', 'Carol', 'human')],
    });
    fireEvent.click(screen.getByTestId('open-invite'));

    fireEvent.change(screen.getByTestId('invite-search'), { target: { value: 'Alpha' } });

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.queryByText('Carol')).not.toBeInTheDocument();
  });

  it('checkbox 选择 → footer 计数与禁用态联动（0 禁用；勾选启用并计数；取消勾选回落）', () => {
    renderSheet({
      candidates: [member('c1', 'candidate', 'Alpha'), member('c2', 'candidate', 'Beta')],
      humanCandidates: [member('h1', 'member', 'Carol', 'human')],
    });
    fireEvent.click(screen.getByTestId('open-invite'));

    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 0');
    expect(screen.getByTestId('invite-submit')).toBeDisabled();

    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 1');
    expect(screen.getByTestId('invite-submit')).toBeEnabled();
    expect(screen.getByTestId('invite-submit')).toHaveTextContent('Invite 1');

    fireEvent.click(boxes[1]);
    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 2');
    expect(screen.getByTestId('invite-submit')).toHaveTextContent('Invite 2');

    fireEvent.click(boxes[0]);
    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 1');
  });

  it('onInvite resolve → 切回主视图 + 清空选择（重进邀请视图 footer 回落禁用）', async () => {
    const onInvite = jest.fn().mockResolvedValue(undefined);
    renderSheet({
      members: [member('a1')],
      candidates: [member('c1', 'candidate', 'Alpha')],
      onInvite,
    });

    fireEvent.click(screen.getByTestId('open-invite'));
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(onInvite).toHaveBeenCalledWith(['c1'], 'agent'));
    // 成功 → 切回主视图
    await waitFor(() => expect(screen.queryByTestId('invite-back')).not.toBeInTheDocument());
    // 选择已清空：重进邀请视图 footer 回落禁用
    fireEvent.click(screen.getByTestId('open-invite'));
    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 0');
    expect(screen.getByTestId('invite-submit')).toBeDisabled();
  });

  it('onInvite reject（R2）：留在邀请视图 + 选择集保留（页面层负责失败 toast）', async () => {
    const onInvite = jest.fn().mockRejectedValue(new Error('partial failure'));
    renderSheet({
      members: [member('a1')],
      candidates: [member('c1', 'candidate', 'Alpha')],
      onInvite,
    });

    fireEvent.click(screen.getByTestId('open-invite'));
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(onInvite).toHaveBeenCalledWith(['c1'], 'agent'));
    // 仍留在邀请视图 + 选择保留
    expect(screen.getByTestId('invite-back')).toBeInTheDocument();
    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 1');
  });

  it('agent + human 混合提交：按 kind 分组两次调用（全部成功才切回主视图）', async () => {
    const onInvite = jest.fn().mockResolvedValue(undefined);
    renderSheet({
      members: [member('a1')],
      candidates: [member('c1', 'candidate', 'Alpha')],
      humanCandidates: [member('h1', 'member', 'Carol', 'human')],
      onInvite,
    });

    fireEvent.click(screen.getByTestId('open-invite'));
    fireEvent.click(screen.getAllByRole('checkbox')[0]); // Alpha（agent 区先渲染）
    fireEvent.click(screen.getAllByRole('checkbox')[1]); // Carol（human 区）
    fireEvent.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(onInvite).toHaveBeenCalledTimes(2));
    expect(onInvite).toHaveBeenCalledWith(['c1'], 'agent');
    expect(onInvite).toHaveBeenCalledWith(['h1'], 'human');
    await waitFor(() => expect(screen.queryByTestId('invite-back')).not.toBeInTheDocument());
  });

  it('候选空态（P3）：candidates 全空 → 「所有 Agent 都已在成员中」', () => {
    renderSheet({
      members: [member('a1')],
      candidates: [],
      humanCandidates: [member('h1', 'member', 'Carol', 'human')],
    });
    fireEvent.click(screen.getByTestId('open-invite'));

    expect(screen.getByText('All agents are already members')).toBeInTheDocument();
    // 人类区不受影响（候选空态仅针对 agent 区）
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });

  it('人类候选区：不传 humanCandidates → 无人类区；传空数组 → 区显示 + 空态', () => {
    // 不传：无人类区（仅 agent 区）
    const { unmount } = renderSheet({ candidates: [member('c1', 'candidate', 'Alpha')] });
    fireEvent.click(screen.getByTestId('open-invite'));
    expect(screen.queryByText('Humans')).not.toBeInTheDocument();
    unmount();

    // 传空数组：人类区存在 + 空态文案
    renderSheet({
      candidates: [member('c1', 'candidate', 'Alpha')],
      humanCandidates: [],
    });
    fireEvent.click(screen.getByTestId('open-invite'));
    expect(screen.getByText('Humans')).toBeInTheDocument();
    expect(screen.getByText('No users available to invite')).toBeInTheDocument();
  });

  it('inviting=true → 提交按钮 loading + disabled（防重复提交）', () => {
    renderSheet({
      candidates: [member('c1', 'candidate', 'Alpha')],
      inviting: true,
    });
    fireEvent.click(screen.getByTestId('open-invite'));
    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    const submit = screen.getByTestId('invite-submit');
    expect(submit).toBeDisabled();
    // isLoading：按钮内 spinner（animate-spin）
    expect(submit.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('MembersSheet 关闭重置（R4）', () => {
  it('invite 视图关闭再打开 → 回到主视图（视图状态机重置）', () => {
    const onOpenChange = jest.fn();
    const props: MembersSheetProps = {
      open: true,
      onOpenChange,
      labels: LABELS,
      members: [member('a1')],
      candidates: [member('c1', 'candidate', 'Alpha')],
      capabilities: { invite: true },
      onInvite: jest.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<MembersSheet {...props} />);

    // 进入邀请视图
    fireEvent.click(screen.getByTestId('open-invite'));
    expect(screen.getByTestId('invite-back')).toBeInTheDocument();

    // 关闭 Sheet（右上 X → onOpenChange(false)）
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // 重新打开：永远是主视图
    rerender(<MembersSheet {...props} />);
    expect(screen.getByTestId('open-invite')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-back')).not.toBeInTheDocument();
  });

  it('invite 视图勾选后关闭 → 选择集清空（重开进邀请为 0 选中）', () => {
    const onOpenChange = jest.fn();
    const props: MembersSheetProps = {
      open: true,
      onOpenChange,
      labels: LABELS,
      members: [member('a1')],
      candidates: [member('c1', 'candidate', 'Alpha')],
      capabilities: { invite: true },
      onInvite: jest.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<MembersSheet {...props} />);

    fireEvent.click(screen.getByTestId('open-invite'));
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 1');

    fireEvent.click(screen.getByLabelText('Close'));
    rerender(<MembersSheet {...props} />);
    fireEvent.click(screen.getByTestId('open-invite'));
    expect(screen.getByTestId('invite-selected-count')).toHaveTextContent('Selected 0');
  });
});

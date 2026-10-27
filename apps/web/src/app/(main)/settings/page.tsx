'use client';

import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { useTranslations } from 'next-intl';
import { motion, MotionConfig } from 'framer-motion';
import { Api } from '@/lib/api';
import { toast } from '@/lib/notify';
import { QueryFeedback } from '@/components/ui/query-feedback';
import { errorMessageOf } from '@/lib/error-message';
import { fadeSlideUp } from '@/lib/animations';
import { UserRole } from '@/types';
import type { User as UserDto } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { NotificationsTab } from '@/components/settings/notifications-tab';
// 主题分区已移除（dark-only 收敛，见 docs/frontend/ui-design-system.md），Sun/Moon/Palette 图标不再需要
import { User, Lock, Upload, RotateCcw, Languages, BellRing, ShieldCheck } from 'lucide-react';

/**
 * 设置页 tab 值域（受控 Tabs 的唯一状态来源）。
 *
 * 值域写成联合类型而不是 string：`onValueChange` 的入参是 string，收窄点只有一处
 * （见 `setActiveTab(v as SettingsTab)`），换来的是分支处编译期校验。
 */
type SettingsTab = 'profile' | 'security' | 'notifications';

export default function SettingsPage() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  // 仅「语言」分区先行 i18n（Phase 0 基础设施验证）；本页其余文案由批次 E 统一抽取
  const tLang = useTranslations('settings.language');
  const t = useTranslations('settings');
  const tRead = useTranslations('common');

  const [name, setName] = useState(user?.name || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // 头像设置：SVG 文件上传 / 外部 URL / 恢复默认 三通道共享一对成功/错误提示
  const [avatarUrlInput, setAvatarUrlInput] = useState('');
  const [avatarError, setAvatarError] = useState('');
  const [avatarSuccess, setAvatarSuccess] = useState('');
  const svgFileInputRef = useRef<HTMLInputElement>(null);

  /**
   * 受控 tab（Notifications 二期批 3：设置页从"一列卡片"重构为三 tab 壳）。
   * 默认落在「资料」——它是本页唯一"每次进来都可能有改动"的分区。
   */
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  /**
   * 通知 tab 的"入场已播"标记（plan §D6：卡片区入场只播一次）。
   *
   * 标记放在**页级**而不是 tab 内：TabsContent 切走即卸载，标记若在 tab 内部，
   * "切到安全再切回来"会重播整屏入场（用户看到的是闪一下，不是动效）。
   */
  const notificationEntrancePlayedRef = useRef(false);

  const profileQuery = useQuery({
    queryKey: ['user', 'profile'],
    queryFn: () => Api.users.me(),
  });
  const { data: profile, isLoading } = profileQuery;

  const updateProfileMutation = useMutation({
    mutationFn: (data: { name: string }) => Api.users.updateMe(data),
    onSuccess: (data) => {
      setUser(data);
      void queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (err) => toast.error({ title: errorMessageOf(err, t('profile.saveFailed')) }),
  });

  /** 头像更新成功后统一收尾：刷新 auth store（navbar 即时生效）+ 失效 user 查询 */
  const onAvatarUpdated = (updated: UserDto) => {
    setUser(updated);
    setAvatarUrlInput('');
    void queryClient.invalidateQueries({ queryKey: ['user'] });
  };

  /** 通道一：上传 SVG 自绘头像（PUT /avatars/me/svg，后端 sanitize 后联动 avatarUrl 短链） */
  const uploadSvgMutation = useMutation({
    mutationFn: (svg: string) => Api.avatars.uploadSvg(svg),
    onSuccess: async () => {
      onAvatarUpdated(await Api.users.me());
      setAvatarSuccess(t('avatar.svgUploaded'));
    },
    onError: (err) => setAvatarError(errorMessageOf(err, t('avatar.svgUploadFailed'))),
  });

  /** 通道二：保存外部头像 URL（存量 updateMe avatar 字段，后端 @IsUrl 校验） */
  const updateAvatarUrlMutation = useMutation({
    mutationFn: (avatar: string) => Api.users.updateMe({ avatar }),
    onSuccess: (data) => {
      onAvatarUpdated(data);
      setAvatarSuccess(t('avatar.urlSaved'));
    },
    onError: (err) => setAvatarError(errorMessageOf(err, t('avatar.urlSaveFailed'))),
  });

  /**
   * 通道三：恢复默认。avatar 传 null——后端 @IsOptional() 对 null 跳过 @IsUrl 校验，
   * service 落 NULL；空字符串会被 @IsUrl 拒绝（400），不能用空串清空。
   */
  const resetAvatarMutation = useMutation({
    mutationFn: () => Api.users.updateMe({ avatar: null }),
    onSuccess: (data) => {
      onAvatarUpdated(data);
      setAvatarSuccess(t('avatar.resetDone'));
    },
    onError: (err) => setAvatarError(errorMessageOf(err, t('avatar.resetFailed'))),
  });

  /** 读取本地 SVG 文件文本并上传；前端先做 32KB 预检（与后端上限一致），避免无效请求 */
  const handleSvgFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 重置 input，允许重复选择同一文件再次触发 change
    if (!file) return;
    setAvatarError('');
    setAvatarSuccess('');
    if (file.size > 32 * 1024) {
      setAvatarError(t('avatar.svgTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') uploadSvgMutation.mutate(reader.result);
    };
    reader.onerror = () => setAvatarError(t('avatar.readFailed'));
    reader.readAsText(file);
  };

  const handleSaveAvatarUrl = () => {
    setAvatarError('');
    setAvatarSuccess('');
    const url = avatarUrlInput.trim();
    if (!url) {
      setAvatarError(t('avatar.enterUrl'));
      return;
    }
    try {
      new URL(url);
    } catch {
      setAvatarError(t('avatar.invalidUrl'));
      return;
    }
    updateAvatarUrlMutation.mutate(url);
  };

  const handleResetAvatar = () => {
    setAvatarError('');
    setAvatarSuccess('');
    resetAvatarMutation.mutate();
  };

  const changePasswordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      Api.users.changePassword(data),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
    },
    onError: (err: unknown) => {
      const message = errorMessageOf(err, t('password.changeFailed'));
      setPasswordError(message);
    },
  });

  const handleUpdateProfile = () => {
    if (!name.trim()) return;
    updateProfileMutation.mutate({ name });
  };

  const handleChangePassword = () => {
    setPasswordError('');
    if (newPassword !== confirmPassword) {
      setPasswordError(t('password.mismatch'));
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError(t('password.tooShort'));
      return;
    }
    changePasswordMutation.mutate({ currentPassword, newPassword });
  };

  const displayUser = profile || user;

  /** tab 标签（值与文案一起列出：新增 tab 时编译期就会提醒补文案） */
  const TAB_LABELS: Record<SettingsTab, { label: string; icon: typeof User }> = {
    profile: { label: t('tabs.profile'), icon: User },
    security: { label: t('tabs.security'), icon: ShieldCheck },
    notifications: { label: t('tabs.notifications'), icon: BellRing },
  };

  const TAB_VALUES: SettingsTab[] = ['profile', 'security', 'notifications'];

  return (
    // reducedMotion="user"：全页 framer-motion 动画尊重 prefers-reduced-motion（设计文档 §5）
    <MotionConfig reducedMotion="user">
      <div className="space-y-6 max-w-2xl">
        {/* 页头：克制的青光点缀（仅标题，正文禁用）+ 淡入上移（admin-dashboard 克制版） */}
        <motion.div variants={fadeSlideUp} initial="hidden" animate="show">
          <h1 className="text-glow-cyan text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </motion.div>

        {/* 受控三 tab 壳：资料（原有卡片纯移动）/ 安全（密码卡）/ 通知（新建） */}
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SettingsTab)}>
          <TabsList className="w-full">
            {TAB_VALUES.map((value) => {
              const { label, icon: Icon } = TAB_LABELS[value];
              const selected = activeTab === value;
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-testid={`settings-tab-${value}`}
                  /*
                    不写 `aria-controls`：TabsContent 的 `role="tabpanel"` 壳不在本页控制范围内
                    （tabs.tsx 不透传 id），把 aria-controls 指向"面板内部那个 div"会让读屏
                    拿到一条**指向非 tabpanel 元素**的关系——比不写更糟。ARIA tabs 模式里
                    aria-controls 是可选属性，tablist / tab / aria-selected 三元组才是契约。
                    另外：选中底色改由滑动 pill 提供，基线的 bg-background/shadow-sm 被这里的
                    bg-transparent/shadow-none 覆盖（cn = twMerge，后者胜），否则会出现
                    "pill 之外还有一块静态底色"的双层选中态。
                  */
                  className="relative flex-1 bg-transparent shadow-none"
                >
                  {/*
                    唯一滑动指示器（layoutId 全树仅 1 个）：只有选中项渲染，切 tab 时
                    framer-motion 让它平滑移动；reduced-motion 由 MotionConfig 降级为静态。
                  */}
                  {selected && (
                    <motion.span
                      layoutId="settings-tab-pill"
                      transition={{ duration: 0.25, ease: 'easeOut' }}
                      className="absolute inset-0 rounded-md border border-primary/30 bg-primary/15 shadow-glow-sm"
                      aria-hidden="true"
                    />
                  )}
                  <span className="relative z-10 inline-flex items-center gap-1.5">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {label}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {/* ── 资料：个人资料 + 头像 + 语言（原有三卡，行为零改动） ── */}
          <TabsContent value="profile" className="mt-4">
            {/*
              内容根挂 key=activeTab：只有激活的那个 TabsContent 会在树上（未激活返回 null），
              故 key 变化即重挂 → 重播 fadeSlideUp。
              ⚠️ 不能把 key 放在 TabsContent 上：三个 Content 会拿到同一个 key，触发 React
              重复 key 警告（key 必须在其兄弟之间唯一）。
            */}
            <motion.div
              key={activeTab}
              variants={fadeSlideUp}
              initial="hidden"
              animate="show"
              id="settings-panel-profile"
              className="space-y-6"
            >
              {/* Language Card：语言偏好写入 NEXT_LOCALE cookie，全站即时生效 */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Languages className="h-5 w-5" />
                    {tLang('title')}
                  </CardTitle>
                  <CardDescription>{tLang('description')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <LocaleSwitcher />
                </CardContent>
              </Card>

              {/* Profile Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <User className="h-5 w-5" />
                    {t('profile.title')}
                  </CardTitle>
                  <CardDescription>{t('profile.description')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {profileQuery.isError && profile !== undefined && (
                    <QueryFeedback
                      compact={profileQuery.data !== undefined}
                      message={errorMessageOf(
                        profileQuery.error,
                        tRead(profileQuery.data !== undefined ? 'refreshFailed' : 'loadFailed'),
                      )}
                      onRetry={() => void profileQuery.refetch()}
                      busy={profileQuery.isFetching}
                    />
                  )}
                  {profileQuery.isError && profile === undefined ? (
                    <QueryFeedback
                      compact={profileQuery.data !== undefined}
                      message={errorMessageOf(
                        profileQuery.error,
                        tRead(profileQuery.data !== undefined ? 'refreshFailed' : 'loadFailed'),
                      )}
                      onRetry={() => void profileQuery.refetch()}
                      busy={profileQuery.isFetching}
                    />
                  ) : isLoading ? (
                    <Loading />
                  ) : (
                    <>
                      <div className="flex items-center gap-4">
                        <Avatar
                          src={displayUser?.avatar ?? undefined}
                          fallback={displayUser?.name || 'U'}
                          size="lg"
                          seed={displayUser?.id}
                        />
                        <div>
                          <p className="font-medium">{displayUser?.name}</p>
                          <p className="text-sm text-muted-foreground">{displayUser?.email}</p>
                          <Badge variant="outline" className="mt-1">
                            {displayUser?.role === UserRole.ADMIN
                              ? t('role.admin')
                              : displayUser?.role || t('role.user')}
                          </Badge>
                        </div>
                      </div>

                      {/* 头像设置：上方 lg 头像即当前预览；三通道——SVG 上传 / 外部 URL / 恢复默认 */}
                      <div className="space-y-3 rounded-lg border border-border/60 p-4">
                        <label className="text-sm font-medium">{t('avatar.title')}</label>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => svgFileInputRef.current?.click()}
                            isLoading={uploadSvgMutation.isPending}
                          >
                            <Upload className="mr-1 h-4 w-4" />
                            {t('avatar.uploadSvg')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleResetAvatar}
                            isLoading={resetAvatarMutation.isPending}
                          >
                            <RotateCcw className="mr-1 h-4 w-4" />
                            {t('avatar.resetDefault')}
                          </Button>
                        </div>
                        <input
                          ref={svgFileInputRef}
                          type="file"
                          accept=".svg,image/svg+xml"
                          className="hidden"
                          onChange={handleSvgFileChange}
                        />
                        <div className="flex gap-2">
                          <Input
                            value={avatarUrlInput}
                            onChange={(e) => setAvatarUrlInput(e.target.value)}
                            placeholder="https://example.com/avatar.png"
                          />
                          <Button
                            variant="outline"
                            className="shrink-0"
                            onClick={handleSaveAvatarUrl}
                            isLoading={updateAvatarUrlMutation.isPending}
                          >
                            {t('avatar.saveUrl')}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t('avatar.helpText')}</p>
                        {avatarError && (
                          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                            {avatarError}
                          </div>
                        )}
                        {avatarSuccess && (
                          // 暗色适配：半透明语义色底 + 亮色文字（与「密码修改成功」提示同款）
                          <div className="rounded-md bg-emerald-500/15 p-3 text-sm text-emerald-300">
                            {avatarSuccess}
                          </div>
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('profile.username')}</label>
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder={t('profile.usernamePlaceholder')}
                        />
                      </div>
                      <Button
                        onClick={handleUpdateProfile}
                        isLoading={updateProfileMutation.isPending}
                      >
                        {t('profile.saveChanges')}
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          {/* ── 安全：密码卡（原有卡片，行为零改动） ── */}
          <TabsContent value="security" className="mt-4">
            <motion.div
              key={activeTab}
              variants={fadeSlideUp}
              initial="hidden"
              animate="show"
              id="settings-panel-security"
              className="space-y-6"
            >
              {/* Theme Card 已移除：站点收敛为单套暗色主题（dark-only），无明暗切换 */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Lock className="h-5 w-5" />
                    {t('password.title')}
                  </CardTitle>
                  <CardDescription>{t('password.description')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('password.current')}</label>
                    <Input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder={t('password.currentPlaceholder')}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('password.new')}</label>
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder={t('password.newPlaceholder')}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('password.confirm')}</label>
                    <Input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder={t('password.confirmPlaceholder')}
                    />
                  </div>
                  {passwordError && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                      {passwordError}
                    </div>
                  )}
                  {changePasswordMutation.isSuccess && (
                    // 暗色适配：半透明语义色底 + 亮色文字（替代原亮主题 emerald-100/800 硬编码）
                    <div className="rounded-md bg-emerald-500/15 p-3 text-sm text-emerald-300">
                      {t('password.success')}
                    </div>
                  )}
                  <Button
                    onClick={handleChangePassword}
                    isLoading={changePasswordMutation.isPending}
                  >
                    {t('password.changeButton')}
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          {/* ── 通知：新建（Notifications 二期批 3 全量） ── */}
          <TabsContent value="notifications" className="mt-4">
            <motion.div
              key={activeTab}
              variants={fadeSlideUp}
              initial="hidden"
              animate="show"
              id="settings-panel-notifications"
            >
              <NotificationsTab entrancePlayedRef={notificationEntrancePlayedRef} />
            </motion.div>
          </TabsContent>
        </Tabs>
      </div>
    </MotionConfig>
  );
}

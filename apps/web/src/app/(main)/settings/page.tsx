'use client';

import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { useAuthStore } from '@/stores/auth.store';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { UserRole } from '@/types';
import type { ApiResponse, User as UserDto } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { LocaleSwitcher } from '@/components/locale-switcher';
// 主题分区已移除（dark-only 收敛，见 docs/ui-design-system.md），Sun/Moon/Palette 图标不再需要
import { User, Lock, Upload, RotateCcw, Languages } from 'lucide-react';

/** 提取后端统一响应体中的 message（如 400 SVG sanitize 拒绝原因），兜底友好文案 */
function errorMessage(err: unknown, fallback: string): string {
  const data = (err as AxiosError<ApiResponse<unknown>>)?.response?.data;
  return (typeof data?.message === 'string' && data.message) || fallback;
}

export default function SettingsPage() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  // 仅「语言」分区先行 i18n（Phase 0 基础设施验证）；本页其余文案由批次 E 统一抽取
  const tLang = useTranslations('settings.language');
  const t = useTranslations('settings');

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

  const { data: profile, isLoading } = useQuery({
    queryKey: ['user', 'profile'],
    queryFn: () => Api.users.me(),
  });

  const updateProfileMutation = useMutation({
    mutationFn: (data: { name: string }) => Api.users.updateMe(data),
    onSuccess: (data) => {
      setUser(data);
      void queryClient.invalidateQueries({ queryKey: ['user'] });
    },
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
    onError: (err) => setAvatarError(errorMessage(err, t('avatar.svgUploadFailed'))),
  });

  /** 通道二：保存外部头像 URL（存量 updateMe avatar 字段，后端 @IsUrl 校验） */
  const updateAvatarUrlMutation = useMutation({
    mutationFn: (avatar: string) => Api.users.updateMe({ avatar }),
    onSuccess: (data) => {
      onAvatarUpdated(data);
      setAvatarSuccess(t('avatar.urlSaved'));
    },
    onError: (err) => setAvatarError(errorMessage(err, t('avatar.urlSaveFailed'))),
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
    onError: (err) => setAvatarError(errorMessage(err, t('avatar.resetFailed'))),
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
      const message = err instanceof Error ? err.message : t('password.changeFailed');
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

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

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
          {isLoading ? (
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
              <Button onClick={handleUpdateProfile} isLoading={updateProfileMutation.isPending}>
                {t('profile.saveChanges')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Theme Card 已移除：站点收敛为单套暗色主题（dark-only），无明暗切换 */}

      {/* Password Card */}
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
          <Button onClick={handleChangePassword} isLoading={changePasswordMutation.isPending}>
            {t('password.changeButton')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

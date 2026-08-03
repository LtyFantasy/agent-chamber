/**
 * 更新用户资料请求输入
 */
export interface UpdateProfileInput {
  /** 昵称 */
  name?: string;
  /** 头像 URL；传 null 表示清空头像（回落确定性生成头像），并联动清除 avatar_svg */
  avatar?: string | null;
  /** 用户偏好设置 */
  preferences?: Record<string, unknown>;
}

/**
 * 修改密码请求输入
 */
export interface ChangePasswordInput {
  /** 当前密码 */
  currentPassword: string;
  /** 新密码 */
  newPassword: string;
}

/**
 * 更新用户设置请求输入
 */
export interface UpdateSettingsInput {
  /** 主题 */
  theme?: string;
  /** 语言 */
  language?: string;
  /** 邮件通知 */
  emailNotifications?: boolean;
  /** 推送通知 */
  pushNotifications?: boolean;
  /** 通知总开关 */
  notifications?: boolean;
}

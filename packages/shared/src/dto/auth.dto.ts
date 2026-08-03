/**
 * 登录请求输入
 */
export interface LoginInput {
  /** 邮箱 */
  email: string;
  /** 密码 */
  password: string;
  /** 验证码（可选） */
  captcha?: string;
}

/**
 * 注册请求输入
 */
export interface RegisterInput {
  /** 邮箱 */
  email: string;
  /** 密码 */
  password: string;
  /** 昵称 */
  name: string;
  /** 邀请码（可选） */
  inviteCode?: string;
}

/**
 * 刷新 Token 请求输入
 */
export interface RefreshTokenInput {
  /** 刷新令牌 */
  refreshToken: string;
}

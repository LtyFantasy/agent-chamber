/**
 * 用户基本信息
 */
export interface User {
  /** 用户 ID */
  id: string;
  /** 邮箱 */
  email: string;
  /** 昵称 */
  name: string;
  /** 角色 */
  role: 'admin' | 'editor';
  /** 头像 URL */
  avatar?: string | null;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 最后登录时间 */
  lastLoginAt?: string | Date | null;
}

/**
 * Admin 用户管理专用类型
 */
export interface AdminUser {
  /** 用户 ID */
  id: string;
  /** 邮箱 */
  email: string;
  /** 昵称 */
  name: string;
  /** 角色 */
  role: 'admin' | 'editor';
  /** 账号状态 */
  status: string;
  /** 头像 URL */
  avatar?: string | null;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 最后登录时间 */
  lastLoginAt?: string | Date | null;
}

/**
 * [前端 Response] apps/web/src/types/index.ts (User interface)
 * [注意] 修改字段时需同步检查前端 User Response 类型
 *
 * User 已降级为 human profile 子类，公共字段上提到 Actor。
 * 通过 getter/setter 保持对旧代码的兼容（displayName/avatarUrl/status/createdAt/updatedAt/deletedAt）。
 */
import { Entity, Column, Index, OneToOne, JoinColumn, OneToMany, PrimaryColumn } from 'typeorm';
import { UserRole } from '@agent-chamber/shared';
import { Actor } from './actor.entity';
import { Agent } from './agent.entity';
import { RefreshToken } from './refresh-token.entity';

@Entity('users')
@Index(['username'], { unique: true })
@Index(['email'], { unique: true })
@Index('idx_unique_admin', ['role'], { unique: true, where: "role = 'admin'" })
export class User {
  /** 主键即外键，指向 actors.id */
  @PrimaryColumn('uuid')
  id: string;

  @OneToOne(() => Actor, (actor) => actor.user, { eager: true, cascade: true })
  @JoinColumn({ name: 'id' })
  actor: Actor;

  get displayName(): string | null {
    return this.actor?.displayName ?? null;
  }

  set displayName(value: string | null) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.displayName = value;
  }

  get avatarUrl(): string | null {
    return this.actor?.avatarUrl ?? null;
  }

  set avatarUrl(value: string | null) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.avatarUrl = value;
  }

  get status(): string {
    return this.actor?.status ?? 'active';
  }

  set status(value: string) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.status = value;
  }

  get createdAt(): Date {
    return this.actor?.createdAt;
  }

  set createdAt(value: Date) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.createdAt = value;
  }

  get updatedAt(): Date {
    return this.actor?.updatedAt;
  }

  set updatedAt(value: Date) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.updatedAt = value;
  }

  get deletedAt(): Date | null {
    return this.actor?.deletedAt ?? null;
  }

  set deletedAt(value: Date | null) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.deletedAt = value;
  }

  @Column({ type: 'varchar', length: 50, nullable: false })
  username: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'password_hash', select: false })
  passwordHash: string | null;

  @Column({ type: 'varchar', length: 30, default: 'local', name: 'auth_provider' })
  authProvider: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'auth_provider_id' })
  authProviderId: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: UserRole.EDITOR,
  })
  role: UserRole;

  @Column({ type: 'jsonb', default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preferences: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_login_at' })
  lastLoginAt: Date | null;

  @OneToMany(() => Agent, (agent) => agent.owner)
  agents: Agent[];

  @OneToMany(() => RefreshToken, (rt) => rt.user)
  refreshTokens: RefreshToken[];
}

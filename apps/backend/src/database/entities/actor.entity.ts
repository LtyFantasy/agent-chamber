/**
 * 统一身份根表（Actor）
 *
 * 采用 Supertype/Subtype 模式：
 * - actors 表保存所有身份实体的公共字段与生命周期
 * - users / agents 表通过 PK = FK 指向 actors，保存各自子类字段
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToOne,
} from 'typeorm';
import { ActorType } from '@agent-chamber/shared';
import { User } from './user.entity';
import { Agent } from './agent.entity';

@Entity('actors')
export class Actor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: ActorType,
    default: ActorType.HUMAN,
  })
  type: ActorType;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'display_name' })
  displayName: string | null;

  @Column({ type: 'text', nullable: true, name: 'avatar_url' })
  avatarUrl: string | null;

  /**
   * 自绘 SVG 头像原文（PUT /avatars/me/svg 写入，上限 32KB，拒绝式 sanitize 后入库）。
   * 对外仅通过 GET /avatars/:actorId.svg 以 image/svg+xml 分发；
   * avatarUrl 同步指向该短链，SVG 原文不进入任何业务 DTO。
   */
  @Column({ type: 'text', nullable: true, name: 'avatar_svg' })
  avatarSvg: string | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @OneToOne(() => User, (user) => user.actor)
  user?: User;

  @OneToOne(() => Agent, (agent) => agent.actor)
  agent?: Agent;
}

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *   - 补充: docs/api-definition.md §3. Auth
 *
 * [踩坑索引] AUTH-BOOTSTRAP-001(首次启动管理员)
 *
 * [铁律关联] #4(文档优先) #7(编译优先) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条）
 *   AUTH-BOOTSTRAP-001: 新数据库没有管理员时受保护的注册接口无法创建首个账号。启动时仅在显式配置凭据后补建唯一 admin。见 memory/2026-07-31.md §AUTH-BOOTSTRAP-001
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { Actor } from '../../database/entities/actor.entity';
import { User } from '../../database/entities/user.entity';
import { ActorType, UserRole } from '@agent-chamber/shared';

@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Creates the first administrator when explicit bootstrap credentials are configured.
   * @returns Resolves after checking or creating the administrator; failures are logged.
   * @sideEffects May insert one Actor and one User, but never blocks application startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    const email = this.configService.get<string>('ADMIN_EMAIL');
    const password = this.configService.get<string>('ADMIN_PASSWORD');

    // Bootstrap is intentionally disabled unless both credentials are explicitly supplied.
    if (!email || !password) {
      this.logger.debug('Admin bootstrap skipped: ADMIN_EMAIL or ADMIN_PASSWORD is not set');
      return;
    }

    try {
      const existingAdmin = await this.userRepo.findOne({
        where: { role: UserRole.ADMIN },
      });
      if (existingAdmin) {
        this.logger.log('Admin bootstrap skipped: an admin user already exists');
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const actor = new Actor();
      actor.type = ActorType.HUMAN;
      actor.displayName = email.split('@')[0] || 'Admin';
      actor.status = 'active';
      await this.userRepo.manager.save(actor);

      const user = this.userRepo.create({
        id: actor.id,
        actor,
        email,
        username: email.split('@')[0] + '_' + Math.random().toString(36).substring(2, 6),
        passwordHash,
        role: UserRole.ADMIN,
      });

      await this.userRepo.save(user);
      this.logger.log(`Admin user created: ${email}`);
    } catch (error) {
      this.logger.error(
        'Admin bootstrap failed; application startup will continue',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

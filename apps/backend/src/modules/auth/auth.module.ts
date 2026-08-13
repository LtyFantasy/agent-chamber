/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *   - 补充: docs/api-definition.md §3. Auth
 *
 * [踩坑索引] （暂无重大踩坑）
 *
 * [铁律关联] #4(文档优先) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { ApiKeyAuthService } from '../../common/services/api-key-auth.service';
import { User } from '../../database/entities/user.entity';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken, ApiKey, Agent]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('jwt.secret'),
        signOptions: { expiresIn: configService.get('jwt.expiresIn') || '2h' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    AuthService,
    AdminBootstrapService,
    JwtStrategy,
    ApiKeyGuard,
    JwtOrApiKeyGuard,
    // 认证逻辑单一事实来源：两个 HTTP guard 与 WS 握手（roundtable 模块，阶段 3）
    // 三方共用；AuthModule 为 @Global()，子模块直接注入（M1 圆桌计划决策 4）
    ApiKeyAuthService,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtModule, ApiKeyGuard, JwtOrApiKeyGuard, ApiKeyAuthService],
})
export class AuthModule {}

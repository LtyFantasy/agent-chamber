import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { Agent } from '../../database/entities/agent.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { User } from '../../database/entities/user.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { AuditModule } from '../audit/audit.module';
import { TaskModule } from '../task/task.module';

@Module({
  // 活动日志插桩（plan shadowcat-sunspot-catwoman Phase 2）：agent 写操作全量记
  // TaskModule：getMyBriefing 编排依赖 TaskService.findAll + TaskDependencyService.hasBlockers
  // （plan captain-atom-crimson-avenger-rocket-dc §2.1：唯一路线，无循环依赖已实证——
  // TaskModule imports 仅 EventModule+AuditModule，全仓除 AppModule 外无模块 import AgentModule）
  imports: [
    TypeOrmModule.forFeature([Agent, ApiKey, User, RoundtableSeat]),
    AuditModule,
    TaskModule,
  ],
  providers: [AgentService],
  controllers: [AgentController],
  exports: [AgentService],
})
export class AgentModule {}

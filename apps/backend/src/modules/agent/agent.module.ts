import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { Agent } from '../../database/entities/agent.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { User } from '../../database/entities/user.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  // 活动日志插桩（plan shadowcat-sunspot-catwoman Phase 2）：agent 写操作全量记
  imports: [TypeOrmModule.forFeature([Agent, ApiKey, User, RoundtableSeat]), AuditModule],
  providers: [AgentService],
  controllers: [AgentController],
  exports: [AgentService],
})
export class AgentModule {}

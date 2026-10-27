import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskService } from './task.service';
import { TaskController } from './task.controller';
import { TaskDependencyService } from './task-dependency.service';
import { MilestoneService } from './milestone.service';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { TaskActivity } from '../../database/entities/task-activity.entity';
import { TaskDependency } from '../../database/entities/task-dependency.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { Milestone } from '../../database/entities/milestone.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Actor } from '../../database/entities/actor.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Board } from '../../database/entities/board.entity';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { EventModule } from '../event/event.module';
import { AuditModule } from '../audit/audit.module';
import { DocSpacePolicy } from '../../common/policies/doc-space.policy';
import { TaskHygieneHintProvider } from './task-hygiene-hint.provider';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Task,
      TaskComment,
      TaskActivity,
      TaskDependency,
      TaskDocLink,
      Doc,
      DocSpace,
      DocSpaceMember,
      Milestone,
      User,
      ApiKey,
      Agent,
      Actor,
      BoardList,
      Board,
      Topic,
      TopicParticipant,
    ]),
    EventModule,
    AuditModule,
  ],
  providers: [
    TaskService,
    TaskDependencyService,
    MilestoneService,
    DocSpacePolicy,
    // 阶段三：task 纪律族 hint provider（hint 拦截器按事实袋求值；
    // **必须在本模块 provide**——它的 Repository 依赖全部来自本模块 forFeature）
    TaskHygieneHintProvider,
  ],
  controllers: [TaskController],
  // `TaskHygieneHintProvider` 的导出是**功能性**的（不是惯例）：AppModule 的
  // `HINT_FACT_PROVIDERS` 工厂（config/app-hint-provider-chain.ts 单源）按类引用注入它，
  // 撤销导出 = 启动期 DI 红（与 MemoryModule 导出 MemoryNominationHintProvider 同款）
  exports: [TaskService, TaskDependencyService, MilestoneService, TaskHygieneHintProvider],
})
export class TaskModule {}

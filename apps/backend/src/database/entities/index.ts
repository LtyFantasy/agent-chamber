export { Actor } from './actor.entity';
export { User } from './user.entity';
export { RefreshToken } from './refresh-token.entity';
export { Agent } from './agent.entity';
export { ApiKey } from './api-key.entity';
export { Topic } from './topic.entity';
export { TopicParticipant } from './topic-participant.entity';
export { Message } from './message.entity';
export { Board } from './board.entity';
export { BoardList } from './board-list.entity';
export { BoardMember } from './board-member.entity';
export { Task } from './task.entity';
export { TaskComment } from './task-comment.entity';
export { TaskActivity } from './task-activity.entity';
export { Event } from './event.entity';
export { AgentHeartbeat } from './agent-heartbeat.entity';
export { AuditLog } from './audit-log.entity';
export { WebhookDelivery } from './webhook-delivery.entity';
export { Milestone } from './milestone.entity';
export { TaskDependency } from './task-dependency.entity';
export { IdempotencyRecord } from './idempotency-record.entity';
export { DocSpace } from './doc-space.entity';
export { DocSpaceMember } from './doc-space-member.entity';
export { DocCategory } from './doc-category.entity';
export { Doc } from './doc.entity';
export { DocSection } from './doc-section.entity';
export { DocVersion } from './doc-version.entity';
export { TaskDocLink } from './task-doc-link.entity';
export { DocRoute } from './doc-route.entity';
export { RoundtableRunner } from './roundtable-runner.entity';
export { RoundtableSeat } from './roundtable-seat.entity';
export { RoundtablePermissionRequest } from './roundtable-permission-request.entity';
export { Attachment } from './attachment.entity';
export { ApiUsageStatsHourly } from './api-usage-stats-hourly.entity';
export { ExperienceEntry } from './experience-entry.entity';
export { ExperienceFeedback } from './experience-feedback.entity';
export { ExperienceSearchEvent } from './experience-search-event.entity';
// 第二期（经验库自治治理面）双表：
// - ExperienceSpaceMember = 空间成员角色（owner/reviewer，终审权委托）
// - ExperienceJudgmentRecord = 判断日志（append-only 语料；类名刻意不带 "Record" 之外的
//   区分见实体文件头——shared 的 `ExperienceJudgment` 是 jsonb 快照形状，同名会撞）
export { ExperienceSpaceMember } from './experience-space-member.entity';
export { ExperienceJudgmentRecord } from './experience-judgment-record.entity';
// Memory 模块（Hument 集成一期，memory 分支）四表：
// - MemoryProject = 项目注册表（绑定列表 + 可空引擎绑定 + 权限锚点）
// - MemoryNomination = 提名账本（引擎外耐久载体；engine_memory_ids 是映射单源）
// - MemoryFormationEvent = 形成尝试遥测（每次尝试一行，**无 FK**）
// - MemoryRecallEvent = 召回遥测（失败也落，**无 FK**）
// 两张遥测表刻意无 FK：日志不随主体删除（同 experience_judgments 先例）。
export { MemoryProject } from './memory-project.entity';
export { MemoryNomination } from './memory-nomination.entity';
export { MemoryFormationEvent } from './memory-formation-event.entity';
export { MemoryRecallEvent } from './memory-recall-event.entity';
// 引擎身份永久占用表（Hument Usage 隔离前提）：四列唯一 + engine<>'none'，永久不释放。
// `project_id` **无 FK**（项目硬删后 claim 必须保留），见该实体文件头。
export { MemoryEngineBindingClaim } from './memory-engine-binding-claim.entity';
// Notifications 模块（外部 IM 通知出口，一期）单表：
// - NotificationDelivery = 投递记录（**只落终态** success/failed 的 append-only 行；
//   `event_id` 无 FK——弱关联，日志须比事件行活得久；无 updated_at / deleted_at）
export { NotificationDelivery } from './notification-delivery.entity';
// Notifications 二期（多用户化）：渠道绑定表 —— per-user provider 绑定 + tombstone 解绑
// （`unbound_at`，不真删）+ 验证锚点（`last_test_address`）。deliveryEligible 谓词的单源
// 与两个值域常量都在该实体文件里（`deliveryEligibleWhere()`）。
export { UserNotificationChannel } from './user-notification-channel.entity';

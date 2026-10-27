/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 健康检查模块装配：`/health`（liveness）+ `/health/ready`（readiness）
 *   - readiness 的 `optional.memoryEngine` 桶 = **引擎告警态视图**（`ENGINE_HEALTH_VIEW`）
 * [代码职责]
 *   - 与 AppModule 共用发行门，关闭时仅保留平台探针。
 * [权威文档]
 *   - 线上 docs/integrations/oss-dual-repo.md §11（临时发行边界）
 *
 * [关键不变量]
 *   - **依赖方向单向无环**：HealthModule → MemoryModule（只为 `ENGINE_HEALTH_VIEW` token）。
 *     Memory 不 import Health——反向一条边就成环。MemoryModule 在 app.module 里已注册，
 *     Nest 按模块类缓存 ⇒ 这里 import 不会产生第二个实例；发行关闭时两处都不得注册。
 *   - **`optional.memoryEngine` 不参与整体就绪判定**：它是观测/查询面，不是摘流判据
 *     （`degraded` 可被任何登录用户诱发，见 `docs/api-definition.md` §19.2）。
 *
 * [关联代码]
 *   - health.controller.ts — 两个端点的实现（含 optional 桶的 try/catch 与固定映射）
 *   - ../modules/memory/memory.module.ts — `ENGINE_HEALTH_VIEW` 的 provide/export 处
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';
import { HealthController } from './health.controller';
// ⚠️ 只为 `ENGINE_HEALTH_VIEW` 而 import（单向：Health → Memory，见文件头不变量）
import { MemoryModule } from '../modules/memory/memory.module';

/**
 * 健康检查模块
 *
 * 提供 /health（存活）和 /health/ready（就绪）端点，无认证限制。
 */
@Module({
  imports: MEMORY_FEATURE_ENABLED ? [MemoryModule] : [],
  controllers: [HealthController],
})
export class HealthModule {}

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * ⚠️ **兼容垫片 / 已弃用（@deprecated）——请勿在此新增任何内容**
 *
 * [功能概念]
 *   - 判别契约的**旧深路径 re-export**：本文件原为"经验库判别提供方抽象"，v1.85.0 批次 2
 *     判别通用化后，契约已上移内核 `modules/judgment/`
 *
 * [代码职责]
 *   - 仅做 re-export（内核契约 + 本能力的输入类型）；**零逻辑、零类型定义**
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/spec.md` — `JudgmentCapability` 终稿形状（新路径为准）
 *
 * [关键不变量]
 *   - **本文件不得承载任何实现**：一旦有人在这里加东西，"删除触发器"就永远无法触发，
 *     旧深路径会变成第二事实源。
 *   - `JUDGMENT_PROVIDER` **字符串值不变**且由内核单源导出：e2e/单测按它 `overrideProvider`，
 *     改名 = 静默换回真实现（测试全绿而判别真的联网）。
 *
 * [关联代码]
 *   - ../../judgment/judgment-capability.interface.ts — 契约新家（唯一事实来源）
 *   - ./judgment-rubric.ts — `ExperienceCheckInput` 的新家（本能力输入）
 *
 * [删除触发器] **下一里程碑删除本文件**（届时把仓内引用一并改到 `modules/judgment/`）：
 *   触发判据 = 全仓不再有 `modules/experience/judgment/judgment-provider.interface` 的引用
 *   （`grep -rn "judgment/judgment-provider.interface" apps packages` 为空）。
 *   同批删除：`./typesafe.judgment-provider.ts` / `./noop.judgment-provider.ts` /
 *   `./judgment-provider.factory.ts` 三个同款垫片。
 *
 * [修改检查]
 *   □ 本文件**只允许**在"内核契约改名/搬家"时同步调整 re-export 目标
 *   □ 新增契约请写进 `modules/judgment/`，不要写在这里
 * =============================================================================
 */

/** @deprecated 契约已迁至 `modules/judgment/judgment-capability.interface.ts`（本文件为删除中的垫片） */
export * from '../../judgment/judgment-capability.interface';

/** @deprecated 本能力的输入契约已随能力定义迁至 `./judgment-rubric.ts` */
export type { ExperienceCheckInput } from './judgment-rubric';

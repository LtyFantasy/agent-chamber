/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * ⚠️ **兼容垫片 / 已弃用（@deprecated）——请勿在此新增任何内容**
 *
 * [功能概念]
 *   - 判别 provider 装配点（分派 + 诊断）的**旧深路径 re-export**：v1.85.0 批次 2 上移内核
 *
 * [代码职责]
 *   - 仅做 re-export（两个 DI token 的 provider 定义 + 配置解析 + 诊断工厂）；
 *     **零逻辑、零类型定义**
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域 / 生效自检）
 *
 * [关键不变量]
 *   - **`JUDGMENT_CONFIG` 字符串值不变**：e2e 按它 `overrideProvider` 注入内联额度配置，
 *     改名 = 静默回落到真实配置（限流用例会以"额度没生效"的形态红）。
 *   - **本文件不得承载任何实现**（见同目录 `judgment-provider.interface.ts` 的同款纪律）。
 *
 * [关联代码]
 *   - ../../judgment/judgment-provider.factory.ts — 实现新家（唯一事实来源）
 *   - ../../judgment/judgment.module.ts — 内核模块（imports/exports 两个 token 的地方）
 *
 * [删除触发器] **下一里程碑删除本文件**（判据见 `./judgment-provider.interface.ts` 的同节）。
 *
 * [修改检查]
 *   □ 本文件**只允许**在"内核装配改名/搬家"时同步调整 re-export 目标
 * =============================================================================
 */

/** @deprecated 装配已迁至 `modules/judgment/judgment-provider.factory.ts`（本文件为删除中的垫片） */
export * from '../../judgment/judgment-provider.factory';

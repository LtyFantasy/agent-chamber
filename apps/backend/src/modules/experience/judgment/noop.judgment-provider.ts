/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * ⚠️ **兼容垫片 / 已弃用（@deprecated）——请勿在此新增任何内容**
 *
 * [功能概念]
 *   - 判别关闭态实现（`provider=none`）的**旧深路径 re-export**：v1.85.0 批次 2 上移内核
 *
 * [代码职责]
 *   - 仅做 re-export；**零逻辑、零类型定义**
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域 = `none|typesafe`）
 *
 * [关键不变量]
 *   - **本文件不得承载任何实现**（见同目录 `judgment-provider.interface.ts` 的同款纪律）。
 *
 * [关联代码]
 *   - ../../judgment/noop.judgment-provider.ts — 实现新家（唯一事实来源）
 *
 * [删除触发器] **下一里程碑删除本文件**（判据见 `./judgment-provider.interface.ts` 的同节）。
 *
 * [修改检查]
 *   □ 本文件**只允许**在"内核实现改名/搬家"时同步调整 re-export 目标
 * =============================================================================
 */

/** @deprecated 实现已迁至 `modules/judgment/noop.judgment-provider.ts`（本文件为删除中的垫片） */
export * from '../../judgment/noop.judgment-provider';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * ⚠️ **兼容垫片 / 已弃用（@deprecated）——请勿在此新增任何内容**
 *
 * [功能概念]
 *   - TypeSafe 官方云 REST 客户端的**旧深路径 re-export**：v1.85.0 批次 2 判别通用化后，
 *     实现已上移内核（通用 provider + 独立传输层）
 *
 * [代码职责]
 *   - 仅做 re-export（通用 provider 与端点构造函数）；**零逻辑、零类型定义**
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/experience-base.md` — 判别服务章（失败标签 / 端点约定）
 *
 * [关键不变量]
 *   - **本文件不得承载任何实现**（见同目录 `judgment-provider.interface.ts` 的同款纪律）。
 *   - 端点的 host+path 打印契约（启动 INFO 一眼可判 double-`/v1`）由内核单源提供，
 *     本垫片不得自己再拼一次 URL。
 *
 * [关联代码]
 *   - ../../judgment/typesafe.judgment-provider.ts — 实现新家（唯一事实来源）
 *   - ../../judgment/judgment.transport.ts — 传输层新家（端点构造 / 失败分类）
 *
 * [删除触发器] **下一里程碑删除本文件**（判据见 `./judgment-provider.interface.ts` 的同节）。
 *
 * [修改检查]
 *   □ 本文件**只允许**在"内核实现改名/搬家"时同步调整 re-export 目标
 * =============================================================================
 */

/** @deprecated 实现已迁至 `modules/judgment/typesafe.judgment-provider.ts`（本文件为删除中的垫片） */
export * from '../../judgment/typesafe.judgment-provider';

/** @deprecated 端点构造已迁至 `modules/judgment/judgment.transport.ts` */
export { buildTypesafeSystemoneUrl } from '../../judgment/judgment.transport';

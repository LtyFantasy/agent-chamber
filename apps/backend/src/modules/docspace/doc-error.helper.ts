/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: review-0831 任务 bbd175dc 子项 2（批量错误提取逻辑收敛）
 *
 * [踩坑索引]
 *   - errorOf-dup-v1.57：doc-bundle.service.ts 的 errorOf 与 doc.service.ts
 *     batchUpsert 内联错误提取逐字重复，2026-08-31 收敛为本文件唯一实现。
 *
 * [铁律关联] #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * 抽取 per-item 错误形状（batchUpsert / importBundle 批量容错的统一契约）。
 *
 * 形状 = { message, code }：message 取 NestJS HttpException.response.message
 * （业务错误码语义的 message），无则回退 err.message，再无则 'Unknown error'；
 * code 取 HttpException.response.code（业务错误码，如 DOC_NOT_FOUND），无则省略。
 *
 * ⚠️ 契约（2026-08-31 统一）：两处批量容错（doc.service.batchUpsert 内联 +
 * doc-bundle.service.errorOf）必须共用本实现，禁止再内联复制——错误形状
 * { message, code } 是批量导入响应的对外契约（docs/spec.md），分叉会漂移。
 *
 * @param err 任意被 catch 的错误（HttpException / Error / 未知值）
 * @returns 批量 per-item 错误形状 { message, code? }
 */
export function errorOf(err: unknown): { message: string; code?: number } {
  const httpErr = err as { response?: { message?: string; code?: number }; message?: string };
  return {
    message: httpErr.response?.message ?? httpErr.message ?? 'Unknown error',
    code: httpErr.response?.code,
  };
}

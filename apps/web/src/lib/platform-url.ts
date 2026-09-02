/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §8c（最后一公里连接向导）
 *   - 补充: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位管理 UI）
 *
 * [踩坑索引]
 *   - 旧版 seat-management 启动命令取 window.location.origin：dev 下是 8742（web），
 *     而 runner 要连 8743（backend）——dev 命令错误（本 helper 即为修复）
 *   - NEXT_PUBLIC_API_URL：dev 是绝对路径（http://localhost:8743/api/v1），
 *     prod 是相对路径（/api/v1 同源）——两形态都要能推导出平台根 URL
 *
 * [铁律关联] #7(视觉克制) #11(注释强制) #17(测试契约)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { API_PREFIX } from '@agent-chamber/shared';

/**
 * 推导「平台根 URL」——runner 拨号与下载资产（install-runner.sh / integrations 指南）
 * 用的平台地址，不是 web 前端地址。
 *
 * 形态推导（与 lib/api.ts API_BASE_URL 两形态对应）：
 * - NEXT_PUBLIC_API_URL 是绝对路径（dev：http://localhost:8743/api/v1）→ 剥掉 /api/v1
 *   后缀，返回 http://localhost:8743（runner 连 backend，不是 web 8742）；
 * - 相对路径（prod：/api/v1 同源）→ 返回 window.location.origin（与 API 同源，
 *   nginx 代理 /api/ 的拓扑下 runner 走同一入口域名）。
 *
 * 鲁棒性：无尾斜杠、多尾斜杠、NEXT_PUBLIC_API_URL 未定义均安全返回。
 *
 * @returns 平台根 URL（无尾斜杠）
 */
export function getRunnerPlatformUrl(): string {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || API_PREFIX;
  if (apiBase.startsWith('http://') || apiBase.startsWith('https://')) {
    // 绝对值：剥 /api/v1 后缀（允许尾斜杠变体，如 http://host:8743/api/v1/）
    const trimmed = apiBase.replace(/\/+$/, '');
    return trimmed.endsWith(API_PREFIX) ? trimmed.slice(0, -API_PREFIX.length) : trimmed;
  }
  // 相对路径（/api/v1）或空：取当前 origin（web 与 API 同源拓扑）
  return window.location.origin.replace(/\/+$/, '');
}

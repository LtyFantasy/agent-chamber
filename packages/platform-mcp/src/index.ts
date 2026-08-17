/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.1（包骨架）
 *   - 补充: .kimi/plan-mcp-phase2.md §3.3（5 个工具契约）
 *   - 补充: .kimi/plan-mcp-experience-topic-board.md §5 Batch E1（3 个新工具）
 *   - 补充: .kimi/plan-batch-e3-read-cursor.md §2.4（mark_topic_read）
 *   - 补充: 任务 T2（list_docs / list_doc_routes 管理盘点视角，v1.55）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #11(注释强制) #12(跨模块)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import type { CustomTool } from '@agent-chamber/automcp';
import { getMyBriefingTool } from './tools/get-my-briefing';
import { followUpTaskTool } from './tools/follow-up-task';
import { getTopicDigestTool } from './tools/get-topic-digest';
import { createTopicWithBoardTool } from './tools/create-topic-with-board';
import { reportTaskResultTool } from './tools/report-task-result';
import { createTaskTool } from './tools/create-task';
import { resolveAgentTool } from './tools/resolve-agent';
import { batchGetTasksTool } from './tools/batch-get-tasks';
import { markTopicReadTool } from './tools/mark-topic-read';
import { getDocsOverviewTool } from './tools/get-docs-overview';
import { getBoardDigestTool } from './tools/get-board-digest';
import { searchDocsTool } from './tools/search-docs';
import { readDocTool } from './tools/read-doc';
import { upsertDocTool } from './tools/upsert-doc';
import { deleteDocTool } from './tools/delete-doc';
import { importDocsTool } from './tools/import-docs';
import { listDocsTool } from './tools/list-docs';
import { listDocRoutesTool } from './tools/list-doc-routes';
import { patchDocTool } from './tools/patch-doc';
import { createDocRouteTool } from './tools/create-doc-route';
import { updateDocRouteTool } from './tools/update-doc-route';
import { deleteDocRouteTool } from './tools/delete-doc-route';
import { exportDocSpaceTool } from './tools/export-doc-space';
import { importDocBundleTool } from './tools/import-doc-bundle';

/**
 * 22 个业务语义化高层 MCP tools
 *
 * 由 automcp --custom-tools 加载，与 OpenAPI 自动映射的原子工具并存。
 * 顺序保持稳定（按设计文档编号；新工具追加在尾部，不打乱既有编号）：
 * ① get_my_briefing → ② follow_up_task → ③ get_topic_digest →
 * ④ create_topic_with_board → ⑤ report_task_result →
 * ⑥ create_task → ⑦ resolve_agent → ⑧ batch_get_tasks →
 * ⑨ mark_topic_read → ⑩ get_docs_overview → ⑪ search_docs →
 * ⑫ read_doc → ⑬ upsert_doc → ⑭ delete_doc → ⑮ import_docs → ⑯ get_board_digest →
 * ⑰ list_docs → ⑱ list_doc_routes（v1.55 任务 T2 管理/盘点视角补齐）→
 * ⑲ patch_doc → ⑳ create_doc_route → ㉑ update_doc_route → ㉒ delete_doc_route
 * （v1.55 任务 T3 section 级写 + routes 写三件套）→
 * ㉓ export_doc_space → ㉔ import_doc_bundle
 * （任务 T6 空间级全量导出/回导——bundle 含策展元数据 + 全文，可落 git 做版本对齐快照/灾备）
 */
export const customTools: CustomTool[] = [
  getMyBriefingTool,
  followUpTaskTool,
  getTopicDigestTool,
  createTopicWithBoardTool,
  reportTaskResultTool,
  createTaskTool,
  resolveAgentTool,
  batchGetTasksTool,
  markTopicReadTool,
  getDocsOverviewTool,
  searchDocsTool,
  readDocTool,
  upsertDocTool,
  deleteDocTool,
  importDocsTool,
  getBoardDigestTool,
  listDocsTool,
  listDocRoutesTool,
  patchDocTool,
  createDocRouteTool,
  updateDocRouteTool,
  deleteDocRouteTool,
  exportDocSpaceTool,
  importDocBundleTool,
];

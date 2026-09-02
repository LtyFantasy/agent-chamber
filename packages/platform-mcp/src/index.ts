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
import { listDocVersionsTool } from './tools/list-doc-versions';
import { readDocVersionTool } from './tools/read-doc-version';
import { getDocMoveImpactTool } from './tools/get-doc-move-impact';
import { moveDocTool } from './tools/move-doc';
import { recheckDocLinkHealthTool } from './tools/recheck-doc-link-health';
import { patchDocMetadataTool } from './tools/patch-doc-metadata';
import { appendDocTool } from './tools/append-doc';
import { patchTaskDescriptionTool } from './tools/patch-task-description';
import { getMyActivityTool } from './tools/get-my-activity';
import { listDocTreeTool } from './tools/list-doc-tree';
import { upsertDiagramTool } from './tools/upsert-diagram';
import { readDiagramTool } from './tools/read-diagram';
import { patchDiagramTool } from './tools/patch-diagram';
import { validateDiagramTool } from './tools/validate-diagram';

/**
 * 38 个业务语义化高层 MCP tools
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
 * （任务 T6 空间级全量导出/回导——bundle 含策展元数据 + 全文，可落 git 做版本对齐快照/灾备）→
 * ㉕ list_doc_versions → ㉖ read_doc_version
 * （doc history MVP 只读两件套：版本元数据清单 + 单版全文/diff 回溯，对应看板任务 27f05ec0）→
 * ㉗ get_doc_move_impact → ㉘ move_doc
 * （v1.60.0-dev P1 双件 8d763914 + 73cadb0d：move 影响预演（backlinks 反查/引用清单/
 * 碰撞检测，与 move dryRun 共用服务端内核）+ 原子移动（同 docId 单事务改 path，
 * 引用面全按 docId 自然连续；响应带待人工改写入链清单 + v1.61.0 起出链失效清单
 * outboundPathLinksToRewrite）→
 * ㉙ recheck_doc_link_health
 * （v1.61.0 批次 1 d0569c83：linkHealth 手动重检——严格 POSIX 源目录解析语义变更
 * 后的迁移收口入口；三通道：单文档 docId / spaceName+path / 仅 spaceName 空间级
 * 全量重检返回 { checked, broken }）→
 * ㉚ patch_doc_metadata
 * （v1.61.0 批次 2 201ae04f：metadata-only 写通道——只 UPDATE docs 元数据列，
 * 不重切 sections/不落 doc_versions/不动 contentHash；Partial 三态语义
 * （缺席=不动/null=400/tags:[]=清空）+ expectedContentHash 必填乐观锁 +
 * category 默认只解析既有（allowCreateCategory 开关）；对应 REST
 * PATCH /docs/:id/metadata，游戏方 Pilot 1b 8 文档消费包依赖能力）→
 * ㉛ append_doc
 * （v1.65.0 消费者反馈批 7601e2f5：追加写原语——一步把 content 追加到文档末尾
 * 或指定 heading 小节末尾，服务端内部消化并发冲突（重读重写自动重试最多 3 次），
 * 调用方无需 read→patch 三步；日记场景首选；对应 REST POST /docs/:id/append）→
 * ㉜ patch_task_description
 * （消费者反馈批 5bc4a570：任务描述局部 patch——match 模式精确串替换 + 乐观锁
 * （expectedDescriptionHash）+ 幂等键，多 Agent 并发改描述首选通道；
 * 对应 REST PATCH /tasks/:id/description）→
 * ㉝ get_my_activity
 * （活动日志系统 Phase 3（plan shadowcat-sunspot-catwoman）：查询当前 actor 的
 * 审计时间线——自证「我的 key 做了什么」；entityType/action/from/to 过滤 +
 * limit 默认 20 clamp [1,50]；响应带 total/hasNext 指导翻页；防误导两句
 * （覆盖起点 + 空结果≠未发生）固化在 description；对应 REST GET /activity-logs）→
 * ㉞ list_doc_tree
 * （v1.70.0-dev 懒加载目录树 Phase 3：DocSpace 分层目录钻取——一次调用只返
 * 「当前层」直接子目录（递归 docCount/latestDocAt 聚合）+ 直挂文档 slim 分页，
 * 用 folder.path 作下一次 prefix 下钻；与 list_docs 平铺清单互补，大空间
 * 目录发现免全量拉取；对应 REST GET /doc-spaces/:id/docs/tree）→
 * ㉟ upsert_diagram → ㊱ read_diagram → ㊲ patch_diagram → ㊳ validate_diagram
 * （Diagram IR v1 Phase 2，plan diagram-ir-v1-plan：docType='diagram' 图文档四件套——
 * 服务端 fail-closed 渲染门（schema/geometry/composition 不过不入库）；upsert = 5 型
 * 选型 + quality_profile 门（showcase=0 警告）；read = 解析后 IR 对象 + contentHash
 * 乐观锁 token；patch = RFC 6901/6902 子集原子应用 + expectedContentHash 必填；
 * validate = dry-run 零副作用修复凭据；错误消费分层键名 details（非 data）；
 * 对应 REST PUT /doc-spaces/:id/diagrams、GET /docs/:id/diagram、
 * PATCH /docs/:id/diagram、POST /doc-spaces/:id/diagrams/validate）
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
  listDocVersionsTool,
  readDocVersionTool,
  getDocMoveImpactTool,
  moveDocTool,
  recheckDocLinkHealthTool,
  patchDocMetadataTool,
  appendDocTool,
  patchTaskDescriptionTool,
  getMyActivityTool,
  listDocTreeTool,
  upsertDiagramTool,
  readDiagramTool,
  patchDiagramTool,
  validateDiagramTool,
];

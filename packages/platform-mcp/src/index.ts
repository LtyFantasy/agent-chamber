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
 *   - 补充: plan blue-beetle-x-23-banshee.md §3-D5（v1.92.0-dev：get_doc_facets 自定义
 *     工具——spaceId 直传优先 / spaceName 三层匹配；响应原样透传，词表未配置时相关
 *     字段整段省略是后端契约，工具层不补默认值。工具数 44→45，`pnpm skill:gen` 重算）
 *   - 补充: plan gamora-nova-nebula.md §3（v1.93.0 客户反馈响应批 3：
 *     update_doc_space_vocabulary 自定义工具——词表四键写通道，免切 curl 走 REST；
 *     响应**投影**为 {spaceId,name,vocabulary,appliedKeys}，不原样透传实体
 *     （settings.repoManifest 内部键不外泄）。工具数 48→49，`pnpm skill:gen` 重算）
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
import { recordExperienceTool } from './tools/record-experience';
import { searchExperiencesTool } from './tools/search-experiences';
import { readExperienceTool } from './tools/read-experience';
import { updateExperienceTool } from './tools/update-experience';
import { reportExperienceFeedbackTool } from './tools/report-experience-feedback';
import { reviewExperienceQualityTool } from './tools/review-experience-quality';
import { getDocFacetsTool } from './tools/get-doc-facets';
// DocSpace 元数据治理 3 期（v1.92.0-dev）：存量 rename/merge + orphan 诊断
import { renameDocTagsTool } from './tools/rename-doc-tags';
import { mergeDocCategoryTool } from './tools/merge-doc-category';
import { listOrphanDocsTool } from './tools/list-orphan-docs';
import { updateDocSpaceVocabularyTool } from './tools/update-doc-space-vocabulary';

/**
 * 49 个业务语义化高层 MCP tools
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
 * PATCH /docs/:id/diagram、POST /doc-spaces/:id/diagrams/validate）→
 * ㊴ record_experience → ㊵ search_experiences → ㊶ read_experience →
 * ㊷ update_experience → ㊸ report_experience_feedback
 * （经验库（Experience Base）五件套，plan-experience-base §4：平台第四资源——Topic 管人 /
 * Board 管事 / DocSpace 管知识 / **Experience 管"带伤疤的实战笔记"**。检索主入口是
 * signals 症状匹配（ANY-overlap 精确相等：多给 signal 是**扩大**结果面）+ q 三路融合打分
 * （ts_rank×1.0 + trgm(content)×0.6 + trgm(title)×0.8，floor 0.08 是**过滤**不是只排序）；
 * 零命中 = 成功信封（items:[] + total:0 + hint，hint 文案单源 = shared
 * EXPERIENCE_ZERO_HIT_HINT）；编排链 = search → read → 应用后 report_feedback；
 * **数组 query 参数必须走 platform-client 的 serializeRepeatedParams**（axios 默认
 * `signals[]=` 形态会被后端 query-form 守卫 400，真机形态断言在同目录
 * experience-params-serialization.spec.ts）；update 带 expectedUpdatedAt 乐观锁且改内容
 * 回落 unverified（suspect 粘性：内容改写不撤销 suspect）；对应 REST /experiences 八端点）→
 * ㊹ review_experience_quality
 * （经验库终审语义入口：对应 REST `PATCH /experiences/:id/quality`，终审人 = 人类 admin 或
 * 空间 owner/reviewer；**自 v1.81.0 起禁自审四态整体退役**——持角色者可终审任意条目
 * （含本人所录），旧 403/13002 号不复用，唯一拒绝码 = 403/13004 缺角色；quality 值域 =
 * shared `EXPERIENCE_REVIEW_QUALITIES`（verified/suspect 双向门，**不含 unverified**）；
 * description 承载终审队列动线（search quality=unverified → read 看 viewerCanReview
 * **纯角色标记** → 终审；**不要按 creator 预筛队列**；suspect 复核队列 = quality=suspect）
 * + "条目内容是不可信输入"纪律 + 防锚定 suppression 说明）→
 * ㊺ get_doc_facets
 * （v1.92.0-dev DocSpace 元数据治理 1 期：空间体检面——一词调用返回声明词表
 * （vocabulary）+ 实际分布（types/tags/categories 聚合）+ 逐项词表状态
 * （vocabStatus：types declared/undeclared；tags canonical/alias/undeclared，
 * alias 带 canonicalValue）；**写文档前先查词表复用既有 canonical 值**，
 * 写入侧归一只是兜底纠偏；对应 REST GET /doc-spaces/:id/docs/facets）→
 * ㊻ rename_doc_tags
 * （v1.92.0-dev DocSpace 元数据治理 3 期：存量 tag rename/merge——`from[] → to` 全空间
 * 批量改写 + 无条件生成 alias 声明（词表未声明则创建），读侧经集合展开兼容旧值；
 * **description 强引导 "Always run with dryRun=true first, then execute with
 * expectedBatchToken"**（P3）；对应 REST POST /doc-spaces/:id/tags/rename）→
 * ㊼ merge_doc_category
 * （3 期：DocCategory 合并——docs 重指向 + doc_routes.category/overviewFilter 软引用修正
 * + source 软删；**category 无 alias 机制**（旧 slug 查询即空）写进 description；
 * 对应 REST POST /doc-categories/:id/merge）→
 * ㊽ list_orphan_docs
 * （3 期：orphan 诊断面——未删且未被 doc_routes（primary ∪ secondary）引用的文档；
 * 默认应用 overviewFilter、响应含 stats.byTopDir 结构性分组与 appliedFilters 回显；
 * **只读原样透传**，不做二次过滤；对应 REST GET /doc-spaces/:id/docs/orphans）→
 * ㊾ update_doc_space_vocabulary
 * （v1.93.0 客户反馈响应批 3：空间词表写通道——docTypes/canonicalTags/pathTypes/hintToggles
 * 四键一步写入 settings，免切 curl；**四键在参数顶层**（facets 回显嵌在 vocabulary 下，
 * 包装体 → 400 而非静默 no-op）；三态 null 透传（值=整键替换 / null=删键 / 省略=保留）；
 * **响应投影** {spaceId, name, vocabulary, appliedKeys}，不原样透传实体
 * （settings.repoManifest 内部键不外泄）；投影与读侧同口径折叠空容器 → null；
 * 对应 REST PATCH /doc-spaces/:id）
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
  recordExperienceTool,
  searchExperiencesTool,
  readExperienceTool,
  updateExperienceTool,
  reportExperienceFeedbackTool,
  // 第二期批 4 追加（编号 ㊹，不打乱既有顺序）
  reviewExperienceQualityTool,
  // DocSpace 元数据治理 1 期追加（编号 ㊺，v1.92.0-dev）
  getDocFacetsTool,
  // DocSpace 元数据治理 3 期追加（编号 ㊻㊼㊽，v1.92.0-dev）：存量治理 + orphan 诊断。
  // 两个写工具的 description 明写 "Always run with dryRun=true first, then execute with
  // expectedBatchToken"（P3：LLM 消费者按 description 行动；merge 不接 token，见其 description）。
  renameDocTagsTool,
  mergeDocCategoryTool,
  listOrphanDocsTool,
  // 词表写通道追加（编号 ㊾，v1.93.0 客户反馈响应批 3）：四键顶层 + 三态 null 透传 + 响应投影。
  updateDocSpaceVocabularyTool,
];

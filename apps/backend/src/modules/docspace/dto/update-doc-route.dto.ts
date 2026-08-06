/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, doc_routes 段)
 *   - 补充: plan §4-B5 (意图路由结构化)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #6）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { PartialType } from '@nestjs/swagger';
import { CreateDocRouteDto } from './create-doc-route.dto';

/**
 * PATCH /doc-routes/:id 请求体（Partial 语义）
 *
 * Service 层合并现有值后整体重跑写时校验（改 primary/secondary doc 或 headingPath 时）。
 */
export class UpdateDocRouteDto extends PartialType(CreateDocRouteDto) {}

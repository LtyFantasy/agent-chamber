/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 空间级导出端点的查询参数（v1.89.0-dev 批次 A：pathPrefix 部分快照）
 *
 * [代码职责]
 *   - 只做**格式校验**（可选字符串、≤512）；前缀的转义与收窄语义归 DocBundleService
 *     （铁律 #21 双层校验：DTO 管格式、Service 管业务）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §16（DocSpace 模块；export 端点）
 *   - 补充: 线上 DocSpace `docs/platform-mcp.md` §2（export_doc_space 契约）
 *
 * [关键不变量]
 *   - pathPrefix 是**字面、大小写敏感**前缀（目录语义请带尾 `/`）——LIKE 通配符由
 *     `escapeLikePrefix()` 转义（common/utils/sql-like.ts 单源）。
 *   - 挂上本 DTO 即改变端点行为：全局 ValidationPipe `forbidNonWhitelisted`
 *     （main.ts:40-43）会让**未知 query 参数**从静默忽略变 400——新增参数必须同时
 *     在本 DTO 声明，否则调用方 400。
 *
 * [关联代码]
 *   - modules/docspace/docspace.controller.ts — @Query() 消费点 + @ApiQuery 契约描述
 *   - modules/docspace/doc-bundle.service.ts — exportBundle 的前缀过滤与闭包收窄
 *   - common/utils/sql-like.ts — 转义单源
 *
 * [铁律关联] #11(注释强制) #21(双层校验) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增参数必须同步 MCP export_doc_space 的 inputSchema 与 handler 透传
 *   □ 行为变化（400 面）必须同步 controller 的 @ApiResponse 与 api-definition
 * =============================================================================
 */
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GET /doc-spaces/:id/export 查询 DTO。
 *
 * pathPrefix 语义：只导出 path 前缀命中的文档，并把 categories / routes / media 一并收窄
 * 为「入选文档的闭包」——这是**部分快照**，**不是备份**（跨空间回导时被丢掉的文档
 * 会让 routes 的 secondaryDocPath 解析失败，走既有 per-item failed 响亮语义）。
 *
 * 零命中 = 200 + 空 bundle（非错误；回导是 no-op），调用方读 `appliedFilters.matchedDocs`
 * 区分「前缀没命中」与「空间本来就是空的」。
 */
export class ExportBundleQueryDto {
  @ApiPropertyOptional({
    description:
      'Literal, case-sensitive path prefix (use a trailing "/" for directory semantics; ' +
      'LIKE wildcards are escaped). Only docs under the prefix are exported, and ' +
      'categories/routes/media are narrowed to that closure — a PARTIAL snapshot, not a backup.',
  })
  @IsOptional()
  @IsString()
  // 路径最长 512，对齐 UpsertDocDto.path 与 QueryDocDto.pathPrefix 的 @MaxLength(512)：
  // DTO 上限必须与列宽同刻度，超限在格式层拦掉（禁透传 PG，铁律 #21）
  @MaxLength(512)
  pathPrefix?: string;
}

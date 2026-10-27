/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 意图路由的 Partial 三态更新：省略保留、显式 null 清空、有效值更新
 *
 * [代码职责]
 *   - 向 MCP 客户端广告可空字段类型，薄包装 PATCH /doc-routes/:id 并透传上游错误
 *
 * [权威文档]
 *   - 主文档: DocSpace「Agent Chamber」docs/integrations/platform-mcp.md §2.21 update_doc_route
 *   - 补充: DocSpace「Agent Chamber」docs/api-definition.md §16.7a 意图路由
 *
 * [关键不变量]
 *   - 五个可空字段的 schema 与 handler 同时表达 string/null；undefined 不进入请求体
 *   - intent/primaryDocId/sortOrder/codeEntryType 的 null 守卫和上游 4xx 错误信封保持
 *   - 次文档与其锚点各自更新；pattern 清空 codeEntry 时仍受服务端合并视图校验
 *
 * [关联代码]
 *   - packages/platform-mcp/src/index.ts — customTools 的真实注册入口
 *   - packages/platform-mcp/src/tools/update-doc-route.spec.ts — 广告 schema、三态和错误回归
 *   - packages/automcp/src/server/mcp-server.ts — custom tool 注册与 tools/list 输出
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import { DOC_ROUTE_CODE_ENTRY_TYPES } from '@agent-chamber/shared';

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * update_doc_route — 更新意图路由（v1.55 任务 T3）
 *
 * 薄包装 PATCH /doc-routes/:id：routeId 直接定位（list_doc_routes 拿 id），
 * Partial 语义透传 UpdateDocRouteDto 字段。触及 doc/headingPath/codeEntry 时
 * 服务端按合并视图重跑写时校验，400 结构化错误透传（铁律 #9 不包装）。
 */
export const updateDocRouteTool: CustomTool = {
  tool: {
    name: 'update_doc_route',
    description:
      'Partially update an intent route (doc_route) by routeId (wrapper of PATCH /doc-routes/:id). ' +
      'Get the routeId from list_doc_routes. Only the provided fields are changed (Partial semantics). ' +
      'When primary/secondary doc, headingPath or codeEntry fields are touched, server-side write-time ' +
      'validation re-runs against the merged view: docs must exist in the space (400 DOC_ROUTE_DOC_NOT_FOUND), ' +
      'headingPath must resolve exactly (400 DOC_ROUTE_HEADING_UNRESOLVED), codeEntry must be ' +
      'repo-relative (400 DOC_ROUTE_INVALID_CODE_ENTRY). Route not found → 404 DOC_ROUTE_NOT_FOUND. ' +
      'Nullable fields (category, primaryHeadingPath, secondaryDocId, secondaryHeadingPath, codeEntry) ' +
      'accept explicit null to clear the value. Returns the updated route row.',
    inputSchema: {
      type: 'object',
      properties: {
        routeId: {
          type: 'string',
          description: 'DocRoute ID (UUID) — from list_doc_routes',
        },
        intent: {
          type: 'string',
          description: 'Optional: new intent description ("我要…", ≤200 chars)',
        },
        category: {
          type: ['string', 'null'],
          description: 'Optional: new route group (≤100 chars)',
        },
        primaryDocId: {
          type: 'string',
          description: 'Optional: new primary doc ID (UUID)',
        },
        primaryHeadingPath: {
          type: ['string', 'null'],
          description: 'Optional: new anchor in the primary doc',
        },
        secondaryDocId: {
          type: ['string', 'null'],
          description: 'Optional: new secondary doc ID (UUID)',
        },
        secondaryHeadingPath: {
          type: ['string', 'null'],
          description: 'Optional: new anchor in the secondary doc',
        },
        codeEntry: {
          type: ['string', 'null'],
          description:
            'Optional: new code entry point — repository-relative path (no absolute path or `..` segments)',
        },
        codeEntryType: {
          type: 'string',
          // 枚举值从 shared DOC_ROUTE_CODE_ENTRY_TYPES 单源取值（防 backend DTO 加值后此处漂移）
          enum: [...DOC_ROUTE_CODE_ENTRY_TYPES],
          description:
            'Optional: codeEntry kind. "exact" = precise file/dir path, recheck validates against ' +
            'the repo manifest. "pattern" = glob-style pattern (e.g. `apps/web/app/**` + `/page.tsx`), ' +
            'existence check is EXEMPTED during recheck (health marked exempt, never reported broken). ' +
            'Changing to "pattern" requires a non-empty codeEntry (400 DOC_ROUTE_INVALID_CODE_ENTRY).',
        },
        sortOrder: {
          type: 'integer',
          description: 'Optional: new curation weight (ASC within space, 0..10000)',
        },
      },
      required: ['routeId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const routeId = args.routeId as string;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // routeId 必填守卫（inputSchema required 之外的防御：MCP 客户端不保证强制）
    if (!routeId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, message: 'routeId is required' }),
          },
        ],
        isError: true,
      };
    }

    // 透传 UpdateDocRouteDto 字段（Partial 语义：undefined = 不携带 = 不修改；字段名与 DTO 一一对应）。
    // nullable 字段（category/headingPath/secondaryDocId/codeEntry）显式传 null = 清空
    // （服务端 `dto.x !== undefined ? dto.x : route.x` 接住 null → `?? null` 落库）；
    // 非空约束字段（intent/primaryDocId/sortOrder/codeEntryType）丢弃 null，避免透传出 DB 非空违约 500。
    const nullableKeys = [
      'category',
      'primaryHeadingPath',
      'secondaryDocId',
      'secondaryHeadingPath',
      'codeEntry',
    ] as const;
    const requiredKeys = ['intent', 'primaryDocId', 'sortOrder', 'codeEntryType'] as const;
    const body: Record<string, unknown> = {};
    for (const key of nullableKeys) {
      const value = args[key];
      if (value !== undefined) body[key] = value;
    }
    for (const key of requiredKeys) {
      const value = args[key];
      if (value !== undefined && value !== null) body[key] = value;
    }

    try {
      const resp = await client.request<Record<string, unknown>>(
        'PATCH',
        `/doc-routes/${routeId}`,
        {
          body,
        },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'update_doc_route');
    }
  },
};

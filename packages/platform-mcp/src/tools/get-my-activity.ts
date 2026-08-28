/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan shadowcat-sunspot-catwoman.md Phase 3（活动日志系统 MCP 工具）
 *   - 补充: docs/api-definition.md Audit 节（GET /activity-logs）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #21(双层校验)
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

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';

/** limit 钳制边界（对齐 get-my-briefing 惯例：1~50） */
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

/**
 * 数量参数钳制：非数字/非有限值回退缺省，其余钳到 [1, 50]。
 *
 * @param raw      - 调用方传入的原始值
 * @param fallback - 非法值回退的缺省（limit 缺省 20）
 */
function clampLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.floor(raw)));
}

/**
 * get_my_activity — 查询当前 actor 的活动日志（审计时间线）
 *
 * 自证场景（plan 五、起因：idle-game 事件）：agent 凭
 * `get_my_activity?from=<ISO 时间戳>` 即可回答「我的 key 在 X 时刻后做了什么」，
 * 无需超管直连生产库。响应 {items, total, page, pageSize, totalPages, hasNext,
 * hasPrev, scope}，hasNext=true 表示仍有更早的记录（按需缩小 from 窗口续查）。
 *
 * ⚠️ 防误导两句（plan Phase 3 固化，重演起因事件的防线）：
 * (a) 仅记录本功能部署后的操作，此前仅 doc 写操作有日志；
 * (b) 空结果不等于未发生——审计为 fail-open 尽力记录（日志缺失 ≠ 未发生）。
 */
export const getMyActivityTool: CustomTool = {
  tool: {
    name: 'get_my_activity',
    description:
      'Query my activity log (audit trail of operations performed by the current actor). ' +
      'Filters: entityType / action / from / to; limit 1~50 (default 20). ' +
      'Response: {items, total, page, pageSize, totalPages, hasNext, hasPrev, scope} — ' +
      'hasNext=true means older records remain (narrow the from window to page further). ' +
      'IMPORTANT COVERAGE: (a) only operations AFTER this feature was deployed are ' +
      'recorded; before that, only doc write operations were logged. ' +
      '(b) An empty result does NOT mean nothing happened — audit is fail-open ' +
      'best-effort logging (missing log ≠ event never occurred).',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          description: 'Optional. Entity type filter (task/topic/message/doc/agent/api_key/…).',
        },
        action: {
          type: 'string',
          description:
            'Optional. Action filter: create / update / delete / login / logout / ' +
            'reset_api_key / toggle_agent / pause_topic / resume_topic / move_doc.',
        },
        from: {
          type: 'string',
          description:
            'Optional. Start time, ISO 8601 WITH timezone (inclusive), ' +
            'e.g. 2026-08-27T08:36:00+08:00.',
        },
        to: {
          type: 'string',
          description:
            'Optional. End time, ISO 8601 with timezone (inclusive), ' +
            'e.g. 2026-08-27T23:59:59+08:00.',
        },
        limit: {
          type: 'integer',
          description: 'Max items to return (1~50, default 20)',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const limit = clampLimit(args.limit, 20);
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 过滤参数透传（非 undefined 才带，避免空串/噪音参数）；limit → pageSize
    // （MCP 层无 DTO 校验，格式非法值由后端 400 兜底，铁律 #21 双层校验）
    const params: Record<string, unknown> = { pageSize: limit };
    if (args.entityType !== undefined) params.entityType = args.entityType;
    if (args.action !== undefined) params.action = args.action;
    if (args.from !== undefined) params.from = args.from;
    if (args.to !== undefined) params.to = args.to;

    try {
      const result = await client.request<Record<string, unknown>>('GET', '/activity-logs', {
        params,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_my_activity');
    }
  },
};

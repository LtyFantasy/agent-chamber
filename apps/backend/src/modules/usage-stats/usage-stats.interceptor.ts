/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：REST 请求级采集（全局拦截器）
 *
 * [代码职责]
 *   - 每请求采集一次维度样本（bucket/method/route/actor/头部 MCP 标识）
 *   - **exactly-once** 语义保证：一次请求恰好产生一行计数
 *   - **fail-open** 语义保证：采集异常绝不影响业务响应
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 口径专章
 *     （guard 短路 401/403/429 与 404 不记、**DTO 400 记**、SSE finalize、latency=handler 阶段）
 *   - 补充: docs/architecture.md §UsageStats 模块
 *
 * [关键不变量]
 *   - 拦截器**内部任何异常都不得抛出**：抛出去会把正常请求变成 500（统计管线反噬业务）
 *   - exactly-once：单次 `recorded` 标志，`tap(error)` 与 `tap(finalize)` 双触发也只记 1 行
 *   - 计数挂在 **finalize**：SSE 的 `next` 每帧触发（不能计数，否则一帧一行），
 *     finalize 只在流终结时触发一次 → bucket 归**打开时刻**、latency = 连接存续时长
 *   - 状态码来源：`next` 取 `res.statusCode`（Nest 在拦截器链**之前**已 setStatus，
 *     见 router-execution-context.js:43）、`error` 取 `err.status || 500`
 *     （异常在拦截器链之后才由 exception filter 写响应，故此刻 res.statusCode 仍是 200）
 *   - 维度推导：`actorId = request.agent?.id ?? request.user?.userId ?? null`——
 *     human 侧字段是 **`userId`** 不是 `id`（express.d.ts:6-13）；actorType 由
 *     `agent`/`user` 存在性推导，**禁止 `agent.type`**（AgentPayload 无 type 字段）
 *   - `req.route.path` 是路由**模板**（天然含 /api/v1 前缀、天然含 `:param`）——
 *     禁止改用 `req.path`（含真实 ID → 基数爆炸）
 *   - 头部取值只做**统计元数据**：不作安全判定，接受伪造风险（口径专章声明）
 *
 * [关联代码]
 *   - usage-stats-buffer.service.ts — 计数落点（本文件只调 `recordHttpCall`）
 *   - skip-usage-stats.decorator.ts — `@SkipUsageStats` 自统计排除（上报端点用）
 *   - usage-stats.constants.ts — 词表与归一化单一定义点
 *
 * [持久踩坑]
 *   USAGE-STATS-EXACTLY-ONCE(双触发): 直接在 `next` 里计数会让 SSE 一帧记一行；
 *     只挂 finalize 又怕 error 路径漏记。安全方向: next 只更新状态、finalize 计数、
 *     recorded 标志兜重复——三条同时成立才恰好一行。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（fail-open 与 exactly-once 是否仍成立）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { UsageStatsBufferService, UsageStatsDimensions } from './usage-stats-buffer.service';
import { SKIP_USAGE_STATS_KEY } from './skip-usage-stats.decorator';
import {
  normalizeUsageSurface,
  normalizeUsageToolName,
  toStatusClass,
  toUtcHourBucket,
  USAGE_STATS_CHANNEL_REST,
  USAGE_SURFACE_NONE,
} from './usage-stats.constants';

/** MCP 工具名头（automcp 侧注入，厂商中立命名） */
export const USAGE_MCP_TOOL_HEADER = 'x-mcp-tool';

/** MCP 暴露面头（封闭词表取值，非法归 'unknown'） */
export const USAGE_MCP_SURFACE_HEADER = 'x-mcp-surface';

/**
 * 路由缺失时的兜底值（理论上不可达：拦截器只在匹配到路由之后执行）。
 * 刻意不用 `req.path` 兜底——那会把真实 ID 写进统计（基数爆炸 + 泄漏路径细节）。
 */
export const USAGE_UNKNOWN_ROUTE = 'unknown';

/**
 * 使用统计采集拦截器（全局 APP_INTERCEPTOR）。
 *
 * 位置语义（决定了口径，改动前先读 D1）：Nest 的执行顺序是
 * `guard → setStatus → interceptor 链（含 pipes 与 exception filter 之外的一切）→ 写响应`
 * （router-execution-context.js:36-47）。因此：
 * - guard 短路（401/403/429）**不进本拦截器** → 不计数（B7，口径专章声明）；
 * - 未匹配路由（404）同理不计数；
 * - **DTO 校验 400 会计数**：pipes 在拦截器链**内侧**执行，错误沿 observable 传出，
 *   被 `tap(error)` 捕获；
 * - 计时不含 guard 认证（`startedAt` 在拦截器入口取）。
 */
@Injectable()
export class UsageStatsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UsageStatsInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly buffer: UsageStatsBufferService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    try {
      // HTTP-only：WS 网关的 context 没有 route/response 语义，统计面只覆盖 REST
      if (context.getType() !== 'http') return next.handle();

      // 自统计排除（@SkipUsageStats，见 D4b：上报端点不能统计自己）
      const skip = this.reflector.getAllAndOverride<boolean>(SKIP_USAGE_STATS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (skip) return next.handle();

      const request = context.switchToHttp().getRequest<Request>();
      const response = context.switchToHttp().getResponse<Response>();

      // 计时起点与桶归属点：都在拦截器入口（= handler 阶段开始，SSE 为连接打开时刻）
      const startedAt = Date.now();
      const dimensions = captureDimensions(request);

      // 状态码在 next/error 里更新，最终在 finalize 一次性入库
      // （初值覆盖"既不 next 也不 error 就 complete"的极端路径）
      let status = response.statusCode;
      let recorded = false;

      /** 恰好记一次（error 与 finalize 双触发时第二个是空操作） */
      const commit = (): void => {
        if (recorded) return;
        recorded = true;
        try {
          this.buffer.recordHttpCall({
            ...dimensions,
            statusClass: toStatusClass(status),
            latencyMs: Date.now() - startedAt,
          });
        } catch (err) {
          // 采集失败只记日志：统计是旁路，不得影响业务（与整体 fail-open 一致）
          this.logger.warn(`usage stats record skipped: ${(err as Error).message}`);
        }
      };

      return next.handle().pipe(
        tap({
          // SSE 每帧触发：只更新状态、**不计数**（否则一帧一行）
          next: () => {
            status = response.statusCode;
          },
          // 异常路径：exception filter 尚未写响应，故此刻 res.statusCode 仍是默认值，
          // 必须从异常对象取真实状态
          error: (err: unknown) => {
            status = resolveErrorStatus(err);
            commit();
          },
          // 正常/异常/取消订阅统一收敛点：一次请求恰好一行
          finalize: () => commit(),
        }),
      );
    } catch (err) {
      // 最后一道 fail-open：维度推导或注册本身出错时，请求照常走
      this.logger.warn(`usage stats interceptor bypassed: ${(err as Error).message}`);
      return next.handle();
    }
  }
}

/**
 * 冻结本次请求的 8 个维度（不含 status_class/latency，它们在响应侧才有）。
 * 全部推导都在请求入口完成：SSE 长连接结束时这些值可能已被复用/清理。
 */
function captureDimensions(request: Request): Omit<UsageStatsDimensions, 'statusClass'> {
  const rawSurface = readHeader(request, USAGE_MCP_SURFACE_HEADER);
  const { actorId, actorType } = readActorContext(request);
  return {
    bucketStart: toUtcHourBucket(new Date()),
    channel: USAGE_STATS_CHANNEL_REST,
    // 头缺失 = 非 MCP 直连流量（'' 是词表内合法值）；头存在但非法/超长 → 'unknown'
    mcpSurface: rawSurface === undefined ? USAGE_SURFACE_NONE : normalizeUsageSurface(rawSurface),
    toolName: normalizeUsageToolName(readHeader(request, USAGE_MCP_TOOL_HEADER)),
    method: request.method,
    route: resolveRoute(request),
    actorId,
    actorType,
  };
}

/** 认证上下文的最小形状（只声明本拦截器真正读取的字段，理由见 readActorContext） */
interface UsageStatsActorContext {
  agent?: { id?: string } | null;
  user?: { userId?: string } | null;
}

/**
 * 读取 guard 挂载的认证上下文 → `actorId` / `actorType`（D7 三态推导）。
 *
 * ⚠️ 为什么用 `unknown` 中转而不是直接读 typed `Request`：`Express.Request` 上有**两处
 * 同名属性声明冲突**——`src/types/express.d.ts`（本项目：`user?: { userId, email, role, name }`）
 * 与 `@types/passport`（`user?: Express.User`，空接口）。本项目 d.ts 是模块文件、
 * passport 是 node_modules 库声明，在当前加载顺序下 passport 的声明胜出，于是
 * `request.user.userId` 报 TS2339（`User` 上无 `userId`）。这不是数据问题而是类型合并问题，
 * 故此处显式声明只读最小形状——语义以 `express.d.ts` 为准（`user.userId` / `agent.id`）。
 *
 * 类型由**存在性**推导而非 id 真值：`agent` 存在即 'agent'，`user` 存在即 'human'，
 * 两者都无 → 'anonymous'（口径专章：guard 短路不记，故这里的 anonymous =
 * "公开路由上通过了认证链的空身份"）。**禁止读 `agent.type`**——AgentPayload 无该字段。
 */
function readActorContext(request: Request): { actorId: string | null; actorType: string } {
  const context = request as unknown as UsageStatsActorContext;
  const agent = context.agent ?? null;
  const user = context.user ?? null;
  return {
    actorId: agent?.id ?? user?.userId ?? null,
    actorType: agent ? 'agent' : user ? 'human' : 'anonymous',
  };
}

/** 路由模板（含 /api/v1 前缀，是"高频 REST 晋升 MCP 工具"配方的 join 键） */
function resolveRoute(request: Request): string {
  const path = request.route?.path;
  return typeof path === 'string' && path.length > 0 ? path : USAGE_UNKNOWN_ROUTE;
}

/**
 * 读单个请求头（Express 已小写化头名）。
 * 同名头重复出现时 Node 合成数组——取首个即可（统计元数据，不参与安全判定）。
 */
function readHeader(request: Request, name: string): string | undefined {
  const raw = request.headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/**
 * 异常 → HTTP 状态码：`err.status || 500`（D1 钉死）。
 * 只认有限数值——HttpException 的 status 是数字，其余形态（字符串/缺失）一律 500。
 */
function resolveErrorStatus(err: unknown): number {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : 500;
}

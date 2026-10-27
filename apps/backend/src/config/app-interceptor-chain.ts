/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - AppModule **全局拦截器链序的单源清单**（`APP_INTERCEPTOR` 注册顺序）：顺序不是
 *     风格问题，而是**信封契约**——先注册者在外层，后注册者更靠近 handler。
 *
 * [代码职责]
 *   - 导出 `APP_INTERCEPTOR_CHAIN`（数组序 = 注册序 = 外层→内层）；`app.module.ts`
 *     只做 `{ provide: APP_INTERCEPTOR, useClass }` 的机械展开。
 *   - 守卫 = `src/app.module.spec.ts`（断言链序不变量，**不 boot 应用**）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/architecture.md §3.1（整体架构）；信封形状见
 *     docs/api-definition.md §2（通用规范）
 *
 * [关键不变量]
 *   - **`ResponseInterceptor` 必须是第一个（最外层）**：它负责把 handler 返回值包成
 *     `{code,message,data,timestamp,requestId}`。排在它**之后**的拦截器才看得到业务载荷
 *     （`data`）；排在它之前会拿到已包装的信封（`data` 里再套 `data`）。
 *   - **`HintInterceptor` 必须排在 `ResponseInterceptor` 之后**：它要读的是**业务载荷**
 *     本身（往 `data` 里挂 `hints`），而不是信封。
 *   - ⚠️ **「排在数组最后」≠「全链最内层」**：被 AppModule **import 的模块**若也注册
 *     `APP_INTERCEPTOR`（如 UsageStatsModule 的 UsageStatsInterceptor），Nest 会把
 *     **模块级注册排在 AppModule 自有注册之后**，成为比本数组更内层的拦截器。
 *     故此处只承诺「相邻两条的相对次序」，不承诺绝对内外层位置。
 *   - 顺序变更 = 契约变更：改本文件必须同步 `app.module.spec.ts` 的断言与本注释。
 *
 * [关联代码]
 *   - src/app.module.ts — 唯一消费方（`providers` 内机械展开）
 *   - src/app.module.spec.ts — 链序守卫（HintInterceptor 在 ResponseInterceptor 之后）
 *   - src/modules/hints/hint.interceptor.ts — 链序敏感方（读业务载荷、挂 `hints`）
 *   - src/config/app-config-loads.ts — 同族先例（AppModule 接线清单的单源 + 守卫模式）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增/调整拦截器时同步本数组与本文件的不变量说明
 *   □ 新增拦截器是否读业务载荷？读的话它必须在 ResponseInterceptor 之后
 * =============================================================================
 */
import type { Type } from '@nestjs/common';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { LoggingInterceptor } from '../common/interceptors/logging.interceptor';
import { AccessQueryInterceptor } from '../common/interceptors/access-query.interceptor';
import { HintInterceptor } from '../modules/hints/hint.interceptor';

/**
 * 全局拦截器链（**数组序 = 注册序 = 外层 → 内层**，不变量见文件头）。
 *
 * - `ResponseInterceptor`：信封包装（最外层；读业务载荷的拦截器必须排在它之后）
 * - `LoggingInterceptor`：请求日志（不读载荷语义）
 * - `AccessQueryInterceptor`：请求级白名单缓存（ALS）
 * - `HintInterceptor`：在**业务载荷**上挂 `hints`（advisory 提示，阶段一无 provider ⇒ 直通）
 */
export const APP_INTERCEPTOR_CHAIN: readonly Type<unknown>[] = [
  ResponseInterceptor,
  LoggingInterceptor,
  AccessQueryInterceptor,
  HintInterceptor,
];

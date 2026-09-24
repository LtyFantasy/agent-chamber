import { SetMetadata } from '@nestjs/common';

/** Reflector 读取用的元数据键（与拦截器共用，改名单点） */
export const SKIP_USAGE_STATS_KEY = 'skipUsageStats';

/**
 * 跳过 UsageStatsInterceptor 的自统计（照 `@SkipTransform` 先例，
 * 见 common/decorators/skip-transform.decorator.ts）。
 *
 * 唯一已知消费方 = `POST /system/usage-events`（D4b）：该端点本身就是上报入口，
 * 若被自己统计，每次 MCP 调用会额外产生一行 REST 记录，污染 `channel=rest` 口径。
 *
 * 刻意用装饰器而非路径字面量：路径改名时装饰器随代码走，字面量不会——
 * 后者会静默失效（自统计重新混入），前者改名即编译期可见。
 * 用法（方法级或类级均可，Reflector 走 getAllAndOverride）：
 * `@SkipUsageStats()`。
 */
export const SkipUsageStats = () => SetMetadata(SKIP_USAGE_STATS_KEY, true);

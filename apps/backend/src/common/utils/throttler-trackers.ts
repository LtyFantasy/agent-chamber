/**
 * 命名限流桶的 tracker（F4 项3，2026-10-17）。
 *
 * 为什么需要「身份维度」的桶，而不是只按 IP 限流（四条理由，缺一条这条防线就不成立）：
 * ① **automcp 是同一个出口**：生产双实例以 `--base-url http://localhost:8743/api/v1`
 *    从**同机**发起 recall（生产实测：双实例均无 `--api-key`，见 resume-context），
 *    即所有 MCP 侧调用共用同一个 loopback IP——纯 IP 桶在这个拓扑下把「所有 Agent」
 *    当成一个主体，配额互相挤压。
 * ② **远程部署同样共享 IP**：NAT / 办公网出口下，多个调用方天然同 IP。
 * ③ **身份桶可被无成本铸造**：`POST /agents`（agent.controller.ts:166-169）允许
 *    自主注册 Agent，故只按身份分桶等于给攻击者一个"每次换新身份即重置配额"的通道。
 *    ⇒ IP 维度是**拦洪的真上限**，身份维度是**公平性**——两个桶缺一不可，不是冗余。
 * ④ **双桶不会互相污染**：`generateKey` 把 throttler `name` 编进 key
 *    （throttler.guard.js:129-132 → `${class}-${handler}-${name}-${tracker}`），
 *    同一 tracker 在两个桶里是两条独立计数。
 *
 * 桶的声明与阈值：`app.module.ts` 的 forRoot 数组（不声明则该桶不会被迭代）；
 * 路由侧阈值见 `memory.controller.ts` 的 recall 端点。
 */
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';

/**
 * 按「Agent id → 人类 userId → IP」取 tracker，作为命名桶 `actor` 的默认身份。
 *
 * 类型标注必须是 `ThrottlerGetTrackerFunction`（形参是 `Record<string, any>`）：
 * 标注成 express `Request` 会因严格函数逆变（参数类型需为目标形参的父类型）报 TS2322
 * ——express `Request` 比 `Record<string, any>` 更窄，不可赋值（A-C1，评审实测）。
 *
 * 字段读法与守卫装配一致：API Key 通道挂 `request.agent.id`，人类 JWT 通道挂
 * `request.user.userId`——**注意是 `userId` 不是 `id`**（`src/types/express.d.ts:5`）；
 * 写成 `user.id` 恒 undefined，会让 JWT 通道静默退化成 IP 兜底且编译报错。
 * 两条通道都缺失才落 IP，`'unknown'` 兜底只为防御 request 形状异常（正常情况下
 * express 恒有 ip）。
 *
 * @param req 未类型化的请求对象（由守卫传入原始 express request）
 * @returns 该请求的限流身份键（agent id / user id / IP / 'unknown'）
 */
export const actorTracker: ThrottlerGetTrackerFunction = (req) => {
  const r = req as {
    agent?: { id?: string } | null;
    user?: { userId?: string } | null;
    ip?: string;
  };
  return r.agent?.id ?? r.user?.userId ?? req.ip ?? 'unknown';
};

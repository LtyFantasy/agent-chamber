/**
 * 登录回跳 helper（通知深链的最后一厘米）
 *
 * 场景：手机点通知里的深链（如 `/tasks/xxx`）→ 未登录 → 被赶到 `/login` 登录 →
 * 若不回跳就落在首页，目标页丢失。本模块把「当前地址」编码进 `?next=`（发送侧），
 * 并在登录成功时反向解析出安全目标（消费侧）。
 *
 * 分工（两处跳转点共用本模块，避免编码逻辑各写一遍成漂移源）：
 * - `buildLoginRedirect` —— 赶人去登录的调用方（api.ts 的 401 响应拦截器、
 *   `components/auth/auth-guard.tsx`）用它生成跳转地址；
 * - `resolveSafeNext` —— 登录页消费 `?next=` 前必须过它。**这是安全边界**：
 *   `?next=` 是攻击者完全可控的 query 参数（可直接分享 `/login?next=...` 钓鱼链接）。
 *
 * ⚠️ 为什么不能只靠 `/^\/(?!\/)/` 一条正则（plan §8 S5 的原始写法）——实测反例：
 * URL 解析器对 special scheme 会把反斜杠归一化成 `/`，并在解析前直接剥离 TAB/LF/CR，
 * 于是 `/\evil.com`、`/<TAB>/evil.com` 都能通过那条正则，却被浏览器解析成
 * `https://evil.com/`（node 实测：`new URL('/\\t/evil.com', 'https://x')` →
 * `https://evil.com/`）。因此这里**以 URL 解析器的解析结果为准做同源断言**：
 * 正则只负责「必须是站点相对路径」的形态前置，解析器负责最终同源判定——
 * 不手写字符黑名单，就不会再漏下一个变体。
 *
 * 已评估、**有意不改**的边界（review P2-2）：百分号编码形态（如 `/%2f%2fevil.com`）
 * 放行。依据：URL 解析器不会把路径里的 %2f 解码成 `/`，浏览器侧仍落在同源路径上；
 * 本链路下游（Next router / 后端）也没有「先 percent-decode 再当 URL 解析」的层。
 * 故不引入「解码后再校验」的复杂度——若将来出现这类下游消费者，此结论必须重估。
 */

/** 登录页路径（发送侧自指防护 + 消费侧不绕回登录页，两侧共用的判据） */
export const LOGIN_PATH = '/login';

/** 站点相对路径形态：`/` 开头，且第二个字符不是 `/`（`//host` 是协议相对 URL） */
const SITE_RELATIVE_PATTERN = /^\/(?!\/)/;

/**
 * 同源断言用哨兵基址：只提供一个确定的 origin 让 URL 解析器完成归一化，
 * 不参与最终地址（换任意 origin 结论一致，校验与真实部署域名无关）。
 */
const ORIGIN_SENTINEL = 'https://next-origin-sentinel.invalid';

/**
 * 组装「登录页 + 回跳目标」地址。
 *
 * @param pathname - 当前 pathname（`window.location.pathname`）
 * @param search - 当前 query（`window.location.search`，含前导 `?`）
 * @param hash - 当前 fragment（`window.location.hash`，含前导 `#`）。**必须一并带上**：
 *   消费侧 `resolveSafeNext` 放行 `#anchor`，发送侧若丢弃就造成往返不对称
 *   （深链落点从锚点漂回页首）
 * @returns `/login?next=<encodeURIComponent(pathname+search+hash)>`；当 `pathname` 缺失或
 *   已在登录页时返回 `/login`（**不填 next**，即发送侧自指防护）
 *
 * ⚠️ 自指防护的定位：它兜的是「AuthGuard 一类在 /login 上仍触发跳转」的形态。
 * **401 链路不靠它**——api.ts 的 401 分支在更上层直接短路（登录页上根本不重定向），
 * 因为那里除了自指还要保住 `?next=` 本身与用户已输入内容（见 api.ts 该分支注释）。
 */
export function buildLoginRedirect(pathname: string, search = '', hash = ''): string {
  if (!pathname || pathname === LOGIN_PATH) return LOGIN_PATH;
  return `${LOGIN_PATH}?next=${encodeURIComponent(pathname + search + hash)}`;
}

/**
 * 解析 `?next=` 并做同源白名单校验（登录页唯一入口）。
 *
 * 三层校验：
 * 1. 空值 / 缺失 → `/`；
 * 2. 自指：`next` 恰为 `/login` 时回退 `/`（否则登录成功后原地绕回登录表单）。
 *    按**精确等于**判定——`/login?x=1` 之类变体不在本判定内（它是合法站点相对路径，
 *    落地后表现由登录页自身决定），这是刻意收窄的范围；
 * 3. 形态 + 同源：先匹配 `/^\/(?!\/)/`（`/` 开头、非 `//` 协议相对），再交给 URL
 *    解析器归一化后断言 origin 等于哨兵基址 —— 后一步才拦住反斜杠 / 控制字符变体
 *    （见文件头实测说明）。
 *
 * @param next - 原始 query 值（`useSearchParams().get('next')`，已 percent-decode）
 * @returns 校验通过的**原值**（深链逐字不变，避免二次编码/解码漂移）；
 *   任何不合格输入（含空、缺失、自指、绝对 URL、协议相对、解析失败）一律回退 `/`
 */
export function resolveSafeNext(next: string | null): string {
  if (!next || next === LOGIN_PATH || !SITE_RELATIVE_PATTERN.test(next)) return '/';
  try {
    if (new URL(next, ORIGIN_SENTINEL).origin !== ORIGIN_SENTINEL) return '/';
  } catch {
    // 解析失败（非法 URL）与不同源同判：回退首页
    return '/';
  }
  return next;
}

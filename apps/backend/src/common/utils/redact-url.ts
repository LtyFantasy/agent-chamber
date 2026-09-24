/**
 * URL 日志脱敏（query 敏感键值替换，P2 批 2 / plan §②.7）。
 *
 * 背景：`logging.interceptor.ts` 与 `all-exceptions.filter.ts` 直接打完整 request.url，
 * 签名 URL 引入 `?token=<JWT>` 后，能力凭证会随访问日志/异常日志落盘
 * （日志读权限 = 凭证泄露）。公开端点每次抓取都会写一行，量还不小。
 *
 * 语义钉死：
 * - 只替换**查询参数值**，其余部分（path / 非敏感键 / 值编码形态 / 键值顺序 /
 *   重复键）逐字符保持原样——日志保真优先，不做 URL 重编码
 *   （URLSearchParams 往返会把 `+`、编码大小写等改写，破坏日志可读性与可比对性）；
 * - 敏感键匹配**大小写不敏感**（`?Token=` 不得绕过）；
 * - 数组形态 `?token=a&token=b` 天然覆盖（逐 key=value 段处理，重复段各自替换）；
 * - 无值形态 `?token`（无 `=`）同样视为敏感并补写 `[redacted]`；
 * - `#fragment` 原样保留（Express 的 request.url 一般不含 fragment，防御性处理）。
 *
 * 已知不做（刻意）：键名百分号编码（`?tok%65n=`）、`;` 分隔的旧式参数、路径段里的
 * 机密值——前者是规避面而非正常形态，后两者不属于 query 值域；如未来出现需求，
 * 在调用侧（而非本 util）收紧。
 */

/**
 * 需要脱敏的 query 键（小写匹配）。
 *
 * 前四键（token/access_token/api_key/key）是当前平台真实存在的凭证键；
 * 后四键（refresh_token/sig/signature/password）为前向防御——同一日志面未来
 * 接入预签名 URL（`X-Amz-Signature` 类）或表单式凭证时零成本覆盖。
 */
export const REDACTED_QUERY_KEYS = [
  'token',
  'access_token',
  'api_key',
  'key',
  'refresh_token',
  'sig',
  'signature',
  'password',
] as const;

/** 替换文案（固定字符串，不含原值任何片段——长度/前缀都不泄露） */
const REDACTED = '[redacted]';

/** 键是否敏感（大小写不敏感；键名不做百分号解码，见文件头「已知不做」） */
function isSensitiveKey(key: string): boolean {
  return (REDACTED_QUERY_KEYS as readonly string[]).includes(key.toLowerCase());
}

/**
 * 把 URL 中的敏感 query 值替换为 `[redacted]`。
 *
 * @param rawUrl 原始 URL（通常为 Express `request.url`：path + query，无 origin）
 * @returns 脱敏后的 URL；无 query 或无敏感键时原样返回
 */
export function redactUrl(rawUrl: string | undefined | null): string {
  if (!rawUrl) return '';
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return rawUrl;

  // fragment 从 query 中切出后原样保留（其内部不做 query 语义解析）
  const hashStart = rawUrl.indexOf('#', queryStart);
  const queryEnd = hashStart === -1 ? rawUrl.length : hashStart;
  const query = rawUrl.slice(queryStart + 1, queryEnd);
  const fragment = hashStart === -1 ? '' : rawUrl.slice(hashStart);
  if (query === '') return rawUrl;

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return isSensitiveKey(pair) ? `${pair}=${REDACTED}` : pair;
      const key = pair.slice(0, eq);
      return isSensitiveKey(key) ? `${key}=${REDACTED}` : pair;
    })
    .join('&');

  return `${rawUrl.slice(0, queryStart + 1)}${redactedQuery}${fragment}`;
}

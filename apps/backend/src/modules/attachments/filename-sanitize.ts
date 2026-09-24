/**
 * original_name sanitize 与 RFC 6266 filename* 编码（plan wiccan-carnage-rocket §3.6 钉死）；
 * P2 批 1 追加缩略图下载文件名拼装（buildThumbnailFilename）。
 *
 * 威胁模型：
 * 1. 原始文件名进 Content-Disposition 响应头——含 \r\n 可直接响应头注入
 *   （Node header 含 CRLF 直接 throw 500，错误码说谎 + 潜在拆分攻击）；
 * 2. 含路径分隔符的名字（../../etc/passwd、C:\x）对任何落盘/拼接消费方都是隐患；
 * 3. 数据库列 varchar(255) 按字符计，HTTP 头按字节计——统一按 UTF-8 字节截断 ≤255，
 *   两种消费方都安全，且不截断在多字节字符中间（半截 UTF-8 序列 = 替换字符乱码）。
 */

/** sanitize 后为空（纯控制字符/分隔符组成）时的兜底名 */
const FALLBACK_NAME = 'attachment';

/**
 * busboy latin1 文件名乱码还原。
 *
 * 背景：multer 2.x 构造 busboy 只透传 {headers, limits, preservePath}（源码实证），
 * busboy defParamCharset 保持默认 latin1——浏览器/Agent 按 UTF-8 发出的
 * filename="截图.png" 被逐字节按 latin1 解读成 mojibake（æ̈ªå̛¾.png）。
 * 框架层无配置入口，只能在应用层还原。
 *
 * 判定与安全性：mojibake 形态恒为「全码点 ≤ U+00FF」；按 latin1 重编码回字节后
 * 若是合法 UTF-8 则还原，否则（出现 U+FFFD 替换符）按原样返回——真 latin1 名
 * （如 café.png 的 é 单字节 0xE9 非法 UTF-8 起始字节）不会被误还原。
 * 纯 ASCII 名 latin1→utf8 恒等，天然免疫。
 */
function fixLatin1Mojibake(name: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\xff]*$/.test(name)) return name;
  const asUtf8 = Buffer.from(name, 'latin1').toString('utf8');
  return asUtf8.includes('�') ? name : asUtf8;
}

/**
 * 清洗原始文件名：
 * 0. busboy latin1 mojibake 还原（见 fixLatin1Mojibake）；
 * 1. 剥离全部控制字符（\x00-\x1F 含 \r\n\0、\x7F DEL）——删而非替换，零残留；
 * 2. 路径分隔符 / 与 \ 替换为 '_'（保留可读性，胜过直接删除导致的粘连）；
 * 3. trim；空结果回退 'attachment'；
 * 4. UTF-8 字节截断 ≤255（不在多字节序列中间下刀）。
 */
export function sanitizeOriginalName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = fixLatin1Mojibake(name).replace(/[\x00-\x1F\x7F]/g, '');
  cleaned = cleaned.replace(/[/\\]/g, '_');
  cleaned = cleaned.trim();
  if (cleaned === '') cleaned = FALLBACK_NAME;
  return truncateUtf8Bytes(cleaned, 255);
}

/**
 * 按 UTF-8 字节数截断字符串：逐 code point 累积，超上限即停，
 * 保证输出 Buffer.byteLength ≤ maxBytes 且无半截多字节序列。
 */
function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let out = '';
  for (const ch of value) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out === '' ? FALLBACK_NAME : out;
}

/**
 * RFC 6266 filename* 值的 percent-encoding（ext-value，charset=UTF-8）。
 *
 * 逐字节实现而非 encodeURIComponent 修补：attr-char 白名单
 * （ALPHA / DIGIT / ! # $ & + - . ^ _ ` | ~，RFC 5987 §3.2）直通，
 * 其余每字节 %XX 大写编码。多字节 UTF-8 字符的每字节 ≥ 0x80 必被编码；
 * encodeURIComponent 路线会把 #$&+^`|~ 一并编码（合法但偏离 SHOULD NOT），
 * 且漏编码 ' ( ) *——手写逐字节没有这两个坑。
 */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

export function encodeFilenameStar(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  let out = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    out += ATTR_CHAR.test(ch) ? ch : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/**
 * 缩略图下载文件名（P2 批 1 规格钉死）：`<原文件名 stem>_thumb.webp`。
 *
 * stem = 去掉最后一个扩展名（`photo.png` → `photo_thumb.webp`；多段扩展名
 * 只剥最后一段：`archive.tar.gz` → `archive.tar_thumb.webp`）；无扩展名
 * 原样加后缀；纯扩展名/空 stem 回退 FALLBACK_NAME（`attachment_thumb.webp`）。
 * 输入是**已 sanitize** 的 originalName（无控制字符/路径分隔符），故此处不再清洗。
 */
export function buildThumbnailFilename(originalName: string): string {
  const stem = originalName.replace(/\.[^./\\]*$/, '');
  return `${stem === '' ? FALLBACK_NAME : stem}_thumb.webp`;
}

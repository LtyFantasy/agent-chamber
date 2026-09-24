/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - bundle media 载荷解码 + **字节证据校验**（导入媒体段的唯一安全边界，P2 批 5）
 *
 * [代码职责]
 *   - 解码 base64（严格形态）→ 魔数嗅探（复用 image-sniffer）→ 与声明 mime 比对
 *     → sha256/sizeBytes 自洽 → 产出可入库的字节
 *   - 纯函数、零 IO：不查库、不写对象、不判权限（调用方 attachment.service 负责）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / bundle 媒体段)
 *   - 补充: docs/api-definition.md §16（bundle formatVersion 2 的 media 段契约）
 *
 * [关键不变量]
 *   - **嗅探结果才是事实**：声明 mimeType 只作对照，解码字节必须嗅探为
 *     png/jpeg/gif/webp 且与声明一致，否则 failed 不落行（与上传同一套 sniffImageMime）
 *   - 入库的 sizeBytes/sha256 一律取**实际解码结果**；声明值不符即 failed
 *   - 缩略图必须 webp；失败即整项 failed（不 fail-open 丢 thumb——bundle 是外部输入，
 *     静默降级会掩盖 tamper 信号）
 *
 * [关联代码]
 *   - image-sniffer.ts — 魔数白名单与头部解析（上传/导入共用单一事实源）
 *   - attachment.service.ts `importFromBundle` — 唯一调用方（配额/存储/复用键在那里）
 *   - docspace/doc-bundle.service.ts — 阶段编排与结果信封
 *
 * [持久踩坑]
 *   - BUNDLE-XSS(B2): 只信 bundle 声明的 mimeType = 允许脚本字节以 image/png 落库
 *     并由平台同源回吐（存储型 XSS）。安全方向：字节证据不符即 failed 不落行。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（尤其"嗅探结果才是事实"）
 *   □ 行为/合同变化时同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

/**
 * bundle media 载荷的解码与**字节证据**校验（P2 批 5 / plan §⑤.2-⑤.4、security B2）。
 *
 * 纯函数（零 IO），故与上传链共用同一套嗅探（image-sniffer.sniffImageMime）而不复制规则。
 *
 * 为什么必须在导入侧重做一遍上传时的校验：
 * 1. **存储型 XSS（security B2）**——bundle 是外部输入，`mimeType` 与 `originalName` 都是
 *    声明值。若只信声明，攻击者可以声明 `image/png` 却塞 `<script>` 字节，导入后这行会以
 *    `Content-Type: image/png` 被平台自己的附件端点回吐（同源），在浏览器里就是一次
 *    可控内容的同源投递。故：解码字节必须嗅探为四类图片之一**且与声明 mime 一致**，
 *    不符 → 该项 failed 不落行。
 * 2. **手改包防御**——sizeBytes/sha256 是自洽性证据：不符说明包被改过或坏了，
 *    落库等于把脏数据写进"内容寻址"的元数据面（sha256 是 ETag，说谎的 ETag 比没有更糟）。
 *
 * 与上传路径的差异（有意为之）：上传是"逐项违例即 400 终止"，bundle 是批量导入，
 * 任一不合规项落 per-item failed（不中止批次、不整包 400）——与 categories/routes 段口径一致。
 */

import { createHash } from 'crypto';
import { sniffImageMime } from './image-sniffer';

/** base64 严格形态：标准字母表 + ≤2 个尾部 '='（长度须为 4 的倍数） */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** 缩略图 MIME（恒 webp——thumbnail-generator 的唯一输出） */
const THUMBNAIL_MIME = 'image/webp';

/** 解码+校验成功 */
export interface BundleMediaDecodeOk {
  ok: true;
  /** 解码后的原始字节（入库/落对象用的唯一事实） */
  data: Buffer;
  /** 嗅探出的 mime（= 声明值，已比对一致） */
  mime: string;
  /** 用于对象键后缀的扩展名（{uuid}.{ext}） */
  ext: string;
}

/** 解码+校验失败（reason 面向调用方/Agent，指导修正后再导） */
export interface BundleMediaDecodeFail {
  ok: false;
  reason: string;
}

/**
 * 校验 base64 并解码。分两步（先形态后解码）的原因：`Buffer.from(str,'base64')`
 * 对非法字符是**静默忽略**的（不抛错），只靠它无法发现"包被改坏"。
 */
function decodeBase64Strict(
  contentBase64: string,
): { ok: true; data: Buffer } | { ok: false; reason: string } {
  if (contentBase64.length === 0) {
    return { ok: false, reason: 'contentBase64 is empty' };
  }
  if (contentBase64.length % 4 !== 0 || !BASE64_PATTERN.test(contentBase64)) {
    return { ok: false, reason: 'contentBase64 is not standard padded base64' };
  }
  return { ok: true, data: Buffer.from(contentBase64, 'base64') };
}

/**
 * 解码并校验 bundle 媒体载荷（原图）。
 *
 * 校验顺序（有意排序）：base64 形态 → 解码非空 → **字节证据（mime 嗅探一致性）** →
 * sha256 自洽 → sizeBytes 自洽。嗅探排在哈希之前是安全考量：字节证据不通过时
 * 无需再算哈希（也避免用"哈希对了"误导调用方以为内容可信）。
 */
export function decodeAndVerifyBundleMedia(input: {
  contentBase64: string;
  declaredMime: string;
  sizeBytes: number;
  sha256: string;
}): BundleMediaDecodeOk | BundleMediaDecodeFail {
  const decoded = decodeBase64Strict(input.contentBase64);
  if (!decoded.ok) return decoded;

  const data = decoded.data;
  if (data.length === 0) {
    return { ok: false, reason: 'decoded media payload is empty' };
  }

  // ── 字节证据（**存储型 XSS 的唯一防线**）──
  const sniffed = sniffImageMime(data);
  if (!sniffed) {
    return {
      ok: false,
      reason:
        'media byte evidence check failed: decoded bytes are not an allowed image ' +
        '(png/jpeg/gif/webp)',
    };
  }
  if (sniffed.mime !== input.declaredMime) {
    return {
      ok: false,
      reason: `media byte evidence mismatch: declared mimeType '${input.declaredMime}' but decoded bytes are '${sniffed.mime}'`,
    };
  }

  // ── sha256 自洽（手改包/传输损坏的探测器）──
  const actualSha = createHash('sha256').update(data).digest('hex');
  if (actualSha !== input.sha256) {
    return { ok: false, reason: 'media sha256 does not match the decoded bytes' };
  }

  // ── sizeBytes 自洽（入库值一律取实际长度，声明值只作对照）──
  if (data.length !== input.sizeBytes) {
    return {
      ok: false,
      reason: `media sizeBytes mismatch: declared ${input.sizeBytes} but decoded ${data.length} bytes`,
    };
  }

  return { ok: true, data, mime: sniffed.mime, ext: sniffed.ext };
}

/**
 * 解码并校验 bundle 缩略图载荷：解码字节必须嗅探为 webp（缩略图生成器唯一输出），
 * 且 sizeBytes/sha256 自洽。
 *
 * 为什么这里也**失败即整项 failed**（而不是像上传那样 fail-open 丢缩略图）：
 * 上传的 fail-open 是"我们自己生成失败，降级不影响主链路"；导入的缩略图是**别人给的
 * 字节**，不符 = 包不可信（同一项的原图也可能被动过），静默丢弃会掩盖 tamper 信号。
 */
export function decodeAndVerifyBundleThumbnail(input: {
  contentBase64: string;
  sizeBytes: number;
  sha256: string;
}): { ok: true; data: Buffer } | BundleMediaDecodeFail {
  const decoded = decodeBase64Strict(input.contentBase64);
  if (!decoded.ok) return decoded;

  const data = decoded.data;
  if (data.length === 0) {
    return { ok: false, reason: 'decoded thumbnail payload is empty' };
  }

  const sniffed = sniffImageMime(data);
  if (!sniffed || sniffed.mime !== THUMBNAIL_MIME) {
    return {
      ok: false,
      reason: `thumbnail byte evidence mismatch: decoded bytes are '${sniffed?.mime ?? 'unknown'}', expected '${THUMBNAIL_MIME}'`,
    };
  }

  const actualSha = createHash('sha256').update(data).digest('hex');
  if (actualSha !== input.sha256) {
    return { ok: false, reason: 'thumbnail sha256 does not match the decoded bytes' };
  }

  if (data.length !== input.sizeBytes) {
    return {
      ok: false,
      reason: `thumbnail sizeBytes mismatch: declared ${input.sizeBytes} but decoded ${data.length} bytes`,
    };
  }

  return { ok: true, data };
}

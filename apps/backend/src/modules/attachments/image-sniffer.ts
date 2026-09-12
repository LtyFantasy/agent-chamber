/**
 * 图片魔数嗅探与头部尺寸解析（plan wiccan-carnage-rocket §3.3，自写零依赖可单测）
 *
 * 为什么不用 file-type：v16+ 纯 ESM 与后端 CJS 构建冲突（plan 钉死）。
 * 为什么不信任客户端声明的 Content-Type：公开接口的所有输入都是敌意输入，
 * mime_type 入库值（= GET /content 响应 Content-Type 单一来源）必须来自字节证据。
 *
 * 尺寸校验的目的不是认识图片，而是防解码炸弹：只解析各格式的头部字段
 * （PNG IHDR / JPEG SOF0-15 / GIF 逻辑屏幕描述符 / WebP VP8/VP8L/VP8X 头），
 * 不做完整解码；头部损坏/截断一律返回 null 由调用方拒绝。
 */

/** 嗅探结果：mime 入库 + safeExt 用于 object_key 后缀（{uuid}.{safeExt}） */
export interface ImageSniffResult {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  ext: 'png' | 'jpg' | 'gif' | 'webp';
}

/** 图片头部解析出的像素尺寸 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/** 魔数表（§3.3 逐字节钉死） */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWithBytes(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function startsWithAscii(buf: Buffer, text: string, offset = 0): boolean {
  if (buf.length < offset + text.length) return false;
  return text.split('').every((ch, i) => buf[offset + i] === ch.charCodeAt(0));
}

/**
 * 魔数嗅探：返回命中白名单的 mime/ext，不命中返回 null。
 *
 * webp 必须双段比对（RIFF@0-3 + WEBP@8-11，共 12B）——只查 RIFF 会放行
 * WAV/AVI 等同容器格式（plan §3.3 明确警告）。
 */
export function sniffImageMime(buf: Buffer): ImageSniffResult | null {
  if (startsWithBytes(buf, PNG_SIGNATURE)) return { mime: 'image/png', ext: 'png' };
  if (startsWithBytes(buf, JPEG_SIGNATURE)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWithAscii(buf, 'GIF87a') || startsWithAscii(buf, 'GIF89a')) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (startsWithAscii(buf, 'RIFF') && startsWithAscii(buf, 'WEBP', 8)) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/**
 * PNG 尺寸：8B 签名后第一个 chunk 必须是 IHDR（4B 长度 + 'IHDR' + 数据），
 * width/height 为 BE uint32，位于文件偏移 16/20。
 */
function readPngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24 || !startsWithAscii(buf, 'IHDR', 12)) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * GIF 尺寸：逻辑屏幕描述符紧跟 6B 头，width/height 为 LE uint16，偏移 6/8。
 */
function readGifDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * JPEG 尺寸：遍历 marker 段找 SOF0-15（0xC0-0xCF，排除 0xC4 DHT / 0xC8 JPG / 0xCC DAC）。
 * 段结构：0xFF + marker + 2B 长度（含长度自身）+ 数据；SOF 段内 1B 精度 + 2B 高 + 2B 宽（BE）。
 * 遇 SOS（0xDA）或截断即放弃——SOF 必在 SOS 前。
 */
function readJpegDimensions(buf: Buffer): ImageDimensions | null {
  let offset = 2; // 跳过 SOI（FF D8）
  while (offset + 1 < buf.length) {
    // marker 前可能有填充 0xFF
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xda) return null; // SOS：不再往下找
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2; // 无长度独立 marker（RST0-7/TEM/SOI/EOI 家族）
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * WebP 尺寸：RIFF 容器内第一个 chunk 决定编码形态。
 * - 'VP8X'（extended）：canvas (width-1)/(height-1) 各 3B LE，偏移 24/27
 * - 'VP8 '（lossy）：帧头 start code 9D 01 2A 位于偏移 23，宽/高 LE uint16
 *   （低 14 位有效）位于偏移 26/28
 * - 'VP8L'（lossless）：签名 0x2F 于偏移 20，随后 4B 位打包 14 位 (width-1)/(height-1)
 */
function readWebpDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (startsWithAscii(buf, 'VP8X', 12)) {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (startsWithAscii(buf, 'VP8 ', 12)) {
    if (!(buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (startsWithAscii(buf, 'VP8L', 12)) {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * 按已嗅探的 mime 解析头部尺寸；头部损坏/截断/不认识的结构返回 null。
 * 调用方语义：null = 不可信文件（魔数可能系伪造头），拒绝入库。
 */
export function readImageDimensions(buf: Buffer, mime: ImageSniffResult['mime']): ImageDimensions | null {
  switch (mime) {
    case 'image/png':
      return readPngDimensions(buf);
    case 'image/jpeg':
      return readJpegDimensions(buf);
    case 'image/gif':
      return readGifDimensions(buf);
    case 'image/webp':
      return readWebpDimensions(buf);
  }
}

/**
 * 尺寸上限判定（防解码炸弹）：单边 > maxDimension 或总像素 > maxTotalPixels 即超限。
 * 纯函数，阈值由调用方注入（attachment.constants.ts 单一事实源）。
 */
export function exceedsDimensionLimits(
  dim: ImageDimensions,
  maxDimension: number,
  maxTotalPixels: number,
): boolean {
  if (dim.width > maxDimension || dim.height > maxDimension) return true;
  return dim.width * dim.height > maxTotalPixels;
}

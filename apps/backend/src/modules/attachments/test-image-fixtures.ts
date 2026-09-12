/**
 * 测试用最小图片字节构造器（attachments 模块 spec 共用 fixtures）
 *
 * 只构造魔数 + 头部尺寸字段（image-sniffer 的解析面），不构造完整合法图片——
 * 被测对象本来就只读头部（防炸弹语义，见 image-sniffer.ts 头注）。
 * PNG 的 CRC 等校验字段不填真值（解析路径不消费）。
 */

/** PNG：8B 签名 + IHDR chunk（长度 13 + 'IHDR' + 宽/高 BE uint32 于偏移 16/20） */
export function makePngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR 数据长度
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** GIF：6B 头（GIF87a/GIF89a）+ 逻辑屏幕描述符宽/高 LE uint16 于偏移 6/8 */
export function makeGifBuffer(width: number, height: number, variant: '87a' | '89a' = '89a'): Buffer {
  const buf = Buffer.alloc(13);
  buf.write(`GIF${variant}`, 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/**
 * JPEG：SOI + APP0(JFIF, 段长 16) + SOF0(段长 17，高/宽 BE 于段内偏移 3/5)。
 * 覆盖「SOF 前有其他 marker 段」的真实布局（盲找 SOF 偏移的实现会漏）。
 */
export function makeJpegBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(39);
  buf.writeUInt16BE(0xffd8, 0); // SOI
  buf.writeUInt16BE(0xffe0, 2); // APP0
  buf.writeUInt16BE(16, 4); // APP0 段长（含长度自身）
  buf.write('JFIF\0', 6, 'ascii');
  buf.writeUInt16BE(0xffc0, 20); // SOF0
  buf.writeUInt16BE(17, 22); // SOF0 段长
  buf.writeUInt8(8, 24); // 精度
  buf.writeUInt16BE(height, 25);
  buf.writeUInt16BE(width, 27);
  buf.writeUInt8(3, 29); // 组件数
  return buf;
}

/** JPEG 变体：SOI 后直接 SOS（无 SOF）——尺寸必须解析失败 */
export function makeJpegWithoutSof(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(0xffd8, 0);
  buf.writeUInt16BE(0xffda, 2); // SOS
  buf.writeUInt16BE(12, 4);
  return buf;
}

/** WebP lossy：RIFF+WEBP + 'VP8 ' chunk，start code 9D 01 2A @23，宽/高 LE @26/28（低 14 位） */
export function makeWebpVp8Buffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUInt8(0x9d, 23);
  buf.writeUInt8(0x01, 24);
  buf.writeUInt8(0x2a, 25);
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

/** WebP lossless：'VP8L' chunk，签名 0x2F @20，(w-1)/(h-1) 14 位打包 @21-24 */
export function makeWebpVp8lBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(5, 16);
  buf.writeUInt8(0x2f, 20);
  buf.writeUInt32LE((((height - 1) & 0x3fff) << 14) | ((width - 1) & 0x3fff), 21);
  return buf;
}

/** WebP extended：'VP8X' chunk，canvas (w-1)/(h-1) 各 3B LE @24/27 */
export function makeWebpVp8xBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

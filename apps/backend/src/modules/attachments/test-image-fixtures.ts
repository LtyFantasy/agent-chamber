/**
 * 测试用最小图片字节构造器（attachments 模块 spec 共用 fixtures）
 *
 * 只构造魔数 + 头部尺寸字段（image-sniffer 的解析面），不构造完整合法图片——
 * 被测对象本来就只读头部（防炸弹语义，见 image-sniffer.ts 头注）。
 * PNG 的 CRC 等校验字段不填真值（解析路径不消费）。
 *
 * ⚠️ 本文件分两套 fixtures（P2 批 1 追加第二套，两套都保留）：
 * - 本套（同步、伪图）：只喂 image-sniffer/sniff 测试——**sharp 解不了码**，
 *   拿去做缩略图生成只会走 fail-open 分支；
 * - `makeReal*`（异步、sharp 自产真字节）：喂解码路径（缩略图生成/首帧语义/
 *   e2e 真实上传）。
 */
import sharp from 'sharp';

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
export function makeGifBuffer(
  width: number,
  height: number,
  variant: '87a' | '89a' = '89a',
): Buffer {
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

// ─── 真实可解码 fixtures（P2 批 1，sharp 自产）───────────────────────────

/**
 * 真实 PNG 字节（sharp 编码，可被 sharp 解码）。
 * 默认 1024x768（> THUMB_MAX_EDGE，用于"缩放至 512"断言）。
 */
export async function makeRealPngBuffer(width = 1024, height = 768): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();
}

/** 真实 JPEG 字节（可解码）；默认 800x600（> 512，断言缩放） */
export async function makeRealJpegBuffer(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg()
    .toBuffer();
}

/** 真实静态 GIF 字节（可解码，单帧）；默认 40x20（< 512，断言不放大） */
export async function makeRealGifBuffer(width = 40, height = 20): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 10 } } })
    .gif()
    .toBuffer();
}

/** 真实静态 WebP 字节（可解码，单帧）；默认 64x32（< 512，断言不放大） */
export async function makeRealWebpBuffer(width = 64, height = 32): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 200 } } })
    .webp()
    .toBuffer();
}

/**
 * 真实 TIFF 字节——**不在上传白名单**（嗅探拒收），只用于"解码器收窄"单测：
 * 证明非白名单 loader 已被 block（sharp 直解该 buffer 必失败）。
 */
export async function makeTiffBuffer(width = 20, height = 20): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .tiff()
    .toBuffer();
}

/** GIF 的 LZW 码流打包（LSB-first，固定码宽 = minCodeSize+1） */
function packLzwCodes(codes: number[], minCodeSize: number): Buffer {
  const codeSize = minCodeSize + 1;
  const bits: number[] = [];
  for (const code of codes) {
    for (let i = 0; i < codeSize; i += 1) bits.push((code >> i) & 1);
  }
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte |= (bits[i + j] ?? 0) << j;
    out.push(byte);
  }
  return Buffer.from(out);
}

/**
 * 真实**多帧** GIF 字节（GIF89a，2 帧，canvas 2x2）：帧 1 纯白、帧 2 纯黑。
 *
 * 为什么手写而不是 sharp 自产：sharp/libvips 没有"从多张图编码多帧 GIF"的
 * 公开 API（写动画 GIF 需要输入本身多页）。手写码流用"每个像素前插 CLEAR"
 * 的 LZW 序列（CLEAR=4/EOI=5，码宽恒 3 bit，字典不增长）——最小可解析实现。
 *
 * 用途：断言缩略图取**首帧**（输出应为 2x2 白，而非 2x4 的堆叠图或帧 2 黑）。
 */
export function makeAnimatedGifBuffer(): Buffer {
  const CLEAR = 4;
  const EOI = 5;
  const parts: Buffer[] = [Buffer.from('GIF89a', 'ascii')];
  const lsd = Buffer.alloc(7); // 逻辑屏幕描述符：2x2 + 全局色表（2 色）
  lsd.writeUInt16LE(2, 0);
  lsd.writeUInt16LE(2, 2);
  lsd[4] = 0x80; // GCT 存在，色表 2 项
  parts.push(lsd);
  parts.push(Buffer.from([0, 0, 0, 255, 255, 255])); // GCT：索引 0 黑 / 索引 1 白
  const frame = (colorIndex: number): Buffer => {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]);
    const desc = Buffer.alloc(10); // 图像描述符：2x2，无局部色表
    desc[0] = 0x2c;
    desc.writeUInt16LE(2, 5);
    desc.writeUInt16LE(2, 7);
    const lzw = packLzwCodes(
      [CLEAR, colorIndex, CLEAR, colorIndex, CLEAR, colorIndex, CLEAR, colorIndex, EOI],
      2,
    );
    return Buffer.concat([gce, desc, Buffer.from([2, lzw.length]), lzw, Buffer.from([0])]);
  };
  parts.push(frame(1), frame(0), Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/**
 * 真实**动画 WebP** 字节（2 帧，由上面的多帧 GIF 经 sharp 转换而来）。
 * 用途：断言 animated WebP 缩略图同样取首帧（白帧）。
 */
export async function makeAnimatedWebpBuffer(): Promise<Buffer> {
  return sharp(makeAnimatedGifBuffer(), { animated: true }).webp({ loop: 0 }).toBuffer();
}

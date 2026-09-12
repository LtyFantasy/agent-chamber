/**
 * image-sniffer 单测：魔数白名单 + 各格式头部尺寸解析 + 尺寸上限判定
 *
 * 关键回归点（plan §3.3 点名）：
 * - webp 必须 RIFF+WEBP 双段比对——RIFF+WAVE（WAV 音频）不得放行；
 * - JPEG 尺寸须跳过 APPn 段找 SOF（盲读固定偏移会拿错）；
 * - 截断/伪造头一律 null（调用方语义 = 拒绝入库）。
 */
import {
  exceedsDimensionLimits,
  readImageDimensions,
  sniffImageMime,
} from './image-sniffer';
import {
  makeGifBuffer,
  makeJpegBuffer,
  makeJpegWithoutSof,
  makePngBuffer,
  makeWebpVp8Buffer,
  makeWebpVp8lBuffer,
  makeWebpVp8xBuffer,
} from './test-image-fixtures';

describe('sniffImageMime（魔数白名单）', () => {
  it('命中 png（8B 签名）', () => {
    expect(sniffImageMime(makePngBuffer(2, 2))).toEqual({ mime: 'image/png', ext: 'png' });
  });

  it('命中 jpeg（FF D8 FF 3B）', () => {
    expect(sniffImageMime(makeJpegBuffer(2, 2))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it('命中 gif87a 与 gif89a', () => {
    expect(sniffImageMime(makeGifBuffer(2, 2, '87a'))).toEqual({ mime: 'image/gif', ext: 'gif' });
    expect(sniffImageMime(makeGifBuffer(2, 2, '89a'))).toEqual({ mime: 'image/gif', ext: 'gif' });
  });

  it('命中 webp（RIFF + WEBP 双段）', () => {
    expect(sniffImageMime(makeWebpVp8Buffer(2, 2))).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('RIFF + WAVE（WAV 音频）不放行——只查 RIFF 的经典漏判', () => {
    const buf = Buffer.alloc(16);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WAVE', 8, 'ascii');
    expect(sniffImageMime(buf)).toBeNull();
  });

  it('随机字节 / 空 buffer / 截断签名均不命中', () => {
    expect(sniffImageMime(Buffer.from('not an image at all'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    // PNG 签名截断（仅前 4 字节）
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe('readImageDimensions（头部尺寸解析）', () => {
  it('PNG：IHDR 宽/高', () => {
    expect(readImageDimensions(makePngBuffer(640, 480), 'image/png')).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('PNG：IHDR 缺失/截断 → null', () => {
    const noIhdr = makePngBuffer(10, 10);
    noIhdr.write('XXXX', 12, 'ascii');
    expect(readImageDimensions(noIhdr, 'image/png')).toBeNull();
    expect(readImageDimensions(makePngBuffer(1, 1).subarray(0, 20), 'image/png')).toBeNull();
  });

  it('GIF：逻辑屏幕描述符宽/高', () => {
    expect(readImageDimensions(makeGifBuffer(320, 200), 'image/gif')).toEqual({
      width: 320,
      height: 200,
    });
  });

  it('JPEG：跳过 APP0 段命中 SOF0', () => {
    expect(readImageDimensions(makeJpegBuffer(1920, 1080), 'image/jpeg')).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('JPEG：SOS 先于 SOF（无尺寸段）→ null', () => {
    expect(readImageDimensions(makeJpegWithoutSof(), 'image/jpeg')).toBeNull();
  });

  it('WebP VP8（lossy）：start code + 14 位宽/高', () => {
    expect(readImageDimensions(makeWebpVp8Buffer(800, 600), 'image/webp')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('WebP VP8L（lossless）：位打包 14 位宽/高', () => {
    expect(readImageDimensions(makeWebpVp8lBuffer(1024, 768), 'image/webp')).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it('WebP VP8X（extended）：canvas 3B LE 宽/高', () => {
    expect(readImageDimensions(makeWebpVp8xBuffer(2048, 1536), 'image/webp')).toEqual({
      width: 2048,
      height: 1536,
    });
  });

  it('WebP：VP8 start code 缺失 → null', () => {
    const bad = makeWebpVp8Buffer(100, 100);
    bad.writeUInt8(0x00, 23);
    expect(readImageDimensions(bad, 'image/webp')).toBeNull();
  });
});

describe('exceedsDimensionLimits（炸弹判定）', () => {
  it('单边超限即拒（20000x10）', () => {
    expect(exceedsDimensionLimits({ width: 20000, height: 10 }, 16384, 40_000_000)).toBe(true);
  });

  it('总像素超限即拒（8000x6000 = 48MP）', () => {
    expect(exceedsDimensionLimits({ width: 8000, height: 6000 }, 16384, 40_000_000)).toBe(true);
  });

  it('边界值放行（恰 16384 边 / 恰 40MP）', () => {
    expect(exceedsDimensionLimits({ width: 16384, height: 100 }, 16384, 40_000_000)).toBe(false);
    expect(exceedsDimensionLimits({ width: 8000, height: 5000 }, 16384, 40_000_000)).toBe(false);
  });

  it('常规尺寸放行', () => {
    expect(exceedsDimensionLimits({ width: 1920, height: 1080 }, 16384, 40_000_000)).toBe(false);
  });
});

/**
 * thumbnail-generator 单测（P2 批 1，铁律 #17 测试契约）
 *
 * 覆盖（真实字节，非伪图——伪图 sharp 解不了码，测不出解码路径）：
 * ① 缩放：大图最长边 → 512 且宽高比保持；小图不放大（原尺寸）；
 * ② 格式：输出恒 webp（RIFF/WEBP 魔数 + sharp 可回读）；
 * ③ 首帧：多帧 GIF / animated WebP 缩略图 = 帧 1（白色，非堆叠图/末帧）；
 * ④ 解码面收窄：非白名单 loader（TIFF）被 block 失败，白名单（含 GIF）可用；
 * ⑤ 信号量：并发 N 个生成全部完成（FIFO 唤醒路径无丢许可/死锁）。
 */
import sharp from 'sharp';
import { generateWebpThumbnail, THUMB_LOADER_WHITELIST } from './thumbnail-generator';
import { ATTACHMENT_THUMB_MAX_EDGE } from './attachment.constants';
import {
  makeAnimatedGifBuffer,
  makeAnimatedWebpBuffer,
  makeRealGifBuffer,
  makeRealJpegBuffer,
  makeRealPngBuffer,
  makeRealWebpBuffer,
  makeTiffBuffer,
} from './test-image-fixtures';

/** 回读生成的缩略图（raw 像素 + 尺寸） */
async function readRaw(
  buffer: Buffer,
): Promise<{ width: number; height: number; pixels: number[] }> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: [...data.subarray(0, 3)] };
}

describe('generateWebpThumbnail', () => {
  it('大图（1024x768 PNG）→ webp，最长边 = 512，宽高比保持', async () => {
    const out = await generateWebpThumbnail(await makeRealPngBuffer(1024, 768));

    expect(out.width).toBe(ATTACHMENT_THUMB_MAX_EDGE);
    expect(out.height).toBe(384); // 1024:768 = 512:384
    // 输出恒 webp：RIFF....WEBP 魔数（sharp 回读也验证）
    expect(out.data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(out.data.subarray(8, 12).toString('ascii')).toBe('WEBP');
    await expect(sharp(out.data).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 512,
      height: 384,
    });
  });

  it('小图不放大：40x20 GIF → 40x20（不触发 withoutEnlargement 放大）', async () => {
    const out = await generateWebpThumbnail(await makeRealGifBuffer(40, 20));
    expect(out.width).toBe(40);
    expect(out.height).toBe(20);
  });

  it('JPEG / 静态 WebP 同样可生成（白名单四格式全覆盖）', async () => {
    const jpeg = await generateWebpThumbnail(await makeRealJpegBuffer(800, 600));
    expect(jpeg.width).toBe(512);
    expect(jpeg.height).toBe(384);

    const webp = await generateWebpThumbnail(await makeRealWebpBuffer(64, 32));
    expect(webp.width).toBe(64);
    expect(webp.height).toBe(32);
  });

  it('多帧 GIF 取首帧：帧 1 白 / 帧 2 黑 → 输出 2x2 纯白（非 2x4 堆叠、非末帧）', async () => {
    const gif = makeAnimatedGifBuffer();
    // 前置事实校验：fixture 真是 2 帧（防 fixture 退化成单帧导致假绿）
    await expect(sharp(gif, { animated: true }).metadata()).resolves.toMatchObject({
      format: 'gif',
      width: 2,
      height: 4,
      pages: 2,
    });

    const out = await generateWebpThumbnail(gif);

    expect([out.width, out.height]).toEqual([2, 2]); // 单帧，未堆叠
    const raw = await readRaw(out.data);
    expect(raw.pixels).toEqual([255, 255, 255]); // 帧 1（白）而非帧 2（黑）
  });

  it('animated WebP 取首帧：输出 2x2 纯白', async () => {
    const animated = await makeAnimatedWebpBuffer();
    await expect(sharp(animated, { animated: true }).metadata()).resolves.toMatchObject({
      format: 'webp',
      pages: 2,
    });

    const out = await generateWebpThumbnail(animated);

    expect([out.width, out.height]).toEqual([2, 2]);
    const raw = await readRaw(out.data);
    expect(raw.pixels).toEqual([255, 255, 255]);
  });

  it('解码面收窄：非白名单 TIFF 被 block 失败，白名单含 GIF/Nsgif loader', async () => {
    // 白名单闭合集合（GIF 双 loader 变体必须都在——漏一个 = GIF 缩略图全失败）
    expect(THUMB_LOADER_WHITELIST).toEqual(
      expect.arrayContaining([
        'VipsForeignLoadPngBuffer',
        'VipsForeignLoadJpegBuffer',
        'VipsForeignLoadWebpBuffer',
        'VipsForeignLoadGifBuffer',
        'VipsForeignLoadNsgifBuffer',
      ]),
    );
    expect(THUMB_LOADER_WHITELIST.join(',')).not.toContain('Tiff');

    // TIFF：block('VipsForeignLoad') 家族封锁沿类型继承链生效 → 解码必失败
    const tiff = await makeTiffBuffer(20, 20);
    await expect(generateWebpThumbnail(tiff)).rejects.toThrow();

    // 同一个进程内 GIF 仍然可用（block 没把白名单一起封掉）
    await expect(generateWebpThumbnail(await makeRealGifBuffer(8, 8))).resolves.toMatchObject({
      width: 8,
      height: 8,
    });
  });

  it('信号量：6 个并发生成全部完成且尺寸正确（FIFO 唤醒无丢许可/死锁）', async () => {
    const png = await makeRealPngBuffer(1024, 768);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => generateWebpThumbnail(png)),
    );
    for (const out of results) {
      expect([out.width, out.height]).toEqual([512, 384]);
    }
  });

  it('解码失败不吞错（fail-open 是调用方职责）：垃圾字节 reject', async () => {
    await expect(generateWebpThumbnail(Buffer.from('not-an-image'))).rejects.toThrow();
  });
});

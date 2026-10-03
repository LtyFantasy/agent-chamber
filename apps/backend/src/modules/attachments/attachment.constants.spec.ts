/**
 * attachment.constants.spec.ts — 附件 TTL / 类型出口 / 过期判据常量与纯函数单测
 * （v1.90.0-dev 附件 TTL 批 §1.1/§1.2/§1.3）。
 *
 * 钉死的契约：
 * - `INLINE_IMAGE_MIME_TYPES` 是**精确相等**成员判断（禁前缀/正则：image/svg+xml 过闸 = XSS）；
 * - `resolveAttachmentTtlMs` **fail-closed**：未知/脏值 → 7d（绝不回退 never）；
 * - `computeAttachmentExpiresAt`：doc 绑定永久（null）；
 * - `isAttachmentExpired`：null/非法日期 → false（永不把脏数据判成过期）；
 * - `isAttachmentReadable`：仅 'ready'。
 */
import {
  ATTACHMENT_FALLBACK_MIME,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TTL_DEFAULT,
  ATTACHMENT_TTL_OPTIONS,
  INLINE_IMAGE_MIME_TYPES,
  NON_IMAGE_OBJECT_EXT,
  computeAttachmentExpiresAt,
  isAttachmentExpired,
  isAttachmentReadable,
  isInlineImageMime,
  resolveAttachmentTtlMs,
} from './attachment.constants';

describe('attachment.constants（TTL / 类型出口 / 过期判据）', () => {
  describe('单文件上限（§1.5）', () => {
    it('默认 10MiB（业务口径 10MB）——与 nginx 12m 留 2m 余量', () => {
      expect(ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('INLINE_IMAGE_MIME_TYPES / isInlineImageMime（§1.2 M1）', () => {
    it('值域 = 4 种嗅探图片（与 image-sniffer 返回类型逐字一致）', () => {
      expect([...INLINE_IMAGE_MIME_TYPES]).toEqual([
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
      ]);
    });

    it('精确相等成员判断：4 种命中，其余一律 false', () => {
      expect(isInlineImageMime('image/png')).toBe(true);
      expect(isInlineImageMime('image/jpeg')).toBe(true);
      expect(isInlineImageMime('image/gif')).toBe(true);
      expect(isInlineImageMime('image/webp')).toBe(true);
      expect(isInlineImageMime(ATTACHMENT_FALLBACK_MIME)).toBe(false);
      expect(isInlineImageMime('application/pdf')).toBe(false);
      expect(isInlineImageMime('image/avif')).toBe(false);
      expect(isInlineImageMime('')).toBe(false);
    });

    it('SVG 必须被拒（前缀判断会放行 image/svg+xml = 存储型 XSS 面）', () => {
      expect(isInlineImageMime('image/svg+xml')).toBe(false);
      expect(isInlineImageMime('image/svg')).toBe(false);
      // 近似值也不得命中（无 trim/大小写归一——出口判据不做任何"聪明"变换）
      expect(isInlineImageMime('image/png ')).toBe(false);
      expect(isInlineImageMime('IMAGE/PNG')).toBe(false);
    });

    it('非图片对象键后缀恒定 .bin（外部输入不进键空间，M3）', () => {
      expect(NON_IMAGE_OBJECT_EXT).toBe('bin');
    });
  });

  describe('resolveAttachmentTtlMs / computeAttachmentExpiresAt（§1.1）', () => {
    it('四档映射：1d/7d/30d 天数正确，never → null', () => {
      expect(ATTACHMENT_TTL_OPTIONS['1d']).toBe(24 * 60 * 60 * 1000);
      expect(ATTACHMENT_TTL_OPTIONS['7d']).toBe(7 * 24 * 60 * 60 * 1000);
      expect(ATTACHMENT_TTL_OPTIONS['30d']).toBe(30 * 24 * 60 * 60 * 1000);
      expect(ATTACHMENT_TTL_OPTIONS.never).toBeNull();
      expect(ATTACHMENT_TTL_DEFAULT).toBe('7d');
    });

    it('白名单成员判断：合法档位原值返回', () => {
      expect(resolveAttachmentTtlMs('1d')).toBe(86_400_000);
      expect(resolveAttachmentTtlMs('never')).toBeNull();
    });

    it('fail-closed：缺省/未知/脏值/非字符串 → 7d（绝不回退 never）', () => {
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      for (const dirty of [
        undefined,
        null,
        '',
        'forever',
        '0',
        '1D',
        '7',
        7,
        true,
        {},
        ['7d'],
        'constructor',
        '__proto__',
        'toString',
      ]) {
        expect(resolveAttachmentTtlMs(dirty)).toBe(sevenDays);
      }
    });

    it('computeAttachmentExpiresAt：now + ttl；never → null；永久短路 → null', () => {
      const now = new Date('2026-10-03T00:00:00.000Z');
      expect(computeAttachmentExpiresAt('1d', now)?.toISOString()).toBe('2026-10-04T00:00:00.000Z');
      expect(computeAttachmentExpiresAt('30d', now)?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
      expect(computeAttachmentExpiresAt('never', now)).toBeNull();
      // doc 绑定 / 显式豁免：无论 rawTtl 是什么都恒 null
      expect(computeAttachmentExpiresAt('1d', now, true)).toBeNull();
      expect(computeAttachmentExpiresAt(undefined, now, true)).toBeNull();
      // 脏值 → 7d（不是 null）
      expect(computeAttachmentExpiresAt('bogus', now)?.toISOString()).toBe(
        '2026-10-10T00:00:00.000Z',
      );
    });
  });

  describe('isAttachmentExpired（单一事实源）', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');

    it('null / undefined = 永久 → false', () => {
      expect(isAttachmentExpired(null, now)).toBe(false);
      expect(isAttachmentExpired(undefined, now)).toBe(false);
    });

    it('过去 → true；未来 → false；恰等于 now → false（严格 <，与 GC/partial index 谓词逐字同义）', () => {
      expect(isAttachmentExpired(new Date('2026-10-03T11:59:59.000Z'), now)).toBe(true);
      expect(isAttachmentExpired(new Date('2026-10-03T12:00:01.000Z'), now)).toBe(false);
      expect(isAttachmentExpired(new Date('2026-10-03T12:00:00.000Z'), now)).toBe(false);
    });

    it('接受 ISO 字符串（消息索引快照形态）', () => {
      expect(isAttachmentExpired('2026-10-03T11:00:00.000Z', now)).toBe(true);
      expect(isAttachmentExpired('2026-10-03T13:00:00.000Z', now)).toBe(false);
    });

    it('非法日期串 → false（宁可可下载，不因脏数据把资源置灰）', () => {
      expect(isAttachmentExpired('not-a-date', now)).toBe(false);
      expect(isAttachmentExpired('', now)).toBe(false);
      expect(isAttachmentExpired(new Date('invalid'), now)).toBe(false);
    });
  });

  describe('isAttachmentReadable（m6 就绪谓词）', () => {
    it('仅 ready 可读字节；pending/其它/空 → false', () => {
      expect(isAttachmentReadable('ready')).toBe(true);
      expect(isAttachmentReadable('pending')).toBe(false);
      expect(isAttachmentReadable('')).toBe(false);
      expect(isAttachmentReadable('READY')).toBe(false);
    });
  });
});

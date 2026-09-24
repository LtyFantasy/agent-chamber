/**
 * doc-bundle-url 纯函数单测（P2 批 5 / plan §0 arch m8：重写两形态）
 *
 * 覆盖：相对形态、同源绝对形态（含端口）、正文多引用提取（去重 + 顺序）、
 * 无映射不重写、非 UUID / 非 /content 路径不误伤、同一 content 连续两次扫描不漏匹配
 * （正则带 g 标志的 lastIndex 陷阱）。
 */
import { extractAttachmentContentIds, rewriteAttachmentContentUrls } from './doc-bundle-url';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('doc-bundle-url', () => {
  describe('rewriteAttachmentContentUrls', () => {
    it('相对形态：只换 id，形态不变', () => {
      const out = rewriteAttachmentContentUrls(`![a](/api/v1/attachments/${A}/content)`, new Map([[A, B]]));
      expect(out).toBe(`![a](/api/v1/attachments/${B}/content)`);
    });

    it('同源绝对形态：保留 origin（含端口）+ 换 id', () => {
      const out = rewriteAttachmentContentUrls(
        `see https://platform.example.com:8443/api/v1/attachments/${A}/content here`,
        new Map([[A, B]]),
      );
      expect(out).toBe(`see https://platform.example.com:8443/api/v1/attachments/${B}/content here`);
    });

    it('同一正文两形态都换（映射命中即改，与出现形态无关）', () => {
      const content = `/api/v1/attachments/${A}/content and https://x.io/api/v1/attachments/${A}/content`;
      const out = rewriteAttachmentContentUrls(content, new Map([[A, C]]));
      expect(out).toBe(`/api/v1/attachments/${C}/content and https://x.io/api/v1/attachments/${C}/content`);
    });

    it('无映射不重写（断链可见优于错链）', () => {
      const content = `/api/v1/attachments/${A}/content`;
      expect(rewriteAttachmentContentUrls(content, new Map([[B, C]]))).toBe(content);
      expect(rewriteAttachmentContentUrls(content, new Map())).toBe(content);
    });

    it('不误伤：非 UUID / 非 /content 路径 / 其它前缀原样保留', () => {
      const content = [
        '/api/v1/attachments/not-a-uuid/content',
        `/api/v1/attachments/${A}/thumbnail`,
        `/v2/attachments/${A}/content`,
      ].join(' | ');
      const out = rewriteAttachmentContentUrls(content, new Map([[A, B]]));
      expect(out).toBe(content);
    });

    it('URL 后带 query 也重写（只替换路径段，query 原样保留）', () => {
      const content = `/api/v1/attachments/${A}/content?download=1`;
      expect(rewriteAttachmentContentUrls(content, new Map([[A, B]]))).toBe(
        `/api/v1/attachments/${B}/content?download=1`,
      );
    });

    it('大小写形态：URL 里出现大写 UUID 也能命中映射', () => {
      const upper = A.toUpperCase();
      const out = rewriteAttachmentContentUrls(`/api/v1/attachments/${upper}/content`, new Map([[A, B]]));
      expect(out).toBe(`/api/v1/attachments/${B}/content`);
    });
  });

  describe('extractAttachmentContentIds', () => {
    it('按出现顺序去重提取（小写归一）', () => {
      const content = [
        `/api/v1/attachments/${A}/content`,
        `https://x.io/api/v1/attachments/${B}/content`,
        `/api/v1/attachments/${A}/content`,
        `/api/v1/attachments/${C}/thumbnail`,
      ].join('\n');
      expect(extractAttachmentContentIds(content)).toEqual([A, B]);
    });

    it('同一 content 连续两次扫描结果一致（g 标志 lastIndex 陷阱回归）', () => {
      const content = `/api/v1/attachments/${A}/content`;
      expect(extractAttachmentContentIds(content)).toEqual([A]);
      expect(extractAttachmentContentIds(content)).toEqual([A]);
    });
  });
});

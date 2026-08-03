import { FILE_MAX_BYTES, isOverFileLimit } from '@/lib/docs-upload-limit';

describe('batch-upload-dialog 单文件大小校验（B4）', () => {
  it('阈值常量 = 4.5MB（后端 body limit 5mb 作用于整个请求体，单文件预留 JSON 封装余量）', () => {
    expect(FILE_MAX_BYTES).toBe(4.5 * 1024 * 1024);
  });

  it('恰好等于阈值不判定超限（边界）', () => {
    expect(isOverFileLimit(FILE_MAX_BYTES)).toBe(false);
  });

  it('超过阈值判定超限', () => {
    expect(isOverFileLimit(FILE_MAX_BYTES + 1)).toBe(true);
    // 顶格 5MB 必然超限（后端 body limit 会连 JSON 封装一起算）
    expect(isOverFileLimit(5 * 1024 * 1024)).toBe(true);
  });

  it('小文件不超限', () => {
    expect(isOverFileLimit(1024)).toBe(false);
    expect(isOverFileLimit(0)).toBe(false);
  });

  it('支持自定义阈值参数', () => {
    expect(isOverFileLimit(100, 200)).toBe(false);
    expect(isOverFileLimit(201, 200)).toBe(true);
  });
});

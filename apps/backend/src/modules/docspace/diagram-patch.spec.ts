/**
 * diagram-patch.ts 纯函数单测（plan §6.1：pointer 解析 / 三 op 语义 / 根路径拒绝 /
 * 父缺失与类型不符 / 原子性）。照 markdown-chunker 可独立单测先例，无 NestJS 依赖。
 */
import { applyDiagramPatch, parseJsonPointer, DiagramPatchError } from './diagram-patch';

/** 测试基准 IR（每用例函数内深拷贝语义由 applyDiagramPatch 自带，无需调用方处理） */
function makeIr() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Web App', 'tilde~key': { 'slash/key': 1 } },
    components: [
      { id: 'web', label: 'Web Frontend', tags: ['spa', 'react'] },
      { id: 'api', label: 'API Server', tags: ['fastapi'] },
      { id: 'db', label: 'PostgreSQL', tags: [] },
    ],
    connections: [{ from: 'web', to: 'api', label: 'HTTPS' }],
  };
}

describe('parseJsonPointer（RFC 6901）', () => {
  it('解析嵌套对象路径', () => {
    expect(parseJsonPointer('/meta/title')).toEqual(['meta', 'title']);
  });

  it('解析数组下标段', () => {
    expect(parseJsonPointer('/components/2/label')).toEqual(['components', '2', 'label']);
  });

  it('~1 → / 转义', () => {
    expect(parseJsonPointer('/meta/tilde~0key/slash~1key')).toEqual([
      'meta',
      'tilde~key',
      'slash/key',
    ]);
  });

  it("空串（根）解析为空段数组", () => {
    expect(parseJsonPointer('')).toEqual([]);
  });

  it('非 / 前缀 → DiagramPatchError', () => {
    expect(() => parseJsonPointer('components/0/label')).toThrow(DiagramPatchError);
  });
});

describe('applyDiagramPatch — 三 op 语义', () => {
  it('replace 对象键值', () => {
    const out = applyDiagramPatch(makeIr(), [
      { op: 'replace', path: '/components/2/label', value: 'API 网关' },
    ]) as ReturnType<typeof makeIr>;
    expect(out.components[2].label).toBe('API 网关');
  });

  it('replace 数组元素', () => {
    const out = applyDiagramPatch(makeIr(), [
      { op: 'replace', path: '/components/0/tags/1', value: 'vue' },
    ]) as ReturnType<typeof makeIr>;
    expect(out.components[0].tags).toEqual(['spa', 'vue']);
  });

  it('add 对象新键（RFC 6902 对象 add = upsert 语义）', () => {
    const out = applyDiagramPatch(makeIr(), [
      { op: 'add', path: '/meta/subtitle', value: 'v2' },
    ]) as ReturnType<typeof makeIr> & { meta: { subtitle?: string } };
    expect(out.meta.subtitle).toBe('v2');
  });

  it('add 数组中间插入与尾插（index == length）', () => {
    const insert = applyDiagramPatch(makeIr(), [
      { op: 'add', path: '/components/1', value: { id: 'cache', label: 'Redis', tags: [] } },
    ]) as ReturnType<typeof makeIr>;
    expect(insert.components.map((c) => c.id)).toEqual(['web', 'cache', 'api', 'db']);

    const append = applyDiagramPatch(makeIr(), [
      { op: 'add', path: '/components/3', value: { id: 's3', label: 'S3', tags: [] } },
    ]) as ReturnType<typeof makeIr>;
    expect(append.components.map((c) => c.id)).toEqual(['web', 'api', 'db', 's3']);
  });

  it("add 数组 '-' 尾段追加（RFC 6902）", () => {
    const out = applyDiagramPatch(makeIr(), [
      { op: 'add', path: '/components/-', value: { id: 'cdn', label: 'CDN', tags: [] } },
    ]) as ReturnType<typeof makeIr>;
    expect(out.components.map((c) => c.id)).toEqual(['web', 'api', 'db', 'cdn']);
  });

  it('remove 对象键与数组元素', () => {
    const out = applyDiagramPatch(makeIr(), [
      { op: 'remove', path: '/connections/0' },
      { op: 'remove', path: '/meta/tilde~0key' },
    ]) as ReturnType<typeof makeIr>;
    expect(out.connections).toEqual([]);
    expect(out.meta['tilde~key']).toBeUndefined();
  });

  it('replace 允许显式 null 值（undefined 才是缺失）', () => {
    const out = applyDiagramPatch(makeIr(), [
      { op: 'replace', path: '/meta/title', value: null },
    ]) as ReturnType<typeof makeIr>;
    expect(out.meta.title).toBeNull();
  });
});

describe('applyDiagramPatch — 拒绝面（带 pointer+reason）', () => {
  it("根路径 '' 拒绝（整文档替换走 upsert_diagram）；'/' 是 RFC 6901 的空键名而非根——键 '' 不存在同样失败", () => {
    try {
      applyDiagramPatch(makeIr(), [{ op: 'replace', path: '', value: {} }]);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DiagramPatchError);
      expect((err as DiagramPatchError).reason).toMatch(/root-level/);
    }
    // '/' 解析为 [''] = 根对象的 '' 键（RFC 6901 合法指针）——目标不存在 → 拒绝
    expect(() => applyDiagramPatch(makeIr(), [{ op: 'replace', path: '/', value: {} }])).toThrow(
      DiagramPatchError,
    );
  });

  it('replace 不存在的键 → 失败', () => {
    expect(() =>
      applyDiagramPatch(makeIr(), [{ op: 'replace', path: '/meta/nope', value: 1 }]),
    ).toThrow(DiagramPatchError);
  });

  it('remove 不存在的数组下标 → 越界失败', () => {
    try {
      applyDiagramPatch(makeIr(), [{ op: 'remove', path: '/components/9' }]);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DiagramPatchError);
      expect((err as DiagramPatchError).pointer).toBe('/components/9');
      expect((err as DiagramPatchError).reason).toMatch(/out of bounds/);
    }
  });

  it('父容器不存在 → 失败', () => {
    expect(() =>
      applyDiagramPatch(makeIr(), [{ op: 'replace', path: '/nope/0/label', value: 'x' }]),
    ).toThrow(DiagramPatchError);
  });

  it('穿越标量 → 类型不符失败', () => {
    try {
      applyDiagramPatch(makeIr(), [{ op: 'replace', path: '/meta/title/x', value: 1 }]);
      fail('should have thrown');
    } catch (err) {
      expect((err as DiagramPatchError).reason).toMatch(/scalar/);
    }
  });

  it("replace/add 缺 value → 失败", () => {
    expect(() => applyDiagramPatch(makeIr(), [{ op: 'replace', path: '/meta/title' }])).toThrow(
      /requires a 'value'/,
    );
    expect(() => applyDiagramPatch(makeIr(), [{ op: 'add', path: '/meta/x' }])).toThrow(
      /requires a 'value'/,
    );
  });

  it("'-' 尾段对 replace/remove 非法", () => {
    expect(() => applyDiagramPatch(makeIr(), [{ op: 'remove', path: '/components/-' }])).toThrow(
      DiagramPatchError,
    );
  });

  it('非数字数组下标 → 失败', () => {
    expect(() =>
      applyDiagramPatch(makeIr(), [{ op: 'replace', path: '/components/abc', value: 1 }]),
    ).toThrow(DiagramPatchError);
  });
});

describe('applyDiagramPatch — 原子性（全或无）', () => {
  it('多 op 中间失败 → 输入对象零变更（引用不变、内容不变）', () => {
    const ir = makeIr();
    const snapshot = JSON.stringify(ir);
    expect(() =>
      applyDiagramPatch(ir, [
        { op: 'replace', path: '/components/0/label', value: 'CHANGED' },
        { op: 'replace', path: '/nope/deep/path', value: 1 }, // 失败点
        { op: 'remove', path: '/meta/title' },
      ]),
    ).toThrow(DiagramPatchError);
    // 输入零变更（深拷贝上应用，失败即抛——原始对象连第一笔成功 op 也不应体现）
    expect(JSON.stringify(ir)).toBe(snapshot);
    expect(ir.components[0].label).toBe('Web Frontend');
  });

  it('成功路径返回新对象，输入不被改写', () => {
    const ir = makeIr();
    const out = applyDiagramPatch(ir, [
      { op: 'replace', path: '/components/0/label', value: 'CHANGED' },
    ]) as ReturnType<typeof makeIr>;
    expect(ir.components[0].label).toBe('Web Frontend');
    expect(out.components[0].label).toBe('CHANGED');
    expect(out).not.toBe(ir);
  });

  it('非对象基准 IR → 失败', () => {
    expect(() => applyDiagramPatch([1, 2], [{ op: 'add', path: '/0', value: 1 }])).toThrow(
      /must be a JSON object/,
    );
  });
});

/**
 * `resolveKeyScopes` / `hasScope` / `requiredScopeForMethod` 的判定矩阵单测
 * （2026-10-16 卡 72566c2e）。纯单测，不依赖 PG。
 *
 * 覆盖契约（docs/api-definition.md §2.1）：
 * - fail-closed：缺失 / 非对象 / 非数组 / 空数组 / 含未知值 → null
 * - write 不蕴含 read
 * - 方法映射：GET/HEAD → read；其余 → write；OPTIONS 是**唯一**放行分支
 */
import {
  hasScope,
  requiredScopeForMethod,
  resolveKeyScopes,
  type RequiredScopeVerdict,
} from './api-key-scope';

describe('resolveKeyScopes — fail-closed 收窄', () => {
  it('合法双权', () => {
    expect(resolveKeyScopes({ scopes: ['read', 'write'] })).toEqual(['read', 'write']);
  });

  it('只读', () => {
    expect(resolveKeyScopes({ scopes: ['read'] })).toEqual(['read']);
  });

  it('去重（同一 scope 写两次）', () => {
    expect(resolveKeyScopes({ scopes: ['read', 'read'] })).toEqual(['read']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空对象（scopes 缺失）', {}],
    ['scopes=null', { scopes: null }],
    ['scopes 是字符串（非数组）', { scopes: 'read' }],
    ['scopes 空数组', { scopes: [] }],
    ['含未知值', { scopes: ['read', 'admin'] }],
    ['全是未知值', { scopes: ['admin'] }],
    ['元素非字符串', { scopes: [1, 2] }],
    ['permissions 是数组', ['read']],
    ['permissions 是字符串', 'read'],
    ['scopes 是对象', { scopes: { read: true } }],
  ])('非法形态 → null：%s', (_label, input) => {
    expect(resolveKeyScopes(input)).toBeNull();
  });
});

describe('hasScope — write 不蕴含 read', () => {
  it('双权满足 read 与 write', () => {
    const scopes = resolveKeyScopes({ scopes: ['read', 'write'] });
    expect(hasScope(scopes, 'read')).toBe(true);
    expect(hasScope(scopes, 'write')).toBe(true);
  });

  it('只读满足 read，不满足 write', () => {
    const scopes = resolveKeyScopes({ scopes: ['read'] });
    expect(hasScope(scopes, 'read')).toBe(true);
    expect(hasScope(scopes, 'write')).toBe(false);
  });

  it('只写满足 write，不满足 read（写不蕴含读）', () => {
    const scopes = resolveKeyScopes({ scopes: ['write'] });
    expect(hasScope(scopes, 'write')).toBe(true);
    expect(hasScope(scopes, 'read')).toBe(false);
  });

  it('null（非法/缺失）恒不满足', () => {
    expect(hasScope(null, 'read')).toBe(false);
    expect(hasScope(null, 'write')).toBe(false);
  });
});

describe('requiredScopeForMethod — 唯一放行分支是 OPTIONS', () => {
  it.each(['get', 'GET', 'Get', 'HEAD', 'head'])('%s → read', (method) => {
    expect(requiredScopeForMethod(method)).toEqual({ required: 'read' });
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE', 'post', 'patch'])('%s → write', (method) => {
    expect(requiredScopeForMethod(method)).toEqual({ required: 'write' });
  });

  it('OPTIONS → 放行（required=null）', () => {
    const verdict = requiredScopeForMethod('OPTIONS') as RequiredScopeVerdict;
    expect(verdict.required).toBeNull();
  });

  it('未知/非常规方法不在放行集合内（一律回落 write，不漏判）', () => {
    for (const method of ['TRACE', 'CONNECT', 'PROPFIND', 'FOO', '']) {
      expect(requiredScopeForMethod(method)).toEqual({ required: 'write' });
    }
  });

  it('放行分支有且仅有 OPTIONS 一个', () => {
    const all = [
      'GET',
      'HEAD',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'OPTIONS',
      'TRACE',
      'CONNECT',
      'PROPFIND',
      '',
    ];
    const passthrough = all.filter((m) => requiredScopeForMethod(m).required === null);
    expect(passthrough).toEqual(['OPTIONS']);
  });
});

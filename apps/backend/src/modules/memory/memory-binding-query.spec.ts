/**
 * memory 绑定 containment 谓词的**逐字契约守卫**（阶段二抽 helper 时的搬迁保护）
 *
 * 覆盖：SQL 文本与参数名逐字不变（既有消费方 `memory-project.service.spec.ts` 的断言对象
 * 就是这两串 —— `'project.bindings @> :binding::jsonb'` / `':bindingType::jsonb'`）、
 * 参数值形状（`[{type,id}]` / `[{type}]`）、别名前缀参与拼接、两态分支互斥。
 *
 * 为什么必须有：铁律 #23（jsonb 嵌套对象等值永不命中）的**正确写法**只有这一份；
 * 抽 helper 时若文本走样（少个 `::jsonb`、参数名改了），真库上会静默地"永远查不到绑定"，
 * 而 mock 单测与类型系统都拦不住。真实命中由 `test/memory-nomination-hint.e2e-spec.ts`
 * 打真 PG 覆盖（本文件只管"发出去的 SQL 是不是那一句"）。
 */
import type { SelectQueryBuilder } from 'typeorm';
import { andWhereProjectBindingsContain } from './memory-binding-query';
import type { MemoryProject } from '../../database/entities/memory-project.entity';

/** 记录调用的假 QueryBuilder（只记 `andWhere` 的文本与参数） */
function makeQb() {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const qb = {
    andWhere: (sql: string, params: Record<string, unknown>) => {
      calls.push({ sql, params });
      return qb;
    },
  } as unknown as SelectQueryBuilder<MemoryProject>;
  return { qb, calls };
}

describe('andWhereProjectBindingsContain（绑定 containment 谓词单源）', () => {
  it('带 id：追加 `alias.bindings @> :binding::jsonb`，参数值 = [{type,id}] JSON', () => {
    const { qb, calls } = makeQb();

    andWhereProjectBindingsContain(qb, 'project', { type: 'board', id: 'board-1' });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('project.bindings @> :binding::jsonb');
    expect(calls[0].params).toEqual({
      binding: JSON.stringify([{ type: 'board', id: 'board-1' }]),
    });
  });

  it('不带 id：追加 `alias.bindings @> :bindingType::jsonb`，参数值 = [{type}] JSON', () => {
    const { qb, calls } = makeQb();

    andWhereProjectBindingsContain(qb, 'project', { type: 'topic' });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('project.bindings @> :bindingType::jsonb');
    expect(calls[0].params).toEqual({ bindingType: JSON.stringify([{ type: 'topic' }]) });
  });

  it('空串 id 视同未给（按类型反查）——与既有 `query.bindingId` 真值判据同义', () => {
    const { qb, calls } = makeQb();

    andWhereProjectBindingsContain(qb, 'project', { type: 'docSpace', id: '' });

    expect(calls[0].sql).toBe('project.bindings @> :bindingType::jsonb');
  });

  it('别名参与列前缀拼接（调用点各自命名，不写死 project）', () => {
    const { qb, calls } = makeQb();

    andWhereProjectBindingsContain(qb, 'p', { type: 'board', id: 'board-1' });

    expect(calls[0].sql).toBe('p.bindings @> :binding::jsonb');
  });
});

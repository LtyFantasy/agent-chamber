/**
 * `MemoryLedgerRepository` 单测（重放读取器）。
 *
 * 设计意图：`content` / `rationale` 在实体上是 `select: false`——**漏 addSelect 不报错**，
 * 只会静默返回 `undefined`（症状：重放把空正文发给引擎，而排障一路查网络）。故本 spec
 * 的**唯一核心断言**是"查询必带这两列"，其余（投影 / 判空）只是形状守卫。
 */
import type { Repository } from 'typeorm';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryLedgerRepository } from './ledger.repository';

/** 造一个链式 QueryBuilder 替身（只需 addSelect / where / getOne） */
function queryBuilderOf(row: Partial<MemoryNomination> | null) {
  return {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(row),
  };
}

function repositoryOf(qb: ReturnType<typeof queryBuilderOf>): Repository<MemoryNomination> {
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) } as unknown as Repository<MemoryNomination>;
}

describe('MemoryLedgerRepository.findForReplay', () => {
  it('**必带 addSelect(content, rationale)**（select:false 列漏取 = 静默空正文）', async () => {
    const qb = queryBuilderOf({
      id: 'led-1',
      projectId: 'prj-1',
      content: '冻结正文',
      rationale: '冻结理由',
      category: 'ruling',
    });
    const ledger = new MemoryLedgerRepository(repositoryOf(qb));
    await ledger.findForReplay('led-1');

    expect(qb.addSelect).toHaveBeenCalledTimes(1);
    expect(qb.addSelect).toHaveBeenCalledWith(['nomination.content', 'nomination.rationale']);
    expect(qb.where).toHaveBeenCalledWith('nomination.id = :id', { id: 'led-1' });
  });

  it('投影出重放所需列（content/rationale 必须真的带出来）', async () => {
    const qb = queryBuilderOf({
      id: 'led-1',
      projectId: 'prj-1',
      content: '冻结正文',
      rationale: '冻结理由',
      category: 'ruling',
    });
    const ledger = new MemoryLedgerRepository(repositoryOf(qb));

    await expect(ledger.findForReplay('led-1')).resolves.toEqual({
      id: 'led-1',
      projectId: 'prj-1',
      content: '冻结正文',
      rationale: '冻结理由',
      category: 'ruling',
    });
  });

  it('行不存在（或已软删）→ null（不抛：调用方据此走 404/跳过）', async () => {
    const qb = queryBuilderOf(null);
    const ledger = new MemoryLedgerRepository(repositoryOf(qb));
    await expect(ledger.findForReplay('led-missing')).resolves.toBeNull();
  });
});

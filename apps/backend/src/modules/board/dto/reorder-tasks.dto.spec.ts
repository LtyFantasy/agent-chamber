import 'reflect-metadata';
import { validate, ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ReorderTasksDto } from './reorder-tasks.dto';

/**
 * ReorderTasksDto 边界（F4-2 / V2-N2，复审 MINOR-2）
 *
 * **为什么必须有上界**：本端点每条 item 都要过一次「跨板取出门」（查该 item 当前列所属板），
 * 且逐条 `taskRepo.update(id, { listId })` 改写 list_id。无上界 = 单个请求可放大成任意多组
 * DB 查询 + 任意多行改写（跨板写族闭合引入的成本面）。上界取值 200 的取舍见 dto 内注释。
 *
 * 断言方式与 board/dto 既有 spec 同款：`plainToInstance` + `validate`（嵌套 DTO 必须
 * plainToInstance，否则子对象不会被实例化成 TaskOrderItem 而漏掉嵌套约束）。
 */
describe('ReorderTasksDto', () => {
  /** 递增计数器 → 合法 UUID（12 位 hex 尾段，格式 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx） */
  const validItem = (seq: number) => ({
    id: `550e8400-e29b-41d4-a716-${seq.toString(16).padStart(12, '0')}`,
    position: 0,
  });

  const makeDto = (tasks: unknown) => plainToInstance(ReorderTasksDto, { tasks });

  /**
   * 递归收集全部约束键。
   * 嵌套数组（`@ValidateNested({each:true})`）的 ValidationError 是**两层**结构
   * （外层 property='tasks' → children[索引] → children[子字段]），直接取
   * `children[0].constraints` 会落空，故统一递归。
   */
  const constraintKeys = (errors: ValidationError[]): string[] => {
    const out: string[] = [];
    const walk = (list: ValidationError[]) => {
      for (const e of list) {
        out.push(...Object.keys(e.constraints ?? {}));
        if (e.children?.length) walk(e.children);
      }
    };
    walk(errors);
    return out;
  };

  it('接受 200 条（恰好等于上界）', async () => {
    const dto = makeDto(Array.from({ length: 200 }, (_, i) => validItem(i + 1)));
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('拒绝 201 条（arrayMaxSize）', async () => {
    const dto = makeDto(Array.from({ length: 201 }, (_, i) => validItem(i + 1)));
    const errors = await validate(dto);
    expect(
      errors.some((e) => e.property === 'tasks' && e.constraints?.arrayMaxSize),
    ).toBe(true);
  });

  it('拒绝非数组', async () => {
    const dto = makeDto('not-an-array');
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tasks' && e.constraints?.isArray)).toBe(true);
  });

  it('子项 id 非 UUID → 嵌套约束命中', async () => {
    const dto = makeDto([{ id: 'not-a-uuid', position: 0 }]);
    const errors = await validate(dto);
    expect(constraintKeys(errors)).toContain('isUuid');
  });

  it('子项 position 为负 → 嵌套约束命中', async () => {
    const dto = makeDto([{ id: validItem(1).id, position: -1 }]);
    const errors = await validate(dto);
    expect(constraintKeys(errors)).toContain('min');
  });
});

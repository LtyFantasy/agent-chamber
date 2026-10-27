import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RecallMemoryDto } from './recall.dto';
import { MEMORY_CONTEXT_EPOCH_MAX } from '../memory.constants';

/**
 * `POST /memory/projects/:id/recalls` 请求 DTO 的**边界校验**单测（铁律 #21 双层校验第一层）。
 *
 * 为什么只测这里：召回 DTO 是"格式正确性"的唯一闸门——业务闸门（引擎可用性、项目读权限、
 * 来源过滤）归 `memory-recall.service`，各自有自己的套件。
 *
 * ⚠️ `contextEpoch` 的上限（1e9）**是平台主动保留的护栏，不是引擎当前的运行时限制**：
 * alpha.3 时代引擎会拒 `> 1e9`（schema 只声明了 `minimum: 0`，schema/运行时漂移已反馈 hument；
 * 边界二分实证 1e9 → 200、1e9+1 → 400 `invalid_argument`），但 **alpha.4 起引擎已放宽到 JS 安全
 * 整数（FEEDBACK-10 已修复）**。平台**仍**卡 1e9，因为 epoch 的语义是"同一 identity 下的第几轮"
 * （逻辑序号 / 相对纪元）——`Date.now()` 毫秒恒为误用。这几条用例守的是"绝对时间当 epoch 在
 * 边界层就被挡下"（护栏），而非"引擎会拒"。
 */
describe('RecallMemoryDto', () => {
  /** 造一个除 contextEpoch 外全部合法的载荷（其余字段的校验不在本套件范围内） */
  function dtoWith(overrides: Record<string, unknown> = {}) {
    return plainToInstance(RecallMemoryDto, {
      query: '权限前移到内容返回边界',
      contextIdentity: 'chamber-web-session',
      contextEpoch: 1,
      ...overrides,
    });
  }

  it('contextEpoch 边界：0 与 1e9 通过，1e9+1 拒绝（**平台护栏**；引擎 alpha.4 起已放宽）', async () => {
    for (const ok of [0, MEMORY_CONTEXT_EPOCH_MAX]) {
      expect(await validate(dtoWith({ contextEpoch: ok }))).toHaveLength(0);
    }

    const errors = await validate(dtoWith({ contextEpoch: MEMORY_CONTEXT_EPOCH_MAX + 1 }));
    expect(errors.some((e) => e.property === 'contextEpoch' && e.constraints?.max)).toBe(true);
  });

  it('contextEpoch 传 `Date.now()` 毫秒 ⇒ 400（护栏挡下"绝对时间当 epoch"这个恒错用法）', async () => {
    const errors = await validate(dtoWith({ contextEpoch: Date.now() }));

    expect(errors.some((e) => e.property === 'contextEpoch' && e.constraints?.max)).toBe(true);
  });

  it('contextEpoch 传 **Unix 秒**（`Date.now()/1000` ≈1.76e9）也 400——"改成秒"不是解', async () => {
    // 最容易踩的"修法"：以为改成秒就合规。绝对时间怎么切都超标，必须是相对纪元/自增序号。
    expect(Math.floor(Date.now() / 1000)).toBeGreaterThan(MEMORY_CONTEXT_EPOCH_MAX);
    const errors = await validate(dtoWith({ contextEpoch: Math.floor(Date.now() / 1000) }));

    expect(errors.some((e) => e.property === 'contextEpoch' && e.constraints?.max)).toBe(true);
  });

  it('contextEpoch 越界时的 message 给出下一步（点名毫秒时间戳 + 建议相对纪元）', async () => {
    const errors = await validate(dtoWith({ contextEpoch: Date.now() }));
    const message = errors.find((e) => e.property === 'contextEpoch')?.constraints?.max ?? '';

    expect(message).toContain('Date.now()');
    expect(message).toContain('relative epoch');
    expect(message).toContain(String(MEMORY_CONTEXT_EPOCH_MAX));
  });

  it('contextEpoch 负数拒绝（下限仍是 0——引擎合同与运行时一致的一侧）', async () => {
    const errors = await validate(dtoWith({ contextEpoch: -1 }));

    expect(errors.some((e) => e.property === 'contextEpoch' && e.constraints?.min)).toBe(true);
  });

  it('contextEpoch 非整数拒绝（不落到引擎的 invalid_argument）', async () => {
    const errors = await validate(dtoWith({ contextEpoch: 1.5 }));

    expect(errors.some((e) => e.property === 'contextEpoch' && e.constraints?.isInt)).toBe(true);
  });

  it('contextIdentity 空串拒绝（引擎 required 且不派生，见文件头不变量）', async () => {
    const errors = await validate(dtoWith({ contextIdentity: '' }));

    expect(errors.some((e) => e.property === 'contextIdentity')).toBe(true);
  });
});

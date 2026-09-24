/**
 * noop.judgment-provider 单测（provider=none 的关闭态实现）。
 *
 * 设计意图：noop 是判别服务的**关闭态**，它的正确形态是"调用点短路"——`enabled=false`
 * 让 service 不调用、不写日志、不占额度。这里钉死两条：① `name`/`enabled` 的关态语义
 * （与工厂分派、`experience_judgments.provider` 值域同源）；② **误调也不抛**——全 provider
 * 统一的"永不 throw"契约不能因为"理论不可达"就破坏。
 */
import { NoopJudgmentProvider } from './noop.judgment-provider';
import type { JudgmentOutcome } from './judgment-provider.interface';

describe('NoopJudgmentProvider（provider=none）', () => {
  it('enabled=false（调用点据此短路：不调用、不写日志、不占额度）', () => {
    const noop = new NoopJudgmentProvider();
    expect(noop.enabled).toBe(false);
    expect(noop.name).toBe('none');
  });

  it('误调 checkEntry 也不抛（保持"永不 throw"契约）', async () => {
    const outcome: JudgmentOutcome = await new NoopJudgmentProvider().checkEntry();
    expect(outcome.status).toBe('error');
  });
});

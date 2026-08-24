import * as os from 'node:os';
import * as path from 'node:path';
import { LEGACY_DEFAULT_STATE_DIR, resolveStateDir } from './state-dir';

describe('resolveStateDir（r25 R3：裸 CLI stateDir 按 runner 名派生）', () => {
  const home = os.homedir();

  it('显式 --state-dir 最优先，不触发旧目录探测', () => {
    const legacyExists = jest.fn(() => true);

    const { stateDir, usedLegacyDefault } = resolveStateDir(
      'runner-a',
      '/tmp/explicit-state',
      legacyExists,
    );

    expect(stateDir).toBe('/tmp/explicit-state');
    expect(usedLegacyDefault).toBe(false);
    // 显式传参路径不需要探测旧目录
    expect(legacyExists).not.toHaveBeenCalled();
  });

  it('裸 CLI 按 runner 名派生 ~/.roundtable-runner-<name>', () => {
    const { stateDir, usedLegacyDefault } = resolveStateDir('runner-a', undefined);

    expect(stateDir).toBe(path.join(home, '.roundtable-runner-runner-a'));
    expect(usedLegacyDefault).toBe(false);
  });

  it('runner 名中的 `/` 全部替换为 `-`（与 install-runner.sh ${RUNNER_NAME//\\//-} 同规则）', () => {
    const { stateDir } = resolveStateDir('team/a/b', undefined);

    expect(stateDir).toBe(path.join(home, '.roundtable-runner-team-a-b'));
    expect(stateDir.includes('/a/')).toBe(false);
  });

  it('多级斜杠连续替换不留空段', () => {
    const { stateDir } = resolveStateDir('org//team/', undefined);

    expect(stateDir).toBe(path.join(home, '.roundtable-runner-org--team-'));
  });

  it('旧默认目录存在 → usedLegacyDefault=true（cli 层据此打 mv 迁移 warn）', () => {
    const { stateDir, usedLegacyDefault } = resolveStateDir('runner-a', undefined, () => true);

    expect(stateDir).toBe(path.join(home, '.roundtable-runner-runner-a'));
    expect(usedLegacyDefault).toBe(true);
  });

  it('LEGACY_DEFAULT_STATE_DIR 指向旧固定缺省 ~/.roundtable-runner', () => {
    expect(LEGACY_DEFAULT_STATE_DIR).toBe(path.join(home, '.roundtable-runner'));
  });
});

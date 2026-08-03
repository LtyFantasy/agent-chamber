/**
 * database.config 单元测试（A5：DB_NAME / DB_DATABASE 键名 fallback）
 *
 * 背景：.env.example 历史键名为 DB_DATABASE，代码原仅读 DB_NAME，
 * 靠默认值巧合跑通。统一为 DB_NAME 优先、DB_DATABASE fallback、双缺省回退默认值。
 */

import databaseConfig from './database.config';

describe('databaseConfig', () => {
  // registerAs 返回的 ConfigFactory 可直接调用得到配置对象
  const factory = databaseConfig as unknown as () => { database: string };

  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // 恢复环境变量，避免污染其他测试
    process.env = { ...ORIGINAL_ENV };
  });

  it('DB_NAME 设置时优先使用', () => {
    process.env.DB_NAME = 'db_from_name';
    process.env.DB_DATABASE = 'db_from_database';

    expect(factory().database).toBe('db_from_name');
  });

  it('仅 DB_DATABASE 设置时 fallback 到它（.env.example 历史键名）', () => {
    delete process.env.DB_NAME;
    process.env.DB_DATABASE = 'db_from_database';

    expect(factory().database).toBe('db_from_database');
  });

  it('两者都未设置时回退默认值 agent_chamber', () => {
    delete process.env.DB_NAME;
    delete process.env.DB_DATABASE;

    expect(factory().database).toBe('agent_chamber');
  });
});

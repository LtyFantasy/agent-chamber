/**
 * HealthController 单元测试（铁律 #17：新增观测字段必须同步测试覆盖）
 *
 * 覆盖点：
 * - 存活探针基础字段（status/timestamp/uptime）不回归
 * - version 来自 monorepo 根 package.json（子包 version 恒 1.0.0，是错误来源）
 * - commit：GIT_SHA 环境变量优先；无 GIT_SHA 时回退 git rev-parse（无 .git 环境则省略）
 */
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller';

/** 读取 monorepo 根 package.json 的 version（本文件位于 apps/backend/src/health/，向上 4 级为根） */
function rootPackageVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../../../package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

describe('HealthController', () => {
  /** DataSource 仅 readiness 使用，存活探针不触达，给最小桩即可 */
  const mockDataSource = { query: jest.fn() } as unknown as DataSource;

  /** GIT_SHA 环境变量隔离：每个用例前后清理，避免污染版本解析序 */
  const ORIGINAL_GIT_SHA = process.env.GIT_SHA;
  afterEach(() => {
    if (ORIGINAL_GIT_SHA === undefined) {
      delete process.env.GIT_SHA;
    } else {
      process.env.GIT_SHA = ORIGINAL_GIT_SHA;
    }
  });

  describe('check（存活探针）', () => {
    it('返回 status/timestamp/uptime 基础字段', () => {
      const controller = new HealthController(mockDataSource);
      const res = controller.check();
      expect(res.status).toBe('ok');
      expect(typeof res.timestamp).toBe('string');
      expect(typeof res.uptime).toBe('number');
    });

    it('version 等于 monorepo 根 package.json 的 version（而非子包 1.0.0）', () => {
      const controller = new HealthController(mockDataSource);
      const res = controller.check();
      expect(res.version).toBe(rootPackageVersion());
      expect(res.version).not.toBe('1.0.0');
      expect(res.version).not.toBe('unknown');
    });

    it('GIT_SHA 环境变量优先于 git rev-parse', () => {
      process.env.GIT_SHA = 'testsha123';
      const controller = new HealthController(mockDataSource);
      expect(controller.check().commit).toBe('testsha123');
    });

    it('无 GIT_SHA 时回退 git rev-parse（有 .git）或省略字段（无 .git）', () => {
      delete process.env.GIT_SHA;
      const controller = new HealthController(mockDataSource);
      const commit = controller.check().commit;
      // 开发/CI 环境有 .git → short SHA；docker 运行镜像无 .git → undefined。两种均合法
      if (commit !== undefined) {
        expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
      }
    });
  });
});

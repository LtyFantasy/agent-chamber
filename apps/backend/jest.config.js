module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // M1 圆桌：roundtable-protocol 契约包直读源码（ts-jest 不解析 tsconfig paths，
  // 显式映射；@agent-chamber/shared 走 node_modules 符号链接 + dist，照旧不动）
  moduleNameMapper: {
    '^@agent-chamber/roundtable-protocol$':
      '<rootDir>/../../../packages/roundtable-protocol/src/index.ts',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  // 内存安全硬约束（2026-10-13 两次 OOM 崩机教训：jest 默认 min(cpus-1) workers，
  // 每个 worker 独立拉起 NestJS 全挂载数百 MB，多核机直接打爆内存）。
  // 默认 2 workers + worker 闲置内存超阈自动回收；要更快用 JEST_MAX_WORKERS=8
  // 或 CLI --maxWorkers=N 显式覆盖（CLI 优先于本配置）。
  maxWorkers: process.env.JEST_MAX_WORKERS ? Number(process.env.JEST_MAX_WORKERS) : 2,
  workerIdleMemoryLimit: '1.5GB',
};

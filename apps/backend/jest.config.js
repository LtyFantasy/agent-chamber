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
};

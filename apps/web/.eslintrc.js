const path = require('path');
const rulesDirPlugin = require('eslint-plugin-rulesdir');
// 规则单源化（review-0831 任务 8b57f5a5）：与 backend 共用 monorepo 根 eslint-rules/
rulesDirPlugin.RULES_DIR = path.resolve(__dirname, '../../eslint-rules');

module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'unused-imports', 'rulesdir'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  ignorePatterns: ['.eslintrc.js', '.next/', 'dist/', 'node_modules/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'unused-imports/no-unused-imports': 'warn',
    '@typescript-eslint/no-empty-object-type': 'off',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/return-await': 'error',
    'no-console': ['error', { allow: ['error', 'warn'] }],
    'react-hooks/exhaustive-deps': 'warn',
    'react-hooks/rules-of-hooks': 'error',
    'rulesdir/no-magic-string-compare': 'error',
  },
  overrides: [
    {
      // 测试文件豁免：测试中常需直接比较字符串（与 backend *.spec.ts 豁免同口径）
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: {
        'rulesdir/no-magic-string-compare': 'off',
      },
    },
  ],
};

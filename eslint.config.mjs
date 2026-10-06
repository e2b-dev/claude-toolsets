import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['packages/claude-toolsets-runtime/src/**/*.ts', 'packages/claude-toolsets-js/src/page-scripts.ts'],
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  languageOptions: {
    parserOptions: {
      project: ['./packages/claude-toolsets-runtime/tsconfig.json', './tsconfig.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    curly: ['error', 'all'],
    'one-var': ['error', 'never'],
    'no-sequences': 'error',
    'no-nested-ternary': 'error',
    'padding-line-between-statements': [
      'error',
      { blankLine: 'always', prev: '*', next: 'export' },
      { blankLine: 'always', prev: '*', next: 'function' },
      { blankLine: 'always', prev: 'function', next: '*' },
    ],
    'id-length': ['error', { min: 2, exceptions: ['x', 'y'], properties: 'never' }],
    eqeqeq: ['error', 'smart'],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
  },
});

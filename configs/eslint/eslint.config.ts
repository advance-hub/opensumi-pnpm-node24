import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import-x';
import jest from 'eslint-plugin-jest';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import classnamesImportRule from '../../scripts/eslint-rules/rules/classnames-import-rule.ts';

const sourceFiles = ['**/*.{js,jsx,ts,tsx}'];
const testFiles = ['**/__test?(s)__/**/*.{js,jsx,ts,tsx}', '**/*.{spec,test}.{js,jsx,ts,tsx}'];

export default defineConfig([
  globalIgnores([
    'node_modules/**',
    'tmp/**',
    '**/coverage/**',
    '**/dist/**',
    '**/dist-node/**',
    '**/lib/**',
    'packages/process/scripts/**',
    'tools/electron/scripts/**',
    '**/tools/workspace/**',
    '**/tools/extensions/**',
    '**/tools/**/vendor/**',
    '**/tools/electron/app/dist/**',
    '**/tools/playwright/src/tests/workspaces/**',
    'tools/cli-engine/src/browser/worker-host.js',
    'packages/monaco/worker/**',
    '**/typings/**',
    'packages/components/src/icon/iconfont/**',
    'packages/core-browser/src/style/octicons/**',
    'packages/extension/__mocks__/extension/browser-new.js',
    'packages/extension/__mocks__/extension/browser.js',
    'packages/extension/__mocks__/extension-error/browser.js',
    '__mocks__/**',
  ]),
  {
    name: 'opensumi/source',
    files: sourceFiles,
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      importPlugin.flatConfigs.recommended,
      eslintConfigPrettier,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.jest,
        ...globals.node,
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    plugins: {
      opensumi: {
        rules: {
          'classnames-import': classnamesImportRule,
        },
      },
      'unused-imports': unusedImports,
    },
    settings: {
      'import-x/extensions': ['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.cjs', '.mjs'],
      'import-x/internal-regex': '^@opensumi/',
      'import-x/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx', '.cts', '.mts'],
      },
    },
    rules: {
      '@typescript-eslint/adjacent-overload-signatures': 'error',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/consistent-type-assertions': 'error',
      '@typescript-eslint/consistent-type-definitions': 'error',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/member-ordering': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-parameter-properties': 'off',
      '@typescript-eslint/no-shadow': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/prefer-for-of': 'error',
      '@typescript-eslint/prefer-function-type': 'error',
      '@typescript-eslint/prefer-namespace-keyword': 'error',
      '@typescript-eslint/triple-slash-reference': [
        'error',
        {
          lib: 'always',
          path: 'always',
          types: 'prefer-import',
        },
      ],
      '@typescript-eslint/unified-signatures': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      'arrow-body-style': 'error',
      'arrow-parens': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      complexity: 'off',
      curly: 'error',
      'eol-last': 'error',
      eqeqeq: ['error', 'smart'],
      'guard-for-in': 'error',
      'max-classes-per-file': 'off',
      'max-len': 'off',
      'new-parens': 'error',
      'no-bitwise': 'off',
      'no-caller': 'error',
      'no-cond-assign': 'off',
      'no-console': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-debugger': 'error',
      'no-empty': 'off',
      'no-eval': 'off',
      'no-fallthrough': 'off',
      'no-inner-declarations': 'off',
      'no-irregular-whitespace': ['error', { skipComments: true }],
      'no-multiple-empty-lines': 'error',
      'no-new-wrappers': 'error',
      'no-prototype-builtins': 'warn',
      'no-trailing-spaces': 'error',
      'no-undef': 'off',
      'no-undef-init': 'error',
      'no-unsafe-finally': 'error',
      'no-unused-labels': 'error',
      'no-useless-catch': 'warn',
      'no-useless-escape': 'warn',
      'no-async-promise-executor': 'warn',
      'object-shorthand': 'error',
      'one-var': ['error', 'never'],
      'prefer-const': 'warn',
      'prefer-rest-params': 'warn',
      'quote-props': 'off',
      quotes: ['error', 'single', { avoidEscape: true }],
      radix: 'error',
      semi: ['error', 'always'],
      'sort-imports': ['error', { ignoreDeclarationSort: true }],
      'spaced-comment': ['error', 'always', { markers: ['/'] }],
      'use-isnan': 'error',
      'valid-typeof': 'off',
      'unused-imports/no-unused-imports': 'warn',
      'import-x/default': 'off',
      'import-x/export': 'off',
      'import-x/named': 'off',
      'import-x/namespace': 'off',
      'import-x/no-named-as-default-member': 'off',
      'import-x/no-relative-packages': 'warn',
      'import-x/no-unresolved': 'off',
      'import-x/order': [
        'error',
        {
          alphabetize: { caseInsensitive: true, order: 'asc' },
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type', 'unknown'],
          'newlines-between': 'always',
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              from: './packages/**/*/node/**/*',
              message: '`browser` should not import the `node` modules',
              target: './packages/**/*/!(__tests__)/browser/**/*',
            },
            {
              from: './packages/**/*/browser/**/*',
              message: '`node` should not import the `browser` modules',
              target: './packages/**/*/!(__tests__)/node/**/*',
            },
            {
              from: './packages/**/*/node/**/*',
              message: '`common` should not import the `node` modules',
              target: './packages/**/*/!(__tests__)/common/**/*',
            },
            {
              from: './packages/**/*/browser/**/*',
              message: '`common` should not import the `browser` modules',
              target: './packages/**/*/!(__tests__)/common/**/*',
            },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              message: 'please re-export the reference you want from `monaco-editor` in the `ide-monaco` package.',
              name: '@opensumi/monaco-editor-core/esm/vs/editor/editor.api',
            },
          ],
          patterns: [
            {
              group: ['@opensumi/*/src/**/*', '!@opensumi/ide-dev-tool/src/**/*'],
              message: "please import from 'esm' or 'lib' instead of 'src'.",
            },
          ],
        },
      ],
      'opensumi/classnames-import': 'error',
    },
  },
  {
    name: 'opensumi/client-type-imports',
    files: ['client/**/*.ts', 'client/**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'separate-type-imports',
          prefer: 'type-imports',
        },
      ],
    },
  },
  {
    name: 'opensumi/tests',
    files: testFiles,
    extends: [jest.configs['flat/recommended']],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'jest/no-conditional-expect': 'warn',
      'jest/no-done-callback': 'warn',
      'jest/no-export': 'warn',
      'jest/no-mocks-import': 'warn',
      'jest/no-standalone-expect': 'warn',
      'jest/prefer-expect-assertions': 'warn',
      'jest/valid-title': 'warn',
      'no-console': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    name: 'opensumi/scripts',
    files: ['scripts/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'import-x/no-relative-packages': 'off',
      'no-console': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    name: 'opensumi/cli-output',
    files: ['tools/**/cli/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    name: 'opensumi/synchronous-platform-layout-loading',
    files: ['packages/core-browser/src/keyboard/layouts/layout.contribution.{darwin,linux,win}.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    name: 'opensumi/commonjs-boundaries',
    files: ['**/*.{cjs,js}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]);

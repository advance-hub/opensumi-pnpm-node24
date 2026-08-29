import fs from 'node:fs';
import path from 'node:path';

import { pathsToModuleNameMapper } from 'ts-jest';

import type { Config } from 'jest';

const repoRoot = process.cwd();
const tsconfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'configs/ts/tsconfig.resolve.json'), 'utf8')) as {
  compilerOptions: {
    paths: Record<string, string[]>;
  };
};

const tsModuleNameMapper = pathsToModuleNameMapper(tsconfig.compilerOptions.paths, { prefix: '<rootDir>/configs/' });

const baseConfig: Config = {
  rootDir: repoRoot,
  preset: 'ts-jest',
  resolver: '<rootDir>/tools/dev-tool/src/jest-resolver.js',
  maxWorkers: 2,
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/**/*.contribution.ts',
    // 部分contribution文件为-contribution结尾
    '!packages/**/*-contribution.ts',
    '!packages/startup/**/*.ts',
    // Test, Notebook 模块暂不覆盖
    '!packages/testing/**/*.ts',
    '!packages/notebook/**/*.ts',
    // CLI 不需要测试
    '!packages/remote-cli/**/*.ts',
    '!packages/core-electron-main/**/*.ts',
    '!packages/*/src/electron-main/**/*.ts',
  ],
  moduleNameMapper: {
    ...tsModuleNameMapper,
    '^file-type$': '<rootDir>/tools/dev-tool/src/jest-file-type.js',
    '^vscode-languageserver-types$': '<rootDir>/node_modules/vscode-languageserver-types/lib/umd/main.js',
    '^ws$': '<rootDir>/node_modules/ws/index.js',
    '.*\\.(css|less)$': '<rootDir>/tools/dev-tool/src/mock-exports.js',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/configs/jest/tsconfig.json',
      },
    ],
  },
  testPathIgnorePatterns: [
    '/dist/',
    '/node_modules/',
    '/tools/workspace/',
    '/tools/template/',
    '/tools/extensions/',
    '/packages/status-bar/entry',
    '/packages/startup/entry',
    '/__mocks__/',
    '/packages/quick-open/entry',
    // 终端渲染测试暂时不跟随单元测试
    '/packages/terminal-next/__tests__/browser/render.test.ts',
  ],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/tools/workspace/'],
  coveragePathIgnorePatterns: [
    '/dist/',
    '/node_modules/',
    '/mocks/',
    '/tools/template/',
    '/tools/workspace/',
    '/packages/startup/entry',
  ],
  coverageThreshold: {
    global: {
      branches: 0,
      functions: 0,
      lines: 0,
      statements: 0,
    },
  },
};

const coverageProvider = process.env.JEST_COVERAGE_PROVIDER;
if (coverageProvider === 'babel' || coverageProvider === 'v8') {
  baseConfig.coverageProvider = coverageProvider;
}

const config: Config = {
  ...baseConfig,
  coverageReporters: ['json', 'clover'],
  projects: [
    {
      ...baseConfig,
      displayName: 'node',
      testEnvironment: 'node',
      setupFiles: ['<rootDir>/configs/jest/setup-node.ts'],
      testMatch: [
        // 有个 webview 的 case 应该放在 electron 下测，也会被第一条规则匹配到
        // - packages/webview/__tests__/webview/webview.channel.test.ts
        '**/packages/*/__test?(s)__/!(browser)/**/?(*.)+(spec|test).[jt]s?(x)',
        '**/packages/{core-common,core-electron-main,core-node,utils,i18n}/__tests__/**/?(*.)+(spec|test).[jt]s?(x)',
        // exclude 的要放最后
        '!**/packages/{components,core-browser}/__tests__/**',
        '!**/packages/extension/__tests__/{hosted,common}/**',
      ],
    },
    {
      ...baseConfig,
      displayName: 'jsdom',
      testEnvironment: 'jsdom',
      testEnvironmentOptions: {
        html: `<html>
        <body>
          <div id="main"></div>
        </body>
        </html>`,
        runScripts: 'dangerously',
        url: 'http://localhost/?id=1',
        userAgent: `Mozilla/5.0 (${
          process.platform === 'darwin' ? 'Macintosh' : process.platform === 'win32' ? 'Windows' : 'Linux'
        }) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/v16.7.0`,
      },
      setupFiles: ['<rootDir>/configs/jest/setup-jsdom.ts'],
      testMatch: [
        '**/packages/*/__test?(s)__/browser/**/?(*.)+(spec|test).[jt]s?(x)',
        '**/packages/*/__test?(s)__/common/**/?(*.)+(spec|test).[jt]s?(x)',
        '**/tools/*/__tests__/**/?(*.)+(spec|test).[jt]s?(x)',
        '**/packages/extension/__tests__/{hosted,common}/**/?(*.)+(spec|test).[jt]s?(x)',
        '**/packages/{components,core-browser,core-common,electron-basic}/__tests__/**/?(*.)+(spec|test).[jt]s?(x)',
      ],
      transformIgnorePatterns: ['/node_modules/(?!(?:@opensumi/monaco-editor-core|nanoid)/)'],
      transform: {
        ...baseConfig.transform,
        '^.+\\.(js)$': [
          'ts-jest',
          {
            isolatedModules: true,
            tsconfig: {
              allowJs: true,
              module: 'NodeNext',
              moduleResolution: 'node',
              esModuleInterop: true,
              skipLibCheck: true,
            },
          },
        ],
      },
    },
  ],
};

export default config;

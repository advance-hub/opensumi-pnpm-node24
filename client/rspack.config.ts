import path from 'node:path';

import { rspack } from '@rspack/core';
import fse from 'fs-extra';
import less from 'less';

import type { Configuration, RuleSetRule } from '@rspack/core';

const clientDirectory = import.meta.dirname;
const repoRoot = path.resolve(clientDirectory, '..');
const sourceMode = process.env.OPENSUMI_SOURCE_MODE === '1';
const tsconfigPath = sourceMode
  ? path.join(repoRoot, 'configs/ts/tsconfig.resolve.json')
  : path.join(clientDirectory, 'tsconfig.rspack.json');
const outputPath = path.join(clientDirectory, 'dist');
const templatePath = path.join(repoRoot, 'tools/dev-tool/src/index.html');
const defaultWorkspace = path.join(repoRoot, 'tools/workspace');
const clientSourcePath = path.join(clientDirectory, 'src');
const notebookModulePath = path.join(repoRoot, 'packages/notebook');
const isProduction = process.env.NODE_ENV === 'production';
const sourceMapEnabled = process.env.SOURCE_MAP === '1';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.IDE_FRONT_PORT || 8080);
const withSlash = process.platform === 'win32' ? '/' : '';

fse.mkdirpSync(defaultWorkspace);

const styleLoader = isProduction ? rspack.CssExtractRspackPlugin.loader : 'style-loader';

function createWorkspacePackageAliases(): Record<string, string> {
  if (sourceMode) {
    return {};
  }

  const packagesDirectory = path.join(repoRoot, 'packages');
  return Object.fromEntries(
    fse
      .readdirSync(packagesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesDirectory, entry.name))
      .map((packageDirectory) => {
        const packageJsonPath = path.join(packageDirectory, 'package.json');
        if (!fse.existsSync(packageJsonPath)) {
          return undefined;
        }
        const packageJson = fse.readJsonSync(packageJsonPath) as { name?: unknown };
        return typeof packageJson.name === 'string' && packageJson.name.startsWith('@opensumi/')
          ? [packageJson.name, packageDirectory]
          : undefined;
      })
      .filter((entry): entry is [string, string] => Boolean(entry)),
  );
}

const workspacePackageAliases = createWorkspacePackageAliases();

function createSwcRule(): RuleSetRule {
  return {
    test: /\.tsx?$/,
    include: clientSourcePath,
    use: {
      loader: 'builtin:swc-loader',
      options: {
        detectSyntax: 'auto',
        collectTypeScriptInfo: {
          typeExports: true,
          exportedEnum: 'const-only',
        },
        jsc: {
          parser: {
            syntax: 'typescript',
            tsx: true,
            decorators: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
            react: {
              runtime: 'classic',
              development: !isProduction,
              refresh: false,
            },
          },
          target: 'es2018',
          keepClassNames: true,
        },
        module: {
          type: 'es6',
        },
      },
    },
  };
}

function createTypeScriptRule(include?: string, compilerOptions: Record<string, unknown> = {}): RuleSetRule {
  return {
    test: /\.tsx?$/,
    ...(include ? { include } : { exclude: [clientSourcePath, notebookModulePath] }),
    use: {
      loader: 'ts-loader',
      options: {
        happyPackMode: true,
        transpileOnly: true,
        onlyCompileBundledFiles: true,
        configFile: tsconfigPath,
        compilerOptions: {
          target: 'es2018',
          sourceMap: sourceMapEnabled,
          ...compilerOptions,
        },
      },
    },
  };
}

const config: Configuration = {
  context: repoRoot,
  entry: path.join(clientDirectory, 'src/main.tsx'),
  target: ['web', 'es2018'],
  mode: isProduction ? 'production' : 'development',
  bail: process.env.RSPACK_STATS !== 'verbose',
  // Source maps materially increase the resident set of this large IDE graph.
  // Keep the low-memory profile as the default and make maps an explicit opt-in.
  devtool: sourceMapEnabled ? (isProduction ? 'source-map' : 'cheap-module-source-map') : false,
  cache:
    process.env.RSPACK_CACHE === '0'
      ? false
      : {
          type: 'persistent',
        },
  node: {
    // process.ts only probes this value to detect Node/CJS output. Keeping it
    // undefined in the browser avoids Rspack's compatibility mock and warning.
    __filename: false,
    __dirname: false,
  },
  experiments: {
    asyncWebAssembly: true,
    css: false,
  },
  output: {
    filename: 'bundle.js',
    chunkFilename: '[name].[contenthash:8].js',
    path: outputPath,
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    extensionAlias: {
      // Prefer published JavaScript when a dependency ships both .js and its
      // TypeScript source (for example ansi_up). Source-only .js specifiers
      // still fall back to the matching .ts/.tsx file.
      '.js': ['.js', '.ts', '.tsx'],
    },
    // The default profile consumes each workspace package's precompiled lib.
    // Mapping every @opensumi import to packages/*/src makes Rspack retain the
    // full framework TypeScript graph. Source mode is still available when a
    // framework package itself needs browser-side HMR.
    ...(sourceMode
      ? {
          tsConfig: {
            configFile: tsconfigPath,
          },
        }
      : {}),
    // Keep Node's normal ancestor lookup first so pnpm can select nested
    // transitive versions. The client workspace is the final fallback for
    // self-references in emitted styles such as @opensumi/ide-core-browser.
    modules: ['node_modules', path.join(clientDirectory, 'node_modules')],
    alias: {
      ...workspacePackageAliases,
      react: path.join(repoRoot, 'node_modules/react'),
      'react-dom': path.join(repoRoot, 'node_modules/react-dom'),
    },
    fallback: {
      buffer: require.resolve('buffer/'),
      process: require.resolve('process/browser.js'),
      net: false,
      path: false,
      os: false,
      crypto: false,
      child_process: false,
      url: false,
      fs: false,
      stream: false,
    },
  },
  module: {
    rules: [
      // Product-entry code uses Rspack's fast built-in SWC path.
      createSwcRule(),
      // Framework sources need TypeScript's type analysis to emit correct
      // decorator metadata. An all-SWC build treats erased interfaces as
      // runtime imports and currently fails module linking.
      createTypeScriptRule(notebookModulePath, {
        module: 'esnext',
        moduleResolution: 'bundler',
      }),
      createTypeScriptRule(),
      {
        test: /\.png$/,
        type: 'asset/resource',
      },
      {
        test: /\.css$/,
        type: 'javascript/auto',
        use: [styleLoader, 'css-loader'],
      },
      {
        test: /\.module\.less$/,
        type: 'javascript/auto',
        use: [
          styleLoader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
              sourceMap: sourceMapEnabled,
              // Framework sources are still transpiled to CommonJS, so expose
              // the CSS module object with matching interop semantics.
              esModule: false,
              modules: {
                localIdentName: '[local]___[hash:base64:5]',
                // css-loader 7 otherwise camel-cases keys such as
                // `mod_selected`; existing styles access the literal name.
                exportLocalsConvention: 'as-is',
              },
            },
          },
          {
            loader: 'less-loader',
            options: {
              implementation: less,
              lessOptions: {
                javascriptEnabled: true,
              },
            },
          },
        ],
      },
      {
        test: /^((?!\.module).)*less$/,
        type: 'javascript/auto',
        use: [
          styleLoader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
            },
          },
          {
            loader: 'less-loader',
            options: {
              implementation: less,
              lessOptions: {
                javascriptEnabled: true,
              },
            },
          },
        ],
      },
      {
        test: /\.svg$/,
        type: 'asset/resource',
        generator: {
          filename: 'images/[name][ext][query]',
        },
      },
      {
        test: /\.(woff(2)?|ttf|eot)(\?v=\d+\.\d+\.\d+)?$/,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name][hash:8][ext][query]',
        },
      },
    ],
  },
  optimization: {
    nodeEnv: isProduction ? 'production' : 'development',
    minimize: isProduction,
  },
  plugins: [
    new rspack.HtmlRspackPlugin({
      template: templatePath,
    }),
    isProduction &&
      new rspack.CssExtractRspackPlugin({
        filename: '[name].[contenthash:8].css',
        chunkFilename: '[name].[contenthash:8].css',
      }),
    new rspack.DefinePlugin({
      'process.env.IS_DEV': JSON.stringify(isProduction ? 0 : 1),
      'process.env.ENABLE_AI': JSON.stringify(process.env.ENABLE_AI === '1' ? '1' : '0'),
      'process.env.ENABLE_NOTEBOOK': JSON.stringify(process.env.ENABLE_NOTEBOOK === '1' ? '1' : '0'),
      'process.env.ENABLE_COLLABORATION': JSON.stringify(process.env.ENABLE_COLLABORATION === '1' ? '1' : '0'),
      'process.env.COLLABORATION_PORT': JSON.stringify(process.env.COLLABORATION_PORT || '12345'),
      'process.env.NOTEBOOK_SERVER_HOST': JSON.stringify(process.env.NOTEBOOK_SERVER_HOST || 'localhost:8888'),
      'process.env.WORKSPACE_DIR': JSON.stringify(process.env.MY_WORKSPACE || defaultWorkspace),
      'process.env.SUPPORT_LOAD_WORKSPACE_BY_HASH': JSON.stringify(process.env.SUPPORT_LOAD_WORKSPACE_BY_HASH),
      'process.env.OPENSUMI_E2E_COMMANDS': JSON.stringify(process.env.OPENSUMI_E2E_COMMANDS),
      'process.env.EXTENSION_DIR': JSON.stringify(path.join(repoRoot, 'tools/extensions')),
      'process.env.KTLOG_SHOW_DEBUG': JSON.stringify(process.env.KTLOG_SHOW_DEBUG || '0'),
      'process.env.OTHER_EXTENSION_DIR': JSON.stringify(path.join(repoRoot, 'other')),
      'process.env.EXTENSION_WORKER_HOST': JSON.stringify(
        process.env.EXTENSION_WORKER_HOST ||
          `http://${host}:${port}/assets${withSlash}${path.join(repoRoot, 'packages/extension/lib/worker-host.js')}`,
      ),
      'process.env.WS_PATH': JSON.stringify(process.env.WS_PATH || `ws://${host}:8000`),
      'process.env.WEBVIEW_HOST': JSON.stringify(process.env.WEBVIEW_HOST || host),
      'process.env.STATIC_SERVER_PATH': JSON.stringify(process.env.STATIC_SERVER_PATH || `http://${host}:8000/`),
      'process.env.HOST': JSON.stringify(process.env.HOST),
    }),
    new rspack.ProvidePlugin({
      process: 'process/browser.js',
      Buffer: ['buffer', 'Buffer'],
    }),
  ].filter(Boolean),
  performance: {
    hints: false,
  },
  stats:
    process.env.RSPACK_STATS === 'verbose'
      ? {
          preset: 'normal',
          errorDetails: true,
        }
      : 'errors-warnings',
  devServer: {
    static: {
      directory: outputPath,
    },
    host,
    port,
    allowedHosts: 'all',
    devMiddleware: {
      stats: 'errors-only',
    },
    proxy: [
      {
        context: ['/api', '/extension', '/assets', '/kaitian'],
        target: `http://${host}:8000`,
        changeOrigin: true,
      },
    ],
    open: Boolean(process.env.SUMI_DEV_OPEN_BROWSER),
    hot: true,
    client: {
      overlay: {
        errors: true,
        warnings: false,
        runtimeErrors: false,
      },
    },
  },
};

export default config;

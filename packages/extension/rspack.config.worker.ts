import { createRequire } from 'node:module';
import path from 'node:path';

import { rspack } from '@rspack/core';

import type { Configuration } from '@rspack/core';

const require = createRequire(import.meta.url);
const extensionDirectory = import.meta.dirname;
const repoRoot = path.resolve(extensionDirectory, '../..');
const tsconfigPath = path.join(repoRoot, 'configs/ts/references/tsconfig.extension.json');

const config: Configuration = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  entry: path.join(extensionDirectory, 'src/hosted/worker.host-preload.ts'),
  target: 'webworker',
  node: {
    // The worker only feature-detects this free variable. Do not inject a
    // synthetic Node filename into a browser worker.
    __filename: false,
  },
  devtool: false,
  cache: {
    type: 'persistent',
  },
  output: {
    publicPath: '',
    filename: 'worker-host.js',
    path: path.join(extensionDirectory, 'lib'),
  },
  optimization: {
    minimize: false,
  },
  performance: {
    hints: false,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
    fallback: {
      buffer: require.resolve('buffer/'),
      process: require.resolve('process/browser.js'),
      net: false,
      path: false,
      os: false,
      crypto: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          configFile: tsconfigPath,
          happyPackMode: true,
          onlyCompileBundledFiles: true,
          transpileOnly: true,
        },
      },
      {
        // The extension worker has no DOM. Keep the old worker-build contract:
        // style side effects must not be evaluated or emitted into the bundle.
        test: /\.(?:css|less)$/,
        loader: 'null-loader',
      },
    ],
  },
  plugins: [
    process.env.RSPACK_PROGRESS === '1' && new rspack.ProgressPlugin(),
    new rspack.ProvidePlugin({
      process: 'process/browser.js',
      Buffer: ['buffer', 'Buffer'],
    }),
  ].filter(Boolean),
  stats: process.env.RSPACK_STATS === 'verbose' ? 'normal' : 'errors-warnings',
};

export default config;

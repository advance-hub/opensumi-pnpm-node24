const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const jestBin = path.join(repoRoot, 'node_modules/jest/bin/jest.js');
const jestConfig = path.join(repoRoot, 'configs/jest/jest.config.ts');
const cliArgs = process.argv.slice(2);
const baseArgs = ['--unhandled-rejections=strict', '--expose-gc', jestBin, '--config', jestConfig, '--runInBand'];

function runJest(args, memoryLimit = 1024) {
  const result = spawnSync(process.execPath, [...baseArgs, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${memoryLimit}`].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

const runsSelectedTests = cliArgs.some(
  (arg) =>
    arg === '--runTestsByPath' ||
    arg === '--findRelatedTests' ||
    arg === '--selectProjects' ||
    arg.startsWith('--testPathPattern') ||
    !arg.startsWith('-'),
);

if (runsSelectedTests || cliArgs.includes('--coverage')) {
  process.exitCode = runJest(cliArgs, cliArgs.includes('--coverage') ? 4096 : 1024);
} else {
  for (const project of ['node', 'jsdom']) {
    const status = runJest(['--selectProjects', project, ...cliArgs]);
    if (status !== 0) {
      process.exitCode = status;
      break;
    }
  }
}

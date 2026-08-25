import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const eslintEntry = path.join(repoRoot, 'node_modules/eslint/bin/eslint.js');
const configPath = path.join(repoRoot, 'configs/eslint/eslint.config.ts');
const maxBatchFiles = 30;
const maxBatchSourceBytes = 300 * 1024;
const maxOldSpaceMb = 384;
const sourcePattern = /\.(?:js|jsx|ts|tsx)$/;
const skippedDirectories = new Set([
  '.cache',
  '.git',
  'coverage',
  'dist',
  'dist-node',
  'lib',
  'node_modules',
  'typings',
]);

function collectSourceFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = path.join(repoRoot, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) {
    return [];
  }

  const files: string[] = [];
  const visit = (absoluteParent: string) => {
    for (const entry of fs.readdirSync(absoluteParent, { withFileTypes: true })) {
      const absoluteEntry = path.join(absoluteParent, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) {
          visit(absoluteEntry);
        }
      } else if (entry.isFile() && sourcePattern.test(entry.name)) {
        files.push(path.relative(repoRoot, absoluteEntry));
      }
    }
  };
  visit(absoluteDirectory);
  return files;
}

function createBatches(values: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let sourceBytes = 0;

  for (const value of values) {
    const valueBytes = fs.statSync(path.join(repoRoot, value)).size;
    if (
      batch.length > 0 &&
      (batch.length >= maxBatchFiles || sourceBytes + valueBytes > maxBatchSourceBytes)
    ) {
      batches.push(batch);
      batch = [];
      sourceBytes = 0;
    }

    batch.push(value);
    sourceBytes += valueBytes;
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}

const rootSourceFiles = fs
  .readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && sourcePattern.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const sourceFiles = [
  rootSourceFiles,
  ...['client', 'server', 'configs', 'scripts', 'test', 'packages', 'tools'].flatMap(collectSourceFiles),
]
  .flat()
  .sort();
const batches = createBatches(sourceFiles);
const forwardedArgs = process.argv.slice(2).filter((argument) => argument !== '--');

for (const [index, targets] of batches.entries()) {
  const result = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${maxOldSpaceMb}`,
      eslintEntry,
      ...targets,
      '--config',
      configPath,
      '--cache',
      '--cache-location',
      path.join(repoRoot, `.cache/eslint/batch-${index}.cache`),
      '--cache-strategy',
      'content',
      '--no-error-on-unmatched-pattern',
      '--no-warn-ignored',
      ...forwardedArgs,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(`ESLint batch failed: ${targets.join(', ')}\n`);
    process.exit(result.status ?? 1);
  }
}

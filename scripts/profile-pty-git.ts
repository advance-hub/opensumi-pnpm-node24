import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { collectProcessTreeMemory } from '../server/scripts/process-tree.ts';

import type { ProcessTreeMemorySnapshot } from '../server/scripts/process-tree.ts';
import type { Browser, Page } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface PtyGitOptions {
  durationSeconds: number;
  intervalMs: number;
  headless: boolean;
  outputPath: string;
}

interface RoleShare {
  role: string;
  count: number;
  peakRssBytes: number;
  peakShareOfTree: number;
}

interface PtyGitEvidence {
  schemaVersion: 1;
  platform: string;
  startedAt: string;
  durationMs: number;
  options: PtyGitOptions;
  workspace: { path: string; gitRepository: boolean };
  samples: Array<{ atMs: number; totalTreeRssBytes: number; byRole: ProcessTreeMemorySnapshot['byRole'] }>;
  rolePeaks: RoleShare[];
  gateDecision: {
    thresholdShare: number;
    ptyProcessQualified: boolean;
    gitQualified: boolean;
    verdict: string;
  };
  consoleErrors: string[];
}

function parseOptions(argv: string[]): PtyGitOptions {
  const options: PtyGitOptions = {
    durationSeconds: 90,
    intervalMs: 3_000,
    headless: true,
    outputPath: path.join(repoRoot, 'output/pty-git', `pty-git-profile-${process.platform}.json`),
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    const next = (): string => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${value}`);
      }
      return argv[index];
    };
    switch (value) {
      case '--duration':
        options.durationSeconds = Number(next());
        break;
      case '--interval':
        options.intervalMs = Number(next());
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--output':
        options.outputPath = path.resolve(next());
        break;
      default:
        throw new Error(`Unknown option ${value}`);
    }
  }
  return options;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function runGit(workspace: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('git', args, { cwd: workspace });
  return stdout;
}

async function prepareGitWorkspace(): Promise<{ workspacePath: string; cleanup: () => Promise<void> }> {
  // A throwaway git repository with enough history that the SCM extension has
  // real status/log work to do.
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'opensumi-pty-git-'));
  await mkdir(path.join(workspacePath, 'src'), { recursive: true });
  for (let commit = 0; commit < 12; commit++) {
    await writeFile(
      path.join(workspacePath, 'src', `file-${commit}.ts`),
      `export const value${commit} = ${commit};\n`.repeat(40),
    );
  }
  await runGit(workspacePath, ['init']);
  await runGit(workspacePath, ['config', 'user.email', 'profile@example.com']);
  await runGit(workspacePath, ['config', 'user.name', 'PTY Git Profiler']);
  await runGit(workspacePath, ['add', '.']);
  await runGit(workspacePath, ['commit', '-m', 'initial commit']);
  await writeFile(path.join(workspacePath, 'src', 'dirty.ts'), 'export const dirty = true;\n');
  return {
    workspacePath,
    cleanup: () => rm(workspacePath, { recursive: true, force: true }),
  };
}

async function openTerminal(page: Page): Promise<void> {
  // OpenSumi binds new-terminal to Ctrl+` in the browser workbench.
  await page.keyboard.press('Control+`');
  await page.waitForFunction(
    () => document.body.innerText.includes('TERMINAL') || Boolean(document.querySelector('.xterm')),
    undefined,
    { timeout: 30_000 },
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = Date.now();
  const port = await freePort();
  const serverEntry = path.join(repoRoot, 'server/dist/main.js');
  const clientEntry = path.join(repoRoot, 'client/dist/index.html');
  await Promise.all([serverEntry, clientEntry].map((filePath) => access(filePath)));

  const { workspacePath, cleanup } = await prepareGitWorkspace();
  const consoleErrors: string[] = [];
  let server: ReturnType<typeof spawn> | undefined;
  let browser: Browser | undefined;
  try {
    server = spawn(process.execPath, ['--max-old-space-size=512', serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await delay(200);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
        ready = ((await response.json()) as { status?: string }).status === 'ok';
      } catch {}
    }
    if (!ready) {
      throw new Error('Server did not become healthy');
    }

    browser = await chromium.launch({ headless: options.headless });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (message) => {
      if (message.type() === 'error' && consoleErrors.length < 30) {
        consoleErrors.push(message.text());
      }
    });
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set('workspaceDir', workspacePath);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(
      (expectedTitle) => document.title === expectedTitle,
      `${path.basename(workspacePath)} — OpenSumi`,
      { timeout: 30_000 },
    );
    await openTerminal(page);

    // Drive real PTY + git + build-like load inside the terminal.
    const commands = [
      'git status',
      'git log --oneline -5',
      'echo pty-proof-$((1 + 1))',
      'for i in 1 2 3; do echo cycle-$i; done',
      'node -e "console.log(process.version)"',
    ];
    for (const command of commands) {
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await delay(1_000);
    }

    const samples: PtyGitEvidence['samples'] = [];
    const deadline = Date.now() + options.durationSeconds * 1000;
    while (Date.now() < deadline) {
      const snapshot = await collectProcessTreeMemory(server.pid!);
      samples.push({
        atMs: Date.now() - startedAt,
        totalTreeRssBytes: snapshot.totalRssBytes,
        byRole: snapshot.byRole,
      });
      await delay(options.intervalMs);
    }

    // Keep git activity going during a second pass so transient git children
    // are sampled while alive.
    for (const command of ['git status', 'git diff --stat', 'git log -1']) {
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await delay(800);
    }
    const lateSnapshot = await collectProcessTreeMemory(server.pid!);
    samples.push({
      atMs: Date.now() - startedAt,
      totalTreeRssBytes: lateSnapshot.totalRssBytes,
      byRole: lateSnapshot.byRole,
    });

    const rolesOfInterest = [
      'pty-host',
      'terminal-shell',
      'extension-child',
      'extension-host',
      'server',
      'workspace-agent',
    ];
    const rolePeaks: RoleShare[] = rolesOfInterest
      .map((role) => {
        let peakRssBytes = 0;
        let peakCount = 0;
        for (const sample of samples) {
          const summary = (sample.byRole as Record<string, { count: number; rssBytes: number }>)[role];
          if (summary && summary.rssBytes > peakRssBytes) {
            peakRssBytes = summary.rssBytes;
            peakCount = summary.count;
          }
        }
        const peakTree = Math.max(...samples.map((sample) => sample.totalTreeRssBytes));
        return {
          role,
          count: peakCount,
          peakRssBytes,
          peakShareOfTree: peakTree > 0 ? peakRssBytes / peakTree : 0,
        };
      })
      .sort((left, right) => right.peakRssBytes - left.peakRssBytes);

    const pty = rolePeaks.find((role) => role.role === 'pty-host');
    const shells = rolePeaks.find((role) => role.role === 'terminal-shell');
    const ptyProcessTotal = (pty?.peakRssBytes ?? 0) + (shells?.peakRssBytes ?? 0);
    const gitChildren = rolePeaks.find((role) => role.role === 'extension-child');
    const gateDecision = {
      thresholdShare: 0.2,
      ptyProcessQualified: ptyProcessTotal / Math.max(1, Math.max(...samples.map((s) => s.totalTreeRssBytes))) >= 0.2,
      gitQualified: (gitChildren?.peakShareOfTree ?? 0) >= 0.2,
      verdict: '',
    };
    gateDecision.verdict =
      `pty-host+terminal-shell peak ${(ptyProcessTotal / 1048576).toFixed(1)} MiB, git children peak ` +
      `${((gitChildren?.peakRssBytes ?? 0) / 1048576).toFixed(1)} MiB — per §6.1 a role must hold ≥20% of the ` +
      `process tree to enter a Go pilot; PTY+Git qualification: ${gateDecision.ptyProcessQualified || gateDecision.gitQualified}`;

    const evidence: PtyGitEvidence = {
      schemaVersion: 1,
      platform: process.platform,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      options,
      workspace: { path: workspacePath, gitRepository: true },
      samples,
      rolePeaks,
      gateDecision,
      consoleErrors,
    };
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, JSON.stringify(evidence, null, 2));
    console.log(`PTY/Git profile written to ${options.outputPath}`);
    console.log(JSON.stringify({ rolePeaks, gateDecision }, null, 2));
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill('SIGTERM');
    await cleanup();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

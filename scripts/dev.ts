import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { assertMemoryHeadroom } from './fn/memory.ts';

import type { ChildProcess } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const host = process.env.HOST || '127.0.0.1';
const serverPort = Number(process.env.PORT || process.env.IDE_SERVER_PORT || 8000);
const clientPort = Number(process.env.IDE_FRONT_PORT || 8080);
const knownArguments = new Set([
  '--',
  '--ai',
  '--client-only',
  '--collaboration',
  '--help',
  '--notebook',
  '--server-only',
  '--source',
]);

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child: ChildProcess): Promise<ChildResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    } else {
      // The process-group leader may have exited while one of its descendants is
      // still alive. Always signal the group so watcher and extension-host
      // processes cannot be orphaned during shutdown.
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function stopChildren(children: ChildProcess[]): Promise<void> {
  const processTrees = children.filter((child) => child.pid);
  const running = children.filter((child) => child.exitCode === null && child.signalCode === null);
  processTrees.forEach((child) => signalProcessTree(child, 'SIGTERM'));
  if (processTrees.length === 0) {
    return;
  }

  const exited = Promise.allSettled(running.map(waitForExit));
  await Promise.race([exited, delay(5_000)]);
  processTrees.forEach((child) => signalProcessTree(child, 'SIGKILL'));
  await Promise.race([exited, delay(1_000)]);
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      const response = await fetch(`http://${host}:${serverPort}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The watcher may still be compiling or restarting the server.
    }
    await delay(250);
  }
  throw new Error(`Server did not become healthy on ${host}:${serverPort} within 30 seconds`);
}

function spawnRuntime(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env,
    stdio: 'inherit',
  });
  child.once('spawn', () => {
    process.stdout.write(`[dev] ${name} started (pid ${child.pid}, ${env.NODE_OPTIONS})\n`);
  });
  return child;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const unknownArguments = Array.from(args).filter((argument) => !knownArguments.has(argument));
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown development options: ${unknownArguments.join(', ')}`);
  }
  if (args.has('--help')) {
    process.stdout.write(
      'Usage: node scripts/dev.ts [--ai] [--notebook] [--collaboration] [--source] [--client-only|--server-only]\n',
    );
    return;
  }

  const clientOnly = args.has('--client-only');
  const serverOnly = args.has('--server-only');
  if (clientOnly && serverOnly) {
    throw new Error('--client-only and --server-only cannot be used together');
  }
  if (!Number.isSafeInteger(serverPort) || serverPort <= 0 || !Number.isSafeInteger(clientPort) || clientPort <= 0) {
    throw new Error('PORT, IDE_SERVER_PORT and IDE_FRONT_PORT must be positive integers');
  }

  const startClient = !serverOnly;
  const startServer = !clientOnly;
  const sourceMode = args.has('--source') || process.env.OPENSUMI_SOURCE_MODE === '1';
  const serverSourceMode = args.has('--source') || process.env.OPENSUMI_SERVER_SOURCE_MODE === '1';
  const requiredServerRuntimeFiles = [
    'packages/extension/lib/worker-host.js',
    'packages/extension/lib/hosted/ext.process.js',
    'packages/file-service/lib/node/hosted/watcher.process.js',
    'packages/startup/lib/node/common-modules.js',
    ...(serverSourceMode ? [] : ['server/dist/main.js']),
  ];
  const requiredClientRuntimeFiles = [
    'packages/core-browser/lib/index.js',
    'packages/core-common/lib/index.js',
    'packages/design/lib/index.js',
    'packages/startup/lib/browser/common-modules.js',
    'packages/startup/lib/browser/menu-bar-help-icon.js',
  ];
  const requiredRuntimeFiles = [
    ...(startServer ? requiredServerRuntimeFiles : []),
    ...(startClient && process.env.OPENSUMI_SOURCE_MODE !== '1' ? requiredClientRuntimeFiles : []),
  ];
  const missingRuntimeFiles = requiredRuntimeFiles.filter((file) => !fs.existsSync(path.join(repoRoot, file)));
  if (missingRuntimeFiles.length > 0) {
    throw new Error(`Runtime artifacts are missing; run pnpm init first:\n${missingRuntimeFiles.join('\n')}`);
  }

  assertMemoryHeadroom('Development startup', {
    minimumFreeMemoryMb: startClient && startServer ? 2048 : 1536,
    minimumFreeMemoryPercent: startClient && startServer ? 30 : 25,
  });
  if (startServer && (await isPortOpen(serverPort))) {
    throw new Error(`Server port ${serverPort} is already in use`);
  }
  if (startClient && (await isPortOpen(clientPort))) {
    throw new Error(`Client port ${clientPort} is already in use`);
  }

  const enableAI = args.has('--ai');
  const enableNotebook = args.has('--notebook');
  const enableCollaboration = args.has('--collaboration');
  const profileEnvironment = {
    ENABLE_AI: enableAI ? '1' : '0',
    ENABLE_NOTEBOOK: enableNotebook ? '1' : '0',
    ENABLE_COLLABORATION: enableCollaboration ? '1' : '0',
    OPENSUMI_SOURCE_MODE: sourceMode ? '1' : '0',
  };
  const children: ChildProcess[] = [];
  let requestedShutdown = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ||= stopChildren(children);
    return shutdownPromise;
  };
  const handleSignal = () => {
    requestedShutdown = true;
    void shutdown();
  };
  // Package managers and the controlling terminal can both forward the same
  // signal. Keep idempotent handlers installed until cleanup finishes so a
  // duplicate signal cannot terminate the supervisor halfway through shutdown.
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.on('SIGHUP', handleSignal);

  try {
    if (startServer) {
      const serverHeapMb = enableAI ? 768 : 512;
      const serverEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ...profileEnvironment,
        NODE_OPTIONS: `--max-old-space-size=${serverHeapMb}`,
        PORT: String(serverPort),
        IS_DEV: '1',
        NODE_ENV: 'development',
        KTLOG_SHOW_DEBUG: process.env.KTLOG_SHOW_DEBUG || '0',
      };
      if (serverSourceMode) {
        serverEnvironment.EXT_MODE = 'js';
      } else {
        delete serverEnvironment.EXT_MODE;
      }
      const server = spawnRuntime(
        serverSourceMode ? 'server source watcher' : 'server',
        serverSourceMode
          ? [path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'watch', 'server/src/main.ts']
          : [path.join(repoRoot, 'server/dist/main.js')],
        serverEnvironment,
      );
      children.push(server);
      if (startClient) {
        await waitForServer(server);
      }
    }

    if (startClient) {
      assertMemoryHeadroom('Client development startup', {
        minimumFreeMemoryMb: 1536,
        minimumFreeMemoryPercent: 25,
      });
      const clientHeapMb = enableAI || enableNotebook ? 768 : 512;
      const client = spawnRuntime(
        'client',
        [path.join(repoRoot, 'node_modules/@rspack/cli/bin/rspack.js'), 'dev', '--config', 'client/rspack.config.ts'],
        {
          ...process.env,
          ...profileEnvironment,
          NODE_OPTIONS: `--max-old-space-size=${clientHeapMb}`,
          HOST: host,
          IDE_FRONT_PORT: String(clientPort),
          WS_PATH: process.env.WS_PATH || `ws://${host}:${serverPort}`,
          NODE_ENV: 'development',
        },
      );
      children.push(client);
    }

    const firstExit = await Promise.race(children.map(waitForExit));
    if (!requestedShutdown && (firstExit.code !== 0 || firstExit.signal)) {
      process.exitCode = firstExit.code || 1;
    }
  } finally {
    await shutdown();
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    process.off('SIGHUP', handleSignal);
  }
}

void main().catch((error) => {
  process.stderr.write(`[dev] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

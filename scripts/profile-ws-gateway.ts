import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { collectProcessTreeMemory } from '../server/scripts/process-tree';
import { percentile, summarizeRuntimeProfile } from '../server/scripts/runtime-profile-metrics';

import type { ProcessTreeMemorySnapshot } from '../server/scripts/process-tree';
import type { ChildProcess } from 'node:child_process';

type Variant = 'node' | 'gateway';
type GatewayChannelMode = 'direct' | 'multiplex-v1';

interface Options {
  connections: number;
  batchSize: number;
  runs: number;
  samples: number;
  intervalMs: number;
  warmupMs: number;
  outputPath: string;
  gatewayChannelMode: GatewayChannelMode;
}

interface RunResult {
  variant: Variant;
  run: number;
  connections: number;
  handshakeP50Ms: number;
  handshakeP95Ms: number;
  baseline: ProcessTreeMemorySnapshot;
  connected: ReturnType<typeof summarizeRuntimeProfile>;
  connectedP95IncrementalRssBytes: number;
  cleanup: ProcessTreeMemorySnapshot;
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverEntry = path.join(repoRoot, 'server/dist/main.js');
const gatewayBinary = path.join(
  repoRoot,
  'server/dist/workspace-agent',
  process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway',
);

function usage(): string {
  return [
    'Usage: pnpm profile:ws-gateway -- [options]',
    '',
    'Starts the production server in Node and Go Gateway modes, opens idle',
    'WebSocket connections from an out-of-tree client, and compares handshake',
    'latency plus whole-process-tree RSS.',
    '',
    'Options:',
    '  --connections <count>  Concurrent WebSockets, default 200',
    '  --batch-size <count>   Concurrent handshakes per batch, default 25',
    '  --runs <count>         Paired repetitions, default 3',
    '  --samples <count>      RSS samples while connected, default 5',
    '  --interval <ms>        Delay between RSS samples, default 500',
    '  --warmup <ms>          Settle time before baseline and samples, default 1500',
    '  --gateway-channel-mode <mode>  direct or multiplex-v1, default multiplex-v1',
    '  --output <path>        JSON evidence path',
  ].join('\n');
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options | undefined {
  argv = argv.filter((argument) => argument !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${option || '<end>'}`);
    }
    if (
      ![
        '--connections',
        '--batch-size',
        '--runs',
        '--samples',
        '--interval',
        '--warmup',
        '--output',
        '--gateway-channel-mode',
      ].includes(option)
    ) {
      throw new Error(`Unknown option: ${option}`);
    }
    values.set(option, value);
  }
  const gatewayChannelMode = values.get('--gateway-channel-mode') || 'multiplex-v1';
  if (gatewayChannelMode !== 'direct' && gatewayChannelMode !== 'multiplex-v1') {
    throw new Error('--gateway-channel-mode must be direct or multiplex-v1');
  }
  return {
    connections: positiveInteger('--connections', values.get('--connections'), 200),
    batchSize: positiveInteger('--batch-size', values.get('--batch-size'), 25),
    runs: positiveInteger('--runs', values.get('--runs'), 3),
    samples: positiveInteger('--samples', values.get('--samples'), 5),
    intervalMs: positiveInteger('--interval', values.get('--interval'), 500),
    warmupMs: positiveInteger('--warmup', values.get('--warmup'), 1_500),
    outputPath: path.resolve(repoRoot, values.get('--output') || 'output/runtime-profiles/ws-gateway-capacity.json'),
    gatewayChannelMode,
  };
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    listener.close();
    throw new Error('Could not reserve a loopback benchmark port');
  }
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (await waitForExit(child, 0)) {
    return;
  }
  child.kill('SIGTERM');
  if (!(await waitForExit(child, 5_000))) {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000);
  }
}

async function waitForHealth(url: string, child: ChildProcess, readLogs: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Server exited during startup (code ${child.exitCode}, signal ${child.signalCode}): ${readLogs()}`,
      );
    }
    try {
      const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // The public listener is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${readLogs()}`);
}

async function startServer(
  variant: Variant,
  port: number,
  maxConnections: number,
  gatewayChannelMode: GatewayChannelMode,
): Promise<{
  child: ChildProcess;
  url: string;
  readLogs(): string;
}> {
  let logs = '';
  const child = spawn(process.execPath, ['--max-old-space-size=512', serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      EXT_MODE: 'js',
      KTLOG_SHOW_DEBUG: '0',
      OPENSUMI_WORKSPACE_AGENT_WATCH_MODE: 'off',
      OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: 'off',
      OPENSUMI_WS_GATEWAY_MODE: variant === 'gateway' ? 'enabled' : 'off',
      OPENSUMI_WS_GATEWAY_PATH: gatewayBinary,
      OPENSUMI_WS_GATEWAY_CHANNEL_MODE: gatewayChannelMode,
      WS_MAX_CONNECTIONS: String(maxConnections),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = (chunk: Buffer | string) => {
    logs = `${logs}${String(chunk)}`.slice(-64 * 1024);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, child, () => logs);
  return { child, url, readLogs: () => logs };
}

function openWebSocket(url: string): Promise<{ socket: WebSocket; latencyMs: number }> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/service`, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket handshake timed out'));
    }, 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve({ socket, latencyMs: performance.now() - startedAt });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function openConnections(
  url: string,
  count: number,
  batchSize: number,
): Promise<{
  sockets: WebSocket[];
  latenciesMs: number[];
}> {
  const sockets: WebSocket[] = [];
  const latenciesMs: number[] = [];
  try {
    for (let offset = 0; offset < count; offset += batchSize) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(batchSize, count - offset) }, () => openWebSocket(url)),
      );
      sockets.push(...batch.map((result) => result.socket));
      latenciesMs.push(...batch.map((result) => result.latencyMs));
    }
    return { sockets, latenciesMs };
  } catch (error) {
    sockets.forEach((socket) => socket.terminate());
    throw error;
  }
}

async function closeConnections(sockets: WebSocket[]): Promise<void> {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            socket.terminate();
            resolve();
          }, 2_000);
          timer.unref?.();
          socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          socket.close();
        }),
    ),
  );
}

async function profileRun(variant: Variant, run: number, options: Options): Promise<RunResult> {
  const port = await freePort();
  const runtime = await startServer(variant, port, options.connections + 32, options.gatewayChannelMode);
  const child = runtime.child;
  if (!child.pid) {
    await stopServer(child);
    throw new Error('Server process has no PID');
  }
  let sockets: WebSocket[] = [];
  try {
    await delay(options.warmupMs);
    const baseline = await collectProcessTreeMemory(child.pid);
    const opened = await openConnections(runtime.url, options.connections, options.batchSize);
    sockets = opened.sockets;
    await delay(options.warmupMs);
    const samples: ProcessTreeMemorySnapshot[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      samples.push(await collectProcessTreeMemory(child.pid));
      if (index + 1 < options.samples) {
        await delay(options.intervalMs);
      }
    }
    const connected = summarizeRuntimeProfile(samples);
    await closeConnections(sockets);
    sockets = [];
    await delay(options.warmupMs);
    const cleanup = await collectProcessTreeMemory(child.pid);
    return {
      variant,
      run,
      connections: options.connections,
      handshakeP50Ms: percentile(opened.latenciesMs, 0.5),
      handshakeP95Ms: percentile(opened.latenciesMs, 0.95),
      baseline,
      connected,
      connectedP95IncrementalRssBytes: connected.p95TreeRssBytes - baseline.totalRssBytes,
      cleanup,
    };
  } catch (error) {
    throw new Error(
      `${variant} run ${run} failed: ${error instanceof Error ? error.message : String(error)}\n${runtime.readLogs()}`,
      { cause: error },
    );
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await stopServer(child);
  }
}

function median(results: RunResult[], read: (result: RunResult) => number): number {
  return percentile(results.map(read), 0.5);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    return;
  }
  const results: RunResult[] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    for (const variant of (run % 2 === 1 ? ['node', 'gateway'] : ['gateway', 'node']) as Variant[]) {
      const result = await profileRun(variant, run, options);
      results.push(result);
      process.stdout.write(
        `${variant} run ${run}: p95 handshake ${result.handshakeP95Ms.toFixed(2)}ms, p95 tree RSS ${result.connected.p95TreeRssBytes}\n`,
      );
    }
  }

  const nodeResults = results.filter((result) => result.variant === 'node');
  const gatewayResults = results.filter((result) => result.variant === 'gateway');
  const nodeP95HandshakeMs = median(nodeResults, (result) => result.handshakeP95Ms);
  const gatewayP95HandshakeMs = median(gatewayResults, (result) => result.handshakeP95Ms);
  const nodeP95TreeRssBytes = median(nodeResults, (result) => result.connected.p95TreeRssBytes);
  const gatewayP95TreeRssBytes = median(gatewayResults, (result) => result.connected.p95TreeRssBytes);
  const nodeIncrementalRssBytes = median(nodeResults, (result) => result.connectedP95IncrementalRssBytes);
  const gatewayIncrementalRssBytes = median(gatewayResults, (result) => result.connectedP95IncrementalRssBytes);
  const summary = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    options,
    comparison: {
      nodeP95HandshakeMs,
      gatewayP95HandshakeMs,
      handshakeRegressionRatio: (gatewayP95HandshakeMs - nodeP95HandshakeMs) / nodeP95HandshakeMs,
      nodeP95TreeRssBytes,
      gatewayP95TreeRssBytes,
      wholeTreeRssReductionRatio: (nodeP95TreeRssBytes - gatewayP95TreeRssBytes) / nodeP95TreeRssBytes,
      nodeIncrementalRssBytes,
      gatewayIncrementalRssBytes,
      incrementalRssReductionRatio:
        nodeIncrementalRssBytes > 0
          ? (nodeIncrementalRssBytes - gatewayIncrementalRssBytes) / nodeIncrementalRssBytes
          : undefined,
      meetsTenPercentLatencyGate: gatewayP95HandshakeMs <= nodeP95HandshakeMs * 1.1,
      reducesWholeTreeRss: gatewayP95TreeRssBytes < nodeP95TreeRssBytes,
    },
    runs: results,
  };
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary.comparison, null, 2)}\nEvidence: ${options.outputPath}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});

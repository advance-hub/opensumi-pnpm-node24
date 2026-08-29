import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WS from 'ws';

import { collectProcessTreeMemory } from './process-tree';

import type { ProcessRole, ProcessTreeMemorySnapshot } from './process-tree';

interface HealthResponse {
  ready: boolean;
  memory: NodeJS.MemoryUsage;
}

const connectionCount = Number(process.env.MEMORY_SMOKE_CONNECTIONS || 100);
const reconnectCycles = Number(process.env.MEMORY_SMOKE_CYCLES || 5);
const maxRetainedBytes = Number(process.env.MEMORY_SMOKE_MAX_RETAINED_MB || 32) * 1024 * 1024;
const maxTreeRetainedBytes =
  Number(process.env.MEMORY_SMOKE_MAX_TREE_RETAINED_MB || process.env.MEMORY_SMOKE_MAX_RETAINED_MB || 32) * 1024 * 1024;

function updateRolePeaks(
  peaks: Partial<Record<ProcessRole, number>>,
  sample: ProcessTreeMemorySnapshot,
): Partial<Record<ProcessRole, number>> {
  const next = { ...peaks };
  for (const [role, summary] of Object.entries(sample.byRole) as Array<
    [ProcessRole, { count: number; rssBytes: number }]
  >) {
    next[role] = Math.max(next[role] || 0, summary.rssBytes);
  }
  return next;
}

function summarizeTreeSample(sample: ProcessTreeMemorySnapshot) {
  return {
    timestamp: sample.timestamp,
    processCount: sample.processCount,
    totalRssBytes: sample.totalRssBytes,
    byRole: sample.byRole,
    linuxCgroup: sample.linuxCgroup,
  };
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate a TCP port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function readHealth(port: number): Promise<HealthResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!response.ok) {
    throw new Error(`Health endpoint returned ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

async function waitUntilReady(port: number): Promise<HealthResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const health = await readHealth(port);
      if (health.ready) {
        return health;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${String(lastError)}`);
}

async function openConnections(port: number): Promise<WS[]> {
  return Promise.all(
    Array.from({ length: connectionCount }, () => {
      const socket = new WS(`ws://127.0.0.1:${port}/service`);
      return new Promise<WS>((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
    }),
  );
}

async function closeConnections(sockets: WS[]): Promise<void> {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close();
        }),
    ),
  );
}

async function main(): Promise<void> {
  if (!Number.isSafeInteger(connectionCount) || connectionCount <= 0) {
    throw new Error('MEMORY_SMOKE_CONNECTIONS must be a positive integer');
  }
  if (!Number.isSafeInteger(reconnectCycles) || reconnectCycles <= 0) {
    throw new Error('MEMORY_SMOKE_CYCLES must be a positive integer');
  }

  const port = await getFreePort();
  const serverEntry = path.resolve(__dirname, '../dist/main.js');
  const child = spawn(process.execPath, ['--max-old-space-size=512', serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024);
  });

  let runError: unknown;
  try {
    const baseline = await waitUntilReady(port);
    const baselineTree = await collectProcessTreeMemory(child.pid!);
    const treeSamples: ProcessTreeMemorySnapshot[] = [baselineTree];
    let peakRss = baseline.memory.rss;
    let peakHeapUsed = baseline.memory.heapUsed;
    let peakTreeRss = baselineTree.totalRssBytes;
    let peakTree = baselineTree;
    let peakProcessCount = baselineTree.processCount;
    let peakRoleRssBytes = updateRolePeaks({}, baselineTree);

    for (let cycle = 0; cycle < reconnectCycles; cycle++) {
      const sockets = await openConnections(port);
      const active = await readHealth(port);
      const activeTree = await collectProcessTreeMemory(child.pid!);
      treeSamples.push(activeTree);
      peakRss = Math.max(peakRss, active.memory.rss);
      peakHeapUsed = Math.max(peakHeapUsed, active.memory.heapUsed);
      peakTreeRss = Math.max(peakTreeRss, activeTree.totalRssBytes);
      if (activeTree.totalRssBytes > peakTree.totalRssBytes) {
        peakTree = activeTree;
      }
      peakProcessCount = Math.max(peakProcessCount, activeTree.processCount);
      peakRoleRssBytes = updateRolePeaks(peakRoleRssBytes, activeTree);
      await closeConnections(sockets);
      const closedTree = await collectProcessTreeMemory(child.pid!);
      treeSamples.push(closedTree);
      peakTreeRss = Math.max(peakTreeRss, closedTree.totalRssBytes);
      if (closedTree.totalRssBytes > peakTree.totalRssBytes) {
        peakTree = closedTree;
      }
      peakProcessCount = Math.max(peakProcessCount, closedTree.processCount);
      peakRoleRssBytes = updateRolePeaks(peakRoleRssBytes, closedTree);
    }

    await delay(2_000);
    const final = await readHealth(port);
    const finalTree = await collectProcessTreeMemory(child.pid!);
    treeSamples.push(finalTree);
    peakRss = Math.max(peakRss, final.memory.rss);
    peakHeapUsed = Math.max(peakHeapUsed, final.memory.heapUsed);
    peakTreeRss = Math.max(peakTreeRss, finalTree.totalRssBytes);
    if (finalTree.totalRssBytes > peakTree.totalRssBytes) {
      peakTree = finalTree;
    }
    peakProcessCount = Math.max(peakProcessCount, finalTree.processCount);
    peakRoleRssBytes = updateRolePeaks(peakRoleRssBytes, finalTree);
    const retainedRss = final.memory.rss - baseline.memory.rss;
    const retainedTreeRss = finalTree.totalRssBytes - baselineTree.totalRssBytes;
    if (retainedRss > maxRetainedBytes) {
      throw new Error(
        `RSS retained ${Math.ceil(retainedRss / 1024 / 1024)} MiB after reconnect cycles; limit is ${Math.ceil(
          maxRetainedBytes / 1024 / 1024,
        )} MiB`,
      );
    }
    if (retainedTreeRss > maxTreeRetainedBytes) {
      throw new Error(
        `Process tree RSS retained ${Math.ceil(
          retainedTreeRss / 1024 / 1024,
        )} MiB after reconnect cycles; limit is ${Math.ceil(maxTreeRetainedBytes / 1024 / 1024)} MiB`,
      );
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 2,
          connectionCount,
          reconnectCycles,
          baseline: baseline.memory,
          peak: { heapUsed: peakHeapUsed, rss: peakRss },
          final: final.memory,
          retainedRss,
          processTree: {
            baseline: baselineTree,
            peak: {
              sample: peakTree,
              rssBytes: peakTreeRss,
              processCount: peakProcessCount,
              roleRssBytes: peakRoleRssBytes,
            },
            final: finalTree,
            retainedRssBytes: retainedTreeRss,
            samples: treeSamples.map(summarizeTreeSample),
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    runError = error;
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      delay(5_000).then(() => {
        child.kill('SIGKILL');
      }),
    ]);
  }

  if (runError) {
    throw new Error(
      `Memory smoke failed: ${runError instanceof Error ? runError.message : String(runError)}\n${stderr}`,
      {
        cause: runError,
      },
    );
  }
  if (child.exitCode && child.exitCode !== 0 && child.signalCode !== 'SIGTERM') {
    throw new Error(`Server exited with code ${child.exitCode}: ${stderr}`);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

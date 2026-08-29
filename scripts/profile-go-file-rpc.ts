import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { oneOf } from '@opensumi/ide-connection/lib/common/fury-extends/one-of';
import { MessageIO, OperationType } from '@opensumi/ide-connection/lib/common/rpc/message-io';
import {
  BinaryProtocol,
  CloseProtocol,
  DataProtocol,
  ErrorProtocol,
  OpenProtocol,
  PingProtocol,
  PongProtocol,
  ServerReadyProtocol,
} from '@opensumi/ide-connection/lib/common/serializer/fury';
import { DiskFileServiceProtocol } from '@opensumi/ide-file-service/lib/common/protocols/disk-file-service';

import { collectProcessTreeMemory } from '../server/scripts/process-tree.ts';

import type { ProcessTreeMemorySnapshot } from '../server/scripts/process-tree.ts';
import type { ChannelMessage } from '@opensumi/ide-connection/lib/common/channel/types';
import type { ISerializer } from '@opensumi/ide-connection/lib/common/serializer/types';
import type { ChildProcess } from 'node:child_process';

type Variant = 'node' | 'gateway';

interface Options {
  runs: number;
  warmups: number;
  measuredReads: number;
  stressReads: number;
  fileBytes: number;
  clients: number;
  outputPath: string;
}

interface GatewayDiagnostics {
  directFileRPCEnabled: boolean;
  directFileRPCs: number;
  directFileReads: number;
  directFileReadBytes: number;
  directFileAccesses: number;
  directDirectoryReads: number;
  directFileStats: number;
  browserFramesForwarded: number;
  nodeFramesForwarded: number;
}

interface RunResult {
  variant: Variant;
  run: number;
  exactResponses: number;
  duringLoadP95TreeRssBytes: number;
  duringLoadSamples: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyMeanMs: number;
  latencyByMethod: {
    readFile: MethodLatency;
    access: MethodLatency;
    readDirectory: MethodLatency;
    statFile: MethodLatency;
    statDirectory: MethodLatency;
  };
  baseline: ProcessTreeMemorySnapshot;
  afterMeasured: ProcessTreeMemorySnapshot;
  afterStress: ProcessTreeMemorySnapshot;
  cleanup: ProcessTreeMemorySnapshot;
  statProof: {
    file: unknown;
    directory: unknown;
  };
  gatewayDiagnostics?: GatewayDiagnostics;
}

interface MethodLatency {
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
}

interface LatencyBuckets {
  readFile: number[];
  access: number[];
  readDirectory: number[];
  statFile: number[];
  statDirectory: number[];
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverEntry = path.join(repoRoot, 'server/dist/main.js');
const gatewayBinary = path.join(
  repoRoot,
  'server/dist/workspace-agent',
  process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway',
);
const fileReadMethod = 'DiskFileService:readFile';
const fileAccessMethod = 'DiskFileService:access';
const fileReadDirectoryMethod = 'DiskFileService:readDirectory';
const fileStatMethod = 'DiskFileService:stat';

function usage(): string {
  return [
    'Usage: pnpm profile:go-file-rpc -- [options]',
    '',
    'Runs DiskFileService:readFile, access, readDirectory and file/directory stat',
    'RPCs against fresh Node and Go Gateway servers, then records latency and process trees.',
    '',
    'Options:',
    '  --runs <count>          Paired fresh-process runs, default 3',
    '  --warmups <count>       Warmup cycles per client, default 20',
    '  --reads <count>         Timed cycles per client, default 200',
    '  --stress-reads <count>  Additional cycles per client before final RSS, default 500',
    '  --file-bytes <count>    Payload size, default 65536',
    '  --clients <count>       Concurrent RPC clients per run, default 1',
    '  --output <path>         JSON evidence path',
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
  argv = argv.filter((value) => value !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${name || '<end>'}`);
    }
    if (!['--runs', '--warmups', '--reads', '--stress-reads', '--file-bytes', '--clients', '--output'].includes(name)) {
      throw new Error(`Unknown option ${name}`);
    }
    values.set(name, value);
  }
  return {
    runs: positiveInteger('--runs', values.get('--runs'), 3),
    warmups: positiveInteger('--warmups', values.get('--warmups'), 20),
    measuredReads: positiveInteger('--reads', values.get('--reads'), 200),
    stressReads: positiveInteger('--stress-reads', values.get('--stress-reads'), 500),
    fileBytes: positiveInteger('--file-bytes', values.get('--file-bytes'), 65_536),
    clients: positiveInteger('--clients', values.get('--clients'), 1),
    outputPath: path.resolve(repoRoot, values.get('--output') || 'output/runtime-profiles/go-file-rpc-r3.json'),
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
    throw new Error('Could not allocate a loopback port');
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
    await waitForExit(child, 1_000);
  }
}

async function waitForReady(port: number, child: ChildProcess, readLogs: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited during startup: ${readLogs()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Listener is not ready yet.
    }
    await delay(50);
  }
  throw new Error(`Server did not become ready: ${readLogs()}`);
}

async function startServer(variant: Variant, port: number): Promise<{ child: ChildProcess; readLogs(): string }> {
  let logs = '';
  const child = spawn(process.execPath, ['--max-old-space-size=512', serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      OPENSUMI_WORKSPACE_AGENT_AUTO_MODE: 'off',
      OPENSUMI_WORKSPACE_AGENT_WATCH_MODE: 'off',
      OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: 'off',
      OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE: 'off',
      OPENSUMI_WS_GATEWAY_MODE: variant === 'gateway' ? 'enabled' : 'off',
      OPENSUMI_WS_GATEWAY_PATH: gatewayBinary,
      OPENSUMI_WS_GATEWAY_CHANNEL_MODE: 'multiplex-v1',
      OPENSUMI_WS_GATEWAY_FILE_RPC_MODE: 'enabled',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = (chunk: Buffer | string) => {
    logs = `${logs}${String(chunk)}`.slice(-32 * 1024);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  await waitForReady(port, child, () => logs);
  return { child, readLogs: () => logs };
}

function createChannelSerializer(): ISerializer<ChannelMessage, Uint8Array> {
  return oneOf([
    PingProtocol,
    PongProtocol,
    OpenProtocol,
    ServerReadyProtocol,
    DataProtocol,
    BinaryProtocol,
    CloseProtocol,
    ErrorProtocol,
  ]);
}

function nextBinaryMessage(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for RPC WebSocket response'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      cleanup();
      if (!isBinary) {
        reject(new Error('Received a non-binary OpenSumi message'));
        return;
      }
      resolve(Uint8Array.from(data as Buffer));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('RPC WebSocket closed before a response'));
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function sendAndReceive(socket: WebSocket, payload: Uint8Array): Promise<Uint8Array> {
  const response = nextBinaryMessage(socket);
  socket.send(payload, { binary: true });
  return response;
}

async function openRPCConnection(
  port: number,
  clientIndex = 0,
): Promise<{
  socket: WebSocket;
  serializer: ISerializer<ChannelMessage, Uint8Array>;
  io: MessageIO;
  channelID: string;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/service`, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const serializer = createChannelSerializer();
  const channelID = `go-file-rpc-profile-${clientIndex}`;
  const response = await sendAndReceive(
    socket,
    serializer.serialize({
      kind: 'open',
      id: channelID,
      path: 'RPCService',
      clientId: `profile-${process.pid}-${clientIndex}-${Date.now()}`,
      traceId: `trace-${Date.now()}`,
    }),
  );
  const ready = serializer.deserialize(response);
  if (ready.kind !== 'server-ready' || ready.id !== channelID) {
    throw new Error(`Unexpected channel-open response ${JSON.stringify(ready)}`);
  }
  const io = new MessageIO();
  io.loadProtocol(DiskFileServiceProtocol, { nameConverter: (method) => `DiskFileService:${method}` });
  return { socket, serializer, io, channelID };
}

async function readFileRPC(
  connection: Awaited<ReturnType<typeof openRPCConnection>>,
  requestID: number,
  uri: Record<string, string>,
  expected: Uint8Array,
): Promise<number> {
  const inner = connection.io.Request(requestID, fileReadMethod, {}, [uri]);
  const startedAt = performance.now();
  const response = await sendAndReceive(
    connection.socket,
    connection.serializer.serialize({
      kind: 'binary',
      id: connection.channelID,
      binary: inner,
    }),
  );
  const latencyMs = performance.now() - startedAt;
  const outer = connection.serializer.deserialize(response);
  if (outer.kind !== 'binary' || outer.id !== connection.channelID) {
    throw new Error(`Unexpected outer RPC response ${JSON.stringify(outer)}`);
  }
  const parsed = connection.io.parse(outer.binary);
  if (
    parsed.kind !== OperationType.Response ||
    parsed.requestId !== requestID ||
    !(parsed.result instanceof Uint8Array) ||
    parsed.result.length !== expected.length ||
    Buffer.compare(Buffer.from(parsed.result), Buffer.from(expected)) !== 0
  ) {
    throw new Error(`RPC response ${requestID} did not contain the exact file bytes`);
  }
  return latencyMs;
}

async function anyFileRPC(
  connection: Awaited<ReturnType<typeof openRPCConnection>>,
  requestID: number,
  method: string,
  args: unknown[],
  validate: (result: unknown) => boolean,
  capture?: (result: unknown) => void,
): Promise<number> {
  const inner = connection.io.Request(requestID, method, {}, args);
  const startedAt = performance.now();
  const response = await sendAndReceive(
    connection.socket,
    connection.serializer.serialize({
      kind: 'binary',
      id: connection.channelID,
      binary: inner,
    }),
  );
  const latencyMs = performance.now() - startedAt;
  const outer = connection.serializer.deserialize(response);
  if (outer.kind !== 'binary' || outer.id !== connection.channelID) {
    throw new Error(`Unexpected outer RPC response ${JSON.stringify(outer)}`);
  }
  const parsed = connection.io.parse(outer.binary);
  if (parsed.kind !== OperationType.Response || parsed.requestId !== requestID || !validate(parsed.result)) {
    throw new Error(`${method} response ${requestID} failed validation`);
  }
  capture?.(parsed.result);
  return latencyMs;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function summarizeLatency(values: number[]): MethodLatency {
  return {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

async function runVariant(variant: Variant, run: number, options: Options, filePath: string, content: Uint8Array) {
  const port = await freePort();
  const runtime = await startServer(variant, port);
  const connections: Awaited<ReturnType<typeof openRPCConnection>>[] = [];
  try {
    await delay(250);
    const baseline = await collectProcessTreeMemory(runtime.child.pid!);
    for (let index = 0; index < options.clients; index += 1) {
      connections.push(await openRPCConnection(port, index));
    }
    const fileURI = { scheme: 'file', authority: '', path: filePath, query: '', fragment: '' };
    const directoryURI = { ...fileURI, path: path.dirname(filePath) };
    const clientStates = connections.map(() => ({ requestID: 0, cycles: 0 }));
    let statFileProof: unknown;
    let statDirectoryProof: unknown;
    const runClientCycle = async (clientIndex: number, latencies?: LatencyBuckets) => {
      const connection = connections[clientIndex]!;
      const state = clientStates[clientIndex]!;
      const readLatency = await readFileRPC(connection, state.requestID++, fileURI, content);
      const accessLatency = await anyFileRPC(
        connection,
        state.requestID++,
        fileAccessMethod,
        [fileURI, 0],
        (result) => result === true,
      );
      const directoryLatency = await anyFileRPC(
        connection,
        state.requestID++,
        fileReadDirectoryMethod,
        [directoryURI],
        (result) =>
          Array.isArray(result) &&
          result.length === 1 &&
          Array.isArray(result[0]) &&
          result[0][0] === path.basename(filePath) &&
          result[0][1] === 1,
      );
      const statFileLatency = await anyFileRPC(
        connection,
        state.requestID++,
        fileStatMethod,
        [fileURI],
        (result) =>
          typeof result === 'object' &&
          result !== null &&
          (result as Record<string, unknown>).uri === `file://${filePath}` &&
          (result as Record<string, unknown>).size === content.length &&
          (result as Record<string, unknown>).type === 1 &&
          (result as Record<string, unknown>).isDirectory === false,
        (result) => {
          statFileProof ??= result;
        },
      );
      const statDirectoryLatency = await anyFileRPC(
        connection,
        state.requestID++,
        fileStatMethod,
        [directoryURI],
        (result) => {
          if (typeof result !== 'object' || result === null) {
            return false;
          }
          const stat = result as Record<string, unknown>;
          const children = stat.children;
          return (
            stat.uri === `file://${path.dirname(filePath)}` &&
            stat.type === 2 &&
            stat.isDirectory === true &&
            Array.isArray(children) &&
            children.length === 1 &&
            typeof children[0] === 'object' &&
            children[0] !== null &&
            (children[0] as Record<string, unknown>).uri === `file://${filePath}`
          );
        },
        (result) => {
          statDirectoryProof ??= result;
        },
      );
      latencies?.readFile.push(readLatency);
      latencies?.access.push(accessLatency);
      latencies?.readDirectory.push(directoryLatency);
      latencies?.statFile.push(statFileLatency);
      latencies?.statDirectory.push(statDirectoryLatency);
      state.cycles += 1;
    };
    const runPhase = async (cyclesPerClient: number, buckets?: LatencyBuckets) => {
      await Promise.all(
        connections.map(async (_, clientIndex) => {
          for (let index = 0; index < cyclesPerClient; index += 1) {
            await runClientCycle(clientIndex, buckets);
          }
        }),
      );
    };
    const latencies: LatencyBuckets = {
      readFile: [],
      access: [],
      readDirectory: [],
      statFile: [],
      statDirectory: [],
    };
    await runPhase(options.warmups);
    // Sample the process tree while measured and stress load is in flight so
    // the high-watermark RSS is captured, not just the post-load retained value.
    const loadSamples: number[] = [];
    const loadSampler = setInterval(() => {
      void collectProcessTreeMemory(runtime.child.pid!).then(
        (snapshot) => loadSamples.push(snapshot.totalRssBytes),
        () => undefined,
      );
    }, 200);
    let afterMeasured!: ProcessTreeMemorySnapshot;
    let afterStress!: ProcessTreeMemorySnapshot;
    try {
      await runPhase(options.measuredReads, latencies);
      afterMeasured = await collectProcessTreeMemory(runtime.child.pid!);
      await runPhase(options.stressReads);
      afterStress = await collectProcessTreeMemory(runtime.child.pid!);
    } finally {
      clearInterval(loadSampler);
    }
    const gatewayDiagnostics =
      variant === 'gateway'
        ? ((await (
            await fetch(`http://127.0.0.1:${port}/_opensumi/ws-gateway`, {
              signal: AbortSignal.timeout(2_000),
            })
          ).json()) as GatewayDiagnostics)
        : undefined;
    const totalRPCs = clientStates.reduce((sum, state) => sum + state.requestID, 0);
    const totalCycles = clientStates.reduce((sum, state) => sum + state.cycles, 0);
    if (
      gatewayDiagnostics &&
      (!gatewayDiagnostics.directFileRPCEnabled ||
        gatewayDiagnostics.directFileRPCs !== totalRPCs ||
        gatewayDiagnostics.directFileReads !== totalCycles ||
        gatewayDiagnostics.directFileAccesses !== totalCycles ||
        gatewayDiagnostics.directDirectoryReads !== totalCycles ||
        gatewayDiagnostics.directFileStats !== totalCycles * 2)
    ) {
      throw new Error(`Gateway did not handle every file RPC: ${JSON.stringify(gatewayDiagnostics)}`);
    }
    for (const connection of connections) {
      connection.socket.close();
    }
    connections.length = 0;
    await delay(300);
    const cleanup = await collectProcessTreeMemory(runtime.child.pid!);
    if (!statFileProof || !statDirectoryProof) {
      throw new Error('File stat proof was not captured');
    }
    return {
      variant,
      run,
      exactResponses: totalRPCs,
      duringLoadP95TreeRssBytes: percentile(
        [...loadSamples].sort((left, right) => left - right),
        0.95,
      ),
      duringLoadSamples: loadSamples.length,
      latencyP50Ms: percentile(latencies.readFile, 0.5),
      latencyP95Ms: percentile(latencies.readFile, 0.95),
      latencyMeanMs: latencies.readFile.reduce((sum, value) => sum + value, 0) / latencies.readFile.length,
      latencyByMethod: {
        readFile: summarizeLatency(latencies.readFile),
        access: summarizeLatency(latencies.access),
        readDirectory: summarizeLatency(latencies.readDirectory),
        statFile: summarizeLatency(latencies.statFile),
        statDirectory: summarizeLatency(latencies.statDirectory),
      },
      baseline,
      afterMeasured,
      afterStress,
      cleanup,
      statProof: {
        file: statFileProof,
        directory: statDirectoryProof,
      },
      gatewayDiagnostics,
    } satisfies RunResult;
  } catch (error) {
    throw new Error(
      `${variant} run ${run} failed: ${error instanceof Error ? error.message : String(error)}\n${runtime.readLogs()}`,
      { cause: error },
    );
  } finally {
    for (const connection of connections.splice(0)) {
      connection.socket.close();
    }
    await stopServer(runtime.child);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensumi-go-file-rpc-profile-'));
  try {
    const filePath = path.join(directory, 'payload.bin');
    const content = Uint8Array.from({ length: options.fileBytes }, (_, index) => index % 251);
    await writeFile(filePath, content);
    const results: RunResult[] = [];
    for (let run = 1; run <= options.runs; run += 1) {
      const variants: Variant[] = run % 2 === 1 ? ['node', 'gateway'] : ['gateway', 'node'];
      for (const variant of variants) {
        results.push(await runVariant(variant, run, options, filePath, content));
      }
    }
    for (let run = 1; run <= options.runs; run += 1) {
      const nodeProof = results.find((result) => result.variant === 'node' && result.run === run)?.statProof;
      const gatewayProof = results.find((result) => result.variant === 'gateway' && result.run === run)?.statProof;
      if (!nodeProof || !gatewayProof || JSON.stringify(nodeProof) !== JSON.stringify(gatewayProof)) {
        throw new Error(
          `Node/Go stat parity failed in run ${run}: ${JSON.stringify({ node: nodeProof, gateway: gatewayProof })}`,
        );
      }
    }
    const node = results.filter((result) => result.variant === 'node');
    const gateway = results.filter((result) => result.variant === 'gateway');
    const nodeP95 = median(node.map((result) => result.latencyP95Ms));
    const gatewayP95 = median(gateway.map((result) => result.latencyP95Ms));
    const nodeAccessP95 = median(node.map((result) => result.latencyByMethod.access.p95Ms));
    const gatewayAccessP95 = median(gateway.map((result) => result.latencyByMethod.access.p95Ms));
    const nodeReadDirectoryP95 = median(node.map((result) => result.latencyByMethod.readDirectory.p95Ms));
    const gatewayReadDirectoryP95 = median(gateway.map((result) => result.latencyByMethod.readDirectory.p95Ms));
    const nodeStatFileP95 = median(node.map((result) => result.latencyByMethod.statFile.p95Ms));
    const gatewayStatFileP95 = median(gateway.map((result) => result.latencyByMethod.statFile.p95Ms));
    const nodeStatDirectoryP95 = median(node.map((result) => result.latencyByMethod.statDirectory.p95Ms));
    const gatewayStatDirectoryP95 = median(gateway.map((result) => result.latencyByMethod.statDirectory.p95Ms));
    const nodeTreeRSS = median(node.map((result) => result.afterStress.totalRssBytes));
    const gatewayTreeRSS = median(gateway.map((result) => result.afterStress.totalRssBytes));
    const nodeServerRSS = median(node.map((result) => result.afterStress.byRole.server?.rssBytes || 0));
    const gatewayNodeServerRSS = median(gateway.map((result) => result.afterStress.byRole.server?.rssBytes || 0));
    const directFileRPCCount = gateway.reduce(
      (sum, result) => sum + (result.gatewayDiagnostics?.directFileRPCs || 0),
      0,
    );
    const output = {
      schemaVersion: 3,
      type: 'go-file-rpc-profile',
      status: 'pass',
      platform: process.platform,
      architecture: process.arch,
      options,
      results,
      comparison: {
        nodeP95Ms: nodeP95,
        gatewayP95Ms: gatewayP95,
        latencyChangeRatio: (gatewayP95 - nodeP95) / nodeP95,
        nodeAccessP95Ms: nodeAccessP95,
        gatewayAccessP95Ms: gatewayAccessP95,
        accessLatencyChangeRatio: (gatewayAccessP95 - nodeAccessP95) / nodeAccessP95,
        nodeReadDirectoryP95Ms: nodeReadDirectoryP95,
        gatewayReadDirectoryP95Ms: gatewayReadDirectoryP95,
        readDirectoryLatencyChangeRatio: (gatewayReadDirectoryP95 - nodeReadDirectoryP95) / nodeReadDirectoryP95,
        nodeStatFileP95Ms: nodeStatFileP95,
        gatewayStatFileP95Ms: gatewayStatFileP95,
        statFileLatencyChangeRatio: (gatewayStatFileP95 - nodeStatFileP95) / nodeStatFileP95,
        nodeStatDirectoryP95Ms: nodeStatDirectoryP95,
        gatewayStatDirectoryP95Ms: gatewayStatDirectoryP95,
        statDirectoryLatencyChangeRatio: (gatewayStatDirectoryP95 - nodeStatDirectoryP95) / nodeStatDirectoryP95,
        nodeAfterStressTreeRssBytes: nodeTreeRSS,
        gatewayAfterStressTreeRssBytes: gatewayTreeRSS,
        wholeTreeRssChangeRatio: (gatewayTreeRSS - nodeTreeRSS) / nodeTreeRSS,
        nodeServerAfterStressRssBytes: nodeServerRSS,
        gatewayNodeServerAfterStressRssBytes: gatewayNodeServerRSS,
        nodeServerRssChangeRatio: (gatewayNodeServerRSS - nodeServerRSS) / nodeServerRSS,
        directFileRPCCount,
      },
    };
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(output.comparison, null, 2)}\n`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});

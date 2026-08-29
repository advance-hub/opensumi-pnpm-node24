import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { collectProcessTreeMemory } from '../server/scripts/process-tree.ts';
import { hasRunnableWsGatewayPackage, resolveWsGatewayMode } from '../server/src/ws-gateway-defaults.ts';

import type { ProcessTreeMemorySnapshot } from '../server/scripts/process-tree.ts';
import type { Browser, Locator, Page } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '..');
const searchQuery = 'OPENSUMI_WORKSPACE_AGENT_PRODUCT_SMOKE';
const expectedSearchResult = '2 results found in 2 files';
const fileSearchQuery = 'workspace-agent-file-search-proof';
const fileSearchProofFileName = 'workspace-agent-file-search-proof.md';
const fileSearchProofContent = 'Workspace Agent File Search opened this nested proof file.';
const watchProofFileName = 'workspace-agent-watch-proof.txt';
const recoverySearchQuery = 'OPENSUMI_WORKSPACE_AGENT_RECOVERY_SEARCH';
const expectedRecoverySearchResult = '1 results found in 1 files';
const secondRecoverySearchQuery = 'OPENSUMI_WORKSPACE_AGENT_SECOND_RECOVERY_SEARCH';
const expectedSecondRecoverySearchResult = '2 results found in 2 files';
const exhaustedSearchQuery = 'OPENSUMI_WORKSPACE_AGENT_EXHAUSTED_NODE_SEARCH';
const expectedExhaustedSearchResult = '3 results found in 3 files';
const recoveryWatchProofFileName = 'workspace-agent-recovery-watch-proof.txt';
const expectedFallbackConsoleMessage =
  'Workspace Agent watcher failed and the connection was moved to the Node watcher';
const fatalServerLogMarkers = ['Uncaught Exception:', 'UnhandledPromiseRejection', 'unhandledRejection'];

interface SmokeOptions {
  port?: number;
  headless: boolean;
  keepWorkspace: boolean;
  outputPath: string;
  screenshotPath: string;
  useServerDefaults: boolean;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}

interface WorkspaceAgentReadiness {
  configured: {
    watch: 'off' | 'shadow-read' | 'enabled';
    search: 'off' | 'shadow-read' | 'enabled';
    fileSearch: 'off' | 'shadow-read' | 'enabled';
  };
  state:
    | 'idle'
    | 'starting'
    | 'running'
    | 'restart-backoff'
    | 'restart-ready'
    | 'exhausted'
    | 'disposed'
    | 'disabled'
    | 'diagnostic-unavailable';
  degraded: boolean;
  affectsReadiness: false;
  pid?: number;
  protocol?: { major: number; minor: number };
  services?: string[];
  buildRevision?: string;
  activeStreams?: number;
  sharedWatches?: number;
  restart?: {
    failuresInWindow: number;
    maxFailuresPerWindow: number;
    windowMs: number;
    retryAfterMs: number;
  };
}

interface ReadinessResponse {
  status?: string;
  ready?: boolean;
  workspaceAgent?: WorkspaceAgentReadiness;
}

interface WsGatewayHealthSnapshot {
  configured?: boolean;
  state?: 'disabled' | 'starting' | 'running' | 'failed' | 'stopped';
  degraded?: boolean;
  affectsReadiness?: boolean;
  pid?: number;
  channelMode?: string;
  directFileRPC?: boolean;
  error?: string;
}

interface WsGatewayDiagnostics {
  directFileRPCEnabled: boolean;
  directFileRPCs: number;
  directFileReads: number;
  directFileReadBytes: number;
  directFileAccesses: number;
  directDirectoryReads: number;
  directFileStats: number;
  directFileMetadataMaxBytes: number;
  browserFramesForwarded: number;
  nodeFramesForwarded: number;
}

interface WorkspaceAgentPackageEvidence {
  schemaVersion: number;
  protocolMajor: number;
  protocolMinor: number;
  services: string[];
  goos: string;
  goarch: string;
  revision: string;
  binary: string;
  sha256: string;
  nativeStartupVerified: boolean;
}

interface WorkspaceSearchEvidence {
  latencyMs: number;
  inputResetRetries: number;
}

interface WorkspaceFileSearchEvidence {
  latencyMs: number;
  fileName: string;
  contentVerified: boolean;
}

interface SmokeArtifacts {
  browser?: Browser;
  page?: Page;
  server?: ReturnType<typeof spawn>;
  serverLogTail: string;
  workspacePath?: string;
}

function usage(): string {
  return [
    'Usage: pnpm smoke:workspace-agent:product -- [options]',
    '',
    'Options:',
    '  --port <number>       Server port, defaults to a free loopback port',
    '  --output <path>       JSON result path',
    '  --screenshot <path>   Browser proof screenshot path',
    '  --headed              Show the browser window',
    '  --keep-workspace      Keep the generated temporary workspace',
    '  --use-server-defaults Omit per-service overrides and verify packaged auto-rollout',
  ].join('\n');
}

function parsePositivePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be an integer from 1 through 65535');
  }
  return port;
}

function parseOptions(argv: string[]): SmokeOptions | undefined {
  argv = argv.filter((argument) => argument !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }

  let port: number | undefined;
  let headless = true;
  let keepWorkspace = false;
  let useServerDefaults = false;
  let outputPath = path.join(repoRoot, `output/workspace-agent/product-smoke-${process.platform}.json`);
  let screenshotPath = path.join(repoRoot, `output/playwright/workspace-agent-product-smoke-${process.platform}.png`);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--headed') {
      headless = false;
      continue;
    }
    if (option === '--keep-workspace') {
      keepWorkspace = true;
      continue;
    }
    if (option === '--use-server-defaults') {
      useServerDefaults = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}`);
    }
    if (option === '--port') {
      port = parsePositivePort(value);
    } else if (option === '--output') {
      outputPath = path.resolve(repoRoot, value);
    } else if (option === '--screenshot') {
      screenshotPath = path.resolve(repoRoot, value);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
    index += 1;
  }
  return { port, headless, keepWorkspace, outputPath, screenshotPath, useServerDefaults };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function appendLog(current: string, chunk: Buffer | string): string {
  const maximumLength = 128 * 1024;
  const next = current + String(chunk);
  return next.length <= maximumLength ? next : next.slice(next.length - maximumLength);
}

async function findFreePort(): Promise<number> {
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

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) {
      return;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function ensureClassicLayout(page: Page, timeoutMs = 30_000): Promise<void> {
  const searchActivity = page.locator('#opensumi-left-tabbar #search');
  const openClassicLayout = page.getByText('Open IDE layout', { exact: true });

  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('#opensumi-left-tabbar #search')) ||
      Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).some(
        (element) => element.innerText.trim() === 'Open IDE layout',
      ),
    undefined,
    { timeout: timeoutMs },
  );

  if (!(await searchActivity.isVisible().catch(() => false))) {
    await openClassicLayout.click({ timeout: timeoutMs });
    await searchActivity.waitFor({ state: 'visible', timeout: timeoutMs });
  }

  const aiChatSlot = page.locator('.AI-Chat-slot').first();
  if (await aiChatSlot.isVisible().catch(() => false)) {
    const closeButtons = page.locator(
      '#ai-chat-header-close [role="button"], #ai_right_panel_header_close [role="button"]',
    );
    for (let index = 0; index < (await closeButtons.count()); index += 1) {
      const closeButton = closeButtons.nth(index);
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click();
        await aiChatSlot.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        break;
      }
    }
  }
}

async function revealActivityView(page: Page, viewId: string, target: Locator, timeoutMs = 30_000): Promise<void> {
  const activity = page.locator(`#opensumi-left-tabbar #${viewId}`);
  await activity.waitFor({ state: 'visible', timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await target.isVisible()) {
      return;
    }
    await activity.click();
    try {
      await target.waitFor({ state: 'visible', timeout: Math.min(1_500, Math.max(1, deadline - Date.now())) });
      return;
    } catch {
      // Startup contributions can restore another view after the first click; retry the same visible activity item.
    }
  }
  throw new Error(`Workbench activity ${viewId} did not reveal its target within ${timeoutMs}ms`);
}

async function runWorkspaceSearch(
  page: Page,
  searchBox: Locator,
  query: string,
  expectedResult: string,
): Promise<WorkspaceSearchEvidence> {
  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
  let inputResetRetries = 0;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    await revealActivityView(page, 'search', searchBox, Math.min(30_000, remainingMs));
    await searchBox.fill(query);
    await searchBox.press('Enter');

    let outcome: 'result' | 'input-reset';
    try {
      const handle = await page.waitForFunction(
        ({ expected, submittedQuery }) => {
          if (document.body.innerText.includes(expected)) {
            return 'result';
          }
          const input = document.querySelector<HTMLInputElement>('#search-input-field');
          if (!input || input.value !== submittedQuery) {
            return 'input-reset';
          }
          return false;
        },
        { expected: expectedResult, submittedQuery: query },
        { timeout: Math.max(1, deadline - Date.now()) },
      );
      outcome = (await handle.jsonValue()) as 'result' | 'input-reset';
      await handle.dispose();
    } catch (error) {
      throw new Error(
        `Workspace Search did not reach ${JSON.stringify(expectedResult)} within 60000ms after ${inputResetRetries} input-reset retries: ${errorText(error)}`,
        { cause: error },
      );
    }
    if (outcome === 'result') {
      return { latencyMs: Date.now() - startedAt, inputResetRetries };
    }
    inputResetRetries += 1;
  }

  throw new Error(
    `Workspace Search did not reach ${JSON.stringify(expectedResult)} within 60000ms after ${inputResetRetries} input-reset retries`,
  );
}

async function runWorkspaceFileSearch(page: Page): Promise<WorkspaceFileSearchEvidence> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
  const input = page.locator('#opensumi-quickpick-input');
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.fill('');
  const startedAt = Date.now();
  await input.fill(fileSearchQuery);
  const result = page.getByLabel(fileSearchProofFileName, { exact: true }).first();
  await result.waitFor({ state: 'visible', timeout: 30_000 });
  const latencyMs = Date.now() - startedAt;
  await result.click();
  await input.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForFunction(
    (expected) => document.body.innerText.replace(/\s+/g, ' ').includes(expected),
    fileSearchProofContent,
    { timeout: 30_000 },
  );
  return { latencyMs, fileName: fileSearchProofFileName, contentVerified: true };
}

async function waitForHealth(port: number, server: ReturnType<typeof spawn>): Promise<void> {
  await waitUntil(
    async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(
          `OpenSumi server exited before becoming healthy (code ${server.exitCode}, signal ${server.signalCode})`,
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        const body = (await response.json()) as { status?: string };
        return response.ok && body.status === 'ok';
      } catch {
        return false;
      }
    },
    30_000,
    'OpenSumi server did not become healthy within 30 seconds',
  );
}

async function readReadiness(port: number): Promise<ReadinessResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
    signal: AbortSignal.timeout(2_000),
  });
  const body = (await response.json()) as ReadinessResponse;
  if (!response.ok || body.status !== 'ready' || body.ready !== true) {
    throw new Error(`OpenSumi readiness unexpectedly failed (${response.status} ${JSON.stringify(body)})`);
  }
  return body;
}

async function readWsGatewayHealth(port: number): Promise<WsGatewayHealthSnapshot | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { wsGateway?: WsGatewayHealthSnapshot };
  return body.wsGateway;
}

async function readWsGatewayDiagnostics(port: number): Promise<WsGatewayDiagnostics> {
  const response = await fetch(`http://127.0.0.1:${port}/_opensumi/ws-gateway`, {
    signal: AbortSignal.timeout(2_000),
  });
  const body = (await response.json()) as WsGatewayDiagnostics;
  if (
    !response.ok ||
    body.directFileRPCEnabled !== true ||
    !Number.isSafeInteger(body.directFileRPCs) ||
    body.directFileRPCs < 3 ||
    !Number.isSafeInteger(body.directFileReads) ||
    body.directFileReads < 1 ||
    !Number.isSafeInteger(body.directFileReadBytes) ||
    body.directFileReadBytes < fileSearchProofContent.length ||
    !Number.isSafeInteger(body.directFileAccesses) ||
    body.directFileAccesses < 1 ||
    !Number.isSafeInteger(body.directDirectoryReads) ||
    !Number.isSafeInteger(body.directFileStats) ||
    body.directFileStats < 1 ||
    body.directFileMetadataMaxBytes !== 1024 * 1024
  ) {
    throw new Error(`Go WS Gateway did not prove direct file RPCs (${response.status} ${JSON.stringify(body)})`);
  }
  return body;
}

function assertWorkspaceAgentReadiness(
  body: ReadinessResponse,
  expectedStates: WorkspaceAgentReadiness['state'][],
  expectedPid?: number,
): WorkspaceAgentReadiness {
  const status = body.workspaceAgent;
  if (!status) {
    throw new Error('Readiness response did not include Workspace Agent diagnostics');
  }
  if (
    status.configured.watch !== 'enabled' ||
    status.configured.search !== 'enabled' ||
    status.configured.fileSearch !== 'enabled'
  ) {
    throw new Error(`Readiness reported unexpected Workspace Agent modes: ${JSON.stringify(status.configured)}`);
  }
  if (!expectedStates.includes(status.state)) {
    throw new Error(
      `Readiness reported Workspace Agent state ${status.state}, expected ${expectedStates.join(' or ')}`,
    );
  }
  if (status.affectsReadiness !== false) {
    throw new Error('Workspace Agent diagnostics unexpectedly affect Node readiness');
  }
  if (expectedPid !== undefined && status.pid !== expectedPid) {
    throw new Error(`Readiness reported Workspace Agent PID ${status.pid}, expected ${expectedPid}`);
  }
  return status;
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function terminateServer(child: ReturnType<typeof spawn>): Promise<ChildExit> {
  let forced = false;
  if (!(await waitForChildExit(child, 0))) {
    child.kill('SIGTERM');
    if (!(await waitForChildExit(child, 8_000))) {
      forced = true;
      child.kill('SIGKILL');
      if (!(await waitForChildExit(child, 3_000))) {
        throw new Error(`OpenSumi server process ${child.pid} did not exit`);
      }
    }
  }
  return { code: child.exitCode, signal: child.signalCode, forced };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function assertAgentProcess(
  snapshot: ProcessTreeMemorySnapshot,
  expectedWatcherHostCount = 0,
): { pid: number; transport: string } {
  const agentProcesses = snapshot.processes.filter((record) => record.role === 'workspace-agent');
  if (agentProcesses.length !== 1) {
    throw new Error(`Expected exactly one Workspace Agent, found ${agentProcesses.length}`);
  }
  const watcherHostCount = snapshot.byRole['watcher-host']?.count || 0;
  if (watcherHostCount !== expectedWatcherHostCount) {
    throw new Error(`Expected ${expectedWatcherHostCount} Node watcher host(s), found ${watcherHostCount}`);
  }

  const agent = agentProcesses[0];
  const transport = process.platform === 'win32' ? '--tcp 127.0.0.1:0' : '--socket';
  if (!agent.commandLine.includes(transport)) {
    throw new Error(`Workspace Agent command line does not contain the expected transport ${transport}`);
  }
  return { pid: agent.pid, transport };
}

function assertNodeFallbackProcess(snapshot: ProcessTreeMemorySnapshot): void {
  const agentCount = snapshot.byRole['workspace-agent']?.count || 0;
  const watcherHostCount = snapshot.byRole['watcher-host']?.count || 0;
  if (agentCount !== 0 || watcherHostCount !== 1) {
    throw new Error(
      `Expected no Workspace Agent and one Node watcher, found ${agentCount} Agent(s) and ${watcherHostCount} watcher(s)`,
    );
  }
}

async function writeResult(outputPath: string, result: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

async function runSmoke(options: SmokeOptions): Promise<void> {
  const startedAt = Date.now();
  const port = options.port || (await findFreePort());
  const serverEntry = path.join(repoRoot, 'server/dist/main.js');
  const clientEntry = path.join(repoRoot, 'client/dist/index.html');
  const agentBinary = path.join(
    repoRoot,
    'server/dist/workspace-agent',
    process.platform === 'win32' ? 'workspace-agent.exe' : 'workspace-agent',
  );
  const agentManifest = path.join(repoRoot, 'server/dist/workspace-agent/workspace-agent.manifest.json');
  await Promise.all([serverEntry, clientEntry, agentBinary, agentManifest].map((filePath) => access(filePath)));
  const agentPackage = JSON.parse(await readFile(agentManifest, 'utf8')) as WorkspaceAgentPackageEvidence;
  const expectedGoos = process.platform === 'win32' ? 'windows' : process.platform;
  const expectedGoarch = process.arch === 'x64' ? 'amd64' : process.arch;
  if (
    agentPackage.schemaVersion !== 1 ||
    agentPackage.protocolMajor !== 1 ||
    agentPackage.protocolMinor !== 1 ||
    !Array.isArray(agentPackage.services) ||
    !agentPackage.services.includes('workspace.watch.v1') ||
    !agentPackage.services.includes('workspace.search.v1') ||
    !agentPackage.services.includes('workspace.fileSearch.v1') ||
    agentPackage.goos !== expectedGoos ||
    agentPackage.goarch !== expectedGoarch ||
    agentPackage.binary !== path.basename(agentBinary) ||
    typeof agentPackage.revision !== 'string' ||
    agentPackage.revision.length === 0 ||
    !/^[a-f0-9]{64}$/.test(agentPackage.sha256) ||
    agentPackage.nativeStartupVerified !== true
  ) {
    throw new Error(`Workspace Agent package evidence is invalid for this host: ${JSON.stringify(agentPackage)}`);
  }
  if (await isPortOpen(port)) {
    throw new Error(`Loopback port ${port} is already in use`);
  }

  await Promise.all([
    mkdir(path.dirname(options.outputPath), { recursive: true }),
    mkdir(path.dirname(options.screenshotPath), { recursive: true }),
  ]);

  const artifacts: SmokeArtifacts = { serverLogTail: '' };
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let agentPid: number | undefined;
  let shutdown: ChildExit | undefined;
  let wsGatewayResolution: { mode: 'gateway' | 'direct'; source: 'explicit' | 'default' } | undefined;
  let wsGatewayObserved: WsGatewayHealthSnapshot | undefined;
  try {
    artifacts.workspacePath = await mkdtemp(path.join(os.tmpdir(), 'opensumi-workspace-agent-product-'));
    await mkdir(path.join(artifacts.workspacePath, 'nested'), { recursive: true });
    await Promise.all([
      writeFile(path.join(artifacts.workspacePath, 'search-proof-a.txt'), `${searchQuery}\n`),
      writeFile(path.join(artifacts.workspacePath, 'nested/search-proof-b.txt'), `${searchQuery}\n`),
      writeFile(path.join(artifacts.workspacePath, 'nested', fileSearchProofFileName), `${fileSearchProofContent}\n`),
      writeFile(path.join(artifacts.workspacePath, 'recovery-search-proof.txt'), `${recoverySearchQuery}\n`),
      writeFile(
        path.join(artifacts.workspacePath, 'second-recovery-search-proof-a.txt'),
        `${secondRecoverySearchQuery}\n`,
      ),
      writeFile(
        path.join(artifacts.workspacePath, 'nested/second-recovery-search-proof-b.txt'),
        `${secondRecoverySearchQuery}\n`,
      ),
      writeFile(path.join(artifacts.workspacePath, 'exhausted-search-proof-a.txt'), `${exhaustedSearchQuery}\n`),
      writeFile(path.join(artifacts.workspacePath, 'nested/exhausted-search-proof-b.txt'), `${exhaustedSearchQuery}\n`),
      writeFile(path.join(artifacts.workspacePath, 'exhausted-search-proof-c.txt'), `${exhaustedSearchQuery}\n`),
    ]);

    const workspaceAgentModes = options.useServerDefaults
      ? {}
      : {
          OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: 'enabled',
          OPENSUMI_WORKSPACE_AGENT_WATCH_MODE: 'enabled',
          OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE: 'enabled',
        };
    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=512',
      PORT: String(port),
      ...workspaceAgentModes,
      EXTENSION_HOST_IDLE_TIMEOUT: '1000',
      EXTENSION_HOST_SHUTDOWN_TIMEOUT: '1000',
      TERMINAL_IDLE_TIMEOUT: '1000',
      TERMINAL_PERSISTENT_SESSION_TIMEOUT: '1000',
    };
    const serverStartedAt = Date.now();
    artifacts.server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    artifacts.server.stdout?.on('data', (chunk) => {
      artifacts.serverLogTail = appendLog(artifacts.serverLogTail, chunk);
    });
    artifacts.server.stderr?.on('data', (chunk) => {
      artifacts.serverLogTail = appendLog(artifacts.serverLogTail, chunk);
    });
    artifacts.server.once('error', (error) => {
      artifacts.serverLogTail = appendLog(artifacts.serverLogTail, `\n${errorText(error)}\n`);
    });
    await waitForHealth(port, artifacts.server);
    const serverReadyMs = Date.now() - serverStartedAt;
    wsGatewayResolution = resolveWsGatewayMode(serverEnv, hasRunnableWsGatewayPackage(repoRoot, serverEnv));
    wsGatewayObserved = await readWsGatewayHealth(port);
    if (wsGatewayResolution.mode === 'direct' && wsGatewayObserved?.state === 'running') {
      throw new Error('WS Gateway is running although the resolved entrypoint mode is direct Node sockets');
    }
    const wsGatewayRunning = wsGatewayObserved?.state === 'running';
    const wsGatewayFallbackError = wsGatewayRunning ? undefined : wsGatewayObserved?.error;

    const browserStartedAt = Date.now();
    artifacts.browser = await chromium.launch({ headless: options.headless });
    artifacts.page = await artifacts.browser.newPage({ viewport: { width: 1440, height: 900 } });
    artifacts.page.on('console', (message) => {
      if (message.type() === 'error' && consoleErrors.length < 30) {
        consoleErrors.push(message.text());
      }
    });
    artifacts.page.on('pageerror', (error) => {
      if (pageErrors.length < 30) {
        pageErrors.push(error.message);
      }
    });
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set('workspaceDir', artifacts.workspacePath);
    await artifacts.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await artifacts.page.waitForFunction(
      (expectedTitle) => document.title === expectedTitle,
      `${path.basename(artifacts.workspacePath)} — OpenSumi`,
      { timeout: 30_000 },
    );
    const browserReadyMs = Date.now() - browserStartedAt;

    await ensureClassicLayout(artifacts.page);
    const searchBox = artifacts.page.getByRole('textbox', { name: 'Enter search content' });
    const searchEvidence = await runWorkspaceSearch(artifacts.page, searchBox, searchQuery, expectedSearchResult);
    const fileSearchEvidence = await runWorkspaceFileSearch(artifacts.page);
    const gatewayDirectFileRPCExpected =
      wsGatewayRunning && (serverEnv.OPENSUMI_WS_GATEWAY_FILE_RPC_MODE || 'enabled') === 'enabled';

    await artifacts.page.locator('#opensumi-left-tabbar #explorer').click();
    await artifacts.page.waitForFunction(() => document.body.innerText.split('\n').includes('EXPLORER'), undefined, {
      timeout: 30_000,
    });
    const watchProofPath = path.join(artifacts.workspacePath, watchProofFileName);
    const watchAddStartedAt = Date.now();
    await writeFile(watchProofPath, 'Workspace Agent watch add proof\n');
    await artifacts.page.waitForFunction(
      (fileName) => document.body.innerText.split('\n').includes(fileName),
      watchProofFileName,
      { timeout: 10_000 },
    );
    const watchAddLatencyMs = Date.now() - watchAddStartedAt;
    const wsGatewayDiagnostics = gatewayDirectFileRPCExpected ? await readWsGatewayDiagnostics(port) : undefined;
    await artifacts.page.screenshot({ path: options.screenshotPath, fullPage: true });

    const watchDeleteStartedAt = Date.now();
    await rm(watchProofPath);
    await artifacts.page.waitForFunction(
      (fileName) => !document.body.innerText.split('\n').includes(fileName),
      watchProofFileName,
      { timeout: 10_000 },
    );
    const watchDeleteLatencyMs = Date.now() - watchDeleteStartedAt;
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `Browser reported ${consoleErrors.length} console error(s) and ${pageErrors.length} page error(s)`,
      );
    }

    const activeSnapshot = await collectProcessTreeMemory(artifacts.server.pid!);
    const agent = assertAgentProcess(activeSnapshot);
    agentPid = agent.pid;
    const activeReadiness = await readReadiness(port);
    const activeAgentReadiness = assertWorkspaceAgentReadiness(activeReadiness, ['running'], agent.pid);
    if (
      activeAgentReadiness.degraded ||
      activeAgentReadiness.protocol?.major !== 1 ||
      !activeAgentReadiness.services?.includes('workspace.watch.v1') ||
      !activeAgentReadiness.services.includes('workspace.search.v1') ||
      !activeAgentReadiness.services.includes('workspace.fileSearch.v1') ||
      activeAgentReadiness.buildRevision !== agentPackage.revision ||
      !activeAgentReadiness.activeStreams ||
      !activeAgentReadiness.sharedWatches
    ) {
      throw new Error(
        `Readiness did not report a healthy active Workspace Agent: ${JSON.stringify(activeAgentReadiness)}`,
      );
    }

    process.kill(agent.pid, 'SIGTERM');
    await waitUntil(() => !isProcessAlive(agent.pid), 8_000, `Workspace Agent process ${agent.pid} did not exit`);
    let fallbackSnapshot: ProcessTreeMemorySnapshot | undefined;
    await waitUntil(
      async () => {
        fallbackSnapshot = await collectProcessTreeMemory(artifacts.server!.pid!);
        return (
          (fallbackSnapshot.byRole['workspace-agent']?.count || 0) === 0 &&
          (fallbackSnapshot.byRole['watcher-host']?.count || 0) === 1 &&
          consoleErrors.some((message) => message.includes(expectedFallbackConsoleMessage))
        );
      },
      15_000,
      'The active Watch connection did not converge to one Node watcher after the Agent crash',
    );
    const fallbackReadiness = await readReadiness(port);
    const fallbackAgentReadiness = assertWorkspaceAgentReadiness(fallbackReadiness, [
      'restart-backoff',
      'restart-ready',
    ]);
    if (
      !fallbackAgentReadiness.degraded ||
      fallbackAgentReadiness.pid !== undefined ||
      fallbackAgentReadiness.restart?.failuresInWindow !== 1
    ) {
      throw new Error(
        `Readiness did not report the Workspace Agent fallback state: ${JSON.stringify(fallbackAgentReadiness)}`,
      );
    }

    const recoverySearchEvidence = await runWorkspaceSearch(
      artifacts.page,
      searchBox,
      recoverySearchQuery,
      expectedRecoverySearchResult,
    );
    const recoveredSnapshot = await collectProcessTreeMemory(artifacts.server.pid!);
    const recoveredAgent = assertAgentProcess(recoveredSnapshot, 1);
    if (recoveredAgent.pid === agent.pid) {
      throw new Error(`Workspace Agent restart reused the exited PID ${agent.pid}`);
    }
    agentPid = recoveredAgent.pid;
    const recoveredReadiness = await readReadiness(port);
    const recoveredAgentReadiness = assertWorkspaceAgentReadiness(recoveredReadiness, ['running'], recoveredAgent.pid);
    if (recoveredAgentReadiness.degraded || recoveredAgentReadiness.restart?.failuresInWindow !== 1) {
      throw new Error(
        `Readiness did not report the recovered Workspace Agent and retained restart evidence: ${JSON.stringify(recoveredAgentReadiness)}`,
      );
    }

    await artifacts.page.locator('#opensumi-left-tabbar #explorer').click();
    const recoveryWatchProofPath = path.join(artifacts.workspacePath, recoveryWatchProofFileName);
    const recoveryWatchAddStartedAt = Date.now();
    await writeFile(recoveryWatchProofPath, 'Node fallback watch add proof\n');
    await artifacts.page.waitForFunction(
      (fileName) => document.body.innerText.split('\n').includes(fileName),
      recoveryWatchProofFileName,
      { timeout: 10_000 },
    );
    const recoveryWatchAddLatencyMs = Date.now() - recoveryWatchAddStartedAt;
    await artifacts.page.screenshot({ path: options.screenshotPath, fullPage: true });
    const recoveryWatchDeleteStartedAt = Date.now();
    await rm(recoveryWatchProofPath);
    await artifacts.page.waitForFunction(
      (fileName) => !document.body.innerText.split('\n').includes(fileName),
      recoveryWatchProofFileName,
      { timeout: 10_000 },
    );
    const recoveryWatchDeleteLatencyMs = Date.now() - recoveryWatchDeleteStartedAt;

    process.kill(recoveredAgent.pid, 'SIGTERM');
    await waitUntil(
      () => !isProcessAlive(recoveredAgent.pid),
      8_000,
      `Second Workspace Agent process ${recoveredAgent.pid} did not exit`,
    );
    let secondFallbackSnapshot: ProcessTreeMemorySnapshot | undefined;
    let secondFallbackReadiness: ReadinessResponse | undefined;
    await waitUntil(
      async () => {
        secondFallbackSnapshot = await collectProcessTreeMemory(artifacts.server!.pid!);
        const agentCount = secondFallbackSnapshot.byRole['workspace-agent']?.count || 0;
        const watcherCount = secondFallbackSnapshot.byRole['watcher-host']?.count || 0;
        secondFallbackReadiness = await readReadiness(port);
        return (
          agentCount === 0 &&
          watcherCount === 1 &&
          ['restart-backoff', 'restart-ready'].includes(secondFallbackReadiness.workspaceAgent?.state || '')
        );
      },
      15_000,
      'The second Agent crash did not converge to the bounded-restart fallback state',
    );
    assertNodeFallbackProcess(secondFallbackSnapshot!);
    const secondFallbackAgentReadiness = assertWorkspaceAgentReadiness(secondFallbackReadiness!, [
      'restart-backoff',
      'restart-ready',
    ]);
    if (
      !secondFallbackAgentReadiness.degraded ||
      secondFallbackAgentReadiness.pid !== undefined ||
      secondFallbackAgentReadiness.restart?.failuresInWindow !== 2
    ) {
      throw new Error(
        `Readiness did not report the second Workspace Agent failure: ${JSON.stringify(secondFallbackAgentReadiness)}`,
      );
    }

    const secondRecoverySearchEvidence = await runWorkspaceSearch(
      artifacts.page,
      searchBox,
      secondRecoverySearchQuery,
      expectedSecondRecoverySearchResult,
    );
    const secondRecoveredSnapshot = await collectProcessTreeMemory(artifacts.server.pid!);
    const secondRecoveredAgent = assertAgentProcess(secondRecoveredSnapshot, 1);
    if (secondRecoveredAgent.pid === agent.pid || secondRecoveredAgent.pid === recoveredAgent.pid) {
      throw new Error(`Second Workspace Agent restart reused an exited PID ${secondRecoveredAgent.pid}`);
    }
    agentPid = secondRecoveredAgent.pid;
    const secondRecoveredReadiness = await readReadiness(port);
    const secondRecoveredAgentReadiness = assertWorkspaceAgentReadiness(
      secondRecoveredReadiness,
      ['running'],
      secondRecoveredAgent.pid,
    );
    if (secondRecoveredAgentReadiness.degraded || secondRecoveredAgentReadiness.restart?.failuresInWindow !== 2) {
      throw new Error(
        `Readiness did not report the second recovered Agent: ${JSON.stringify(secondRecoveredAgentReadiness)}`,
      );
    }

    process.kill(secondRecoveredAgent.pid, 'SIGTERM');
    await waitUntil(
      () => !isProcessAlive(secondRecoveredAgent.pid),
      8_000,
      `Third Workspace Agent process ${secondRecoveredAgent.pid} did not exit`,
    );
    let exhaustedSnapshot: ProcessTreeMemorySnapshot | undefined;
    let exhaustedReadiness: ReadinessResponse | undefined;
    await waitUntil(
      async () => {
        exhaustedSnapshot = await collectProcessTreeMemory(artifacts.server!.pid!);
        const agentCount = exhaustedSnapshot.byRole['workspace-agent']?.count || 0;
        const watcherCount = exhaustedSnapshot.byRole['watcher-host']?.count || 0;
        exhaustedReadiness = await readReadiness(port);
        return agentCount === 0 && watcherCount === 1 && exhaustedReadiness.workspaceAgent?.state === 'exhausted';
      },
      15_000,
      'The third Agent crash did not exhaust the server-scoped restart budget',
    );
    assertNodeFallbackProcess(exhaustedSnapshot!);
    const exhaustedAgentReadiness = assertWorkspaceAgentReadiness(exhaustedReadiness!, ['exhausted']);
    if (
      !exhaustedAgentReadiness.degraded ||
      exhaustedAgentReadiness.pid !== undefined ||
      exhaustedAgentReadiness.restart?.failuresInWindow !== 3
    ) {
      throw new Error(
        `Readiness did not report the exhausted Workspace Agent budget: ${JSON.stringify(exhaustedAgentReadiness)}`,
      );
    }

    const exhaustedSearchEvidence = await runWorkspaceSearch(
      artifacts.page,
      searchBox,
      exhaustedSearchQuery,
      expectedExhaustedSearchResult,
    );
    const exhaustedSearchSnapshot = await collectProcessTreeMemory(artifacts.server.pid!);
    assertNodeFallbackProcess(exhaustedSearchSnapshot);
    const exhaustedSearchReadiness = await readReadiness(port);
    const exhaustedSearchAgentReadiness = assertWorkspaceAgentReadiness(exhaustedSearchReadiness, ['exhausted']);
    if (exhaustedSearchAgentReadiness.restart?.failuresInWindow !== 3) {
      throw new Error(
        `Node fallback Search changed the exhausted restart budget: ${JSON.stringify(exhaustedSearchAgentReadiness)}`,
      );
    }

    const expectedRecoveryConsoleErrors = consoleErrors.filter((message) =>
      message.includes(expectedFallbackConsoleMessage),
    );
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !message.includes(expectedFallbackConsoleMessage),
    );
    if (expectedRecoveryConsoleErrors.length !== 1 || unexpectedConsoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `Browser reported ${expectedRecoveryConsoleErrors.length} expected recovery error(s), ${unexpectedConsoleErrors.length} unexpected console error(s) and ${pageErrors.length} page error(s)`,
      );
    }

    await artifacts.browser.close();
    artifacts.browser = undefined;
    artifacts.page = undefined;
    const browserCloseStartedAt = Date.now();
    let postBrowserCloseSnapshot: ProcessTreeMemorySnapshot | undefined;
    await waitUntil(
      async () => {
        postBrowserCloseSnapshot = await collectProcessTreeMemory(artifacts.server!.pid!);
        return (['workspace-agent', 'watcher-host', 'extension-host', 'pty-host', 'terminal-shell'] as const).every(
          (role) => (postBrowserCloseSnapshot!.byRole[role]?.count || 0) === 0,
        );
      },
      15_000,
      'Browser-owned fallback watcher, Extension Host or terminal process was not reclaimed within 15 seconds',
    );
    const browserCloseCleanupMs = Date.now() - browserCloseStartedAt;
    const postBrowserCloseReadiness = await readReadiness(port);
    const postBrowserCloseAgentReadiness = assertWorkspaceAgentReadiness(postBrowserCloseReadiness, ['exhausted']);
    if (postBrowserCloseAgentReadiness.activeStreams !== 0 || postBrowserCloseAgentReadiness.sharedWatches !== 0) {
      throw new Error(
        `Workspace Agent diagnostics retained streams after browser cleanup: ${JSON.stringify(postBrowserCloseAgentReadiness)}`,
      );
    }

    shutdown = await terminateServer(artifacts.server);
    await waitUntil(() => !isProcessAlive(agentPid!), 8_000, `Workspace Agent process ${agentPid} was not reclaimed`);
    await waitUntil(
      async () => !(await isPortOpen(port)),
      5_000,
      `OpenSumi server port ${port} remained open after shutdown`,
    );
    const fatalServerLogMarker = fatalServerLogMarkers.find((marker) => artifacts.serverLogTail.includes(marker));
    if (fatalServerLogMarker) {
      throw new Error(`Server emitted fatal runtime error marker ${JSON.stringify(fatalServerLogMarker)}`);
    }

    const result = {
      schemaVersion: 6,
      type: 'workspace-agent-product-smoke',
      status: 'pass',
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      port,
      agentPackage,
      workspaceAgentModeSource: options.useServerDefaults ? 'packaged-auto-rollout' : 'explicit-enabled',
      wsGateway: {
        resolvedMode: wsGatewayResolution?.mode,
        modeSource: wsGatewayResolution?.source,
        running: wsGatewayObserved?.state === 'running',
        observedState: wsGatewayObserved?.state,
        fallbackError: wsGatewayFallbackError,
        directFileRPCExpected: gatewayDirectFileRPCExpected,
        diagnostics: wsGatewayDiagnostics,
      },
      workspacePath: options.keepWorkspace ? artifacts.workspacePath : undefined,
      search: {
        query: searchQuery,
        expectedResult: expectedSearchResult,
        ...searchEvidence,
      },
      fileSearch: {
        query: fileSearchQuery,
        expectedResult: fileSearchProofFileName,
        ...fileSearchEvidence,
      },
      watch: {
        fileName: watchProofFileName,
        addLatencyMs: watchAddLatencyMs,
        deleteLatencyMs: watchDeleteLatencyMs,
      },
      recovery: {
        crashedAgentPid: agent.pid,
        fallbackSnapshot,
        search: {
          query: recoverySearchQuery,
          expectedResult: expectedRecoverySearchResult,
          ...recoverySearchEvidence,
        },
        restartedAgentPid: recoveredAgent.pid,
        recoveredSnapshot,
        nodeFallbackWatch: {
          fileName: recoveryWatchProofFileName,
          addLatencyMs: recoveryWatchAddLatencyMs,
          deleteLatencyMs: recoveryWatchDeleteLatencyMs,
        },
        restartBudget: {
          secondCrashedAgentPid: recoveredAgent.pid,
          secondFallbackSnapshot,
          secondRecoverySearch: {
            query: secondRecoverySearchQuery,
            expectedResult: expectedSecondRecoverySearchResult,
            ...secondRecoverySearchEvidence,
          },
          secondRestartedAgentPid: secondRecoveredAgent.pid,
          secondRecoveredSnapshot,
          exhaustedCrashedAgentPid: secondRecoveredAgent.pid,
          exhaustedSnapshot,
          nodeFallbackSearch: {
            query: exhaustedSearchQuery,
            expectedResult: expectedExhaustedSearchResult,
            ...exhaustedSearchEvidence,
            snapshot: exhaustedSearchSnapshot,
          },
        },
      },
      runtime: {
        serverPid: artifacts.server.pid,
        serverReadyMs,
        browserReadyMs,
        agentPid,
        agentTransport: agent.transport,
        wsGatewayDiagnostics,
        activeSnapshot,
        postBrowserCloseSnapshot,
        readiness: {
          active: activeReadiness,
          fallback: fallbackReadiness,
          recovered: recoveredReadiness,
          secondFallback: secondFallbackReadiness,
          secondRecovered: secondRecoveredReadiness,
          exhausted: exhaustedReadiness,
          exhaustedNodeSearch: exhaustedSearchReadiness,
          postBrowserClose: postBrowserCloseReadiness,
        },
      },
      cleanup: {
        browserCloseCleanupMs,
        browserChildrenReclaimed: true,
        serverExit: shutdown,
        agentReclaimed: true,
        portClosed: true,
      },
      browser: {
        consoleErrors,
        expectedRecoveryConsoleErrors,
        unexpectedConsoleErrors,
        pageErrors,
        screenshotPath: path.relative(repoRoot, options.screenshotPath),
      },
      durationMs: Date.now() - startedAt,
      serverLogTail: artifacts.serverLogTail,
    };
    await writeResult(options.outputPath, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    let pageDiagnostics: unknown;
    if (artifacts.page) {
      pageDiagnostics = await Promise.all([
        artifacts.page.title(),
        artifacts.page
          .locator('body')
          .innerText()
          .then((text) => text.slice(0, 8_000)),
        artifacts.page.locator('input').evaluateAll((inputs) =>
          inputs.map((input) => ({
            ariaLabel: input.getAttribute('aria-label'),
            value: (input as HTMLInputElement).value,
          })),
        ),
      ])
        .then(([title, bodyText, inputs]) => ({ title, url: artifacts.page!.url(), bodyText, inputs }))
        .catch(() => undefined);
      await artifacts.page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => undefined);
    }
    await writeResult(options.outputPath, {
      schemaVersion: 6,
      type: 'workspace-agent-product-smoke',
      status: 'fail',
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      port,
      workspaceAgentModeSource: options.useServerDefaults ? 'packaged-auto-rollout' : 'explicit-enabled',
      workspacePath: options.keepWorkspace ? artifacts.workspacePath : undefined,
      agentPid,
      wsGateway: { resolution: wsGatewayResolution, observed: wsGatewayObserved },
      error: errorText(error),
      pageDiagnostics,
      browser: { consoleErrors, pageErrors, screenshotPath: path.relative(repoRoot, options.screenshotPath) },
      durationMs: Date.now() - startedAt,
      serverLogTail: artifacts.serverLogTail,
    });
    throw error;
  } finally {
    if (artifacts.browser?.isConnected()) {
      await artifacts.browser.close().catch(() => undefined);
    }
    if (artifacts.server && artifacts.server.exitCode === null && artifacts.server.signalCode === null) {
      await terminateServer(artifacts.server).catch(() => undefined);
    }
    if (artifacts.workspacePath && !options.keepWorkspace) {
      await rm(artifacts.workspacePath, {
        force: true,
        recursive: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options) {
    await runSmoke(options);
  }
}

void main().catch((error) => {
  process.stderr.write(`${errorText(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});

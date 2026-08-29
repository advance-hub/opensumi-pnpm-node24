import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { collectProcessTreeMemory } from '../server/scripts/process-tree';
import { percentile, summarizeRuntimeProfile } from '../server/scripts/runtime-profile-metrics';

import type { ProcessTreeMemorySnapshot } from '../server/scripts/process-tree';
import type { Browser, Locator, Page } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '..');
const resultPattern = /\d+ results found in \d+ files/;

interface BrowserProfileOptions {
  rootPid: number;
  url: string;
  sessions: number;
  batchSize: number;
  query: string;
  expectedResult: string;
  fileSearchQuery: string;
  expectedFileSearchResult: string;
  variant: 'node' | 'agent';
  run: number;
  durationMs: number;
  intervalMs: number;
  warmupMs: number;
  pageReadyMs: number;
  cleanupWaitMs: number;
  outputPath: string;
}

interface BrowserErrorEvidence {
  session: number;
  source: 'console' | 'pageerror';
  message: string;
  url?: string;
}

interface ExtensionHostRuntimeHealth {
  active: number;
  disconnected: number;
  clientServiceProxies: number;
  mainThreadConnections: number;
  limit: number;
  saturated: boolean;
  counters: {
    created: number;
    crashed: number;
    disposed: number;
    reclaimed: number;
    rejected: number;
    startupTimeouts: number;
  };
  activationDiagnostics?: {
    reportedHosts: number;
    topExtensions: Array<{
      extensionId: string;
      reportingHosts: number;
      activationCount: number;
      failureCount: number;
      maxActivationDurationMs: number;
      maxModuleCount: number;
      maxSubscriptionCount: number;
      maxObservedHeapUsedBytes: number;
      maxObservedRssBytes: number;
      maxPositiveHeapUsedDeltaBytes: number;
      maxPositiveRssDeltaBytes: number;
    }>;
  };
}

const maximumBrowserErrorEvidence = 50;
const maximumBrowserErrorMessageLength = 2 * 1024;
const knownNonWorkloadConsoleErrors = new Set(['Displaying error: No data available for the selected range']);

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

function usage(): string {
  return [
    'Usage: pnpm profile:browser-runtime -- --pid <pid> --variant <node|agent> --sessions <count> --run <number> --expected-result <text> --file-search-query <text> --expected-file-search-result <file> [options]',
    '',
    'The client and production server must already be running. The profiler opens',
    'real Chromium tabs, verifies workspace Search and Quick Open results, samples the',
    'server process tree, closes Chromium and records a post-close snapshot.',
    '',
    'Options:',
    '  --url <url>               Client URL, default http://127.0.0.1:8080',
    '  --query <text>            Search query, default ServerApp',
    '  --file-search-query <text>  Quick Open file-name query',
    '  --expected-file-search-result <file>  Exact accessible file-name result',
    '  --batch-size <count>      Tabs opened concurrently, default 3',
    '  --duration <seconds>      Process-tree sampling duration, default 8',
    '  --interval <ms>           Sampling interval, default 1000',
    '  --warmup <seconds>        Wait after search before sampling, default 20',
    '  --page-ready <ms>         Per-page UI settling window, default 1800',
    '  --cleanup-wait <ms>       Cleanup deadline after browser close, default 20000',
    '  --output <path>           JSONL path; defaults under output/runtime-profiles',
  ].join('\n');
}

function positiveInteger(name: string, value: string | undefined, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): BrowserProfileOptions | undefined {
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
    values.set(option, value);
  }
  const knownOptions = new Set([
    '--pid',
    '--url',
    '--sessions',
    '--batch-size',
    '--query',
    '--expected-result',
    '--file-search-query',
    '--expected-file-search-result',
    '--variant',
    '--run',
    '--duration',
    '--interval',
    '--warmup',
    '--page-ready',
    '--cleanup-wait',
    '--output',
  ]);
  const unknownOptions = Array.from(values.keys()).filter((option) => !knownOptions.has(option));
  if (unknownOptions.length > 0) {
    throw new Error(`Unknown options: ${unknownOptions.join(', ')}`);
  }
  const variant = values.get('--variant');
  if (variant !== 'node' && variant !== 'agent') {
    throw new Error('--variant must be node or agent');
  }
  const sessions = positiveInteger('--sessions', values.get('--sessions'));
  const run = positiveInteger('--run', values.get('--run'));
  const expectedResult = values.get('--expected-result');
  if (!expectedResult || !resultPattern.test(expectedResult)) {
    throw new Error('--expected-result must look like "104 results found in 21 files"');
  }
  const fileSearchQuery = values.get('--file-search-query')?.trim();
  if (!fileSearchQuery) {
    throw new Error('--file-search-query must be a non-empty Quick Open query');
  }
  const expectedFileSearchResult = values.get('--expected-file-search-result')?.trim();
  if (!expectedFileSearchResult) {
    throw new Error('--expected-file-search-result must be a non-empty exact file name');
  }
  const outputPath = values.get('--output')
    ? path.resolve(repoRoot, values.get('--output')!)
    : path.join(repoRoot, `output/runtime-profiles/${variant}-s${sessions}-r${run}.jsonl`);
  return {
    rootPid: positiveInteger('--pid', values.get('--pid')),
    url: values.get('--url') || 'http://127.0.0.1:8080',
    sessions,
    batchSize: positiveInteger('--batch-size', values.get('--batch-size'), 3),
    query: values.get('--query') || 'ServerApp',
    expectedResult,
    fileSearchQuery,
    expectedFileSearchResult,
    variant,
    run,
    durationMs: positiveInteger('--duration', values.get('--duration'), 8) * 1000,
    intervalMs: positiveInteger('--interval', values.get('--interval'), 1000),
    warmupMs: positiveInteger('--warmup', values.get('--warmup'), 20) * 1000,
    pageReadyMs: positiveInteger('--page-ready', values.get('--page-ready'), 1800),
    cleanupWaitMs: positiveInteger('--cleanup-wait', values.get('--cleanup-wait'), 20_000),
    outputPath,
  };
}

async function openSession(
  browser: Browser,
  options: BrowserProfileOptions,
  onBrowserError: (error: Omit<BrowserErrorEvidence, 'session'>) => void,
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      onBrowserError({ source: 'console', message: message.text(), url: message.location().url || undefined });
    }
  });
  page.on('pageerror', (error) => onBrowserError({ source: 'pageerror', message: error.message }));
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => document.title.endsWith('— OpenSumi'), undefined, { timeout: 30_000 });
  await page.waitForTimeout(options.pageReadyMs);
  const searchBox = page.getByRole('textbox', { name: 'Enter search content' });
  await revealActivityView(page, 'search', searchBox);
  return page;
}

async function searchAndVerify(page: Page, options: BrowserProfileOptions): Promise<number> {
  const input = page.getByRole('textbox', { name: 'Enter search content' });
  const startedAt = Date.now();
  await input.fill(options.query);
  await input.press('Enter');
  await page.waitForFunction(
    (expectedResult) => document.body.innerText.includes(expectedResult),
    options.expectedResult,
    { timeout: 60_000 },
  );
  return Date.now() - startedAt;
}

async function clearSearch(page: Page): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Enter search content' });
  await input.fill('');
  await input.press('Enter');
  await page.waitForFunction(() => !/\d+ results found in \d+ files/.test(document.body.innerText), undefined, {
    timeout: 10_000,
  });
}

async function fileSearchAndVerify(page: Page, options: BrowserProfileOptions): Promise<number> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
  const input = page.locator('#opensumi-quickpick-input');
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.fill('');
  const startedAt = Date.now();
  await input.fill(options.fileSearchQuery);
  await page.getByLabel(options.expectedFileSearchResult, { exact: true }).first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  const latencyMs = Date.now() - startedAt;
  await page.keyboard.press('Escape');
  await input.waitFor({ state: 'hidden', timeout: 10_000 });
  return latencyMs;
}

function isCleanupSettled(snapshot: ProcessTreeMemorySnapshot, variant: BrowserProfileOptions['variant']): boolean {
  // Server-side residents (the server itself, the packaged WS Gateway and the
  // Workspace Agent on the agent variant) survive a browser close by design;
  // everything else must be reclaimed.
  return snapshot.processes.every(
    (process) =>
      process.role === 'server' ||
      process.role === 'ws-gateway' ||
      (variant === 'agent' && (process.role === 'workspace-agent' || process.role === 'workspace-agent-child')),
  );
}

function assertRuntimeTopology(snapshot: ProcessTreeMemorySnapshot, variant: BrowserProfileOptions['variant']): void {
  const agentCount = snapshot.byRole['workspace-agent']?.count || 0;
  const gatewayCount = snapshot.byRole['ws-gateway']?.count || 0;
  const watcherCount = snapshot.byRole['watcher-host']?.count || 0;
  // The gateway is the packaged product default since 10.17: the node
  // comparison baseline must stay on direct sockets, while the agent variant
  // carries exactly one gateway alongside its Workspace Agent.
  if (variant === 'node' && gatewayCount !== 0) {
    throw new Error(`Node capacity profile unexpectedly started ${gatewayCount} WS Gateway process(es)`);
  }
  if (variant === 'agent' && gatewayCount > 1) {
    throw new Error(`Agent capacity profile started ${gatewayCount} WS Gateway process(es)`);
  }
  if (variant === 'agent' && (agentCount !== 1 || watcherCount !== 0)) {
    throw new Error(
      `Agent profile requires exactly one Workspace Agent and no Node watcher: ${JSON.stringify(snapshot.byRole)}`,
    );
  }
  if (variant === 'node' && agentCount !== 0) {
    throw new Error(`Node profile unexpectedly started ${agentCount} Workspace Agent process(es)`);
  }
}

async function readExtensionHostHealth(url: string): Promise<ExtensionHostRuntimeHealth> {
  const healthUrl = new URL('/readyz', url);
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`Extension Host health request failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { extensionHost?: ExtensionHostRuntimeHealth };
  if (!body.extensionHost?.counters) {
    throw new Error('Extension Host health response is missing lifecycle counters');
  }
  return body.extensionHost;
}

function assertHealthyExtensionHosts(
  health: ExtensionHostRuntimeHealth,
  expectedActive: number,
  phase: 'active' | 'post-close',
): void {
  const { crashed, rejected, startupTimeouts } = health.counters;
  if (
    health.active !== expectedActive ||
    health.disconnected !== 0 ||
    health.clientServiceProxies !== expectedActive ||
    health.mainThreadConnections !== expectedActive ||
    crashed !== 0 ||
    rejected !== 0 ||
    startupTimeouts !== 0
  ) {
    throw new Error(`Extension Host ${phase} health gate failed: ${JSON.stringify(health)}`);
  }
}

async function waitForCleanup(
  rootPid: number,
  variant: BrowserProfileOptions['variant'],
  timeoutMs: number,
): Promise<{ snapshot: ProcessTreeMemorySnapshot; elapsedMs: number; settled: boolean }> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let snapshot = await collectProcessTreeMemory(rootPid);
  while (!isCleanupSettled(snapshot, variant) && Date.now() < deadline) {
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
    snapshot = await collectProcessTreeMemory(rootPid);
  }
  return {
    snapshot,
    elapsedMs: Date.now() - startedAt,
    settled: isCleanupSettled(snapshot, variant),
  };
}

async function runProfile(options: BrowserProfileOptions): Promise<void> {
  if (options.intervalMs > options.durationMs) {
    throw new Error('--interval cannot be greater than --duration');
  }
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, '');
  const emit = async (event: unknown) => {
    const line = `${JSON.stringify(event)}\n`;
    process.stdout.write(line);
    await appendFile(options.outputPath, line);
  };

  let consoleErrorCount = 0;
  let observedBrowserErrorCount = 0;
  let acceptingBrowserErrors = true;
  const browserErrors: BrowserErrorEvidence[] = [];
  const ignoredBrowserErrors: BrowserErrorEvidence[] = [];
  const recordBrowserError = (session: number, error: Omit<BrowserErrorEvidence, 'session'>) => {
    if (!acceptingBrowserErrors) {
      return;
    }
    observedBrowserErrorCount += 1;
    const evidence = {
      session,
      source: error.source,
      message: error.message.slice(0, maximumBrowserErrorMessageLength),
      ...(error.url ? { url: error.url } : {}),
    };
    if (error.source === 'console' && knownNonWorkloadConsoleErrors.has(error.message)) {
      if (ignoredBrowserErrors.length < maximumBrowserErrorEvidence) {
        ignoredBrowserErrors.push(evidence);
      }
      return;
    }
    consoleErrorCount += 1;
    if (browserErrors.length < maximumBrowserErrorEvidence) {
      browserErrors.push(evidence);
    }
  };
  const browser = await chromium.launch({ headless: true });
  const pages: Page[] = [];
  try {
    for (let offset = 0; offset < options.sessions; offset += options.batchSize) {
      const count = Math.min(options.batchSize, options.sessions - offset);
      pages.push(
        ...(await Promise.all(
          Array.from({ length: count }, (_, batchIndex) =>
            openSession(browser, options, (error) => recordBrowserError(offset + batchIndex + 1, error)),
          ),
        )),
      );
    }

    // First search proves the expected final result. The measured second search
    // uses an already-initialized UI and runtime on both variants.
    await Promise.all(pages.map((page) => searchAndVerify(page, options)));
    await Promise.all(pages.map(clearSearch));
    const searchLatenciesMs = await Promise.all(pages.map((page) => searchAndVerify(page, options)));
    await Promise.all(pages.map((page) => fileSearchAndVerify(page, options)));
    const fileSearchLatenciesMs = await Promise.all(pages.map((page) => fileSearchAndVerify(page, options)));
    await emit({
      schemaVersion: 2,
      type: 'browser-workload-ready',
      variant: options.variant,
      sessions: options.sessions,
      run: options.run,
      url: options.url,
      query: options.query,
      expectedResult: options.expectedResult,
      fileSearchQuery: options.fileSearchQuery,
      expectedFileSearchResult: options.expectedFileSearchResult,
      searchLatencyP50Ms: percentile(searchLatenciesMs, 0.5),
      searchLatencyP95Ms: percentile(searchLatenciesMs, 0.95),
      fileSearchLatencyP50Ms: percentile(fileSearchLatenciesMs, 0.5),
      fileSearchLatencyP95Ms: percentile(fileSearchLatenciesMs, 0.95),
      consoleErrorCount,
      observedBrowserErrorCount,
      browserErrors,
      ignoredBrowserErrors,
    });
    if (consoleErrorCount > 0) {
      throw new Error(
        `Browser workload reported ${consoleErrorCount} console or page error(s): ${JSON.stringify(browserErrors)}`,
      );
    }

    await delay(options.warmupMs);
    const samples: ProcessTreeMemorySnapshot[] = [];
    const deadline = Date.now() + options.durationMs;
    do {
      const sample = await collectProcessTreeMemory(options.rootPid);
      assertRuntimeTopology(sample, options.variant);
      samples.push(sample);
      await emit({
        schemaVersion: 2,
        type: 'sample',
        label: 'real-browser-search-and-file-search',
        variant: options.variant,
        sessions: options.sessions,
        run: options.run,
        ...sample,
      });
      if (Date.now() < deadline) {
        await delay(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
      }
    } while (Date.now() < deadline);

    const activeExtensionHostHealth = await readExtensionHostHealth(options.url);
    assertHealthyExtensionHosts(activeExtensionHostHealth, options.sessions, 'active');
    acceptingBrowserErrors = false;
    await browser.close();
    const cleanup = await waitForCleanup(options.rootPid, options.variant, options.cleanupWaitMs);
    const cleanupSnapshot = cleanup.snapshot;
    const postCloseExtensionHostHealth = await readExtensionHostHealth(options.url);
    assertHealthyExtensionHosts(postCloseExtensionHostHealth, 0, 'post-close');
    await emit({
      schemaVersion: 4,
      type: 'summary',
      label: 'real-browser-search-and-file-search',
      variant: options.variant,
      sessions: options.sessions,
      run: options.run,
      rootPid: options.rootPid,
      searchLatencyP50Ms: percentile(searchLatenciesMs, 0.5),
      searchLatencyP95Ms: percentile(searchLatenciesMs, 0.95),
      fileSearchLatencyP50Ms: percentile(fileSearchLatenciesMs, 0.5),
      fileSearchLatencyP95Ms: percentile(fileSearchLatenciesMs, 0.95),
      consoleErrorCount,
      observedBrowserErrorCount,
      browserErrors,
      ignoredBrowserErrors,
      extensionHost: {
        active: activeExtensionHostHealth,
        postClose: postCloseExtensionHostHealth,
      },
      ...summarizeRuntimeProfile(samples),
      postCloseTreeRssBytes: cleanupSnapshot.totalRssBytes,
      postCloseProcessCount: cleanupSnapshot.processCount,
      postCloseByRole: cleanupSnapshot.byRole,
      postCloseCleanupMs: cleanup.elapsedMs,
      postCloseSettled: cleanup.settled,
    });
    if (consoleErrorCount > 0) {
      throw new Error(
        `Browser workload reported ${consoleErrorCount} console or page error(s): ${JSON.stringify(browserErrors)}`,
      );
    }
    if (!cleanup.settled) {
      throw new Error(
        `Browser workload child processes did not exit within ${options.cleanupWaitMs}ms: ${JSON.stringify(cleanupSnapshot.byRole)}`,
      );
    }
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options) {
    await runProfile(options);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CancellationTokenSource } from '@opensumi/ide-core-common';

import {
  WorkspaceAgentClient,
  WorkspaceAgentLifecycleContribution,
  createWorkspaceAgentLaunchOptions,
  nodeArchitectureToGoarch,
  nodePlatformToGoos,
  parseWorkspaceAgentMode,
  parseWorkspaceAgentReadyLine,
  validateWorkspaceAgentCapabilities,
  validateWorkspaceAgentPackage,
  validateWorkspaceAgentReadyAddress,
  waitForExit,
  waitForReadyAnnouncement,
} from '../../src/node/workspace-agent';

describe('WorkspaceAgentClient protocol gates', () => {
  it('keeps the agent off for unset and unknown modes', () => {
    expect.assertions(4);
    expect(parseWorkspaceAgentMode(undefined)).toBe('off');
    expect(parseWorkspaceAgentMode('unexpected')).toBe('off');
    expect(parseWorkspaceAgentMode('shadow-read')).toBe('shadow-read');
    expect(parseWorkspaceAgentMode('enabled')).toBe('enabled');
  });

  it('accepts a compatible capability response', () => {
    expect.assertions(1);
    expect(() =>
      validateWorkspaceAgentCapabilities(
        {
          protocolMajor: 1,
          protocolMinor: 0,
          services: ['workspace.watch.v1'],
          buildRevision: 'test',
        },
        'workspace.watch.v1',
      ),
    ).not.toThrow();
  });

  it('uses an ephemeral loopback transport on Windows and an exact socket elsewhere', () => {
    expect.assertions(6);
    expect(createWorkspaceAgentLaunchOptions('win32')).toEqual({
      arguments: ['--tcp', '127.0.0.1:0'],
    });
    expect(createWorkspaceAgentLaunchOptions('linux', '/tmp/agent.sock')).toEqual({
      arguments: ['--socket', '/tmp/agent.sock'],
      expectedAddress: 'unix:/tmp/agent.sock',
    });
    expect(() => createWorkspaceAgentLaunchOptions('linux')).toThrow('absolute Unix socket');
    expect(() => createWorkspaceAgentLaunchOptions('linux', 'agent.sock')).toThrow('absolute Unix socket');
    expect(nodePlatformToGoos('win32')).toBe('windows');
    expect(nodeArchitectureToGoarch('x64')).toBe('amd64');
  });

  it('accepts only the expected private ready announcement', () => {
    expect.assertions(5);
    const windows = parseWorkspaceAgentReadyLine(
      '{"event":"workspace-agent-ready","transport":"tcp-loopback","address":"127.0.0.1:43123"}',
    )!;
    const unix = parseWorkspaceAgentReadyLine(
      '{"event":"workspace-agent-ready","transport":"unix","address":"unix:/tmp/agent.sock"}',
    )!;
    expect(validateWorkspaceAgentReadyAddress(windows, 'win32')).toBe('127.0.0.1:43123');
    expect(validateWorkspaceAgentReadyAddress(unix, 'linux', 'unix:/tmp/agent.sock')).toBe('unix:/tmp/agent.sock');
    expect(() => validateWorkspaceAgentReadyAddress({ ...windows, address: '0.0.0.0:43123' }, 'win32')).toThrow(
      'non-private Windows address',
    );
    expect(() => validateWorkspaceAgentReadyAddress(unix, 'linux', 'unix:/tmp/other.sock')).toThrow(
      'unexpected Unix address',
    );
    expect(parseWorkspaceAgentReadyLine('not-json')).toBeUndefined();
  });

  it('bounds an unterminated ready announcement and removes startup listeners', async () => {
    expect.assertions(4);
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      exitCode: null,
      signalCode: null,
    });

    const ready = waitForReadyAnnouncement(child as any);
    stdout.emit('data', 'x'.repeat(64 * 1024 + 1));

    await expect(ready).rejects.toThrow('ready announcement exceeded 65536 bytes');
    expect(stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('removes the child exit listener when a bounded wait times out', async () => {
    expect.assertions(2);
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });

    await expect(waitForExit(child as any, 1)).resolves.toBe(false);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('rejects incompatible protocols and missing services', () => {
    expect.assertions(2);
    expect(() =>
      validateWorkspaceAgentCapabilities(
        { protocolMajor: 2, protocolMinor: 0, services: ['workspace.watch.v1'], buildRevision: 'test' },
        'workspace.watch.v1',
      ),
    ).toThrow('protocol major');
    expect(() =>
      validateWorkspaceAgentCapabilities(
        { protocolMajor: 1, protocolMinor: 0, services: [], buildRevision: 'test' },
        'workspace.watch.v1',
      ),
    ).toThrow('does not provide');
  });

  it('shares equivalent watches across connections and exclude order', () => {
    expect.assertions(1);
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    const first = client.watchKey({
      workspaceId: 'first-connection',
      rootPath: '/workspace',
      recursive: true,
      excludes: ['**/.git/**', '**/node_modules/**'],
    });
    const second = client.watchKey({
      workspaceId: 'second-connection',
      rootPath: '/workspace',
      recursive: true,
      excludes: ['**/node_modules/**', '**/.git/**'],
    });

    expect(second).toBe(first);
  });

  it('multiplexes 50 logical workspace sessions onto one native watch', async () => {
    expect.assertions(6);
    const stream = Object.assign(new EventEmitter(), { cancel: jest.fn() });
    const upstreamWatch = jest.fn().mockReturnValue(stream);
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      watcher: { watch: upstreamWatch },
      token: 'test-token',
      getActiveRuntime: jest.fn().mockResolvedValue({
        child: { pid: 123 },
        token: 'test-token',
        watcher: { watch: upstreamWatch },
        searchClient: {},
      }),
      logger: { debug: jest.fn() },
      streams: new Set(),
      sharedWatches: new Map(),
      sharedWatchSubscriberSequence: 1,
    });

    const handles = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        client.watch(
          {
            workspaceId: `session-${index}`,
            rootPath: '/workspace',
            recursive: true,
            excludes: ['**/node_modules/**', '**/.git/**'],
          },
          { onEvent: jest.fn(), onError: jest.fn(), onEnd: jest.fn() },
        ),
      ),
    );

    expect(upstreamWatch).toHaveBeenCalledTimes(1);
    expect(client.sharedWatches.size).toBe(1);
    expect(client.streams.size).toBe(1);
    handles.slice(0, -1).forEach((handle) => handle.dispose());
    expect(stream.cancel).not.toHaveBeenCalled();
    handles.at(-1)!.dispose();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(client.streams.size).toBe(0);
  });

  it('untracks an explicitly cancelled search even without a terminal stream event', async () => {
    expect.assertions(3);
    const stream = Object.assign(new EventEmitter(), { cancel: jest.fn() });
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      getActiveRuntime: jest.fn().mockResolvedValue({
        child: { pid: 123 },
        token: 'test-token',
        watcher: {},
        searchClient: { search: jest.fn().mockReturnValue(stream) },
      }),
      streams: new Set(),
    });

    const handle = await client.search({ requestId: 1 }, { onEvent: jest.fn(), onError: jest.fn(), onEnd: jest.fn() });
    expect(client.streams.size).toBe(1);
    handle.dispose();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(client.streams.size).toBe(0);
  });

  it('collects file search batches and cancels the gRPC stream with the caller token', async () => {
    expect.assertions(5);
    const stream = Object.assign(new EventEmitter(), { cancel: jest.fn() });
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      getActiveRuntime: jest.fn().mockResolvedValue({
        child: { pid: 123 },
        token: 'test-token',
        watcher: {},
        searchClient: {},
        fileSearchClient: { find: jest.fn().mockReturnValue(stream) },
      }),
      streams: new Set(),
    });
    const tokenSource = new CancellationTokenSource();
    const result = client.fileSearch({ pattern: 'server' }, tokenSource.token);
    await Promise.resolve();

    stream.emit('data', { exactPaths: ['/workspace/server.ts'], fuzzyPaths: ['/workspace/s-e-r-v-e-r.ts'] });
    expect(client.streams.size).toBe(1);
    tokenSource.cancel();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    stream.emit('error', { code: 1 });

    await expect(result).resolves.toEqual({
      exactPaths: ['/workspace/server.ts'],
      fuzzyPaths: ['/workspace/s-e-r-v-e-r.ts'],
      limitHit: false,
    });
    expect(client.streams.size).toBe(0);
    expect(stream.listenerCount('data')).toBe(0);
    tokenSource.dispose();
  });

  it('explicitly cancels shared watches during disposal after untracking them', async () => {
    expect.assertions(5);
    const stream = Object.assign(new EventEmitter(), { cancel: jest.fn() });
    const streams = new Set([stream]);
    const untrack = jest.fn(() => streams.delete(stream));
    const subscribers = new Map([[1, { onEvent: jest.fn(), onError: jest.fn(), onEnd: jest.fn() }]]);
    const sharedWatches = new Map([
      [
        'watch-key',
        {
          key: 'watch-key',
          stream,
          untrack,
          subscribers,
          ended: false,
        },
      ],
    ]);
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      disposed: false,
      sharedWatches,
      streams,
      cleanupTasks: new Set(),
    });

    await client.dispose();

    expect(untrack).toHaveBeenCalledTimes(1);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(subscribers.size).toBe(0);
    expect(sharedWatches.size).toBe(0);
    expect(client.streams.size).toBe(0);
  });

  it('does not poison a healthy runtime when only one optional service is unavailable', async () => {
    expect.assertions(3);
    const child = { pid: 123, exitCode: null, signalCode: null };
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      disposed: false,
      permanentlyUnavailable: false,
      child,
      capabilities: {
        protocolMajor: 1,
        protocolMinor: 0,
        services: ['workspace.watch.v1'],
        buildRevision: 'test',
      },
    });

    await expect(client.ensureStarted('workspace.search.v1')).rejects.toThrow('does not provide');
    expect(client.permanentlyUnavailable).toBe(false);
    expect(client.child).toBe(child);
  });

  it('allows two bounded retries and stops launch churn after the third failure in one minute', () => {
    expect.assertions(7);
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      disposed: false,
      permanentlyUnavailable: false,
      failureTimestamps: [],
      lastHandledFailureAttempt: 0,
      logger: { warn: jest.fn(), error: jest.fn() },
      restartNotBefore: 0,
    });

    client.recordFailure(1, new Error('first'));
    expect(client.permanentlyUnavailable).toBe(false);
    expect(client.restartNotBefore).toBeGreaterThan(Date.now());
    client.recordFailure(1, new Error('duplicate callback'));
    expect(client.failureTimestamps).toHaveLength(1);
    client.recordFailure(2, new Error('second'));
    expect(client.permanentlyUnavailable).toBe(false);
    client.recordFailure(1, new Error('stale callback'));
    expect(client.failureTimestamps).toHaveLength(2);
    client.recordFailure(3, new Error('third'));
    expect(client.permanentlyUnavailable).toBe(true);
    expect(client.logger.error).toHaveBeenCalledTimes(1);
  });

  it('reports a secret-free running status for health diagnostics', () => {
    expect.assertions(2);
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      disposed: false,
      permanentlyUnavailable: false,
      startPromise: undefined,
      child: { pid: 321, exitCode: null, signalCode: null },
      capabilities: {
        protocolMajor: 1,
        protocolMinor: 2,
        services: ['workspace.watch.v1', 'workspace.search.v1'],
        buildRevision: 'status-test',
      },
      token: 'must-not-leak',
      socketDirectory: '/private/must-not-leak',
      streams: new Set([{}]),
      sharedWatches: new Map([['watch-key', {}]]),
      failureTimestamps: [9_900],
      restartNotBefore: 0,
    });

    const status = client.getStatus(10_000);

    expect(status).toEqual({
      state: 'running',
      pid: 321,
      protocol: { major: 1, minor: 2 },
      services: ['workspace.watch.v1', 'workspace.search.v1'],
      buildRevision: 'status-test',
      activeStreams: 1,
      sharedWatches: 1,
      restart: {
        failuresInWindow: 1,
        maxFailuresPerWindow: 3,
        windowMs: 60_000,
        retryAfterMs: 0,
      },
    });
    expect(JSON.stringify(status)).not.toMatch(/must-not-leak/);
  });

  it('distinguishes restart backoff from a server-scoped exhausted budget', () => {
    expect.assertions(2);
    const client = Object.create(WorkspaceAgentClient.prototype) as any;
    Object.assign(client, {
      disposed: false,
      permanentlyUnavailable: false,
      startPromise: undefined,
      child: undefined,
      capabilities: undefined,
      streams: new Set(),
      sharedWatches: new Map(),
      failureTimestamps: [9_900],
      restartNotBefore: 10_250,
    });

    expect(client.getStatus(10_000)).toMatchObject({
      state: 'restart-backoff',
      services: [],
      restart: { failuresInWindow: 1, retryAfterMs: 250 },
    });
    client.permanentlyUnavailable = true;
    expect(client.getStatus(10_000)).toMatchObject({ state: 'exhausted' });
  });

  it('stops the server-scoped agent during server shutdown', async () => {
    expect.assertions(1);
    const dispose = jest.fn().mockResolvedValue(undefined);
    const contribution = Object.create(WorkspaceAgentLifecycleContribution.prototype) as any;
    Object.defineProperty(contribution, 'workspaceAgent', { value: { dispose } });

    await contribution.onStop();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('verifies a packaged agent platform and checksum before execution', () => {
    expect.assertions(2);
    const directory = mkdtempSync(path.join(tmpdir(), 'opensumi-agent-package-test-'));
    const binaryPath = path.join(directory, 'workspace-agent');
    const binary = Buffer.from('workspace-agent-test-binary');
    writeFileSync(binaryPath, binary);
    writeFileSync(
      path.join(directory, 'workspace-agent.manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        protocolMajor: 1,
        protocolMinor: 0,
        services: ['workspace.watch.v1', 'workspace.search.v1'],
        goos: nodePlatformToGoos(process.platform),
        goarch: nodeArchitectureToGoarch(process.arch),
        revision: 'test',
        binary: 'workspace-agent',
        sha256: createHash('sha256').update(binary).digest('hex'),
      }),
    );

    try {
      expect(validateWorkspaceAgentPackage(binaryPath)?.revision).toBe('test');
      writeFileSync(binaryPath, 'tampered');
      expect(() => validateWorkspaceAgentPackage(binaryPath)).toThrow('checksum');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires a manifest for production packages but permits raw development binaries', () => {
    expect.assertions(3);
    const directory = mkdtempSync(path.join(tmpdir(), 'opensumi-agent-manifest-test-'));
    const binaryPath = path.join(directory, 'workspace-agent');
    const previousNodeEnvironment = process.env.NODE_ENV;
    const previousConfiguredPath = process.env.OPENSUMI_WORKSPACE_AGENT_PATH;
    writeFileSync(binaryPath, 'workspace-agent-development-binary');

    try {
      expect(validateWorkspaceAgentPackage(binaryPath)).toBeUndefined();
      expect(() => validateWorkspaceAgentPackage(binaryPath, { requireManifest: true })).toThrow(
        'package manifest is required',
      );
      process.env.NODE_ENV = 'production';
      process.env.OPENSUMI_WORKSPACE_AGENT_PATH = binaryPath;
      const client = Object.create(WorkspaceAgentClient.prototype) as any;
      expect(() => client.resolveBinaryPath()).toThrow('package manifest is required');
    } finally {
      if (previousNodeEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnvironment;
      }
      if (previousConfiguredPath === undefined) {
        delete process.env.OPENSUMI_WORKSPACE_AGENT_PATH;
      } else {
        process.env.OPENSUMI_WORKSPACE_AGENT_PATH = previousConfiguredPath;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

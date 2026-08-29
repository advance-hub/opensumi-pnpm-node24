import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { WsGatewayRuntime, parseWsGatewayReadyLine, validateWsGatewayPackage } from '../src/ws-gateway';

function currentTarget(): { goos: string; goarch: string } {
  return {
    goos: process.platform === 'win32' ? 'windows' : process.platform,
    goarch: process.arch === 'x64' ? 'amd64' : process.arch,
  };
}

describe('WS Gateway launcher', () => {
  it('accepts only complete readiness announcements', () => {
    assert.deepEqual(
      parseWsGatewayReadyLine(
        JSON.stringify({
          event: 'opensumi-ws-gateway-ready',
          address: '[::]:8000',
          revision: 'test-revision',
          channelMode: 'multiplex-v1',
          directFileRPC: true,
        }),
      ),
      {
        event: 'opensumi-ws-gateway-ready',
        address: '[::]:8000',
        revision: 'test-revision',
        channelMode: 'multiplex-v1',
        directFileRPC: true,
      },
    );
    assert.equal(parseWsGatewayReadyLine('{not-json'), undefined);
    assert.equal(
      parseWsGatewayReadyLine(JSON.stringify({ event: 'workspace-agent-ready', address: ':8000' })),
      undefined,
    );
    assert.equal(
      parseWsGatewayReadyLine(
        JSON.stringify({ event: 'opensumi-ws-gateway-ready', address: ':8000', revision: 'test-revision' }),
      ),
      undefined,
    );
  });

  it('validates the packaged binary checksum and target', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'opensumi-ws-gateway-manifest-'));
    try {
      const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
      const binaryPath = path.join(directory, binaryName);
      const binary = Buffer.from('test-gateway-binary');
      await writeFile(binaryPath, binary);
      await writeFile(
        path.join(directory, 'ws-gateway.manifest.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          protocol: 'opensumi-ws-bridge-v1',
          ...currentTarget(),
          revision: 'test-revision',
          binary: binaryName,
          sha256: createHash('sha256').update(binary).digest('hex'),
        })}\n`,
      );

      assert.equal(validateWsGatewayPackage(binaryPath, true)?.revision, 'test-revision');
      await writeFile(binaryPath, 'tampered');
      assert.throws(() => validateWsGatewayPackage(binaryPath, true), /checksum/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('WS Gateway private channel adoption', () => {
  it('replays gateway connections dialed before the handler listener exists', async () => {
    const runtime = await WsGatewayRuntime.create();
    try {
      // The gateway dials immediately at startup; this client connects before
      // any "handler" listener is attached, exactly like the real gateway.
      const gatewayDial = net.connect(runtime.channelServer.address() as string);
      await new Promise<void>((resolve, reject) => {
        gatewayDial.once('connect', resolve);
        gatewayDial.once('error', reject);
      });
      gatewayDial.write('gateway-preface');
      await delay(100);

      const adopted: net.Socket[] = [];
      // ServerApp.start would register the real handler here; simulate it.
      runtime.channelServer.on('connection', (socket: net.Socket) => {
        adopted.push(socket);
        socket.on('data', () => socket.write('node-replies'));
      });
      runtime.adoptHeldChannelConnections();

      await delay(200);
      assert.equal(adopted.length, 1, 'held connection must be replayed to the handler');
      const reply = await new Promise<string>((resolve) => {
        gatewayDial.once('data', (chunk) => resolve(String(chunk)));
      });
      assert.equal(reply, 'node-replies');
      gatewayDial.destroy();
    } finally {
      await runtime.stop();
    }
  });
});

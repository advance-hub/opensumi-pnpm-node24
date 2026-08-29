import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyProcessRole,
  parsePosixProcessList,
  parseWindowsProcessList,
  redactCommandLine,
  selectProcessTree,
  summarizeProcessTree,
} from './process-tree';

describe('process tree diagnostics', () => {
  it('parses a POSIX process list without truncating command arguments', () => {
    const processes = parsePosixProcessList(`
      100     1  51200 01:02:03 node server/dist/main.js --flag value
      101   100  24576    00:12 /usr/bin/node packages/file-service/lib/node/hosted/watcher.process.js
      malformed row
    `);

    assert.deepEqual(processes, [
      {
        pid: 100,
        parentPid: 1,
        rssBytes: 51200 * 1024,
        elapsed: '01:02:03',
        commandLine: 'node server/dist/main.js --flag value',
      },
      {
        pid: 101,
        parentPid: 100,
        rssBytes: 24576 * 1024,
        elapsed: '00:12',
        commandLine: '/usr/bin/node packages/file-service/lib/node/hosted/watcher.process.js',
      },
    ]);
  });

  it('normalizes single-object Windows CIM output', () => {
    const processes = parseWindowsProcessList(
      JSON.stringify({
        ProcessId: 200,
        ParentProcessId: 100,
        WorkingSetSize: '4096',
        Name: 'node.exe',
        CommandLine: 'node.exe ext.process.js',
      }),
    );

    assert.deepEqual(processes, [
      {
        pid: 200,
        parentPid: 100,
        rssBytes: 4096,
        commandLine: 'node.exe ext.process.js',
      },
    ]);
  });

  it('redacts common command-line credential forms before emitting diagnostics', () => {
    assert.equal(
      redactCommandLine(
        'node agent.js --api-key top-secret --token=second https://user:password@example.com/workspace',
      ),
      'node agent.js --api-key [REDACTED] --token=[REDACTED] https://[REDACTED]@example.com/workspace',
    );
  });

  it('selects only the requested root and recursive descendants', () => {
    const processes = parsePosixProcessList(`
      100     1  100 00:10 node server/dist/main.js
      101   100  200 00:09 node ext.process.js
      102   101  300 00:08 gopls serve
      200     1  400 00:07 unrelated
    `);

    assert.deepEqual(
      selectProcessTree(processes, 100).map((process) => process.pid),
      [100, 101, 102],
    );
    assert.deepEqual(selectProcessTree(processes, 999), []);
  });

  it('classifies known runtime roles and summarizes their RSS', () => {
    const processes = parsePosixProcessList(`
      100     1  100 00:10 node server/dist/main.js
      101   100  200 00:09 node ext.process.js
      102   100  300 00:08 node watcher.process.js
      103   100  400 00:07 node pty.proxy.remote.exec.js
      104   101  500 00:06 /usr/local/bin/gopls serve
      105   100  600 00:05 /usr/bin/node custom-worker.js
      106   100  700 00:04 /bin/zsh --login
      107   100  800 00:03 /bin/zsh -ilc echo environment
      108   100  900 00:02 /opt/opensumi/workspace-agent --socket /tmp/agent.sock
      109   101 1000 00:01 /usr/bin/git log --max-count=1200
      110   108 1100 00:01 /usr/bin/rg --json workspace-agent /workspace
      111   100 1200 00:01 /usr/bin/rg --json workspace-agent /workspace
      112   100 1300 00:01 /opt/opensumi/ws-gateway --listen :8000
    `);

    assert.equal(classifyProcessRole(processes[1], 100), 'extension-host');
    assert.equal(classifyProcessRole(processes[2], 100), 'watcher-host');
    assert.equal(classifyProcessRole(processes[3], 100), 'pty-host');
    assert.equal(classifyProcessRole(processes[4], 100), 'language-server');
    assert.equal(classifyProcessRole(processes[5], 100), 'node-child');
    assert.equal(classifyProcessRole(processes[6], 100), 'terminal-shell');
    assert.equal(classifyProcessRole(processes[7], 100), 'other');
    assert.equal(classifyProcessRole(processes[8], 100), 'workspace-agent');
    assert.equal(classifyProcessRole(processes[10], 100), 'other');

    assert.equal(classifyProcessRole(processes[12], 100), 'ws-gateway');

    const summary = summarizeProcessTree(processes, 100);
    assert.equal(summary.processCount, 13);
    assert.equal(summary.totalRssBytes, 9100 * 1024);
    assert.deepEqual(summary.byRole['extension-host'], { count: 1, rssBytes: 200 * 1024 });
    assert.deepEqual(summary.byRole['extension-child'], { count: 1, rssBytes: 1000 * 1024 });
    assert.deepEqual(summary.byRole['language-server'], { count: 1, rssBytes: 500 * 1024 });
    assert.deepEqual(summary.byRole['terminal-shell'], { count: 1, rssBytes: 700 * 1024 });
    assert.deepEqual(summary.byRole['workspace-agent'], { count: 1, rssBytes: 900 * 1024 });
    assert.deepEqual(summary.byRole['workspace-agent-child'], { count: 1, rssBytes: 1100 * 1024 });
    assert.deepEqual(summary.byRole['ws-gateway'], { count: 1, rssBytes: 1300 * 1024 });
    assert.deepEqual(summary.byRole.other, { count: 2, rssBytes: 2000 * 1024 });
  });

  it('recognizes a quoted Windows Agent executable without matching its arguments', () => {
    const agent = parseWindowsProcessList(
      JSON.stringify({
        ProcessId: 201,
        ParentProcessId: 100,
        WorkingSetSize: 4096,
        CommandLine: '"C:\\Program Files\\OpenSumi\\workspace-agent.exe" --tcp 127.0.0.1:0',
      }),
    )[0];

    assert.equal(classifyProcessRole(agent, 100), 'workspace-agent');
  });
});

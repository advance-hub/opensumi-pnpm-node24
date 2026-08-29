import assert from 'assert';
import cp from 'child_process';

import isRunning from 'is-running';
import treeKill from 'tree-kill';

import { Injectable } from '@opensumi/di';
import { Event, IDisposable, MaybePromise } from '@opensumi/ide-core-common';
import { findFreePort } from '@opensumi/ide-core-common/lib/node/port';

import { IExtensionHostManager, Output, OutputType } from '../common';

@Injectable()
export class ExtensionHostManager implements IExtensionHostManager {
  private readonly processMap = new Map<number, cp.ChildProcess>();

  private readonly processDisposables = new Map<number, IDisposable[]>();

  private readonly maxProcessCount = (() => {
    const configured = Number(process.env.MAX_MANAGED_EXTENSION_PROCESSES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 3;
  })();

  constructor() {
    this.init();
  }

  init() {
    // Debug Auto Launch 插件 https://github.com/microsoft/vscode/blob/1.44.2/extensions/debug-auto-launch/src/extension.ts#L120
    // 依赖了 VSCODE_PID 来查找子进程
    process.env['VSCODE_PID'] = String(process.pid);
  }

  fork(modulePath: string, ...args: any[]) {
    if (this.processMap.size >= this.maxProcessCount) {
      throw new Error(`Managed extension child process limit (${this.maxProcessCount}) reached`);
    }
    const extProcess = cp.fork(modulePath, ...args);
    assert(extProcess.pid, `fork ${modulePath} error`);
    this.processMap.set(extProcess.pid, extProcess);
    this.processDisposables.set(extProcess.pid, []);
    extProcess.once('exit', () => this.releaseProcess(extProcess.pid!, extProcess));
    return extProcess.pid;
  }

  private trackProcessDisposable(pid: number, disposable: IDisposable) {
    const disposables = this.processDisposables.get(pid);
    if (disposables) {
      disposables.push(disposable);
    } else {
      disposable.dispose();
    }
  }

  private releaseProcess(pid: number, expectedProcess?: cp.ChildProcess) {
    if (expectedProcess && this.processMap.get(pid) !== expectedProcess) {
      return;
    }
    this.processMap.delete(pid);
    const disposables = this.processDisposables.get(pid) || [];
    this.processDisposables.delete(pid);
    disposables.forEach((disposable) => disposable.dispose());
  }

  send(pid: number, message: string) {
    return new Promise<void>((resolve, reject) => {
      const extProcess = this.processMap.get(pid);
      if (!extProcess) {
        reject(new Error(`Can't find process with pid ${pid}`));
        return;
      }
      extProcess.send(message, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  isRunning(pid: number) {
    return isRunning(pid);
  }

  treeKill(pid: number) {
    return new Promise<void>((resolve, reject) => {
      treeKill(pid, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  kill(pid: number, signal?: NodeJS.Signals) {
    const extProcess = this.processMap.get(pid);
    extProcess?.kill(signal);
  }

  isKilled(pid: number) {
    const extProcess = this.processMap.get(pid);
    if (!extProcess) {
      return true;
    }
    return extProcess.killed;
  }

  findDebugPort(startPort: number, giveUpAfter: number, timeout: number) {
    return findFreePort(startPort, giveUpAfter, timeout);
  }

  onOutput(pid: number, listener: (output: Output) => void) {
    const extProcess = this.processMap.get(pid);
    if (!extProcess) {
      return;
    }

    assert(extProcess.stdout, 'ext process spawn failed');
    assert(extProcess.stderr, 'ext process spawn failed');

    extProcess.stdout.setEncoding('utf8');
    extProcess.stderr.setEncoding('utf8');
    const onStdout = Event.fromNodeEventEmitter<string>(extProcess.stdout, 'data');
    const onStderr = Event.fromNodeEventEmitter<string>(extProcess.stderr, 'data');
    const onOutput = Event.any(
      Event.map(onStdout, (o) => ({ type: OutputType.STDOUT, data: `%c${o}`, format: [''] })),
      Event.map(onStderr, (o) => ({ type: OutputType.STDERR, data: `%c${o}`, format: ['color: red'] })),
    );

    // Debounce all output, so we can render it in the Chrome console as a group
    const onDebouncedOutput = Event.debounce<Output>(
      onOutput,
      (r, o) =>
        r
          ? {
              data: r.data + o.data,
              format: [...r.format, ...o.format],
              type: [r.type, o.type].includes(OutputType.STDERR) ? OutputType.STDERR : OutputType.STDOUT,
            }
          : { data: o.data, format: o.format, type: o.type },
      100,
    );

    this.trackProcessDisposable(pid, onDebouncedOutput(listener));
  }

  onExit(pid: number, listener: (code: number, signal: string) => void) {
    const extProcess = this.processMap.get(pid);
    if (!extProcess) {
      return;
    }
    extProcess.once('exit', listener);
  }

  onMessage(pid: number, listener: (msg: any) => void): MaybePromise<void> {
    const extProcess = this.processMap.get(pid);
    if (!extProcess) {
      return;
    }
    extProcess.on('message', listener);
    this.trackProcessDisposable(pid, {
      dispose: () => extProcess.off('message', listener),
    });
  }

  disposeProcess(pid: number) {
    const extProcess = this.processMap.get(pid);
    if (extProcess) {
      if (this.isRunning(pid)) {
        extProcess.kill();
      }
      this.releaseProcess(pid, extProcess);
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.processMap.keys()].map(async (pid) => {
        const isRunning = await this.isRunning(pid);
        if (isRunning) {
          await this.treeKill(pid);
        }
      }),
    );
    [...this.processMap.entries()].forEach(([pid, process]) => this.releaseProcess(pid, process));
  }
}

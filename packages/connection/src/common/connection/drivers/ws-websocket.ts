import { IDisposable } from '@opensumi/ide-core-common';

import { BaseConnection } from './base';

import type WS from 'ws';

export interface WSWebSocketConnectionOptions {
  maxBufferedAmount?: number;
  onBackpressure?(bufferedAmount: number, messageSize: number): void;
  onSendError?(error: Error): void;
}

export class WSWebSocketConnection extends BaseConnection<Uint8Array> {
  private terminatedByBackpressure = false;

  constructor(
    public socket: WS,
    private readonly options: WSWebSocketConnectionOptions = {},
  ) {
    super();
  }

  send(data: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN || this.terminatedByBackpressure) {
      return;
    }

    const maxBufferedAmount = this.options.maxBufferedAmount;
    if (maxBufferedAmount !== undefined && this.socket.bufferedAmount + data.byteLength > maxBufferedAmount) {
      this.terminatedByBackpressure = true;
      this.options.onBackpressure?.(this.socket.bufferedAmount, data.byteLength);
      this.socket.terminate();
      return;
    }

    try {
      this.socket.send(data, (error) => {
        if (error) {
          this.options.onSendError?.(error);
          this.socket.terminate();
        }
      });
    } catch (error) {
      this.options.onSendError?.(error instanceof Error ? error : new Error(String(error)));
      this.socket.terminate();
    }
  }

  onMessage(cb: (data: Uint8Array) => void): IDisposable {
    this.socket.on('message', cb);
    return {
      dispose: () => {
        this.socket.off('message', cb);
      },
    };
  }
  onceClose(cb: () => void): IDisposable {
    this.socket.once('close', cb);
    return {
      dispose: () => {
        this.socket.off('close', cb);
      },
    };
  }

  isOpen() {
    return this.socket.readyState === this.socket.OPEN;
  }

  dispose(): void {
    this.socket.removeAllListeners();
  }
}

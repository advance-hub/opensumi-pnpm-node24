import { Duplex } from 'node:stream';

/**
 * A Node stream like `/dev/null`.
 *
 * Writing goes to a black hole, reading returns `EOF`.
 */
export class DevNullStream extends Duplex {
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }

  _read(_size: number): void {
    this.push(null);
  }
}

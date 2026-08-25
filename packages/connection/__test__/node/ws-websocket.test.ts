import { WSWebSocketConnection } from '../../src/common/connection/drivers/ws-websocket';

import type WS from 'ws';

function createSocket(bufferedAmount = 0) {
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    send: jest.fn(),
    terminate: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    removeAllListeners: jest.fn(),
  } as unknown as WS;

  return socket;
}

describe('WSWebSocketConnection', () => {
  it('terminates before a send would exceed the buffer budget', () => {
    expect.hasAssertions();
    const socket = createSocket(6);
    const onBackpressure = jest.fn();
    const connection = new WSWebSocketConnection(socket, {
      maxBufferedAmount: 10,
      onBackpressure,
    });

    connection.send(new Uint8Array(5));
    connection.send(new Uint8Array(1));

    expect(onBackpressure).toHaveBeenCalledWith(6, 5);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('sends while the pending buffer remains within budget', () => {
    expect.hasAssertions();
    const socket = createSocket(2);
    const connection = new WSWebSocketConnection(socket, { maxBufferedAmount: 10 });
    const data = new Uint8Array(8);

    connection.send(data);

    expect(socket.send).toHaveBeenCalledWith(data, expect.any(Function));
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('terminates a connection when an asynchronous send fails', () => {
    expect.hasAssertions();
    const socket = createSocket();
    const sendError = new Error('send failed');
    const onSendError = jest.fn();
    jest.mocked(socket.send).mockImplementation((_data, callback) => {
      (callback as (error?: Error) => void)(sendError);
    });
    const connection = new WSWebSocketConnection(socket, { onSendError });

    connection.send(new Uint8Array(1));

    expect(onSendError).toHaveBeenCalledWith(sendError);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });
});

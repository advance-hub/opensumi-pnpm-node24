import { RPCServiceCenter, initRPCService } from '@opensumi/ide-connection';
import { SimpleConnection } from '@opensumi/ide-connection/lib/common/connection/drivers/simple';
import { SumiConnection } from '@opensumi/ide-connection/lib/common/rpc/connection';
import { SumiConnectionMultiplexer } from '@opensumi/ide-connection/lib/common/rpc/multiplexer';
import { Emitter } from '@opensumi/ide-core-common';

import { MainThreadAPIIdentifier } from '../src/common/vscode';

const noOpMainThreadActor = new Proxy(
  {},
  {
    get: () => async () => undefined,
  },
);

function registerDefaultMainThreadActors(protocol: SumiConnectionMultiplexer) {
  protocol.set(MainThreadAPIIdentifier.MainThreadEditorTabs, noOpMainThreadActor);
  protocol.set(MainThreadAPIIdentifier.MainThreadOutput, noOpMainThreadActor);
}

export async function initMockRPCProtocol(client): Promise<SumiConnectionMultiplexer> {
  const extProtocol = new SumiConnectionMultiplexer(
    new SimpleConnection({
      onMessage: client.onMessage,
      send: client.send,
    }),
  );

  return extProtocol;
}

export function createMockPairRPCProtocol() {
  const emitterA = new Emitter<any>();
  const emitterB = new Emitter<any>();

  const mockClientA = {
    send: (msg) => emitterB.fire(msg),
    onMessage: emitterA.event,
  };
  const mockClientB = {
    send: (msg) => emitterA.fire(msg),
    onMessage: emitterB.event,
  };

  const rpcProtocolExt = new SumiConnectionMultiplexer(new SimpleConnection(mockClientA));
  const rpcProtocolMain = new SumiConnectionMultiplexer(new SimpleConnection(mockClientB));
  // Extension-host constructors eagerly notify these actors. Register no-op
  // defaults on both ends so tests that do not exercise those APIs cannot leak
  // rejected RPC promises after their environment has already been torn down.
  registerDefaultMainThreadActors(rpcProtocolExt);
  registerDefaultMainThreadActors(rpcProtocolMain);
  return {
    rpcProtocolExt,
    rpcProtocolMain,
  };
}

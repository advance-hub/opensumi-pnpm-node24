# OpenSumi Server

The product backend runs on Node.js 24 and owns OpenSumi RPC, extension hosts, terminals, file services and optional Yjs collaboration. There is one public server entry at port `8000`; no Go gateway or compatibility worker is required.

```bash
pnpm dev                       # client + Node server
pnpm dev:ai                    # add AI Native on both sides
pnpm dev:full                  # add AI Native and Notebook client
pnpm dev:collaboration         # also enable the Yjs collaboration service
pnpm dev:full:collaboration    # full client plus collaboration
pnpm build:server              # emit production JavaScript to server/dist
pnpm --dir server start        # run the compiled server
```

The default server does not instantiate AI or collaboration modules. The RPC and collaboration WebSocket servers disable compression by default and enforce payload, connection and buffered-output limits. All limits are configurable with the environment variables documented in `docs/architecture/client-server-runtime.md`.

# OpenSumi Workspace Agent

This module is a private child process for resource-owning workspace services. A native-startup-verified production package is selected automatically by the OpenSumi Server; a Server build without that package stays on Node. It is not a public HTTP gateway and does not replace the Node compatibility runtime or VS Code Extension Host.

The same Go module also contains `cmd/ws-gateway` so the public WebSocket experiment can reuse transport and lifecycle utilities. That command is separate from the Workspace Agent and remains default-off. Concurrent WebSocket handshakes coalesce the Node `/readyz` admission request and retain the result for at most 100 ms; shutdown cancels the shared request. Its `multiplex-v1` private channel carries isolated logical browser streams over one Gateway-to-Node socket, while `direct` preserves the original per-browser socket path for rollback and A/B profiles. The current 500-connection, three-run multiplexed profile passed the latency gate (`2.676 ms` Gateway versus `2.729 ms` Node P95) but still used `29.28%` more whole-tree RSS, so the Gateway is not an approved general memory optimization.

The Gateway now owns four real RPC methods rather than only terminating WebSockets: compatible `DiskFileService:readFile`, `access` (`F_OK`), `readDirectory` and `stat` requests for local `file:` URIs are decoded and answered in Go, while unsupported, failed, oversized or concurrency-saturated cases are forwarded unchanged to Node. File content and directory-list responses retain the default 8 MiB bound; recursive stat metadata has an independent 1 MiB bound, and all direct file RPCs share 16 execution slots. Stat preserves the current one-level directory shape, symlink target metadata and JavaScript `Date` millisecond rounding. A read-only diagnostics endpoint reports per-method direct counts versus forwarded frames. Five fresh-process comparisons ran 720 cycles per side across all four methods; all `18,000` Gateway RPCs avoided Node and full file/directory stat objects matched Node in every pair. Cross-run median P95 improved by `20.41%` for reads, `6.77%` for access, `22.73%` for directory reads, `45.40%` for file stat and `56.32%` for directory stat. Node Server post-stress RSS fell `13.70%`, but the focused whole tree including Gateway fell only `1.30%`. This advances the experiment but does not override the earlier 500-idle-connection failure or make the Gateway production-default.

```bash
pnpm build:workspace-agent
pnpm build:server:workspace-agent
pnpm test:workspace-agent
pnpm test:workspace-agent:linux

OPENSUMI_WORKSPACE_AGENT_WATCH_MODE=enabled \
OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE=shadow-read \
OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE=shadow-read \
pnpm dev
```

When `pnpm build:server:workspace-agent` supplies a matching manifest, valid checksum, all three capabilities and `nativeStartupVerified: true`, Watch, Content Search and File Search default to `enabled`. `OPENSUMI_WORKSPACE_AGENT_AUTO_MODE=off` restores package-level opt-in, and explicit per-service modes always win. Without a runnable package all three remain `off`. Content Search and File Search also support `shadow-read`; Watcher event streams do not. The Node adapter falls back to the existing implementation if the binary cannot start or capability negotiation fails. A Watcher stream drop migrates the current connection to the Node watcher. An active Content Search stream is not silently replayed after it has emitted results: it reports an error, and searches submitted after the Agent becomes unavailable use Node. File Search buffers only its bounded result list before returning, so an Agent failure can safely replay the request through Node.

Node launches the Agent with a random bearer credential, verifies protocol major `1` and required service capabilities, and closes it during server shutdown. macOS and Linux use a per-process Unix socket restricted to `0600`. Windows requests an ephemeral `127.0.0.1:0` listener; the Agent announces the allocated port over its inherited stdout, and the Node adapter rejects any announcement that is not an allocated IPv4 loopback address. The token is still required for every unary and streaming RPC.

Platform watcher backends are isolated behind `internal/agent/watch_backend.go`:

- macOS uses native FSEvents and requires CGO. `github.com/fsnotify/fsevents` is pinned to `v0.2.0` behind the internal adapter because its public API is pre-v1.
- Linux and other non-Darwin builds use fsnotify. Linux resolves this to inotify; Windows resolves it to `ReadDirectoryChangesW`.

Content Search and File Search own their ripgrep child processes and propagate stream cancellation. File Search performs exact/fuzzy classification in Go and streams only bounded path batches back to Node; this avoids growing the Server's V8 heap for every candidate path. Generated protobuf code lives under `gen/`; the protocol source remains in `packages/file-service/proto` so the TypeScript adapter and Go implementation share one contract.

`go test -race -v ./...` includes authenticated gRPC integration tests against the native watcher backend and the ephemeral loopback transport. They create real filesystem changes, enforce the event-latency threshold, reject unauthenticated RPC, validate Content/File Search batching and classification, and verify that cancellation returns all active counters to zero. The repository CI runs this suite, `go vet`, native packaging and binary startup on macOS, Ubuntu and Windows; the Ubuntu job also cross-builds Linux arm64.

`pnpm test:workspace-agent:linux` runs the same race suite, vet, native build and binary startup inside a disposable Linux container. Set `WORKSPACE_AGENT_LINUX_TEST_IMAGE` to use an already-approved Go image mirror. The process-level suite also verifies Unix socket mode `0600`, the loopback handshake, rejected unauthenticated RPC, protocol capabilities, graceful Shutdown, socket removal and exit after the configured parent PID disappears. Windows CI additionally checks process liveness through a real process handle.

For a production server artifact, use `pnpm build:server:workspace-agent`. The dependency-free Node 24 packaging step builds the host platform binary atomically into `server/dist/workspace-agent`, runs the native binary's startup path, applies the build revision, and writes a manifest containing the protocol, service list, target platform, native-startup proof and SHA-256 digest. The Node adapter verifies that manifest before starting the production Agent. Darwin packages must be built on a matching macOS host because the FSEvents backend uses CGO; Linux and Windows packages can be cross-compiled with CGO disabled. Windows artifacts use `workspace-agent.exe`.

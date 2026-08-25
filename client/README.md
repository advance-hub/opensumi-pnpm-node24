# OpenSumi Client

The browser application composition lives here. OpenSumi framework packages remain under `packages/`; this folder owns only the product entry and its build.

The default build uses Rspack 2. New product-entry code in `client/src` uses Rspack's built-in SWC transformer. Existing framework sources keep `ts-loader` in transpile-only mode for now because their decorator metadata and CommonJS cycles do not yet satisfy isolated-module ESM semantics. This boundary keeps the application stable while still removing Webpack's bundling and minification bottleneck.

Full repository type checking remains a separate `pnpm compile` concern, so development HMR is not blocked by whole-project analysis. New client code is linted for explicit type-only imports; framework packages can move onto the SWC path after their type re-exports and decorated signatures pass the same rule.

```bash
pnpm start:client
pnpm build:client
pnpm build:client:full
```

The default client composes the core IDE only. Set `ENABLE_AI=1`, `ENABLE_NOTEBOOK=1`, or `ENABLE_COLLABORATION=1` through the root profile commands to add those code-split modules. The client connects to the Node 24 server at `ws://127.0.0.1:8000` in development.

The product client has no Webpack fallback. Build and development configuration lives in `rspack.config.ts`; legacy Webpack files that remain under framework packages and tools are separate migration targets, not product entry points.

An all-SWC validation produced invalid runtime imports for erased interfaces used in decorator metadata. That mode is therefore not exposed as a supported build: reducing a short-lived build peak is not worth breaking dependency injection at runtime.

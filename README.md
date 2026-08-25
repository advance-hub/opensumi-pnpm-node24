<p align="center">
	<a href="https://github.com/opensumi/core"><img src="https://img.alicdn.com/imgextra/i2/O1CN01dqjQei1tpbj9z9VPH_!!6000000005951-55-tps-87-78.svg" width="150" /></a>
</p>

<h1 align="center">OpenSumi · Node 24 / pnpm Upgrade</h1>

<p align="center">A lower-memory, resource-bounded OpenSumi distribution that keeps VS Code Node extension compatibility.</p>

> **Project status:** this is an independent engineering upgrade based on [OpenSumi Core](https://github.com/opensumi/core) commit `9fee6aa`, not an official OpenSumi release branch.

## Why This Version Exists

The selected upstream baseline still used Node.js 18 and Yarn across a large workspace, with product startup, framework source compilation, and development tooling closely coupled. That arrangement works, but it makes ordinary WebIDE development retain more source graphs, watchers, and supervisors than necessary.

The migration also found concrete runtime risks beyond the choice of language:

1. WebSocket heartbeat ownership, payload size, connection count, and slow-consumer buffering did not have one complete resource boundary.
2. Extension hosts and file watchers could leave callbacks, sockets, timers, or descendant processes alive after reconnects and shutdown.
3. Yjs rooms needed explicit limits for clients, documents, CRDT state, concurrent initialization, and idle history cleanup.
4. Product entry points were mixed with many reusable packages, making it difficult to tell what actually runs in the browser and on the server.

A Go or Bun rewrite was evaluated but not adopted. Traditional VS Code extensions, OpenSumi RPC, PTY, file watching, and existing native modules still require the Node ecosystem, so a second runtime would add a proxy and deployment boundary without removing Node memory. This version instead keeps one Node.js 24 backend and places measurable limits around it.

## What Changed

| Area | Main change | Practical value |
| --- | --- | --- |
| Toolchain | Pin Node.js 24.16, pnpm 11.21, TypeScript 5.9, and React 18.3; remove Yarn | Installation, CI, builds, and local development share one version contract |
| Product layout | Make `client/` and `server/` the only runnable product entries while keeping `packages/` as the internal framework | Product ownership is clearer without breaking OpenSumi package identities, dependency injection, or extension protocols |
| Frontend build | Use Rspack 2 + SWC for the default client and extension worker; keep repository-owned configuration and scripts in TypeScript with no `.mjs`/`.cjs` files | Shorter default compilation path and less legacy configuration maintenance |
| Low-memory development | Consume precompiled `packages/*/lib` and `server/dist`, disable source maps by default, check memory headroom, and cap Node heaps | Avoid retaining the entire framework source graph and multiple source watchers during normal development |
| Connections and processes | Bound WebSocket connections, payloads, send buffers, heartbeats, and slow consumers; clean up the Server, Rspack, extension-host, and Watcher process trees on exit | Reduce resource growth caused by abnormal clients, reconnect loops, and orphan processes |
| Collaboration | Bound Yjs clients, documents, CRDT state, concurrent initialization, and idle lifetime; rebuild rooms under pressure | Prevent collaboration rooms and update history from growing without limits |
| Compatibility boundary | Keep one Node.js 24 production backend instead of adding Go/Bun; load AI, Notebook, and collaboration on demand while retaining traditional VS Code Node extensions | Preserve the extension ecosystem without introducing a second runtime and proxy layer |

See the [Node 24 single-runtime design](./docs/architecture/client-server-runtime.md) for implementation details, resource limits, validation evidence, and the Go/Bun decision. See the [repository layout](./docs/architecture/repository-layout.md) for ownership rules. Local memory figures are point samples rather than production capacity guarantees; production deployments still need staged load tests across workspaces, extensions, and collaboration clients.

<div align="center">

[![MCP][mcp-client-image]][mcp-client-url] [![MCP Feature][mcp-client-feature-image]][mcp-client-feature-url]

[![CI][ci-image]][ci-url] [![E2E][e2e-image]][e2e-url] [![Test Coverage][test-image]][test-url] [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com) [![Issues need help][help-wanted-image]][help-wanted-url]

[![Discussions][discussions-image]][discussions-url] [![CLA assistant][cla-image]][cla-url] [![License][license-image]][license-url]

[![NPM Version][npm-image]][npm-url] [![NPM downloads][download-image]][download-url]

[![Open in CodeBlitz][codeblitz-image]][codeblitz-url]

[ci-image]: https://github.com/opensumi/core/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/opensumi/core/actions/workflows/ci.yml
[e2e-image]: https://github.com/opensumi/core/actions/workflows/e2e.yml/badge.svg
[e2e-url]: https://github.com/opensumi/core/actions/workflows/e2e.yml
[discussions-image]: https://img.shields.io/badge/discussions-on%20github-blue
[discussions-url]: https://github.com/opensumi/core/discussions
[npm-image]: https://img.shields.io/npm/v/@opensumi/ide-core-common.svg
[npm-url]: https://www.npmjs.com/package/@opensumi/ide-core-common
[download-image]: https://img.shields.io/npm/dm/@opensumi/ide-core-common.svg
[download-url]: https://npmjs.org/package/@opensumi/ide-core-common
[license-image]: https://img.shields.io/npm/l/@opensumi/ide-core-common.svg
[license-url]: https://github.com/opensumi/core/blob/main/LICENSE
[cla-image]: https://cla-assistant.io/readme/badge/opensumi/core
[cla-url]: https://cla-assistant.io/opensumi/core
[test-image]: https://codecov.io/gh/opensumi/core/branch/main/graph/badge.svg?token=07JAPLU957
[test-url]: https://codecov.io/gh/opensumi/core
[codeblitz-image]: https://img.shields.io/badge/Ant_Codespaces-Open_in_CodeBlitz-1677ff
[codeblitz-url]: https://codeblitz.cloud.alipay.com/github/opensumi/core
[github-issues-url]: https://github.com/opensumi/core/issues
[help-wanted-image]: https://flat.badgen.net/github/label-issues/opensumi/core/🤔%20help%20wanted/open
[help-wanted-url]: https://github.com/opensumi/core/issues?q=is%3Aopen+is%3Aissue+label%3A%22🤔+help+wanted%22
[mcp-client-image]: https://badge.mcpx.dev/?type=client
[mcp-client-url]: https://modelcontextprotocol.io
[mcp-client-feature-image]: https://badge.mcpx.dev/?type=client&features=tools
[mcp-client-feature-url]: https://modelcontextprotocol.io/clients

[Changelog](./docs/CHANGELOG.md) · [Report Bug][github-issues-url] · [Request Feature][github-issues-url] · English · [中文](./README-zh_CN.md)

</div>

![perview](https://img.alicdn.com/imgextra/i3/O1CN01UUnvG21foKD7RAw9n_!!6000000004053-2-tps-2400-721.png)

## 🌟 Getting Started

Here you can find some of our example projects and templates:

- [Cloud IDE](https://github.com/opensumi/ide-startup)
- [Desktop IDE - based on the Electron](https://github.com/opensumi/ide-electron)
- [CodeFuse IDE - AI IDE based on OpenSumi](https://github.com/codefuse-ai/codefuse-ide)
- [CodeBlitz - A pure web IDE Framework](https://github.com/opensumi/codeblitz)
- [Lite Web IDE - A pure web IDE on the Browser](https://github.com/opensumi/ide-startup-lite)
- [The Mini-App liked IDE](https://github.com/opensumi/app-desktop)

## ⚡️ Development

Use Node.js 24 LTS and pnpm 11. The browser product lives in `client/`; the single Node.js backend lives in `server/` and retains full VS Code Node extension compatibility.

When using Volta, install both tools after selecting Node 24 (`volta install node@24.16.0 pnpm@11.21.0`); Volta otherwise keeps a globally installed pnpm bound to the Node version that was active when pnpm was installed.

```bash
$ pnpm install --frozen-lockfile
$ pnpm run setup:native        # First install or after changing Node versions
$ pnpm run init
$ pnpm run download-extension  # Optional
$ pnpm run dev                  # lightweight core profile
$ pnpm run dev:source           # framework and server source-watch profile
$ pnpm run dev:ai               # core + AI Native
$ pnpm run dev:full             # AI Native + Notebook
$ pnpm run dev:collaboration    # core + Yjs collaboration
$ pnpm run dev:full:collaboration
```

The default profile does not compose AI, Notebook, or collaboration modules, reducing server residency and initial browser work. These capabilities remain available through the explicit profiles above, while traditional VS Code Node extensions continue to run in Node 24 extension hosts.

Development starts the server before the client, enforces bounded heaps and available-memory preflight checks, and shuts down the complete process tree. Source maps are disabled in the low-memory default; run `SOURCE_MAP=1 pnpm dev` when a debugging session needs them.

The default client consumes the workspace packages' precompiled `lib` output instead of making Rspack retain the entire framework TypeScript source graph, and the default server runs the compiled `server/dist` entry without a second `tsx watch` supervisor. Run `pnpm init` after changing framework packages. Use `pnpm dev:source` when both browser-side HMR for `packages/*/src` and server source watching are required; use `OPENSUMI_SOURCE_MODE=1` or `OPENSUMI_SERVER_SOURCE_MODE=1` with `pnpm dev` when only one side needs source mode. These modes intentionally use more memory.

`client/` and `server/` are the only runnable product directories. `packages/` contains internal reusable framework capabilities; see the [repository layout](./docs/architecture/repository-layout.md) for placement rules.

By default, the `tools/workspace` folder in the project would be opened, or you can run the project by specifying the directory in the following way:

```bash
$ MY_WORKSPACE={local_path} pnpm run dev
```

Usually, you may still encounter some system-level environment dependencies. You can visit [Development Environment Preparation](./docs/CONTRIBUTING.md#development-environment-preparation) to see how to install the corresponding environment dependencies.

## 📕 Documentation

For complete documentation: [opensumi.com](https://opensumi.com)

## 📍 ReleaseNotes & BreakingChanges

You can see all the releasenotes and breaking changes here: [CHANGELOG.md](./docs/CHANGELOG.md).

## 🔥 Contributing

Read through our [Contributing Guide](./docs/CONTRIBUTING.md) to learn about our submission process, coding rules and more.

## 🙋‍♀️ Want to Help?

Want to report a bug, contribute some code, or improve documentation? Excellent! Read up on our [Contributing Guidelines](./docs/CONTRIBUTING.md) for contributing and then check out one of our issues labeled as help wanted or good first issue.

## 🧑‍💻 Needs some help?

Go to our [issues](https://github.com/opensumi/core/issues) or [discussions](https://github.com/opensumi/core/discussions) to create a topic, it will be resolved as soon as we can.

## ✨ Contributors

Let's build a better OpenSumi together.

<table>
<tr>
  <td>
    <a href="https://next.ossinsight.io/widgets/official/compose-recent-top-contributors?repo_id=429104828" target="_blank" style="display: block" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://next.ossinsight.io/widgets/official/compose-recent-top-contributors/thumbnail.png?repo_id=429104828&image_size=auto&color_scheme=dark" width="280">
        <img alt="Top Contributors of ant-design/ant-design - Last 28 days" src="https://next.ossinsight.io/widgets/official/compose-recent-top-contributors/thumbnail.png?repo_id=429104828&image_size=auto&color_scheme=light" width="280">
      </picture>
    </a>
  </td>
  <td rowspan="2">
    <a href="https://next.ossinsight.io/widgets/official/compose-last-28-days-stats?repo_id=429104828" target="_blank" style="display: block" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://next.ossinsight.io/widgets/official/compose-last-28-days-stats/thumbnail.png?repo_id=429104828&image_size=auto&color_scheme=dark" width="655" height="auto">
        <img alt="Performance Stats of ant-design/ant-design - Last 28 days" src="https://next.ossinsight.io/widgets/official/compose-last-28-days-stats/thumbnail.png?repo_id=429104828&image_size=auto&color_scheme=light" width="655" height="auto">
      </picture>
    </a>
  </td>
</tr>
<tr>
  <td>
    <a href="https://next.ossinsight.io/widgets/official/compose-org-active-contributors?period=past_28_days&activity=active&owner_id=90233428&repo_ids=429104828" target="_blank" style="display: block" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://next.ossinsight.io/widgets/official/compose-org-active-contributors/thumbnail.png?period=past_28_days&activity=active&owner_id=90233428&repo_ids=429104828&image_size=2x3&color_scheme=dark" width="273" height="auto">
        <img alt="Active participants of opensumi - past 28 days" src="https://next.ossinsight.io/widgets/official/compose-org-active-contributors/thumbnail.png?period=past_28_days&activity=active&owner_id=90233428&repo_ids=429104828&image_size=2x3&color_scheme=light" width="273" height="auto">
      </picture>
    </a>
  </td>
</tr>
</table>

We warmly invite contributions from everyone. Before you get started, please take a moment to review our [Contributing Guide](./docs/CONTRIBUTING.md). Feel free to share your ideas through [Pull Requests](https://github.com/opensumi/core/pulls) or [GitHub Issues](https://github.com/opensumi/core/issues).

## 📃 License

Copyright (c) 2019-present Alibaba Group Holding Limited, Ant Group Co. Ltd.

Licensed under the [MIT](LICENSE) license.

This project contains various third-party code under other open source licenses.

See the [NOTICE.md](./NOTICE.md) file for more information.

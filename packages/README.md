# Internal framework packages

`packages/` is the internal OpenSumi framework, not a third application. The repository has exactly two product entry points:

- `client/` assembles browser modules and owns the web bundle.
- `server/` assembles Node modules and owns the production process.

Many framework packages intentionally contain `src/browser`, `src/common`, and `src/node` together. These directories are different runtime facets of one public capability and share one package version. Physically copying them into both applications would duplicate protocols and dependency injection tokens, while moving every package into either application would create invalid browser-to-Node dependencies.

## Placement rules

| Code | Directory | Rule |
| --- | --- | --- |
| Browser product composition | `client/src` | Product defaults, optional feature flags, layout and bootstrapping |
| Node product composition | `server/src` | Process startup, deployment defaults and server-only adapters |
| Reusable browser implementation | `packages/*/src/browser` | Must not import a Node facet |
| Shared protocol and types | `packages/*/src/common` | Must not import browser or Node facets |
| Reusable backend implementation | `packages/*/src/node` | May be assembled only by the server or extension host |
| Tests | Next to the owning package | Keep framework tests with the public package contract |

New product-specific code belongs in `client/` or `server/`. Add a framework package only when the capability is reusable outside this product and needs an independent public package boundary. AI, Notebook and collaboration remain optional runtime modules; they must not return to either default module list.

The package count does not determine runtime memory. pnpm links workspaces during development, Webpack only emits reachable client modules, and Node only loads modules assembled by `server/src/main.ts`.

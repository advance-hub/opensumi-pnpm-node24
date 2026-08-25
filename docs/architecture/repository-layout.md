# Repository layout

The repository uses an application-first layout. `client/` and `server/` are the only runnable products; all other top-level directories are internal support areas.

```text
client/       browser product entry, Webpack and web assets
server/       Node 24 product entry and production build
packages/     reusable OpenSumi framework packages (not an application)
configs/      TypeScript, Jest, ESLint and commit policy
scripts/      repository automation and release scripts
tools/        build/test/Electron utilities retained by the framework
test/         repository-level acceptance specifications
typings/      ambient declarations shared by framework packages
docs/         architecture, changelog and contribution guides
```

Root files are limited to files that repository tooling discovers there or that hosts expect there: package/workspace metadata, Node version pins, the root TypeScript project, Lerna's release version, Codecov policy, license notices and readmes.

## Why `packages/` remains top-level

OpenSumi publishes framework capabilities as npm packages. A capability commonly owns browser, common and Node facets under the same package and version. Moving those facets independently below `client/` and `server/` would break public import identities, TypeScript project references, dependency injection tokens and the VS Code extension host contract. It would also duplicate shared protocols.

The structural boundary is therefore based on responsibility:

- application composition lives only in `client/` and `server/`;
- reusable runtime code lives in `packages/`;
- engineering configuration lives in `configs/`;
- generated output stays inside its owning application or package and is ignored by Git.

This keeps day-to-day product development focused on two directories without turning the framework migration into a breaking package rewrite.

# OpenSumi Startup

`CommonBrowserModules` 与 `CommonNodeModules` 只保留默认 IDE 核心能力。AI 模块分别从 `src/browser/ai-modules.ts` 和 `src/node/ai-modules.ts` 显式引入，产品入口可据此实现轻量与完整两种装配。

如需自定义 workspace 目录，可以通过传递 `MY_WORKSPACE` 环境变量指定：

```bash
MY_WORKSPACE=${your_folder} pnpm dev
```

import { SlotLocation } from '@opensumi/ide-core-browser';
import { DESIGN_MENUBAR_CONTAINER_VIEW_ID, DESIGN_MENU_BAR_RIGHT } from '@opensumi/ide-design';
import { BaseSampleModule } from '@opensumi/ide-startup/entry/sample-modules/base';
import { getDefaultClientAppOpts, renderApp } from '@opensumi/ide-startup/entry/web/render-app';
import { MENU_BAR_FEATURE_TIP } from '@opensumi/ide-startup/lib/browser/menu-bar-help-icon';

import type { BrowserModule, ConstructorOf, IClientAppOpts } from '@opensumi/ide-core-browser';

// Keep the framework-owned renderer reusable while the product composition
// lives in client/. The renderer can be moved later without changing servers.

async function main() {
  const productModules: ConstructorOf<BrowserModule>[] = [BaseSampleModule];
  const rightMenuModules = [MENU_BAR_FEATURE_TIP];
  const productOpts: Partial<IClientAppOpts> = {
    layoutViewSize: {
      menubarHeight: 32,
    },
    measure: {
      connection: {
        minimumReportThresholdTime: 400,
      },
    },
  };

  if (process.env.ENABLE_AI === '1') {
    const [{ AI_CHAT_LOGO_AVATAR_ID }, { AILayout }, { AISampleModule }, { AIBrowserModules }] = await Promise.all([
      import('@opensumi/ide-ai-native'),
      import('@opensumi/ide-ai-native/lib/browser/layout/ai-layout.js'),
      import('@opensumi/ide-startup/entry/sample-modules/ai-module.js'),
      import('@opensumi/ide-startup/lib/browser/ai-modules.js'),
    ]);
    productModules.push(AISampleModule, ...AIBrowserModules);
    rightMenuModules.push(AI_CHAT_LOGO_AVATAR_ID);
    productOpts.layoutComponent = AILayout;
    productOpts.AINativeConfig = {
      capabilities: {
        supportsMCP: true,
        supportsCustomLLMSettings: true,
      },
    };
  }

  if (process.env.ENABLE_NOTEBOOK === '1') {
    const { NotebookModule } = await import('@opensumi/ide-notebook/lib/browser/index.js');
    productModules.push(NotebookModule);
    productOpts.notebookServerHost = process.env.NOTEBOOK_SERVER_HOST || 'localhost:8888';
  }

  if (process.env.ENABLE_COLLABORATION === '1') {
    const { CollaborationModule } = await import('@opensumi/ide-collaboration/lib/browser/index.js');
    productModules.push(CollaborationModule);
  }

  productOpts.layoutConfig = {
    [DESIGN_MENU_BAR_RIGHT]: {
      modules: rightMenuModules,
    },
    [SlotLocation.top]: {
      modules: [DESIGN_MENUBAR_CONTAINER_VIEW_ID],
    },
  };
  productOpts.collaborationOptions = {
    port: Number(process.env.COLLABORATION_PORT || 12_345),
  };

  renderApp(
    getDefaultClientAppOpts({
      modules: productModules,
      opts: productOpts,
    }),
  );
}

void main();

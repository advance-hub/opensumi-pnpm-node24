import { AI_CHAT_LOGO_AVATAR_ID } from '@opensumi/ide-ai-native';
import { AILayout } from '@opensumi/ide-ai-native/lib/browser/layout/ai-layout';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { DESIGN_MENUBAR_CONTAINER_VIEW_ID, DESIGN_MENU_BAR_RIGHT } from '@opensumi/ide-design';
import { NotebookModule } from '@opensumi/ide-notebook/lib/browser';
import { AIBrowserModules } from '@opensumi/ide-startup/lib/browser/ai-modules';
import { MENU_BAR_FEATURE_TIP } from '@opensumi/ide-startup/lib/browser/menu-bar-help-icon';

import { SampleModule } from '../sample-modules';

import { getDefaultClientAppOpts, renderApp } from './render-app';

renderApp(
  getDefaultClientAppOpts({
    modules: [SampleModule, ...AIBrowserModules, NotebookModule],
    opts: {
      layoutViewSize: {
        menubarHeight: 32,
      },
      layoutConfig: {
        [DESIGN_MENU_BAR_RIGHT]: {
          modules: [MENU_BAR_FEATURE_TIP, AI_CHAT_LOGO_AVATAR_ID],
        },
        [SlotLocation.top]: {
          modules: [DESIGN_MENUBAR_CONTAINER_VIEW_ID],
        },
      },
      measure: {
        connection: {
          minimumReportThresholdTime: 400,
        },
      },
      AINativeConfig: {
        capabilities: {
          supportsMCP: true,
          supportsCustomLLMSettings: true,
        },
      },
      layoutComponent: AILayout,
      notebookServerHost: 'localhost:8888',
    },
  }),
);

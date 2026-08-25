import { AI_CHAT_LOGO_AVATAR_ID } from '@opensumi/ide-ai-native';
import { AILayout } from '@opensumi/ide-ai-native/lib/browser/layout/ai-layout';
import { DESIGN_MENU_BAR_RIGHT } from '@opensumi/ide-design';
import { AIBrowserModules } from '@opensumi/ide-startup/lib/browser/ai-modules';

import { SampleModule } from '../../sample-modules';
import { getDefaultClientAppOpts, renderApp } from '../render-app';

const hostname = window.location.hostname;
const port = window.location.port;

renderApp(
  getDefaultClientAppOpts({
    modules: [SampleModule, ...AIBrowserModules],
    opts: {
      layoutComponent: AILayout,
      layoutConfig: {
        [DESIGN_MENU_BAR_RIGHT]: {
          modules: [AI_CHAT_LOGO_AVATAR_ID],
        },
      },
      webviewEndpoint: '/webview',
      extWorkerHost: '/worker-host.js',
      wsPath: window.location.protocol === 'https:' ? `wss://${hostname}:${port}` : `ws://${hostname}:${port}`,
    },
  }),
);

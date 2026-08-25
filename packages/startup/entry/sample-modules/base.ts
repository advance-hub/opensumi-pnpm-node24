import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { AbstractNodeExtProcessService } from '@opensumi/ide-extension/lib/common/extension.service';

import { DebugConfigurationContribution } from './debug-configuration.contribution';
import { EditorEmptyComponentContribution } from './editor-empty-component.contribution';
import { MenuBarContribution } from './menu-bar/menu-bar.contribution';
import { OverrideExtensionNodeService } from './overrides/extension/extension-node.service';
import { StatusBarContribution } from './status-bar.contribution';
import { TerminalReconnectNotifyContribution } from './terminal-reconnect-notify.contribution';
import { WatcherDebugContribution } from './watcher-debug.contribution';

export const baseSampleProviders: Provider[] = [
  MenuBarContribution,
  EditorEmptyComponentContribution,
  StatusBarContribution,
  DebugConfigurationContribution,
  WatcherDebugContribution,
  TerminalReconnectNotifyContribution,
  {
    token: AbstractNodeExtProcessService,
    useClass: OverrideExtensionNodeService,
    override: true,
  },
];

@Injectable()
export class BaseSampleModule extends BrowserModule {
  providers = baseSampleProviders;
}

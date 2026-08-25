import { AINativeModule } from '@opensumi/ide-ai-native/lib/browser';
import { BrowserModule, ConstructorOf } from '@opensumi/ide-core-browser';
import { DesignModule } from '@opensumi/ide-design/lib/browser';

export const AIBrowserModules: ConstructorOf<BrowserModule>[] = [DesignModule, AINativeModule];

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import { AINativeContribution } from './ai-native/ai-native.contribution';

@Injectable()
export class AISampleModule extends BrowserModule {
  providers = [AINativeContribution];
}

import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import { AINativeContribution } from './ai-native/ai-native.contribution';
import { baseSampleProviders } from './base';

export { AISampleModule } from './ai-module';
export { BaseSampleModule } from './base';

@Injectable()
export class SampleModule extends BrowserModule {
  providers: Provider[] = [...baseSampleProviders, AINativeContribution];
}

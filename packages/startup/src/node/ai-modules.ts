import { AINativeModule } from '@opensumi/ide-ai-native/lib/node';
import { ConstructorOf, NodeModule } from '@opensumi/ide-core-node';

export const AINodeModules: ConstructorOf<NodeModule>[] = [AINativeModule];

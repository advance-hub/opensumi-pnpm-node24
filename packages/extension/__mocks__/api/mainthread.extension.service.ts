import { VSCodeExtensionService } from '../../src/common/vscode';
import { mockExtensionProps, mockExtensionProps2 } from '../extensions';

export class MainThreadExtensionService implements VSCodeExtensionService {
  constructor(public extensions = [mockExtensionProps, mockExtensionProps2]) {}

  $getExtensions() {
    return Promise.resolve(this.extensions);
  }

  $activateExtension(extensionPath: string) {
    return Promise.resolve();
  }

  $getStaticServicePath() {
    return Promise.resolve('http://localhost:57889');
  }
}

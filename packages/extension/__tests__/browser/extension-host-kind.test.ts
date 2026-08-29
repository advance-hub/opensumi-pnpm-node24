import { shouldRunExtensionInWorker } from '../../src/browser/extension-host-kind';
import { normalizeWorkerEntryScript } from '../../src/browser/extension-worker.service';

describe('extension host selection', () => {
  it('runs browser-only extensions in the Worker', () => {
    expect.assertions(1);
    expect(shouldRunExtensionInWorker({ browser: './browser.js' })).toBe(true);
  });

  it('honors UI preference for dual-entry extensions', () => {
    expect.assertions(2);
    expect(
      shouldRunExtensionInWorker({
        main: './node.js',
        browser: './browser.js',
        extensionKind: ['ui', 'workspace'],
      }),
    ).toBe(true);
    expect(shouldRunExtensionInWorker({ main: './node.js', browser: './browser.js', extensionKind: 'ui' })).toBe(true);
  });

  it('keeps workspace and unspecified dual-entry extensions in the Node host', () => {
    expect.assertions(2);
    expect(shouldRunExtensionInWorker({ main: './node.js', browser: './browser.js', extensionKind: 'workspace' })).toBe(
      false,
    );
    expect(shouldRunExtensionInWorker({ main: './node.js', browser: './browser.js' })).toBe(false);
  });

  it('never moves Node-only or backend contribution extensions into the Worker', () => {
    expect.assertions(4);
    expect(shouldRunExtensionInWorker({ main: './node.js' }, true)).toBe(false);
    expect(shouldRunExtensionInWorker({ contributes: { debuggers: [] } }, true)).toBe(false);
    expect(shouldRunExtensionInWorker({ contributes: { terminal: {} } }, true)).toBe(false);
    expect(shouldRunExtensionInWorker({ contributes: { typescriptServerPlugins: [] } }, true)).toBe(false);
  });

  it('uses the Worker fallback for contribution-only extensions when the Node host is disabled', () => {
    expect.assertions(2);
    expect(shouldRunExtensionInWorker({ contributes: { themes: [] } }, true)).toBe(true);
    expect(shouldRunExtensionInWorker({ contributes: { themes: [] } }, false)).toBe(false);
  });

  it('preserves JavaScript module suffixes for Worker entry scripts', () => {
    expect.assertions(4);
    expect(normalizeWorkerEntryScript('./extension')).toBe('./extension.js');
    expect(normalizeWorkerEntryScript('./extension.js')).toBe('./extension.js');
    expect(normalizeWorkerEntryScript('./extension.cjs')).toBe('./extension.cjs');
    expect(normalizeWorkerEntryScript('./extension.mjs')).toBe('./extension.mjs');
  });
});

import type { JSONType } from '../common';

function preferredExtensionKind(packageJSON: JSONType): string | undefined {
  const extensionKind = packageJSON.extensionKind;
  if (Array.isArray(extensionKind)) {
    return typeof extensionKind[0] === 'string' ? extensionKind[0] : undefined;
  }
  return typeof extensionKind === 'string' ? extensionKind : undefined;
}

/**
 * Select the browser Worker only when the manifest provides a browser entry.
 * For dual-entry extensions, `extensionKind: ui` means the UI-side host is the
 * preferred runtime; the Node host remains the fallback for workspace kinds.
 */
export function shouldRunExtensionInWorker(packageJSON: JSONType = {}, noExtHost = false): boolean {
  const { browser, main } = packageJSON;

  if (browser && !main) {
    return true;
  }
  if (browser && main) {
    return noExtHost || preferredExtensionKind(packageJSON) === 'ui';
  }
  if (!browser && main) {
    return false;
  }

  const contributes = packageJSON.contributes;
  if (contributes && typeof contributes === 'object') {
    for (const id of ['debuggers', 'terminal', 'typescriptServerPlugins']) {
      if (Object.prototype.hasOwnProperty.call(contributes, id)) {
        return false;
      }
    }
  }

  return noExtHost;
}

import path from 'node:path';

export const EXTENSION_DIRECTORY_ENVIRONMENT = 'OPENSUMI_EXTENSION_DIR';

/**
 * Production must not inherit extensions from the host user's home directory.
 * A deployment can mount a curated, persistent extension volume explicitly;
 * development keeps the framework's existing ~/.sumi/extensions default.
 */
export function resolveMarketplaceExtensionDirectory(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment[EXTENSION_DIRECTORY_ENVIRONMENT]?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (environment.NODE_ENV === 'production') {
    return path.join(rootDirectory, 'tools/extensions');
  }
  return undefined;
}

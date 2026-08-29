import { existsSync } from 'node:fs';
import path from 'node:path';

import { validateWorkspaceAgentPackage } from '@opensumi/ide-file-service/lib/node/workspace-agent';

const WORKSPACE_AGENT_MODE_ENVIRONMENTS = [
  'OPENSUMI_WORKSPACE_AGENT_WATCH_MODE',
  'OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE',
  'OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE',
] as const;

const REQUIRED_AUTO_ROLLOUT_SERVICES = [
  'workspace.watch.v1',
  'workspace.search.v1',
  'workspace.fileSearch.v1',
] as const;

export function configureWorkspaceAgentDefaultModes(
  environment: NodeJS.ProcessEnv,
  nativePackageAvailable: boolean,
): boolean {
  if (
    !nativePackageAvailable ||
    ['0', 'off', 'disabled'].includes(environment.OPENSUMI_WORKSPACE_AGENT_AUTO_MODE || '')
  ) {
    return false;
  }
  for (const name of WORKSPACE_AGENT_MODE_ENVIRONMENTS) {
    environment[name] ??= 'enabled';
  }
  return true;
}

export function hasRunnableWorkspaceAgentPackage(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const binaryName = process.platform === 'win32' ? 'workspace-agent.exe' : 'workspace-agent';
  const configured = environment.OPENSUMI_WORKSPACE_AGENT_PATH;
  const candidates = configured
    ? [path.resolve(configured)]
    : environment.NODE_ENV === 'production'
      ? [path.join(rootDirectory, 'server/dist/workspace-agent', binaryName)]
      : [
          path.join(rootDirectory, 'go/workspace-agent/bin', binaryName),
          path.join(rootDirectory, 'server/dist/workspace-agent', binaryName),
        ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const manifest = validateWorkspaceAgentPackage(candidate, {
        requireManifest: environment.NODE_ENV === 'production',
      });
      return (
        !manifest ||
        (manifest.nativeStartupVerified === true &&
          REQUIRED_AUTO_ROLLOUT_SERVICES.every((service) => manifest.services.includes(service)))
      );
    } catch {
      return false;
    }
  }
  return false;
}

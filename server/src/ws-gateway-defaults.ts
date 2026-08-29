import { existsSync } from 'node:fs';
import path from 'node:path';

import { validateWsGatewayPackage } from './ws-gateway.ts';

export type WsGatewayModeSource = 'explicit' | 'default';

export interface WsGatewayModeResolution {
  mode: 'gateway' | 'direct';
  source: WsGatewayModeSource;
}

const GATEWAY_ON_VALUES = ['1', 'enabled'] as const;

export function resolveWsGatewayMode(
  environment: NodeJS.ProcessEnv,
  gatewayAvailable: boolean,
): WsGatewayModeResolution {
  const raw = (environment.OPENSUMI_WS_GATEWAY_MODE || '').toLowerCase();
  // Anything explicitly set — including the accepted off spellings ("0", "off",
  // "disabled") — keeps the historical "anything not enabled is off" behavior
  // instead of silently opting deployments into the Go entrypoint.
  if (GATEWAY_ON_VALUES.includes(raw as '1' | 'enabled')) {
    return { mode: 'gateway', source: 'explicit' };
  }
  if (raw.length > 0) {
    return { mode: 'direct', source: 'explicit' };
  }
  return { mode: gatewayAvailable ? 'gateway' : 'direct', source: 'default' };
}

export function hasRunnableWsGatewayPackage(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
  const configured = environment.OPENSUMI_WS_GATEWAY_PATH;
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
      const manifest = validateWsGatewayPackage(candidate, environment.NODE_ENV === 'production');
      return !manifest || true;
    } catch {
      return false;
    }
  }
  return false;
}

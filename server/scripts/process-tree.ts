import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessRole =
  | 'server'
  | 'extension-host'
  | 'extension-child'
  | 'watcher-host'
  | 'workspace-agent'
  | 'workspace-agent-child'
  | 'ws-gateway'
  | 'pty-host'
  | 'terminal-shell'
  | 'language-server'
  | 'node-child'
  | 'other';

export interface ProcessMemoryRecord {
  pid: number;
  parentPid: number;
  rssBytes: number;
  elapsed?: string;
  commandLine: string;
}

export interface ProcessRoleSummary {
  count: number;
  rssBytes: number;
}

export interface LinuxCgroupMemory {
  path: string;
  currentBytes?: number;
  peakBytes?: number;
  maxBytes?: number;
}

export interface ProcessTreeMemorySnapshot {
  timestamp: string;
  rootPid: number;
  processCount: number;
  totalRssBytes: number;
  byRole: Partial<Record<ProcessRole, ProcessRoleSummary>>;
  processes: Array<ProcessMemoryRecord & { role: ProcessRole }>;
  linuxCgroup?: LinuxCgroupMemory;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function redactCommandLine(commandLine: string): string {
  return commandLine
    .replace(
      /(\s--?(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|authorization|password|secret)(?:=|\s+))(?:("[^"]*")|('[^']*')|(\S+))/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function parsePosixProcessList(output: string): ProcessMemoryRecord[] {
  const processes: ProcessMemoryRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) {
      continue;
    }
    const pid = parsePositiveInteger(match[1]);
    const parentPid = parsePositiveInteger(match[2]);
    const rssKiB = parsePositiveInteger(match[3]);
    if (pid === undefined || parentPid === undefined || rssKiB === undefined) {
      continue;
    }
    processes.push({
      pid,
      parentPid,
      rssBytes: rssKiB * 1024,
      elapsed: match[4],
      commandLine: redactCommandLine(match[5].trim()),
    });
  }
  return processes;
}

interface WindowsProcessRecord {
  ProcessId?: number;
  ParentProcessId?: number;
  WorkingSetSize?: number | string;
  Name?: string;
  CommandLine?: string | null;
}

export function parseWindowsProcessList(output: string): ProcessMemoryRecord[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as WindowsProcessRecord | WindowsProcessRecord[];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.flatMap((record) => {
    const pid = Number(record.ProcessId);
    const parentPid = Number(record.ParentProcessId);
    const rssBytes = Number(record.WorkingSetSize);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !Number.isFinite(rssBytes)) {
      return [];
    }
    return [
      {
        pid,
        parentPid,
        rssBytes,
        commandLine: redactCommandLine(record.CommandLine || record.Name || ''),
      },
    ];
  });
}

export function selectProcessTree(processes: ProcessMemoryRecord[], rootPid: number): ProcessMemoryRecord[] {
  const childrenByParent = new Map<number, ProcessMemoryRecord[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.parentPid) || [];
    children.push(process);
    childrenByParent.set(process.parentPid, children);
  }

  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const root = byPid.get(rootPid);
  if (!root) {
    return [];
  }

  const result: ProcessMemoryRecord[] = [];
  const pending = [root];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.pid)) {
      continue;
    }
    visited.add(current.pid);
    result.push(current);
    pending.push(...(childrenByParent.get(current.pid) || []));
  }
  return result;
}

function executableBasename(commandLine: string): string {
  const match = commandLine.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = (match?.[1] || match?.[2] || match?.[3] || '').replace(/[()]/g, '');
  return executable.split(/[/\\]/).pop()?.toLowerCase() || '';
}

export function classifyProcessRole(process: ProcessMemoryRecord, rootPid: number): ProcessRole {
  if (process.pid === rootPid) {
    return 'server';
  }

  const command = process.commandLine.toLowerCase();
  const executable = executableBasename(command);
  if (command.includes('ext.process') || command.includes('extension-host') || command.includes('extensionhost')) {
    return 'extension-host';
  }
  if (command.includes('watcher.process') || command.includes('watcher-host')) {
    return 'watcher-host';
  }
  if (executable === 'workspace-agent' || executable === 'workspace-agent.exe') {
    return 'workspace-agent';
  }
  if (executable === 'ws-gateway' || executable === 'ws-gateway.exe') {
    return 'ws-gateway';
  }
  if (command.includes('pty.proxy') || command.includes('pty-host') || command.includes('pty-service')) {
    return 'pty-host';
  }
  if (
    ['bash', 'cmd.exe', 'dash', 'fish', 'ksh', 'nu', 'powershell.exe', 'pwsh', 'sh', 'zsh'].includes(executable) &&
    !/(?:^|\s)-(?:\S*?c|command)(?:\s|=)/.test(command)
  ) {
    return 'terminal-shell';
  }
  if (
    command.includes('language-server') ||
    command.includes('typescript-language-server') ||
    command.includes('rust-analyzer') ||
    command.includes('pyright') ||
    command.includes('gopls') ||
    command.includes('jdtls') ||
    command.includes('clangd')
  ) {
    return 'language-server';
  }
  if (/(^|[/\\\s])node(?:\.exe)?([\s]|$)/.test(command)) {
    return 'node-child';
  }
  return 'other';
}

export function summarizeProcessTree(
  processes: ProcessMemoryRecord[],
  rootPid: number,
): Pick<ProcessTreeMemorySnapshot, 'processCount' | 'totalRssBytes' | 'byRole' | 'processes'> {
  const initiallyClassified = processes.map((process) => ({
    ...process,
    role: classifyProcessRole(process, rootPid),
  }));
  const byPid = new Map(initiallyClassified.map((process) => [process.pid, process]));
  const withRoles = initiallyClassified.map((process) => {
    if (process.role !== 'other' && process.role !== 'node-child') {
      return process;
    }
    const visited = new Set<number>([process.pid]);
    let parent = byPid.get(process.parentPid);
    while (parent && !visited.has(parent.pid)) {
      visited.add(parent.pid);
      if (parent.role === 'extension-host' || parent.role === 'extension-child') {
        return { ...process, role: 'extension-child' as const };
      }
      if (parent.role === 'workspace-agent' || parent.role === 'workspace-agent-child') {
        return { ...process, role: 'workspace-agent-child' as const };
      }
      parent = byPid.get(parent.parentPid);
    }
    return process;
  });
  const byRole: Partial<Record<ProcessRole, ProcessRoleSummary>> = {};
  for (const process of withRoles) {
    const summary = byRole[process.role] || { count: 0, rssBytes: 0 };
    summary.count += 1;
    summary.rssBytes += process.rssBytes;
    byRole[process.role] = summary;
  }
  return {
    processCount: withRoles.length,
    totalRssBytes: withRoles.reduce((total, process) => total + process.rssBytes, 0),
    byRole,
    processes: withRoles,
  };
}

async function collectAllProcesses(): Promise<ProcessMemoryRecord[]> {
  if (process.platform === 'win32') {
    const script = [
      'Get-CimInstance Win32_Process',
      'Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseWindowsProcessList(stdout);
  }

  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,etime=,args='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePosixProcessList(stdout);
}

async function readNumericFile(filePath: string): Promise<number | undefined> {
  try {
    const value = (await readFile(filePath, 'utf8')).trim();
    if (value === 'max') {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readLinuxCgroupMemory(rootPid: number): Promise<LinuxCgroupMemory | undefined> {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    const cgroup = await readFile(`/proc/${rootPid}/cgroup`, 'utf8');
    const unifiedPath = cgroup
      .split(/\r?\n/)
      .find((line) => line.startsWith('0::'))
      ?.slice(3);
    if (!unifiedPath) {
      return undefined;
    }
    const relativePath = unifiedPath.replace(/^\/+/, '');
    const cgroupDirectory = path.join('/sys/fs/cgroup', relativePath);
    const [currentBytes, peakBytes, maxBytes] = await Promise.all([
      readNumericFile(path.join(cgroupDirectory, 'memory.current')),
      readNumericFile(path.join(cgroupDirectory, 'memory.peak')),
      readNumericFile(path.join(cgroupDirectory, 'memory.max')),
    ]);
    if (currentBytes === undefined && peakBytes === undefined && maxBytes === undefined) {
      return undefined;
    }
    return {
      path: unifiedPath,
      currentBytes,
      peakBytes,
      maxBytes,
    };
  } catch {
    return undefined;
  }
}

export async function collectProcessTreeMemory(rootPid: number): Promise<ProcessTreeMemorySnapshot> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new Error('rootPid must be a positive integer');
  }
  const allProcesses = await collectAllProcesses();
  const tree = selectProcessTree(allProcesses, rootPid);
  if (tree.length === 0) {
    throw new Error(`Process ${rootPid} is not running or cannot be inspected`);
  }
  return {
    timestamp: new Date().toISOString(),
    rootPid,
    ...summarizeProcessTree(tree, rootPid),
    linuxCgroup: await readLinuxCgroupMemory(rootPid),
  };
}

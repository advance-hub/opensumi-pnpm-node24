import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const agentDirectory = path.join(repoRoot, 'go/workspace-agent');

interface PackageOptions {
  goos: 'darwin' | 'linux' | 'windows';
  goarch: 'amd64' | 'arm64';
  outputPath: string;
  revision?: string;
}

function usage(): string {
  return [
    'Usage: pnpm --dir server package:workspace-agent -- [options]',
    '',
    'Options:',
    '  --goos <darwin|linux|windows>  Target OS, defaults to the host OS',
    '  --goarch <amd64|arm64>  Target architecture, defaults to the host architecture',
    '  --output <path>         Binary output, defaults to server/dist/workspace-agent/workspace-agent',
    '  --revision <value>      Build revision, defaults to the current Git revision',
  ].join('\n');
}

function hostGoos(): 'darwin' | 'linux' | 'windows' {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform;
  }
  if (process.platform === 'win32') {
    return 'windows';
  }
  throw new Error(`Workspace Agent packaging is not supported on ${process.platform}`);
}

function hostGoarch(): 'amd64' | 'arm64' {
  if (process.arch === 'x64') {
    return 'amd64';
  }
  if (process.arch === 'arm64') {
    return 'arm64';
  }
  throw new Error(`Workspace Agent packaging is not supported on ${process.arch}`);
}

function parseOptions(argv: string[]): PackageOptions | undefined {
  argv = argv.filter((argument) => argument !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${option || '<end>'}`);
    }
    if (!['--goos', '--goarch', '--output', '--revision'].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    values.set(option, value);
  }
  const goos = values.get('--goos') || hostGoos();
  const goarch = values.get('--goarch') || hostGoarch();
  if (goos !== 'darwin' && goos !== 'linux' && goos !== 'windows') {
    throw new Error('--goos must be darwin, linux or windows');
  }
  if (goarch !== 'amd64' && goarch !== 'arm64') {
    throw new Error('--goarch must be amd64 or arm64');
  }
  if (goos === 'darwin' && (process.platform !== 'darwin' || goarch !== hostGoarch())) {
    throw new Error('Darwin packaging requires a matching macOS host because the FSEvents backend uses CGO');
  }
  const revision = values.get('--revision');
  if (revision && !/^[A-Za-z0-9._+-]+$/.test(revision)) {
    throw new Error('--revision may only contain letters, numbers, dot, underscore, plus and hyphen');
  }
  const defaultBinary = goos === 'windows' ? 'workspace-agent.exe' : 'workspace-agent';
  const outputPath = path.resolve(
    repoRoot,
    values.get('--output') || path.join('server/dist/workspace-agent', defaultBinary),
  );
  if (goos === 'windows' && path.extname(outputPath).toLowerCase() !== '.exe') {
    throw new Error('Windows Workspace Agent output must use the .exe extension');
  }
  return {
    goos,
    goarch,
    outputPath,
    revision,
  };
}

async function getRevision(configuredRevision?: string): Promise<string> {
  if (configuredRevision) {
    return configuredRevision;
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repoRoot });
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${stdout.trim()}${status.trim() ? '-dirty' : ''}`;
  } catch {
    return 'development';
  }
}

async function packageWorkspaceAgent(options: PackageOptions): Promise<void> {
  const revision = await getRevision(options.revision);
  const outputDirectory = path.dirname(options.outputPath);
  const temporaryPath = `${options.outputPath}.tmp-${process.pid}`;
  const gatewayBinaryName = options.goos === 'windows' ? 'ws-gateway.exe' : 'ws-gateway';
  const gatewayOutputPath = path.join(outputDirectory, gatewayBinaryName);
  const temporaryGatewayPath = `${gatewayOutputPath}.tmp-${process.pid}`;
  const manifestPath = path.join(outputDirectory, 'workspace-agent.manifest.json');
  const gatewayManifestPath = path.join(outputDirectory, 'ws-gateway.manifest.json');
  await mkdir(outputDirectory, { recursive: true });
  await rm(temporaryPath, { force: true });
  await rm(temporaryGatewayPath, { force: true });
  try {
    await execFileAsync(
      'go',
      [
        'build',
        '-C',
        agentDirectory,
        '-buildvcs=false',
        '-trimpath',
        '-ldflags',
        `-X main.buildRevision=${revision}`,
        '-o',
        temporaryPath,
        './cmd/workspace-agent',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CGO_ENABLED: options.goos === 'darwin' ? '1' : '0',
          GOOS: options.goos,
          GOARCH: options.goarch,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    await execFileAsync(
      'go',
      [
        'build',
        '-C',
        agentDirectory,
        '-buildvcs=false',
        '-trimpath',
        '-ldflags',
        `-X main.buildRevision=${revision}`,
        '-o',
        temporaryGatewayPath,
        './cmd/ws-gateway',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CGO_ENABLED: options.goos === 'darwin' ? '1' : '0',
          GOOS: options.goos,
          GOARCH: options.goarch,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    await chmod(temporaryPath, 0o755);
    await chmod(temporaryGatewayPath, 0o755);
    await rename(temporaryPath, options.outputPath);
    await rename(temporaryGatewayPath, gatewayOutputPath);
    const nativeStartupVerified = options.goos === hostGoos() && options.goarch === hostGoarch();
    if (nativeStartupVerified) {
      await execFileAsync(options.outputPath, ['--help'], { cwd: repoRoot });
      await execFileAsync(gatewayOutputPath, ['--help'], { cwd: repoRoot });
    }
    const binary = await readFile(options.outputPath);
    const gatewayBinary = await readFile(gatewayOutputPath);
    const builtAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      protocolMajor: 1,
      protocolMinor: 2,
      services: ['workspace.watch.v1', 'workspace.search.v1', 'workspace.fileSearch.v1'],
      goos: options.goos,
      goarch: options.goarch,
      revision,
      binary: path.basename(options.outputPath),
      sha256: createHash('sha256').update(binary).digest('hex'),
      nativeStartupVerified,
      builtAt,
    };
    const gatewayManifest = {
      schemaVersion: 1,
      protocol: 'opensumi-ws-bridge-v1',
      goos: options.goos,
      goarch: options.goarch,
      revision,
      binary: path.basename(gatewayOutputPath),
      sha256: createHash('sha256').update(gatewayBinary).digest('hex'),
      nativeStartupVerified,
      builtAt,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(gatewayManifestPath, `${JSON.stringify(gatewayManifest, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          outputPath: options.outputPath,
          manifestPath,
          ...manifest,
          wsGateway: {
            outputPath: gatewayOutputPath,
            manifestPath: gatewayManifestPath,
            ...gatewayManifest,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(temporaryGatewayPath, { force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options) {
    await packageWorkspaceAgent(options);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});

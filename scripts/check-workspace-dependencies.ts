import fs from 'node:fs';
import path from 'node:path';

const roots = ['client', 'packages', 'server', 'tools'];
const ignoredDirectories = new Set(['__mocks__', 'dist', 'lib', 'node_modules', 'test-results']);
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const localProtocols = /^(?:workspace|file|link|portal):/;
const packageFiles: string[] = [];

type DependencySection = (typeof dependencySections)[number];
type PackageManifest = Partial<Record<DependencySection, Record<string, string>>>;

function collectPackageFiles(directory: string): void {
  if (!fs.existsSync(directory)) {
    return;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectPackageFiles(entryPath);
    } else if (entry.name === 'package.json') {
      packageFiles.push(entryPath);
    }
  }
}

for (const root of roots) {
  collectPackageFiles(root);
}

const versions = new Map<string, Map<string, string[]>>();
for (const packageFile of packageFiles) {
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as PackageManifest;
  for (const section of dependencySections) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (localProtocols.test(range)) {
        continue;
      }
      const ranges = versions.get(name) || new Map();
      const users = ranges.get(range) || [];
      users.push(packageFile);
      ranges.set(range, users);
      versions.set(name, ranges);
    }
  }
}

const conflicts = [...versions.entries()]
  .filter(([, ranges]) => ranges.size > 1)
  .sort(([left], [right]) => left.localeCompare(right));

if (conflicts.length > 0) {
  console.error('Workspace dependency ranges are inconsistent:');
  for (const [name, ranges] of conflicts) {
    console.error(`\n${name}`);
    for (const [range, users] of ranges) {
      console.error(`  ${range}: ${users.join(', ')}`);
    }
  }
  process.exit(1);
}

console.log(`Checked ${packageFiles.length} workspace manifests: dependency ranges are consistent.`);

import * as path from 'node:path';

export function toPackageLibResourcePath(file: string): string {
  const segments = file.split(/[\\/]/);
  const sourceDirectoryIndex = segments.indexOf('src');

  if (sourceDirectoryIndex <= 0) {
    throw new Error(`Expected a package resource path containing a src directory: ${file}`);
  }

  segments[sourceDirectoryIndex] = 'lib';
  return path.join(...segments);
}

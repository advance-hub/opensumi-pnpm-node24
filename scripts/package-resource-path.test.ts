import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { toPackageLibResourcePath } from './fn/package-resource-path';

test('package resources map from src to lib with POSIX and Windows separators', () => {
  const expected = path.join('components', 'lib', 'style', 'index.less');

  assert.equal(toPackageLibResourcePath('components/src/style/index.less'), expected);
  assert.equal(toPackageLibResourcePath(String.raw`components\src\style\index.less`), expected);
});

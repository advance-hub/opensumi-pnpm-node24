import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveMarketplaceExtensionDirectory } from '../src/extension-directory';

const rootDirectory = path.resolve('/opt/opensumi');

test('production uses the product-owned extension directory by default', () => {
  assert.equal(
    resolveMarketplaceExtensionDirectory(rootDirectory, { NODE_ENV: 'production' }),
    path.join(rootDirectory, 'tools/extensions'),
  );
});

test('an explicit extension directory overrides the production default', () => {
  assert.equal(
    resolveMarketplaceExtensionDirectory(rootDirectory, {
      NODE_ENV: 'production',
      OPENSUMI_EXTENSION_DIR: '/data/opensumi/extensions',
    }),
    path.resolve('/data/opensumi/extensions'),
  );
});

test('development preserves the framework marketplace directory when no override is configured', () => {
  assert.equal(resolveMarketplaceExtensionDirectory(rootDirectory, { NODE_ENV: 'development' }), undefined);
});

test('blank overrides are ignored', () => {
  assert.equal(
    resolveMarketplaceExtensionDirectory(rootDirectory, {
      NODE_ENV: 'production',
      OPENSUMI_EXTENSION_DIR: '   ',
    }),
    path.join(rootDirectory, 'tools/extensions'),
  );
});

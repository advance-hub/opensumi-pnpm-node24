const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
  const helperPath = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');

  if (fs.existsSync(helperPath)) {
    const mode = fs.statSync(helperPath).mode;
    fs.chmodSync(helperPath, mode | 0o111);
  }
}

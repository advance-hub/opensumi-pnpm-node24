let err = false;

if (parseInt(process.versions.node.split('.')[0], 10) !== 24) {
  console.error('\x1b[1;31mPlease use Node.js 24 LTS.\x1b[0;0m');
  err = true;
}

const packageManager = process.env['npm_config_user_agent'] || '';
const packageManagerExec = process.env['npm_execpath'] || '';

if (!packageManager.startsWith('pnpm/') && !/pnpm(?:[\w.-]*\.c?js)?$/.test(packageManagerExec)) {
  console.error('\x1b[1;31mPlease use pnpm to install dependencies.\x1b[0;0m');
  err = true;
}

if (err) {
  console.error('');
  process.exit(1);
}

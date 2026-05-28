const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SINGBOX_CONF = '/etc/sing-box/config.json';
const APP_COMMAND = '/usr/local/bin/app';

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT_DIR, stdio: 'inherit' });
}

function installAppCommandIfPresent() {
  const installer = path.join(ROOT_DIR, 'scripts/install-app-command.sh');
  if (!fs.existsSync(APP_COMMAND) || !fs.existsSync(installer)) return;

  console.log('Updating app command...');
  run('bash', [installer]);
}

function syncPresetsIfConfigured() {
  if (!fs.existsSync(SINGBOX_CONF)) return;

  console.log('Syncing applied whitelist presets...');
  run('node', [path.join(__dirname, 'sync-presets.js')]);
}

try {
  installAppCommandIfPresent();
  syncPresetsIfConfigured();
} catch (e) {
  console.error(`postinstall failed: ${e.message}`);
  process.exit(1);
}

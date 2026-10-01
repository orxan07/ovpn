// Shared validation, atomic replacement and rollback for sing-box changes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const CONFIG = '/etc/sing-box/config.json';

function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function readConfig() {
  return JSON.parse(command('sudo', ['cat', CONFIG]));
}
function writeConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-singbox-'));
  const local = path.join(dir, 'config.json');
  const staged = `${CONFIG}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(local, JSON.stringify(config, null, 2), { mode: 0o600 });
    try { command('sing-box', ['check', '-c', local]); }
    catch { throw new Error('sing-box отклонил конфигурацию; рабочий файл не изменён'); }
    command('sudo', ['install', '-m', '600', local, staged]);
    command('sudo', ['mv', '-f', staged, CONFIG]);
  } finally {
    try { command('sudo', ['rm', '-f', staged]); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function applyConfig(config) {
  const previous = readConfig();
  writeConfig(config);
  try { command('sudo', ['systemctl', 'restart', 'sing-box']); }
  catch {
    try {
      writeConfig(previous);
      command('sudo', ['systemctl', 'restart', 'sing-box']);
    } catch {
      throw new Error('Перезапуск sing-box и восстановление предыдущего конфига не удались');
    }
    throw new Error('Перезапуск sing-box не удался; предыдущая конфигурация восстановлена');
  }
}
module.exports = { readConfig, writeConfig, applyConfig };

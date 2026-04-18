// Управление SSTP-сервером (accel-ppp): пользователи, сессии, рестарт.
//
// Требует sudo-прав на:
//   /usr/sbin/accel-cmd
//   /bin/cat /etc/accel-ppp/chap-secrets
//   /usr/bin/tee /etc/accel-ppp/chap-secrets
//   /bin/systemctl restart|is-active|show accel-ppp
// См. infra/sstp/sudoers.example

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const CHAP_SECRETS = '/etc/accel-ppp/chap-secrets';
const CONF = '/etc/accel-ppp.conf';
const SERVICE = 'accel-ppp';

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).toString();
}

function safeRun(cmd) {
  try { return run(cmd).trim(); } catch { return ''; }
}

function readSecrets() {
  return run(`sudo cat ${CHAP_SECRETS}`);
}

function writeSecrets(content) {
  const tmp = `/tmp/sstp-secrets-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  try {
    run(`sudo install -m 600 ${tmp} ${CHAP_SECRETS}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  // accel-ppp перечитывает chap-secrets при следующей попытке логина,
  // но мягко перезагрузим runtime-state
  safeRun('sudo /usr/sbin/accel-cmd reload');
}

// ── Users (chap-secrets) ─────────────────────────────

function parseSecrets(raw) {
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      // формат: user  server  password  ip
      const parts = l.split(/\s+/);
      return {
        name: parts[0],
        server: parts[1] || '*',
        password: parts[2] || '',
        ip: parts[3] || '*',
      };
    });
}

function serializeSecrets(users) {
  const header = '# user\tserver\tpassword\tip\n';
  const body = users
    .map(u => `${u.name}\t${u.server || '*'}\t${u.password}\t${u.ip || '*'}`)
    .join('\n');
  return header + body + '\n';
}

function getUsers() {
  return parseSecrets(readSecrets()).map(u => ({
    name: u.name,
    ip: u.ip,
    passwordLength: u.password.length,
  }));
}

function getUserWithPassword(name) {
  const u = parseSecrets(readSecrets()).find(x => x.name === name);
  if (!u) throw new Error(`Пользователь ${name} не найден`);
  return u;
}

function genPassword() {
  return crypto.randomBytes(8).toString('hex');
}

function validateName(name) {
  if (!name || !/^[a-zA-Z0-9_.-]{1,32}$/.test(name)) {
    throw new Error('Имя: только латиница, цифры, _ . -, до 32 символов');
  }
}

function validatePassword(password) {
  if (!password || password.length < 8 || password.length > 64) {
    throw new Error('Пароль: 8–64 символа');
  }
  if (/\s/.test(password)) throw new Error('Пароль не должен содержать пробелов');
}

function addUser(name, password) {
  validateName(name);
  const pwd = password || genPassword();
  validatePassword(pwd);

  const users = parseSecrets(readSecrets());
  if (users.some(u => u.name === name)) {
    throw new Error(`Пользователь ${name} уже существует`);
  }
  users.push({ name, server: '*', password: pwd, ip: '*' });
  writeSecrets(serializeSecrets(users));
  return { name, password: pwd };
}

function removeUser(name) {
  validateName(name);
  const users = parseSecrets(readSecrets());
  const filtered = users.filter(u => u.name !== name);
  if (filtered.length === users.length) {
    throw new Error(`Пользователь ${name} не найден`);
  }
  writeSecrets(serializeSecrets(filtered));
  // мягко прервать активную сессию (если есть)
  safeRun(`sudo /usr/sbin/accel-cmd "terminate username ${name} soft"`);
  return { ok: true };
}

function setPassword(name, password) {
  validateName(name);
  validatePassword(password);
  const users = parseSecrets(readSecrets());
  const u = users.find(x => x.name === name);
  if (!u) throw new Error(`Пользователь ${name} не найден`);
  u.password = password;
  writeSecrets(serializeSecrets(users));
  return { name, password };
}

// ── Sessions (accel-cmd show sessions) ─────────────────

// Парсер таблицы accel-cmd. Строки разделены пайпами, первая — заголовки.
// Пример:
//   ifname    | username | called-sid | sid | uptime  | type | comp | ip       | ...
//   sstp0     | keenetic | 1.2.3.4    | 12  | 0:01:23 | sstp |      | 10.27.0.2| ...
function parseSessions(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 1) return [];
  const headerIdx = lines.findIndex(l => /\bifname\b/.test(l) && l.includes('|'));
  if (headerIdx < 0) return [];

  const headers = lines[headerIdx].split('|').map(s => s.trim());
  const sessions = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split('|').map(s => s.trim());
    if (cols.length !== headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx]; });
    sessions.push({
      ifname: row.ifname || '',
      username: row.username || '',
      calledSid: row['called-sid'] || row.calling || '',
      sid: row.sid || '',
      uptime: row.uptime || '',
      type: row.type || '',
      ip: row.ip || '',
    });
  }
  return sessions;
}

function getSessions() {
  const raw = safeRun('sudo /usr/sbin/accel-cmd "show sessions ifname,username,called-sid,sid,uptime,type,ip"');
  if (!raw) return [];
  return parseSessions(raw);
}

function disconnectSession(ifname) {
  if (!/^sstp\d+$/.test(ifname)) throw new Error('Некорректный ifname');
  safeRun(`sudo /usr/sbin/accel-cmd "terminate if ${ifname}"`);
  return { ok: true };
}

// ── Status ──────────────────────────────────────────────

function getStatus() {
  const isActive = safeRun(`sudo systemctl is-active ${SERVICE}`) === 'active';
  let uptimeSec = null;
  let activeSince = null;
  try {
    const show = safeRun(`sudo systemctl show ${SERVICE} --property=ActiveEnterTimestamp,ActiveState`);
    const m = show.match(/ActiveEnterTimestamp=(.+)/);
    if (m && m[1] && m[1] !== '0' && m[1].trim()) {
      const date = new Date(m[1].trim());
      if (!isNaN(date.getTime())) {
        activeSince = date.toISOString();
        uptimeSec = Math.floor((Date.now() - date.getTime()) / 1000);
      }
    }
  } catch {}

  const sessions = isActive ? getSessions() : [];
  const port = readPort();
  const externalIp = readExternalIp();

  return {
    ok: isActive,
    status: isActive ? 'active' : 'inactive',
    uptimeSec,
    activeSince,
    port,
    externalIp,
    sessionsCount: sessions.length,
    usersCount: parseSecrets(safeRun(`sudo cat ${CHAP_SECRETS}`) || '').length,
  };
}

function readPort() {
  try {
    const conf = safeRun(`sudo cat ${CONF}`);
    const m = conf.match(/^\s*port\s*=\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

let _ipCache = { value: null, ts: 0 };
function readExternalIp() {
  // кэш на 10 минут чтобы не дёргать api.ipify каждые 5 секунд
  if (_ipCache.value && Date.now() - _ipCache.ts < 10 * 60 * 1000) return _ipCache.value;
  try {
    const ip = safeRun('curl -fsS --max-time 3 https://api.ipify.org');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      _ipCache = { value: ip, ts: Date.now() };
      return ip;
    }
  } catch {}
  // fallback — основной IP машины
  const fallback = safeRun(`hostname -I | awk '{print $1}'`);
  return fallback || null;
}

function restart() {
  run(`sudo systemctl restart ${SERVICE}`);
  return { ok: true };
}

module.exports = {
  getStatus,
  getUsers,
  getUserWithPassword,
  addUser,
  removeUser,
  setPassword,
  getSessions,
  disconnectSession,
  restart,
};

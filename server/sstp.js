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
const path = require('path');

const CHAP_SECRETS = '/etc/accel-ppp/chap-secrets';
const CONF = '/etc/accel-ppp.conf';
const SERVER_CERT = '/etc/accel-ppp/sstp/server.crt';
const SERVICE = 'accel-ppp';
const FIREWALL_SERVICE = 'sstp-firewall';
const FIREWALL_UNIT = '/etc/systemd/system/sstp-firewall.service';
const FIREWALL_SCRIPT = path.resolve(__dirname, '..', 'infra/sstp/firewall.sh');

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).toString();
}

function safeRun(cmd) {
  try { return run(cmd).trim(); } catch { return ''; }
}

function commandOk(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
  // После hard poweroff runtime iptables-правила могут отсутствовать.
  // Перед рестартом accel-ppp всегда восстанавливаем forwarding/NAT.
  applyFirewallRules();
  run(`sudo systemctl restart ${SERVICE}`);
  return { ok: true };
}

// ── Firewall/NAT автозапуск для SSTP ────────────────────

function getFirewallStatus() {
  const port = readPort() || 14942;
  const sstpNet = '10.27.0.0/24';
  const wanIf = safeRun(`ip route show default | awk '/default/ {print $5; exit}'`) || 'enp2s0';

  const rules = {
    inputPort: commandOk(`sudo iptables -C INPUT -p tcp --dport ${port} -j ACCEPT`),
    forwardIn: commandOk('sudo iptables -C FORWARD -i sstp+ -j ACCEPT'),
    forwardOut: commandOk('sudo iptables -C FORWARD -o sstp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT'),
    masquerade: commandOk(`sudo iptables -t nat -C POSTROUTING -s ${sstpNet} -o ${wanIf} -j MASQUERADE`),
  };

  let serviceState = 'inactive';
  try {
    serviceState = execSync(`sudo systemctl is-active ${FIREWALL_SERVICE}`, { encoding: 'utf8' }).trim();
  } catch (e) {
    serviceState = (e.stdout || '').toString().trim() || 'inactive';
  }

  let serviceEnabled = false;
  try {
    serviceEnabled = execSync(`sudo systemctl is-enabled ${FIREWALL_SERVICE}`, { encoding: 'utf8' }).trim() === 'enabled';
  } catch {}

  return {
    ok: Object.values(rules).every(Boolean),
    port,
    sstpNet,
    wanIf,
    rules,
    serviceState,
    serviceEnabled,
    unitInstalled: commandOk(`sudo test -f ${FIREWALL_UNIT}`),
    scriptPath: FIREWALL_SCRIPT,
  };
}

function applyFirewallRules() {
  if (!fs.existsSync(FIREWALL_SCRIPT)) {
    throw new Error(`Не найден firewall.sh: ${FIREWALL_SCRIPT}`);
  }
  run(`sudo /usr/bin/env bash ${FIREWALL_SCRIPT}`);
  return getFirewallStatus();
}

function firewallUnitText() {
  return `[Unit]
Description=Apply SSTP firewall/NAT rules
After=network-online.target
Wants=network-online.target
Before=accel-ppp.service

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash ${FIREWALL_SCRIPT}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
}

function enableFirewallAutostart() {
  if (!fs.existsSync(FIREWALL_SCRIPT)) {
    throw new Error(`Не найден firewall.sh: ${FIREWALL_SCRIPT}`);
  }

  const tmpUnit = `/tmp/sstp-firewall-${Date.now()}.service`;
  fs.writeFileSync(tmpUnit, firewallUnitText());
  try {
    run(`sudo install -m 644 ${tmpUnit} ${FIREWALL_UNIT}`);
  } finally {
    try { fs.unlinkSync(tmpUnit); } catch {}
  }

  run('sudo systemctl daemon-reload');
  run(`sudo systemctl enable --now ${FIREWALL_SERVICE}`);
  return getFirewallStatus();
}

function disableFirewallAutostart() {
  safeRun(`sudo systemctl disable --now ${FIREWALL_SERVICE}`);
  safeRun(`sudo rm -f ${FIREWALL_UNIT}`);
  safeRun('sudo systemctl daemon-reload');
  return getFirewallStatus();
}

function getServerCert() {
  // Возвращает PEM содержимого server.crt (для импорта в Trusted Root на Windows)
  const pem = safeRun(`sudo cat ${SERVER_CERT}`);
  if (!pem || !pem.includes('BEGIN CERTIFICATE')) {
    throw new Error(`Сертификат не найден: ${SERVER_CERT}`);
  }
  return pem;
}

// ── Интеграция SSTP↔sing-box (вкл/выкл из UI) ───────────

const SINGBOX_INTEGRATION_NFT = '/etc/nftables.d/sstp-singbox.nft';
const SINGBOX_INTEGRATION_UNIT = '/etc/systemd/system/sstp-singbox-route.service';

const NFT_RULES = `#!/usr/sbin/nft -f
# Managed by wg-admin (server/sstp.js). Do not edit by hand.
table inet sstp-singbox
delete table inet sstp-singbox

table inet sstp-singbox {
    chain prerouting_nat {
        type nat hook prerouting priority dstnat; policy accept;
        iifname != "sstp*" return
        meta l4proto { tcp, udp } th dport 53 dnat ip to 172.19.0.2
    }

    chain prerouting_mark {
        type filter hook prerouting priority mangle; policy accept;
        iifname != "sstp*" return
        ip daddr {
            10.0.0.0/8,
            172.16.0.0/12,
            192.168.0.0/16,
            169.254.0.0/16,
            127.0.0.0/8
        } return
        meta mark set 0x00002023 ct mark set 0x00002023
    }
}
`;

const SYSTEMD_UNIT = `[Unit]
Description=Route SSTP client traffic through sing-box (nftables)
After=sing-box.service accel-ppp.service network-online.target
Wants=sing-box.service network-online.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f ${SINGBOX_INTEGRATION_NFT}
ExecStop=/usr/sbin/nft delete table inet sstp-singbox
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;

function getSingboxIntegrationStatus() {
  // Активны ли наши правила в ядре
  let nftActive = false;
  try {
    execSync('sudo nft list table inet sstp-singbox >/dev/null 2>&1');
    nftActive = true;
  } catch {}

  const fileInstalled = (() => {
    try { execSync(`sudo test -f ${SINGBOX_INTEGRATION_NFT}`); return true; }
    catch { return false; }
  })();

  let serviceState = 'inactive';
  try {
    serviceState = execSync('sudo systemctl is-active sstp-singbox-route', { encoding: 'utf8' }).trim();
  } catch (e) {
    serviceState = (e.stdout || '').toString().trim() || 'inactive';
  }

  let serviceEnabled = false;
  try {
    const v = execSync('sudo systemctl is-enabled sstp-singbox-route', { encoding: 'utf8' }).trim();
    serviceEnabled = v === 'enabled';
  } catch {}

  // Проверяем что sing-box доступен (sbtun + table 2022 default)
  const sbtunUp = !!safeRun('ip -br link show sbtun 2>/dev/null');
  const route2022 = safeRun('ip route show table 2022 2>/dev/null');
  const route2022HasDefault = /^default via/m.test(route2022);

  return {
    active: nftActive && serviceState === 'active',
    nftActive,
    fileInstalled,
    serviceState,
    serviceEnabled,
    prerequisites: {
      sbtunUp,
      route2022HasDefault,
    },
  };
}

function enableSingboxIntegration() {
  // Pre-flight
  if (!safeRun('ip -br link show sbtun 2>/dev/null')) {
    throw new Error('Интерфейс sbtun не найден. sing-box не запущен или не использует tun.');
  }

  // Записать nft-конфиг
  const tmpNft = `/tmp/sstp-singbox-${Date.now()}.nft`;
  fs.writeFileSync(tmpNft, NFT_RULES);
  try {
    run(`sudo install -d /etc/nftables.d`);
    run(`sudo install -m 644 ${tmpNft} ${SINGBOX_INTEGRATION_NFT}`);
  } finally {
    try { fs.unlinkSync(tmpNft); } catch {}
  }

  // Записать systemd unit
  const tmpUnit = `/tmp/sstp-singbox-route-${Date.now()}.service`;
  fs.writeFileSync(tmpUnit, SYSTEMD_UNIT);
  try {
    run(`sudo install -m 644 ${tmpUnit} ${SINGBOX_INTEGRATION_UNIT}`);
  } finally {
    try { fs.unlinkSync(tmpUnit); } catch {}
  }

  // Активировать
  run('sudo systemctl daemon-reload');
  run('sudo systemctl enable --now sstp-singbox-route');

  // Убедиться что таблица применилась
  const check = safeRun('sudo nft list table inet sstp-singbox 2>&1');
  if (!check.includes('table inet sstp-singbox')) {
    throw new Error('nft не применил правила: ' + check);
  }

  return getSingboxIntegrationStatus();
}

function disableSingboxIntegration() {
  safeRun('sudo systemctl disable --now sstp-singbox-route');
  safeRun('sudo nft delete table inet sstp-singbox');
  safeRun(`sudo rm -f ${SINGBOX_INTEGRATION_NFT} ${SINGBOX_INTEGRATION_UNIT}`);
  safeRun('sudo systemctl daemon-reload');
  return getSingboxIntegrationStatus();
}

// ── Diagnostics: интеграция SSTP-трафика с sing-box ────

function getIntegrationDiagnostics() {
  const out = {};
  out.sstpStatus = (() => {
    try { return getStatus(); } catch (e) { return { error: e.message }; }
  })();

  // 1. iptables NAT - есть ли MASQUERADE для SSTP-подсети
  out.iptablesNat = safeRun('sudo iptables -t nat -S POSTROUTING')
    || safeRun('sudo iptables -t nat -L POSTROUTING -n -v');

  // 2. iptables FORWARD - проходит ли трафик от sstp+
  out.iptablesForward = safeRun('sudo iptables -S FORWARD');

  // 3. iptables mangle - tproxy метки (для transparent proxy схемы)
  out.iptablesMangle = safeRun('sudo iptables -t mangle -S');

  // 4. nftables - полное состояние (если используется nft вместо iptables)
  out.nftRuleset = safeRun('sudo nft list ruleset 2>/dev/null');

  // 5. ip rules - policy routing (часто sing-box использует свою таблицу)
  out.ipRules = safeRun('ip rule show');

  // 6. ip routes основной таблицы
  out.ipRoutesMain = safeRun('ip route show table main');

  // 7. ip routes всех таблиц с upstream-trafficом sing-box (часто 100, 7777)
  out.ipRoutesAll = safeRun('ip route show table all 2>/dev/null | head -100');

  // 8. что слушает sing-box (tun, tproxy, redirect)
  let singboxConfig = null;
  try {
    singboxConfig = JSON.parse(safeRun('sudo cat /etc/sing-box/config.json'));
  } catch {}
  out.singboxInbounds = singboxConfig
    ? (singboxConfig.inbounds || []).map(i => ({
        type: i.type,
        tag: i.tag,
        listen: i.listen,
        listen_port: i.listen_port,
        interface_name: i.interface_name,
        inet4_address: i.inet4_address,
        auto_route: i.auto_route,
      }))
    : null;

  // 9. интерфейсы sstp/wg/tun/sing-box
  out.interfaces = safeRun(`ip -br addr | grep -E '^(sstp|wg|tun|singbox|sing-box)' || true`);

  // 10. проверки наличия правил конкретно для SSTP-подсети
  const sstpNet = '10.27.0.0/24';
  out.checks = {
    masqueradeForSstp: out.iptablesNat.includes(sstpNet),
    forwardForSstpInterface: /sstp\+|sstp[0-9]/.test(out.iptablesForward),
    nftHasSstp: out.nftRuleset && (out.nftRuleset.includes('sstp') || out.nftRuleset.includes(sstpNet)),
    singboxHasTun: !!(out.singboxInbounds || []).find(i => i.type === 'tun'),
    singboxHasTproxy: !!(out.singboxInbounds || []).find(i => i.type === 'tproxy'),
    singboxHasRedirect: !!(out.singboxInbounds || []).find(i => i.type === 'redirect'),
  };

  return out;
}

function getCertInfo() {
  // Парсит cert через openssl: subject, issuer, SAN, даты, fingerprint
  const pem = getServerCert();
  const tmp = `/tmp/sstp-cert-info-${Date.now()}.pem`;
  fs.writeFileSync(tmp, pem);
  try {
    const text = safeRun(
      `openssl x509 -in ${tmp} -noout -subject -issuer -startdate -enddate -fingerprint -sha256 -ext subjectAltName 2>/dev/null`
    );
    return { pem, text };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
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
  getServerCert,
  getCertInfo,
  getFirewallStatus,
  applyFirewallRules,
  enableFirewallAutostart,
  disableFirewallAutostart,
  getIntegrationDiagnostics,
  getSingboxIntegrationStatus,
  enableSingboxIntegration,
  disableSingboxIntegration,
};

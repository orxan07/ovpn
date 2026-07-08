const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SINGBOX_CONF = '/etc/sing-box/config.json';
const DATA_DIR = path.join(__dirname, '../data');
const PROFILES_FILE = path.join(DATA_DIR, 'outline-profiles.json');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function readConfig() {
  return JSON.parse(run(`sudo cat ${SINGBOX_CONF}`));
}

function writeConfig(config) {
  const json = JSON.stringify(config, null, 2);
  const tmp = `/tmp/singbox-config-${Date.now()}.json`;
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  try {
    try {
      execFileSync('sing-box', ['check', '-c', tmp], { stdio: 'pipe' });
    } catch (e) {
      const details = [e.stdout, e.stderr]
        .filter(Boolean)
        .map(v => v.toString().trim())
        .filter(Boolean)
        .join('\n');
      throw new Error(`sing-box check failed${details ? `: ${details}` : ''}`);
    }
    run(`sudo cp ${tmp} ${SINGBOX_CONF}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function restartSingbox() {
  run('sudo systemctl restart sing-box');
}

function loadStore() {
  if (!fs.existsSync(PROFILES_FILE)) return { activeProfileId: null, profiles: [] };
  try {
    const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    return {
      activeProfileId: data.activeProfileId || null,
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
    };
  } catch {
    return { activeProfileId: null, profiles: [] };
  }
}

function saveStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseMethodPassword(raw) {
  let text = decodeURIComponent(raw);
  if (!text.includes(':')) {
    text = decodeBase64(text);
  }

  const idx = text.indexOf(':');
  if (idx <= 0) throw new Error('Некорректный ss:// ключ: не найден method:password');

  return {
    method: text.slice(0, idx),
    password: text.slice(idx + 1),
  };
}

function parseHostPort(raw) {
  const text = decodeURIComponent(raw).replace(/\/.*$/, '');
  let server;
  let port;

  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) throw new Error('Некорректный ss:// ключ: неверный IPv6 host');
    server = text.slice(1, end);
    port = text.slice(end + 1).replace(/^:/, '');
  } else {
    const idx = text.lastIndexOf(':');
    if (idx <= 0) throw new Error('Некорректный ss:// ключ: не найден server:port');
    server = text.slice(0, idx);
    port = text.slice(idx + 1);
  }

  const serverPort = Number(port);
  if (!server || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error('Некорректный ss:// ключ: неверный server или port');
  }

  return { server, server_port: serverPort };
}

function parseOutlineAccessKey(accessKey) {
  if (!accessKey || typeof accessKey !== 'string') throw new Error('Вставьте ss:// ключ Outline');

  const trimmed = accessKey.trim();
  if (!trimmed.startsWith('ss://')) throw new Error('Outline key должен начинаться с ss://');

  const withoutScheme = trimmed.slice('ss://'.length);
  const fragment = withoutScheme.includes('#')
    ? decodeURIComponent(withoutScheme.slice(withoutScheme.indexOf('#') + 1))
    : '';
  const withoutFragment = withoutScheme.split('#')[0];
  const main = withoutFragment.split('?')[0];

  let method;
  let password;
  let server;
  let server_port;

  if (main.includes('@')) {
    const at = main.lastIndexOf('@');
    ({ method, password } = parseMethodPassword(main.slice(0, at)));
    ({ server, server_port } = parseHostPort(main.slice(at + 1)));
  } else {
    const decoded = decodeBase64(decodeURIComponent(main));
    const at = decoded.lastIndexOf('@');
    if (at < 0) throw new Error('Некорректный ss:// ключ: не найден @server');
    ({ method, password } = parseMethodPassword(decoded.slice(0, at)));
    ({ server, server_port } = parseHostPort(decoded.slice(at + 1)));
  }

  if (!/^[a-z0-9._-]+$/i.test(method)) throw new Error(`Неподдерживаемый method: ${method}`);
  if (!password) throw new Error('Некорректный ss:// ключ: пустой password');

  return { type: 'shadowsocks', tag: 'outline', server, server_port, method, password, name: fragment };
}

function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function getOutline() {
  ensureInitialProfile();

  const config = readConfig();
  const outline = config.outbounds?.find(o => o.tag === 'outline');
  if (!outline) return { configured: false };
  const store = loadStore();

  return {
    configured: true,
    activeProfileId: store.activeProfileId,
    type: outline.type,
    tag: outline.tag,
    server: outline.server,
    server_port: outline.server_port,
    method: outline.method,
    passwordMasked: mask(outline.password),
    profiles: getProfiles(),
  };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    server: profile.outbound.server,
    server_port: profile.outbound.server_port,
    method: profile.outbound.method,
    passwordMasked: mask(profile.outbound.password),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function makeProfile(accessKey, name) {
  const parsed = parseOutlineAccessKey(accessKey);
  const profileName = (name || parsed.name || `${parsed.server}:${parsed.server_port}`).trim();
  const { name: _unusedName, ...outbound } = parsed;

  return {
    id: crypto.randomBytes(8).toString('hex'),
    name: profileName,
    outbound: { ...outbound, tag: 'outline' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function activeOutboundFromProfile(profile) {
  return {
    ...profile.outbound,
    tag: 'outline',
  };
}

function writeActiveOutline(outbound) {
  const config = readConfig();
  const outbounds = config.outbounds || [];
  const idx = outbounds.findIndex(o => o.tag === 'outline');
  if (idx < 0) throw new Error('В /etc/sing-box/config.json не найден outbound tag=outline');

  outbounds[idx] = outbound;
  config.outbounds = outbounds;

  writeConfig(config);
  restartSingbox();
}

function ensureInitialProfile() {
  const store = loadStore();
  if (store.profiles.length) return;

  const config = readConfig();
  const active = config.outbounds?.find(o => o.tag === 'outline');
  if (!active) return;

  const profile = {
    id: crypto.randomBytes(8).toString('hex'),
    name: `${active.server}:${active.server_port}`,
    outbound: {
      type: active.type,
      tag: 'outline',
      server: active.server,
      server_port: active.server_port,
      method: active.method,
      password: active.password,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveStore({ activeProfileId: profile.id, profiles: [profile] });
}

function getProfiles() {
  ensureInitialProfile();
  const store = loadStore();
  return store.profiles.map(profile => ({
    ...publicProfile(profile),
    active: profile.id === store.activeProfileId,
  }));
}

function addProfile(accessKey, name, activate = true) {
  ensureInitialProfile();
  const store = loadStore();
  const profile = makeProfile(accessKey, name);
  store.profiles.push(profile);
  saveStore(store);

  if (activate) return activateProfile(profile.id);

  return {
    activeProfileId: store.activeProfileId,
    profile: publicProfile(profile),
    profiles: getProfiles(),
  };
}

function activateProfile(id) {
  ensureInitialProfile();
  const store = loadStore();
  const profile = store.profiles.find(p => p.id === id);
  if (!profile) throw new Error('Outline profile не найден');

  writeActiveOutline(activeOutboundFromProfile(profile));

  profile.updatedAt = Date.now();
  store.activeProfileId = profile.id;
  saveStore(store);

  return getOutline();
}

function deleteProfile(id) {
  ensureInitialProfile();
  const store = loadStore();
  const profile = store.profiles.find(p => p.id === id);
  if (!profile) throw new Error('Outline profile не найден');
  if (store.activeProfileId === id) throw new Error('Нельзя удалить активный Outline profile');

  store.profiles = store.profiles.filter(p => p.id !== id);
  saveStore(store);

  return { ok: true, profiles: getProfiles() };
}

function updateOutline(accessKey) {
  return addProfile(accessKey, null, true);
}

module.exports = {
  getOutline,
  getProfiles,
  addProfile,
  activateProfile,
  deleteProfile,
  updateOutline,
  parseOutlineAccessKey,
};

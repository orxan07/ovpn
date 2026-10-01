// Хранилище для состояния клиентов: история endpoint'ов, лимиты, блокировки
// Данные хранятся в /opt/wg-admin/data/store.json — небольшой файл, не лог

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function load() {
  if (!fs.existsSync(STORE_FILE)) return Object.create(null);
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid store');
    return Object.assign(Object.create(null), data);
  } catch {
    throw new Error('Не удалось прочитать store.json; изменения отменены');
  }
}

function save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, STORE_FILE);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

// Возвращает данные клиента (создаёт если нет)
function getClient(name) {
  const store = load();
  if (!store[name]) store[name] = { endpoints: [], limitGb: null, blocked: false, note: '', createdAt: null, configToken: null };
  return store[name];
}

function generateConfigToken(name) {
  const token = require('crypto').randomBytes(16).toString('hex');
  const client = getClient(name);
  client.configToken = token;
  saveClient(name, client);
  return token;
}

// Найти клиента по configToken
function findByConfigToken(token) {
  const store = load();
  for (const [name, data] of Object.entries(store)) {
    if (data.configToken === token) return name;
  }
  return null;
}

function setCreatedAt(name, ts) {
  const client = getClient(name);
  if (!client.createdAt) {
    client.createdAt = ts || Date.now();
    saveClient(name, client);
  }
}

function saveClient(name, data) {
  const store = load();
  store[name] = data;
  save(store);
}

// Обновляет один снимок; IPv6 endpoint приходит как [address]:port.
function trackEndpointInSnapshot(client, endpoint, now) {
  const ip = endpoint.startsWith('[') ? endpoint.slice(1, endpoint.indexOf(']')) : endpoint.split(':')[0];
  client.endpoints = client.endpoints || [];
  const existing = client.endpoints.find(e => e.ip === ip);
  if (existing) {
    existing.lastSeen = now;
    existing.count = (existing.count || 1) + 1;
  } else {
    client.endpoints.unshift({ ip, firstSeen: now, lastSeen: now, count: 1 });
    client.endpoints = client.endpoints.slice(0, 20);
  }
}

function trackEndpoint(name, endpoint) {
  if (!endpoint) return;
  const client = getClient(name);
  trackEndpointInSnapshot(client, endpoint, Date.now());
  saveClient(name, client);
}

function updatePeers(peers, blockClient) {
  const data = load();
  let changed = false;
  const now = Date.now();
  for (const peer of peers) {
    const client = data[peer.name] || { endpoints: [], blocked: false, limitGb: null, note: '' };
    data[peer.name] = client;
    if (peer.endpoint) {
      trackEndpointInSnapshot(client, peer.endpoint, now);
      changed = true;
    }
    if (client.limitGb && !client.blocked && (peer.rx + peer.tx) >= client.limitGb * 1024 ** 3) {
      client.blocked = true;
      changed = true;
    }
  }
  // Persist the desired blocked state before touching runtime; retry on later polls.
  if (changed) save(data);
  for (const peer of peers) {
    if (data[peer.name]?.blocked) blockClient(peer.name);
  }
}

function deleteClient(name) {
  const data = load();
  delete data[name];
  save(data);
}

function resetClient(name) {
  saveClient(name, { endpoints: [], limitGb: null, blocked: false, note: '', createdAt: Date.now(), configToken: null });
}

// Блокировка
function setBlocked(name, blocked) {
  const client = getClient(name);
  client.blocked = blocked;
  saveClient(name, client);
}

// Лимит трафика в GB (null = без лимита)
function setLimit(name, limitGb) {
  const client = getClient(name);
  client.limitGb = limitGb;
  saveClient(name, client);
}

// Заметка
function setNote(name, note) {
  const client = getClient(name);
  client.note = note;
  saveClient(name, client);
}

function getAll() {
  return load();
}

// Переименовать клиента в store
function renameClient(oldName, newName) {
  const store = load();
  if (store[oldName]) {
    store[newName] = store[oldName];
    delete store[oldName];
    save(store);
  }
}

module.exports = { deleteClient, resetClient, updatePeers, getClient, saveClient, trackEndpoint, setBlocked, setLimit, setNote, setCreatedAt, getAll, renameClient, generateConfigToken, findByConfigToken };

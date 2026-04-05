// Хранилище для состояния клиентов: история endpoint'ов, лимиты, блокировки
// Данные хранятся в /opt/wg-admin/data/store.json — небольшой файл, не лог

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function load() {
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

// Возвращает данные клиента (создаёт если нет)
function getClient(name) {
  const store = load();
  if (!store[name]) store[name] = { endpoints: [], limitGb: null, blocked: false, note: '' };
  return store[name];
}

function saveClient(name, data) {
  const store = load();
  store[name] = data;
  save(store);
}

// Добавляет endpoint в историю клиента (макс 20 уникальных IP)
function trackEndpoint(name, endpoint) {
  if (!endpoint) return;
  const ip = endpoint.split(':')[0]; // только IP без порта
  const client = getClient(name);

  const existing = client.endpoints.find(e => e.ip === ip);
  if (existing) {
    existing.lastSeen = Date.now();
    existing.count = (existing.count || 1) + 1;
  } else {
    client.endpoints.unshift({ ip, firstSeen: Date.now(), lastSeen: Date.now(), count: 1 });
    if (client.endpoints.length > 20) client.endpoints = client.endpoints.slice(0, 20);
  }

  saveClient(name, client);
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

module.exports = { getClient, saveClient, trackEndpoint, setBlocked, setLimit, setNote, getAll, renameClient };

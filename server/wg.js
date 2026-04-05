const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = '/etc/wireguard/clients';
const WG_CONF = '/etc/wireguard/wg0.conf';
const WG_INTERFACE = 'wg0';
const SUBNET = '10.20.0';
const SERVER_PUBKEY = 'Wq9Db2KQ2EQtIxTSaKT1cel6T0dSLX+cQ5k1JHHAcCE=';
const SERVER_ENDPOINT = '171.22.75.104:443';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

// Парсит вывод `wg show wg0 dump`
// Формат: pubkey preshared endpoint allowed_ips last_handshake rx tx keepalive
function getPeersStatus() {
  try {
    const dump = run(`sudo wg show ${WG_INTERFACE} dump`);
    const lines = dump.split('\n').slice(1); // первая строка — сервер
    const peers = {};
    for (const line of lines) {
      if (!line.trim()) continue;
      const [pubkey, , endpoint, allowedIps, lastHandshake, rx, tx] = line.split('\t');
      peers[pubkey] = {
        endpoint: endpoint === '(none)' ? null : endpoint,
        allowedIps,
        lastHandshake: parseInt(lastHandshake),
        rx: parseInt(rx),
        tx: parseInt(tx),
      };
    }
    return peers;
  } catch {
    return {};
  }
}

// Читает все .conf файлы клиентов и возвращает список с именами и публичными ключами
function getClients() {
  const clients = [];
  if (!fs.existsSync(CLIENTS_DIR)) return clients;

  const files = fs.readdirSync(CLIENTS_DIR).filter(f => f.endsWith('.pub'));
  for (const file of files) {
    const name = file.replace('.pub', '');
    const pubkey = fs.readFileSync(path.join(CLIENTS_DIR, file), 'utf8').trim();
    // Читаем IP из .conf
    let ip = null;
    const confPath = path.join(CLIENTS_DIR, `${name}.conf`);
    if (fs.existsSync(confPath)) {
      const conf = fs.readFileSync(confPath, 'utf8');
      const match = conf.match(/Address\s*=\s*([\d.]+)/);
      if (match) ip = match[1];
    }
    clients.push({ name, pubkey, ip });
  }
  return clients;
}

// Объединяет клиентов с их live-статусом из wg show
function getPeersWithStatus() {
  const clients = getClients();
  const status = getPeersStatus();
  const now = Math.floor(Date.now() / 1000);

  return clients.map(client => {
    const s = status[client.pubkey] || {};
    const lastHandshake = s.lastHandshake || 0;
    const secondsAgo = lastHandshake ? now - lastHandshake : null;
    return {
      name: client.name,
      ip: client.ip,
      pubkey: client.pubkey,
      endpoint: s.endpoint || null,
      lastHandshake: lastHandshake || null,
      lastHandshakeAgo: secondsAgo,
      active: secondsAgo !== null && secondsAgo < 180, // активен если handshake < 3 минут назад
      rx: s.rx || 0,
      tx: s.tx || 0,
    };
  });
}

// Находит следующий свободный IP в подсети
function nextFreeIp() {
  const clients = getClients();
  const used = new Set(clients.map(c => c.ip).filter(Boolean));
  for (let i = 2; i < 254; i++) {
    const ip = `${SUBNET}.${i}`;
    if (!used.has(ip) && ip !== `${SUBNET}.1`) return ip;
  }
  throw new Error('Нет свободных IP адресов');
}

// Создаёт нового клиента
function createClient(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Недопустимое имя');

  const keyPath = path.join(CLIENTS_DIR, `${name}.key`);
  const pubPath = path.join(CLIENTS_DIR, `${name}.pub`);
  const confPath = path.join(CLIENTS_DIR, `${name}.conf`);

  if (fs.existsSync(confPath)) throw new Error(`Клиент ${name} уже существует`);

  const ip = nextFreeIp();

  // Генерируем ключи
  run(`sudo wg genkey | sudo tee ${keyPath} | wg pubkey | sudo tee ${pubPath}`);
  const privkey = run(`sudo cat ${keyPath}`);
  const pubkey = run(`sudo cat ${pubPath}`);

  // Создаём .conf
  const conf = `[Interface]
PrivateKey = ${privkey}
Address = ${ip}/32
DNS = 1.1.1.1
MTU = 1280

[Peer]
PublicKey = ${SERVER_PUBKEY}
Endpoint = ${SERVER_ENDPOINT}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`;
  run(`sudo bash -c 'cat > ${confPath} << '"'"'HEREDOC'"'"'\n${conf}\nHEREDOC'`);

  // Добавляем peer в wg0 (runtime)
  run(`sudo wg set ${WG_INTERFACE} peer ${pubkey} allowed-ips ${ip}/32`);

  // Дописываем в wg0.conf
  const peerBlock = `\n[Peer]\nPublicKey = ${pubkey}\nAllowedIPs = ${ip}/32\n`;
  run(`sudo bash -c 'echo "${peerBlock}" >> ${WG_CONF}'`);

  return { name, ip, pubkey, conf };
}

// Удаляет клиента
function deleteClient(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Недопустимое имя');

  const pubPath = path.join(CLIENTS_DIR, `${name}.pub`);
  if (!fs.existsSync(pubPath)) throw new Error(`Клиент ${name} не найден`);

  const pubkey = run(`sudo cat ${pubPath}`);

  // Убираем из runtime
  run(`sudo wg set ${WG_INTERFACE} peer ${pubkey} remove`);

  // Удаляем файлы
  for (const ext of ['.key', '.pub', '.conf']) {
    const f = path.join(CLIENTS_DIR, `${name}${ext}`);
    if (fs.existsSync(f)) run(`sudo rm ${f}`);
  }

  // TODO: убрать из wg0.conf (пока требует перезапуска wg-quick)
}

// Возвращает текст .conf файла
function getClientConf(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Недопустимое имя');
  const confPath = path.join(CLIENTS_DIR, `${name}.conf`);
  if (!fs.existsSync(confPath)) throw new Error(`Клиент ${name} не найден`);
  return run(`sudo cat ${confPath}`);
}

// Возвращает QR-код как PNG в base64
function getClientQr(name) {
  const conf = getClientConf(name);
  const tmpFile = `/tmp/wg-qr-${name}-${Date.now()}.png`;
  run(`echo '${conf.replace(/'/g, "'\\''")}' | qrencode -o ${tmpFile}`);
  const data = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);
  return data.toString('base64');
}

module.exports = {
  getPeersWithStatus,
  createClient,
  deleteClient,
  getClientConf,
  getClientQr,
};

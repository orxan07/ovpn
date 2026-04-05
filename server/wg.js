const { execSync } = require('child_process');
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

function validName(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Недопустимое имя');
}

function getPeersStatus() {
  try {
    const dump = run(`sudo wg show ${WG_INTERFACE} dump`);
    const lines = dump.split('\n').slice(1);
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

function getClients() {
  const clients = [];
  if (!fs.existsSync(CLIENTS_DIR)) return clients;

  const files = fs.readdirSync(CLIENTS_DIR).filter(f => f.endsWith('.pub'));
  for (const file of files) {
    const name = file.replace('.pub', '');
    const pubkey = fs.readFileSync(path.join(CLIENTS_DIR, file), 'utf8').trim();
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
      active: secondsAgo !== null && secondsAgo < 180,
      rx: s.rx || 0,
      tx: s.tx || 0,
    };
  });
}

function getPeerDetail(name) {
  validName(name);
  const clients = getClients();
  const client = clients.find(c => c.name === name);
  if (!client) throw new Error(`Клиент ${name} не найден`);

  const status = getPeersStatus();
  const now = Math.floor(Date.now() / 1000);
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
    active: secondsAgo !== null && secondsAgo < 180,
    rx: s.rx || 0,
    tx: s.tx || 0,
  };
}

function nextFreeIp() {
  const clients = getClients();
  const used = new Set(clients.map(c => c.ip).filter(Boolean));
  for (let i = 2; i < 254; i++) {
    const ip = `${SUBNET}.${i}`;
    if (!used.has(ip) && ip !== `${SUBNET}.1`) return ip;
  }
  throw new Error('Нет свободных IP адресов');
}

function createClient(name) {
  validName(name);

  const keyPath = path.join(CLIENTS_DIR, `${name}.key`);
  const pubPath = path.join(CLIENTS_DIR, `${name}.pub`);
  const confPath = path.join(CLIENTS_DIR, `${name}.conf`);

  if (fs.existsSync(confPath)) throw new Error(`Клиент ${name} уже существует`);

  const ip = nextFreeIp();

  run(`sudo wg genkey | sudo tee ${keyPath} | wg pubkey | sudo tee ${pubPath}`);
  const privkey = run(`sudo cat ${keyPath}`);
  const pubkey = run(`sudo cat ${pubPath}`);

  const conf = buildWgConf(privkey, ip);
  run(`sudo bash -c 'printf "%s" "${conf.replace(/"/g, '\\"')}" > ${confPath}'`);
  run(`sudo chmod 640 ${confPath} ${pubPath}`);
  run(`sudo chown root:${process.env.USER || 'orxan'} ${confPath} ${pubPath}`);

  run(`sudo wg set ${WG_INTERFACE} peer ${pubkey} allowed-ips ${ip}/32`);

  const peerBlock = `\\n[Peer]\\nPublicKey = ${pubkey}\\nAllowedIPs = ${ip}/32`;
  run(`sudo bash -c 'printf "${peerBlock}\\n" >> ${WG_CONF}'`);

  return { name, ip, pubkey, conf };
}

function buildWgConf(privkey, ip) {
  return `[Interface]
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
}

function renameClient(oldName, newName) {
  validName(oldName);
  validName(newName);

  const oldPub = path.join(CLIENTS_DIR, `${oldName}.pub`);
  if (!fs.existsSync(oldPub)) throw new Error(`Клиент ${oldName} не найден`);
  if (fs.existsSync(path.join(CLIENTS_DIR, `${newName}.pub`))) {
    throw new Error(`Клиент ${newName} уже существует`);
  }

  for (const ext of ['.key', '.pub', '.conf']) {
    const src = path.join(CLIENTS_DIR, `${oldName}${ext}`);
    const dst = path.join(CLIENTS_DIR, `${newName}${ext}`);
    if (fs.existsSync(src)) run(`sudo mv ${src} ${dst}`);
  }
}

function deleteClient(name) {
  validName(name);

  const pubPath = path.join(CLIENTS_DIR, `${name}.pub`);
  if (!fs.existsSync(pubPath)) throw new Error(`Клиент ${name} не найден`);

  const pubkey = fs.readFileSync(pubPath, 'utf8').trim();

  run(`sudo wg set ${WG_INTERFACE} peer ${pubkey} remove`);

  for (const ext of ['.key', '.pub', '.conf']) {
    const f = path.join(CLIENTS_DIR, `${name}${ext}`);
    if (fs.existsSync(f)) run(`sudo rm ${f}`);
  }
}

function getClientConf(name) {
  validName(name);
  const confPath = path.join(CLIENTS_DIR, `${name}.conf`);
  if (!fs.existsSync(confPath)) throw new Error(`Клиент ${name} не найден`);
  return fs.readFileSync(confPath, 'utf8');
}

function getClientQr(name) {
  const conf = getClientConf(name);
  const tmpFile = `/tmp/wg-qr-${name}-${Date.now()}.png`;
  const escaped = conf.replace(/'/g, "'\\''");
  run(`echo '${escaped}' | qrencode -o ${tmpFile}`);
  const data = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);
  return data.toString('base64');
}

function getSingboxConf(name, mode) {
  validName(name);
  const confPath = path.join(CLIENTS_DIR, `${name}.conf`);
  if (!fs.existsSync(confPath)) throw new Error(`Клиент ${name} не найден`);

  const conf = fs.readFileSync(confPath, 'utf8');
  const privkey = conf.match(/PrivateKey\s*=\s*(.+)/)?.[1]?.trim();
  const ip = conf.match(/Address\s*=\s*([\d.]+)/)?.[1]?.trim();
  const mtu = parseInt(conf.match(/MTU\s*=\s*(\d+)/)?.[1] || '1280');

  if (!privkey || !ip) throw new Error('Не удалось прочитать конфиг клиента');

  const inbound = {
    type: 'tun',
    tag: 'tun-in',
    address: ['172.19.1.1/30'],
    auto_route: true,
    strict_route: true,
    stack: 'system',
  };

  if (mode === 'wifi') {
    inbound.route_exclude_address = ['171.22.75.104/32'];
  }

  return {
    log: { level: 'info' },
    inbounds: [inbound],
    outbounds: [
      {
        type: 'wireguard',
        tag: 'wg-out',
        server: '171.22.75.104',
        server_port: 443,
        local_address: [`${ip}/32`],
        private_key: privkey,
        peer_public_key: SERVER_PUBKEY,
        mtu,
      },
    ],
    route: { final: 'wg-out' },
  };
}

module.exports = {
  getPeersWithStatus,
  getPeerDetail,
  createClient,
  renameClient,
  deleteClient,
  getClientConf,
  getClientQr,
  getSingboxConf,
};

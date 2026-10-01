const { execSync, execFileSync } = require('child_process');
const os = require('os');
const { randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = '/etc/wireguard/clients';
const WG_CONF = '/etc/wireguard/wg0.conf';
const WG_INTERFACE = 'wg0';
const SUBNET = '10.20.0';
const SERVER_PUBKEY = 'Wq9Db2KQ2EQtIxTSaKT1cel6T0dSLX+cQ5k1JHHAcCE=';
const SERVER_ENDPOINT = process.env.SERVER_ENDPOINT || '171.22.75.104:443';
const SERVER_HOST = SERVER_ENDPOINT.split(':')[0];
const SINGBOX_WG_SERVER = process.env.SINGBOX_WG_SERVER || SERVER_HOST;
const SINGBOX_ROUTE_EXCLUDE = process.env.SINGBOX_ROUTE_EXCLUDE || (
  /^\d{1,3}(\.\d{1,3}){3}$/.test(SINGBOX_WG_SERVER) ? `${SINGBOX_WG_SERVER}/32` : null
);
const PRIVATE_BYPASS_ROUTES = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  'fe80::/10',
];

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

  try {
    const wgConf = fs.readFileSync(WG_CONF, 'utf8');
    const matches = wgConf.matchAll(/AllowedIPs\s*=\s*([^\n]+)/g);
    for (const m of matches) {
      for (const cidr of m[1].split(',')) {
        const ip = cidr.trim().split('/')[0];
        if (ip.startsWith(SUBNET + '.')) used.add(ip);
      }
    }
  } catch {}

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
  let pubkey = null;

  try {
    run(`sudo wg genkey | sudo tee ${keyPath} | wg pubkey | sudo tee ${pubPath}`);
    const privkey = run(`sudo cat ${keyPath}`);
    pubkey = run(`sudo cat ${pubPath}`);

    const conf = buildWgConf(privkey, ip);
    run(`sudo bash -c 'printf "%s" "${conf.replace(/"/g, '\\"')}" > ${confPath}'`);
    run(`sudo chmod 640 ${confPath} ${pubPath}`);
    run(`sudo chown root:${process.env.USER || 'orxan'} ${confPath} ${pubPath}`);

    const peerBlock = `\\n[Peer]\\nPublicKey = ${pubkey}\\nAllowedIPs = ${ip}/32`;
    run(`sudo bash -c 'printf "${peerBlock}\\n" >> ${WG_CONF}'`);
    run(`sudo wg set ${WG_INTERFACE} peer ${pubkey} allowed-ips ${ip}/32`);

    return { name, ip, pubkey, conf };
  } catch (e) {
    if (pubkey) {
      try { run(`sudo wg set ${WG_INTERFACE} peer ${pubkey} remove`); } catch {}
      try { removePeerFromWgConf(pubkey); } catch {}
    }
    for (const f of [keyPath, pubPath, confPath]) {
      try { run(`sudo rm ${f}`); } catch {}
    }
    throw e;
  }
}

function buildWgConf(privkey, ip) {
  return `[Interface]
PrivateKey = ${privkey}
Address = ${ip}/32
DNS = 1.1.1.1
MTU = 1200

[Peer]
PublicKey = ${SERVER_PUBKEY}
Endpoint = ${SERVER_ENDPOINT}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`;
}

function buildKeeneticConf(privkey, ip) {
  return `[Interface]
PrivateKey = ${privkey}
Address = ${ip}/32
DNS = 10.20.0.1
MTU = 1280

[Peer]
PublicKey = ${SERVER_PUBKEY}
Endpoint = ${SERVER_ENDPOINT}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`;
}

function getKeeneticConf(name) {
  validName(name);
  const confPath = path.join(CLIENTS_DIR, `${name}.conf`);
  if (!fs.existsSync(confPath)) throw new Error(`Клиент ${name} не найден`);

  const conf = fs.readFileSync(confPath, 'utf8');
  const privkey = conf.match(/PrivateKey\s*=\s*(.+)/)?.[1]?.trim();
  const ip = conf.match(/Address\s*=\s*([\d.]+)/)?.[1]?.trim();
  if (!privkey || !ip) throw new Error('Не удалось прочитать конфиг клиента');

  return buildKeeneticConf(privkey, ip);
}

function renameClient(oldName, newName) {
  validName(oldName);
  validName(newName);

  const oldPub = path.join(CLIENTS_DIR, `${oldName}.pub`);
  if (!fs.existsSync(oldPub)) throw new Error(`Клиент ${oldName} не найден`);
  if (fs.existsSync(path.join(CLIENTS_DIR, `${newName}.pub`))) {
    throw new Error(`Клиент ${newName} уже существует`);
  }

  for (const ext of ['.key', '.pub', '.conf', '.blocked']) {
    const src = path.join(CLIENTS_DIR, `${oldName}${ext}`);
    const dst = path.join(CLIENTS_DIR, `${newName}${ext}`);
    if (fs.existsSync(src)) privileged('mv', ['--', src, dst]);
  }
}

// Keep configuration contents out of shell commands and subprocess error messages.
function privileged(command, args) {
  try {
    return execFileSync('sudo', ['-n', command, ...args], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Не удалось выполнить ${command}`);
  }
}

function withPrivateFile(contents, action) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-admin-'));
  const file = path.join(dir, 'config');
  try {
    fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    return action(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function atomicPrivilegedWrite(target, contents, preserveMode = false) {
  const temporary = `${target}.${randomBytes(12).toString('hex')}.tmp`;
  const stat = preserveMode ? fs.statSync(target) : null;
  const mode = stat ? (stat.mode & 0o777).toString(8) : '600';
  try {
    withPrivateFile(contents, file => {
      privileged('install', ['-m', mode, '-o', String(stat?.uid ?? 0), '-g', String(stat?.gid ?? 0), file, temporary]);
      privileged('mv', ['-f', '--', temporary, target]);
    });
  } finally {
    try { privileged('rm', ['-f', '--', temporary]); } catch {}
  }
}

function splitWgSections(raw) {
  return raw.split(/(?=^[ \t]*\[[^\]\r\n]+\][ \t]*(?:\r?\n|$))/m);
}

function peerPublicKey(section) {
  if (!/^[ \t]*\[Peer\][ \t]*(?:\r?\n|$)/.test(section)) return null;
  return section.match(/^[ \t]*PublicKey[ \t]*=[ \t]*([^\s#]+)/m)?.[1] || null;
}

function withoutPeer(raw, pubkey) {
  return splitWgSections(raw).filter(section => peerPublicKey(section) !== pubkey).join('');
}

function getClientIdentity(name) {
  validName(name);
  const pubPath = path.join(CLIENTS_DIR, `${name}.pub`);
  if (!fs.existsSync(pubPath)) throw new Error(`Клиент ${name} не найден`);
  const pubkey = fs.readFileSync(pubPath, 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(pubkey)) throw new Error('Некорректный публичный ключ клиента');
  return { pubkey, blockedPath: path.join(CLIENTS_DIR, `${name}.blocked`) };
}

function readSavedPeer(blockedPath, pubkey) {
  if (!fs.existsSync(blockedPath)) return null;
  const block = privileged('cat', ['--', blockedPath]);
  const sections = splitWgSections(block).filter(part => part.trim());
  if (sections.length !== 1 || peerPublicKey(sections[0]) !== pubkey ||
      /^[ \t]*PrivateKey[ \t]*=/m.test(block)) {
    throw new Error('Некорректный сохранённый блок клиента');
  }
  return block;
}

function fallbackPeer(name, pubkey) {
  const conf = fs.readFileSync(path.join(CLIENTS_DIR, `${name}.conf`), 'utf8');
  const ip = conf.match(/^[ \t]*Address[ \t]*=[ \t]*([\d.]+)(?:\/\d+)?[ \t]*$/m)?.[1];
  if (!ip || require('net').isIP(ip) !== 4) throw new Error('Не удалось прочитать IP клиента');
  return `[Peer]\nPublicKey = ${pubkey}\nAllowedIPs = ${ip}/32\n`;
}

function blockClient(name) {
  const { pubkey, blockedPath } = getClientIdentity(name);
  try {
    const raw = privileged('cat', ['--', WG_CONF]);
    const matching = splitWgSections(raw).filter(section => peerPublicKey(section) === pubkey);
    // Save before removing: never lose preshared keys, endpoints or keepalive.
    const saved = readSavedPeer(blockedPath, pubkey);
    if (!saved) {
      const block = matching.at(-1) || fallbackPeer(name, pubkey);
      if (/^[ \t]*PrivateKey[ \t]*=/m.test(block)) throw new Error('Некорректный блок клиента');
      atomicPrivilegedWrite(blockedPath, block);
    }
    const cleaned = withoutPeer(raw, pubkey);
    if (cleaned !== raw) atomicPrivilegedWrite(WG_CONF, cleaned, true);
  } finally {
    // Persist first, but still revoke runtime access if saving fails.
    privileged('wg', ['set', WG_INTERFACE, 'peer', pubkey, 'remove']);
  }
}

function unblockClient(name) {
  const { pubkey, blockedPath } = getClientIdentity(name);
  const raw = privileged('cat', ['--', WG_CONF]);
  const existing = splitWgSections(raw).filter(section => peerPublicKey(section) === pubkey);
  const saved = readSavedPeer(blockedPath, pubkey);
  const block = saved || existing.at(-1) || fallbackPeer(name, pubkey);
  if (/^[ \t]*PrivateKey[ \t]*=/m.test(block)) throw new Error('Некорректный блок клиента');
  // Retain recovery details even for legacy blocks until every step succeeds.
  if (!saved) atomicPrivilegedWrite(blockedPath, block);
  const cleaned = withoutPeer(raw, pubkey);
  const restored = `${cleaned.trimEnd()}\n\n${block.trimEnd()}\n`;
  atomicPrivilegedWrite(WG_CONF, restored, true);
  try {
    withPrivateFile(block, file => privileged('wg', ['addconf', WG_INTERFACE, file]));
    privileged('rm', ['-f', '--', blockedPath]);
  } catch (error) {
    // Fail closed: retain saved details and remove persistent/runtime access.
    try { atomicPrivilegedWrite(WG_CONF, cleaned, true); }
    finally {
      try { privileged('wg', ['set', WG_INTERFACE, 'peer', pubkey, 'remove']); } catch {}
    }
    throw error;
  }
}

function reconcileBlockedClients(names) {
  const result = { blocked: [], errors: [] };
  for (const name of names) {
    try { blockClient(name); result.blocked.push(name); }
    catch (error) { result.errors.push({ name, error: error.message }); }
  }
  return result;
}

function removePeerFromWgConf(pubkey) {
  const raw = privileged('cat', ['--', WG_CONF]);
  const cleaned = withoutPeer(raw, pubkey);
  if (raw !== cleaned) atomicPrivilegedWrite(WG_CONF, cleaned, true);
}

// Diagnostics removes orphan peers without modifying client files or metadata.
function removePeerByPublicKey(pubkey) {
  if (typeof pubkey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(pubkey) ||
      Buffer.from(pubkey, 'base64').toString('base64') !== pubkey) {
    throw new Error('Некорректный публичный ключ клиента');
  }
  removePeerFromWgConf(pubkey);
  privileged('wg', ['set', WG_INTERFACE, 'peer', pubkey, 'remove']);
}

function deleteClient(name) {
  validName(name);

  const pubPath = path.join(CLIENTS_DIR, `${name}.pub`);
  if (!fs.existsSync(pubPath)) throw new Error(`Клиент ${name} не найден`);

  const pubkey = fs.readFileSync(pubPath, 'utf8').trim();

  removePeerFromWgConf(pubkey);
  privileged('wg', ['set', WG_INTERFACE, 'peer', pubkey, 'remove']);

  for (const ext of ['.key', '.pub', '.conf', '.blocked']) {
    const f = path.join(CLIENTS_DIR, `${name}${ext}`);
    if (fs.existsSync(f)) privileged('rm', ['--', f]);
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

  const route = { final: 'wg-out' };
  if (mode === 'wifi') {
    if (SINGBOX_ROUTE_EXCLUDE) inbound.route_exclude_address = [SINGBOX_ROUTE_EXCLUDE];
  }

  if (mode === 'beta') {
    // Экспериментальный профиль: оставляем прямой доступ к VPN endpoint
    // и локальным сетям, чтобы снизить шанс потери сети при смене аплинка.
    inbound.strict_route = false;
    inbound.route_exclude_address = [
      ...(SINGBOX_ROUTE_EXCLUDE ? [SINGBOX_ROUTE_EXCLUDE] : []),
      ...PRIVATE_BYPASS_ROUTES,
    ];
  }

  if (mode === 'mac') {
    if (SINGBOX_ROUTE_EXCLUDE) inbound.route_exclude_address = [SINGBOX_ROUTE_EXCLUDE];
    route.auto_detect_interface = true;
  }

  if (mode === 'android') {
    // sing-box 1.13+ removed WireGuard as an outbound. Android builds with
    // newer cores need the endpoint model, while iOS still works with legacy
    // outbounds, so keep this as an explicit compatibility mode.
    delete inbound.stack;
    inbound.strict_route = false;
    inbound.route_exclude_address = [
      ...(SINGBOX_ROUTE_EXCLUDE ? [SINGBOX_ROUTE_EXCLUDE] : []),
      ...PRIVATE_BYPASS_ROUTES,
    ];

    return {
      log: { level: 'info' },
      dns: {
        strategy: 'prefer_ipv4',
        servers: [
          {
            type: 'udp',
            tag: 'dns-wg',
            server: '1.1.1.1',
            server_port: 53,
            detour: 'wg-out',
          },
        ],
        final: 'dns-wg',
      },
      inbounds: [inbound],
      endpoints: [
        {
          type: 'wireguard',
          tag: 'wg-out',
          detour: 'direct',
          address: [`${ip}/32`],
          private_key: privkey,
          mtu,
          peers: [
            {
              address: SINGBOX_WG_SERVER,
              port: 443,
              public_key: SERVER_PUBKEY,
              allowed_ips: ['0.0.0.0/0'],
              persistent_keepalive_interval: 25,
            },
          ],
        },
      ],
      outbounds: [
        {
          type: 'direct',
          tag: 'direct',
        },
      ],
      route: {
        rules: [
          {
            port: 53,
            action: 'hijack-dns',
          },
        ],
        final: route.final,
      },
    };
  }

  const result = {
    log: { level: 'info' },
    inbounds: [inbound],
    outbounds: [
      {
        type: 'wireguard',
        tag: 'wg-out',
        server: SINGBOX_WG_SERVER,
        server_port: 443,
        local_address: [`${ip}/32`],
        private_key: privkey,
        peer_public_key: SERVER_PUBKEY,
        mtu,
      },
    ],
    route,
  };

  return result;
}

module.exports = {
  getPeersWithStatus,
  getPeerDetail,
  createClient,
  renameClient,
  blockClient,
  unblockClient,
  reconcileBlockedClients,
  removePeerByPublicKey,
  deleteClient,
  getClientConf,
  getClientQr,
  getSingboxConf,
  getKeeneticConf,
};

const { execFileSync, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execute = promisify(execFile);
const net = require('net');

function run(file, args = [], timeout = 5000) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }).trim();
  } catch (e) {
    return e.stdout ? e.stdout.trim() : `error: ${e.message}`;
  }
}

async function runAsync(file, args, timeout = 5000) {
  try {
    const { stdout, stderr } = await execute(file, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    return (stdout + stderr).trim();
  } catch (e) {
    return (e.stdout || e.stderr || `error: ${e.message}`).trim();
  }
}

function hostValue(value) {
  if (typeof value !== 'string' || value.length > 253 || !value || value.startsWith('-')) throw new Error('Invalid host');
  if (net.isIP(value)) return value;
  if (!value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('Invalid host');
  return value;
}

function boundedInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /password|secret|private.?key|pre.?shared.?key|token|credential/i.test(key) ? '[redacted]' : redactSecrets(item)]));
  return value;
}

function redactWg(raw) {
  return raw.replace(/^(\s*(?:PrivateKey|PresharedKey)\s*=).*$/gmi, '$1 [redacted]');
}

function getPeersDetailed() {
  const dump = run('sudo', ['-n', 'wg', 'show', 'wg0', 'dump']);
  if (!dump || dump.startsWith('error')) return [];

  const lines = dump.split('\n');
  const serverLine = lines[0];
  const peers = [];

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [pubkey, psk, endpoint, allowedIps, lastHandshake, rx, tx, keepalive] = line.split('\t');
    const hs = parseInt(lastHandshake);
    const now = Math.floor(Date.now() / 1000);
    const ago = hs ? now - hs : null;

    peers.push({
      pubkey,
      endpoint: endpoint === '(none)' ? null : endpoint,
      allowedIps,
      lastHandshake: hs || null,
      handshakeAgo: ago,
      handshakeText: ago === null ? 'never' : ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}m ago` : `${Math.floor(ago / 3600)}h ago`,
      rx: parseInt(rx),
      tx: parseInt(tx),
      active: ago !== null && ago < 180,
    });
  }
  return peers;
}

function getInterfaces() {
  const raw = run('ip', ['-j', 'addr', 'show']);
  try {
    return JSON.parse(raw).map(iface => ({
      name: iface.ifname,
      state: iface.operstate,
      mtu: iface.mtu,
      addresses: (iface.addr_info || []).map(a => `${a.local}/${a.prefixlen}`),
    }));
  } catch {
    return run('ip', ['addr', 'show']);
  }
}

function getRoutes() {
  return run('ip', ['route', 'show']).split('\n').filter(Boolean);
}

function getIpForward() {
  return run('sysctl', ['-n', 'net.ipv4.ip_forward']) === '1';
}

function getIptablesNat() {
  return run('sudo', ['-n', 'iptables', '-t', 'nat', '-L', 'POSTROUTING', '-v', '-n', '--line-numbers']);
}

function getIptablesForward() {
  return run('sudo', ['-n', 'iptables', '-L', 'FORWARD', '-v', '-n', '--line-numbers']);
}

function getNftSingbox() {
  const full = run('sudo', ['-n', 'nft', 'list', 'ruleset'], 10000);
  const match = full.match(/table inet sing-box \{[\s\S]*?\n\}/);
  return match ? match[0] : 'sing-box nftables table not found';
}

function getSingboxConfig() {
  const raw = run('sudo', ['-n', 'cat', '/etc/sing-box/config.json']);
  if (raw.startsWith('error')) return raw;
  try { return JSON.stringify(redactSecrets(JSON.parse(raw)), null, 2); }
  catch { return 'error: Invalid sing-box config'; }
}

async function pingTest(target, count = 4) {
  return runAsync('ping', ['-c', String(boundedInteger(count, 1, 10, 'count')), '-W', '2', hostValue(target)], 25000);
}

async function dnsTest(domain) {
  const host = hostValue(domain);
  const [nslookup, dig] = await Promise.all([
    runAsync('nslookup', [host], 5000), runAsync('dig', ['+short', host], 5000),
  ]);
  return { nslookup, dig };
}

function tcpdumpCapture(iface, filter, count = 10, timeout = 8) {
  if (typeof iface !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,14}$/.test(iface)) throw new Error('Invalid interface');
  boundedInteger(count, 1, 50, 'count');
  boundedInteger(timeout, 1, 15, 'timeout');
  if (typeof filter !== 'string' || filter.length > 512 || !/^[a-zA-Z0-9.:/()&|! \t]*$/.test(filter)) throw new Error('Invalid capture filter');
  return new Promise((resolve, reject) => {
    let output = '';
    const proc = spawn('sudo', ['-n', 'tcpdump', '-i', iface, '-c', String(count), '-n', '--', ...filter.trim().split(/\s+/).filter(Boolean)]);
    const append = d => { output = (output + d.toString()).slice(0, 1024 * 1024); };
    proc.stdout.on('data', append);
    proc.stderr.on('data', append);
    let killTimer;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), 1000);
      killTimer.unref();
    }, timeout * 1000);
    proc.on('error', e => { clearTimeout(timer); clearTimeout(killTimer); reject(e); });
    proc.on('close', () => { clearTimeout(timer); clearTimeout(killTimer); resolve(output.trim()); });
  });
}

async function getSingboxLogs(peerIp, lines = 50) {
  boundedInteger(lines, 1, 200, 'lines');
  if (peerIp && (typeof peerIp !== 'string' || !net.isIP(peerIp))) throw new Error('Invalid peer IP');
  const raw = await runAsync('sudo', ['-n', 'journalctl', '-u', 'sing-box', '--no-pager', '-n', String(lines), '--output=short-iso'], 10000);
  if (!peerIp) return raw;
  return raw.split('\n').filter(l => l.includes(peerIp)).join('\n') || `No logs found for ${peerIp}`;
}

function getOverview() {
  return {
    peers: getPeersDetailed(),
    interfaces: getInterfaces(),
    routes: getRoutes(),
    ipForward: getIpForward(),
    iptablesNat: getIptablesNat(),
    iptablesForward: getIptablesForward(),
  };
}

async function curlTest(url, timeout = 5) {
  boundedInteger(timeout, 1, 15, 'timeout');
  if (typeof url !== 'string' || url.length > 2048) throw new Error('Invalid URL');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only HTTP(S) URLs without credentials are supported');
  return runAsync('curl', ['--proto', '=http,https', '-sS', '-o', '/dev/null', '-w', 'HTTP %{http_code} | Time: %{time_total}s | IP: %{remote_ip}', '--max-time', String(timeout), '--', parsed.href], (timeout + 2) * 1000);
}

function auditWgConfig() {
  const raw = run('sudo', ['-n', 'cat', '/etc/wireguard/wg0.conf'], 5000);
  if (raw.startsWith('error')) return { error: raw };

  const peers = [];
  let current = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[Peer]') {
      if (current) peers.push(current);
      current = { pubkey: null, allowedIps: [], raw: '' };
    }
    if (current) {
      current.raw += line + '\n';
      const pkMatch = trimmed.match(/^PublicKey\s*=\s*(.+)/);
      if (pkMatch) current.pubkey = pkMatch[1].trim();
      const aMatch = trimmed.match(/^AllowedIPs\s*=\s*(.+)/);
      if (aMatch) current.allowedIps = aMatch[1].split(',').map(s => s.trim());
    }
  }
  if (current) peers.push(current);

  const nameMap = {};
  let clientFiles = [];
  try { clientFiles = fs.readdirSync('/etc/wireguard/clients').filter(name => name.endsWith('.pub')); } catch {}
  for (const file of clientFiles) {
    const pk = run('sudo', ['-n', 'cat', path.join('/etc/wireguard/clients', file)], 3000).trim();
    if (pk && !pk.startsWith('error')) nameMap[pk] = file.slice(0, -4);
  }

  const ipMap = {};
  const issues = [];

  for (const p of peers) {
    p.name = nameMap[p.pubkey] || null;
    for (const ip of p.allowedIps) {
      const base = ip.split('/')[0];
      if (!ipMap[base]) ipMap[base] = [];
      ipMap[base].push(p);
    }
  }

  for (const [ip, list] of Object.entries(ipMap)) {
    if (ip.startsWith('192.168') || ip.startsWith('10.0') || ip.startsWith('172.')) continue;
    if (list.length > 1) {
      issues.push({
        type: 'duplicate_ip',
        ip,
        peers: list.map(p => ({ pubkey: p.pubkey, name: p.name, allowedIps: p.allowedIps })),
      });
    }
  }

  const runtimeDump = run('sudo', ['-n', 'wg', 'show', 'wg0', 'dump'], 5000);
  const runtimePeers = new Set();
  if (runtimeDump && !runtimeDump.startsWith('error')) {
    for (const line of runtimeDump.split('\n').slice(1)) {
      if (!line.trim()) continue;
      runtimePeers.add(line.split('\t')[0]);
    }
  }

  for (const p of peers) {
    p.inRuntime = runtimePeers.has(p.pubkey);
  }

  const orphaned = peers.filter(p => !p.name);
  if (orphaned.length) {
    issues.push({
      type: 'orphaned_peers',
      count: orphaned.length,
      peers: orphaned.map(p => ({ pubkey: p.pubkey, allowedIps: p.allowedIps, inRuntime: p.inRuntime })),
    });
  }

  return {
    totalPeers: peers.length,
    peers: peers.map(p => ({
      pubkey: p.pubkey,
      name: p.name,
      allowedIps: p.allowedIps,
      inRuntime: p.inRuntime,
    })),
    issues,
    raw: redactWg(raw),
  };
}

function removePeerFromConfig(pubkey) {
  require('./wg').removePeerByPublicKey(pubkey);
  return { ok: true, removed: pubkey };
}

function keeneticExec(host, port, commands, login = 'admin', password = '') {
  return new Promise((resolve, reject) => {
    let output = '';
    let cmdIndex = 0;
    let authenticated = false;
    let loginSent = false;
    let passwordSent = false;
    const allCmds = [...commands, 'exit'];
    const timeout = setTimeout(() => {
      client.destroy();
      resolve(cleanTelnet(output));
    }, 15000);

    const client = net.createConnection({ host, port: port || 23 }, () => {});

    client.on('data', (data) => {
      // Strip telnet IAC negotiation bytes (0xFF ...)
      const buf = Buffer.from(data);
      const clean = [];
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0xFF && i + 1 < buf.length) {
          const cmd = buf[i + 1];
          if (cmd >= 0xFB && cmd <= 0xFE && i + 2 < buf.length) {
            i += 2; continue;
          } else if (cmd === 0xFA) {
            while (i < buf.length && !(buf[i] === 0xFF && buf[i + 1] === 0xF0)) i++;
            i++; continue;
          } else { i++; continue; }
        }
        clean.push(buf[i]);
      }
      const text = Buffer.from(clean).toString('utf8');
      output += text;

      if (!loginSent && output.includes('Login:')) {
        loginSent = true;
        setTimeout(() => client.write(login + '\r\n'), 200);
        return;
      }
      if (loginSent && !passwordSent && text.includes('Password:')) {
        passwordSent = true;
        setTimeout(() => client.write(password + '\r\n'), 200);
        return;
      }
      if (!authenticated && passwordSent && text.includes('>')) {
        authenticated = true;
      }
      if (authenticated && text.includes('>')) {
        if (cmdIndex < allCmds.length) {
          const cmd = allCmds[cmdIndex];
          cmdIndex++;
          setTimeout(() => client.write(cmd + '\r\n'), 100);
        }
      }
    });

    client.on('end', () => { clearTimeout(timeout); resolve(cleanTelnet(output)); });
    client.on('error', (e) => { clearTimeout(timeout); reject(e); });
    client.on('close', () => { clearTimeout(timeout); resolve(cleanTelnet(output)); });
  });
}

function cleanTelnet(text) {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .replace(/[^\x20-\x7E\n]/g, '')
    .trim();
}

module.exports = {
  getOverview,
  getPeersDetailed,
  getInterfaces,
  getRoutes,
  getIptablesNat,
  getIptablesForward,
  getNftSingbox,
  getSingboxConfig,
  pingTest,
  dnsTest,
  tcpdumpCapture,
  getSingboxLogs,
  curlTest,
  auditWgConfig,
  removePeerFromConfig,
  keeneticExec,
};

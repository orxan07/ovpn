const { execSync, spawn } = require('child_process');
const net = require('net');

function run(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout }).trim();
  } catch (e) {
    return e.stdout ? e.stdout.trim() : `error: ${e.message}`;
  }
}

function getPeersDetailed() {
  const dump = run('sudo wg show wg0 dump');
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
  const raw = run('ip -j addr show');
  try {
    return JSON.parse(raw).map(iface => ({
      name: iface.ifname,
      state: iface.operstate,
      mtu: iface.mtu,
      addresses: (iface.addr_info || []).map(a => `${a.local}/${a.prefixlen}`),
    }));
  } catch {
    return run('ip addr show');
  }
}

function getRoutes() {
  return run('ip route show').split('\n').filter(Boolean);
}

function getIpForward() {
  return run('sysctl -n net.ipv4.ip_forward') === '1';
}

function getIptablesNat() {
  return run('sudo iptables -t nat -L POSTROUTING -v -n --line-numbers');
}

function getIptablesForward() {
  return run('sudo iptables -L FORWARD -v -n --line-numbers');
}

function getNftSingbox() {
  const full = run('sudo nft list ruleset', 10000);
  const match = full.match(/table inet sing-box \{[\s\S]*?\n\}/);
  return match ? match[0] : 'sing-box nftables table not found';
}

function getSingboxConfig() {
  return run('sudo cat /etc/sing-box/config.json');
}

function pingTest(target, count = 4) {
  return run(`ping -c ${count} -W 2 ${target}`, 15000);
}

function dnsTest(domain) {
  const result = {};
  result.nslookup = run(`nslookup ${domain} 2>&1`, 5000);
  result.dig = run(`dig +short ${domain} 2>&1`, 5000);
  return result;
}

function tcpdumpCapture(iface, filter, count = 10, timeout = 8) {
  return new Promise((resolve) => {
    let output = '';
    const args = ['-i', iface, '-c', String(count), '-n'];
    if (filter) args.push(...filter.split(' '));

    const proc = spawn('sudo', ['tcpdump', ...args], {
      timeout: timeout * 1000,
    });

    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, timeout * 1000);

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(output.trim());
    });
  });
}

function getSingboxLogs(peerIp, lines = 50) {
  let cmd = `sudo journalctl -u sing-box --no-pager -n ${lines} --output=short-iso`;
  const raw = run(cmd, 10000);
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

function curlTest(url, timeout = 5) {
  return run(`curl -sS -o /dev/null -w "HTTP %{http_code} | Time: %{time_total}s | IP: %{remote_ip}" --max-time ${timeout} "${url}" 2>&1`, (timeout + 2) * 1000);
}

function auditWgConfig() {
  const raw = run('sudo cat /etc/wireguard/wg0.conf', 5000);
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

  const clientFiles = run('ls /etc/wireguard/clients/*.pub 2>/dev/null', 5000);
  const nameMap = {};
  if (clientFiles && !clientFiles.startsWith('error')) {
    for (const f of clientFiles.split('\n').filter(Boolean)) {
      const name = f.replace(/.*\//, '').replace('.pub', '');
      const pk = run(`sudo cat "${f}"`, 3000).trim();
      if (pk) nameMap[pk] = name;
    }
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

  const runtimeDump = run('sudo wg show wg0 dump', 5000);
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
    raw: raw,
  };
}

function removePeerFromConfig(pubkey) {
  const raw = run('sudo cat /etc/wireguard/wg0.conf', 5000);
  if (raw.startsWith('error')) return { error: raw };

  const lines = raw.split('\n');
  const result = [];
  let skip = false;

  for (const line of lines) {
    if (line.trim() === '[Peer]') {
      skip = false;
    }
    if (line.trim().startsWith('PublicKey') && line.includes(pubkey)) {
      // Remove the [Peer] header we just added
      while (result.length && result[result.length - 1].trim() === '[Peer]') result.pop();
      while (result.length && result[result.length - 1].trim() === '') result.pop();
      skip = true;
      continue;
    }
    if (skip && (line.trim() === '[Peer]' || line.trim() === '[Interface]')) {
      skip = false;
    }
    if (!skip) result.push(line);
  }

  const newConf = result.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  run(`sudo bash -c 'cat > /etc/wireguard/wg0.conf << "WGEOF"\n${newConf}WGEOF'`, 5000);
  run(`sudo wg set wg0 peer ${pubkey} remove`, 5000);

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

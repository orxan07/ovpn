const { execSync, spawn } = require('child_process');

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
};

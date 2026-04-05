const { execSync } = require('child_process');
const fs = require('fs');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getCpuPercent() {
  // Читаем /proc/stat дважды с паузой для вычисления %
  const parse = () => {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const vals = line.split(/\s+/).slice(1).map(Number);
    const idle = vals[3] + vals[4]; // idle + iowait
    const total = vals.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const a = parse();
  // синхронная пауза 100ms
  execSync('sleep 0.1');
  const b = parse();
  const diffIdle = b.idle - a.idle;
  const diffTotal = b.total - a.total;
  return diffTotal ? Math.round((1 - diffIdle / diffTotal) * 100) : 0;
}

function getMemory() {
  const lines = fs.readFileSync('/proc/meminfo', 'utf8').split('\n');
  const get = key => {
    const line = lines.find(l => l.startsWith(key));
    return line ? parseInt(line.split(/\s+/)[1]) * 1024 : 0; // kB -> bytes
  };
  const total = get('MemTotal:');
  const available = get('MemAvailable:');
  const used = total - available;
  return { total, used, free: available, percent: Math.round(used / total * 100) };
}

function getDisk() {
  const line = run('df -B1 /').split('\n')[1];
  if (!line) return null;
  const parts = line.split(/\s+/);
  const total = parseInt(parts[1]);
  const used = parseInt(parts[2]);
  const free = parseInt(parts[3]);
  return { total, used, free, percent: Math.round(used / total * 100) };
}

function getNetwork() {
  // Читаем /proc/net/dev для интерфейса enp2s0
  const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n');
  const iface = lines.find(l => l.includes('enp2s0'));
  if (!iface) return null;
  const vals = iface.trim().split(/\s+/);
  return {
    rxBytes: parseInt(vals[1]),
    txBytes: parseInt(vals[9]),
  };
}

// Вычисляет скорость сети за 1 секунду
let _lastNet = null;
let _lastNetTime = null;

function getNetworkSpeed() {
  const now = Date.now();
  const current = getNetwork();
  if (!current) return { rxSpeed: 0, txSpeed: 0 };

  if (!_lastNet || !_lastNetTime) {
    _lastNet = current;
    _lastNetTime = now;
    return { rxSpeed: 0, txSpeed: 0 };
  }

  const dt = (now - _lastNetTime) / 1000;
  const rxSpeed = Math.round((current.rxBytes - _lastNet.rxBytes) / dt);
  const txSpeed = Math.round((current.txBytes - _lastNet.txBytes) / dt);

  _lastNet = current;
  _lastNetTime = now;

  return { rxSpeed: Math.max(0, rxSpeed), txSpeed: Math.max(0, txSpeed) };
}

function getUptime() {
  const secs = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return { seconds: secs, text: d ? `${d}д ${h}ч ${m}м` : `${h}ч ${m}м` };
}

function getLoadAvg() {
  const [one, five, fifteen] = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').map(parseFloat);
  return { one, five, fifteen };
}

function getStats() {
  return {
    cpu: getCpuPercent(),
    memory: getMemory(),
    disk: getDisk(),
    network: getNetworkSpeed(),
    uptime: getUptime(),
    loadAvg: getLoadAvg(),
  };
}

module.exports = { getStats };

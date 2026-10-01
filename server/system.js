const { execFile } = require('child_process');
const fs = require('fs');

let lastCpu = null;
let cpuPercent = 0;
let diskStats = null;
let refreshingDisk = false;
let networkSpeed = { rxSpeed: 0, txSpeed: 0 };

function sampleCpu() {
  try {
    const vals = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    // guest and guest_nice are already included in user/nice.
    const current = { idle: vals[3] + vals[4], total: vals.slice(0, 8).reduce((a, b) => a + b, 0) };
    if (lastCpu) {
      const total = current.total - lastCpu.total;
      if (total > 0) cpuPercent = Math.max(0, Math.min(100, Math.round((1 - (current.idle - lastCpu.idle) / total) * 100)));
    }
    lastCpu = current;
  } catch {}
}

function getCpuPercent() { return cpuPercent; }

function refreshDisk() {
  if (refreshingDisk) return;
  refreshingDisk = true;
  execFile('df', ['-B1', '--output=size,used,avail', '/'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 }, (error, stdout) => {
    refreshingDisk = false;
    if (error) return;
    const values = stdout.trim().split('\n').slice(1).join(' ').trim().split(/\s+/).map(Number);
    const [total, used, free] = values;
    if (values.length === 3 && values.every(Number.isFinite) && total > 0) diskStats = { total, used, free, percent: Math.round(used / total * 100) };
  });
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

function getDisk() { return diskStats; }

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
  if (dt <= 0) return { rxSpeed: 0, txSpeed: 0 };
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
    network: { ...networkSpeed },
    uptime: getUptime(),
    loadAvg: getLoadAvg(),
  };
}

// Sample independently of HTTP request frequency; timers do not keep Node alive.
sampleCpu();
refreshDisk();
setInterval(() => {
  sampleCpu();
  try { networkSpeed = getNetworkSpeed(); } catch {}
}, 1000).unref();
setInterval(refreshDisk, 30000).unref();

module.exports = { getStats };

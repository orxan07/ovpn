const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
let snapshot = null;
let pending = null;

function parseActivity(raw, sessions, since) {
  const addresses = new Map(sessions.filter(s => s.ip).map(s => [s.ip, s.observedAt || since]));
  const connections = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (typeof record.MESSAGE !== 'string') continue;
    const message = record.MESSAGE.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const timestamp = Number(record.__REALTIME_TIMESTAMP) / 1000;
    if (!Number.isFinite(timestamp) || timestamp < since) continue;
    const id = message.match(/\[(\d+) [^\]]+\]/)?.[1];
    if (!id) continue;
    let entry = connections.get(id) || { at: timestamp };
    const from = message.match(/inbound\/(?:tun|tproxy)\[[^\]]+\]: inbound (?:packet )?connection from ([0-9.]+):\d+/);
    if (from) entry = { at: timestamp, source: addresses.has(from[1]) && timestamp >= addresses.get(from[1]) ? from[1] : null };
    const target = message.match(/outbound\/([^\[]+)\[([^\]]+)\]: outbound (packet )?connection to (\S+)/);
    if (target) Object.assign(entry, { destination: target[4].slice(0, 300),
      protocol: target[3] ? 'UDP' : 'TCP', outbound: target[2].slice(0, 80), at: timestamp });
    const domain = message.match(/sniffed protocol: [^,]+, domain: (\S+)/)?.[1];
    if (domain) entry.domain = domain.slice(0, 253);
    if (/\bERROR\b/.test(message)) entry.failed = true;
    connections.set(id, entry);
  }
  const rows = [...connections.values()].filter(e => e.source && e.destination);
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.destination}/${row.protocol}/${row.outbound}`;
    const previous = grouped.get(key);
    if (previous) {
      previous.connections++;
      if (row.at > previous.at) Object.assign(previous, row, { connections: previous.connections });
    } else grouped.set(key, { ...row, connections: 1 });
  }
  return [...grouped.values()].sort((a, b) => b.at - a.at).slice(0, 100)
    .map(({ source, ...entry }) => entry);
}

async function getActivity(sessions) {
  if (!sessions.length) return { entries: [], available: true, note: 'Нет активных сессий. Активность доступна для текущего подключения.' };
  try {
    if (!snapshot || Date.now() - snapshot.at > 10000) {
      if (!pending) pending = execute('sudo', ['journalctl', '-u', 'sing-box', '--since', '10 minutes ago', '-n', '3000', '--no-pager', '-o', 'json'], { timeout: 8000, maxBuffer: 6 * 1024 * 1024 })
        .then(({ stdout }) => { snapshot = { at: Date.now(), raw: stdout }; })
        .finally(() => { pending = null; });
      await pending;
    }
    return { available: true, entries: parseActivity(snapshot.raw, sessions, Date.now() - 600000),
      note: 'Последние 10 минут, до 3000 строк журнала. Видны только соединения через sing-box после начала наблюдения за сессией; это не полная история посещений.' };
  } catch { return { available: false, entries: [], note: 'Журнал sing-box недоступен или превышен размер выборки.' }; }
}

module.exports = { getActivity, parseActivity };

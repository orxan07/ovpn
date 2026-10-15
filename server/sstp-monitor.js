const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function validState(state) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const timestamp = value => value === null || number(value);
  if (!object(state) || state.version !== 1 || !number(state.since) || !object(state.users) || !object(state.active)) return false;
  for (const account of Object.values(state.users)) {
    if (!object(account) || typeof account.note !== 'string' || account.note.length > 2000 ||
        !number(account.upload) || !number(account.download) ||
        !(account.limitGb === null || number(account.limitGb) && account.limitGb > 0) ||
        !(account.expiresAt === null || typeof account.expiresAt === 'string' && Number.isFinite(Date.parse(account.expiresAt))) ||
        !timestamp(account.firstSeen) || !timestamp(account.lastSeen) || !object(account.days) || !Array.isArray(account.history)) return false;
    if (Object.entries(account.days).some(([date, bytes]) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !object(bytes) || !number(bytes.upload) || !number(bytes.download))) return false;
    if (account.history.some(session => !object(session) || !number(session.observedAt) || !number(session.endedAt) || !number(session.upload) || !number(session.download))) return false;
  }
  return Object.values(state.active).every(session => object(session) && typeof session.username === 'string' &&
    /^sstp\d+$/.test(session.ifname) && typeof session.sid === 'string' &&
    number(session.upload) && number(session.download) && number(session.uploadTracked) && number(session.downloadTracked) &&
    number(session.observedAt) && number(session.lastSeen));
}

function readCounters(ifname) {
  if (!/^sstp\d+$/.test(ifname)) throw new Error('Некорректный интерфейс SSTP');
  const dir = `/sys/class/net/${ifname}`;
  const value = name => {
    const number = Number(fs.readFileSync(`${dir}/statistics/${name}`, 'utf8').trim());
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('Некорректный счётчик интерфейса');
    return number;
  };
  return { upload: value('rx_bytes'), download: value('tx_bytes'),
    rxErrors: value('rx_errors'), txErrors: value('tx_errors'),
    rxDropped: value('rx_dropped'), txDropped: value('tx_dropped'),
    mtu: Number(fs.readFileSync(`${dir}/mtu`, 'utf8').trim()) };
}

function createMonitor(options) {
  const file = options.file || path.join(__dirname, '../data/sstp-monitor.json');
  const clock = options.now || Date.now;
  const counters = options.readCounters || readCounters;
  const timezone = 'Europe/Moscow';
  let state = { version: 1, since: clock(), users: {}, active: {} };
  if (fs.existsSync(file)) {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!validState(state)) throw new Error();
    } catch { throw new Error('Файл учёта SSTP повреждён; автоматическая перезапись отменена'); }
  }
  state.users = Object.assign(Object.create(null), state.users);
  state.active = Object.assign(Object.create(null), state.active);
  let boot = 'unknown';
  try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch {}
  let lastSampleAt = null;
  let lastError = null;
  let timer = null;
  let lastSaved = 0;
  let current = [];
  const rates = new Map();
  const day = timestamp => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(timestamp);

  function user(name) {
    if (!Object.hasOwn(state.users, name)) state.users[name] = {
      note: '', limitGb: null, expiresAt: null, upload: 0, download: 0,
      days: {}, history: [], firstSeen: null, lastSeen: null,
    };
    return state.users[name];
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      lastSaved = clock();
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }

  function sample() {
    const now = clock();
    const sessions = options.getSessions(); // Failure must not close real sessions.
    const seen = new Set();
    current = sessions.filter(session => /^sstp\d+$/.test(session.ifname)).map(session => {
      const key = `${boot}:${session.sid}:${session.ifname}:${session.username}`;
      seen.add(key);
      const account = user(session.username);
      account.firstSeen ||= now;
      account.lastSeen = now;
      let value;
      try { value = counters(session.ifname); }
      catch { return { ...session, countersAvailable: false, uploadBps: null, downloadBps: null }; }
      const previous = state.active[key];
      let up = 0, down = 0;
      if (previous) {
        up = Math.max(0, value.upload - previous.upload);
        down = Math.max(0, value.download - previous.download);
      }
      const previousRate = rates.get(key);
      const elapsed = previousRate ? (now - previousRate.at) / 1000 : 0;
      const uploadBps = elapsed > 0 && value.upload >= previousRate.upload ? (value.upload - previousRate.upload) / elapsed : null;
      const downloadBps = elapsed > 0 && value.download >= previousRate.download ? (value.download - previousRate.download) / elapsed : null;
      rates.set(key, { ...value, at: now });
      account.upload += up;
      account.download += down;
      const today = day(now);
      const bucket = account.days[today] ||= { upload: 0, download: 0 };
      bucket.upload += up;
      bucket.download += down;
      for (const date of Object.keys(account.days).sort().slice(0, -90)) delete account.days[date];
      state.active[key] = { ...session, ...value, observedAt: previous?.observedAt || now,
        uploadTracked: (previous?.uploadTracked || 0) + up,
        downloadTracked: (previous?.downloadTracked || 0) + down, lastSeen: now };
      return { ...session, ...value, countersAvailable: true, uploadBps, downloadBps,
        observedAt: state.active[key].observedAt };
    });
    for (const [key, session] of Object.entries(state.active)) {
      if (seen.has(key)) continue;
      const account = user(session.username);
      account.history.unshift({ sid: session.sid, ifname: session.ifname, ip: session.ip,
        callingSid: session.callingSid, observedAt: session.observedAt, endedAt: now,
        lastSeen: session.lastSeen, upload: session.uploadTracked, download: session.downloadTracked });
      account.history = account.history.slice(0, 100);
      delete state.active[key];
      rates.delete(key);
    }
    lastSampleAt = now;
    lastError = null;
    if (now - lastSaved >= 30000) save();
  }

  function getClient(account) {
    const data = user(account.name);
    const sessions = current.filter(session => session.username === account.name);
    return { ...account, ...data, online: sessions.length > 0, sessions,
      uploadBps: sessions.some(s => s.uploadBps !== null) ? sessions.reduce((n, s) => n + (s.uploadBps || 0), 0) : null,
      downloadBps: sessions.some(s => s.downloadBps !== null) ? sessions.reduce((n, s) => n + (s.downloadBps || 0), 0) : null,
      today: data.days[day(clock())] || { upload: 0, download: 0 },
      quotaExceeded: data.limitGb !== null && (data.upload + data.download) >= data.limitGb * 1024 ** 3,
      expired: Boolean(data.expiresAt && Date.parse(data.expiresAt) <= clock()) };
  }

  function configure(name, patch) {
    const values = {};
    if (Object.hasOwn(patch, 'note')) {
      if (typeof patch.note !== 'string' || patch.note.length > 2000) throw new Error('Заметка: до 2000 символов');
      values.note = patch.note;
    }
    if (Object.hasOwn(patch, 'limitGb')) {
      if (patch.limitGb !== null && (typeof patch.limitGb !== 'number' || !Number.isFinite(patch.limitGb) || patch.limitGb <= 0 || patch.limitGb > 1000000)) throw new Error('Лимит: положительное число GiB или null');
      values.limitGb = patch.limitGb;
    }
    if (Object.hasOwn(patch, 'expiresAt')) {
      if (patch.expiresAt !== null && (typeof patch.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(patch.expiresAt) || !Number.isFinite(Date.parse(patch.expiresAt)))) throw new Error('Некорректный срок доступа');
      values.expiresAt = patch.expiresAt;
    }
    const previous = { ...user(name) };
    Object.assign(user(name), values);
    try { save(); }
    catch (error) { state.users[name] = previous; throw error; }
    return user(name);
  }

  function resetUsage(name) {
    const account = user(name);
    const previous = { ...account };
    account.upload = 0; account.download = 0; account.days = {};
    account.usageResetAt = clock();
    try { save(); } catch (error) { state.users[name] = previous; throw error; }
  }

  function remove(name) {
    if (typeof name !== 'string') throw new Error('Некорректное имя SSTP-клиента');
    delete state.users[name];
    for (const [key, session] of Object.entries(state.active)) if (session.username === name) {
      delete state.active[key]; rates.delete(key);
    }
    current = current.filter(session => session.username !== name);
    save();
  }

  function tick() {
    try {
      sample();
      for (const account of options.getUsers()) {
        const client = getClient(account);
        if ((client.quotaExceeded || client.expired) && !account.blocked) options.blockUser(account.name, true);
        else if (account.blocked && client.online && options.disconnectUser) options.disconnectUser(account.name);
      }
    } catch (error) { lastError = error.message; }
  }

  return { sample, getClient, configure, resetUsage, remove, save,
    status: () => ({ since: state.since, lastSampleAt, error: lastError, timezone, intervalSeconds: 5 }),
    start: () => { if (!timer) { tick(); timer = setInterval(tick, 5000); timer.unref(); } },
    stop: () => { clearInterval(timer); timer = null; save(); } };
}

module.exports = { createMonitor, readCounters };

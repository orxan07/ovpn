// Per-account split routing. Only our reserved static addresses are managed here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const auth = require('./sstp-auth');
const singbox = require('./singbox-config');
const sstp = require('./sstp');
const FILE = path.join(__dirname, '../data/sstp-routing.json');
const JOURNAL = FILE + '.pending';
const SECRETS = '/etc/accel-ppp/chap-secrets';
const CONF = '/etc/accel-ppp.conf';
const SEED = { revision: 0, groups: [{ id: 'chatgpt', name: 'ChatGPT', domains: [
  'chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com', 'oaistatsig.com',
  'openaimerge.com', 'workos.com', 'workoscdn.com', 'workos.imgix.net',
  'challenges.cloudflare.com', 'ct.sendgrid.net', 'intercom.io', 'intercomcdn.com',
  'stripe.com', 'sentry.io', 'datadoghq.com', 'humb.apple.com',
  'livekit.cloud', 'webpubsub.azure.com',
] }], profiles: [], bindings: [], managedRoutes: [], managedDns: [] };
function invalid(message) { const e = new Error(message); e.status = 400; throw e; }
function normalize(input) {
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.groups) || !Array.isArray(input.profiles)) invalid('Некорректная конфигурация маршрутов');
  if (input.groups.length > 30 || input.profiles.length > 30) invalid('Не более 30 групп и профилей');
  const ids = new Set();
  const title = value => { if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f]/.test(value)) invalid('Название: 1–80 символов'); return value.trim(); };
  const id = value => { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value) || ids.has(value)) invalid('Некорректный или повторяющийся идентификатор'); ids.add(value); return value; };
  const groups = input.groups.map(g => {
    if (!g || !Array.isArray(g.domains) || g.domains.length < 1 || g.domains.length > 300) invalid('В группе должно быть 1–300 доменов');
    const domains = [...new Set(g.domains.map(d => {
      if (typeof d !== 'string') invalid('Домен должен быть строкой');
      d = d.trim().toLowerCase().replace(/^\*\./, '');
      if (d.length > 253 || d.split('.').length < 2 || !d.split('.').every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) invalid(`Некорректный домен: ${d.slice(0, 80)}`);
      return d;
    }))].sort();
    return { id: id(g.id), name: title(g.name), domains };
  });
  ids.clear(); const names = new Set();
  const profiles = input.profiles.map(p => {
    if (!p || !Array.isArray(p.groups) || !Array.isArray(p.users) || p.users.length > 80) invalid('Некорректный профиль');
    const selected = [...new Set(p.groups)];
    if (selected.some(g => !groups.some(item => item.id === g))) invalid('Профиль ссылается на удалённую группу');
    const users = [...new Set(p.users)];
    for (const name of users) { sstp.validateName(name); if (names.has(name)) invalid('Клиент может иметь только один профиль'); names.add(name); }
    return { id: id(p.id), name: title(p.name), groups: selected, users };
  });
  return { revision: input.revision, groups, profiles };
}
function read() {
  if (!fs.existsSync(FILE)) return structuredClone(SEED);
  const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  validateState(value);
  return value;
}
function validateState(value) {
  normalize(value);
  const fail = () => { throw new Error('Повреждён файл маршрутов SSTP'); };
  if (!Array.isArray(value.bindings) || !Array.isArray(value.managedRoutes) || !Array.isArray(value.managedDns)) fail();
  const names = new Set(); const ips = new Set();
  for (const b of value.bindings) {
    if (!b || typeof b.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,32}$/.test(b.name) || !/^10\.27\.0\.(?:1[6-9][0-9]|2[0-3][0-9])$/.test(b.ip) ||
        names.has(b.name) || ips.has(b.ip) || typeof b.originalIp !== 'string' || !/^(?:\*|10\.27\.0\.[0-9]{1,3})$/.test(b.originalIp)) fail();
    names.add(b.name); ips.add(b.ip);
  }
  if (JSON.stringify([...names].sort()) !== JSON.stringify(value.profiles.flatMap(p => p.users).sort())) fail();
  if (value.bindings.length && (!value.dnsCacheOriginal || typeof value.dnsCacheOriginal.present !== 'boolean' || typeof value.dnsCacheOriginal.value !== 'boolean')) fail();
  if ([...value.managedRoutes, ...value.managedDns].some(r => !r || typeof r !== 'object' || !Array.isArray(r.source_ip_cidr) || r.source_ip_cidr.some(ip => typeof ip !== 'string' || !ips.has(ip.replace(/\/32$/, ''))))) fail();
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex');
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function command(binary, args) { return execFileSync(binary, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); }
function install(file, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstp-routing-'));
  try { const tmp = path.join(dir, 'file'); fs.writeFileSync(tmp, content, { mode: 0o600 }); command('sudo', ['install', '-m', '600', tmp, file]); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function gateway(conf) {
  if ((conf.match(/^\[chap-secrets\][ \t]*\r?$/gm) || []).length !== 1) throw new Error('Требуется ровно один раздел [chap-secrets]');
  return conf.replace(/(^\[chap-secrets\][^\n]*\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m, (all, header, body) => {
    const matches = [...body.matchAll(/^gw-ip-address[ \t]*=[ \t]*(.*)$/gm)];
    if (matches.length > 1) throw new Error('Повторяющийся gateway chap-secrets');
    const match = matches[0];
    if (match && match[1].trim() !== '10.27.0.1') throw new Error('Нестандартный gateway chap-secrets; требуется настройка сервера');
    return header + (match ? body : 'gw-ip-address=10.27.0.1\n' + body);
  });
}
function strip(rules, managed) {
  const result = [...rules];
  for (const old of managed) {
    const index = result.findIndex(rule => JSON.stringify(rule) === JSON.stringify(old));
    if (index < 0) throw new Error('Правила профилей изменены вне панели. Сначала восстановите согласованную конфигурацию');
    result.splice(index, 1);
  }
  return result;
}
function build(input, previous, raw, config, sessions = []) {
  validateState(previous);
  const next = normalize(input);
  const records = auth.records(raw);
  const assigned = next.profiles.flatMap(p => p.users);
  const used = new Set([...records.map(r => r.ip), ...sessions.map(s => s.ip)]);
  next.bindings = assigned.map(name => {
    const record = auth.find(raw, name);
    const old = previous.bindings.find(b => b.name === name);
    if (old) {
      if (record.ip !== old.ip) throw new Error(`Адрес ${name} изменён вне профиля`);
      return { ...old };
    }
    if (record.ip !== '*' && !/^10\.27\.0\.(?:[0-9]{1,3})$/.test(record.ip)) invalid(`У ${name} нестандартный адрес или пул; сначала настройте его отдельно`);
    // Reserved addresses are outside the installed dynamic pool (.2–.100).
    let ip;
    for (let n = 160; n <= 239; n++) if (!used.has(`10.27.0.${n}`)) { ip = `10.27.0.${n}`; break; }
    if (!ip) invalid('Нет свободных адресов для профилей');
    used.add(ip);
    return { name, ip, originalIp: record.ip };
  });
  let secrets = raw;
  for (const old of previous.bindings) if (!assigned.includes(old.name) && records.some(r => r.name === old.name)) {
    if (auth.find(secrets, old.name).ip !== old.ip) throw new Error(`Адрес ${old.name} изменён вне профиля`);
    secrets = auth.change(secrets, old.name, { ip: old.originalIp });
  }
  for (const b of next.bindings) secrets = auth.change(secrets, b.name, { ip: b.ip });
  const updated = structuredClone(config);
  if (!updated.route || !updated.dns || !['outline', 'direct'].every(tag => updated.outbounds?.some(o => o.tag === tag)) || !['dns-local', 'dns-proxy'].every(tag => updated.dns.servers?.some(s => s.tag === tag))) throw new Error('Нет необходимых выходов/DNS sing-box');
  const baseRoutes = strip(updated.route.rules || [], previous.managedRoutes);
  const baseDns = strip(updated.dns.rules || [], previous.managedDns);
  if (next.bindings.length) {
    next.dnsCacheOriginal = previous.bindings.length ? previous.dnsCacheOriginal : {
      present: Object.hasOwn(updated.dns, 'independent_cache'), value: updated.dns.independent_cache ?? false,
    };
    updated.dns.independent_cache = true;
  } else if (previous.bindings.length) {
    if (!previous.dnsCacheOriginal) throw new Error('Нет исходных настроек DNS-кеша профилей');
    if (previous.dnsCacheOriginal.present) updated.dns.independent_cache = previous.dnsCacheOriginal.value;
    else delete updated.dns.independent_cache;
  }
  next.managedRoutes = []; next.managedDns = [];
  for (const profile of next.profiles) {
    const sources = next.bindings.filter(b => profile.users.includes(b.name)).map(b => b.ip + '/32');
    if (!sources.length) continue;
    const domains = [...new Set(next.groups.filter(g => profile.groups.includes(g.id)).flatMap(g => g.domains))].sort();
    if (domains.length) {
      next.managedRoutes.push({ source_ip_cidr: sources, domain_suffix: domains, action: 'route', outbound: 'outline' });
      next.managedDns.push({ source_ip_cidr: sources, domain_suffix: domains, action: 'route', server: 'dns-proxy' });
    }
    next.managedRoutes.push({ source_ip_cidr: sources, action: 'route', outbound: 'direct' });
    next.managedDns.push({ source_ip_cidr: sources, action: 'route', server: 'dns-local' });
  }
  // Sniff and DNS interception run before profile selection, global rules after it.
  const pre = baseRoutes.filter(r => r.action === 'sniff' || r.action === 'hijack-dns');
  updated.route.rules = [...pre, ...next.managedRoutes, ...baseRoutes.filter(r => !pre.includes(r))];
  updated.dns.rules = [...next.managedDns, ...baseDns];
  next.revision++;
  return { next, secrets, config: updated };
}
function reload() {
  const binary = ['/usr/bin/accel-cmd', '/usr/sbin/accel-cmd'].find(p => fs.existsSync(p));
  if (!binary) throw new Error('Не найден accel-cmd');
  const output = command('sudo', [binary, 'reload']);
  if (/error|failed|unknown/i.test(output)) throw new Error('Не удалось перечитать настройки SSTP');
}
function restore(snapshot) {
  if (!snapshot || typeof snapshot.secrets !== 'string' || typeof snapshot.conf !== 'string' || !snapshot.config?.route || !snapshot.config?.dns || !Array.isArray(snapshot.config.outbounds)) throw new Error('Повреждён журнал восстановления SSTP');
  if (snapshot.state !== null) validateState(snapshot.state);
  install(SECRETS, snapshot.secrets); install(CONF, snapshot.conf); reload();
  singbox.applyConfig(snapshot.config);
  if (snapshot.state) save(FILE, snapshot.state); else if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  fs.unlinkSync(JOURNAL);
}
function recover() {
  if (fs.existsSync(JOURNAL)) restore(JSON.parse(fs.readFileSync(JOURNAL, 'utf8')));
}
function get() {
  if (fs.existsSync(JOURNAL)) throw new Error('Предыдущее применение не завершено; требуется восстановление');
  const state = read();
  return { ...normalize(state), bindings: state.bindings, users: sstp.getUsers().map(u => ({ name: u.name, blocked: u.blocked })) };
}
function apply(input) {
  if (fs.existsSync(JOURNAL)) throw new Error('Предыдущее применение не завершено; требуется восстановление');
  const previous = read();
  if (input?.revision !== previous.revision) { const e = new Error('Настройки изменились. Обновите страницу перед сохранением'); e.status = 409; throw e; }
  const raw = command('sudo', ['cat', SECRETS]);
  const conf = command('sudo', ['cat', CONF]);
  // Refuse nonstandard pools: a static profile address must never be reallocated.
  if (!/^10\.27\.0\.2-100\s*$/m.test(conf)) throw new Error('Профили поддерживают пул 10.27.0.2–100; обнаружена другая настройка');
  const config = singbox.readConfig();
  const plan = build(input, previous, raw, config, sstp.getSessions());
  const newConf = plan.next.bindings.length ? gateway(conf) : conf;
  if (JSON.stringify(plan.config) === JSON.stringify(config) && plan.secrets === raw && newConf === conf) {
    save(FILE, plan.next);
    return { ...get(), warnings: [] };
  }
  // writeConfig validates before touching the active file; restore before transaction.
  // Validate separately so a bad group cannot disconnect a working tunnel.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstp-route-check-'));
  try { const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(plan.config), { mode: 0o600 }); command('sing-box', ['check', '-c', file]); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const snapshot = { secrets: raw, conf, config, state: fs.existsSync(FILE) ? previous : null };
  save(JOURNAL, snapshot);
  try {
    install(CONF, newConf); install(SECRETS, plan.secrets); reload();
    singbox.applyConfig(plan.config);
    save(FILE, plan.next);
    fs.unlinkSync(JOURNAL);
  } catch (error) {
    try { restore(snapshot); } catch { throw new Error('Не удалось применить или восстановить маршруты. Резервная копия сохранена; требуется восстановление сервера'); }
    throw new Error('Применение отменено; предыдущие настройки восстановлены');
  }
  const warnings = [];
  // Active clients need the stable address; terminate only accounts whose binding changed.
  const changed = new Set([...previous.bindings, ...plan.next.bindings].filter(b =>
    previous.bindings.find(x => x.name === b.name)?.ip !== plan.next.bindings.find(x => x.name === b.name)?.ip).map(b => b.name));
  for (const name of changed) try { sstp.disconnectUser(name); } catch { warnings.push(`Переподключите ${name}, чтобы применить адрес профиля`); }
  return { ...get(), warnings };
}
module.exports = { get, apply, recover, normalize, build, gateway, validateState, SEED };

// Редактор whitelist доменов в /etc/sing-box/config.json
const { readConfig, writeConfig, applyConfig } = require('./singbox-config');

// Собирает уникальный список доменов из всех мест конфига где они есть
function getDomains() {
  const config = readConfig();
  const domains = new Set();

  for (const rule of config.dns?.rules || []) {
    for (const d of rule.domain_suffix || []) domains.add(d);
  }
  for (const rule of config.route?.rules || []) {
    for (const d of rule.domain_suffix || []) domains.add(d);
  }

  return Array.from(domains).sort();
}

function getIpCidrs() {
  const config = readConfig();
  const cidrs = new Set();
  for (const rule of config.route?.rules || []) {
    for (const c of rule.ip_cidr || []) cidrs.add(c);
  }
  return Array.from(cidrs).sort();
}

function getRoutingMode() {
  const config = readConfig();
  const final = config.route?.final || 'direct';
  const hasOutline = (config.outbounds || []).some(outbound => outbound.tag === 'outline');

  return {
    mode: final === 'outline' ? 'all' : 'whitelist',
    final,
    allTrafficThroughOutline: final === 'outline',
    hasOutline,
  };
}

function setRoutingMode(mode) {
  if (!['whitelist', 'all'].includes(mode)) {
    throw new Error('mode должен быть whitelist или all');
  }

  const config = readConfig();
  const hasOutline = (config.outbounds || []).some(outbound => outbound.tag === 'outline');
  if (!hasOutline) throw new Error('В sing-box config не найден outbound tag=outline');

  config.route = config.route || {};
  config.route.final = mode === 'all' ? 'outline' : 'direct';

  applyConfig(config);

  return getRoutingMode();
}

function addIpCidr(cidr) {
  const config = readConfig();
  for (const rule of config.route?.rules || []) {
    if (rule.ip_cidr && rule.outbound === 'outline') {
      if (!rule.ip_cidr.includes(cidr)) rule.ip_cidr.push(cidr);
    }
  }
  writeConfig(config);
}

function collectDomains(config) {
  const domains = new Set();
  for (const rule of config.dns?.rules || []) {
    for (const d of rule.domain_suffix || []) domains.add(d);
  }
  for (const rule of config.route?.rules || []) {
    for (const d of rule.domain_suffix || []) domains.add(d);
  }
  return domains;
}

function collectIpCidrs(config) {
  const cidrs = new Set();
  for (const rule of config.route?.rules || []) {
    for (const c of rule.ip_cidr || []) cidrs.add(c);
  }
  return cidrs;
}

function normalizeDomain(domain) {
  if (typeof domain !== 'string') throw new Error('Домен должен быть строкой');
  const normalized = domain.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  if (normalized.length > 253 || !normalized.split('.').every(label =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('Некорректный домен');
  }
  return normalized;
}

function addPresetToConfig(config, preset) {
  let domainsAdded = 0;
  let ipCidrsAdded = 0;
  let changed = false;

  for (const domain of preset.domains || []) {
    const d = normalizeDomain(domain);
    let added = false;

    for (const rule of config.dns?.rules || []) {
      if (rule.domain_suffix && rule.server === 'dns-proxy') {
        if (!rule.domain_suffix.includes(d)) {
          rule.domain_suffix.push(d);
          added = true;
          changed = true;
        }
      }
    }
    for (const rule of config.route?.rules || []) {
      if (rule.domain_suffix && rule.outbound === 'outline') {
        if (!rule.domain_suffix.includes(d)) {
          rule.domain_suffix.push(d);
          added = true;
          changed = true;
        }
      }
    }

    if (added) domainsAdded++;
  }

  for (const cidr of preset.ipCidr || []) {
    let added = false;
    for (const rule of config.route?.rules || []) {
      if (rule.ip_cidr && rule.outbound === 'outline') {
        if (!rule.ip_cidr.includes(cidr)) {
          rule.ip_cidr.push(cidr);
          added = true;
          changed = true;
        }
      }
    }

    if (added) ipCidrsAdded++;
  }

  return { changed, domainsAdded, ipCidrsAdded };
}

// Добавляет домен во все нужные места (dns.rules + route.rules)
function addDomain(domain) {
  domain = normalizeDomain(domain); // убираем *. префикс
  const config = readConfig();

  let added = false;

  // dns.rules — первое правило с domain_suffix
  for (const rule of config.dns?.rules || []) {
    if (rule.domain_suffix && rule.server === 'dns-proxy') {
      if (!rule.domain_suffix.includes(domain)) {
        rule.domain_suffix.push(domain);
        added = true;
      }
    }
  }

  // route.rules — правило с outbound: outline
  for (const rule of config.route?.rules || []) {
    if (rule.domain_suffix && rule.outbound === 'outline') {
      if (!rule.domain_suffix.includes(domain)) {
        rule.domain_suffix.push(domain);
        added = true;
      }
    }
  }

  if (!added) throw new Error(`Домен ${domain} уже есть или не найдены нужные правила`);

  applyConfig(config);
  return domain;
}

// Удаляет домен из всех мест
function removeDomain(domain) {
  domain = normalizeDomain(domain);
  const config = readConfig();

  for (const rule of config.dns?.rules || []) {
    if (rule.domain_suffix) {
      rule.domain_suffix = rule.domain_suffix.filter(d => d !== domain);
    }
  }
  for (const rule of config.route?.rules || []) {
    if (rule.domain_suffix) {
      rule.domain_suffix = rule.domain_suffix.filter(d => d !== domain);
    }
  }

  applyConfig(config);
}

// Применяет пресет: добавляет домены + ip_cidr, перезапускает sing-box один раз
function applyPreset(preset) {
  const config = readConfig();
  addPresetToConfig(config, preset);
  applyConfig(config);
}

function isPresetApplied(config, preset) {
  const domains = collectDomains(config);
  const anchors = preset.syncAnchors || [preset.domains?.[0]].filter(Boolean);
  return anchors.some(domain => domains.has(normalizeDomain(domain)));
}

// После deploy обновляет только те пресеты, которые уже были применены раньше.
// Это не включает новые сервисы само по себе, а лишь подтягивает новые домены/IP.
function syncAppliedPresets(presets) {
  const config = readConfig();
  const result = [];
  let domainsAdded = 0;
  let ipCidrsAdded = 0;

  for (const preset of presets) {
    if (!isPresetApplied(config, preset)) continue;

    const added = addPresetToConfig(config, preset);
    if (added.changed) {
      result.push({ name: preset.name, ...added });
      domainsAdded += added.domainsAdded;
      ipCidrsAdded += added.ipCidrsAdded;
    }
  }

  if (domainsAdded || ipCidrsAdded) {
    applyConfig(config);
  }

  return { changed: Boolean(domainsAdded || ipCidrsAdded), domainsAdded, ipCidrsAdded, presets: result };
}

module.exports = {
  getDomains,
  getIpCidrs,
  getRoutingMode,
  setRoutingMode,
  addDomain,
  removeDomain,
  addIpCidr,
  applyPreset,
  syncAppliedPresets,
};

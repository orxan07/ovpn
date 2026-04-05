// Редактор whitelist доменов в /etc/sing-box/config.json
const { execSync } = require('child_process');
const fs = require('fs');

const SINGBOX_CONF = '/etc/sing-box/config.json';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function readConfig() {
  const raw = run(`sudo cat ${SINGBOX_CONF}`);
  return JSON.parse(raw);
}

function writeConfig(config) {
  const json = JSON.stringify(config, null, 2);
  const tmp = `/tmp/singbox-config-${Date.now()}.json`;
  require('fs').writeFileSync(tmp, json);
  run(`sudo cp ${tmp} ${SINGBOX_CONF}`);
  require('fs').unlinkSync(tmp);
}

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

function addIpCidr(cidr) {
  const config = readConfig();
  for (const rule of config.route?.rules || []) {
    if (rule.ip_cidr && rule.outbound === 'outline') {
      if (!rule.ip_cidr.includes(cidr)) rule.ip_cidr.push(cidr);
    }
  }
  writeConfig(config);
}

// Добавляет домен во все нужные места (dns.rules + route.rules)
function addDomain(domain) {
  domain = domain.toLowerCase().replace(/^[*.]+/, ''); // убираем *. префикс
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

  writeConfig(config);
  restartSingbox();
  return domain;
}

// Удаляет домен из всех мест
function removeDomain(domain) {
  domain = domain.toLowerCase().replace(/^[*.]+/, '');
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

  writeConfig(config);
  restartSingbox();
}

// Применяет пресет: добавляет домены + ip_cidr, перезапускает sing-box один раз
function applyPreset(preset) {
  const config = readConfig();

  for (const domain of preset.domains || []) {
    const d = domain.toLowerCase();
    for (const rule of config.dns?.rules || []) {
      if (rule.domain_suffix && rule.server === 'dns-proxy') {
        if (!rule.domain_suffix.includes(d)) rule.domain_suffix.push(d);
      }
    }
    for (const rule of config.route?.rules || []) {
      if (rule.domain_suffix && rule.outbound === 'outline') {
        if (!rule.domain_suffix.includes(d)) rule.domain_suffix.push(d);
      }
    }
  }

  for (const cidr of preset.ipCidr || []) {
    for (const rule of config.route?.rules || []) {
      if (rule.ip_cidr && rule.outbound === 'outline') {
        if (!rule.ip_cidr.includes(cidr)) rule.ip_cidr.push(cidr);
      }
    }
  }

  writeConfig(config);
  restartSingbox();
}

function restartSingbox() {
  run('sudo systemctl restart sing-box');
}

module.exports = { getDomains, getIpCidrs, addDomain, removeDomain, addIpCidr, applyPreset };

// Реквизиты подключения Telegram. Не управляет удалённым контейнером прокси.
const fs = require('fs').promises;
const path = require('path');
const net = require('net');
const { randomBytes } = require('crypto');

const DATA_DIR = path.join(__dirname, '../data');
const CONFIG_FILE = path.join(DATA_DIR, 'mtproto.json');
const DEFAULTS = { server: '156.67.63.163', port: 443, secret: '' };
let writes = Promise.resolve();

class ValidationError extends Error {}

function isHostname(value) {
  return value.length <= 253 && value.split('.').every(label =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Ожидаются server, port и secret');
  }
  const { server, port, secret } = input;
  if (typeof server !== 'string' || !server || server.includes('%') ||
      (!net.isIP(server) && (!isHostname(server) || /^[0-9.]+$/.test(server)))) {
    throw new ValidationError('Server должен быть hostname, IPv4 или IPv6 без порта');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('Port должен быть целым числом от 1 до 65535');
  }
  if (typeof secret !== 'string') {
    throw new ValidationError('Secret должен быть строкой');
  }
  let validSecret = secret === '' || /^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/i.test(secret);
  if (!validSecret && /^ee[0-9a-f]{32}(?:[0-9a-f]{2}){1,253}$/i.test(secret)) {
    const domain = Buffer.from(secret.slice(34), 'hex').toString('latin1');
    validSecret = isHostname(domain) && !/^[0-9.]+$/.test(domain);
  }
  if (!validSecret) {
    throw new ValidationError('Secret: 32 hex, dd + 32 hex или ee + 32 hex + домен в hex');
  }
  return { server: server.toLowerCase(), port, secret: secret.toLowerCase() };
}

function present(config) {
  const configured = Boolean(config.secret);
  const params = new URLSearchParams({ server: config.server, port: String(config.port), secret: config.secret });
  return { ...config, configured, link: configured ? `https://t.me/proxy?${params}` : null };
}

async function getConfig() {
  await writes;
  let contents;
  try {
    contents = await fs.readFile(CONFIG_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return present(DEFAULTS);
    throw new Error('Не удалось прочитать настройки MTProto');
  }
  try {
    return present(validateConfig(JSON.parse(contents)));
  } catch {
    // JSON parse errors can contain the secret: never expose the underlying error.
    throw new Error('Некорректный файл настроек MTProto');
  }
}

async function writeConfig(config) {
  const temporary = `${CONFIG_FILE}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, CONFIG_FILE);
    return present(config);
  } catch {
    throw new Error('Не удалось сохранить настройки MTProto');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function setConfig(input) {
  const config = validateConfig(input);
  const result = writes.then(() => writeConfig(config));
  // A failed save must not block later requests.
  writes = result.catch(() => {});
  return result;
}

module.exports = { getConfig, setConfig, ValidationError };

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const wg = require('./wg');
const system = require('./system');
const store = require('./store');
const whitelist = require('./whitelist');

const app = express();
const PORT = process.env.PORT || 8080;
const ENV_FILE = path.join(__dirname, '.env');

// Читаем токен из .env в runtime (чтобы перегенерация работала без перезапуска)
function getToken() {
  try {
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    const match = env.match(/AUTH_TOKEN=(.+)/);
    return match ? match[1].trim() : (process.env.AUTH_TOKEN || 'changeme');
  } catch {
    return process.env.AUTH_TOKEN || 'changeme';
  }
}

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));

// Auth middleware
app.use('/api', (req, res, next) => {
  if (req.headers['authorization'] !== `Bearer ${getToken()}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Peers ──────────────────────────────────────────────

app.get('/api/peers', (req, res) => {
  try {
    const peers = wg.getPeersWithStatus();
    const storeData = store.getAll();
    // Объединяем с данными из store
    const result = peers.map(p => ({
      ...p,
      blocked: storeData[p.name]?.blocked || false,
      limitGb: storeData[p.name]?.limitGb || null,
      note: storeData[p.name]?.note || '',
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/peers/:name', (req, res) => {
  try {
    const p = wg.getPeerDetail(req.params.name);
    const s = store.getClient(req.params.name);
    res.json({ ...p, ...s });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/peers', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name обязателен' });
    const result = wg.createClient(name);
    store.setCreatedAt(name, Date.now());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/peers/:name', (req, res) => {
  try {
    const { newName, note, limitGb } = req.body;

    if (newName) {
      wg.renameClient(req.params.name, newName);
      store.renameClient(req.params.name, newName);
    }
    if (note !== undefined) store.setNote(req.params.name, note);
    if (limitGb !== undefined) store.setLimit(req.params.name, limitGb === '' ? null : Number(limitGb));

    res.json({ ok: true, name: newName || req.params.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/peers/:name', (req, res) => {
  try {
    wg.deleteClient(req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Блокировка
app.post('/api/peers/:name/block', (req, res) => {
  try {
    wg.blockClient(req.params.name);
    store.setBlocked(req.params.name, true);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/peers/:name/unblock', (req, res) => {
  try {
    wg.unblockClient(req.params.name);
    store.setBlocked(req.params.name, false);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/peers/:name/config', (req, res) => {
  try {
    res.type('text/plain').send(wg.getClientConf(req.params.name));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Скачать .conf файл
app.get('/api/peers/:name/download', (req, res) => {
  try {
    const conf = wg.getClientConf(req.params.name);
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.conf"`);
    res.type('text/plain').send(conf);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/peers/:name/qr', (req, res) => {
  try {
    res.json({ qr: wg.getClientQr(req.params.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/peers/:name/singbox', (req, res) => {
  try {
    const mode = req.query.mode === 'wifi' ? 'wifi' : 'mobile';
    res.json(wg.getSingboxConf(req.params.name, mode));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// История endpoint'ов
app.get('/api/peers/:name/endpoints', (req, res) => {
  try {
    const s = store.getClient(req.params.name);
    res.json(s.endpoints || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── System ─────────────────────────────────────────────

app.get('/api/system', (req, res) => {
  try {
    res.json(system.getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Перезапуск сервисов
app.post('/api/system/restart/:service', (req, res) => {
  const allowed = ['sing-box', 'wg-quick@wg0'];
  const service = req.params.service;
  if (!allowed.includes(service)) return res.status(400).json({ error: 'Недопустимый сервис' });
  try {
    execSync(`sudo systemctl restart ${service}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Проверка доступности Outline + sing-box
app.get('/api/system/check', (req, res) => {
  const results = {};

  // sing-box статус
  try {
    const out = execSync('sudo systemctl is-active sing-box', { encoding: 'utf8' }).trim();
    results.singbox = { ok: out === 'active', status: out };
  } catch {
    results.singbox = { ok: false, status: 'inactive' };
  }

  // WireGuard статус
  try {
    const out = execSync('sudo systemctl is-active wg-quick@wg0', { encoding: 'utf8' }).trim();
    results.wireguard = { ok: out === 'active', status: out };
  } catch {
    results.wireguard = { ok: false, status: 'inactive' };
  }

  // Outline — пробуем достучаться до shadowsocks сервера
  try {
    const conf = JSON.parse(execSync('sudo cat /etc/sing-box/config.json', { encoding: 'utf8' }));
    const outline = conf.outbounds?.find(o => o.tag === 'outline');
    if (outline) {
      results.outline = { server: outline.server, port: outline.server_port };
      try {
        execSync(`timeout 3 bash -c "echo >/dev/tcp/${outline.server}/${outline.server_port}" 2>/dev/null`);
        results.outline.ok = true;
      } catch {
        results.outline.ok = false;
      }
    } else {
      results.outline = { ok: false, status: 'не настроен' };
    }
  } catch (e) {
    results.outline = { ok: false, status: e.message };
  }

  res.json(results);
});

// Перегенерация токена
app.post('/api/system/rotate-token', (req, res) => {
  try {
    const newToken = require('crypto').randomBytes(16).toString('hex');
    const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const updated = current.includes('AUTH_TOKEN=')
      ? current.replace(/AUTH_TOKEN=.+/, `AUTH_TOKEN=${newToken}`)
      : current + `\nAUTH_TOKEN=${newToken}\n`;
    fs.writeFileSync(ENV_FILE, updated);
    res.json({ token: newToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Whitelist ──────────────────────────────────────────

app.get('/api/whitelist', (req, res) => {
  try {
    res.json(whitelist.getDomains());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/whitelist', (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain обязателен' });
    const added = whitelist.addDomain(domain);
    res.json({ ok: true, domain: added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/whitelist/:domain', (req, res) => {
  try {
    whitelist.removeDomain(req.params.domain);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Фоновый поллинг ────────────────────────────────────
// Каждые 30 сек: трекаем endpoint'ы и проверяем лимиты

setInterval(() => {
  try {
    const peers = wg.getPeersWithStatus();
    const storeData = store.getAll();

    for (const p of peers) {
      // Трекаем endpoint
      if (p.endpoint) store.trackEndpoint(p.name, p.endpoint);

      // Проверяем лимит трафика
      const s = storeData[p.name];
      if (s?.limitGb && !s.blocked) {
        const totalGb = (p.rx + p.tx) / 1024 / 1024 / 1024;
        if (totalGb >= s.limitGb) {
          console.log(`[limit] Блокируем ${p.name}: ${totalGb.toFixed(2)} GB >= ${s.limitGb} GB`);
          try {
            wg.blockClient(p.name);
            store.setBlocked(p.name, true);
          } catch (e) {
            console.error(`[limit] Ошибка блокировки ${p.name}:`, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('[poll]', e.message);
  }
}, 30000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WireGuard admin listening on :${PORT}`);
});

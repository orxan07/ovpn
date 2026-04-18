const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const wg = require('./wg');
const system = require('./system');
const store = require('./store');
const whitelist = require('./whitelist');
const { PRESETS } = require('./presets');
const diag = require('./diagnostics');
const sstp = require('./sstp');

const app = express();
const PORT = process.env.PORT || 8080;
const ENV_FILE = path.join(__dirname, '.env');

function getSingboxMode(mode) {
  return ['mobile', 'wifi', 'beta', 'mac'].includes(mode) ? mode : 'mobile';
}

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

// Публичный endpoint для remote profile (без авторизации, защищён токеном в URL)
app.get('/config/:token', (req, res) => {
  const name = store.findByConfigToken(req.params.token);
  if (!name) return res.status(404).json({ error: 'Not found' });
  const mode = getSingboxMode(req.query.mode);
  try {
    res.json(wg.getSingboxConf(name, mode));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// Получить или сгенерировать config token для remote profile
app.post('/api/peers/:name/config-token', (req, res) => {
  try {
    const token = store.generateConfigToken(req.params.name);
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/peers/:name/keenetic', (req, res) => {
  try {
    const conf = wg.getKeeneticConf(req.params.name);
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}-keenetic.conf"`);
    res.type('text/plain').send(conf);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/peers/:name/singbox', (req, res) => {
  try {
    const mode = getSingboxMode(req.query.mode);
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
  const allowed = ['sing-box', 'wg-quick@wg0', 'accel-ppp'];
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

  // SSTP (accel-ppp) статус
  try {
    const out = execSync('sudo systemctl is-active accel-ppp', { encoding: 'utf8' }).trim();
    results.sstp = { ok: out === 'active', status: out };
  } catch {
    results.sstp = { ok: false, status: 'inactive' };
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

app.get('/api/whitelist/presets', (req, res) => {
  res.json(PRESETS.map(p => ({ name: p.name, domains: p.domains.length, ipCidr: p.ipCidr.length })));
});

app.post('/api/whitelist/presets/apply', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name обязателен' });
    const preset = PRESETS.find(p => p.name === name);
    if (!preset) return res.status(404).json({ error: 'Пресет не найден' });
    whitelist.applyPreset(preset);
    res.json({ ok: true });
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

// ── SSTP (accel-ppp) ──────────────────────────────────

app.get('/api/sstp/status', (req, res) => {
  try { res.json(sstp.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sstp/users', (req, res) => {
  try { res.json(sstp.getUsers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Раскрытие пароля по запросу (для копирования клиенту)
app.get('/api/sstp/users/:name/credentials', (req, res) => {
  try {
    const u = sstp.getUserWithPassword(req.params.name);
    const status = sstp.getStatus();
    res.json({
      name: u.name,
      password: u.password,
      server: status.externalIp,
      port: status.port,
    });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.post('/api/sstp/users', (req, res) => {
  try {
    const { name, password } = req.body;
    res.json(sstp.addUser(name, password));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/sstp/users/:name', (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password обязателен' });
    res.json(sstp.setPassword(req.params.name, password));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/sstp/users/:name', (req, res) => {
  try { res.json(sstp.removeUser(req.params.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/sstp/sessions', (req, res) => {
  try { res.json(sstp.getSessions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sstp/sessions/:ifname/disconnect', (req, res) => {
  try { res.json(sstp.disconnectSession(req.params.ifname)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/sstp/restart', (req, res) => {
  try { res.json(sstp.restart()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Скачать TLS-сертификат сервера (для импорта в Trusted Root на Windows и т.п.)
app.get('/api/sstp/cert', (req, res) => {
  try {
    const pem = sstp.getServerCert();
    res.setHeader('Content-Disposition', 'attachment; filename="sstp-server.crt"');
    res.type('application/x-pem-file').send(pem);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/sstp/cert/info', (req, res) => {
  try { res.json(sstp.getCertInfo()); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

// Диагностика интеграции SSTP-трафика с sing-box
app.get('/api/sstp/integration', (req, res) => {
  try { res.json(sstp.getIntegrationDiagnostics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Diagnostics ───────────────────────────────────────

app.get('/api/diag/overview', (req, res) => {
  try {
    res.json(diag.getOverview());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diag/peers', (req, res) => {
  try {
    res.json(diag.getPeersDetailed());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diag/ping', (req, res) => {
  try {
    const { target, count } = req.body;
    if (!target) return res.status(400).json({ error: 'target обязателен' });
    const result = diag.pingTest(target, Math.min(count || 4, 10));
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diag/dns', (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain обязателен' });
    res.json(diag.dnsTest(domain));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diag/tcpdump', async (req, res) => {
  try {
    const { iface, filter, count, timeout } = req.body;
    const result = await diag.tcpdumpCapture(
      iface || 'wg0',
      filter || '',
      Math.min(count || 10, 50),
      Math.min(timeout || 8, 15),
    );
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diag/logs', (req, res) => {
  try {
    const { peer, lines } = req.query;
    const result = diag.getSingboxLogs(peer, Math.min(parseInt(lines) || 50, 200));
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diag/nftables', (req, res) => {
  try {
    res.json({ result: diag.getNftSingbox() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diag/singbox-config', (req, res) => {
  try {
    res.json({ result: diag.getSingboxConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diag/routes', (req, res) => {
  try {
    res.json({ routes: diag.getRoutes() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diag/curl', (req, res) => {
  try {
    const { url, timeout } = req.body;
    if (!url) return res.status(400).json({ error: 'url обязателен' });
    const result = diag.curlTest(url, Math.min(timeout || 5, 15));
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diag/keenetic-exec', async (req, res) => {
  try {
    const { host, port, commands, login, password } = req.body;
    if (!host || !commands?.length) return res.status(400).json({ error: 'host и commands обязательны' });
    const result = await diag.keeneticExec(host, port || 23, commands, login || 'admin', password || '');
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diag/audit', (req, res) => {
  try {
    res.json(diag.auditWgConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diag/remove-peer', (req, res) => {
  try {
    const { pubkey } = req.body;
    if (!pubkey) return res.status(400).json({ error: 'pubkey обязателен' });
    res.json(diag.removePeerFromConfig(pubkey));
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

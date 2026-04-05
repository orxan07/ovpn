const express = require('express');
const cors = require('cors');
const path = require('path');
const wg = require('./wg');

const app = express();
const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';

app.use(express.json());
app.use(cors());

// Статика (frontend)
app.use(express.static(path.join(__dirname, '../client')));

// Auth middleware
app.use('/api', (req, res, next) => {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// GET /api/peers — список всех клиентов с live-статусом
app.get('/api/peers', (req, res) => {
  try {
    const peers = wg.getPeersWithStatus();
    res.json(peers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/peers — создать нового клиента
// Body: { name: "имя" }
app.post('/api/peers', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name обязателен' });
    const result = wg.createClient(name);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/peers/:name — удалить клиента
app.delete('/api/peers/:name', (req, res) => {
  try {
    wg.deleteClient(req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/peers/:name/config — текст .conf
app.get('/api/peers/:name/config', (req, res) => {
  try {
    const conf = wg.getClientConf(req.params.name);
    res.type('text/plain').send(conf);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// GET /api/peers/:name/qr — QR в base64 PNG
app.get('/api/peers/:name/qr', (req, res) => {
  try {
    const qr = wg.getClientQr(req.params.name);
    res.json({ qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WireGuard admin listening on :${PORT}`);
});

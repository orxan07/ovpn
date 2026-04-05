const express = require('express');
const cors = require('cors');
const path = require('path');
const wg = require('./wg');

const app = express();
const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));

// Auth middleware
app.use('/api', (req, res, next) => {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// GET /api/peers
app.get('/api/peers', (req, res) => {
  try {
    res.json(wg.getPeersWithStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/peers/:name
app.get('/api/peers/:name', (req, res) => {
  try {
    res.json(wg.getPeerDetail(req.params.name));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// POST /api/peers — создать клиента
app.post('/api/peers', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name обязателен' });
    res.json(wg.createClient(name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/peers/:name — переименовать
app.patch('/api/peers/:name', (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'newName обязателен' });
    wg.renameClient(req.params.name, newName);
    res.json({ ok: true, name: newName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/peers/:name
app.delete('/api/peers/:name', (req, res) => {
  try {
    wg.deleteClient(req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/peers/:name/config
app.get('/api/peers/:name/config', (req, res) => {
  try {
    res.type('text/plain').send(wg.getClientConf(req.params.name));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// GET /api/peers/:name/qr
app.get('/api/peers/:name/qr', (req, res) => {
  try {
    res.json({ qr: wg.getClientQr(req.params.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/peers/:name/singbox?mode=mobile|wifi
app.get('/api/peers/:name/singbox', (req, res) => {
  try {
    const mode = req.query.mode === 'wifi' ? 'wifi' : 'mobile';
    res.json(wg.getSingboxConf(req.params.name, mode));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WireGuard admin listening on :${PORT}`);
});

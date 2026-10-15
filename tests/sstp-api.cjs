// Isolated SSTP route integration checks: no Express install, listeners or system commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.SSTP_TEST_ROOT || path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sstp-api-'));
const stateFile = path.join(temporary, 'monitor.json');
const routes = new Map();
const middleware = [];
const app = {
  use(...args) { if (args[0] === '/api') middleware.push(args[1]); },
  listen() {},
};
for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
  app[method] = (route, handler) => routes.set(`${method} ${route}`, handler);
}
const express = () => app;
express.json = express.static = () => () => {};

// Load the real command wrapper with inert child_process functions to exercise its
// validators and command-error handling without sudo, accel-ppp or network access.
let commandOutput = '';
let commandCount = 0;
let authContents = 'alice * password123 *\n';
let installs = 0;
const commandCalls = [];
const commandModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'server/sstp.js'), 'utf8'), {
  require(name) {
    if (name === 'child_process') return {
      execSync(command) { commandCount++; return command.includes('cat /etc/accel-ppp/chap-secrets') ? authContents : ''; },
      execFileSync(binary, args) {
        commandCount++;
        commandCalls.push({ binary, args });
        if (args[0] === 'install') {
          installs++;
          authContents = fs.readFileSync(args[3], 'utf8');
        }
        return commandOutput;
      },
    };
    if (name === 'fs') return {
      ...fs,
      existsSync(file) {
        if (file.endsWith('/accel-cmd')) return file === '/usr/bin/accel-cmd';
        return fs.existsSync(file);
      },
    };
    return require(name.startsWith('./') ? path.join(root, 'server', name) : name);
  },
  __dirname: path.join(root, 'server'), module: commandModule, Buffer, process,
});
const realSstp = commandModule.exports;
let accounts = [{ name: 'alice', blocked: false, passwordLength: 8 }];
let sessions = [];
let failMutation = false;
let mutations = 0;
let bytes = 0;
let monitor;
const sstp = {
  validateName: realSstp.validateName,
  validatePassword: realSstp.validatePassword,
  getUsers: () => accounts.map(account => ({ ...account })),
  getSessions: () => sessions,
  addUser(name, password) {
    mutations++;
    accounts.push({ name, blocked: false, passwordLength: (password || 'generated').length });
    return { name, password: password || 'generated' };
  },
  setBlocked(name, blocked) {
    if (failMutation) throw new Error('block failure');
    mutations++;
    accounts.find(account => account.name === name).blocked = blocked;
    return { name, blocked };
  },
  disconnectUser() {
    if (failMutation) throw new Error('disconnect failure');
    mutations++;
    return { ok: true };
  },
  getUserWithPassword: () => ({ name: 'alice', password: 'secret' }),
  getStatus: () => ({ publicHost: 'vpn.example', port: 443 }),
  removeUser(name) {
    mutations++;
    accounts = accounts.filter(account => account.name !== name);
    return { ok: true };
  },
};
const { createMonitor } = require(path.join(root, 'server/sstp-monitor'));
function requireStub(name) {
  if (name === 'express') return express;
  if (name === 'cors') return () => () => {};
  if (name === './sstp') return sstp;
  if (name === './sstp-monitor') return {
    createMonitor(options) {
      monitor = createMonitor({ ...options, file: stateFile,
        readCounters: () => ({ upload: bytes, download: 0 }) });
      monitor.start = () => {}; // Explicit samples only; no background interval.
      return monitor;
    },
  };
  if (name === './sstp-activity') return { getActivity: async () => ({ entries: [] }) };
  if (name === './store') return { getAll: () => ({}) };
  if (name === './wg') return { reconcileBlockedClients: () => ({ errors: [] }) };
  if (name.startsWith('./')) return {};
  if (name === 'fs') return {
    ...fs,
    readFileSync(file, ...args) {
      // Do not depend on the developer's runtime AUTH_TOKEN or read their .env.
      if (file === path.join(root, 'server/.env')) throw new Error('test environment');
      return fs.readFileSync(file, ...args);
    },
  };
  return require(name);
}
vm.runInNewContext(fs.readFileSync(path.join(root, 'server/index.js'), 'utf8'), {
  require: requireStub, __dirname: path.join(root, 'server'),
  process: { env: { AUTH_TOKEN: 'test' } }, console,
  setInterval: () => ({ unref() {} }), clearInterval() {},
});
async function call(method, route, body = {}, name = 'alice', token = 'test') {
  const response = {
    code: 200, headers: {},
    status(code) { this.code = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const request = { body, params: { name }, query: {},
    headers: { authorization: token ? `Bearer ${token}` : undefined } };
  let authorized = false;
  middleware[0](request, response, () => { authorized = true; });
  if (authorized) await routes.get(`${method} ${route}`)(request, response);
  return response;
}
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
async function run() {
  assert.equal((await call('get', '/api/sstp/clients', {}, 'alice', null)).code, 401);
  assert.equal((await call('get', '/api/sstp/clients', {}, 'alice', 'wrong')).code, 401);
  let response = await call('get', '/api/sstp/clients');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert(!JSON.stringify(response.body).includes('secret'));
  assert(!Object.hasOwn(response.body.clients[0], 'password'));
  for (const route of ['/api/sstp/clients/:name/activity', '/api/sstp/users/:name/credentials']) {
    assert.equal((await call('get', route)).headers['Cache-Control'], 'no-store');
  }
  for (const patch of [{ unknown: true }, { limitGb: NaN }, { limitGb: -1 },
    { limitGb: 1000001 }, { expiresAt: 'bad' }, { note: 2 }, {}]) {
    assert.equal((await call('patch', '/api/sstp/clients/:name', patch)).code, 400);
  }
  assert.equal((await call('patch', '/api/sstp/clients/:name', { note: 'x' }, 'unknown')).code, 400);
  assert.equal((await call('patch', '/api/sstp/clients/:name', {
    expiresAt: '2000-01-01T00:00:00Z',
  })).code, 200);
  assert.equal((await call('post', '/api/sstp/clients/:name/access', { blocked: false })).code, 400);
  await call('patch', '/api/sstp/clients/:name', { expiresAt: null, limitGb: 1 });
  sessions = [{ ifname: 'sstp0', username: 'alice', sid: '1' }];
  monitor.sample();
  bytes = 1024 ** 3;
  monitor.sample();
  assert.equal((await call('post', '/api/sstp/clients/:name/access', { blocked: false })).code, 400);
  await call('post', '/api/sstp/clients/:name/access', { blocked: true });
  assert((await call('get', '/api/sstp/clients')).body.clients[0].blocked);
  failMutation = true;
  assert.equal((await call('post', '/api/sstp/clients/:name/access', { blocked: true })).code, 400);
  assert.equal((await call('post', '/api/sstp/clients/:name/disconnect')).code, 400);
  failMutation = false;

  // Duplicate create must preserve a live account's measured usage and settings.
  const beforeDuplicate = fs.readFileSync(stateFile, 'utf8');
  const beforeMutations = mutations;
  assert.equal((await call('post', '/api/sstp/users', { name: 'alice', password: 'abcdefgh' })).code, 400);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeDuplicate);
  assert.equal(mutations, beforeMutations);

  // Invalid JSON types/values must not erase stale metadata or touch auth state.
  monitor.configure('reused', { note: 'old account', limitGb: 4, expiresAt: '2000-01-01T00:00:00Z' });
  const beforeInvalid = fs.readFileSync(stateFile, 'utf8');
  for (const body of [{ name: ['reused'] }, { name: 123 }, { name: {} },
    { name: null }, { name: 'bad name' }, { name: 'reused', password: 12345678 },
    { name: 'reused', password: ['abcdefgh'] }, { name: 'reused', password: {} },
    { name: 'reused', password: null }, { name: 'reused', password: '' }]) {
    assert.equal((await call('post', '/api/sstp/users', body)).code, 400);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeInvalid);
    assert.equal(mutations, beforeMutations);
  }
  response = await call('post', '/api/sstp/users', { name: 'reused', password: 'abcdefgh' });
  assert.equal(response.code, 200);
  assert.equal(response.body.name, 'reused');
  assert(!Object.hasOwn(readState().users, 'reused'));
  const reused = (await call('get', '/api/sstp/clients')).body.clients.find(client => client.name === 'reused');
  assert.equal(reused.note, '');
  assert.equal(reused.limitGb, null);
  assert.equal(reused.expiresAt, null);
  assert.equal(reused.upload + reused.download, 0);
  assert.equal(reused.history.length, 0);
  assert.equal((await call('post', '/api/sstp/users', { name: 'generated' })).code, 200);

  await call('delete', '/api/sstp/users/:name');
  assert(!Object.hasOwn(readState().users, 'alice'));
  assert(!Object.values(readState().active).some(session => session.username === 'alice'));

  // Both exit-zero CLI text errors and valid output are checked against real wrappers.
  for (const output of ['Unknown command\r\n', 'command unknown\r\n', 'Error: rejected', 'Failed to terminate', 'Permission denied']) {
    commandOutput = output;
    assert.throws(() => realSstp.disconnectUser('alice'));
    assert.throws(() => realSstp.disconnectSession('sstp0'));
  }
  for (const output of ['', 'OK\r\n']) {
    commandOutput = output;
    assert.equal(realSstp.disconnectUser('alice').ok, true);
    assert.equal(realSstp.disconnectSession('sstp0').ok, true);
  }
  const terminateCalls = commandCalls.filter(call => call.args[0].endsWith('/accel-cmd'));
  assert(terminateCalls.length > 0);
  for (const call of terminateCalls) {
    assert.equal(call.binary, 'sudo');
    assert.equal(call.args[0], '/usr/bin/accel-cmd');
    assert(['terminate username alice hard', 'terminate if sstp0 hard'].includes(call.args[1]));
  }
  commandOutput = 'command unknown\r\n';
  const beforeFailedDelete = authContents;
  assert.throws(() => realSstp.removeUser('alice'));
  assert.equal(authContents, beforeFailedDelete);
  assert.equal(installs, 0);
  commandOutput = '';
  assert.equal(realSstp.removeUser('alice').ok, true);
  assert(!authContents.includes('alice'));
  assert.equal(installs, 1);
  const beforeInvalidCommand = commandCount;
  assert.throws(() => realSstp.disconnectUser(['alice']));
  assert.throws(() => realSstp.disconnectSession('sstp0; touch /tmp/unsafe'));
  assert.equal(commandCount, beforeInvalidCommand);
  console.log('PASS SSTP API: auth, cache, settings, expiry/quota, block/error, create/reuse/duplicate/types, delete, CLI output');
}
run().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));

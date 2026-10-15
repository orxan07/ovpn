// Focused deferred-response regression; no browser, networking or system mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.SSTP_TEST_ROOT || path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).filter(script => script.trim());
inline.forEach(script => new vm.Script(script));
const source = inline.find(script => script.includes('async function showSstpCred('));
function extract(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Cannot locate ${start}`);
  return source.slice(first, last);
}
const functions = extract('    async function showSstpCred(name)', '    function copySstpCred()');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(api) {
  const elements = {
    sstpCredModal: { style: { display: 'none' } },
    sstpCredBody: { innerHTML: '', textContent: '' },
  };
  const context = vm.createContext({
    TOKEN: 'original', sstpCredText: '', api,
    document: { getElementById: id => elements[id] },
    esc: value => String(value), alert: message => { throw Error(message); },
  });
  vm.runInContext(functions, context);
  return { context, elements };
}
function assertCleared(test) {
  assert.equal(test.elements.sstpCredModal.style.display, 'none');
  assert.equal(test.elements.sstpCredBody.innerHTML, '');
  assert.equal(test.context.sstpCredText, '');
}
(async () => {
  const credentials = { name: 'alice', password: 'private-secret', server: 'vpn.example', port: 443 };
  // Request begins under a valid token, but completes after logout.
  const response = deferred();
  let test = fixture(() => response.promise);
  let pending = test.context.showSstpCred('alice');
  test.context.TOKEN = null;
  test.context.closeSstpCred();
  response.resolve(credentials);
  await pending;
  assertCleared(test);

  // Fallback status lookup is also asynchronous and must not reopen credentials.
  const status = deferred();
  test = fixture(() => status.promise);
  pending = test.context.showSstpCredFromObject({ name: 'alice', password: 'private-secret' });
  test.context.TOKEN = null;
  test.context.closeSstpCred();
  status.resolve({ publicHost: 'vpn.example', port: 443 });
  await pending;
  assertCleared(test);

  // An old response is also discarded if another account/token signs in.
  test = fixture(() => Promise.resolve({}));
  test.context.TOKEN = 'replacement';
  await test.context.showSstpCredFromObject(credentials, 'original');
  assertCleared(test);
  test.context.TOKEN = null;
  await test.context.showSstpCredFromObject(credentials);
  assertCleared(test);

  // Positive control ensures the guards do not suppress a valid current request.
  test = fixture(() => Promise.resolve(credentials));
  await test.context.showSstpCred('alice');
  assert.equal(test.elements.sstpCredModal.style.display, 'flex');
  assert(test.context.sstpCredText.includes('private-secret'));
  console.log('PASS credential/logout races, stale/null tokens, positive control; inline JS compiles');
})().catch(error => { console.error(error); process.exitCode = 1; });

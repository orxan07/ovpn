const assert = require('node:assert/strict');
const { build, normalize, gateway, validateState, SEED } = require('../server/sstp-routing');
const auth = require('../server/sstp-auth');
const previous = structuredClone(SEED);
const input = { ...structuredClone(SEED), profiles: [{ id: 'kids', name: 'Дети', groups: ['chatgpt'], users: ['child'] }] };
const raw = '# accounts\nchild * "secret123" * # child\nparent * "parent123" *\n';
const config = {
  outbounds: [{ tag: 'direct' }, { tag: 'outline' }],
  route: { rules: [{ port: 53, action: 'hijack-dns' }, { action: 'sniff' }, { domain_suffix: ['instagram.com'], action: 'route', outbound: 'outline' }], final: 'outline' },
  dns: { servers: [{ tag: 'dns-local' }, { tag: 'dns-proxy' }], rules: [{ action: 'route', server: 'dns-local' }] },
};
const plan = build(input, previous, raw, config);
assert.equal(plan.next.bindings[0].ip, '10.27.0.160');
assert.equal(auth.find(plan.secrets, 'child').ip, '10.27.0.160');
assert.ok(plan.secrets.includes(' # child'));
assert.equal(auth.find(plan.secrets, 'parent').ip, '*');
assert.deepEqual(plan.config.route.rules.slice(0, 2), config.route.rules.slice(0, 2));
assert.equal(plan.config.route.rules[2].outbound, 'outline');
assert.equal(plan.config.route.rules[3].outbound, 'direct');
assert.equal(plan.config.route.rules[4].domain_suffix[0], 'instagram.com');
assert.deepEqual(plan.config.route.rules[2].source_ip_cidr, ['10.27.0.160/32']);
assert.equal(plan.config.dns.rules[0].server, 'dns-proxy');
assert.equal(plan.config.dns.rules[1].server, 'dns-local');
assert.equal(plan.config.dns.independent_cache, true);
assert.equal(config.route.rules.length, 3);
const blocked = auth.change(raw, 'child', { blocked: true });
assert.equal(auth.find(build(input, previous, blocked, config).secrets, 'child').blocked, true);
const again = build({ ...input, revision: 1 }, plan.next, plan.secrets, plan.config);
assert.deepEqual(again.next.bindings, plan.next.bindings);
assert.equal(again.config.route.rules.length, plan.config.route.rules.length);
const removed = build({ ...input, revision: 1, profiles: [] }, plan.next, plan.secrets, plan.config);
assert.equal(removed.secrets, raw);
assert.deepEqual(removed.config, config);
assert.equal(build(input, previous, raw, config, [{ ip: '10.27.0.160' }]).next.bindings[0].ip, '10.27.0.161');
assert.throws(() => build(input, plan.next, plan.secrets, config), /вне панели/);
assert.throws(() => normalize({ ...input, groups: [{ id: 'bad', name: 'Bad', domains: ['https://example.com'] }] }));
assert.throws(() => normalize({ ...input, profiles: [...input.profiles, { id: 'other', name: 'Other', groups: [], users: ['child'] }] }));
assert.throws(() => normalize({ ...input, groups: [] }));
const conf = '[ppp]\nmtu=1400\n[chap-secrets]\nchap-secrets=/etc/accel-ppp/chap-secrets\n[cli]\ntcp=127.0.0.1:2001\n';
const fixed = gateway(conf);
assert.ok(fixed.includes('[chap-secrets]\ngw-ip-address=10.27.0.1\n'));
assert.equal(gateway(fixed), fixed);
assert.throws(() => gateway(fixed.replace('gw-ip-address=10.27.0.1', 'gw-ip-address=10.99.0.1')));
assert.throws(() => gateway('[ppp]\nmtu=1400\n'));
assert.throws(() => gateway(fixed.replace('[cli]', 'gw-ip-address=10.99.0.1\n[cli]')));
assert.throws(() => gateway(fixed + '[chap-secrets]\n'));
for (const mutate of [
  state => { delete state.dnsCacheOriginal; },
  state => { state.bindings.push({ ...state.bindings[0] }); },
  state => { state.bindings[0].ip = '10.27.0.11'; },
  state => { state.profiles[0].users = []; },
  state => { state.managedRoutes[0].source_ip_cidr = ['10.27.0.11/32']; },
]) {
  const state = structuredClone(plan.next); mutate(state);
  assert.throws(() => validateState(state), /Повреждён/);
}
console.log('PASS SSTP routing: isolation, rule order, static addresses, rollback plan, validation, gateway');

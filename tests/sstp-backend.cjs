const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');

const root = path.join(process.env.SSTP_TEST_ROOT || path.resolve(__dirname, '..'), 'server') + path.sep;
 const auth=require(root+'sstp-auth'),{createMonitor}=require(root+'sstp-monitor'),{parseActivity}=require(root+'sstp-activity');

let count=0;
function test(name,fn){try{fn();
console.log('PASS',name);
count++}catch(e){console.error('FAIL',name,e.stack);
process.exitCode=1}}
const raw='# comment\n  "bob"\tserver\t"pa \\"ss"\t10.0.0.1\tcustom # tail\nother * secret *\n';

test('auth preserves original block/unblock and unrelated syntax',()=>{assert.equal(auth.change(auth.change(raw,'bob',{blocked:true}),'bob',{blocked:false}),raw);
const changed=auth.change(auth.change(raw,'bob',{blocked:true}),'bob',{password:'new "pass\\'});
assert.equal(auth.find(changed,'bob').blocked,true);
assert.equal(auth.find(changed,'bob').password,'new "pass\\');
assert.ok(auth.change(changed,'bob',{blocked:false}).includes('\t10.0.0.1\tcustom # tail'));
assert.throws(()=>auth.change('bob * a *\nbob * b *','bob',{blocked:true}));
assert.throws(()=>auth.append(raw,'bob','x'));
for(const name of ['__proto__','constructor']) assert.equal(auth.find(auth.append('',name,'pw'),name).name,name)});

const dir=fs.mkdtempSync(path.join(os.tmpdir(), 'sstp-check-'));
let now=Date.parse('2026-10-14T20:59:55Z'),sid='1',sessions=true,fail=false,up=100,down=200;
const file=path.join(dir,'monitor.json');
const opts={file,now:()=>now,getSessions:()=>{if(fail)throw Error('offline');
return sessions?[{sid,ifname:'sstp0',username:'bob',ip:'10.0.0.1'}]:[]},readCounters:()=>({upload:up,download:down}),getUsers:()=>[{name:'bob',blocked:false}],blockUser:()=>{}};
let m=createMonitor(opts);
const client=()=>m.getClient({name:'bob'});

test('5s rates, Moscow day, reset and reconnect accounting',()=>{m.sample();
assert.equal(client().uploadBps,null);
now+=5000;
up+=50;
down+=100;
m.sample();
assert.equal(client().upload,50);
assert.equal(client().download,100);
assert.equal(client().uploadBps,10);
assert.equal(client().downloadBps,20);
assert.deepEqual(client().today,{upload:50,download:100});
assert.ok(client().days['2026-10-15']);
now+=5000;
up=10;
down=20;
m.sample();
assert.equal(client().upload,50);
assert.equal(client().uploadBps,null);
sid='2';
now+=5000;
up=300;
down=500;
m.sample();
assert.equal(client().upload,50);
assert.equal(client().uploadBps,null);
assert.equal(client().history.length,1);
assert.ok(client().history[0].endedAt);
});

test('restart uses persisted SID, no double count, sessions read failure preserves',()=>{m.save();
m=createMonitor(opts);
now+=5000;
up+=25;
down+=40;
m.sample();
assert.equal(client().upload,75);
assert.equal(client().download,140);
assert.equal(client().uploadBps,null);
fail=true;
assert.throws(()=>m.sample());
assert.equal(client().history.length,1);
fail=false;
sessions=false;
now+=5000;
m.sample();
assert.equal(client().history.length,2);
assert.equal(client().online,false);
m.save();
assert.equal(fs.statSync(file).mode&0o777,0o600);
assert.deepEqual(fs.readdirSync(dir),['monitor.json']);
});

test('special usernames have independent persisted state',()=>{for(const name of ['__proto__','constructor']){m.configure(name,{note:name});
assert.equal(m.getClient({name}).note,name)}m.save();
const next=createMonitor(opts);
assert.equal(next.getClient({name:'__proto__'}).note,'__proto__')});

test('corrupt file fails closed without overwrite',()=>{const f=path.join(dir,'corrupt');
fs.writeFileSync(f,'broken');
assert.throws(()=>createMonitor({...opts,file:f}));
assert.equal(fs.readFileSync(f,'utf8'),'broken')});

test('quota and expiry enforced on immediate start tick',()=>{let blocked=[];
const q=createMonitor({...opts,file:path.join(dir,'quota'),getSessions:()=>[],getUsers:()=>[{name:'expired',blocked:false},{name:'quota',blocked:false}],blockUser:(...args)=>blocked.push(args)});
q.configure('expired',{expiresAt:new Date(now-1000).toISOString()});
q.configure('quota',{limitGb:1});
let saved=JSON.parse(fs.readFileSync(path.join(dir,'quota')));
saved.users.quota.upload=1024**3;
fs.writeFileSync(path.join(dir,'quota'),JSON.stringify(saved));
const q2=createMonitor({...opts,file:path.join(dir,'quota'),getSessions:()=>[],getUsers:()=>[{name:'expired',blocked:false},{name:'quota',blocked:false}],blockUser:(...args)=>blocked.push(args)});
q2.start();
q2.stop();
assert.deepEqual(blocked,[['expired',true],['quota',true]])});

test('activity isolates interleaved IDs and observedAt, emits no secrets',()=>{const t=100000;
const line=(id,msg,at=t)=>JSON.stringify({__REALTIME_TIMESTAMP:at*1000,MESSAGE:`[${id} 0ms] ${msg}`,PASSWORD:'secret'});
const rows=[line(1,'inbound/tun[tun-in]: inbound connection from 10.0.0.1:123'),line(2,'inbound/tun[tun-in]: inbound connection from 10.0.0.2:123'),line(2,'outbound/direct[direct]: outbound connection to private.example:443'),line(1,'sniffed protocol: tls, domain: good.example'),line(1,'outbound/direct[direct]: outbound connection to good.example:443'),line(3,'inbound/tun[tun-in]: inbound connection from 10.0.0.1:123',t-1),line(3,'outbound/direct[direct]: outbound connection to stale.example:443',t-1)].join('\n');
const result=parseActivity(rows,[{ip:'10.0.0.1',observedAt:t}],t-100);
assert.equal(result.length,1);
assert.equal(result[0].destination,'good.example:443');
assert.ok(!JSON.stringify(result).includes('secret'));
assert.ok(!JSON.stringify(result).includes('private.example'));
assert.ok(!JSON.stringify(result).includes('stale.example'))});



// Corrupt persisted data must never be silently normalized or overwritten.
test('structural corruption fails closed and preserves exact file bytes', () => {
  const valid = JSON.parse(fs.readFileSync(file, 'utf8'));

  const cases = [
    state => { state.users = [];
 },
    state => { state.active = [];
 },
    state => { state.users.bob.upload = -1;
 },
    state => { delete state.users.bob.download;
 },
    state => { state.users.bob.days['2026-10-15'].download = -1;
 },
    state => { state.users.bob.history[0].upload = -1;
 },
    state => { delete state.users.bob.history[0].observedAt;
 },
    state => { state.active.bad = { username: 'bob', ifname: 'sstp0', sid: '1' };
 },
    state => {
      state.active.bad = { username: 'bob', ifname: 'sstp0', sid: '1',
        upload: -1, download: 0, uploadTracked: 0, downloadTracked: 0,
        observedAt: now, lastSeen: now };

    },
  ];

  cases.forEach((mutate, index) => {
    const state = structuredClone(valid);

    mutate(state);

    const corruptFile = path.join(dir, `structural-${index}.json`);

    const original = JSON.stringify(state, null, 2) + '\n';

    fs.writeFileSync(corruptFile, original);

    assert.equal(fs.readFileSync(corruptFile, 'utf8'), original);

    assert.throws(() => createMonitor({ ...opts, file: corruptFile }), /повреждён/);

    assert.equal(fs.readFileSync(corruptFile, 'utf8'), original);

  });

});


test('reused inbound connection ID cannot inherit another client target', () => {
  const timestamp = 200000;

  const line = message => JSON.stringify({
    __REALTIME_TIMESTAMP: timestamp * 1000,
    MESSAGE: `[42 0ms] ${message}`,
  });

  const raw = [
    line('inbound/tun[tun-in]: inbound connection from 10.0.0.2:123'),
    line('outbound/direct[direct]: outbound connection to other-client.example:443'),
    line('sniffed protocol: tls, domain: other-client.example'),
    line('inbound/tun[tun-in]: inbound connection from 10.0.0.1:456'),
  ];

  const sessions = [{ ip: '10.0.0.1', observedAt: timestamp }];

  assert.deepEqual(parseActivity(raw.join('\n'), sessions, timestamp), []);

  raw.push(line('outbound/direct[direct]: outbound connection to own.example:443'));

  const entries = parseActivity(raw.join('\n'), sessions, timestamp);

  assert.equal(entries.length, 1);

  assert.equal(entries[0].destination, 'own.example:443');

  assert.equal(entries[0].domain, undefined);

  assert.ok(!JSON.stringify(entries).includes('other-client'));

});

test('colored sing-box logs retain client correlation and clean destinations', () => {
  const timestamp = 200000;
  const line = (id, message) => JSON.stringify({
    __REALTIME_TIMESTAMP: timestamp * 1000,
    MESSAGE: `\x1b[32mINFO\x1b[0m[123] [\x1b[38;5;195m${id}\x1b[0m 5.0s] ${message}`,
  });
  const raw = [
    line(42, 'inbound/tun[tun-in]: inbound connection from 10.0.0.1:456'),
    line(43, 'inbound/tun[tun-in]: inbound connection from 10.0.0.2:123'),
    line(43, 'outbound/direct[direct]: outbound connection to other-client.example:443'),
    line(42, 'sniffed protocol: tls, domain: \x1b[36mwww.instagram.com\x1b[0m'),
    line(42, 'outbound/shadowsocks[\x1b[36moutline\x1b[0m]: outbound connection to \x1b[36m157.240.0.1:443\x1b[0m'),
  ].join('\n');
  const entries = parseActivity(raw, [{ ip: '10.0.0.1', observedAt: timestamp }], timestamp);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].destination, '157.240.0.1:443');
  assert.equal(entries[0].domain, 'www.instagram.com');
  assert.equal(entries[0].outbound, 'outline');
  assert.equal(entries[0].protocol, 'TCP');
  assert.ok(!JSON.stringify(entries).includes('other-client'));
  assert.ok(!JSON.stringify(entries).includes('\\u001b'));
});

console.log('Completed', count, 'tests');

fs.rmSync(dir, { recursive: true, force: true });

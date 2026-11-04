/*
 * Security tests for backend/Code.gs.
 * Runs the real backend code in Node with fake versions of Google's services.
 * Usage: node tests/security.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// ---------- fake Google services ----------
function makeEnv() {
  const props = new Map();
  const cache = new Map();
  const drive = { files: new Map(), nextId: 1 };
  const resumable = new Map();
  let fetchCount = 0;

  const toSigned = (buf) => Array.from(buf, (x) => (x > 127 ? x - 256 : x));
  const env = {
    console: { log() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, String(v)); },
    }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => { cache.set(k, String(v)); },
      remove: (k) => { cache.delete(k); },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a, s) => toSigned(crypto.createHash('sha256').update(s, 'utf8').digest()),
      base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
      getUuid: () => crypto.randomUUID(),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      formatDate: () => '20261210_183000',
      parseDate: (s) => new Date(s.replace(' ', 'T') + ':00+05:30'),
    },
    ScriptApp: { getOAuthToken: () => 'SECRET-OWNER-TOKEN' },
    Drive: { Files: { create: (res, blob) => {
      const id = 'drv' + drive.nextId++;
      drive.files.set(id, { ...res, bytes: blob ? Buffer.from(blob.bytes.map((x) => x & 255)) : null, mimeType: res.mimeType || (blob && blob.mime) });
      return { id };
    } } },
    UrlFetchApp: { fetch: (url, opt) => {
      fetchCount++;
      const mk = (code, headers, text = '') => ({ getResponseCode: () => code, getAllHeaders: () => headers, getContentText: () => text });
      if (url.startsWith('https://www.googleapis.com/upload/')) {
        const meta = JSON.parse(opt.payload);
        const u = 'https://upload.example/session/' + crypto.randomUUID();
        resumable.set(u, { meta, mime: opt.headers['X-Upload-Content-Type'], size: Number(opt.headers['X-Upload-Content-Length']), parts: [] });
        return mk(200, { Location: u });
      }
      const r = resumable.get(url);
      if (!r) return mk(404, {});
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(opt.headers['Content-Range']);
      const start = +m[1], have = r.parts.reduce((a, p) => a + p.length, 0);
      if (start !== have) return mk(400, {}, 'bad offset');
      r.parts.push(Buffer.from(opt.payload.map((x) => x & 255)));
      const now = have + opt.payload.length;
      if (now >= r.size) {
        const id = 'drv' + drive.nextId++;
        drive.files.set(id, { ...r.meta, mimeType: r.mime, bytes: Buffer.concat(r.parts) });
        return mk(200, {});
      }
      return mk(308, { Range: 'bytes=0-' + (now - 1) });
    } },
  };
  return { env, props, cache, drive, getFetchCount: () => fetchCount };
}

function load(settings) {
  const st = makeEnv();
  let src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
  if (settings) src = src.replace(/const SETUP = \{[\s\S]*?\n\};/, 'const SETUP = ' + JSON.stringify(settings) + ';');
  // smaller limits so tests run fast
  src = src.replace('singleShotMaxBytes: 10 * MB', 'singleShotMaxBytes: 256 * 1024')
           .replace('chunkBytes: 10 * MB', 'chunkBytes: 256 * 1024')
           .replace('maxBytesPerGuestPerEvent: 8 * GB', 'maxBytesPerGuestPerEvent: 3 * MB')
           .replace('maxPhotoBytes: 60 * MB', 'maxPhotoBytes: 2 * MB');
  src += '\n;globalThis.__api = { doPost, setup, newLinkFor, Storage };';
  const ctx = vm.createContext({ ...st.env });
  vm.runInContext(src, ctx);
  return { ...st, api: ctx.__api, ctx };
}

// capture links printed by setup()
function runSetup(t) {
  let out = '';
  t.ctx.console = { log: (s) => { out += s; }, error() {} };
  t.api.setup();
  const links = {};
  for (const m of out.matchAll(/\?e=([a-z0-9-]+)&k=([A-Za-z0-9]+)/g)) links[m[1]] = m[2];
  return links;
}

const settings = {
  siteUrl: 'https://example.test/', rootFolderName: 'Wedding Photos', timeZone: 'Asia/Kolkata',
  events: [
    { id: 'sangeet', title: 'Sangeet', opens: '2020-01-01 00:00', closes: '2099-01-01 00:00', pin: '' },
    { id: 'wedding', title: 'Wedding', opens: '2020-01-01 00:00', closes: '2099-01-01 00:00', pin: '4821' },
    { id: 'future', title: 'Future', opens: '2098-01-01 00:00', closes: '2099-01-01 00:00', pin: '' },
    { id: 'past', title: 'Past', opens: '2020-01-01 00:00', closes: '2021-01-01 00:00', pin: '' },
  ],
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  →  ' + JSON.stringify(detail) : '')); }
}

// realistic file headers
const jpegWithGps = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40]), Buffer.from('Exif\0\0'),
  Buffer.from('GPSLatitude=16.5062N GPSLongitude=80.6480E'), crypto.randomBytes(5000), Buffer.from([0xff, 0xd9]),
]);
const mp4Header = (size) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(24, 0); b.write('ftyp', 4); b.write('isom', 8); b.writeUInt32BE(512, 12); b.write('isom', 16); b.write('mp41', 20);
  crypto.randomBytes(size - 24).copy(b, 24);
  return b;
};
const heic = (() => { const b = Buffer.alloc(3000); b.writeUInt32BE(24, 0); b.write('ftyp', 4); b.write('heic', 8); b.write('mif1', 16); b.write('heic', 20); return b; })();

// ===================================================================
const t = load(settings);
const links = runSetup(t);
let dev = 'device' + crypto.randomBytes(8).toString('hex');
const call = (body) => JSON.parse(t.api.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const S = (extra) => ({ event: 'sangeet', key: links.sangeet, device: dev, ...extra });

console.log('\nSetup');
check('setup printed a secret link for every event', Object.keys(links).length === 4, links);
check('secret keys are long (≥48 chars)', links.sangeet && links.sangeet.length >= 48);
check('keys are not stored in plain text', ![...t.props.values()].some((v) => v.includes(links.sangeet)));

console.log('\n1. Access without the right QR code');
check('wrong key is refused', call(S({ action: 'info', key: 'A'.repeat(48) })).code === 'ACCESS');
check('missing key is refused', call(S({ action: 'info', key: undefined })).code === 'ACCESS');
check("one event's key can't open another event", call({ ...S({ action: 'info' }), event: 'wedding' }).code === 'ACCESS');
check('unknown event gives the same answer as wrong key', call(S({ action: 'info', event: 'nope' })).code === 'ACCESS');
check('correct key works', call(S({ action: 'info' })).ok === true);
check('upload before opening time is refused', call({ action: 'check', event: 'future', key: links.future, device: dev, name: 'Ravi' }).code === 'NOT_OPEN');
check('upload after closing time is refused', call({ action: 'check', event: 'past', key: links.past, device: dev, name: 'Ravi' }).code === 'CLOSED');

console.log('\n2. PIN');
const W = (extra) => ({ event: 'wedding', key: links.wedding, device: dev, ...extra });
check('page learns a PIN is needed', call(W({ action: 'info' })).requiresPin === true);
check('missing PIN is refused', call(W({ action: 'check', name: 'Ravi' })).code === 'PIN');
check('wrong PIN is refused', call(W({ action: 'check', name: 'Ravi', pin: '1111' })).code === 'PIN');
check('right PIN works', call(W({ action: 'check', name: 'Ravi', pin: '4821' })).ok === true);
let locked = false;
for (let i = 0; i < 40; i++) { dev = 'brute' + i + crypto.randomBytes(8).toString('hex'); const r = call(W({ action: 'check', name: 'Ravi', pin: String(1000 + i) })); if (r.code === 'RATE_LIMITED') { locked = true; break; } }
check('PIN guessing gets locked out even when switching devices', locked);
dev = 'device' + crypto.randomBytes(8).toString('hex');
t.cache.delete('pinfail:wedding'); // lockout expires after 10 min

console.log('\n3. Guest names');
for (const evil of ['../../etc', 'a/b', '<script>alert(1)</script>', "Robert'); DROP TABLE", 'x', ' ', '.hidden', 'A'.repeat(41), '12345', 'name\u0000null']) {
  check('rejects name ' + JSON.stringify(evil).slice(0, 30), call(S({ action: 'check', name: evil })).code === 'BAD_NAME');
}
check('accepts Telugu name', call(S({ action: 'check', name: 'రవి కుమార్' })).ok === true);
check('accepts Hindi name', call(S({ action: 'check', name: 'सीता देवी' })).ok === true);
check("accepts names like D'Souza (Vizag)", call(S({ action: 'check', name: "Anil D'Souza (Vizag)" })).ok === true);

console.log('\n4. "Name already exists" flow');
check('new name does not exist yet', call(S({ action: 'check', name: 'Ravi Kumar' })).exists === false);
const up = (name, buf, extra) => call(S({ action: 'upload', name, size: buf.length, data: buf.toString('base64'), ...extra }));
check('photo upload succeeds', up('Ravi Kumar', jpegWithGps).ok === true);
check('name now exists', call(S({ action: 'check', name: 'Ravi Kumar' })).exists === true);
check('check is case- and space-insensitive', call(S({ action: 'check', name: '  ravi   KUMAR ' })).exists === true);
up('ravi kumar', jpegWithGps);
const folders = [...t.drive.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder' && /ravi/i.test(f.name));
check('same guest always lands in one folder', folders.length === 1, folders.map((f) => f.name));
check('same name at another event is a separate folder', call(W({ action: 'check', name: 'Ravi Kumar', pin: '4821' })).exists === false);
const resp = JSON.stringify(call(S({ action: 'check', name: 'Ravi Kumar' })));
check('responses never reveal Drive ids or other guests', !/drv\d|folder|parents/.test(resp), resp);

console.log('\n5. File contents');
const stored = [...t.drive.files.values()].find((f) => f.bytes && f.mimeType === 'image/jpeg');
check('photo stored byte-for-byte (GPS + EXIF kept)', stored && stored.bytes.equals(jpegWithGps));
check('stored file is renamed, guest name + .jpg', stored && /^Ravi Kumar_\d{8}_\d{6}_[a-f0-9]{6}\.jpg$/.test(stored.name), stored && stored.name);
check('HEIC (iPhone) accepted', up('Ravi Kumar', heic).ok === true);
check('text file pretending to be photo refused', up('Ravi Kumar', Buffer.from('<?php system($_GET["c"]); ?>' + 'x'.repeat(100))).code === 'UNSUPPORTED');
check('HTML file refused', up('Ravi Kumar', Buffer.from('<!doctype html><script>steal()</script>' + ' '.repeat(100))).code === 'UNSUPPORTED');
check('Windows program (.exe) refused', up('Ravi Kumar', Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(500)])).code === 'UNSUPPORTED');
check('ZIP refused', up('Ravi Kumar', Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(500)])).code === 'UNSUPPORTED');
check('PDF refused', up('Ravi Kumar', Buffer.from('%PDF-1.7' + 'x'.repeat(200))).code === 'UNSUPPORTED');
check('fake ftyp with junk brand refused', (() => { const b = Buffer.alloc(200); b.writeUInt32BE(24, 0); b.write('ftyp', 4); b.write('evil', 8); return up('Ravi Kumar', b).code === 'UNSUPPORTED'; })());
check('declared size ≠ real size refused', up('Ravi Kumar', jpegWithGps, { size: jpegWithGps.length + 10 }).ok === false);
check('broken base64 refused', call(S({ action: 'upload', name: 'Ravi Kumar', size: 20, data: '$$$$not-base64$$$$$$' })).code === 'BAD_FILE');
check('oversized photo refused', up('Ravi Kumar', Buffer.concat([jpegWithGps, Buffer.alloc(3 * 1024 * 1024)]), {}).ok === false);
check('extra fields like folderId are ignored', (() => { const n = t.drive.files.size; up('Ravi Kumar', jpegWithGps, { folderId: 'drv1', parents: ['drv1'], fileName: '../../x.html' }); const last = [...t.drive.files.values()].pop(); return t.drive.files.size === n + 1 && /\.jpg$/.test(last.name) && last.parents[0] !== 'drv1'; })());

console.log('\n6. Big video (chunked)');
const vid = mp4Header(256 * 1024 * 3 + 1234);
const C = 256 * 1024;
const fetchesBefore = t.getFetchCount();
let r = call(S({ action: 'begin', name: 'Sita', size: vid.length, data: vid.subarray(0, C).toString('base64') }));
check('video upload starts', r.ok && /^[a-f0-9]{32}$/.test(r.session), r);
check('private Drive upload URL never sent to browser', !JSON.stringify(r).includes('upload.example'));
const sess = r.session;
const other = call({ ...S({ action: 'chunk', session: sess, offset: C, data: vid.subarray(C, 2 * C).toString('base64') }), device: 'otherdevice' + crypto.randomBytes(8).toString('hex') });
check('another phone cannot hijack the upload session', other.code === 'SESSION_EXPIRED');
const wrongOff = call(S({ action: 'chunk', session: sess, offset: 5, data: vid.subarray(C, 2 * C).toString('base64') }));
check('wrong position is answered with the right one (resume)', wrongOff.code === 'OFFSET' && wrongOff.expected === C, wrongOff);
let off = C;
while (off < vid.length) {
  r = call(S({ action: 'chunk', session: sess, offset: off, data: vid.subarray(off, Math.min(off + C, vid.length)).toString('base64') }));
  if (!r.ok) break; off = r.received;
}
check('video finishes', r.ok && r.done, r);
const storedVid = [...t.drive.files.values()].find((f) => f.mimeType === 'video/mp4');
check('video stored byte-for-byte as .mp4', storedVid && storedVid.bytes.equals(vid) && /\.mp4$/.test(storedVid.name));
check('owner token never in any response', !JSON.stringify(r).includes('SECRET-OWNER-TOKEN'));
check('finished session cannot be reused', call(S({ action: 'chunk', session: sess, offset: 0, data: vid.subarray(0, C).toString('base64') })).code === 'SESSION_EXPIRED');
check('Drive calls are economical (1 per chunk + 1 start)', t.getFetchCount() - fetchesBefore === 5, t.getFetchCount() - fetchesBefore);
const fakeVid = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(C * 2)]);
check('big non-video file refused at first chunk', call(S({ action: 'begin', name: 'Sita', size: fakeVid.length, data: fakeVid.subarray(0, C).toString('base64') })).code === 'UNSUPPORTED');

console.log('\n7. Limits and flooding');
let quota = false;
for (let i = 0; i < 20; i++) { const big = Buffer.concat([jpegWithGps, crypto.randomBytes(200 * 1024)]); const q = up('Greedy Guest', big); if (q.code === 'QUOTA') { quota = true; break; } }
check('per-guest storage cap enforced', quota);
const flood = 'flood' + crypto.randomBytes(8).toString('hex');
let limited = false;
for (let i = 0; i < 120; i++) { const q = call({ action: 'info', event: 'sangeet', key: links.sangeet, device: flood }); if (q.code === 'RATE_LIMITED') { limited = true; break; } }
check('one phone flooding requests gets slowed down', limited);
check('missing/invalid device id refused', call({ action: 'info', event: 'sangeet', key: links.sangeet }).code === 'BAD_REQUEST');

console.log('\n8. Junk requests');
check('not JSON', JSON.parse(t.api.doPost({ postData: { contents: 'hello' } }).text).code === 'BAD_REQUEST');
check('empty body', JSON.parse(t.api.doPost({}).text).code === 'BAD_REQUEST');
check('unknown action (e.g. "list")', call(S({ action: 'list' })).code === 'BAD_REQUEST');
check('prototype trick action', call(S({ action: '__proto__' })).code === 'BAD_REQUEST');
check('"delete" action does not exist', call(S({ action: 'delete', name: 'Ravi Kumar' })).code === 'BAD_REQUEST');
check('array body', JSON.parse(t.api.doPost({ postData: { contents: '[1,2]' } }).text).code === 'BAD_REQUEST');
check('huge body refused before parsing', JSON.parse(t.api.doPost({ postData: { contents: 'x'.repeat(20 * 1024 * 1024) } }).text).code === 'BAD_REQUEST');

console.log('\n9. Link rotation');
let out = ''; t.ctx.console = { log: (s) => { out += s; }, error() {} };
t.api.newLinkFor('sangeet');
const newKey = /k=([A-Za-z0-9]+)/.exec(out)[1];
check('old QR stops working after newLinkFor()', call(S({ action: 'info' })).code === 'ACCESS');
check('new QR works', call(S({ action: 'info', key: newKey })).ok === true);
const before = JSON.stringify([...t.props.entries()].filter(([k]) => k === 'EVENTS'));
runSetup(t);
check('re-running setup keeps existing links', call(S({ action: 'info', key: newKey })).ok === true && before.length > 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

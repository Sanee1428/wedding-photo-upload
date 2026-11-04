/**
 * Wedding Photo Upload — backend (Google Apps Script)
 * ---------------------------------------------------
 * Guests pick photos/videos on the upload page; this script stores them in
 * Google Drive as:  <Root folder> / <Event> / <Guest name> / file
 *
 * Security summary (details in README.md):
 *  - Every request needs the event's secret key from the QR code (+ optional PIN).
 *  - Uploads only accepted inside each event's open/close window.
 *  - Upload-only API: nothing can be listed, viewed, downloaded or deleted.
 *  - File contents are checked (real photo/video signatures), files are renamed.
 *  - Guest names are cleaned before becoming folder names.
 *  - Size limits per file, per guest and per event; rate limits per device.
 *  - Your Google login never reaches the browser. The script only has access to
 *    files it created itself (drive.file scope), not the rest of your Drive.
 *  - Original bytes are stored untouched, so photo metadata (date, GPS) is kept.
 *
 * STORAGE IS SWAPPABLE: everything that talks to Google Drive lives in the
 * `Storage` object near the bottom. To move to another cloud later, replace
 * that object (or build a new backend with the same 5 actions — see README).
 */

// =====================================================================
// 1. SETTINGS YOU EDIT
// =====================================================================

const SETUP = {
  // Where the upload page is hosted (must end with /). Used to print QR links.
  siteUrl: 'https://YOUR-SITE.netlify.app/',

  // Top folder created in your Google Drive.
  rootFolderName: 'Wedding Photos',

  timeZone: 'Asia/Kolkata',

  // One entry per event = one QR code.
  //  id:     short code, lowercase letters/numbers/dashes (never change once printed)
  //  title:  folder name and what guests see
  //  opens / closes: upload window, 'YYYY-MM-DD HH:mm' in the time zone above
  //  pin:    optional extra code printed on table cards ('' = no PIN)
  events: [
    { id: 'haldi',     title: 'Haldi',     opens: '2026-12-01 00:00', closes: '2027-01-15 23:59', pin: '' },
    { id: 'mehendi',   title: 'Mehendi',   opens: '2026-12-01 00:00', closes: '2027-01-15 23:59', pin: '' },
    { id: 'sangeet',   title: 'Sangeet',   opens: '2026-12-01 00:00', closes: '2027-01-15 23:59', pin: '' },
    { id: 'wedding',   title: 'Wedding',   opens: '2026-12-01 00:00', closes: '2027-01-15 23:59', pin: '' },
    { id: 'reception', title: 'Reception', opens: '2026-12-01 00:00', closes: '2027-01-15 23:59', pin: '' },
  ],
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

const LIMITS = {
  maxPhotoBytes: 60 * MB,
  maxVideoBytes: 1 * GB,
  maxBytesPerGuestPerEvent: 8 * GB,
  maxBytesPerEvent: 150 * GB,
  maxRequestsPerDevicePerMinute: 90,
  maxPinFailuresPer10Min: 30,   // per event, across all devices
  // Files up to this size go in one request; bigger ones are sent in chunks.
  singleShotMaxBytes: 10 * MB,
  // Chunk size for big files. Must be a multiple of 256 KiB (Drive rule).
  chunkBytes: 10 * MB,
};

// =====================================================================
// 2. WEB ENTRY POINTS
// =====================================================================

function doGet() {
  return ContentService.createTextOutput('OK');
}

function doPost(e) {
  let res;
  try {
    const body = parseBody_(e);
    res = route_(body);
  } catch (err) {
    if (err && err.isApiError) {
      res = Object.assign({ ok: false, code: err.code, message: err.message }, err.extra || {});
    } else {
      console.error(err && err.stack ? err.stack : String(err)); // visible only to you
      res = { ok: false, code: 'SERVER', message: 'Something went wrong. Please try again.' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiError_(code, message, extra) {
  const e = new Error(message);
  e.isApiError = true;
  e.code = code;
  e.extra = extra;
  return e;
}

const MAX_BODY_CHARS = Math.ceil(Math.max(LIMITS.singleShotMaxBytes, LIMITS.chunkBytes) / 3) * 4 + 4096;

function parseBody_(e) {
  const raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  if (!raw || raw.length > MAX_BODY_CHARS) throw apiError_('BAD_REQUEST', 'Invalid request.');
  let body;
  try { body = JSON.parse(raw); } catch (x) { throw apiError_('BAD_REQUEST', 'Invalid request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError_('BAD_REQUEST', 'Invalid request.');
  return body;
}

const ACTIONS = {
  info:   { fn: actInfo_,   allowClosed: true },
  check:  { fn: actCheck_ },
  upload: { fn: actUpload_ },
  begin:  { fn: actBegin_ },
  chunk:  { fn: actChunk_ },
};

function route_(body) {
  const action = body.action;
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    throw apiError_('BAD_REQUEST', 'Invalid request.');
  }
  const device = body.device;
  if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(device)) {
    throw apiError_('BAD_REQUEST', 'Invalid request.');
  }
  rateLimit_(device);
  const spec = ACTIONS[action];
  const ev = authEvent_(body, !!spec.allowClosed);
  return spec.fn(body, ev, device);
}

// =====================================================================
// 3. ACTIONS (the whole public API — upload only, no reading)
// =====================================================================

function actInfo_(body, ev) {
  const now = Date.now();
  return {
    ok: true,
    title: ev.title,
    status: now < ev.opensAt ? 'not_open' : (now > ev.closesAt ? 'closed' : 'open'),
    requiresPin: !!ev.pinHash,
    limits: {
      maxPhotoBytes: LIMITS.maxPhotoBytes,
      maxVideoBytes: LIMITS.maxVideoBytes,
      singleShotMaxBytes: LIMITS.singleShotMaxBytes,
      chunkBytes: LIMITS.chunkBytes,
    },
  };
}

function actCheck_(body, ev) {
  const n = normalizeName_(body.name);
  return { ok: true, exists: !!lookupGuestFolder_(ev, n.key) };
}

/** Small file in one request. */
function actUpload_(body, ev) {
  const n = normalizeName_(body.name);
  const size = parseSize_(body.size, LIMITS.singleShotMaxBytes);
  const bytes = decodeData_(body.data, size);
  if (bytes.length !== size) throw apiError_('BAD_FILE', 'The file did not arrive complete. Please try again.');

  const type = detectType_(bytes);
  checkTypeSize_(type, size);
  checkQuota_(ev, n.key, size);

  const folderId = ensureGuestFolder_(ev, n);
  Storage.saveFile(folderId, makeFileName_(n.display, type.ext), type.mime, bytes);
  addUsage_(ev, n.key, size);
  return { ok: true };
}

/** Start a big file: the first chunk comes with this request. */
function actBegin_(body, ev, device) {
  const n = normalizeName_(body.name);
  const size = parseSize_(body.size, LIMITS.maxVideoBytes);
  if (size <= LIMITS.singleShotMaxBytes) throw apiError_('BAD_REQUEST', 'Invalid request.');
  const bytes = decodeData_(body.data, LIMITS.chunkBytes);
  if (bytes.length !== LIMITS.chunkBytes) throw apiError_('BAD_FILE', 'The file did not arrive complete. Please try again.');

  const type = detectType_(bytes);
  checkTypeSize_(type, size);
  checkQuota_(ev, n.key, size);

  const folderId = ensureGuestFolder_(ev, n);
  const url = Storage.beginLargeFile(folderId, makeFileName_(n.display, type.ext), type.mime, size);
  const received = Storage.putChunk(url, bytes, 0, size);

  const sessionId = randomToken_(32);
  const sess = { u: url, s: size, o: received, e: ev.id, g: n.key, d: device };
  CacheService.getScriptCache().put('up:' + sessionId, JSON.stringify(sess), 21600);
  return { ok: true, session: sessionId, received: received, done: received >= size };
}

/** Next chunk of a big file. */
function actChunk_(body, ev, device) {
  const sessionId = body.session;
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) throw apiError_('BAD_REQUEST', 'Invalid request.');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('up:' + sessionId);
  if (!raw) throw apiError_('SESSION_EXPIRED', 'This upload timed out. It will restart.');
  const sess = JSON.parse(raw);
  // A session only works for the same event and the same phone that started it.
  if (sess.e !== ev.id || sess.d !== device) throw apiError_('SESSION_EXPIRED', 'This upload timed out. It will restart.');

  const offset = body.offset;
  if (offset !== sess.o) throw apiError_('OFFSET', 'Resuming upload.', { expected: sess.o });

  const remaining = sess.s - sess.o;
  const expectedLen = Math.min(LIMITS.chunkBytes, remaining);
  const bytes = decodeData_(body.data, expectedLen);
  if (bytes.length !== expectedLen) throw apiError_('BAD_FILE', 'The file did not arrive complete. Please try again.');

  const received = Storage.putChunk(sess.u, bytes, sess.o, sess.s);
  const done = received >= sess.s;
  if (done) {
    cache.remove('up:' + sessionId);
    addUsage_(ev, sess.g, sess.s);
  } else {
    sess.o = received;
    cache.put('up:' + sessionId, JSON.stringify(sess), 21600);
  }
  return { ok: true, received: received, done: done };
}

// =====================================================================
// 4. SECURITY CHECKS
// =====================================================================

function loadEvents_() {
  const raw = PropertiesService.getScriptProperties().getProperty('EVENTS');
  return raw ? JSON.parse(raw) : [];
}

function authEvent_(body, allowClosed) {
  const denied = apiError_('ACCESS', "This QR code isn't valid. Please scan the code at the venue again.");
  const id = body.event, key = body.key;
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) throw denied;
  if (typeof key !== 'string' || !/^[A-Za-z0-9]{32,128}$/.test(key)) throw denied;

  const ev = loadEvents_().find(function (x) { return x.id === id; });
  // Same answer whether the event or the key is wrong.
  const keyOk = ev ? safeEqual_(sha256Hex_(ev.salt + ':' + key), ev.keyHash)
                   : safeEqual_(sha256Hex_('x:' + key), 'f'.repeat(64));
  if (!ev || !keyOk) throw denied;

  if (ev.pinHash && body.action !== 'info') {
    const cache = CacheService.getScriptCache();
    const failKey = 'pinfail:' + ev.id;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= LIMITS.maxPinFailuresPer10Min) {
      throw apiError_('RATE_LIMITED', 'Too many wrong PIN attempts. Please wait 10 minutes.');
    }
    const pin = body.pin;
    const pinOk = typeof pin === 'string' && /^[0-9]{3,12}$/.test(pin) &&
      safeEqual_(sha256Hex_(ev.salt + ':pin:' + pin), ev.pinHash);
    if (!pinOk) {
      cache.put(failKey, String(fails + 1), 600);
      throw apiError_('PIN', 'That PIN is not right. It is printed on the table card.');
    }
  }

  if (!allowClosed) {
    const now = Date.now();
    if (now < ev.opensAt) throw apiError_('NOT_OPEN', 'Uploads for ' + ev.title + ' have not opened yet.');
    if (now > ev.closesAt) throw apiError_('CLOSED', 'Uploads for ' + ev.title + ' are now closed. Thank you!');
  }
  return ev;
}

function rateLimit_(device) {
  const cache = CacheService.getScriptCache();
  const k = 'rl:' + device + ':' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), 120);
  if (n > LIMITS.maxRequestsPerDevicePerMinute) {
    throw apiError_('RATE_LIMITED', 'Slow down a little. Uploads will continue shortly.');
  }
}

/** Clean a guest name. Allows letters of any language (Telugu, Hindi…), digits, space . ' - ( ) */
function normalizeName_(raw) {
  const bad = apiError_('BAD_NAME', "Please enter your name using letters only (2–40 characters).");
  if (typeof raw !== 'string' || raw.length > 200) throw bad;
  const display = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (display.length < 2 || display.length > 40) throw bad;
  if (!/^[\p{L}\p{M}\p{N} .'()-]+$/u.test(display)) throw bad;
  if (!/\p{L}/u.test(display)) throw bad;
  if (/^[. ]|[. ]$/.test(display)) throw bad;
  return { display: display, key: display.toLowerCase() };
}

function parseSize_(v, max) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 12 || v > max) {
    throw apiError_('TOO_BIG', 'This file is too large to upload.');
  }
  return v;
}

function decodeData_(data, maxBytes) {
  if (typeof data !== 'string' || data.length === 0 ||
      data.length > Math.ceil(maxBytes / 3) * 4 || data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw apiError_('BAD_FILE', 'The file did not arrive complete. Please try again.');
  }
  return Utilities.base64Decode(data);
}

/**
 * Identify the file from its first bytes. The name/extension the phone
 * reports is ignored. Anything that is not a known photo or video is refused.
 */
function detectType_(bytes) {
  const b = function (i) { return i < bytes.length ? (bytes[i] & 0xff) : -1; };
  const ascii = function (from, len) {
    let s = '';
    for (let i = from; i < from + len; i++) { const c = b(i); if (c < 0) return ''; s += String.fromCharCode(c); }
    return s;
  };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { kind: 'photo', mime: 'image/jpeg', ext: 'jpg' };
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return { kind: 'photo', mime: 'image/png', ext: 'png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { kind: 'photo', mime: 'image/webp', ext: 'webp' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { kind: 'photo', mime: 'image/gif', ext: 'gif' };
  if (b(0) === 0x1a && b(1) === 0x45 && b(2) === 0xdf && b(3) === 0xa3) return { kind: 'video', mime: 'video/webm', ext: 'webm' };

  if (ascii(4, 4) === 'ftyp') {
    const boxSize = ((b(0) << 24) >>> 0) + (b(1) << 16) + (b(2) << 8) + b(3);
    if (boxSize < 16 || boxSize > 4096) throw unsupported_();
    const brand = ascii(8, 4);
    const compat = [];
    for (let i = 16; i + 4 <= boxSize && i + 4 <= bytes.length; i += 4) compat.push(ascii(i, 4));
    const all = [brand].concat(compat);
    const has = function (list) { return all.some(function (x) { return list.indexOf(x) >= 0; }); };
    if (has(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'])) return { kind: 'photo', mime: 'image/heic', ext: 'heic' };
    if (has(['avif', 'avis'])) return { kind: 'photo', mime: 'image/avif', ext: 'avif' };
    if (brand === 'mif1' || brand === 'msf1') return { kind: 'photo', mime: 'image/heif', ext: 'heif' };
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    if (/^3g[p2]/.test(brand)) return { kind: 'video', mime: 'video/3gpp', ext: '3gp' };
    if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'mmp4', 'dash', 'MSNV'].indexOf(brand) >= 0) {
      return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
    }
  }
  throw unsupported_();
}

function unsupported_() {
  return apiError_('UNSUPPORTED', 'Only photos and videos can be uploaded.');
}

function checkTypeSize_(type, size) {
  const max = type.kind === 'photo' ? LIMITS.maxPhotoBytes : LIMITS.maxVideoBytes;
  if (size > max) throw apiError_('TOO_BIG', 'This file is too large to upload.');
}

function checkQuota_(ev, nameKey, size) {
  const p = PropertiesService.getScriptProperties();
  const guest = Number(p.getProperty(usageGuestKey_(ev, nameKey)) || 0);
  const total = Number(p.getProperty('u:e:' + ev.id) || 0);
  if (guest + size > LIMITS.maxBytesPerGuestPerEvent) throw apiError_('QUOTA', 'You have reached the upload limit for this event. Thank you!');
  if (total + size > LIMITS.maxBytesPerEvent) throw apiError_('QUOTA', 'Uploads for this event are full. Please contact the family.');
}

function addUsage_(ev, nameKey, size) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const p = PropertiesService.getScriptProperties();
    const gk = usageGuestKey_(ev, nameKey), ek = 'u:e:' + ev.id;
    p.setProperty(gk, String(Number(p.getProperty(gk) || 0) + size));
    p.setProperty(ek, String(Number(p.getProperty(ek) || 0) + size));
  } finally { lock.releaseLock(); }
}

function usageGuestKey_(ev, nameKey) { return 'u:g:' + guestHash_(ev, nameKey); }
function guestHash_(ev, nameKey) { return sha256Hex_(ev.id + '\n' + nameKey).slice(0, 40); }

function lookupGuestFolder_(ev, nameKey) {
  return PropertiesService.getScriptProperties().getProperty('g:' + guestHash_(ev, nameKey));
}

function ensureGuestFolder_(ev, n) {
  const existing = lookupGuestFolder_(ev, n.key);
  if (existing) return existing;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const again = lookupGuestFolder_(ev, n.key); // another request may have just created it
    if (again) return again;
    const id = Storage.createFolder(ev.folderId, n.display);
    PropertiesService.getScriptProperties().setProperty('g:' + guestHash_(ev, n.key), id);
    return id;
  } finally { lock.releaseLock(); }
}

function makeFileName_(display, ext) {
  const stamp = Utilities.formatDate(new Date(), SETUP.timeZone, 'yyyyMMdd_HHmmss');
  return display + '_' + stamp + '_' + randomToken_(6) + '.' + ext;
}

// ---------- small helpers ----------

function sha256Hex_(s) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return d.map(function (x) { return ('0' + (x & 0xff).toString(16)).slice(-2); }).join('');
}

/** Compare two strings in constant time (no timing hints for attackers). */
function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

function randomToken_(len) {
  let s = '';
  while (s.length < len) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, len).toLowerCase();
}

// =====================================================================
// 5. STORAGE ADAPTER — Google Drive
//    Replace this object to use a different cloud. It needs 4 functions.
// =====================================================================

const DRIVE_FOLDER = 'application/vnd.google-apps.folder';

const Storage = {
  /** Create a folder inside parentId; return its id. */
  createFolder: function (parentId, name) {
    const f = Drive.Files.create({ name: name, mimeType: DRIVE_FOLDER, parents: parentId ? [parentId] : [] });
    return f.id;
  },

  /** Save a small file in one go. */
  saveFile: function (folderId, name, mime, bytes) {
    const blob = Utilities.newBlob(bytes, mime, name);
    Drive.Files.create({ name: name, parents: [folderId] }, blob);
  },

  /** Start a large upload; return a private upload URL (never sent to the browser). */
  beginLargeFile: function (folderId, name, mime, size) {
    const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(size),
      },
      payload: JSON.stringify({ name: name, parents: [folderId] }),
      muteHttpExceptions: true,
      followRedirects: false,
    });
    const loc = header_(res, 'location');
    if (res.getResponseCode() !== 200 || !loc) {
      console.error('Drive begin failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 500));
      throw apiError_('SERVER', 'Something went wrong. Please try again.');
    }
    return loc;
  },

  /** Send bytes [start, start+len) of a large upload. Return total bytes Drive now has. */
  putChunk: function (url, bytes, start, total) {
    const end = start + bytes.length - 1;
    const res = UrlFetchApp.fetch(url, {
      method: 'put',
      contentType: 'application/octet-stream',
      headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + total },
      payload: bytes,
      muteHttpExceptions: true,
      followRedirects: false,
    });
    const code = res.getResponseCode();
    if (code === 200 || code === 201) return total;
    if (code === 308) {
      const range = header_(res, 'range'); // e.g. "bytes=0-10485759"
      const m = range && /bytes=0-(\d+)/.exec(range);
      return m ? Number(m[1]) + 1 : 0;
    }
    console.error('Drive chunk failed: ' + code + ' ' + res.getContentText().slice(0, 500));
    throw apiError_('SERVER', 'Something went wrong. Please try again.');
  },
};

function header_(res, name) {
  const h = res.getAllHeaders ? res.getAllHeaders() : res.getHeaders();
  for (const k in h) if (k.toLowerCase() === name) return Array.isArray(h[k]) ? h[k][0] : h[k];
  return null;
}

// =====================================================================
// 6. ADMIN FUNCTIONS — run these from the Apps Script editor
// =====================================================================

/**
 * Run once after editing SETUP (and again whenever you add events or change
 * dates/PINs). Creates folders and prints the QR links for NEW events.
 * Existing events keep their links unless you run newLinkFor().
 */
function setup() {
  const p = PropertiesService.getScriptProperties();
  let rootId = p.getProperty('ROOT_FOLDER');
  if (!rootId) {
    rootId = Storage.createFolder(null, SETUP.rootFolderName);
    p.setProperty('ROOT_FOLDER', rootId);
  }
  const events = loadEvents_();
  const lines = [];
  SETUP.events.forEach(function (cfg) {
    if (!/^[a-z0-9-]{1,32}$/.test(cfg.id)) throw new Error('Bad event id: ' + cfg.id);
    if (cfg.pin && !/^[0-9]{3,12}$/.test(cfg.pin)) throw new Error('PIN must be 3–12 digits: ' + cfg.id);
    let ev = events.find(function (x) { return x.id === cfg.id; });
    let newKey = null;
    if (!ev) {
      newKey = randomToken_(48);
      ev = { id: cfg.id, salt: randomToken_(32), folderId: Storage.createFolder(rootId, cfg.title) };
      ev.keyHash = sha256Hex_(ev.salt + ':' + newKey);
      events.push(ev);
    }
    ev.title = cfg.title;
    ev.opensAt = parseDate_(cfg.opens);
    ev.closesAt = parseDate_(cfg.closes);
    if (ev.closesAt <= ev.opensAt) throw new Error('closes must be after opens: ' + cfg.id);
    ev.pinHash = cfg.pin ? sha256Hex_(ev.salt + ':pin:' + cfg.pin) : '';
    if (newKey) lines.push(cfg.title + ':  ' + linkFor_(cfg.id, newKey));
  });
  p.setProperty('EVENTS', JSON.stringify(events));
  console.log(lines.length
    ? 'QR LINKS — copy these now, they are shown only once:\n\n' + lines.join('\n')
    : 'Settings updated. No new events, so no new links.');
}

/** Make a fresh link for one event (the old QR stops working). Example: newLinkFor('sangeet') */
function newLinkFor(eventId) {
  const p = PropertiesService.getScriptProperties();
  const events = loadEvents_();
  const ev = events.find(function (x) { return x.id === eventId; });
  if (!ev) throw new Error('No event with id ' + eventId + '. Run setup() first.');
  const key = randomToken_(48);
  ev.keyHash = sha256Hex_(ev.salt + ':' + key);
  p.setProperty('EVENTS', JSON.stringify(events));
  console.log('New link for ' + ev.title + ' (old QR no longer works):\n' + linkFor_(eventId, key));
}

/** Print how much each event has received. */
function showUsage() {
  const p = PropertiesService.getScriptProperties();
  loadEvents_().forEach(function (ev) {
    const bytes = Number(p.getProperty('u:e:' + ev.id) || 0);
    console.log(ev.title + ': ' + (bytes / GB).toFixed(2) + ' GB');
  });
}

function linkFor_(id, key) {
  return SETUP.siteUrl + '?e=' + encodeURIComponent(id) + '&k=' + key;
}

function parseDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) throw new Error('Date must look like 2026-12-10 18:30 — got ' + s);
  return Utilities.parseDate(s, SETUP.timeZone, 'yyyy-MM-dd HH:mm').getTime();
}

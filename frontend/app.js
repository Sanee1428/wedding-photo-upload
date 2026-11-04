/* Wedding photo upload page. No libraries, no tracking. */
(function () {
  'use strict';

  var CFG = window.WEDDING_CONFIG || {};
  var DEMO = CFG.demo === true;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- small storage helpers (work even if storage is blocked) ----------
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function ssGet(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  function randomId() {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  var DEVICE = (function () {
    var d = lsGet('wp_device', null);
    if (typeof d !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(d)) { d = randomId(); lsSet('wp_device', d); }
    return d;
  })();

  // ---------- read the QR link, then hide the secret from the address bar ----------
  var params = new URLSearchParams(location.search);
  var link = null;
  if (params.get('e') && params.get('k')) {
    link = { e: params.get('e'), k: params.get('k') };
    ssSet('wp_link', link);
    history.replaceState(null, '', location.pathname); // so screenshots don't show the key
  } else {
    link = ssGet('wp_link');
  }
  if (DEMO && !link) link = { e: 'sangeet', k: 'demo' };

  var state = {
    event: link && link.e, key: link && link.k, pin: '',
    info: null, name: null, items: [], busy: false,
  };

  // ---------- screens ----------
  var SCREENS = ['loading', 'message', 'pin', 'name', 'confirm', 'upload'];
  function show(name) {
    SCREENS.forEach(function (s) { $('screen-' + s).hidden = s !== name; });
    var focusMap = { pin: 'pinInput', name: 'nameInput' };
    if (focusMap[name]) setTimeout(function () { $(focusMap[name]).focus(); }, 50);
  }
  function message(title, text) { $('msgTitle').textContent = title; $('msgText').textContent = text; show('message'); }

  $('couple').textContent = CFG.coupleNames || '';
  $('tagline').textContent = CFG.tagline || '';

  // ---------- talking to the server ----------
  function ApiError(res) { this.code = res.code; this.message = res.message || 'Something went wrong.'; this.expected = res.expected; }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function api(action, payload) {
    var body = Object.assign({ action: action, event: state.event, key: state.key, device: DEVICE }, payload || {});
    if (state.pin) body.pin = state.pin;
    if (DEMO) return demoApi(body);
    var text = JSON.stringify(body);
    var attempt = 0;
    function go() {
      return fetch(CFG.apiUrl, {
        method: 'POST', body: text, redirect: 'follow', credentials: 'omit', cache: 'no-store',
        referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (j) {
        if (j && j.ok) return j;
        throw new ApiError(j || {});
      }).catch(function (err) {
        var retryable = !(err instanceof ApiError) || err.code === 'SERVER' || err.code === 'RATE_LIMITED';
        if (retryable && attempt < 5) {
          attempt++;
          var wait = err.code === 'RATE_LIMITED' ? 20000 : Math.min(30000, 1500 * Math.pow(2, attempt));
          return sleep(wait).then(go);
        }
        if (!(err instanceof ApiError)) throw new ApiError({ code: 'NETWORK', message: 'No connection. Check your internet and try again.' });
        throw err;
      });
    }
    return go();
  }

  // ---------- start ----------
  function start() {
    if (!state.event || !state.key) {
      return message('Please scan the QR code', 'Open this page by scanning the QR code at the venue.');
    }
    if (!/^[a-z0-9-]{1,32}$/.test(state.event)) return message('Link not valid', 'Please scan the QR code at the venue again.');
    show('loading');
    api('info').then(function (info) {
      state.info = info;
      $('eventTitle').textContent = info.title;
      document.title = 'Share your ' + info.title + ' photos';
      if (info.status === 'not_open') return message('Opening soon', 'Photo uploads for ' + info.title + " haven't opened yet. Please come back on the day.");
      if (info.status === 'closed') return message('Uploads are closed', 'Uploads for ' + info.title + ' have closed. Thank you for sharing your memories!');
      if (info.requiresPin) {
        var saved = lsGet('wp_pins', {})[state.event];
        if (saved) { state.pin = saved; return afterPin(); }
        return show('pin');
      }
      afterPin();
    }).catch(function (e) {
      if (e.code === 'ACCESS') return message('Link not valid', e.message);
      message("Couldn't open", e.message);
    });
  }

  // ---------- PIN ----------
  $('pinBtn').addEventListener('click', submitPin);
  $('pinInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPin(); });
  function submitPin() {
    var pin = $('pinInput').value.replace(/\D/g, '');
    if (pin.length < 3) { $('pinError').textContent = 'Please enter the PIN from your table card.'; return; }
    state.pin = pin;
    $('pinBtn').disabled = true;
    // checking any name validates the PIN
    api('check', { name: 'PIN check' }).then(function () {
      var pins = lsGet('wp_pins', {}); pins[state.event] = pin; lsSet('wp_pins', pins);
      $('pinError').textContent = '';
      afterPin();
    }).catch(function (e) {
      state.pin = '';
      $('pinError').textContent = e.message;
    }).then(function () { $('pinBtn').disabled = false; });
  }

  // ---------- name ----------
  function afterPin() {
    var mine = lsGet('wp_names', {})[state.event];
    if (mine) { state.name = mine; return showUpload(); } // returning guest on this phone
    var last = lsGet('wp_lastname', '');
    if (last) $('nameInput').value = last;
    show('name');
  }

  var NAME_RE = /^[\p{L}\p{M}\p{N} .'()-]+$/u;
  function cleanName(s) { return s.normalize('NFC').replace(/\s+/g, ' ').trim(); }

  $('nameBtn').addEventListener('click', submitName);
  $('nameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitName(); });
  function submitName() {
    var name = cleanName($('nameInput').value);
    var err = $('nameError');
    if (name.length < 2 || name.length > 40 || !NAME_RE.test(name) || !/\p{L}/u.test(name) || /^[. ]|[. ]$/.test(name)) {
      err.textContent = 'Please enter your name using letters only (2–40 characters).';
      return;
    }
    err.textContent = '';
    $('nameBtn').disabled = true;
    api('check', { name: name }).then(function (r) {
      if (r.exists) {
        state.pendingName = name;
        $('confirmName').textContent = name;
        $('confirmEvent').textContent = state.info.title;
        show('confirm');
      } else {
        claimName(name);
      }
    }).catch(function (e) { err.textContent = e.message; })
      .then(function () { $('nameBtn').disabled = false; });
  }

  $('confirmYes').addEventListener('click', function () { claimName(state.pendingName); });
  $('confirmNo').addEventListener('click', function () {
    $('nameInput').value = state.pendingName + ' ';
    $('nameError').textContent = 'Add something to tell you apart, like your town: "' + state.pendingName + ' (Vizag)"';
    show('name');
  });

  function claimName(name) {
    state.name = name;
    var names = lsGet('wp_names', {}); names[state.event] = name; lsSet('wp_names', names);
    lsSet('wp_lastname', name);
    showUpload();
  }

  $('changeName').addEventListener('click', function () {
    if (state.busy) return;
    var names = lsGet('wp_names', {}); delete names[state.event]; lsSet('wp_names', names);
    state.name = null;
    $('nameInput').value = '';
    show('name');
  });

  function showUpload() {
    $('helloName').textContent = state.name;
    show('upload');
    render();
  }

  // ---------- choosing files ----------
  var HEIC_RE = /\.(heic|heif)$/i;
  function fileKey(f) { return [f.name, f.size, f.lastModified].join('|'); }
  function uploadedSet() { return lsGet('wp_done_' + state.event, []); }
  function markUploaded(f) {
    var list = uploadedSet(); list.push(fileKey(f));
    if (list.length > 3000) list = list.slice(-3000);
    lsSet('wp_done_' + state.event, list);
  }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  $('fileInput').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    var done = uploadedSet();
    var have = {};
    state.items.forEach(function (it) { have[fileKey(it.file)] = true; });
    var lim = state.info.limits;
    files.forEach(function (f) {
      if (have[fileKey(f)]) return;
      var isVideo = /^video\//.test(f.type);
      var isPhoto = /^image\//.test(f.type) || HEIC_RE.test(f.name);
      var it = { file: f, isVideo: isVideo, status: 'ready', note: fmtSize(f.size), progress: 0 };
      if (!isVideo && !isPhoto) { it.status = 'skipped'; it.note = 'Not a photo or video'; }
      else if (f.size > (isVideo ? lim.maxVideoBytes : lim.maxPhotoBytes)) { it.status = 'skipped'; it.note = 'Too large (' + fmtSize(f.size) + ')'; }
      else if (done.indexOf(fileKey(f)) >= 0) { it.status = 'done'; it.progress = 1; it.note = 'Already uploaded'; }
      state.items.push(it);
    });
    render();
  });

  // ---------- list rendering (textContent only — never HTML from data) ----------
  function render() {
    var list = $('fileList');
    while (list.firstChild) list.removeChild(list.firstChild);
    state.items.forEach(function (it, idx) {
      if (!it.el) it.el = buildRow(it, idx);
      updateRow(it);
      list.appendChild(it.el);
    });
    var ready = state.items.filter(function (i) { return i.status === 'ready'; }).length;
    var failed = state.items.filter(function (i) { return i.status === 'failed'; }).length;
    var done = state.items.filter(function (i) { return i.status === 'done'; }).length;
    var total = state.items.filter(function (i) { return i.status !== 'skipped'; }).length;

    $('uploadBtn').hidden = state.busy || ready === 0;
    $('uploadBtn').textContent = 'Upload ' + ready + (ready === 1 ? ' file' : ' files');
    $('retryBtn').hidden = state.busy || failed === 0;
    $('keepOpen').hidden = !state.busy;
    $('pickerLabel').classList.toggle('busy', state.busy);
    $('fileInput').disabled = state.busy;

    $('summary').hidden = total === 0;
    if (total) {
      var progress = state.items.reduce(function (a, i) { return i.status === 'skipped' ? a : a + i.progress; }, 0) / total;
      $('barFill').style.width = Math.round(progress * 100) + '%';
      var t = done + ' of ' + total + ' uploaded';
      if (failed) t += ' · ' + failed + ' failed';
      if (!state.busy && done === total) t = '✓ All ' + total + ' uploaded. Thank you! You can add more anytime.';
      $('summaryText').textContent = t;
    }
  }

  function buildRow(it) {
    var li = document.createElement('li'); li.className = 'file';
    var thumb;
    if (!it.isVideo && /^image\/(jpeg|png|webp|gif)$/.test(it.file.type)) {
      thumb = document.createElement('img'); thumb.className = 'thumb'; thumb.alt = '';
      thumb.loading = 'lazy'; thumb.decoding = 'async';
      thumb.src = URL.createObjectURL(it.file);
      thumb.addEventListener('load', function () { URL.revokeObjectURL(thumb.src); }, { once: true });
      thumb.addEventListener('error', function () {
        URL.revokeObjectURL(thumb.src);
        var icon = document.createElement('div'); icon.className = 'thumb'; icon.textContent = '🖼';
        if (thumb.parentNode) thumb.parentNode.replaceChild(icon, thumb);
      }, { once: true });
    } else {
      thumb = document.createElement('div'); thumb.className = 'thumb';
      thumb.textContent = it.isVideo ? '▶' : '🖼';
    }
    var meta = document.createElement('div'); meta.className = 'meta';
    var nm = document.createElement('div'); nm.className = 'fname'; nm.textContent = it.file.name || (it.isVideo ? 'Video' : 'Photo');
    var sub = document.createElement('div'); sub.className = 'fsub';
    var mini = document.createElement('div'); mini.className = 'mini'; var fill = document.createElement('div'); mini.appendChild(fill);
    meta.appendChild(nm); meta.appendChild(sub); meta.appendChild(mini);
    var st = document.createElement('button'); st.type = 'button'; st.className = 'state';
    st.addEventListener('click', function () {
      if (state.busy || it.status === 'uploading') return;
      if (it.status === 'ready' || it.status === 'skipped' || it.status === 'failed') {
        state.items.splice(state.items.indexOf(it), 1); render();
      }
    });
    li.appendChild(thumb); li.appendChild(meta); li.appendChild(st);
    it.parts = { sub: sub, fill: fill, st: st, mini: mini };
    return li;
  }

  function updateRow(it) {
    var p = it.parts;
    it.el.className = 'file ' + it.status;
    p.sub.textContent = it.note;
    p.fill.style.width = Math.round(it.progress * 100) + '%';
    p.mini.hidden = it.status !== 'uploading';
    var icons = { ready: '×', uploading: '…', done: '✓', failed: '!', skipped: '×' };
    p.st.textContent = icons[it.status];
    p.st.setAttribute('aria-label', it.status === 'ready' || it.status === 'skipped' || it.status === 'failed' ? 'Remove' : it.status);
    p.st.classList.toggle('remove', it.status === 'ready' || it.status === 'skipped');
  }

  // ---------- uploading ----------
  $('uploadBtn').addEventListener('click', runQueue);
  $('retryBtn').addEventListener('click', function () {
    state.items.forEach(function (i) { if (i.status === 'failed') { i.status = 'ready'; i.progress = 0; i.note = fmtSize(i.file.size); } });
    runQueue();
  });

  var wakeLock = null;
  function holdAwake(on) {
    try {
      if (on && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
      if (!on && wakeLock) { wakeLock.release(); wakeLock = null; }
    } catch (e) { /* not supported */ }
  }
  window.addEventListener('beforeunload', function (e) { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });

  function runQueue() {
    if (state.busy) return;
    state.busy = true; holdAwake(true); render();
    var queue = state.items.filter(function (i) { return i.status === 'ready'; });
    var stopAll = null;
    var chain = Promise.resolve();
    queue.forEach(function (it) {
      chain = chain.then(function () {
        if (stopAll) { it.status = 'failed'; it.note = stopAll; updateRow(it); return; }
        it.status = 'uploading'; it.note = 'Uploading…'; it.progress = 0.02; updateRow(it); render();
        return uploadOne(it).then(function () {
          it.status = 'done'; it.progress = 1; it.note = 'Uploaded'; markUploaded(it.file);
        }).catch(function (e) {
          it.status = 'failed'; it.progress = 0; it.note = e.message || 'Upload failed';
          // These affect every remaining file, so stop instead of failing one by one.
          if (['CLOSED', 'ACCESS', 'QUOTA', 'PIN'].indexOf(e.code) >= 0) stopAll = e.message;
        }).then(function () { updateRow(it); render(); });
      });
    });
    chain.then(function () { state.busy = false; holdAwake(false); render(); });
  }

  function readB64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { reject(new ApiError({ code: 'READ', message: "Couldn't read this file from your phone." })); };
      fr.readAsDataURL(blob);
    });
  }

  function uploadOne(it, restarted) {
    var f = it.file, lim = state.info.limits;
    // The original file is sent untouched — no resizing, so date & location stay in the photo.
    if (f.size <= lim.singleShotMaxBytes) {
      return readB64(f).then(function (data) { return api('upload', { name: state.name, size: f.size, data: data }); });
    }
    var C = lim.chunkBytes;
    var session = null;
    function step(offset) {
      it.progress = Math.max(0.02, offset / f.size); updateRow(it); render();
      if (offset >= f.size) return Promise.resolve();
      var end = Math.min(offset + C, f.size);
      return readB64(f.slice(offset, end)).then(function (data) {
        return session === null
          ? api('begin', { name: state.name, size: f.size, data: data }).then(function (r) { session = r.session; return r; })
          : api('chunk', { session: session, offset: offset, data: data });
      }).then(function (r) {
        return r.done ? Promise.resolve() : step(r.received);
      }, function (e) {
        if (e.code === 'OFFSET' && typeof e.expected === 'number') return step(e.expected);
        if (e.code === 'SESSION_EXPIRED' && !restarted) return uploadOne(it, true);
        throw e;
      });
    }
    return step(0);
  }

  // ---------- demo mode (no backend; nothing leaves the phone) ----------
  var demoNames = { 'ravi kumar': true };
  function demoApi(b) {
    return sleep(b.action === 'info' ? 400 : 300 + Math.random() * 500).then(function () {
      var key = b.name ? cleanName(b.name).toLowerCase() : '';
      switch (b.action) {
        case 'info': return { ok: true, title: 'Sangeet', status: 'open', requiresPin: false,
          limits: { maxPhotoBytes: 60 * 1048576, maxVideoBytes: 1073741824, singleShotMaxBytes: 10 * 1048576, chunkBytes: 10 * 1048576 } };
        case 'check': return { ok: true, exists: !!demoNames[key] };
        case 'upload': demoNames[key] = true; return { ok: true };
        case 'begin': demoNames[key] = true; return { ok: true, session: 'd'.repeat(32), received: 10 * 1048576, done: false };
        case 'chunk': var rec = Math.min(b.offset + 10 * 1048576, 1e12); return { ok: true, received: rec, done: rec >= (state._demoSize || 0) };
      }
    });
  }
  if (DEMO) {
    var origUpload = uploadOne;
    uploadOne = function (it) { state._demoSize = it.file.size; return origUpload(it); };
  }

  start();
})();

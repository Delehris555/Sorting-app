(function () {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var IMG_RE = /\.(jpe?g|png|heic|heif|tiff?|webp|gif|avif|dng|cr2|cr3|nef|arw|orf|rw2|raf)$/i;
  var CLUSTER_KM = 15;
  var META_WEIGHT = 0.15; // share of the progress bar used by the metadata pass

  var $ = function (id) { return document.getElementById(id); };
  var btn = $('loadBtn'), fill = $('fill'), track = $('track'), pctEl = $('pct'),
    etaEl = $('eta'), panel = $('statusPanel'), titleEl = $('statusTitle'), bodyEl = $('statusBody');

  var running = false, t0 = 0, smoothRem = null, lastPaint = 0;

  /* ---------- UI helpers ---------- */
  function setStatus(title, lines, kind) {
    panel.className = kind || '';
    titleEl.textContent = title;
    bodyEl.textContent = '';
    (lines || []).forEach(function (l) {
      var p = document.createElement('p');
      p.textContent = l;
      bodyEl.appendChild(p);
    });
  }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + 's';
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function setProgress(frac, force) {
    var now = performance.now();
    if (!force && now - lastPaint < 80) return;
    lastPaint = now;
    frac = Math.max(0, Math.min(1, frac));
    fill.style.clipPath = 'inset(0 ' + ((1 - frac) * 100).toFixed(2) + '% 0 0)';
    pctEl.textContent = Math.floor(frac * 100) + '%';
    var el = (now - t0) / 1000;
    if (frac >= 1) {
      etaEl.textContent = 'Done in ' + fmt(el);
    } else if (frac > 0.02 && el > 2) {
      var rem = el * (1 - frac) / frac;
      smoothRem = smoothRem == null ? rem : smoothRem * 0.8 + rem * 0.2;
      etaEl.textContent = 'about ' + fmt(smoothRem) + ' remaining';
    } else {
      etaEl.textContent = 'Estimating time remaining…';
    }
  }

  function setBusy(b) {
    running = b;
    btn.disabled = b;
    track.classList.toggle('running', b);
  }

  window.addEventListener('beforeunload', function (e) {
    if (running) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- Metadata ---------- */
  function validDate(d) { return d instanceof Date && !isNaN(d.getTime()); }

  async function readMeta(file) {
    var date = null, lat = null, lon = null, fromExif = false;
    if (window.exifr) {
      try {
        var tags = await window.exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
        if (tags) {
          var d = tags.DateTimeOriginal || tags.CreateDate;
          if (validDate(d)) { date = d; fromExif = true; }
        }
      } catch (e) { /* no readable EXIF */ }
      try {
        var gps = await window.exifr.gps(file);
        if (gps && isFinite(gps.latitude) && isFinite(gps.longitude) &&
          !(gps.latitude === 0 && gps.longitude === 0)) {
          lat = gps.latitude; lon = gps.longitude;
        }
      } catch (e) { /* no GPS */ }
    }
    if (!date) date = new Date(file.lastModified);
    return { date: date, lat: lat, lon: lon, fromExif: fromExif };
  }

  function haversineKm(a, b, c, d) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (c - a) * rad, dLon = (d - b) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function coordName(lat, lon) {
    return Math.abs(lat).toFixed(3) + (lat >= 0 ? 'N' : 'S') + ' ' +
      Math.abs(lon).toFixed(3) + (lon >= 0 ? 'E' : 'W');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- File system ---------- */
  async function scan(dir, out, isRoot, onCount) {
    for await (var entry of dir.entries()) {
      var name = entry[0], handle = entry[1];
      if (handle.kind === 'file') {
        if (IMG_RE.test(name)) {
          out.push({ handle: handle, parent: dir, name: name });
          if (out.length % 100 === 0) onCount(out.length);
        }
      } else {
        if (name.charAt(0) === '.') continue;
        if (isRoot && /^\d{4}$/.test(name)) continue; // already-sorted year folders
        await scan(handle, out, false, onCount);
      }
    }
  }

  async function fileExists(dir, name) {
    try { await dir.getFileHandle(name); return true; }
    catch (e) {
      if (e.name === 'NotFoundError') return false;
      if (e.name === 'TypeMismatchError') return true;
      throw e;
    }
  }

  async function uniqueName(dir, name) {
    if (!(await fileExists(dir, name))) return name;
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    for (var n = 1; n < 10000; n++) {
      var c = base + ' (' + n + ')' + ext;
      if (!(await fileExists(dir, c))) return c;
    }
    throw new Error('Too many files with the same name');
  }

  async function copyFile(file, destDir, name, onBytes) {
    var fh = await destDir.getFileHandle(name, { create: true });
    try {
      var writable = await fh.createWritable();
      var counter = new TransformStream({
        transform: function (chunk, ctl) { onBytes(chunk.byteLength); ctl.enqueue(chunk); }
      });
      await file.stream().pipeThrough(counter).pipeTo(writable);
      var copied = await fh.getFile();
      if (copied.size !== file.size) throw new Error('Size mismatch after copy');
    } catch (e) {
      try { await destDir.removeEntry(name); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  /* ---------- Main run ---------- */
  async function run(root) {
    t0 = performance.now(); smoothRem = null;
    setProgress(0, true);
    setStatus('Scanning…', ['Looking for images in "' + root.name + '"…']);

    var found = [];
    await scan(root, found, true, function (n) {
      setStatus('Scanning…', ['Found ' + n + ' images so far…']);
    });

    if (!found.length) {
      setProgress(0, true);
      etaEl.textContent = '';
      setStatus('No images found', ['The selected folder has no supported image files.'], 'error');
      return;
    }

    // Pass 1: read metadata
    var infos = [], failed = [], totalBytes = 0, noExif = 0;
    for (var i = 0; i < found.length; i++) {
      var it = found[i];
      try {
        var file = await it.handle.getFile();
        var m = await readMeta(file);
        if (!m.fromExif) noExif++;
        infos.push({ handle: it.handle, parent: it.parent, name: it.name, size: file.size,
          date: m.date, lat: m.lat, lon: m.lon });
        totalBytes += file.size;
      } catch (e) {
        failed.push(it.name + ': ' + (e && e.message ? e.message : e));
      }
      setProgress(META_WEIGHT * (i + 1) / found.length);
      if (i % 20 === 0) setStatus('Reading metadata…', ['Checked ' + (i + 1) + ' of ' + found.length + ' images.']);
    }

    // Plan destinations (oldest first so location clusters are deterministic)
    infos.sort(function (a, b) { return a.date - b.date; });
    var clusters = {}, withLoc = 0, folders = {};
    infos.forEach(function (f) {
      var y = String(f.date.getFullYear());
      var mo = f.date.getMonth();
      var monthName = pad2(mo + 1) + ' - ' + MONTHS[mo];
      var locName = null;
      if (f.lat != null) {
        var key = y + '/' + mo;
        var list = clusters[key] || (clusters[key] = []);
        var hit = null;
        for (var k = 0; k < list.length; k++) {
          if (haversineKm(list[k].lat, list[k].lon, f.lat, f.lon) <= CLUSTER_KM) { hit = list[k]; break; }
        }
        if (!hit) { hit = { lat: f.lat, lon: f.lon, name: coordName(f.lat, f.lon) }; list.push(hit); }
        locName = hit.name;
        withLoc++;
      }
      f.path = [y, monthName].concat(locName ? [locName] : []);
      folders[f.path.join('/')] = true;
    });

    // Pass 2: copy, verify, delete original
    var dirCache = {}, doneBytes = 0, moved = 0;
    async function getDir(path) {
      var key = '', cur = root;
      for (var i = 0; i < path.length; i++) {
        key += '/' + path[i];
        if (!dirCache[key]) dirCache[key] = await cur.getDirectoryHandle(path[i], { create: true });
        cur = dirCache[key];
      }
      return cur;
    }
    function onBytes(n) {
      doneBytes += n;
      setProgress(META_WEIGHT + (1 - META_WEIGHT) * (totalBytes ? doneBytes / totalBytes : 0));
    }

    for (var j = 0; j < infos.length; j++) {
      var f = infos[j];
      var before = doneBytes;
      try {
        var src = await f.handle.getFile();
        var dest = await getDir(f.path);
        var name = await uniqueName(dest, f.name);
        await copyFile(src, dest, name, onBytes);
        await f.parent.removeEntry(f.name);
        moved++;
      } catch (e) {
        failed.push(f.name + ': ' + (e && e.message ? e.message : e));
        doneBytes = before + f.size; // keep progress honest
      }
      setProgress(META_WEIGHT + (1 - META_WEIGHT) * (totalBytes ? doneBytes / totalBytes : 1));
      if (j % 5 === 0) setStatus('Sorting…', ['Moved ' + moved + ' of ' + infos.length + ' images.']);
    }

    setProgress(1, true);
    var lines = [
      moved + ' of ' + found.length + ' images moved into ' + Object.keys(folders).length + ' folders.',
      withLoc + ' had GPS data and went into location subfolders (15 km grouping).',
      noExif + ' had no EXIF date and were sorted by file date.'
    ];
    if (failed.length) {
      lines.push(failed.length + ' could not be moved (originals left in place):');
      failed.slice(0, 5).forEach(function (m) { lines.push('  • ' + m); });
      if (failed.length > 5) lines.push('  …and ' + (failed.length - 5) + ' more.');
    }
    setStatus(failed.length ? 'Finished with some problems' : 'All done! 🎉', lines,
      failed.length ? 'error' : 'done');
  }

  async function onLoad() {
    if (running) return;
    if (!window.showDirectoryPicker) {
      setStatus('Browser not supported',
        ['Folder access needs Chrome, Edge or Opera on a desktop computer, opened over https.'], 'error');
      return;
    }
    var root;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'photo-sorter' });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus('Could not open folder', [String(e && e.message || e)], 'error');
      return;
    }
    btn.blur();
    setBusy(true);
    try {
      await run(root);
    } catch (e) {
      setStatus('Something went wrong', [String(e && e.message || e)], 'error');
      etaEl.textContent = '';
    } finally {
      setBusy(false);
    }
  }

  setStatus('Ready', [
    'Pick a folder of photos. They will be moved into Year › "01 - January" style month folders, ' +
    'with a location subfolder when GPS data exists.',
    'Works in Chrome, Edge and Opera. Nothing is uploaded; everything happens on your computer.'
  ]);
  if (!window.exifr) {
    bodyEl.appendChild(Object.assign(document.createElement('p'),
      { textContent: 'Note: the EXIF library could not load (offline?). File dates will be used and GPS ignored.' }));
  }
  btn.addEventListener('click', onLoad);
})();

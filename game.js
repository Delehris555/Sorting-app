/* Santa's Helper: self-contained mini-game.
   Any error here falls back to a static scene and never touches the sorter. */
(function () {
  'use strict';

  var canvas = document.getElementById('gameCanvas');
  var fallbackEl = document.getElementById('gameFallback');
  if (!canvas) return;

  var ctx = null, W = 300, Hc = 200, U = 30, dpr = 1;
  var raf = 0, last = 0, broken = false;

  var C = {
    bg: '#10203a', ground: '#ffffff', deer: '#b9783a', nose: '#ff2a2a',
    tree: '#43d17a', snow: '#ffffff', penguin: '#dbe8ff', beak: '#ffa726',
    ball: '#e8f1ff', text: '#cfe3ff', muted: '#8fa6c7'
  };

  /* Tunables (distances in U = avatar standing height, time in seconds) */
  var SCROLL = 7, RAMP_T = 2;
  var JUMP_T = 0.9, JUMP_H = 3, DOUBLE_H = 5, DOUBLE_WINDOW = 0.5, FALL_MULT = 1.69;
  var LEVEL_T = 60, CUT_T = 10, BASE_INTERVAL = 1.7, SPAWN_UP = 1.2;
  var G = 8 * JUMP_H / (JUMP_T * JUMP_T);
  var V0 = G * JUMP_T / 2;

  /* State */
  var state = 'intro';           // intro | playing | cutscene | dead
  var ramp = 0, obstacles = [], finale = null;
  var level = 1, levelTime = 0, score = 0, best = 0, finishing = false;
  var spawnTimer = 0, groundOff = 0, runPhase = 0, anim = 0, cutT = 0, deadT = 0;
  var P = { y: 0, vy: 0, air: false, jumps: 0, jumpT: 0, down: false };
  var stars = [];

  try { best = parseInt(localStorage.getItem('santasHelperBest') || '0', 10) || 0; } catch (e) { best = 0; }

  var TREE_PTS = [[0.42, 0], [0.42, 0.12], [0.02, 0.12], [0.26, 0.42], [0.12, 0.42], [0.34, 0.68],
    [0.22, 0.68], [0.5, 1], [0.78, 0.68], [0.66, 0.68], [0.88, 0.42], [0.74, 0.42], [0.98, 0.12],
    [0.58, 0.12], [0.58, 0]];
  var ORN = [[0.5, 0.82, '#ff4d4d'], [0.38, 0.6, '#ffd54f'], [0.62, 0.56, '#4fc3f7'], [0.3, 0.35, '#ff8ad8'],
    [0.52, 0.3, '#ff4d4d'], [0.72, 0.34, '#ffd54f'], [0.2, 0.18, '#4fc3f7'], [0.45, 0.2, '#ffffff'],
    [0.65, 0.17, '#ff8ad8'], [0.82, 0.2, '#ff4d4d'], [0.5, 0.58, '#ffffff'], [0.42, 0.42, '#4fc3f7']];

  function ax() { return W / 2; }
  function gy() { return Hc - U * 1.0; }
  function LW() { return Math.max(2, U * 0.07); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ---------- Setup ---------- */
  function resize() {
    var r = canvas.getBoundingClientRect();
    W = Math.max(200, r.width); Hc = Math.max(120, r.height);
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hc * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    U = Math.max(14, Hc / 7.4);
    stars = [];
    for (var i = 0; i < 28; i++) stars.push([(i * 97 % 100) / 100, ((i * 53) % 55) / 100 * 0.9 + 0.03]);
  }

  function mk(type, x, w, h, lane, label) {
    return { type: type, x: x, w: w, h: h, lane: lane || 0, label: label || '', ph: Math.random() * 6 };
  }

  function buildIntro() {
    obstacles = []; finale = null;
    var a = ax();
    var f = Math.min(1, (W / 2 - 0.6 * U) / (7.2 * U));
    function put(type, off, w, h, lane, label) { obstacles.push(mk(type, a + off * f * U, w, h, lane, label)); }
    // behind: tall ones, dynamic ones, plain reindeer
    put('tree', -6.8, 1.3, 2, 0, 'Tree');
    put('ball', -5.4, 0.5, 0.5, 3, 'Snowball');
    put('bank', -5.1, 1.9, 2, 0, 'Snow bank');
    put('penguin', -4.0, 1.8, 0.6, 4, 'Penguin');
    put('deer', -2.0, 1.15, 1, 0, 'Reindeer');
    // ahead: small ones, easy start
    put('tree', 3.4, 0.8, 1, 0, 'Tree');
    put('bank', 5.6, 1.35, 1, 0, 'Snow bank');
  }

  function resetPlayer() { P.y = 0; P.vy = 0; P.air = false; P.jumps = 0; P.jumpT = 0; P.down = false; }

  function toIntro() {
    state = 'intro'; ramp = 0; level = 1; levelTime = 0; score = 0; finishing = false;
    groundOff = 0; resetPlayer(); buildIntro();
  }

  function startGame(downKey) {
    state = 'playing'; ramp = 0; level = 1; levelTime = 0; score = 0; finishing = false;
    spawnTimer = 1.8; resetPlayer(); P.down = !!downKey;
  }

  function die() {
    state = 'dead'; deadT = 0;
    var s = Math.floor(score);
    if (s > best) {
      best = s;
      try { localStorage.setItem('santasHelperBest', String(best)); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- Input ---------- */
  function pressUp() {
    if (state === 'intro') { startGame(false); return; }
    if (state === 'dead') { if (deadT > 0.6) toIntro(); return; }
    if (state !== 'playing') return;
    if (!P.air) { P.vy = V0; P.air = true; P.jumps = 1; P.jumpT = 0; }
    else if (P.jumps === 1 && P.jumpT <= DOUBLE_WINDOW) {
      P.vy = Math.sqrt(2 * G * Math.max(0.5, DOUBLE_H - P.y)); P.jumps = 2;
    }
  }
  function pressDown() {
    if (state === 'intro') { startGame(true); return; }
    if (state === 'dead') { if (deadT > 0.6) toIntro(); return; }
    P.down = true;
  }
  function releaseDown() { P.down = false; }

  function guard(fn) { return function (e) { if (broken) return; try { fn(e); } catch (err) { fail(err); } }; }

  window.addEventListener('keydown', guard(function (e) {
    var k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown') e.preventDefault();
    if (e.repeat) return;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') pressUp();
    else if (k === 'ArrowDown' || k === 's' || k === 'S') pressDown();
  }));
  window.addEventListener('keyup', guard(function (e) {
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') releaseDown();
  }));
  canvas.addEventListener('pointerdown', guard(function (e) {
    var r = canvas.getBoundingClientRect();
    if (e.clientY - r.top < r.height / 2) pressUp(); else pressDown();
  }));
  window.addEventListener('pointerup', guard(releaseDown));
  window.addEventListener('pointercancel', guard(releaseDown));

  /* ---------- Simulation ---------- */
  function rectOf(o) {
    var wpx = o.w * U, hpx = o.h * U, b = o.lane ? o.lane * U - hpx / 2 : 0;
    var il = 0, ih = 1;
    if (o.type === 'bank') { il = 0.12; ih = 0.85; }
    else if (o.type === 'tree') { il = 0.22; ih = 0.95; }
    else if (o.type === 'deer') { il = 0.1; ih = 0.95; }
    return { l: o.x + wpx * il, r: o.x + wpx * (1 - il), b: b, t: b + hpx * ih };
  }

  function playerRect() {
    var left = ax() - 0.55 * U;
    var h = (P.down && !P.air) ? 0.42 : 0.85;
    return { l: left + 0.25 * U, r: left + 0.95 * U, b: P.y * U, t: P.y * U + h * U };
  }

  function spawn() {
    var right = -1e9;
    obstacles.forEach(function (o) { right = Math.max(right, o.x + o.w * U); });
    if (right > W + 8 * U) return;
    var x = Math.max(W + 2 * U, right + (4.2 + Math.random() * 1.6) * U);
    var h;
    if (Math.random() < 0.65) {
      var s = Math.random();
      if (s < 0.45) { h = 1 + Math.random(); obstacles.push(mk('bank', x, 0.8 + 0.55 * h, h)); }
      else if (s < 0.9) { h = 1 + Math.random(); obstacles.push(mk('tree', x, 0.3 + 0.5 * h, h)); }
      else obstacles.push(mk('deer', x, 1.15, 1));
    } else {
      var r = Math.random(), lane = r < 0.35 ? 1 : r < 0.6 ? 2 : r < 0.8 ? 3 : 4;
      if (Math.random() < 0.5) obstacles.push(mk('ball', x, 0.5, 0.5, lane));
      else obstacles.push(mk('penguin', x, 1.8, 0.6, lane));
    }
  }

  function step(dt) {
    anim += dt;
    if (state === 'intro') return;
    if (state === 'dead') { deadT += dt; return; }

    if (state === 'playing') ramp = Math.min(1, ramp + dt / RAMP_T);
    else if (state === 'cutscene' && ramp > 0) {
      ramp = Math.max(0, ramp - dt * 2.5);
      if (ramp === 0) { cutT = 0; finale = { x: ax() + 3.4 * U, w: 3.0, h: 4.2 }; }
    } else if (state === 'cutscene') {
      cutT += dt;
      if (cutT >= CUT_T) {
        level++; levelTime = 0; finishing = false; state = 'playing'; spawnTimer = 2.2;
      }
    }

    var dx = SCROLL * ramp * U * dt;
    groundOff += dx; runPhase += dx / U * 3.2;
    obstacles.forEach(function (o) { o.x -= dx; });
    obstacles = obstacles.filter(function (o) { return o.x + o.w * U > -3 * U; });
    if (finale) {
      finale.x -= dx;
      if (state === 'playing' && finale.x + finale.w * U < -U) finale = null;
    }

    if (state !== 'playing') return;

    // vertical physics
    if (P.air) {
      P.jumpT += dt;
      P.vy -= G * (P.down ? FALL_MULT : 1) * dt;
      P.y += P.vy * dt;
      if (P.y <= 0) { P.y = 0; P.vy = 0; P.air = false; P.jumps = 0; }
    }

    // score and level timer
    levelTime += dt;
    score += dt * (1 + 0.2 * (level - 1));
    if (levelTime >= LEVEL_T) finishing = true;

    // spawning
    if (!finishing) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawn();
        spawnTimer = BASE_INTERVAL / Math.pow(SPAWN_UP, level - 1) * (0.85 + Math.random() * 0.5);
      }
    }

    // collisions
    var pr = playerRect();
    for (var i = 0; i < obstacles.length; i++) {
      var rr = rectOf(obstacles[i]);
      if (pr.l < rr.r && pr.r > rr.l && pr.b < rr.t && pr.t > rr.b) { die(); return; }
    }

    // level end: wait until the track is clear, then the tree scene
    if (finishing && !P.air) {
      var clear = obstacles.every(function (o) { return o.x + o.w * U < ax() - 1.2 * U; });
      if (clear) { state = 'cutscene'; P.down = false; }
    }
  }

  /* ---------- Drawing primitives ---------- */
  function drawDeer(left, ground, o) {
    var sit = o.pose === 'sit', k = sit ? 0.55 : 1;
    var by = sit ? 0.13 : 0.52, bry = sit ? 0.13 : 0.2;
    ctx.save();
    ctx.translate(left, ground); ctx.scale(U, -U);
    ctx.lineWidth = LW() / U; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = C.deer; ctx.fillStyle = C.bg;

    if (!sit) {
      var amp = o.air ? 0 : (o.amp || 0) * 0.6, hipY = by - 0.1;
      var xs = [0.2, 0.32, 0.6, 0.72], offs = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
      for (var i = 0; i < 4; i++) {
        var a = o.air ? (i < 2 ? -0.5 : 0.5) : Math.sin((o.phase || 0) + offs[i]) * amp;
        ctx.beginPath(); ctx.moveTo(xs[i], hipY);
        ctx.lineTo(xs[i] + Math.sin(a) * hipY, hipY - Math.cos(a) * hipY); ctx.stroke();
      }
    }
    // body
    ctx.beginPath(); ctx.ellipse(0.45, by, 0.38, bry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // tail
    ctx.beginPath(); ctx.moveTo(0.08, by + 0.05 * k); ctx.lineTo(0.02, by + 0.15 * k); ctx.stroke();
    // neck
    ctx.beginPath(); ctx.moveTo(0.62, by + 0.17 * k); ctx.lineTo(0.76, by + 0.34 * k);
    ctx.moveTo(0.78, by + 0.02 * k); ctx.lineTo(0.9, by + 0.2 * k); ctx.stroke();
    // head
    var hx = 0.86, hy = by + 0.3 * k, th = 0.3;
    ctx.beginPath(); ctx.ellipse(hx, hy, 0.14, 0.09 * (sit ? 0.9 : 1), th, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // antlers
    ctx.beginPath();
    ctx.moveTo(hx - 0.02, hy + 0.08 * k); ctx.lineTo(hx - 0.08, hy + 0.17 * k); ctx.lineTo(hx - 0.15, hy + 0.2 * k);
    ctx.moveTo(hx - 0.08, hy + 0.17 * k); ctx.lineTo(hx - 0.06, hy + 0.23 * k);
    ctx.moveTo(hx + 0.03, hy + 0.08 * k); ctx.lineTo(hx + 0.01, hy + 0.18 * k); ctx.lineTo(hx - 0.04, hy + 0.22 * k);
    ctx.stroke();
    // eye
    ctx.fillStyle = C.deer; ctx.beginPath(); ctx.arc(hx + 0.02, hy + 0.025, 0.012, 0, Math.PI * 2); ctx.fill();
    // red nose
    if (o.nose) {
      ctx.fillStyle = C.nose; ctx.strokeStyle = C.nose;
      ctx.beginPath(); ctx.arc(hx + 0.14 * Math.cos(th), hy + 0.14 * Math.sin(th), 0.05, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function treePath(x, g, w, h) {
    var pts = TREE_PTS.map(function (p) { return [x + p[0] * w, g - p[1] * h]; });
    var len = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
    ctx.closePath();
    return len;
  }

  function drawTree(x, g, w, h, p) {
    if (p <= 0) return;
    ctx.save();
    ctx.lineWidth = LW(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = C.tree; ctx.fillStyle = C.bg;
    var len = treePath(x, g, w, h);
    if (p < 1) ctx.setLineDash([len * p, len * 2]); else ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawStar(cx, cy, r) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var ang = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r * 0.45 : r;
      ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
    }
    ctx.closePath(); ctx.fillStyle = '#ffd54f'; ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 1.5;
    ctx.fill(); ctx.stroke();
  }

  function drawFinale(f, t) {
    var g = gy(), w = f.w * U, h = f.h * U;
    drawTree(f.x, g, w, h, clamp((t - 0.3) / 3, 0, 1));
    if (t > 3.3) {
      var n = clamp(Math.floor((t - 3.3) / 4 * ORN.length) + 1, 0, ORN.length);
      for (var i = 0; i < n; i++) {
        var o = ORN[i], tw = 0.85 + 0.15 * Math.sin(anim * 4 + i);
        ctx.beginPath(); ctx.arc(f.x + o[0] * w, g - o[1] * h, U * 0.11 * tw, 0, Math.PI * 2);
        ctx.fillStyle = o[2]; ctx.fill();
      }
    }
    if (t > 7.3) drawStar(f.x + 0.5 * w, g - h - U * 0.05, U * 0.3 * clamp((t - 7.3) / 0.7, 0, 1));
  }

  function drawPenguin(l, top, w, h, ph) {
    ctx.save();
    ctx.lineWidth = LW(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = C.penguin; ctx.fillStyle = C.bg;
    ctx.beginPath(); ctx.ellipse(l + w * 0.46, top + h / 2, w * 0.42, h * 0.48, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    var hx = l + w * 0.88, hy = top + h * 0.45, r = h * 0.34;
    ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = C.beak; ctx.fillStyle = C.beak;
    ctx.beginPath(); ctx.moveTo(hx + r * 0.8, hy - h * 0.12); ctx.lineTo(hx + r + U * 0.12, hy + h * 0.05);
    ctx.lineTo(hx + r * 0.8, hy + h * 0.18); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.penguin; ctx.beginPath(); ctx.arc(hx + r * 0.1, hy - r * 0.2, Math.max(1.5, U * 0.025), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.penguin;
    var flap = Math.sin(anim * 16 + ph);
    ctx.beginPath(); ctx.moveTo(l + w * 0.5, top + h * 0.5); ctx.lineTo(l + w * 0.3, top + h * 0.5 + flap * h * 0.75); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(l + w * 0.58, top + h * 0.5); ctx.lineTo(l + w * 0.4, top + h * 0.5 - flap * h * 0.55); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(l + w * 0.05, top + h * 0.5); ctx.lineTo(l - w * 0.04, top + h * 0.35);
    ctx.moveTo(l + w * 0.05, top + h * 0.6); ctx.lineTo(l - w * 0.04, top + h * 0.75); ctx.stroke();
    ctx.restore();
  }

  function drawBank(x, g, w, h) {
    ctx.save();
    ctx.lineWidth = LW(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = C.snow; ctx.fillStyle = C.bg;
    ctx.beginPath(); ctx.moveTo(x, g);
    ctx.bezierCurveTo(x + 0.12 * w, g - 1.33 * h, x + 0.88 * w, g - 1.33 * h, x + w, g);
    ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(x + 0.22 * w, g - 0.4 * h);
    ctx.quadraticCurveTo(x + 0.35 * w, g - 0.65 * h, x + 0.5 * w, g - 0.62 * h); ctx.stroke();
    ctx.restore();
  }

  function drawBall(cx, cy, r) {
    ctx.save();
    ctx.lineWidth = LW(); ctx.lineCap = 'round';
    ctx.strokeStyle = C.ball; ctx.fillStyle = C.bg;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, anim * 6, anim * 6 + 2); ctx.stroke();
    ctx.restore();
  }

  function drawObstacle(o) {
    var g = gy(), wpx = o.w * U, hpx = o.h * U, labelX = o.x + wpx / 2, labelY;
    if (o.type === 'bank') drawBank(o.x, g, wpx, hpx);
    else if (o.type === 'tree') drawTree(o.x, g, wpx, hpx, 1);
    else if (o.type === 'deer') drawDeer(o.x, g, { pose: 'stand', nose: false, amp: 0, phase: 0 });
    else if (o.type === 'ball') drawBall(o.x + wpx / 2, g - o.lane * U, wpx / 2);
    else if (o.type === 'penguin') drawPenguin(o.x, g - o.lane * U - hpx / 2, wpx, hpx, o.ph);
    if (state === 'intro' && o.label) {
      ctx.save();
      ctx.font = Math.max(10, U * 0.28) + 'px system-ui, sans-serif';
      ctx.fillStyle = C.muted; ctx.textAlign = 'center';
      labelY = o.lane ? g - o.lane * U - hpx / 2 - U * 0.2 : g + U * 0.6;
      ctx.fillText(o.label, labelX, labelY);
      ctx.restore();
    }
  }

  function drawBackdrop() {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, Hc);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    stars.forEach(function (s) { ctx.fillRect(s[0] * W, s[1] * Hc, 2, 2); });
    var g = gy();
    ctx.strokeStyle = C.ground; ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(4, U * 0.14);
    ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(W, g); ctx.stroke();
    if (state !== 'intro') {
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      var sp = 2.2 * U;
      for (var row = 0; row < 2; row++) {
        ctx.strokeStyle = row ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.55)';
        var shift = row ? sp / 2 : 0;
        for (var x = -((groundOff + shift) % sp); x < W; x += sp) {
          ctx.beginPath(); ctx.moveTo(x, g + U * (0.35 + 0.35 * row)); ctx.lineTo(x + 0.6 * U, g + U * (0.35 + 0.35 * row)); ctx.stroke();
        }
      }
    }
  }

  function drawPlayer() {
    var sit = P.down && !P.air && state === 'playing';
    var bob = (!P.air && ramp > 0 && !sit) ? Math.abs(Math.sin(runPhase)) * 0.03 * U : 0;
    drawDeer(ax() - 0.55 * U, gy() - P.y * U - bob,
      { pose: sit ? 'sit' : 'stand', nose: true, air: P.air, amp: ramp, phase: runPhase });
  }

  function drawHUD() {
    ctx.save();
    var fs = Math.max(11, U * 0.38);
    ctx.font = fs + 'px system-ui, sans-serif'; ctx.fillStyle = C.text;
    if (state === 'intro') {
      ctx.textAlign = 'center';
      ctx.font = 'bold ' + fs * 1.15 + 'px system-ui, sans-serif';
      ctx.fillText('Santa\'s Helper: press ↑ or ↓ to start', W / 2, U * 0.85);
      ctx.font = fs * 0.85 + 'px system-ui, sans-serif'; ctx.fillStyle = C.muted;
      ctx.fillText('↑ jump (again for double jump)   ↓ duck / fall faster', W / 2, U * 1.4);
    } else {
      ctx.textAlign = 'left'; ctx.fillText('Level ' + level, U * 0.4, U * 0.8);
      ctx.textAlign = 'right';
      ctx.fillText('Score ' + Math.floor(score) + '   Best ' + best, W - U * 0.4, U * 0.8);
      if (state === 'cutscene') {
        ctx.textAlign = 'center'; ctx.fillStyle = '#ffd54f';
        ctx.fillText('Level ' + level + ' complete!', W / 2, U * 0.8);
      }
    }
    if (state === 'dead') {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, W, Hc);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.font = 'bold ' + fs * 2 + 'px system-ui, sans-serif';
      ctx.fillText('Game over', W / 2, Hc * 0.4);
      ctx.font = fs * 1.1 + 'px system-ui, sans-serif';
      ctx.fillText('Score ' + Math.floor(score) + '  ·  Best ' + best, W / 2, Hc * 0.4 + fs * 1.8);
      ctx.fillStyle = C.muted;
      ctx.fillText('Press ↑ or ↓ to play again', W / 2, Hc * 0.4 + fs * 3.2);
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, W, Hc);
    drawBackdrop();
    obstacles.forEach(drawObstacle);
    if (finale) drawFinale(finale, cutT);
    drawPlayer();
    drawHUD();
  }

  /* ---------- Fallback: static avatar + decorated tree ---------- */
  function drawFallback() {
    try {
      state = 'intro'; groundOff = 0;
      ctx.clearRect(0, 0, W, Hc);
      drawBackdrop();
      drawDeer(W / 2 - 2.2 * U, gy(), { pose: 'stand', nose: true, amp: 0, phase: 0 });
      drawFinale({ x: W / 2 + 0.3 * U, w: 3.0, h: 4.2 }, 99);
      ctx.font = Math.max(11, U * 0.34) + 'px system-ui, sans-serif';
      ctx.fillStyle = C.muted; ctx.textAlign = 'center';
      ctx.fillText('Mini-game unavailable — sorting is not affected', W / 2, U * 0.9);
    } catch (e) {
      if (fallbackEl) fallbackEl.style.display = 'flex';
    }
  }

  function fail(e) {
    broken = true;
    try { cancelAnimationFrame(raf); } catch (_) { /* ignore */ }
    try { console.error('Santa\'s Helper stopped:', e); } catch (_) { /* ignore */ }
    drawFallback();
  }

  /* ---------- Loop ---------- */
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    try {
      var dt = Math.min(0.05, (ts - last) / 1000 || 0);
      last = ts;
      step(dt); draw();
    } catch (e) { fail(e); }
  }

  function init() {
    ctx = canvas.getContext('2d');
    if (!ctx) { if (fallbackEl) fallbackEl.style.display = 'flex'; return; }
    resize(); toIntro();
    var onResize = function () {
      try { resize(); if (broken) drawFallback(); else if (state === 'intro') buildIntro(); }
      catch (e) { fail(e); }
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(canvas.parentNode);
    else window.addEventListener('resize', onResize);
    raf = requestAnimationFrame(frame);
  }

  try { init(); } catch (e) { fail(e); }
})();

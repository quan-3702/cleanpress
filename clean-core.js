// CleanPress – voice repair DSP at 48 kHz: filters, hum removal, de-esser, leveler, loudness (EBU R128 / BS.1770),
// peak limiter, pause shortening, measurements (ACX check). No DOM – tested with node.
const CC = (() => {
const SR = 48000;
const db2 = (d) => Math.pow(10, d / 20), to_db = (g) => 20 * Math.log10(Math.max(1e-12, g));

// ---------- biquads (RBJ cookbook) ----------
function biquad(type, f, q, gainDb, sr) {
  sr = sr || SR;
  const A = Math.pow(10, (gainDb || 0) / 40), w = (2 * Math.PI * f) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
  else if (type === 'lowshelf' || type === 'highshelf') {
    const sq = 2 * Math.sqrt(A) * al, sign = type === 'lowshelf' ? 1 : -1;
    b0 = A * ((A + 1) - sign * (A - 1) * c + sq); b1 = 2 * sign * A * ((A - 1) - sign * (A + 1) * c); b2 = A * ((A + 1) - sign * (A - 1) * c - sq);
    a0 = (A + 1) + sign * (A - 1) * c + sq; a1 = -2 * sign * ((A - 1) + sign * (A + 1) * c); a2 = (A + 1) + sign * (A - 1) * c - sq;
  } else throw new Error('filter ' + type);
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0, z2: 0 };
}
const raw = (b, a) => ({ b0: b[0], b1: b[1], b2: b[2], a1: a[1], a2: a[2], z1: 0, z2: 0 });
function run(f, x, out) { // transposed direct form II, state kept in f (so chunks can follow each other)
  out = out || x; let z1 = f.z1, z2 = f.z2;
  const { b0, b1, b2, a1, a2 } = f;
  for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + z1; z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y; out[i] = y; }
  f.z1 = z1; f.z2 = z2; return out;
}
const runAll = (fs, x) => { for (const f of fs) run(f, x); return x; };

// ---------- hum (mains 50 / 60 Hz and harmonics) ----------
function goertzel(x, f, sr, a, b) { const w = (2 * Math.PI * f) / sr, c = 2 * Math.cos(w); let s1 = 0, s2 = 0; for (let i = a; i < b; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; } return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (b - a); }
// returns 50, 60 or 0. Looks at the quietest parts too, where hum is easiest to hear
function detectHum(x, sr) {
  sr = sr || SR;
  const len = Math.min(x.length, sr * 4), score = { 50: 0, 60: 0 };
  const starts = []; for (let k = 0; k < 6; k++) starts.push(Math.floor((x.length - len) * (k / 5)));
  for (const a of starts) for (const f0 of [50, 60]) {
    let tone = 0, side = 0;
    for (let h = 1; h <= 4; h++) { const f = f0 * h; tone += goertzel(x, f, sr, a, a + len); side += (goertzel(x, f - 7, sr, a, a + len) + goertzel(x, f + 7, sr, a, a + len)) / 2; }
    score[f0] += tone / (side + 1e-9);
  }
  const s50 = score[50] / starts.length, s60 = score[60] / starts.length;
  const best = s50 > s60 ? 50 : 60, sc = Math.max(s50, s60);
  return sc > 4 ? best : 0;
}
const humFilters = (f0, sr) => { const fs = []; for (let h = 1; h * f0 <= 1000 && h <= 10; h++) fs.push(biquad('notch', f0 * h, h === 1 ? 30 : 40, 0, sr)); return fs; };

// ---------- de-esser: turns down only the "sss" part when it is too loud ----------
function makeDeesser(amount, sr) {
  sr = sr || SR;
  return { hp: biquad('hp', 5000, 0.707, 0, sr), hp2: biquad('hp', 5000, 0.707, 0, sr), det: biquad('bp', 7000, 1.2, 0, sr), envS: 0, envF: 0, g: 1, amount: amount == null ? 0.7 : amount,
    att: Math.exp(-1 / (0.001 * sr)), rel: Math.exp(-1 / (0.06 * sr)) };
}
function deess(d, x) {
  const hi = new Float32Array(x.length); run(d.hp, x, hi); run(d.hp2, hi);
  const det = new Float32Array(x.length); run(d.det, x, det);
  let { envS, envF, g } = d; const { att, rel, amount } = d;
  for (let i = 0; i < x.length; i++) {
    const s = Math.abs(det[i]), f = Math.abs(x[i]);
    envS = s > envS ? att * envS + (1 - att) * s : rel * envS + (1 - rel) * s;
    envF = f > envF ? att * envF + (1 - att) * f : rel * envF + (1 - rel) * f;
    const ratio = envS / (envF + 1e-6); // share of "sss" in the sound
    let target = 1; if (ratio > 0.35 && envS > 0.003) target = Math.max(0.15, Math.pow(0.35 / ratio, 1.5 * amount));
    g = target < g ? target : g + (target - g) * 0.002;
    x[i] = x[i] - hi[i] + hi[i] * g;
  }
  d.envS = envS; d.envF = envF; d.g = g; return x;
}

// ---------- leveler: evens out loud and quiet speech (a gentle voice compressor) ----------
function makeLeveler(strength, sr) {
  sr = sr || SR; strength = strength == null ? 0.6 : strength;
  return { env: 0, g: 1, thr: db2(-30), ratio: 1 + 4 * strength, att: Math.exp(-1 / (0.008 * sr)), rel: Math.exp(-1 / (0.25 * sr)), gate: db2(-55) };
}
function level(c, x) {
  let { env, g } = c; const { thr, ratio, att, rel, gate } = c;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * x[i];
    env = v > env ? att * env + (1 - att) * v : rel * env + (1 - rel) * v;
    const e = Math.sqrt(env);
    let target = 1;
    if (e > thr) target = Math.pow(e / thr, 1 / ratio - 1); // above the threshold: turn down
    else if (e > gate) target = 1; // quiet speech stays as it is (no noise pumping)
    g += (target - g) * (target < g ? 0.004 : 0.0004);
    x[i] *= g;
  }
  c.env = env; c.g = g; return x;
}

// ---------- loudness: BS.1770-4 integrated (LUFS) with K-weighting, 400 ms blocks, gates −70 / −10 ----------
const kFilters = () => [raw([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), raw([1, -2, 1], [1, -1.99004745483398, 0.99007225036621])];
function makeMeter() { return { k: null, sum: 0, n: 0, blocks: [], step: 4800, cur: 0, curN: 0, ring: [] , peak: 0 }; }
// feed channels chunk by chunk (k-weighting state per channel)
function meter(m, chans) {
  if (!m.k) m.k = chans.map(() => kFilters());
  const n = chans[0].length, kw = chans.map((c, ci) => runAll(m.k[ci], Float32Array.from(c)));
  for (let i = 0; i < n; i++) {
    let s = 0; for (let ci = 0; ci < kw.length; ci++) { s += kw[ci][i] * kw[ci][i]; const a = Math.abs(chans[ci][i]); if (a > m.peak) m.peak = a; }
    m.cur += s; m.curN++;
    if (m.curN === m.step) { m.ring.push(m.cur / m.step); m.cur = 0; m.curN = 0; if (m.ring.length >= 4) { const z = (m.ring[0] + m.ring[1] + m.ring[2] + m.ring[3]) / 4; m.blocks.push(z); m.ring.shift(); } }
  }
}
function loudness(m) {
  const L = (z) => -0.691 + 10 * Math.log10(z);
  let bl = m.blocks.filter((z) => L(z) > -70);
  if (!bl.length) return -70;
  const rel = L(bl.reduce((a, b) => a + b, 0) / bl.length) - 10;
  bl = bl.filter((z) => L(z) > rel);
  return bl.length ? L(bl.reduce((a, b) => a + b, 0) / bl.length) : -70;
}
function lufs(chans) { const m = makeMeter(); meter(m, chans); return { lufs: loudness(m), peak: to_db(m.peak) }; }

// ---------- peak limiter (looks 5 ms ahead, so peaks are caught before they happen) ----------
// works on the whole signal (or a long chunk); returns the gain reduction in dB at the worst point
function limit(chans, ceilingDb, sr) {
  sr = sr || SR;
  const n = chans[0].length, ceil = db2(ceilingDb), L = Math.max(1, Math.round(0.005 * sr));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (const c of chans) { const v = Math.abs(c[i]); if (v > a) a = v; } need[i] = a > ceil ? ceil / a : 1; }
  // minimum over the next L samples (monotonic queue)
  const g = new Float32Array(n), q = new Int32Array(n); let h = 0, t = 0;
  for (let i = n - 1; i >= 0; i--) { while (t > h && need[q[t - 1]] >= need[i]) t--; q[t++] = i; while (q[h] > i + L) h++; g[i] = need[q[h]]; }
  // smooth: ramp down over L samples before a peak, recover over 80 ms after
  const relStep = 1 / (0.08 * sr);
  for (let i = 1; i < n; i++) if (g[i] > g[i - 1] + relStep) g[i] = g[i - 1] + relStep;
  const attStep = 1 / L;
  for (let i = n - 2; i >= 0; i--) if (g[i] > g[i + 1] + attStep) g[i] = g[i + 1] + attStep;
  let worst = 1;
  for (let i = 0; i < n; i++) { const gi = Math.min(1, g[i]); if (gi < worst) worst = gi; for (const c of chans) { let v = c[i] * gi; if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil; c[i] = v; } }
  return to_db(worst);
}

// ---------- pauses: long silences are shortened ----------
// returns the kept ranges [[a, b], …] in samples
function pauses(x, sr, opts, scale) {
  sr = sr || SR; opts = opts || {}; const k = scale || 1;
  const frame = Math.round(0.02 * sr), nf = Math.floor(x.length / frame), rms = new Float32Array(nf);
  for (let f = 0; f < nf; f++) { let s = 0; for (let i = f * frame; i < (f + 1) * frame; i++) s += x[i] * x[i]; rms[f] = Math.sqrt(s / frame) * k; }
  const sorted = Float32Array.from(rms).sort(), loud = sorted[Math.floor(nf * 0.9)] || 0;
  const thr = Math.max(db2(-55), loud * db2(-(opts.below || 32)));
  const maxP = Math.round((opts.max || 1.0) / 0.02), keep = Math.round((opts.keep || 0.6) / 0.02);
  const ranges = []; let start = 0, f = 0;
  while (f < nf) {
    if (rms[f] >= thr) { f++; continue; }
    let g = f; while (g < nf && rms[g] < thr) g++;
    if (g - f > maxP && f > 0 && g < nf) { const cutA = (f + Math.floor(keep / 2)) * frame, cutB = (g - Math.ceil(keep / 2)) * frame; ranges.push([start, cutA]); start = cutB; }
    f = g;
  }
  ranges.push([start, x.length]);
  return ranges;
}
// same, from 20 ms frame levels worked out elsewhere (n = number of samples)
function pausesFromRms(rms, n, sr, opts) {
  sr = sr || SR; opts = opts || {};
  const frame = Math.round(0.02 * sr), nf = rms.length;
  const sorted = Float32Array.from(rms).sort(), loud = sorted[Math.floor(nf * 0.9)] || 0;
  const thr = Math.max(db2(-60), loud * db2(-(opts.below || 30)));
  const maxP = Math.round((opts.max || 1.0) / 0.02), keep = Math.round((opts.keep || 0.6) / 0.02);
  const ranges = []; let start = 0, f = 0;
  while (f < nf) {
    if (rms[f] >= thr) { f++; continue; }
    let g = f; while (g < nf && rms[g] < thr) g++;
    if (g - f > maxP && f > 0 && g < nf) { ranges.push([start, (f + Math.floor(keep / 2)) * frame]); start = (g - Math.ceil(keep / 2)) * frame; }
    f = g;
  }
  ranges.push([start, n]);
  return ranges;
}
// downward expander: the room sound between words is turned down (helps the ACX noise floor)
function makeGate(sr) { sr = sr || SR; return { env: 0, g: 1, thr: db2(-45), floor: db2(-18), att: Math.exp(-1 / (0.003 * sr)), rel: Math.exp(-1 / (0.12 * sr)) }; }
function gate(gt, chans) {
  let { env, g } = gt; const { thr, floor, att, rel } = gt, x0 = chans[0];
  for (let i = 0; i < x0.length; i++) {
    let v = 0; for (const c of chans) { const a = Math.abs(c[i]); if (a > v) v = a; }
    env = v > env ? att * env + (1 - att) * v : rel * env + (1 - rel) * v;
    const target = env >= thr ? 1 : Math.max(floor, (env / thr) * (env / thr));
    g += (target - g) * (target > g ? 0.02 : 0.0008);
    for (const c of chans) c[i] *= g;
  }
  gt.env = env; gt.g = g;
}
// joins the kept ranges with 15 ms cross-fades
function cutRanges(chans, ranges, sr) {
  sr = sr || SR; const fade = Math.round(0.015 * sr);
  let total = 0; for (const [a, b] of ranges) total += b - a;
  total -= fade * (ranges.length - 1);
  return chans.map((c) => {
    const out = new Float32Array(Math.max(0, total)); let o = 0;
    ranges.forEach(([a, b], k) => {
      const len = b - a;
      if (k === 0) { out.set(c.subarray(a, b), 0); o = len; return; }
      const s = o - fade;
      for (let i = 0; i < fade && i < len; i++) { const w = i / fade; out[s + i] = out[s + i] * (1 - w) + c[a + i] * w; }
      if (len > fade) out.set(c.subarray(a + fade, b), s + fade);
      o = s + len;
    });
    return out;
  });
}

// ---------- measurements (ACX audiobook check: RMS −23…−18 dB, peak ≤ −3 dB, noise floor ≤ −60 dB) ----------
function measure(chans, sr) {
  sr = sr || SR;
  const x = chans[0], n = x.length; let peak = 0, sum = 0;
  for (const c of chans) for (let i = 0; i < n; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; sum += c[i] * c[i]; }
  const rms = Math.sqrt(sum / (n * chans.length));
  // noise floor: the quietest half-second windows (ACX: the room tone between words)
  const w = Math.round(0.5 * sr), vals = [];
  for (let a = 0; a + w <= n; a += w) { let s = 0; for (let i = a; i < a + w; i++) s += x[i] * x[i]; vals.push(Math.sqrt(s / w)); }
  vals.sort((p, q) => p - q);
  const floor = vals.length ? vals[Math.floor(vals.length * 0.05)] : 0;
  const L = lufs(chans).lufs;
  return { peak: to_db(peak), rms: to_db(rms), floor: to_db(floor), lufs: L };
}
const acx = (m) => ({ rms: m.rms >= -23 && m.rms <= -18, peak: m.peak <= -3, floor: m.floor <= -60 });

// ---------- presets ----------
const PRESETS = {
  podcast: { gate: false, name: 'Podcast', lufs: -16, ceil: -1, hp: true, noise: 100, hum: 'auto', deess: true, level: 0.5, eq: true, pauses: false },
  youtube: { gate: false, name: 'YouTube / video', lufs: -14, ceil: -1, hp: true, noise: 100, hum: 'auto', deess: true, level: 0.5, eq: true, pauses: false },
  acx: { gate: true, name: 'Audiobook (ACX)', lufs: -20, ceil: -3.5, hp: true, noise: 100, hum: 'auto', deess: true, level: 0.4, eq: false, pauses: false },
  lecture: { gate: false, name: 'Lecture / meeting', lufs: -16, ceil: -1, hp: true, noise: 100, hum: 'auto', deess: false, level: 0.8, eq: true, pauses: true },
  memo: { gate: false, name: 'Voice memo', lufs: -16, ceil: -1, hp: true, noise: 80, hum: 'auto', deess: false, level: 0.6, eq: false, pauses: false },
  broadcast: { gate: false, name: 'Radio / broadcast (EBU R128)', lufs: -23, ceil: -1, hp: true, noise: 100, hum: 'auto', deess: true, level: 0.5, eq: false, pauses: false },
};

// ---------- the chain after noise removal (chunk by chunk, state kept) ----------
function makeChain(o, nch, hum) {
  return {
    o, hum,
    ch: Array.from({ length: nch }, () => ({
      hp: o.hp ? [biquad('hp', 80, 0.707), biquad('hp', 80, 0.707)] : [],
      hum: hum ? humFilters(hum) : [],
      eq: o.eq ? [biquad('peak', 3500, 1, 2.5), biquad('lowshelf', 180, 0.707, -1.5)] : [],
      de: o.deess ? makeDeesser(0.7) : null,
      lv: o.level > 0 ? makeLeveler(o.level) : null,
    })),
  };
}
// pre: filters that run before the noise removal (rumble, hum)
function pre(chain, chans) { chans.forEach((x, k) => { const c = chain.ch[k]; runAll(c.hp, x); runAll(c.hum, x); }); return chans; }
// post: what runs after it (EQ, de-esser, leveler)
function post(chain, chans) { chans.forEach((x, k) => { const c = chain.ch[k]; runAll(c.eq, x); if (c.de) deess(c.de, x); if (c.lv) level(c.lv, x); }); return chans; }

const clock = (s) => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const safeName = (s) => String(s || 'Recording').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Recording';
function peaks(x, count) { const out = new Float32Array(count), per = Math.max(1, Math.floor(x.length / count)); for (let p = 0; p < count; p++) { let m = 0; for (let i = p * per, e = Math.min(x.length, i + per); i < e; i += 3) { const v = Math.abs(x[i]); if (v > m) m = v; } out[p] = m; } return out; }
function wav(chans, rate, bits) {
  bits = bits || 16; const nc = chans.length, n = chans[0].length, bps = bits / 8, size = 44 + n * nc * bps, buf = new ArrayBuffer(size), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, size - 8, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, rate, true); v.setUint32(28, rate * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true); str(36, 'data'); v.setUint32(40, n * nc * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const s = Math.max(-1, Math.min(1, chans[c][i])); if (bits === 16) { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; } else { const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; } }
  return new Uint8Array(buf);
}

return { SR, db2, to_db, biquad, run, runAll, detectHum, humFilters, makeDeesser, deess, makeLeveler, level, makeMeter, meter, loudness, lufs, limit, pauses, pausesFromRms, makeGate, gate, cutRanges, measure, acx, PRESETS, makeChain, pre, post, clock, safeName, peaks, wav, goertzel };
})();
if (typeof module !== 'undefined') module.exports = CC;

// CleanPress – MP3 encoder (lamejs, LGPL), mono or stereo, streamed: open → chunk … → end.
importScripts('lame.min.js');
const enc = new Map();
const i16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const s = f[i] > 1 ? 1 : f[i] < -1 ? -1 : f[i]; o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return o; };
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'open') enc.set(m.id, { e: new lamejs.Mp3Encoder(m.ch, m.rate || 48000, m.kbps || 192), parts: [], size: 0, ch: m.ch });
    else if (m.type === 'chunk') {
      const s = enc.get(m.id), L = i16(m.L), R = s.ch > 1 ? i16(m.R) : null, N = 1152 * 20;
      for (let i = 0; i < L.length; i += N) { const o = R ? s.e.encodeBuffer(L.subarray(i, i + N), R.subarray(i, i + N)) : s.e.encodeBuffer(L.subarray(i, i + N)); if (o.length) { s.parts.push(new Uint8Array(o)); s.size += o.length; } }
      self.postMessage({ type: 'ack', id: m.id });
    } else if (m.type === 'end') {
      const s = enc.get(m.id); enc.delete(m.id);
      const o = s.e.flush(); if (o.length) { s.parts.push(new Uint8Array(o)); s.size += o.length; }
      const out = new Uint8Array(s.size); let k = 0; for (const p of s.parts) { out.set(p, k); k += p.length; }
      self.postMessage({ type: 'done', id: m.id, mp3: out }, [out.buffer]);
    }
  } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) }); }
};

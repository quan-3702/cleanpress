// CleanPress – noise removal worker: DeepFilterNet 3 (MIT / Apache-2.0, by H. Schröter et al.; WebAssembly build by lofcz)
// runs on this computer at 48 kHz. Each job is one piece of the recording with one second before it to warm up.
import { DeepFilter } from './df.js';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@lofcz/deepfilternet-web@0.1.0/dist/df_bg.wasm';
const CACHE = 'cleanpress-model';
const DELAY = 1440; // samples the filter is late (2 frames look-ahead + 1 frame)
let wasmBlobUrl = null;
async function wasm() {
  if (wasmBlobUrl) return wasmBlobUrl;
  let cache = null; try { cache = await caches.open(CACHE); } catch (_) {}
  let res = cache ? await cache.match(WASM_URL) : null, bytes;
  if (res) bytes = new Uint8Array(await res.arrayBuffer());
  else {
    res = await fetch(WASM_URL); if (!res.ok) throw new Error('The noise removal AI could not be downloaded (' + res.status + '). Check the internet connection.');
    const total = Number(res.headers.get('Content-Length')) || 34135648, rd = res.body.getReader(), parts = []; let got = 0, last = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (got - last > 1e6) { last = got; postMessage({ type: 'progress', phase: 'download', p: got / total }); } }
    bytes = new Uint8Array(got); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
    if (cache) try { await cache.put(WASM_URL, new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } })); } catch (_) {}
  }
  wasmBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
  return wasmBlobUrl;
}
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'run') return;
  try {
    const url = await wasm();
    const df = await DeepFilter.create({ wasmUrl: url, attenuationLimit: 100 });
    const F = df.frameLength, x = m.x, need = x.length + DELAY, frames = Math.ceil(need / F);
    const inp = new Float32Array(frames * F); inp.set(x);
    const out = new Float32Array(frames * F);
    for (let f = 0; f < frames; f++) { out.set(df.process(inp.subarray(f * F, (f + 1) * F)), f * F); if (f % 2000 === 0) postMessage({ type: 'tick', id: m.id, p: f / frames }); }
    df.destroy();
    const y = out.slice(DELAY + m.warm, DELAY + x.length);
    postMessage({ type: 'done', id: m.id, y }, [y.buffer]);
  } catch (err) { postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) }); }
};

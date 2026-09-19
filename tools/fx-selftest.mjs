// Самопроверка голосовых эффектов без ушей: синтетическая «речь» -> каждый режим -> метрики.
// В консоли страницы:  (await import('/tools/fx-selftest.mjs')).run()
import { VoiceChain, VOICE_NAMES } from '../src/voicefx.js';

const SR = 48000, DUR = 3.2;

function makeSpeech() {
  const n = Math.floor(SR * DUR), x = new Float32Array(n);
  const vowels = [[700, 1100, 2500], [300, 2200, 3000], [320, 800, 2500], [550, 1800, 2600]];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = 125 + 40 * Math.sin(2 * Math.PI * 0.5 * t) + 15 * Math.sin(2 * Math.PI * 2.1 * t);
    ph += f0 / SR; ph -= Math.floor(ph);
    const F = vowels[Math.floor(t * 2.2) % 4];
    let s = 0;
    for (let k = 1; k <= 36; k++) {
      const fk = k * f0;
      if (fk > 7000) break;
      let env = 0;
      for (const f of F) env += Math.exp(-(((fk - f) / (0.14 * f + 80)) ** 2));
      s += (env * Math.sin(2 * Math.PI * k * ph)) / k;
    }
    x[i] = s * Math.pow(Math.max(0, Math.sin(2 * Math.PI * 2.2 * t)), 0.6);
  }
  let pk = 0;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= 0.25 / pk;
  return x;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = i + j + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function analyze(x) {
  let nan = 0, pk = 0, e = 0;
  for (const v of x) { if (!Number.isFinite(v)) nan++; pk = Math.max(pk, Math.abs(v)); e += v * v; }
  const N = 4096, bands = [[0, 300], [300, 1000], [1000, 3000], [3000, 6000], [6000, 24000]], acc = [0, 0, 0, 0, 0];
  const re = new Float64Array(N), im = new Float64Array(N);
  let cn = 0, cd = 0;
  for (let s = 0; s + N <= x.length; s += N) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = k * SR / N, p = re[k] * re[k] + im[k] * im[k];
      cn += f * p; cd += p;
      for (let b = 0; b < 5; b++) if (f >= bands[b][0] && f < bands[b][1]) acc[b] += p;
    }
  }
  const tot = acc.reduce((a, b) => a + b, 0) || 1;
  const W = Math.floor(SR * 0.04), f0s = [];
  for (let s = 0; s + W * 2 < x.length; s += W >> 1) {
    let e0 = 0;
    for (let i = 0; i < W; i++) e0 += x[s + i] * x[s + i];
    if (e0 / W < 1e-4) continue;
    let best = 0, bl = 0;
    for (let l = Math.floor(SR / 400); l <= Math.floor(SR / 70); l++) {
      let c = 0;
      for (let i = 0; i < W; i++) c += x[s + i] * x[s + i + l];
      if (c > best) { best = c; bl = l; }
    }
    if (best / e0 > 0.5) f0s.push(SR / bl);
  }
  f0s.sort((a, b) => a - b);
  const med = f0s.length ? f0s[f0s.length >> 1] : 0;
  const semis = f0s.map((f) => 12 * Math.log2(f / (med || 1)));
  const m = semis.reduce((a, b) => a + b, 0) / (semis.length || 1);
  const std = Math.sqrt(semis.reduce((a, b) => a + (b - m) ** 2, 0) / (semis.length || 1));
  return {
    nan, peak: +pk.toFixed(3), rmsDb: +(20 * Math.log10(Math.sqrt(e / x.length) + 1e-9)).toFixed(1),
    centroidHz: Math.round(cn / cd), bandPct_0_300_1k_3k_6k_up: acc.map((a) => +(100 * a / tot).toFixed(1)),
    f0MedianHz: Math.round(med), f0StdSemitones: +std.toFixed(2),
  };
}

export async function run() {
  const speech = makeSpeech();
  const out = { input: analyze(speech) };
  for (const name of VOICE_NAMES) {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * (DUR + 0.6)), SR);
    await VoiceChain.load(ctx);
    const buf = ctx.createBuffer(1, speech.length, SR);
    buf.copyToChannel(speech, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const chain = new VoiceChain(ctx);
    chain.setVoice(name);
    await new Promise((r) => setTimeout(r, 80));
    src.connect(chain.input);
    chain.output.connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    out[name] = analyze(rendered.getChannelData(0).subarray(0, speech.length));
  }
  return out;
}

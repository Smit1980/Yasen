// AudioWorklet: обработка голоса так, чтобы он звучал «не по-человечески».
// Режимы (порт: {mode}):
//   clean      - без обработки
//   assistant  - тёмный синтетический голос: понижение тона, удвоение, металлический гребень
//   vocoder    - роботизированный вокодер на пилообразной несущей (монотонный голос)
//   choir      - «хор»: несколько слоёв голоса на разной высоте + кольцевая модуляция + bitcrush
// Тембр (эквалайзер) и реверберация делаются штатными нодами в voicefx.js.

const TAU = Math.PI * 2;

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  bandpass(fs, f, q) {
    const w = (TAU * f) / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; this.a1 = (-2 * cw) / a0; this.a2 = (1 - al) / a0;
    return this;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class Delay {
  constructor(n) { this.n = n; this.buf = new Float32Array(n); this.i = 0; }
  push(x) { this.buf[this.i] = x; this.i = (this.i + 1) % this.n; }
  // задержка d отсчётов (d >= 1), интерполяция линейная
  tap(d) {
    let idx = this.i - d;
    while (idx < 0) idx += this.n;
    const i0 = Math.floor(idx), f = idx - i0;
    return this.buf[i0 % this.n] * (1 - f) + this.buf[(i0 + 1) % this.n] * f;
  }
}

// сдвиг высоты: две линии задержки с плавным переходом между ними
class PitchShifter {
  constructor(fs, winMs = 50) {
    this.W = Math.round((fs * winMs) / 1000);
    this.d = new Delay(this.W * 2 + 8);
    this.phase = 0;
  }
  process(x, ratio) {
    this.d.push(x);
    this.phase += (1 - ratio) / this.W;
    this.phase -= Math.floor(this.phase);
    const p2 = (this.phase + 0.5) % 1;
    const g1 = Math.sin(Math.PI * this.phase) ** 2, g2 = Math.sin(Math.PI * p2) ** 2;
    return this.d.tap(1 + this.phase * this.W) * g1 + this.d.tap(1 + p2 * this.W) * g2;
  }
}

class Vocoder {
  constructor(fs, bands = 24, fLo = 110, fHi = 6800) {
    this.fs = fs; this.n = bands;
    this.freqs = new Float32Array(bands);
    this.an1 = []; this.an2 = []; this.sy1 = []; this.sy2 = [];
    this.env = new Float32Array(bands);
    this.nm = new Float32Array(bands);
    for (let i = 0; i < bands; i++) {
      const f = fLo * Math.pow(fHi / fLo, i / (bands - 1));
      this.freqs[i] = f;
      this.an1.push(new Biquad().bandpass(fs, f, 4.5)); this.an2.push(new Biquad().bandpass(fs, f, 4.5));
      this.sy1.push(new Biquad().bandpass(fs, f, 4.5)); this.sy2.push(new Biquad().bandpass(fs, f, 4.5));
      const t = Math.min(1, Math.max(0, (f - 2500) / 2500));
      this.nm[i] = t * t * (3 - 2 * t);
    }
    this.coef = 1 - Math.exp(-1 / (0.006 * fs));
    this.phase = 0; this.f0 = 100; this.seed = 12345; this.gain = 1.1;
    this.bandGain = this.calibrate();
  }

  // Несущая (пила + шум) по-разному ослабляется разными полосами; выравниваем каждую полосу
  // до единичного RMS, чтобы огибающая спектра голоса переносилась на несущую без перекоса.
  calibrate() {
    const g = new Float32Array(this.n);
    let seed = 777;
    const nS = Math.round(this.fs * 0.5);
    for (let i = 0; i < this.n; i++) {
      const f1 = new Biquad().bandpass(this.fs, this.freqs[i], 4.5), f2 = new Biquad().bandpass(this.fs, this.freqs[i], 4.5);
      let ph = 0, e = 0;
      for (let k = 0; k < nS; k++) {
        ph += this.f0 / this.fs; if (ph >= 1) ph -= 1;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const c = (2 * ph - 1) * (1 - this.nm[i]) + ((seed / 4294967296) * 2 - 1) * this.nm[i];
        const y = f2.process(f1.process(c));
        if (k > nS / 4) e += y * y;
      }
      // лёгкий подъём верхних полос: робот-вокодер остаётся разборчивым
      g[i] = Math.pow(this.freqs[i] / 500, 0.35) / Math.sqrt(e / (nS * 0.75) + 1e-12);
    }
    return g;
  }
  process(x) {
    this.phase += this.f0 / this.fs;
    if (this.phase >= 1) this.phase -= 1;
    const saw = 2 * this.phase - 1;
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    const noise = (this.seed / 4294967296) * 2 - 1;
    let y = 0;
    for (let i = 0; i < this.n; i++) {
      const m = this.an2[i].process(this.an1[i].process(x));
      this.env[i] += this.coef * (Math.abs(m) - this.env[i]);
      const c = saw * (1 - this.nm[i]) + noise * this.nm[i];
      y += this.sy2[i].process(this.sy1[i].process(c)) * this.env[i] * this.bandGain[i];
    }
    return y * this.gain;
  }
}

class VoiceFx extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.fs = fs;
    this.mode = 'clean';
    this.psA = new PitchShifter(fs); this.psB = new PitchShifter(fs);
    this.psC = new PitchShifter(fs); this.psD = new PitchShifter(fs);
    this.dA = new Delay(Math.round(fs * 0.06)); this.dB = new Delay(Math.round(fs * 0.06)); this.dC = new Delay(Math.round(fs * 0.06));
    this.comb = new Delay(Math.round(fs * 0.03));
    this.voc = new Vocoder(fs);
    this.rmPhase = 0;
    this.crushHold = 0; this.crushCnt = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.mode) this.mode = e.data.mode; };
  }

  crush(x, levels, hold) {
    if (this.crushCnt++ % hold === 0) this.crushHold = Math.round(x * levels) / levels;
    return this.crushHold;
  }

  tick(x) {
    switch (this.mode) {
      case 'assistant': {
        // основной голос ниже на ~2 полутона + вторая копия с расстройкой и задержкой 16 мс
        const a = this.psA.process(x, 0.89);
        const b = this.psB.process(x, 0.89 * 1.014);
        this.dA.push(b);
        const doubled = a * 0.75 + this.dA.tap(this.fs * 0.016) * 0.5;
        // металлический гребень (~180 Гц), придаёт «цифровой» оттенок
        const c = doubled + 0.32 * this.comb.tap(this.fs * 0.0055);
        this.comb.push(c);
        return Math.tanh(c * 1.2);
      }
      case 'vocoder': {
        const v = this.voc.process(x);
        const dry = x * 0.15;
        // лёгкий bitcrush для цифровой зернистости
        const c = this.crush(v + dry, 512, 2);
        return Math.tanh(c * 1.1);
      }
      case 'choir': {
        // три слоя: -5 полутонов, оригинал, +7 полутонов; задержки разные - ансамбль
        const low = this.psC.process(x, 0.749);
        const high = this.psD.process(x, 1.498);
        this.dA.push(low); this.dB.push(x); this.dC.push(high);
        const ens = this.dA.tap(this.fs * 0.009) * 0.6 + this.dB.tap(this.fs * 0.023) * 0.8 + this.dC.tap(this.fs * 0.037) * 0.32;
        // кольцевая модуляция 55 Гц: «инопланетный» тембр
        this.rmPhase += 55 / this.fs;
        if (this.rmPhase >= 1) this.rmPhase -= 1;
        const rm = ens * (0.72 + 0.28 * Math.sin(TAU * this.rmPhase));
        const cr = this.crush(rm, 256, 3);
        return Math.tanh((rm * 0.7 + cr * 0.3) * 1.1);
      }
      default:
        return x;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const inp = inputs[0];
    const L = inp && inp[0] ? inp[0] : null;
    const R = inp && inp[1] ? inp[1] : null;
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      const x = L ? (R ? 0.5 * (L[i] + R[i]) : L[i]) : 0;
      let y = this.tick(x);
      if (!Number.isFinite(y)) y = 0;
      for (let c = 0; c < out.length; c++) out[c][i] = y;
    }
    return true;
  }
}

registerProcessor('voicefx', VoiceFx);

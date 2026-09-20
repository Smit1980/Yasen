// Слух: забирает звук с микрофона, находит границы фраз по громкости (VAD) и отдаёт каждую фразу
// как WAV 16 кГц моно 16 бит. Распознаёт речь сервер (faster-whisper), поэтому всё остаётся на компьютере.

const OUT_RATE = 16000;

// ---- WAV
function to16k(float, sr) {
  const ratio = sr / OUT_RATE;
  const n = Math.floor(float.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {           // усреднение по окну: простой антиалиасинг
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.min(float.length, Math.floor((i + 1) * ratio)));
    let s = 0;
    for (let j = a; j < b; j++) s += float[j];
    out[i] = s / (b - a);
  }
  return out;
}

export function encodeWav(float, sr) {
  const x = to16k(float, sr);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const gain = peak > 0.001 && peak < 0.25 ? 0.4 / peak : 1;   // тихую запись подтягиваем
  const buf = new ArrayBuffer(44 + x.length * 2);
  const dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, OUT_RATE, true); dv.setUint32(28, OUT_RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i] * gain)) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- определение речи по громкости (без сети и моделей)
export class Vad {
  constructor({ onUtterance, onStart = () => {}, sampleRate = 48000 } = {}) {
    this.onUtterance = onUtterance;
    this.onStart = onStart;
    this.sr = sampleRate;
    this.muted = false;
    this.floor = 0.004;          // оценка шума в комнате
    this.rms = 0;                // текущая громкость (для индикатора)
    this.threshold = 0.015;
    this.speaking = false;
    this.reset();
  }

  reset() {
    this.pre = [];
    this.frames = [];
    this.hits = 0;
    this.voiced = 0;
    this.silent = 0;
    this.speaking = false;
  }

  push(frame) {
    const sec = frame.length / this.sr;
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    this.rms = Math.sqrt(s / frame.length);
    if (this.muted) { this.reset(); return; }   // пока говорит Ясень, себя не слушаем
    this.threshold = Math.max(0.015, this.floor * 3.5);
    const loud = this.rms > this.threshold;

    if (!this.speaking) {
      this.pre.push(frame);
      if (this.pre.length > 8) this.pre.shift();   // ~350 мс до начала фразы, чтобы не съесть первый звук
      if (loud) {
        if (++this.hits >= 2) {
          this.speaking = true;
          this.frames = [...this.pre];
          this.voiced = this.hits;
          this.silent = 0;
          this.onStart();
        }
      } else {
        this.hits = 0;
        this.floor = this.floor * 0.98 + this.rms * 0.02;
      }
      return;
    }

    this.frames.push(frame);
    if (loud) { this.voiced++; this.silent = 0; } else this.silent++;
    const dur = this.frames.length * sec;
    if (this.silent * sec >= 0.9 || dur > 20) this.finish(sec);
  }

  finish(sec) {
    const enough = this.voiced * sec >= 0.35;   // короткие щелчки и шум отбрасываем
    const frames = this.frames;
    this.reset();
    if (!enough) return;
    const total = frames.reduce((a, f) => a + f.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const f of frames) { all.set(f, o); o += f.length; }
    this.onUtterance(encodeWav(all, this.sr));
  }
}

// ---- подключение к микрофону
export class Listener {
  constructor(ctx) {
    this.ctx = ctx;
    this.vad = null;
    this.node = null;
    this.src = null;
    this.sink = null;
    this.loaded = false;
  }

  get level() { return this.vad ? this.vad.rms : 0; }
  get threshold() { return this.vad ? this.vad.threshold : 0; }
  get speaking() { return !!this.vad && this.vad.speaking; }
  set muted(v) { if (this.vad) this.vad.muted = v; }

  async start(stream, { onUtterance, onStart }) {
    if (!this.loaded) {
      await this.ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      this.loaded = true;
    }
    this.vad = new Vad({ onUtterance, onStart, sampleRate: this.ctx.sampleRate });
    this.src = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;   // узел должен быть подключён к выходу, но звука не даёт
    this.node.port.onmessage = (e) => this.vad && this.vad.push(e.data);
    this.src.connect(this.node).connect(this.sink).connect(this.ctx.destination);
  }

  stop() {
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); }
    if (this.src) this.src.disconnect();
    if (this.sink) this.sink.disconnect();
    this.node = this.src = this.sink = null;
    this.vad = null;
  }
}

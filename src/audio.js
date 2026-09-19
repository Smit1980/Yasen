// Аудио-движок: превращает звук (файл / микрофон / внешние уровни от агента)
// в числа для шейдера и мимики: level, bass, mid, high (0..1, сглаженные) и tone (-1..1, «яркость» звука).
// Голос из файла проходит цепочку эффектов (voicefx.js), анализатор стоит после неё,
// поэтому лицо двигается в такт тому, что реально звучит.
import { VoiceChain } from './voicefx.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.time = null;
    this.level = 0; this.bass = 0; this.mid = 0; this.high = 0; this.tone = 0;
    this.external = null;       // {level,bass,mid,high,until}
    this.micStream = null;
    this.micSource = null;
    this.elementSources = new WeakMap();
    this.sfxOn = true;
    this.voice = 'clean';
    this.chain = null;
    this.chainReady = null;
    this.sourceKind = null;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.6;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.time = new Uint8Array(this.analyser.fftSize);
      // цепочка эффектов: если worklet не загрузится, файлы играют без обработки
      this.chainReady = VoiceChain.load(this.ctx).then(() => {
        this.chain = new VoiceChain(this.ctx);
        this.chain.setVoice(this.voice);
        this.chain.output.connect(this.analyser);
        this.chain.output.connect(this.ctx.destination);
      }).catch((e) => { console.warn('voicefx недоступен:', e); this.chain = null; });
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVoice(name) {
    this.voice = name;
    if (this.chain) this.chain.setVoice(name);
  }

  // <audio> → (эффекты) → анализатор + колонки
  async connectElement(el) {
    this.ensure();
    await this.chainReady;
    let src = this.elementSources.get(el);
    if (!src) {
      src = this.ctx.createMediaElementSource(el);
      this.elementSources.set(el, src);
    }
    if (this.chain) {
      src.connect(this.chain.input);
    } else {
      src.connect(this.analyser);
      src.connect(this.ctx.destination);
    }
    this.sourceKind = 'element';
    return src;
  }

  disconnectElement(el) {
    const src = this.elementSources.get(el);
    if (src) { try { src.disconnect(); } catch { /* уже отключён */ } }
  }

  // Микрофон только анализируем, в колонки не отдаём (иначе эхо)
  async startMic() {
    this.ensure();
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.micSource.connect(this.analyser);
    this.sourceKind = 'mic';
  }

  stopMic() {
    if (this.micSource) { this.micSource.disconnect(); this.micSource = null; }
    if (this.micStream) { this.micStream.getTracks().forEach((t) => t.stop()); this.micStream = null; }
    if (this.sourceKind === 'mic') this.sourceKind = null;
  }

  get micActive() { return !!this.micStream; }

  // Уровни, присланные агентом по WebSocket (действуют 400 мс после последнего пакета)
  setExternal(level, bands) {
    const l = clamp01(level);
    const b = bands && bands.length >= 3 ? bands.map(clamp01) : [l * 0.9, l * 0.7, l * 0.5];
    this.external = { level: l, bass: b[0], mid: b[1], high: b[2], until: performance.now() + 400 };
  }

  // demo: {level,bass,mid,high} или null
  update(dt, demo) {
    let tl = 0, tb = 0, tm = 0, th = 0, tt = 0;
    const now = performance.now();
    if (demo) {
      ({ level: tl, bass: tb, mid: tm, high: th } = demo);
      tt = toneFromBands(tb, tm, th);
    } else if (this.external && this.external.until > now) {
      ({ level: tl, bass: tb, mid: tm, high: th } = this.external);
      tt = toneFromBands(tb, tm, th);
    } else if (this.analyser && (this.sourceKind === 'element' || this.sourceKind === 'mic')) {
      this.analyser.getByteFrequencyData(this.freq);
      this.analyser.getByteTimeDomainData(this.time);
      let s = 0;
      for (let i = 0; i < this.time.length; i++) { const v = (this.time[i] - 128) / 128; s += v * v; }
      tl = clamp01(Math.sqrt(s / this.time.length) * 3.2);
      tb = band(this.freq, 0, 4);
      tm = band(this.freq, 4, 28);
      th = band(this.freq, 28, 110);
      // спектральный центроид 170..5000 Гц -> tone
      const binHz = this.ctx.sampleRate / this.analyser.fftSize;
      // байты анализатора - децибелы (-100..-30 dB), для центроида нужна линейная амплитуда
      let num = 0, den = 0;
      for (let i = 2; i < 60; i++) { const a = DB_LUT[this.freq[i]]; num += i * a; den += a; }
      if (den > 3e-5) tt = clamp(Math.log2((num / den) * binHz / 1000), -1, 1);
    }
    // быстрая атака, медленный спад
    const k = (cur, target) => cur + (target - cur) * (1 - Math.exp(-dt * (target > cur ? 28 : 7)));
    this.level = k(this.level, tl);
    this.bass = k(this.bass, tb);
    this.mid = k(this.mid, tm);
    this.high = k(this.high, th);
    this.tone += (tt - this.tone) * (1 - Math.exp(-dt * 12));
  }

  // ---- звуковые эффекты (синтез, без файлов) ----
  blip(f0, f1, dur = 0.18, gain = 0.05, type = 'sine') {
    if (!this.sfxOn) return;
    const ctx = this.ensure();
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  sfxState(name) {
    const map = {
      idle: [520, 320], listening: [420, 840], thinking: [700, 700], speaking: [360, 620],
    };
    const [a, b] = map[name] || [440, 440];
    this.blip(a, b, name === 'thinking' ? 0.12 : 0.2, 0.045, name === 'thinking' ? 'triangle' : 'sine');
    if (name === 'thinking') setTimeout(() => this.blip(900, 900, 0.1, 0.03, 'triangle'), 140);
  }

  sfxShape() { this.blip(200, 1200, 0.3, 0.04, 'sawtooth'); }
}

// значение байта анализатора -> линейная амплитуда
const DB_LUT = Float32Array.from({ length: 256 }, (_, b) => (b === 0 ? 0 : 10 ** ((-100 + (b / 255) * 70) / 20)));

function clamp01(v) { return Math.min(1, Math.max(0, Number(v) || 0)); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function band(data, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += data[i];
  return clamp01((s / (to - from) / 255) * 1.6);
}

// тон по трём полосам (низ ~150 Гц, середина ~900 Гц, верх ~3500 Гц)
function toneFromBands(b, m, h) {
  const sum = b + m + h;
  if (sum < 1e-3) return 0;
  const fc = (b * 150 + m * 900 + h * 3500) / sum;
  return clamp(Math.log2(fc / 1000), -1, 1);
}

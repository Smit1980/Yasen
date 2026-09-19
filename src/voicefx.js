// Цепочка голосовых эффектов: worklet (voicefx-worklet.js) -> эквалайзер -> реверберация.
// Параметры «Ассистента» подобраны по измерению звука из референсного ролика:
// энергия почти вся ниже 1 кГц (тёмный, «бочковой» голос), выше 3 кГц резкий спад,
// выше 6 кГц практически пусто, гармоники очень чистые.

export const VOICES = {
  clean: {
    label: 'Оригинал', mode: 'clean',
    hp: 20, low: [250, 0], peak: [520, 0, 1], lp: 20000, lp2: 20000, wet: 0, ir: [0.5, 8], gain: 1,
  },
  assistant: {
    label: 'Ассистент', mode: 'assistant',
    hp: 70, low: [250, 6], peak: [520, 3, 1], lp: 2600, lp2: 3200, wet: 0.22, ir: [1.1, 4.5], gain: 0.8,
  },
  vocoder: {
    label: 'Вокодер', mode: 'vocoder',
    hp: 90, low: [200, 2], peak: [1500, 2, 0.8], lp: 6500, lp2: 9000, wet: 0.1, ir: [0.6, 8], gain: 1.25,
  },
  choir: {
    label: 'Хор', mode: 'choir',
    hp: 140, low: [250, -2], peak: [3000, 3, 0.7], lp: 12000, lp2: 16000, wet: 0.38, ir: [2.6, 2.2], gain: 1.4,
  },
};
export const VOICE_NAMES = Object.keys(VOICES);

// импульс реверберации: затухающий шум, чем позже - тем темнее
function makeIR(ctx, seconds, decay) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    let seed = 1234 + ch * 777;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed / 4294967296) * 2 - 1;
      const t = i / len;
      const k = 0.15 + 0.8 * t;              // сглаживание растёт со временем
      lp += (noise - lp) * (1 - k);
      d[i] = lp * Math.exp(-t * decay * 3) * (t < 0.002 ? t / 0.002 : 1);
    }
  }
  return buf;
}

export class VoiceChain {
  static async load(ctx) {
    await ctx.audioWorklet.addModule(new URL('./voicefx-worklet.js', import.meta.url));
  }

  constructor(ctx) {
    this.ctx = ctx;
    const mk = (type) => { const f = ctx.createBiquadFilter(); f.type = type; return f; };
    this.input = ctx.createGain();
    this.fx = new AudioWorkletNode(ctx, 'voicefx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.hp = mk('highpass');
    this.low = mk('lowshelf');
    this.peak = mk('peaking');
    this.lp = mk('lowpass');
    this.lp2 = mk('lowpass');
    this.lp.Q.value = 0.707; this.lp2.Q.value = 0.707;
    this.dry = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.wet = ctx.createGain();
    this.output = ctx.createGain();

    this.input.connect(this.fx).connect(this.hp).connect(this.low).connect(this.peak).connect(this.lp).connect(this.lp2);
    this.lp2.connect(this.dry).connect(this.output);
    this.lp2.connect(this.conv).connect(this.wet).connect(this.output);
    this.voice = 'clean';
    this.setVoice('clean');
  }

  setVoice(name) {
    const v = VOICES[name];
    if (!v) return;
    this.voice = name;
    const t = this.ctx.currentTime;
    this.fx.port.postMessage({ mode: v.mode });
    this.hp.frequency.setValueAtTime(v.hp, t);
    this.low.frequency.setValueAtTime(v.low[0], t); this.low.gain.setValueAtTime(v.low[1], t);
    this.peak.frequency.setValueAtTime(v.peak[0], t); this.peak.gain.setValueAtTime(v.peak[1], t); this.peak.Q.setValueAtTime(v.peak[2], t);
    this.lp.frequency.setValueAtTime(v.lp, t);
    this.lp2.frequency.setValueAtTime(v.lp2, t);
    this.conv.buffer = makeIR(this.ctx, v.ir[0], v.ir[1]);
    this.wet.gain.setValueAtTime(v.wet, t);
    this.dry.gain.setValueAtTime(1 - v.wet * 0.5, t);
    this.output.gain.setValueAtTime(v.gain, t);
  }
}

// Мимика: из громкости и тембра голоса (level, tone) и состояния агента
// получаем параметры лица для шейдера: рот, ширина губ, улыбка, брови, веки, кивки, взгляд.
// tone: -1 (тёмный звук «у/о» - губы трубочкой) ... +1 (яркий «и/с» - губы шире).

// смещения по настроению ответа (пока Ясень говорит)
const MOODS = {
  calm: { smile: 0, brow: 0, tilt: 0, gy: 0 },
  warm: { smile: 0.15, brow: 0.1, tilt: 0.01, gy: 0 },
  playful: { smile: 0.3, brow: 0.2, tilt: 0.03, gy: 0 },
  curious: { smile: 0.05, brow: 0.35, tilt: 0.05, gy: 0 },
  serious: { smile: -0.1, brow: -0.2, tilt: 0, gy: 0 },
  thoughtful: { smile: 0, brow: -0.1, tilt: -0.03, gy: 0.01 },
};

const follow = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class Face {
  constructor() {
    this.v = {
      open: 0, wide: 0, smile: 0.05, pucker: 0, blink: 0, brow: 0,
      nod: 0, tilt: 0, eyeGlow: 0.3, gazeX: 0, gazeY: 0,
    };
    this.time = 0;
    this.blinkIn = 2.2;     // секунд до следующего моргания
    this.blinkT = -1;       // фаза текущего моргания (сек), -1 - не моргает
    this.doubleBlink = false;
    this.gazeIn = 1;
    this.gazeTX = 0;
    this.gazeTY = 0;
    this.prevLevel = 0;
    this.emph = 0;
    this.override = null;   // для отладки: принудительные значения параметров
    this.mood = 'calm';     // настроение последнего ответа
    this.mirror = null;     // мимика пользователя с камеры {open, smile, blink, brow, pucker}
  }

  update(dt, { state, level, tone }) {
    const v = this.v;
    this.time += dt;
    const t = this.time;
    const speaking = state === 'speaking';
    const L = speaking ? level : 0;

    // акцент в речи: резкий рост громкости даёт кивок и подъём бровей
    const dL = (L - this.prevLevel) / Math.max(dt, 1e-3);
    this.prevLevel = L;
    if (dL > 5 && L > 0.35) this.emph = 1;
    this.emph *= Math.exp(-dt * 3);
    const strength = Math.min(1, L * 2.2);

    // ---- цели по состояниям
    let openT = speaking ? Math.pow(Math.min(1, L * 1.8), 0.75) : 0;
    let wideT = speaking ? tone * 0.3 * strength : 0;
    let puckerT = speaking ? Math.max(0, -tone) * 0.9 * strength : 0;
    let smileT = 0.05;
    let browT = 0;
    let nodT = 0;
    let tiltT = 0.012 * Math.sin(t * 0.35);
    let glowT = 0.25;
    let squint = 0;
    let gx = 0, gy = 0;

    if (speaking) {
      smileT = 0.1 + 0.35 * Math.max(0, tone) * strength + 0.1 * this.emph;
      browT = 0.15 + 0.5 * this.emph + 0.3 * Math.max(0, L - 0.5);
      nodT = this.emph * 0.9;
      tiltT = 0.02 * Math.sin(t * 1.3) + 0.04 * this.emph;
      glowT = 0.25 + 0.25 * L;
    } else if (state === 'listening') {
      smileT = 0.12;
      browT = 0.4;
      nodT = Math.max(0, Math.sin(t * 0.9)) ** 6 * 0.5;
      tiltT = 0.07 + 0.01 * Math.sin(t * 0.5);
      glowT = 0.4;
    } else if (state === 'thinking') {
      smileT = -0.05;
      browT = -0.35;
      puckerT = 0.15;
      tiltT = -0.05;
      glowT = 0.05;
      squint = 0.22;
      gx = -0.02; gy = 0.018;
    }

    // ---- настроение ответа (пока говорит) и повтор мимики пользователя (пока он молчит)
    if (speaking) {
      const m = MOODS[this.mood] || MOODS.calm;
      smileT += m.smile; browT += m.brow; tiltT += m.tilt; gy += m.gy;
    }
    let mirrorBlink = 0;
    if (this.mirror && !speaking && state !== 'thinking') {
      const b = this.mirror;
      openT = b.open * 0.9; smileT = 0.05 + b.smile * 0.6; browT = b.brow * 0.8; puckerT = b.pucker * 0.6;
      mirrorBlink = b.blink;
    }

    // ---- моргание: 2.5-6 с, иногда двойное
    this.blinkIn -= dt;
    if (this.blinkT < 0 && this.blinkIn <= 0) {
      this.blinkT = 0;
      this.doubleBlink = Math.random() < 0.2;
    }
    let blinkShape = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const dur = 0.2;
      blinkShape = Math.sin(Math.PI * Math.min(1, this.blinkT / dur));
      if (this.blinkT >= dur) {
        this.blinkT = -1;
        this.blinkIn = this.doubleBlink ? 0.12 : 2.5 + Math.random() * 3.5;
        this.doubleBlink = false;
      }
    }

    blinkShape = Math.max(blinkShape, mirrorBlink);

    // ---- взгляд: лёгкие случайные сдвиги
    this.gazeIn -= dt;
    if (this.gazeIn <= 0) {
      this.gazeIn = 0.8 + Math.random() * 1.8;
      this.gazeTX = (Math.random() - 0.5) * 0.024;
      this.gazeTY = (Math.random() - 0.5) * 0.014;
    }
    gx += this.gazeTX; gy += this.gazeTY;

    // ---- сглаживание
    const o = this.override;
    if (o) {
      for (const k of Object.keys(o)) v[k] = o[k];
      return v;
    }
    v.open = follow(v.open, openT, openT > v.open ? 45 : 22, dt);
    v.wide = follow(v.wide, wideT, 20, dt);
    v.pucker = follow(v.pucker, puckerT, 16, dt);
    v.smile = follow(v.smile, smileT, 8, dt);
    v.brow = follow(v.brow, browT, 9, dt);
    v.nod = follow(v.nod, nodT, 10, dt);
    v.tilt = follow(v.tilt, tiltT, 4, dt);
    v.eyeGlow = follow(v.eyeGlow, glowT, 8, dt);
    v.blink = Math.max(follow(v.blink * (blinkShape > 0 ? 0 : 1), squint, 8, dt), blinkShape);
    v.gazeX = follow(v.gazeX, gx, 10, dt);
    v.gazeY = follow(v.gazeY, gy, 10, dt);
    return v;
  }
}

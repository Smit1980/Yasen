// Камера и трекинг (MediaPipe Tasks): лицо, мимика (blendshapes) и руки.
// Видео обрабатывается локально в браузере и никуда не отправляется; код и модели MediaPipe
// скачиваются с CDN при первом включении камеры.
//
// Для отладки есть окно камеры (видео + скелет рук и контуры лица), строка статуса с FPS и
// диагностика diagnose(): по шагам проверяет доступ, камеру, загрузку моделей и первый прогон.

const VER = '0.10.14';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/wasm`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// контуры для отрисовки (индексы точек Face Mesh)
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_R = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const HAND_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

export const GESTURES = ['кулак', '1 палец', '2 пальца', '3 пальца', '4 пальца', 'открытая ладонь'];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Сколько пальцев разогнуто (0..5)
export function countFingers(lm) {
  let n = 0;
  const wrist = lm[0];
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    if (dist(lm[tip], wrist) > dist(lm[pip], wrist) * 1.12) n++;
  }
  if (dist(lm[4], lm[17]) > dist(lm[3], lm[17]) * 1.05) n++;
  return n;
}

export function friendlyError(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'доступ к камере запрещён: разрешите камеру для этого сайта (значок слева от адреса) и проверьте Windows: Параметры → Конфиденциальность → Камера. Во встроенном окне Claude камера заблокирована: откройте страницу в Chrome или Edge';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'камера не найдена: проверьте подключение';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'камера занята другим приложением (Zoom, Teams, Discord, «Камера» Windows): закройте его и повторите';
    case 'OverconstrainedError':
      return 'камера не поддерживает запрошенный режим';
    case 'SecurityError':
      return 'браузер запретил доступ к камере (нужен https или адрес 127.0.0.1)';
    default:
      return (e && e.message) || String(e);
  }
}

async function importVision() {
  return import(BUNDLE);
}

// Загрузка обеих моделей. По умолчанию CPU: GPU быстрее в установившемся режиме, но при первом кадре
// «зависает» страницу на секунды (компиляция шейдеров). GPU можно включить адресом ?gpu=1.
export async function loadModels(log = () => {}) {
  const t0 = performance.now();
  const { FilesetResolver, FaceLandmarker, HandLandmarker } = await importVision();
  log(`код MediaPipe загружен за ${Math.round(performance.now() - t0)} мс`);
  const files = await FilesetResolver.forVisionTasks(WASM);
  const order = new URLSearchParams(location.search).get('gpu') === '1' ? ['GPU', 'CPU'] : ['CPU', 'GPU'];
  const make = async (d) => ({
    face: await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: d },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
    }),
    hand: await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: d },
      runningMode: 'VIDEO', numHands: 2,
    }),
  });
  let models = null, delegate = '';
  for (const d of order) {
    try { models = await make(d); delegate = d; break; } catch (e) { log(`${d} не подошёл (${e.message || e})`); }
  }
  if (!models) throw new Error('модели MediaPipe не запустились ни на CPU, ни на GPU');
  // прогрев: первый прогон всегда медленнее, пусть он случится здесь, а не на первом кадре
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  c.getContext('2d').fillRect(0, 0, 160, 90);
  const w0 = performance.now();
  models.face.detectForVideo(c, 1);
  models.hand.detectForVideo(c, 1);
  log(`модели готовы (${delegate}) за ${Math.round(performance.now() - t0)} мс, прогрев ${Math.round(performance.now() - w0)} мс`);
  return { ...models, delegate };
}

const blank = () => ({
  yaw: 0, pitch: 0, x: 0, y: 0, hasFace: false, fingers: -1, hands: [], faceLm: null,
  blend: null,
});

const bs = (cats, name) => {
  const c = cats.find((k) => k.categoryName === name);
  return c ? c.score : 0;
};

export class Tracker {
  constructor() {
    this.video = null;       // <video> в окне камеры
    this.canvas = null;      // оверлей со скелетом
    this.stream = null;
    this.face = null;
    this.hand = null;
    this.running = false;
    this.starting = false;
    this.out = blank();
    this.diag = { label: '', w: 0, h: 0, delegate: '', fps: 0, detectMs: 0, error: '', frames: 0 };
    this._last = -1;
    this._lastTs = 0;
    this._errors = 0;
    this._n = 0;
    this._fpsT = performance.now();
    this._fpsN = 0;
  }

  attach(video, canvas) {
    this.video = video;
    this.canvas = canvas;
  }

  async start(onStatus = () => {}) {
    if (this.running || this.starting) return;
    this.starting = true;
    this.diag.error = '';
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('браузер не даёт доступ к камере (нужен https или адрес 127.0.0.1)');
      }
      onStatus('запрашиваю камеру…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }, audio: false,
      });
      const track = this.stream.getVideoTracks()[0];
      const st = track.getSettings();
      this.diag.label = track.label || 'камера';
      this.diag.w = st.width || 0;
      this.diag.h = st.height || 0;
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      onStatus('загружаю модели трекинга…');
      const m = await loadModels((s) => onStatus(s));
      this.face = m.face;
      this.hand = m.hand;
      this.diag.delegate = m.delegate;
      this.running = true;
      this._errors = 0;
      onStatus('камера: трекинг активен');
    } catch (e) {
      this.diag.error = friendlyError(e);
      this.stop();
      throw new Error(this.diag.error);
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    if (this.face) { try { this.face.close(); } catch { /* уже закрыта */ } }
    if (this.hand) { try { this.hand.close(); } catch { /* уже закрыта */ } }
    this.face = this.hand = null;
    this.out = blank();
    this._n = 0;
    this.clearOverlay();
  }

  // вызывать каждый кадр; возвращает последние результаты
  update(now) {
    if (!this.running) return this.out;
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this._last) return this.out;
    this._last = v.currentTime;
    const ts = now > this._lastTs ? now : this._lastTs + 1;   // MediaPipe требует растущие метки времени
    this._lastTs = ts;
    const t0 = performance.now();
    const o = this.out;
    try {
      // на каждом кадре считаем одну из двух моделей: лицо раз в три кадра, руки на остальных
      if (this._n++ % 3 === 0) {
        const fr = this.face.detectForVideo(v, ts);
        const f = fr.faceLandmarks && fr.faceLandmarks[0];
        if (f) {
          const nose = f[1], left = f[234], right = f[454], top = f[10], chin = f[152];
          const yaw = ((nose.x - left.x) / (right.x - left.x) - 0.5) * 2;
          const pitch = ((nose.y - top.y) / (chin.y - top.y) - 0.5) * 2;
          // картинка с камеры зеркальная: движение вправо -> положительный x
          o.yaw = -yaw; o.pitch = pitch;
          o.x = -(nose.x - 0.5) * 2; o.y = -(nose.y - 0.5) * 2;
          o.hasFace = true;
          o.faceLm = f;
          const cats = fr.faceBlendshapes && fr.faceBlendshapes[0] ? fr.faceBlendshapes[0].categories : null;
          o.blend = cats ? {
            open: bs(cats, 'jawOpen'),
            smile: (bs(cats, 'mouthSmileLeft') + bs(cats, 'mouthSmileRight')) / 2,
            blink: (bs(cats, 'eyeBlinkLeft') + bs(cats, 'eyeBlinkRight')) / 2,
            brow: Math.max(bs(cats, 'browInnerUp'), (bs(cats, 'browOuterUpLeft') + bs(cats, 'browOuterUpRight')) / 2),
            pucker: bs(cats, 'mouthPucker'),
          } : null;
        } else {
          o.hasFace = false; o.faceLm = null; o.blend = null;
        }
      } else {
        const hr = this.hand.detectForVideo(v, ts);
        o.hands = (hr.landmarks || []).map((lm, i) => {
          const cats = hr.handedness && hr.handedness[i];
          const palm = [0, 5, 9, 13, 17].reduce((acc, k) => ({ x: acc.x + lm[k].x / 5, y: acc.y + lm[k].y / 5 }), { x: 0, y: 0 });
          return {
            lm, palm, tip: lm[8], fingers: countFingers(lm),
            // камера зеркалит: «Left» от MediaPipe - это правая рука человека
            side: cats && cats[0] ? (cats[0].categoryName === 'Left' ? 'правая' : 'левая') : '',
          };
        });
        o.fingers = o.hands.length ? o.hands[0].fingers : -1;
      }
      this._errors = 0;
    } catch (e) {
      this.diag.error = `ошибка трекинга: ${e.message || e}`;
      if (++this._errors > 30) { this.stop(); return this.out; }
    }
    this.diag.detectMs = Math.round(performance.now() - t0);
    this.diag.frames++;
    this._fpsN++;
    if (now - this._fpsT > 1000) {
      this.diag.fps = Math.round((this._fpsN * 1000) / (now - this._fpsT));
      this._fpsN = 0;
      this._fpsT = now;
    }
    this.draw();
    return this.out;
  }

  clearOverlay() {
    if (!this.canvas) return;
    const c = this.canvas.getContext('2d');
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // скелет рук и контуры лица; холст отражён так же, как видео (CSS scaleX(-1))
  draw() {
    const cv = this.canvas, v = this.video;
    if (!cv || !v.videoWidth) return;
    if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
    const c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    const lw = Math.max(2, W / 320);

    const poly = (lm, idx, close = true) => {
      c.beginPath();
      idx.forEach((k, i) => { const p = lm[k]; if (i) c.lineTo(p.x * W, p.y * H); else c.moveTo(p.x * W, p.y * H); });
      if (close) c.closePath();
      c.stroke();
    };
    const f = this.out.faceLm;
    if (f) {
      c.strokeStyle = 'rgba(80,220,255,.9)'; c.lineWidth = lw;
      poly(f, FACE_OVAL);
      c.strokeStyle = 'rgba(255,170,60,.95)';
      poly(f, LIPS); poly(f, EYE_L); poly(f, EYE_R);
      c.fillStyle = 'rgba(255,255,255,.9)';
      for (const k of [1, 152, 10]) { c.beginPath(); c.arc(f[k].x * W, f[k].y * H, lw * 1.4, 0, 6.3); c.fill(); }
    }
    for (const h of this.out.hands) {
      c.strokeStyle = 'rgba(120,255,170,.95)'; c.lineWidth = lw;
      for (const [a, b] of HAND_LINKS) {
        c.beginPath(); c.moveTo(h.lm[a].x * W, h.lm[a].y * H); c.lineTo(h.lm[b].x * W, h.lm[b].y * H); c.stroke();
      }
      c.fillStyle = 'rgba(255,255,255,.95)';
      for (const p of h.lm) { c.beginPath(); c.arc(p.x * W, p.y * H, lw * 1.3, 0, 6.3); c.fill(); }
      c.fillStyle = 'rgba(255,90,90,.95)';
      c.beginPath(); c.arc(h.tip.x * W, h.tip.y * H, lw * 2.4, 0, 6.3); c.fill();
    }
  }

  // строка статуса для окна камеры
  statusText() {
    const d = this.diag, o = this.out;
    if (!this.running) return this.starting ? 'камера: запуск…' : (d.error || 'камера выключена');
    const hands = o.hands.map((h) => `${h.side ? h.side + ' ' : ''}${GESTURES[h.fingers] || h.fingers}`).join(', ') || 'нет';
    return `${d.label} ${d.w}×${d.h} · ${d.fps} fps (${d.detectMs} мс, ${d.delegate}) · лицо: ${o.hasFace ? 'да' : 'нет'} · руки: ${hands}`;
  }
}

// Пошаговая диагностика: что именно мешает камере и трекингу
export async function diagnose(log = () => {}) {
  const ok = (s) => log(`✓ ${s}`);
  const bad = (s) => log(`✗ ${s}`);
  log(`адрес: ${location.origin}`);
  (window.isSecureContext ? ok : bad)(`безопасный контекст: ${window.isSecureContext ? 'да' : 'нет (нужен https или 127.0.0.1)'}`);
  if (!navigator.mediaDevices) { bad('navigator.mediaDevices недоступен'); return false; }

  try {
    const st = await navigator.permissions.query({ name: 'camera' });
    log(`разрешение камеры в браузере: ${st.state}${st.state === 'denied' ? ' (заблокировано: разрешите в значке слева от адреса)' : ''}`);
  } catch { log('разрешение камеры: браузер не сообщает'); }

  let stream;
  try {
    const t0 = performance.now();
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 } }, audio: false });
    const tr = stream.getVideoTracks()[0], st = tr.getSettings();
    ok(`камера открыта за ${Math.round(performance.now() - t0)} мс: «${tr.label}» ${st.width}×${st.height} ${Math.round(st.frameRate || 0)} fps`);
  } catch (e) {
    bad(`камера не открылась: ${friendlyError(e)}`);
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      log(`видеоустройств в браузере: ${devs.length}${devs.length ? ' (' + devs.map((d) => d.label || 'без имени').join(', ') + ')' : ''}`);
    } catch { /* не критично */ }
    return false;
  }

  // кадр реально идёт: считаем яркость, чтобы отличить закрытую шторку/чёрный кадр
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    await new Promise((r) => setTimeout(r, 600));
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(v, 0, 0, 64, 36);
    const px = cx.getImageData(0, 0, 64, 36).data;
    let s = 0;
    for (let i = 0; i < px.length; i += 4) s += (px[i] + px[i + 1] + px[i + 2]) / 3;
    const mean = s / (px.length / 4);
    (mean > 12 ? ok : bad)(`средняя яркость кадра ${Math.round(mean)}/255${mean > 12 ? '' : ': кадр почти чёрный (шторка, заглушка или плохой свет)'}`);
    v.srcObject = null;
  } catch (e) { bad(`не удалось прочитать кадр: ${e.message}`); }
  stream.getTracks().forEach((t) => t.stop());

  try {
    const m = await loadModels(log);
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    c.getContext('2d').fillRect(0, 0, 320, 240);
    const t0 = performance.now();
    m.face.detectForVideo(c, 1000);
    m.hand.detectForVideo(c, 1000);
    ok(`первый прогон моделей: ${Math.round(performance.now() - t0)} мс`);
    m.face.close(); m.hand.close();
  } catch (e) {
    bad(`модели не загрузились: ${e.message || e}. Нужен интернет (jsdelivr.net и storage.googleapis.com)`);
    return false;
  }
  ok('диагностика пройдена: камеру и трекинг можно включать (кнопка «Камера»)');
  return true;
}

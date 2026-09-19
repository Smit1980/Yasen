// Motion tracking через MediaPipe Tasks (грузится лениво, только по кнопке «камера»).
// Видео с камеры никуда не отправляется и не показывается: обрабатывается локально.
// Веса моделей и wasm скачиваются с CDN при первом включении.

const VER = '0.10.14';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/wasm`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

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

export class Tracker {
  constructor() {
    this.video = null;
    this.face = null;
    this.hand = null;
    this.stream = null;
    this.running = false;
    // выход: yaw/pitch в -1..1, x/y положение головы, fingers (-1 если руки нет)
    this.out = { yaw: 0, pitch: 0, x: 0, y: 0, fingers: -1, hasFace: false };
    this._last = -1;
  }

  async start(onStatus = () => {}) {
    onStatus('запрашиваю камеру…');
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();

    onStatus('загружаю модели трекинга…');
    const { FilesetResolver, FaceLandmarker, HandLandmarker } = await import(BUNDLE);
    const files = await FilesetResolver.forVisionTasks(WASM);
    this.face = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO', numFaces: 1,
    });
    this.hand = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO', numHands: 1,
    });
    this.running = true;
    onStatus('камера: трекинг активен');
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.face) this.face.close();
    if (this.hand) this.hand.close();
    this.face = this.hand = null;
    this.out = { yaw: 0, pitch: 0, x: 0, y: 0, fingers: -1, hasFace: false };
  }

  // вызывать каждый кадр
  update(now) {
    if (!this.running || this.video.readyState < 2 || this.video.currentTime === this._last) return this.out;
    this._last = this.video.currentTime;
    const o = this.out;

    const f = this.face.detectForVideo(this.video, now).faceLandmarks?.[0];
    if (f) {
      const nose = f[1], left = f[234], right = f[454], top = f[10], chin = f[152];
      const yaw = ((nose.x - left.x) / (right.x - left.x) - 0.5) * 2;
      const pitch = ((nose.y - top.y) / (chin.y - top.y) - 0.5) * 2;
      // картинка с камеры зеркальная: движение вправо → положительный x
      o.yaw = -yaw; o.pitch = pitch;
      o.x = -(nose.x - 0.5) * 2; o.y = -(nose.y - 0.5) * 2;
      o.hasFace = true;
    } else {
      o.hasFace = false;
    }

    const h = this.hand.detectForVideo(this.video, now).landmarks?.[0];
    o.fingers = h ? countFingers(h) : -1;
    return o;
  }
}

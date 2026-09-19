// Портрет-референс -> облако частиц.
// Плотность частиц пропорциональна яркости пикселя, цвет берётся из картинки,
// поэтому оранжевые «звёзды» и голубое свечение повторяют оригинал.
// Поверх добавляются процедурные частицы для мимики: губы, полость рта, брови, веки.
import { makeRng, gauss } from './shapes.js';

const S = 3.0;      // высота портрета в мировых единицах
const IMG_H = 1312; // высота референса (ориентиры заданы для 1199x1312)
const CX = 567;     // ось лица, px
const CY = 575;     // пиксель, который попадает в y = 0
const K = S / IMG_H;
const px2w = (x, y) => [(x - CX) * K, (CY - y) * K];

// ориентиры лица на референсе, px
const LM_PX = {
  eyeL: [471, 431], eyeR: [659, 431],
  mouth: [567, 618], mouthHW: 62,
  browY: 392, chinY: 700, neckY: 800,
  pivot: [568, 790],
};

export const LM = {
  eyeL: px2w(...LM_PX.eyeL), eyeR: px2w(...LM_PX.eyeR),
  mouth: px2w(...LM_PX.mouth), mouthHW: LM_PX.mouthHW * K,
  browY: px2w(0, LM_PX.browY)[1], chinY: px2w(0, LM_PX.chinY)[1], neckY: px2w(0, LM_PX.neckY)[1],
  pivot: px2w(...LM_PX.pivot),
};

// купол лица и купол плеч: даёт объём при повороте головы
function depthAt(x, y) {
  const face = 0.30 * Math.exp(-((x / 0.46) ** 2 + ((y - 0.12) / 0.62) ** 2));
  const body = 0.22 * Math.exp(-((x / 1.15) ** 2 + ((y + 0.95) / 0.6) ** 2));
  return Math.max(face, body);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`не удалось загрузить ${url}`));
    img.src = url;
  });
}

export async function loadPortrait(url, { count = 220000, seed = 5 } = {}) {
  const img = await loadImage(url);
  const W = img.naturalWidth, H = img.naturalHeight;
  if (H !== IMG_H) throw new Error(`ожидался портрет высотой ${IMG_H}px, получено ${H}px`);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const data = cx.getImageData(0, 0, W, H).data;

  // накопленная плотность по пикселям
  const cdf = new Float64Array(W * H);
  let acc = 0;
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) / 255;
    acc += v < 0.05 ? 0 : Math.pow(v, 1.25);
    cdf[i] = acc;
  }

  const EXTRA = 9000;
  const N = count + EXTRA;
  const pos = new Float32Array(N * 3), nor = new Float32Array(N * 3), color = new Float32Array(N * 3);
  const bright = new Float32Array(N), kind = new Float32Array(N), region = new Float32Array(N);
  const seedA = new Float32Array(N * 3);
  const rnd = makeRng(seed);
  let n = 0;

  const put = (wx, wy, wz, r, g, b, br, kd, rg) => {
    // нормаль: в ауре - радиально наружу, на лице - к зрителю
    const dx = wx, dy = wy - 0.1, d = Math.hypot(dx, dy) + 1e-4;
    const wr = Math.min(1, Math.max(0, (d - 0.35) / 0.75));
    let nx = (dx / d) * wr, ny = (dy / d) * wr, nz = (1 - wr) * 0.8 + 0.2;
    const l = Math.hypot(nx, ny, nz);
    nor[n * 3] = nx / l; nor[n * 3 + 1] = ny / l; nor[n * 3 + 2] = nz / l;
    pos[n * 3] = wx; pos[n * 3 + 1] = wy; pos[n * 3 + 2] = wz;
    color[n * 3] = r; color[n * 3 + 1] = g; color[n * 3 + 2] = b;
    bright[n] = br; kind[n] = kd; region[n] = rg;
    seedA[n * 3] = rnd(); seedA[n * 3 + 1] = rnd(); seedA[n * 3 + 2] = rnd();
    n++;
  };

  // ---- 1. частицы из картинки
  for (let k = 0; k < count; k++) {
    const u = rnd() * acc;
    let lo = 0, hi = W * H - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
    const ix = lo % W, iy = (lo / W) | 0;
    const r = data[lo * 4] / 255, g = data[lo * 4 + 1] / 255, b = data[lo * 4 + 2] / 255;
    const v = Math.max(r, g, b) || 1e-3;
    const nr = r / v, ng = g / v, nb = b / v;
    const orange = nr > 0.95 && nb < 0.55 && v > 0.35;
    const white = v > 0.85 && nb > 0.9 && ng > 0.6;
    const [wx, wy] = px2w(ix + rnd() - 0.5, iy + rnd() - 0.5);
    const zd = depthAt(wx, wy);
    const far = 1 - Math.min(1, zd / 0.15);
    const wz = zd + gauss(rnd) * 0.03 * (1 + far * 2) - far * rnd() * 0.3;
    put(wx, wy, wz, nr, ng, nb, v, orange ? 2 : white ? 1 : 0, 0);
  }

  const ptZ = (wx, wy, dz) => depthAt(wx, wy) + dz;
  const arc = (count2, curve, spread, col, br, rg, dz, kd = 1) => {
    for (let k = 0; k < count2; k++) {
      const t = rnd() * 2 - 1;
      const [px, py] = curve(t);
      const [wx, wy] = px2w(px + gauss(rnd) * spread, py + gauss(rnd) * spread);
      const j = 0.85 + rnd() * 0.3;
      put(wx, wy, ptZ(wx, wy, dz), col[0] * j, col[1] * j, col[2] * j, br, kd, rg);
    }
  };

  // ---- 2. губы: верхняя кромка, линия смыкания, нижняя кромка
  const [mx, my] = LM_PX.mouth, a = LM_PX.mouthHW;
  const h = (t) => 1 - t * t;
  arc(1100, (t) => [mx + a * t, my - 3 - 13 * Math.pow(h(t), 0.9) + 6 * Math.exp(-((t / 0.2) ** 2))], 4, [0.22, 0.52, 0.95], 0.7, 1, 0.04);
  arc(700, (t) => [mx + a * t, my + 2.5 * h(t)], 3.5, [0.2, 0.48, 0.9], 0.6, 1, 0.04);
  arc(1300, (t) => [mx + a * t, my + 4 + 17 * Math.pow(h(t), 0.85)], 4, [0.22, 0.52, 0.95], 0.7, 1, 0.04);

  // ---- 3. полость рта: точки между верхней и нижней губой (видны только при открытом рте)
  for (let k = 0; k < 1500; k++) {
    const t = (rnd() * 2 - 1) * 0.86;
    const [wx, wy] = px2w(mx + a * t, my + 2.5 * h(t));
    put(wx, wy, ptZ(wx, wy, 0.02), 0.2, 0.45, 0.9, 0.5, 1, 3);
  }

  // ---- 4. брови и веки
  for (const [ex, side] of [[LM_PX.eyeL[0], -1], [LM_PX.eyeR[0], 1]]) {
    arc(550, (t) => [ex + 56 * t, 396 - 12 * h(t) + side * t * 4], 3, [0.2, 0.5, 0.9], 0.5, 4, 0.03);
    arc(400, (t) => [ex + 44 * t, LM_PX.eyeL[1] - 8 - 20 * h(t)], 2, [0.2, 0.5, 0.9], 0.5, 5, 0.03);
    arc(400, (t) => [ex + 44 * t, LM_PX.eyeL[1] + 6 + 12 * h(t)], 2, [0.2, 0.5, 0.9], 0.5, 5, 0.03);
  }

  // если частиц вышло меньше (округления), обрежем хвост
  const cut = (arr, s) => arr.subarray(0, n * s);
  return {
    N: n,
    pos: cut(pos, 3), nor: cut(nor, 3), color: cut(color, 3), bright: cut(bright, 1),
    kind: cut(kind, 1), region: cut(region, 1), seed: cut(seedA, 3),
    LM,
  };
}

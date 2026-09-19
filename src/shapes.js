// Формы для морфинга. «head» строится отдельно из портрета (portrait.js),
// остальные формы генерируются здесь под ту же раскладку частиц:
// kinds[i]: 0 - тело, 1 - контурные линии, 2 - ядро/акцент (оранжевые точки портрета).

export const SHAPE_NAMES = ['head', 'sphere', 'wave', 'torus'];

export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rnd) {
  const u = Math.max(rnd(), 1e-9), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function unitDir(rnd) {
  const x = gauss(rnd), y = gauss(rnd), z = gauss(rnd);
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function norm(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function ellipsoid(rnd, c, r) {
  const d = unitDir(rnd);
  const n = norm(d[0] / r[0], d[1] / r[1], d[2] / r[2]);
  return [c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2], ...n];
}

function ellipsoidRing(rnd, c, r, levels, tMin, tMax) {
  const li = Math.floor(rnd() * levels);
  const t = tMin + ((tMax - tMin) * li) / (levels - 1);
  const s = Math.sqrt(Math.max(0, 1 - t * t));
  const a = rnd() * Math.PI * 2;
  const dx = s * Math.cos(a), dz = s * Math.sin(a);
  const n = norm(dx / r[0], t / r[1], dz / r[2]);
  return [c[0] + dx * r[0], c[1] + t * r[1], c[2] + dz * r[2], ...n];
}

function blob(rnd, c, sigma) {
  const d = unitDir(rnd);
  const g = Math.min(Math.abs(gauss(rnd)), 2.2);
  return [c[0] + d[0] * sigma * g, c[1] + d[1] * sigma * g, c[2] + d[2] * sigma * g, ...d];
}

function build(kinds, seed, bodyFn, contourFn, coreFn) {
  const N = kinds.length;
  const rnd = makeRng(seed);
  const pos = new Float32Array(N * 3);
  const nor = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const k = kinds[i];
    const v = k === 2 ? coreFn(rnd) : k === 1 ? contourFn(rnd) : bodyFn(rnd);
    pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2];
    nor[i * 3] = v[3]; nor[i * 3 + 1] = v[4]; nor[i * 3 + 2] = v[5];
  }
  return { pos, nor };
}

function sphere(kinds) {
  const R = 1.05, C = [0, 0.1, 0], r = [R, R, R];
  return build(kinds, 22,
    (rnd) => ellipsoid(rnd, C, r),
    (rnd) => ellipsoidRing(rnd, C, r, 22, -0.95, 0.95),
    (rnd) => blob(rnd, C, 0.14));
}

const waveY = (x, z) => -0.25 + 0.28 * Math.sin(x * 2.3) * Math.cos(z * 2.1) + 0.1 * Math.sin(x * 5.0 + z * 3.0);
function wave(kinds) {
  return build(kinds, 33,
    (rnd) => {
      const x = (rnd() * 2 - 1) * 1.9, z = (rnd() * 2 - 1) * 1.3, e = 0.01;
      const n = norm(-(waveY(x + e, z) - waveY(x - e, z)) / (2 * e), 1, -(waveY(x, z + e) - waveY(x, z - e)) / (2 * e));
      return [x, waveY(x, z), z, ...n];
    },
    (rnd) => {
      const z = -1.3 + (2.6 * Math.floor(rnd() * 16)) / 15, x = (rnd() * 2 - 1) * 1.9;
      return [x, waveY(x, z), z, 0, 1, 0];
    },
    (rnd) => blob(rnd, [0, 0.15, 0], 0.15));
}

function torus(kinds) {
  const R = 0.85, r = 0.3, cy = 0.1;
  const pt = (u, v) => {
    const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
    return [(R + r * cv) * cu, cy + (R + r * cv) * su, r * sv, cv * cu, cv * su, sv];
  };
  return build(kinds, 44,
    (rnd) => pt(rnd() * Math.PI * 2, rnd() * Math.PI * 2),
    (rnd) => pt((Math.floor(rnd() * 48) / 48) * Math.PI * 2, rnd() * Math.PI * 2),
    (rnd) => blob(rnd, [0, cy, 0], 0.13));
}

const BUILDERS = { sphere, wave, torus };
const cache = new Map();

// head подставляется снаружи (портрет), поэтому здесь только остальные формы
export function generateShape(name, kinds) {
  if (!cache.has(name)) cache.set(name, BUILDERS[name](kinds));
  return cache.get(name);
}

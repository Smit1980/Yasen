export const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uMix;
uniform float uAmp;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uSwirl;
uniform float uContract;
uniform float uBurst;
uniform float uPixelRatio;
uniform float uSize;
uniform float uGlow;
uniform float uCamZ;
uniform vec3 uPointer;

// мимика (задаётся из face.js)
uniform float uFromHead;
uniform float uToHead;
uniform float uOpen;
uniform float uWide;
uniform float uSmile;
uniform float uPucker;
uniform float uBlink;
uniform float uBrow;
uniform float uNod;
uniform float uTilt;
uniform float uEyeGlow;
uniform vec2 uGaze;
// ориентиры лица (мировые координаты)
uniform vec2 uMouth;
uniform float uMouthHW;
uniform vec2 uEyeL;
uniform vec2 uEyeR;
uniform float uBrowY;
uniform float uChinY;
uniform float uNeckY;
uniform vec2 uPivot;
uniform vec2 uFaceC;
uniform vec2 uFaceR;
uniform float uBottomY;
uniform float uIntroT;
uniform float uIntroLen;
// цвет
uniform vec3 uAccent;
uniform float uHue;
uniform float uIntensity;

attribute vec3 aTarget;
attribute vec3 aNormal;
attribute vec3 aTargetNormal;
attribute vec3 aRest;
attribute vec3 aColor;
attribute vec3 aSeed;
attribute float aKind;
attribute float aRegion;
attribute float aBright;

varying vec3 vColor;
varying float vAlpha;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

// поворот цвета вокруг серой оси
vec3 hueRot(vec3 c, float a) {
  vec3 k = vec3(0.57735026);
  float ca = cos(a);
  float sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

// смещение точки лица: челюсть, губы, глаза, брови, наклон головы
vec3 faceDelta(vec3 r, out float glow) {
  glow = 1.0;
  vec3 d = vec3(0.0);

  // ---- рот и челюсть
  vec2 q = r.xy - uMouth;
  float a = uMouthHW;
  float xw = abs(q.x) / a;
  float jx = exp(-(q.x * q.x) / (2.0 * (a * 1.9) * (a * 1.9)));
  float below = 1.0 - smoothstep(-0.05, 0.02, q.y);
  float jy = smoothstep(uNeckY, uChinY, r.y);
  float jaw = below * jx * jy;
  d.y -= uOpen * 0.115 * jaw;
  d.z += uOpen * 0.02 * jaw;

  float upY = (q.y - 0.035) / 0.04;
  float upM = exp(-xw * xw) * exp(-upY * upY);
  d.y += uOpen * 0.022 * upM;

  float wm = exp(-(q.x * q.x) / (2.0 * a * a * 2.4) - (q.y * q.y) / (2.0 * 0.12 * 0.12));
  d.x += q.x * (uWide - uPucker * 0.4) * wm;
  float cm = smoothstep(0.5, 1.1, xw) * exp(-(q.y * q.y) / (2.0 * 0.1 * 0.1));
  d.y += uSmile * 0.05 * cm;
  d.x += sign(q.x) * uSmile * 0.018 * cm;
  d.z += uPucker * 0.08 * exp(-dot(q, q) / (2.0 * 0.14 * 0.14));

  // ---- глаза: моргание, взгляд, свечение
  vec2 qL = r.xy - uEyeL;
  vec2 qR = r.xy - uEyeR;
  float eL = exp(-(qL.x * qL.x) / (2.0 * 0.095 * 0.095) - (qL.y * qL.y) / (2.0 * 0.075 * 0.075));
  float eR = exp(-(qR.x * qR.x) / (2.0 * 0.095 * 0.095) - (qR.y * qR.y) / (2.0 * 0.075 * 0.075));
  float ew = max(eL, eR);
  vec2 qe = eL > eR ? qL : qR;
  d.y -= qe.y * uBlink * 0.9 * ew;
  d.xy += uGaze * ew;
  glow *= 1.0 + (uEyeGlow * 0.3 - uBlink * 1.0) * ew;

  // ---- лоб / брови
  float bx = r.x / 0.32;
  float by = (r.y - uBrowY) / 0.11;
  d.y += uBrow * 0.04 * exp(-bx * bx) * exp(-by * by);

  // ---- наклон и кивок головы вокруг основания шеи
  float hw = smoothstep(uPivot.y - 0.55, uPivot.y + 0.4, r.y);
  vec2 pr = r.xy - uPivot;
  float ang = uTilt * hw;
  float cs = cos(ang);
  float sn = sin(ang);
  d.xy += vec2(pr.x * cs - pr.y * sn, pr.x * sn + pr.y * cs) - pr;
  d.y -= uNod * 0.035 * hw;
  d.z += uNod * 0.05 * hw * (r.y - uPivot.y);
  return d;
}

// Поток частиц для интро: три ленты, плывущие через сцену
vec3 riverPos(float t) {
  float lane = floor(aSeed.y * 3.0);
  float lf = fract(aSeed.y * 3.0) - 0.5;
  float u = fract(aSeed.x * 7.13 + t * (0.07 + 0.02 * lane));
  float ang = u * 6.2832;
  float x = mix(-4.6, 4.6, u);
  float y = (0.65 + 0.2 * lane) * sin(ang * 1.2 + t * 0.4 + lane * 2.1) + (lane - 1.0) * 0.55;
  float z = 0.9 * sin(ang + lane * 1.7 + t * 0.25);
  vec3 p = vec3(x, y + lf * 0.55, z + (fract(aSeed.z * 13.7) - 0.5) * 0.5);
  p.y += (vnoise(vec3(x * 0.9, t * 0.3, lane)) - 0.5) * 0.4;
  return p;
}

void main() {
  // слой свечения рисует только часть частиц: остальные отсекаем сразу
  if (uGlow > 0.5 && aSeed.x > 0.22) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }
  // морфинг между формами: точки стартуют не одновременно
  float t = clamp(uMix * 1.4 - aSeed.x * 0.4, 0.0, 1.0);
  float m = smoothstep(0.0, 1.0, t);
  vec3 p = mix(position, aTarget, m);
  vec3 nrm = normalize(mix(aNormal, aTargetNormal, m) + 1e-5);
  float headW = mix(uFromHead, uToHead, m);

  float glow = 1.0;
  float vis = 1.0;
  if (headW > 0.001) {
    if (aRegion > 2.5 && aRegion < 3.5) {
      // полость рта: точки растягиваются между верхней и нижней губой
      vec3 tp = aRest + vec3(0.0, 0.006, 0.0);
      vec3 bp = aRest - vec3(0.0, 0.006, 0.0);
      float g1;
      float g2;
      vec3 dt = faceDelta(tp, g1);
      vec3 db = faceDelta(bp, g2);
      vec3 rest2 = mix(tp + dt, bp + db, aSeed.y);
      p += (rest2 - aRest) * headW;
      vis = 0.22 * smoothstep(0.1, 0.5, uOpen);
    } else {
      p += faceDelta(aRest, glow) * headW;
      if (aRegion > 0.5 && aRegion < 1.5) vis = 0.10 + 0.08 * uOpen;
      else if (aRegion > 3.5 && aRegion < 4.5) vis = 0.08 + 0.1 * abs(uBrow);
      else if (aRegion > 4.5) vis = 0.03 + 0.25 * smoothstep(0.05, 0.55, uBlink);
    }
    vis = mix(1.0, vis, headW);
  }

  // внутри лица шум и голос почти не двигают точки, чтобы черты оставались чёткими
  float fx = (aRest.x - uFaceC.x) / uFaceR.x;
  float fy = (aRest.y - uFaceC.y) / uFaceR.y;
  float wob = 1.0 - 0.85 * headW * exp(-(fx * fx + fy * fy));
  float isCore = step(1.5, aKind) * step(aKind, 2.5);
  float kindAmp = mix(1.0, 0.55, isCore);

  // «дыхание» и шум
  // шум согласован в пространстве (без случайного сдвига на частицу): соседи дышат вместе, иначе получаются радиальные «лучи»
  float n = vnoise(p * 1.6 + vec3(0.0, uTime * 0.35, 0.0));
  p += nrm * (n - 0.5) * 0.03 * (1.0 + uHigh * 4.0) * wob;

  // голос: общая амплитуда и кольцевые волны от низких частот
  p += nrm * uAmp * (0.03 + 0.14 * aSeed.y) * kindAmp * wob;
  float d = length(p - vec3(0.0, -0.9, 0.0));
  p += nrm * sin(d * 8.0 - uTime * 5.0) * uBass * 0.05 * kindAmp * wob;
  p += nrm * (aSeed.z - 0.5) * uMid * 0.09 * wob;

  // thinking: закручивание вокруг вертикальной оси
  float ang = uSwirl * (0.3 * sin(uTime * 1.2 + p.y * 3.0) + 0.3 * aSeed.y) * wob;
  float cs = cos(ang);
  float sn = sin(ang);
  p.xz = mat2(cs, -sn, sn, cs) * p.xz;

  // listening: сжатие к центру
  p *= 1.0 - uContract * 0.06 * (0.4 + aSeed.z) * wob;

  // жест / взрыв
  p += nrm * uBurst * (0.2 + aSeed.y * 0.7) * wob;

  // отталкивание от курсора
  vec3 dv = p - uPointer;
  float dl = length(dv);
  p += normalize(dv + 1e-4) * exp(-dl * dl * 6.0) * 0.18;

  // интро: частицы плывут потоком, затем по очереди отрываются и собираются в лицо
  // (сначала контур и плечи, в конце лицо)
  float yFade = p.y;
  float introA = 1.0;
  if (uIntroT < uIntroLen) {
    float order = 1.0 - smoothstep(0.15, 1.7, length(aRest.xy - uFaceC));
    float t0 = 0.25 + 3.4 * order + 0.5 * aSeed.y;
    float dur = 1.7 + 1.5 * aSeed.z;
    float mi = clamp((uIntroT - t0) / dur, 0.0, 1.0);
    mi = mi * mi * mi * (mi * (mi * 6.0 - 15.0) + 10.0);
    vec3 sp = riverPos(min(uIntroT, t0));
    vec3 dirv = p - sp;
    vec3 perp = normalize(cross(dirv, vec3(0.0, 0.0, 1.0)) + vec3(0.0001));
    float arc = sin(3.14159 * mi) * (aSeed.z * 2.0 - 1.0) * 0.18 * length(dirv);
    p = mix(sp, p, mi) + perp * arc;
    introA = smoothstep(0.0, 0.9, uIntroT);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // размер: у редких далёких частиц - «боке»
  float far = smoothstep(0.55, 1.2, length(aRest.xy));
  float bok = step(0.985, fract(aSeed.x * 7.31 + aSeed.y * 3.17)) * far;
  float sizeK = (0.55 + 0.9 * aSeed.z) * (1.0 + bok * 3.2) * mix(1.0, 0.95, isCore) * (1.0 + uAmp * 0.25);
  gl_PointSize = uSize * uPixelRatio * sizeK * 0.00375 * (uCamZ / -mv.z) * mix(1.0, 3.6, uGlow);

  // цвет: тело - из картинки с поворотом оттенка, акцент (оранжевый) - по состоянию
  vec3 acc = mix(uAccent, vec3(1.0), smoothstep(0.55, 0.95, aColor.b));
  vec3 col = mix(hueRot(aColor, uHue), acc, isCore);
  // оранжевая «нить» пульсирует бегущей волной вдоль оси
  float pulse = 1.0 + isCore * uAmp * 0.5 * (0.5 + 0.5 * sin(p.y * 10.0 - uTime * 4.0));
  vColor = col * glow * pulse * mix(1.0, 0.8, isCore);

  float fade = smoothstep(uBottomY, uBottomY + 0.35, yFade);
  vAlpha = (0.5 + 0.5 * sin(uTime * 2.0 + aSeed.x * 40.0)) * (0.4 + 0.6 * aBright) * vis * fade * (1.0 - 0.45 * bok) * uIntensity * introA;
}
`;

export const fragmentShader = /* glsl */ `
uniform float uGlow;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float falloff = exp(-d * d * mix(4.5, 2.2, uGlow));
  float alpha = falloff * vAlpha * mix(1.0, 0.05, uGlow);
  gl_FragColor = vec4(vColor, alpha);
}
`;

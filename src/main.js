import * as THREE from '../vendor/three.module.min.js';
import { SHAPE_NAMES, generateShape } from './shapes.js';
import { loadPortrait } from './portrait.js';
import { vertexShader, fragmentShader } from './shaders.js';
import { AudioEngine } from './audio.js';
import { VOICES, VOICE_NAMES } from './voicefx.js';
import { Face } from './face.js';
import { Tracker } from './tracking.js';
import { Reader, decodeText } from './reader.js';

// ---- интро: лицо собирается из потока частиц (?intro=0 - пропустить)
const INTRO_LEN = 8.2;
let introT = new URLSearchParams(location.search).get('intro') === '0' ? INTRO_LEN + 1 : 0;

// ---------------------------------------------------------------- состояния
const c3 = (r, g, b) => new THREE.Color(r, g, b);
// hue - поворот оттенка «голубого» тела (рад), accent - цвет оранжевых точек
const STATES = {
  idle:      { label: 'покой',   hue: 0,    accent: c3(1.0, 0.60, 0.15), swirl: 0, contract: 0,   ampGain: 0.25, intensity: 1.1,  spin: 0.10 },
  listening: { label: 'слушает', hue: -0.5, accent: c3(0.40, 1.0, 0.75), swirl: 0, contract: 1,   ampGain: 0.9,  intensity: 1.1,  spin: 0.05 },
  thinking:  { label: 'думает',  hue: 0.9,  accent: c3(1.0, 0.35, 0.80), swirl: 1, contract: 0.3, ampGain: 0.25, intensity: 1.15, spin: 0.55 },
  speaking:  { label: 'говорит', hue: 0,    accent: c3(1.0, 0.62, 0.15), swirl: 0, contract: 0,   ampGain: 1.0,  intensity: 1.1,  spin: 0.12 },
};

const ui = {
  status: document.getElementById('status'),
  caption: document.getElementById('caption'),
  bar: document.getElementById('bar'),
};
ui.status.textContent = 'загрузка портрета…';

// ---------------------------------------------------------------- портрет
let portrait;
try {
  // ?points=120000 - меньше частиц для слабых видеокарт
  const points = Number(new URLSearchParams(location.search).get('points')) || 440000;
  portrait = await loadPortrait('assets/portrait.webp', { count: points });
} catch (e) {
  ui.status.textContent = `ошибка: ${e.message}. Откройте страницу через run.bat (http://127.0.0.1:8780/), а не файлом.`;
  throw e;
}
const N = portrait.N;
const LM = portrait.LM;

// ---------------------------------------------------------------- сцена
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setClearColor(0x02050b, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
const group = new THREE.Group();
scene.add(group);

const geo = new THREE.BufferGeometry();
const attr = (arr, size) => new THREE.BufferAttribute(arr, size);
const posAttr = attr(new Float32Array(portrait.pos), 3);
const norAttr = attr(new Float32Array(portrait.nor), 3);
const tgtAttr = attr(new Float32Array(portrait.pos), 3);
const tgtNorAttr = attr(new Float32Array(portrait.nor), 3);
geo.setAttribute('position', posAttr);
geo.setAttribute('aNormal', norAttr);
geo.setAttribute('aTarget', tgtAttr);
geo.setAttribute('aTargetNormal', tgtNorAttr);
geo.setAttribute('aRest', attr(portrait.pos, 3));
geo.setAttribute('aColor', attr(portrait.color, 3));
geo.setAttribute('aSeed', attr(portrait.seed, 3));
geo.setAttribute('aKind', attr(portrait.kind, 1));
geo.setAttribute('aRegion', attr(portrait.region, 1));
geo.setAttribute('aBright', attr(portrait.bright, 1));
geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

const V2 = (a) => new THREE.Vector2(a[0], a[1]);
const shared = {
  uTime: { value: 0 }, uMix: { value: 0 }, uAmp: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uHigh: { value: 0 },
  uSwirl: { value: 0 }, uContract: { value: 0 }, uBurst: { value: 0 }, uPixelRatio: { value: 1 }, uCamZ: { value: 4.7 }, uSize: { value: 1.75 },
  uPointer: { value: new THREE.Vector3(99, 99, 99) },
  uFromHead: { value: 1 }, uToHead: { value: 1 },
  uOpen: { value: 0 }, uWide: { value: 0 }, uSmile: { value: 0 }, uPucker: { value: 0 }, uBlink: { value: 0 },
  uBrow: { value: 0 }, uNod: { value: 0 }, uTilt: { value: 0 }, uEyeGlow: { value: 0 }, uGaze: { value: new THREE.Vector2() },
  uMouth: { value: V2(LM.mouth) }, uMouthHW: { value: LM.mouthHW },
  uEyeL: { value: V2(LM.eyeL) }, uEyeR: { value: V2(LM.eyeR) },
  uBrowY: { value: LM.browY }, uChinY: { value: LM.chinY }, uNeckY: { value: LM.neckY }, uPivot: { value: V2(LM.pivot) },
  uFaceC: { value: V2(LM.faceC) }, uFaceR: { value: V2(LM.faceR) }, uBottomY: { value: LM.bottomY },
  uIntroT: { value: 0 }, uIntroLen: { value: INTRO_LEN },
  uAccent: { value: STATES.idle.accent.clone() }, uHue: { value: 0 }, uIntensity: { value: 1 },
};
const mkMat = (glow) => new THREE.ShaderMaterial({
  vertexShader, fragmentShader,
  uniforms: { ...shared, uGlow: { value: glow } },
  transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
});
group.add(new THREE.Points(geo, mkMat(0)));   // чёткие точки
group.add(new THREE.Points(geo, mkMat(1)));   // мягкое свечение (дешёвый bloom)

let debugView = null;   // {z, y}: приближение для отладки (orb.view)
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  // ?dpr=1 - рисовать без учёта масштаба экрана (быстрее на слабых видеокартах и 4K)
  const dpr = Math.min(window.devicePixelRatio || 1, Number(new URLSearchParams(location.search).get('dpr')) || 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const z = debugView ? debugView.z : 4.7 * Math.max(1, 1.14 / camera.aspect);
  camera.position.set(0, debugView ? debugView.y : 0, z);
  camera.updateProjectionMatrix();
  // пикселей на мировую единицу: по нему масштабируется размер частиц
  shared.uPixelRatio.value = renderer.domElement.height / (2 * z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  shared.uCamZ.value = z;
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- логика
const audio = new AudioEngine();
const tracker = new Tracker();
const face = new Face();

let state = 'idle';
let shapeName = 'head';
let pendingShape = null;
let morphing = false;
let morphT = 0;
let demoOn = false;
let burst = 0;
let sfxReady = false;
let camStatus = '';
let voiceName = 'clean';
const cur = { hue: 0, swirl: 0, contract: 0, ampGain: 0.25, intensity: 1, spin: 0.1 };

function setState(name, silent = false) {
  if (!STATES[name] || name === state) return;
  state = name;
  if (sfxReady && !silent) audio.sfxState(name);
  syncUi();
}

function setShape(name) {
  if (!SHAPE_NAMES.includes(name) || name === shapeName) return;
  if (morphing) { pendingShape = name; return; }
  const next = name === 'head' ? { pos: portrait.pos, nor: portrait.nor } : generateShape(name, portrait.kind);
  tgtAttr.array.set(next.pos); tgtAttr.needsUpdate = true;
  tgtNorAttr.array.set(next.nor); tgtNorAttr.needsUpdate = true;
  shared.uFromHead.value = shapeName === 'head' ? 1 : 0;
  shared.uToHead.value = name === 'head' ? 1 : 0;
  shapeName = name;
  morphing = true;
  morphT = 0;
  if (sfxReady) audio.sfxShape();
  syncUi();
}

function finishMorph() {
  posAttr.array.set(tgtAttr.array); posAttr.needsUpdate = true;
  norAttr.array.set(tgtNorAttr.array); norAttr.needsUpdate = true;
  shared.uMix.value = 0;
  shared.uFromHead.value = shared.uToHead.value;
  morphing = false;
  if (pendingShape) { const n = pendingShape; pendingShape = null; setShape(n); }
}

function setVoice(name) {
  if (!VOICES[name]) return;
  voiceName = name;
  audio.setVoice(name);
  syncUi();
}

let captionTimer = 0;
function showCaption(text) {
  ui.caption.textContent = text;
  ui.caption.classList.add('on');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => ui.caption.classList.remove('on'), 4000 + text.length * 40);
}

// «Демо-голос»: синтетическая огибающая, похожая на речь по слогам и паузам
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function demoVoice(t, gated = true) {
  const gate = gated ? smooth(-0.25, 0.25, Math.sin(t * 0.85)) : 1;
  const syl = Math.max(0, Math.sin(t * 9.0 + Math.sin(t * 2.3) * 2.0));
  const wob = 0.55 + 0.45 * Math.sin(t * 5.3 + Math.sin(t * 1.7) * 3.0);
  const level = syl * wob * gate;
  return {
    level,
    bass: level * (0.6 + 0.4 * Math.sin(t * 3.1)),
    mid: level * (0.55 + 0.45 * Math.sin(t * 4.7 + 1)),
    high: level * (0.35 + 0.35 * Math.sin(t * 11.0)),
  };
}

function setDemo(on) {
  demoOn = on;
  if (on) { audio.ensure(); sfxReady = true; setState('speaking'); }
  else if (state === 'speaking') setState('idle');
  syncUi();
}

// ---------------------------------------------------------------- источники звука
const fileInput = document.getElementById('file');
let audioEl = null;
let lastPlay = null;      // {type: 'file', url} | {type: 'text'} - что повторять кнопкой «Повтор»
let loopOn = false;
let simTalk = false;      // имитация речи, когда читает голос браузера (его звук анализировать нельзя)
async function playUrl(url, { silent = false, keepSpeaking = false, loop = false } = {}) {
  if (demoOn) setDemo(false);
  if (audioEl) { audioEl.pause(); audio.disconnectElement(audioEl); }
  const el = new Audio();
  audioEl = el;
  el.crossOrigin = 'anonymous';
  el.src = url;
  el.loop = loop;
  await audio.connectElement(el);
  sfxReady = true;
  el.onplay = () => setState('speaking', silent);
  el.onended = () => { if (!keepSpeaking) setState('idle'); };
  return el.play();
}
// файл целиком: запоминаем для повтора
function playFile(url) {
  reader.stop();
  lastPlay = { type: 'file', url };
  syncUi();
  return playUrl(url, { loop: loopOn });
}
const playFileSafe = (url) => playFile(url).catch((e) => showCaption(`Не удалось воспроизвести: ${e.message}`));
function replay() {
  if (!lastPlay) return;
  if (lastPlay.type === 'text') { startReading(); return; }
  if (audioEl && audioEl.src === lastPlay.url) {
    if (demoOn) setDemo(false);
    audioEl.currentTime = 0;
    audioEl.play().catch((e) => showCaption(`Не удалось воспроизвести: ${e.message}`));
  } else playFileSafe(lastPlay.url);
}
function toggleLoop() {
  loopOn = !loopOn;
  if (audioEl && lastPlay && lastPlay.type === 'file') audioEl.loop = loopOn;
  syncUi();
}
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (f) playFileSafe(URL.createObjectURL(f));
  fileInput.value = '';
});
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|weba)$/i;
const TEXT_EXT = /\.(txt|md|text|log)$/i;
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  // тип у части файлов (flac, m4a) приходит пустым, поэтому смотрим и на расширение
  if (f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)) playFileSafe(URL.createObjectURL(f));
  else if (f.type.startsWith('text/') || TEXT_EXT.test(f.name)) loadTextFile(f);
});

async function toggleMic() {
  if (audio.micActive) { audio.stopMic(); if (state === 'listening') setState('idle'); }
  else {
    try { await audio.startMic(); sfxReady = true; setState('listening'); }
    catch (e) { showCaption(`Микрофон недоступен: ${e.message}`); }
  }
  syncUi();
}

async function toggleCam() {
  if (tracker.running) { tracker.stop(); camStatus = ''; }
  else {
    try { await tracker.start((s) => { camStatus = s; syncUi(); }); }
    catch (e) { camStatus = ''; tracker.stop(); showCaption(`Камера/трекинг недоступны: ${e.message}`); }
  }
  syncUi();
}

// ---------------------------------------------------------------- мост с агентом (WebSocket)
let ws = null;
let wsOk = false;
function connectWS(url) {
  let closed = false;
  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { wsOk = true; syncUi(); };
    ws.onclose = () => { wsOk = false; syncUi(); if (!closed) setTimeout(open, 2000); };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.state) setState(m.state);
      if (m.shape) setShape(m.shape);
      if (m.voice) setVoice(m.voice);
      if (typeof m.level === 'number') audio.setExternal(m.level, m.bands);
      if (typeof m.text === 'string') showCaption(m.text);
      if (m.burst) burst = Math.max(burst, Number(m.burst) || 1);
      if (m.audioUrl) playFileSafe(m.audioUrl);
      if (typeof m.read === 'string' && m.read.trim()) { tp.text.value = m.read; startReading(); }
    };
  };
  open();
  return () => { closed = true; if (ws) ws.close(); };
}
const wsParam = new URLSearchParams(location.search).get('ws');
if (wsParam) connectWS(wsParam);
else if (location.port === '8780') connectWS(`ws://${location.hostname}:8781`);

// ---------------------------------------------------------------- чтение текста
const tp = {
  panel: document.getElementById('textpanel'), text: document.getElementById('tp-text'),
  file: document.getElementById('tp-file'), voice: document.getElementById('tp-voice'),
  rate: document.getElementById('tp-rate'), read: document.getElementById('tp-read'),
  stop: document.getElementById('tp-stop'), note: document.getElementById('tp-note'),
  progress: document.getElementById('tp-progress'), close: document.getElementById('tp-close'),
};
let readProg = { i: 0, n: 0 };
const note = (t) => { tp.note.textContent = t; };

// проиграть фрагмент и дождаться конца (или паузы при «Стоп»)
function playAndWait(url, opts) {
  return playUrl(url, opts).then(() => new Promise((resolve, reject) => {
    const el = audioEl;
    el.addEventListener('ended', () => resolve(), { once: true });
    el.addEventListener('pause', () => resolve(), { once: true });
    el.addEventListener('error', () => reject(new Error('не удалось воспроизвести аудио')), { once: true });
  }));
}

// запасной путь: голос браузера (звук недоступен для анализа, рот двигается по имитации)
function speakWeb(item, { first, last }) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(item.text);
    const v = item.voice && speechSynthesis.getVoices().find((x) => `web:${x.voiceURI}` === item.voice.id);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = Math.min(2, Math.max(0.5, 1 + item.rate * 0.1));
    const end = () => { simTalk = false; if (last) setState('idle'); resolve(); };
    u.onend = end;
    u.onerror = end;
    simTalk = true;
    setState('speaking', !first);
    speechSynthesis.speak(u);
  });
}

const reader = new Reader({
  playChunk: (item, { first, last }) => {
    if (item.web) return speakWeb(item, { first, last });
    if (demoOn) setDemo(false);
    return playAndWait(item.url, { silent: !first, keepSpeaking: !last }).finally(() => URL.revokeObjectURL(item.url));
  },
  onStart: (n) => { lastPlay = { type: 'text' }; readProg = { i: 0, n }; note(''); syncUi(); },
  onProgress: (i, n) => { readProg = { i, n }; tp.progress.textContent = `${i}/${n}`; syncUi(); },
  onCaption: (t) => showCaption(t),
  onNote: note,
  onStop: () => {
    if (audioEl) audioEl.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    simTalk = false;
    if (state === 'speaking') setState('idle', true);
  },
  onEnd: () => { simTalk = false; tp.progress.textContent = ''; syncUi(); },
});

function startReading() {
  wake();
  if (!tp.text.value.trim()) { openPanel(true); note('Введите текст или загрузите файл .txt'); return; }
  reader.read(tp.text.value, { voiceId: tp.voice.value, rate: Number(tp.rate.value), loop: () => loopOn });
}
function stopReading() { reader.stop(); tp.progress.textContent = ''; syncUi(); }
function openPanel(open) { tp.panel.hidden = !open; if (open) tp.text.focus(); syncUi(); }

async function loadTextFile(f) {
  const MAX = 300000;
  let text = decodeText(await f.arrayBuffer());
  const cut = text.length > MAX;
  if (cut) text = text.slice(0, MAX);
  tp.text.value = text;
  saveText();
  openPanel(true);
  note(`Загружено: ${f.name}, ${text.length} симв.${cut ? ' (обрезано)' : ''}`);
}

function fillVoices() {
  const keep = tp.voice.value;
  tp.voice.innerHTML = '';
  tp.voice.add(new Option('Голос: авто (по языку текста)', ''));
  for (const v of reader.voices()) tp.voice.add(new Option(`${v.name} (${v.culture})`, v.id));
  tp.voice.value = keep;
  if (tp.voice.selectedIndex < 0) tp.voice.selectedIndex = 0;
}
reader.loadVoices().then(fillVoices);
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { if (!reader.serverOk) fillVoices(); });

const saveText = () => { try { localStorage.setItem('orb.text', tp.text.value); } catch { /* приватный режим */ } };
try { tp.text.value = localStorage.getItem('orb.text') || ''; } catch { /* нет доступа */ }
tp.text.addEventListener('input', saveText);
tp.read.addEventListener('click', startReading);
tp.stop.addEventListener('click', stopReading);
tp.close.addEventListener('click', () => openPanel(false));
tp.file.addEventListener('change', () => { const f = tp.file.files[0]; if (f) loadTextFile(f); tp.file.value = ''; });

// публичный API для отладки и встраивания
window.orb = {
  setState, setShape, setVoice, showCaption, playUrl, setDemo, burst: (v = 1) => { burst = v; },
  audio, face, shared, camera, reader, startReading, replay, replayIntro, STATES: Object.keys(STATES), VOICES: VOICE_NAMES,
};

// ---------------------------------------------------------------- UI
const q = (s) => document.querySelector(s);
function syncUi() {
  document.querySelectorAll('[data-state]').forEach((b) => b.classList.toggle('on', b.dataset.state === state));
  document.querySelectorAll('[data-shape]').forEach((b) => b.classList.toggle('on', b.dataset.shape === shapeName));
  document.querySelectorAll('[data-voice]').forEach((b) => b.classList.toggle('on', b.dataset.voice === voiceName));
  q('#btn-demo').classList.toggle('on', demoOn);
  q('#btn-mic').classList.toggle('on', audio.micActive);
  q('#btn-cam').classList.toggle('on', tracker.running);
  q('#btn-sfx').classList.toggle('on', audio.sfxOn);
  q('#btn-replay').disabled = !lastPlay;
  q('#btn-loop').classList.toggle('on', loopOn);
  q('#btn-text').classList.toggle('on', !tp.panel.hidden);
  tp.read.textContent = reader.running ? 'С начала' : 'Читать';
  const bits = [`<b>${STATES[state].label}</b>`, shapeName, `голос: ${VOICES[voiceName].label.toLowerCase()}`];
  if (introT < INTRO_LEN) bits.push('сборка…');
  if (reader.running && readProg.n) bits.push(`чтение ${readProg.i}/${readProg.n}`);
  if (wsOk) bits.push('агент подключён');
  if (camStatus) bits.push(camStatus);
  ui.status.innerHTML = bits.join(' · ');
}
const wake = () => { sfxReady = true; audio.ensure(); };
document.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => { wake(); if (demoOn && b.dataset.state !== 'speaking') setDemo(false); setState(b.dataset.state); }));
document.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => { wake(); setShape(b.dataset.shape); }));
document.querySelectorAll('[data-voice]').forEach((b) => b.addEventListener('click', () => { wake(); setVoice(b.dataset.voice); }));
q('#btn-demo').addEventListener('click', () => setDemo(!demoOn));
q('#btn-mic').addEventListener('click', toggleMic);
q('#btn-cam').addEventListener('click', toggleCam);
q('#btn-sfx').addEventListener('click', () => { audio.sfxOn = !audio.sfxOn; syncUi(); });
q('#btn-replay').addEventListener('click', () => { wake(); replay(); });
q('#btn-loop').addEventListener('click', toggleLoop);
q('#btn-text').addEventListener('click', () => openPanel(tp.panel.hidden));
q('#btn-intro').addEventListener('click', replayIntro);

const KEYS = { 1: 'idle', 2: 'listening', 3: 'thinking', 4: 'speaking' };
const VOICE_KEYS = { 5: 'clean', 6: 'assistant', 7: 'vocoder', 8: 'choir' };
const SHAPE_KEYS = { q: 'head', w: 'sphere', e: 'wave', r: 'torus' };
window.addEventListener('keydown', (e) => {
  // в полях ввода (текст, список голосов, ползунок) горячие клавиши не работают
  const tag = e.target && e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') { if (e.key === 'Escape') openPanel(false); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (introT < INTRO_LEN && (k === ' ' || k === 'escape')) { introT = INTRO_LEN; syncUi(); return; }   // пропуск интро
  if (KEYS[k]) { wake(); if (demoOn && KEYS[k] !== 'speaking') setDemo(false); setState(KEYS[k]); }
  else if (VOICE_KEYS[k]) { wake(); setVoice(VOICE_KEYS[k]); }
  else if (SHAPE_KEYS[k]) { wake(); setShape(SHAPE_KEYS[k]); }
  else if (k === 'd') setDemo(!demoOn);
  else if (k === 'i') replayIntro();
  else if (k === 'p') { wake(); replay(); }
  else if (k === 'l') toggleLoop();
  else if (k === 't') openPanel(tp.panel.hidden);
  else if (k === 'escape') openPanel(false);
  else if (k === 'm') toggleMic();
  else if (k === 'c') toggleCam();
  else if (k === 'x') { audio.sfxOn = !audio.sfxOn; syncUi(); }
  else if (k === 'h') ui.bar.classList.toggle('hidden');
  else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
});

// панель прячется через 5 с без движения мыши и возвращается при движении
let barTimer = 0;
function touchBar() {
  ui.bar.classList.remove('idle');
  clearTimeout(barTimer);
  barTimer = setTimeout(() => { if (!ui.bar.matches(':hover')) ui.bar.classList.add('idle'); }, 5000);
}
touchBar();
if (introT < INTRO_LEN) ui.bar.classList.add('idle');   // на время интро панель скрыта до движения мыши
window.addEventListener('keydown', touchBar);

// курсор отталкивает частицы
const pointerNdc = new THREE.Vector2(9, 9);
window.addEventListener('pointermove', (e) => {
  touchBar();
  pointerNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});
window.addEventListener('pointerleave', () => pointerNdc.set(9, 9));
window.addEventListener('pointerdown', () => {
  if (introT < INTRO_LEN) { introT = INTRO_LEN; syncUi(); return; }   // клик пропускает интро
  burst = Math.max(burst, 0.6);
});

// ---------------------------------------------------------------- цикл
const clock = new THREE.Clock();
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const hit = new THREE.Vector3();
let rotY = 0, rotX = 0, gestureHold = { n: -2, t: 0 };
let simTime = 0;
function replayIntro() { introT = 0; syncUi(); }

function step(dt) {
  simTime += dt;
  const time = simTime;
  shared.uTime.value = time;

  // звук -> uniforms
  audio.update(dt, demoOn ? demoVoice(time) : simTalk ? demoVoice(time, false) : null);
  const st = STATES[state];
  const k = 1 - Math.exp(-dt * 4);
  shared.uAccent.value.lerp(st.accent, k);
  for (const key of ['hue', 'swirl', 'contract', 'ampGain', 'intensity', 'spin']) cur[key] += (st[key] - cur[key]) * k;
  shared.uHue.value = cur.hue;
  shared.uSwirl.value = cur.swirl;
  shared.uContract.value = cur.contract;
  shared.uIntensity.value = cur.intensity;
  const idlePulse = state === 'idle' ? 0.02 + 0.015 * Math.sin(time * 1.6) : 0;
  shared.uAmp.value = audio.level * cur.ampGain + idlePulse;
  shared.uBass.value = audio.bass * cur.ampGain;
  shared.uMid.value = audio.mid * cur.ampGain;
  shared.uHigh.value = audio.high * cur.ampGain;

  // мимика
  const f = face.update(dt, { state, level: audio.level, tone: audio.tone });
  shared.uOpen.value = f.open; shared.uWide.value = f.wide; shared.uSmile.value = f.smile;
  // интро: глаза закрыты, в конце «открываются» со вспышкой
  if (introT <= INTRO_LEN + 1.2) {
    introT += dt;
    if (introT > INTRO_LEN && introT - dt <= INTRO_LEN) syncUi();
  }
  shared.uIntroT.value = introT < INTRO_LEN ? introT : 99;
  const eyesOpen = introT >= INTRO_LEN ? 1 : smooth(INTRO_LEN - 1.4, INTRO_LEN - 0.5, introT);
  const flare = Math.abs(introT - INTRO_LEN) < 1.2 ? 1.2 * Math.exp(-(((introT - INTRO_LEN) / 0.45) ** 2)) : 0;
  shared.uPucker.value = f.pucker; shared.uBlink.value = Math.max(f.blink, 1 - eyesOpen); shared.uBrow.value = f.brow;
  shared.uNod.value = f.nod; shared.uTilt.value = f.tilt; shared.uEyeGlow.value = f.eyeGlow + flare;
  shared.uGaze.value.set(f.gazeX, f.gazeY);

  // morph
  if (morphing) {
    morphT += dt / 1.6;
    shared.uMix.value = Math.min(1, morphT);
    if (morphT >= 1) finishMorph();
  }

  // всплеск (жест / клик / команда агента)
  burst *= Math.exp(-dt * 3.5);
  shared.uBurst.value = burst;

  // трекинг: поворот головы и жесты
  let targetY = Math.sin(time * 0.3) * 0.08, targetX = 0;
  if (tracker.running) {
    const o = tracker.update(performance.now());
    if (o.hasFace) { targetY += o.yaw * 0.7; targetX += o.pitch * 0.4; }
    handleGesture(o.fingers, dt);
  }
  const kr = 1 - Math.exp(-dt * 5);
  rotY += (targetY - rotY) * kr;
  rotX += (targetX - rotX) * kr;
  group.rotation.y = rotY + (state === 'thinking' ? time * cur.spin * 0.15 : 0);
  group.rotation.x = rotX;

  // курсор -> локальная точка
  if (Math.abs(pointerNdc.x) <= 1) {
    ray.setFromCamera(pointerNdc, camera);
    if (ray.ray.intersectPlane(plane, hit)) shared.uPointer.value.copy(hit).sub(group.position);
  } else shared.uPointer.value.set(99, 99, 99);
}

let frozen = false;   // отладка: orb.freeze(true) останавливает анимацию, кадры рисуются вручную через orb.advance
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!frozen) step(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// 1..4 пальца - форма, 5 - всплеск, кулак - «сжатие»
function handleGesture(n, dt) {
  if (n < 0) { gestureHold = { n: -2, t: 0 }; return; }
  if (n !== gestureHold.n) { gestureHold = { n, t: 0 }; return; }
  gestureHold.t += dt;
  if (gestureHold.t < 0.6 || gestureHold.fired) return;
  gestureHold.fired = true;
  const shapes = { 1: 'head', 2: 'sphere', 3: 'wave', 4: 'torus' };
  if (shapes[n]) setShape(shapes[n]);
  else if (n === 5) burst = 1.2;
  else if (n === 0) burst = -0.35;
}

// отладка: промотать анимацию на `seconds` вперёд и отрисовать кадр
window.orb.freeze = (on = true) => { frozen = on; };
window.orb.view = (z, y = 0) => { debugView = z ? { z, y } : null; resize(); };
window.orb.advance = (seconds = 1) => {
  for (let t = 0; t < seconds; t += 1 / 60) step(1 / 60);
  renderer.render(scene, camera);
};

// формы для морфинга готовим заранее, по одной: иначе первое переключение даёт паузу
SHAPE_NAMES.filter((n) => n !== 'head').forEach((n, i) => setTimeout(() => generateShape(n, portrait.kind), 2500 + i * 700));

syncUi();
frame();

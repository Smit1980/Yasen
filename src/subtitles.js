// Субтитры: реплики Ясеня и (по желанию) слова пользователя.
// По умолчанию: середина экрана справа от лица. Вкл/выкл и положение задаются в настройках.
import * as S from './settings.js';

const box = document.getElementById('subs');
const toastEl = document.getElementById('toast');
const MAX_LINES = 3;
let toastTimer = 0;

export function applyLayout() {
  box.className = `pos-${S.get('subsPos')}${S.get('subs') ? '' : ' off'}`;
  if (!S.get('subs')) box.replaceChildren();
}

// who: 'bot' - реплика Ясеня, 'user' - слова пользователя
export function say(text, who = 'bot') {
  if (!S.get('subs') || !text) return;
  if (who === 'user' && !S.get('subsUser')) return;
  const line = document.createElement('div');
  line.className = `line ${who}`;
  line.textContent = text;
  box.append(line);
  while (box.children.length > MAX_LINES) box.firstChild.remove();
  const life = 4500 + text.length * 55;
  setTimeout(() => { line.classList.add('out'); setTimeout(() => line.remove(), 900); }, life);
}

export function clear() { box.replaceChildren(); }

// служебные сообщения и ошибки: показываются всегда, независимо от субтитров
export function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 4500 + text.length * 40);
}

S.onChange((k) => { if (k === 'subs' || k === 'subsPos') applyLayout(); });
applyLayout();

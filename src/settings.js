// Настройки страницы: хранятся в localStorage этого браузера (если он недоступен, работают только до перезагрузки).

const KEY = 'orb.settings.v1';

export const DEFAULTS = {
  subs: true,           // субтитры вкл/выкл
  subsPos: 'right',     // right (по умолчанию: середина экрана справа от лица) | left | bottom
  subsUser: true,       // показывать и мои слова
  camDebug: true,       // окно камеры с видео и скелетом
  mirrorFace: true,     // повторять мою мимику, когда я молчу
  learn: true,          // характер меняется от общения
  filler: true,         // короткая реплика, пока Ясень думает над ответом
  effort: 'low',        // глубина рассуждений Codex: low | medium | high
  model: '',            // модель Codex (пусто - по умолчанию)
  lang: 'ru',           // язык распознавания: ru | en | auto
};

const cur = { ...DEFAULTS };
try { Object.assign(cur, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* нет доступа или битые данные */ }

const listeners = new Set();

export const get = (k) => cur[k];

export function set(k, v) {
  if (cur[k] === v) return;
  cur[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* приватный режим */ }
  listeners.forEach((fn) => fn(k, v));
}

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

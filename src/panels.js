// Боковые панели: «Характер» (системный промпт, черты, память), «Настройки» (субтитры, диалог, камера)
// и общее управление: одновременно открыта только одна панель.
import * as S from './settings.js';
import * as agent from './agentclient.js';
import { diagnose } from './tracking.js';

const $ = (id) => document.getElementById(id);
const IDS = ['textpanel', 'persona', 'settings'];

export function initPanels({ toast, onPromptSaved, onPersona, onChange = () => {} }) {
  let persona = null;

  // ---------------------------------------------------------------- общее
  const isOpen = (id) => !$(id).hidden;
  function show(id, on) {
    if (on) IDS.forEach((x) => { if (x !== id) $(x).hidden = true; });
    $(id).hidden = !on;
    if (on && id === 'persona') refreshPersona();
    if (on && id === 'settings') refreshInfo();
    onChange();
  }
  const toggle = (id) => show(id, !isOpen(id));
  const closeAll = () => IDS.forEach((id) => show(id, false));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => show(b.dataset.close, false)));

  // ---------------------------------------------------------------- характер
  const pp = { prompt: $('pp-prompt'), note: $('pp-note'), traits: $('pp-traits'), memory: $('pp-memory'), turns: $('pp-turns'), learn: $('pp-learn') };
  const note = (t, bad = false) => { pp.note.textContent = t; pp.note.classList.toggle('bad', bad); };

  function renderPersona(state, deltas = {}) {
    persona = state;
    if (document.activeElement !== pp.prompt || !pp.prompt.value) pp.prompt.value = state.prompt;
    pp.traits.replaceChildren(...state.traits.map((t) => {
      const row = document.createElement('div');
      row.className = 'trait' + (deltas[t.key] ? ' flash' : '');
      const d = deltas[t.key] ? ` <small>${deltas[t.key] > 0 ? '+' : ''}${deltas[t.key]}</small>` : '';
      row.innerHTML = `<span>${t.label}</span><div class="tbar"><i style="width:${t.value}%"></i></div><em>${Math.round(t.value)}${d}</em>`;
      return row;
    }));
    pp.memory.replaceChildren(...(state.memory.length ? state.memory : ['пока ничего']).map((m) => {
      const li = document.createElement('li');
      li.textContent = m;
      return li;
    }));
    pp.turns.textContent = state.turns ? `(реплик в разговоре: ${state.turns})` : '';
    onPersona?.(state);
  }

  async function refreshPersona() {
    try { renderPersona(await agent.persona()); note(''); } catch (e) { note(e.message, true); }
  }

  $('pp-save').addEventListener('click', async () => {
    try {
      renderPersona(await agent.setPrompt(pp.prompt.value));
      pp.prompt.value = persona.prompt;
      note('Применено');
      onPromptSaved?.();
    } catch (e) { note(e.message, true); }
  });
  $('pp-default').addEventListener('click', async () => {
    try {
      renderPersona(await agent.resetPersona('prompt'));
      pp.prompt.value = persona.prompt;
      note('Исходный промпт возвращён');
      onPromptSaved?.();
    } catch (e) { note(e.message, true); }
  });
  $('pp-reset').addEventListener('click', async () => {
    if (!confirm('Сбросить черты характера и стереть память о вас?')) return;
    try { renderPersona(await agent.resetPersona('traits')); note('Черты и память сброшены'); onPromptSaved?.(); } catch (e) { note(e.message, true); }
  });
  pp.learn.checked = S.get('learn');
  pp.learn.addEventListener('change', () => S.set('learn', pp.learn.checked));

  // ---------------------------------------------------------------- настройки
  const bind = (id, key, type = 'check') => {
    const el = $(id);
    if (type === 'check') { el.checked = S.get(key); el.addEventListener('change', () => S.set(key, el.checked)); }
    else { el.value = S.get(key); el.addEventListener('change', () => S.set(key, el.value.trim())); }
  };
  bind('st-subs', 'subs'); bind('st-pos', 'subsPos', 'value'); bind('st-user', 'subsUser');
  bind('st-lang', 'lang', 'value'); bind('st-effort', 'effort', 'value'); bind('st-model', 'model', 'value'); bind('st-filler', 'filler');
  bind('st-camdbg', 'camDebug'); bind('st-mirror', 'mirrorFace');
  S.onChange((k, v) => {   // настройки можно менять и с клавиатуры: держим галочки в актуальном состоянии
    const map = { subs: 'st-subs', subsUser: 'st-user', camDebug: 'st-camdbg', mirrorFace: 'st-mirror', filler: 'st-filler' };
    if (map[k]) $(map[k]).checked = v;
    if (k === 'learn') pp.learn.checked = v;
    onChange();
  });

  async function refreshInfo() {
    const el = $('st-info');
    try {
      const st = await agent.status();
      const c = st.codex, s = st.stt;
      el.textContent = `Codex: ${c.found ? `${c.version || 'найден'}, ${c.loggedIn ? 'вход выполнен' : 'НЕ авторизован (codex login)'}` : 'не найден'}\n` +
        `Распознавание: ${s.available ? `${s.engine} ${s.model}, ${s.loaded ? 'модель в памяти' : 'загрузится при первом диалоге'}` : 'faster-whisper не установлен'}`;
    } catch (e) { el.textContent = e.message; }
  }

  const logBox = $('st-log');
  $('st-diag').addEventListener('click', async () => {
    logBox.value = '';
    const log = (s) => { logBox.value += `${s}\n`; logBox.scrollTop = logBox.scrollHeight; };
    $('st-diag').disabled = true;
    try { await diagnose(log); } catch (e) { log(`✗ диагностика прервана: ${e.message}`); } finally { $('st-diag').disabled = false; }
  });
  $('st-diagcopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(logBox.value); toast('Отчёт скопирован'); } catch { logBox.select(); toast('Выделено: нажмите Ctrl+C'); }
  });

  return { show, toggle, closeAll, isOpen, renderPersona, refreshPersona };
}

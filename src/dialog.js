// Диалог: микрофон -> локальное распознавание -> Codex (от лица Ясеня) -> озвучка.
// Пока Ясень думает или говорит, микрофон не слушает (нет эха и самоперебивания).
import * as agent from './agentclient.js';
import * as S from './settings.js';
import { Listener } from './listener.js';

const FILLERS = {
  ru: ['Хм, дай-ка подумаю.', 'Секунду, собираю мысли.', 'Интересно. Сейчас отвечу.'],
  en: ['Hm, let me think.', 'One moment, gathering my thoughts.'],
};
const isRu = (t) => (t.match(/[Ѐ-ӿ]/g) || []).length >= (t.match(/[A-Za-z]/g) || []).length;

export class Dialog {
  // hooks: audio, setState(name, silent), speak(text) -> Promise, say(text, who), toast(text),
  //        onReply(result), onHeard(text), onChange()
  constructor(hooks) {
    this.h = hooks;
    this.listener = null;
    this.active = false;
    this.busy = false;
    this.phase = 'off';      // off | listening | hearing | thinking | speaking
    this.lastError = '';
  }

  get level() { return this.listener ? this.listener.level : 0; }
  get threshold() { return this.listener ? this.listener.threshold : 0; }

  setPhase(p) {
    this.phase = p;
    this.h.onChange?.();
  }

  async start() {
    if (this.active) return;
    let st;
    try {
      st = await agent.status();
    } catch (e) {
      this.h.toast(e.message);
      return;
    }
    if (!st.codex.found) { this.h.toast(`Codex не найден: ${st.codex.detail}`); return; }
    if (!st.codex.loggedIn) { this.h.toast('Codex не авторизован: выполните в терминале «codex login»'); return; }
    if (!st.stt.available) { this.h.toast('Не установлен faster-whisper: pip install faster-whisper'); return; }
    agent.warmStt().catch(() => {});
    try {
      const audio = this.h.audio;
      audio.ensure();
      if (!audio.micActive) await audio.startMic();
      this.listener = new Listener(audio.ctx);
      await this.listener.start(audio.micStream, {
        onUtterance: (wav) => this.onUtterance(wav),
        onStart: () => { if (!this.busy) this.setPhase('hearing'); },
      });
    } catch (e) {
      this.h.toast(`Микрофон недоступен: ${e.message}`);
      this.stop();
      return;
    }
    this.active = true;
    this.busy = false;
    this.resume();
  }

  stop() {
    this.active = false;
    this.busy = false;
    if (this.listener) { this.listener.stop(); this.listener = null; }
    if (this.h.audio.micActive) this.h.audio.stopMic();
    this.setPhase('off');
    this.h.setState('idle', true);
  }

  resume() {
    if (!this.active) return;
    if (this.listener) this.listener.muted = false;
    this.busy = false;
    this.setPhase('listening');
    this.h.setState('listening', true);
  }

  // одна фраза пользователя: распознать -> спросить Codex -> озвучить
  async onUtterance(wav) {
    if (!this.active || this.busy) return;
    this.busy = true;
    this.listener.muted = true;
    this.setPhase('thinking');
    this.h.setState('thinking', true);

    let text = '';
    try {
      text = (await agent.stt(wav, S.get('lang'))).text.trim();
    } catch (e) {
      this.h.toast(`Не удалось распознать речь: ${e.message}`);
      return this.resume();
    }
    if (text.length < 2) return this.resume();   // шум или тишина
    this.h.onHeard?.(text);
    this.h.say(text, 'user');

    // Codex отвечает 15-25 секунд: чтобы не молчать, коротко реагируем
    let filler = Promise.resolve();
    const timer = S.get('filler') ? setTimeout(() => {
      const list = FILLERS[isRu(text) ? 'ru' : 'en'];
      filler = this.h.speak(list[Math.floor(Math.random() * list.length)])
        .finally(() => { if (this.active && this.phase === 'thinking') this.h.setState('thinking', true); });
    }, 5000) : 0;

    let res;
    try {
      res = await agent.chat(text, { effort: S.get('effort'), model: S.get('model'), learn: S.get('learn') });
    } catch (e) {
      clearTimeout(timer);
      this.h.toast(`Ответ не получен: ${e.message}`);
      return this.resume();
    }
    clearTimeout(timer);
    await filler;
    if (!this.active) return;
    this.setPhase('speaking');
    this.h.onReply(res);
    await this.h.speak(res.reply);
    this.resume();
  }
}

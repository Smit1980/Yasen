// Чтение текста вслух. Текст режется на фрагменты по предложениям; каждый фрагмент синтезируется
// на сервере (bridge/server.py, голоса Windows) в WAV и проигрывается страницей, поэтому к нему
// применяются голосовые эффекты и мимика. Пока играет фрагмент, следующий уже готовится.
// Если сервера синтеза нет (не Windows, страница открыта без run.bat), используется голос браузера:
// звук от него анализировать нельзя, эффекты не применяются, рот двигается по имитации речи.

const CYR = /[Ѐ-ӿ]/g;
const LAT = /[A-Za-z]/g;

export function splitText(text, maxLen = 300) {
  const clean = text.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const p of parts) {
    if (p.length > maxLen) { flush(); out.push(...hardSplit(p, maxLen)); continue; }
    if (buf && buf.length + 1 + p.length > maxLen) flush();
    buf = buf ? `${buf} ${p}` : p;
    if (buf.length >= 60) flush();   // короткие предложения склеиваем, чтобы не плодить запросы
  }
  flush();
  return out;
}

function hardSplit(s, maxLen) {
  const out = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(', ', maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Русские .txt часто в windows-1251: пробуем UTF-8 строго, иначе 1251
export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(buffer);
  }
}

const webVoices = () => ('speechSynthesis' in window ? speechSynthesis.getVoices() : [])
  .map((v) => ({ id: `web:${v.voiceURI}`, name: v.name, culture: v.lang || '' }));

export class Reader {
  // hooks: playChunk(item, {first,last}) -> Promise, onStart(n), onProgress(i,n), onCaption(text),
  //        onNote(text), onStop(), onEnd()
  constructor(hooks) {
    this.h = hooks;
    this.token = 0;
    this.running = false;
    this.serverVoices = [];
    this.serverOk = null;   // null - ещё не проверяли
  }

  async loadVoices() {
    try {
      const r = await fetch('/tts/voices');
      if (!r.ok) throw new Error(String(r.status));
      this.serverVoices = await r.json();
      this.serverOk = this.serverVoices.length > 0;
    } catch {
      this.serverOk = false;
    }
    return this.voices();
  }

  voices() {
    return this.serverOk ? this.serverVoices.map((v) => ({ id: v.name, name: v.name, culture: v.culture })) : webVoices();
  }

  pickVoice(text, chosen) {
    const list = this.voices();
    const exact = list.find((v) => v.id === chosen);
    if (exact) return exact;
    const cyr = (text.match(CYR) || []).length, lat = (text.match(LAT) || []).length;
    const want = cyr >= lat ? 'ru' : 'en';
    return list.find((v) => v.culture.toLowerCase().startsWith(want)) || list[0] || null;
  }

  async fetchChunk(text, voice, rate) {
    if (this.serverOk) {
      try {
        const r = await fetch('/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: voice ? voice.id : '', rate }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || String(r.status));
        return { url: URL.createObjectURL(await r.blob()), text, rate };
      } catch (e) {
        this.serverOk = false;
        this.h.onNote?.(`Сервер синтеза недоступен (${e.message}): читаю голосом браузера, без эффектов`);
      }
    }
    return { web: true, text, rate, voice: this.pickVoice(text, '') };
  }

  discard(item) {
    if (item && item.url) URL.revokeObjectURL(item.url);
  }

  async read(text, { voiceId = '', rate = 0, loop = () => false } = {}) {
    this.stop();
    const chunks = splitText(text);
    if (!chunks.length) { this.h.onNote?.('Нет текста для чтения'); return; }
    const my = ++this.token;
    this.running = true;
    this.h.onStart?.(chunks.length);
    const voice = this.pickVoice(text, voiceId);
    let pending = null;
    try {
      let pass = 0;
      do {
        pending = this.fetchChunk(chunks[0], voice, rate);
        for (let i = 0; i < chunks.length; i++) {
          const item = await pending;
          pending = null;
          if (my !== this.token) { this.discard(item); return; }
          if (i + 1 < chunks.length) pending = this.fetchChunk(chunks[i + 1], voice, rate);
          this.h.onProgress?.(i + 1, chunks.length);
          this.h.onCaption?.(chunks[i]);
          const last = i === chunks.length - 1 && !loop();
          await this.h.playChunk(item, { first: i === 0 && pass === 0, last });
          if (my !== this.token) {
            if (pending) pending.then((x) => this.discard(x)).catch(() => {});
            return;
          }
        }
        pass++;
      } while (loop() && my === this.token);
    } catch (e) {
      if (my === this.token) this.h.onNote?.(`Ошибка чтения: ${e.message}`);
    } finally {
      if (my === this.token) { this.running = false; this.h.onEnd?.(); }
    }
  }

  stop() {
    const was = this.running;
    this.token++;
    this.running = false;
    if (was) this.h.onStop?.();
  }
}

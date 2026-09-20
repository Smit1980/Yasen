// Клиент моста (bridge/server.py): диалог через Codex, характер, локальное распознавание речи.

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  } catch {
    throw new Error('сервер моста недоступен: запустите run.bat и откройте страницу по адресу http://127.0.0.1:8780/');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `ошибка ${r.status}`);
  return j;
}

export const status = () => api('/agent/status');
export const warmStt = () => api('/stt/warm', { method: 'POST', body: {} });
export const stt = (wav, lang) => api('/stt', { method: 'POST', body: wav, raw: true, headers: { 'Content-Type': 'audio/wav', 'X-Lang': lang } });
export const chat = (text, opts = {}) => api('/agent/chat', { method: 'POST', body: { text, ...opts } });
export const persona = () => api('/agent/persona');
export const setPrompt = (prompt) => api('/agent/persona', { method: 'POST', body: { prompt } });
export const resetPersona = (kind) => api('/agent/persona', { method: 'POST', body: { reset: kind } });

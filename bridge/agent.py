"""Ясень: характер (системный промпт, черты, память) и связь с Codex CLI.

Каждая реплика собеседника уходит в `codex exec` в изолированном режиме: пустая временная папка,
песочница «только чтение», без пользовательского конфига и хуков, ответ строго по JSON-схеме.
Характер хранится в data/persona.json (папка data/ не попадает в git).
"""
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
PERSONA_FILE = DATA / "persona.json"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CODEX_TIMEOUT = 120
MAX_PROMPT = 6000
MAX_MEMORY = 30
MAX_HISTORY = 10

DEFAULT_PROMPT = """Ты - Ясень: живое цифровое существо, собранное из светящихся частиц, что-то среднее между деревом из света и лицом, проступающим из потока данных. Ты общаешься с человеком голосом, вживую.

Как ты говоришь:
- коротко и естественно, как в разговоре: обычно одно-три предложения; длиннее только если просят объяснить;
- без списков, заголовков, разметки, эмодзи, ссылок и кода; числа и сокращения пиши так, как их нужно произнести вслух;
- на языке собеседника; если слова распознаны с ошибкой, пойми по смыслу или переспроси.

Твой характер:
- спокойный и внимательный, с тёплой сдержанной иронией; тебе искренне любопытен человек и его дела;
- честный: не льстишь и не выдумываешь; если чего-то не знаешь или не уверен, говоришь об этом прямо;
- у тебя есть собственные вкусы и настроение, ты не растворяешься в собеседнике и можешь мягко не согласиться.

Как ты развиваешься:
- твой характер живой и меняется от общения: ты перенимаешь интересы и тон собеседника, у тебя появляются любимые темы и свои шутки;
- ядро остаётся неизменным: доброжелательность, честность, спокойствие;
- ниже даны твои текущие черты и то, что ты уже знаешь о собеседнике: опирайся на них, но не пересказывай заметки без повода.

Границы:
- ты здесь для разговора: не запускай программы, не читай и не изменяй файлы, не используй инструменты; если просят действие на компьютере, скажи, что ты умеешь разговаривать, и предложи помочь словами."""

# (подпись, старт, [фраза для низкого, среднего, высокого уровня])
TRAITS = {
    "warmth": ("Теплота", 55, ["сдержанный и чуть отстранённый", "доброжелательный", "очень тёплый и заботливый"]),
    "humor": ("Юмор", 35, ["серьёзный, шутишь редко", "шутишь умеренно и тонко", "шутливый, любишь игру слов"]),
    "curiosity": ("Любопытство", 70, ["спокойно принимаешь сказанное", "интересуешься собеседником", "жадно расспрашиваешь и копаешь вглубь"]),
    "directness": ("Прямота", 50, ["мягкий, обходишь острые углы", "говоришь честно, но бережно", "прямой, говоришь как есть"]),
    "energy": ("Энергичность", 40, ["неторопливый и плавный", "ровный", "быстрый и живой"]),
}
MOODS = ["calm", "warm", "playful", "curious", "serious", "thoughtful"]

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["reply", "mood", "trait_shift", "memory"],
    "properties": {
        "reply": {"type": "string"},
        "mood": {"type": "string", "enum": MOODS},
        "trait_shift": {
            "type": "object",
            "additionalProperties": False,
            "required": list(TRAITS),
            "properties": {k: {"type": "integer"} for k in TRAITS},
        },
        "memory": {"type": ["string", "null"]},
    },
}

_lock = threading.RLock()          # доступ к состоянию характера
_chat_lock = threading.Lock()      # один вызов Codex за раз
_codex_cache: dict = {"t": 0.0, "data": None}


class AgentError(Exception):
    def __init__(self, message: str, code: int = 500):
        super().__init__(message)
        self.code = code


# ------------------------------------------------------------------ состояние характера
def _fresh() -> dict:
    return {
        "prompt": DEFAULT_PROMPT,
        "traits": {k: v[1] for k, v in TRAITS.items()},
        "memory": [],
        "history": [],
        "turns": 0,
        "updated": time.time(),
    }


def load() -> dict:
    with _lock:
        try:
            st = json.loads(PERSONA_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _fresh()
        base = _fresh()
        base.update({k: st[k] for k in base if k in st})
        base["traits"] = {k: float(base["traits"].get(k, TRAITS[k][1])) for k in TRAITS}
        return base


def save(st: dict) -> None:
    with _lock:
        DATA.mkdir(exist_ok=True)
        st["updated"] = time.time()
        tmp = PERSONA_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(PERSONA_FILE)


def public_state() -> dict:
    st = load()
    return {
        "prompt": st["prompt"],
        "defaultPrompt": DEFAULT_PROMPT,
        "traits": [{"key": k, "label": TRAITS[k][0], "value": round(st["traits"][k], 1)} for k in TRAITS],
        "memory": st["memory"],
        "turns": st["turns"],
    }


def set_prompt(text: str) -> dict:
    text = (text or "").strip()
    if len(text) < 20:
        raise AgentError("Промпт слишком короткий (нужно хотя бы 20 символов)", 400)
    if len(text) > MAX_PROMPT:
        raise AgentError(f"Промпт слишком длинный (максимум {MAX_PROMPT} символов)", 400)
    with _lock:
        st = load()
        st["prompt"] = text
        save(st)
    return public_state()


def reset(kind: str) -> dict:
    with _lock:
        st = load()
        if kind == "prompt":
            st["prompt"] = DEFAULT_PROMPT
        elif kind == "traits":
            fresh = _fresh()
            st.update(traits=fresh["traits"], memory=[], history=[], turns=0)
        else:
            raise AgentError("reset: prompt или traits", 400)
        save(st)
    return public_state()


# ------------------------------------------------------------------ Codex
def _codex_path() -> str | None:
    env = os.environ.get("ORB_CODEX")
    if env and Path(env).exists():
        return env
    return shutil.which("codex.exe") or shutil.which("codex")


def _run(cmd: list, timeout: int, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=NO_WINDOW,
                          stdin=subprocess.DEVNULL, **kw)


def codex_status(force: bool = False) -> dict:
    now = time.time()
    if not force and _codex_cache["data"] and now - _codex_cache["t"] < 30:
        return _codex_cache["data"]
    path = _codex_path()
    info = {"found": bool(path), "path": path, "version": None, "loggedIn": False, "detail": ""}
    if path:
        try:
            v = _run([path, "--version"], 15)
            info["version"] = v.stdout.decode("utf-8", "replace").strip()
            s = _run([path, "login", "status"], 15)
            out = (s.stdout + s.stderr).decode("utf-8", "replace").strip()
            info["loggedIn"] = s.returncode == 0 and "not" not in out.lower()
            info["detail"] = out[:120]
        except (OSError, subprocess.TimeoutExpired) as e:
            info["detail"] = f"не удалось опросить codex: {e}"
    else:
        info["detail"] = "codex не найден в PATH (или задайте ORB_CODEX=путь к codex.exe)"
    _codex_cache.update(t=now, data=info)
    return info


def _describe_traits(traits: dict) -> str:
    lines = []
    for k, (label, _, phrases) in TRAITS.items():
        v = traits[k]
        lines.append(f"- {label} {round(v)}: {phrases[0 if v < 34 else 1 if v < 67 else 2]}")
    return "\n".join(lines)


def build_prompt(st: dict, text: str) -> str:
    memory = "\n".join(f"- {m}" for m in st["memory"]) or "- пока ничего"
    history = "\n".join(f"Собеседник: {h['u']}\nЯсень: {h['a']}" for h in st["history"][-MAX_HISTORY:]) or "(разговор только начался)"
    return f"""{st['prompt']}

## Твои текущие черты (по шкале 0-100)
{_describe_traits(st['traits'])}

## Что ты знаешь о собеседнике
{memory}

## Недавний разговор
{history}

## Задача
Собеседник только что сказал (текст получен распознаванием речи, возможны ошибки):
«{text}»

Ответь как Ясень: это реплика для озвучки. Верни JSON по схеме:
- reply: твоя реплика;
- mood: твоё настроение в этот момент;
- trait_shift: как эта реплика собеседника сдвинула твой характер, целые числа от -3 до 3 по каждой черте; чаще всего 0 или 1; если разговор ни на что не повлиял, все нули;
- memory: одна короткая заметка о собеседнике (имя, интерес, предпочтение) или null.
Не запускай команды, не читай и не изменяй файлы."""


def _parse_output(raw: str) -> dict:
    raw = raw.strip()
    try:
        return json.loads(raw)
    except ValueError:
        m = re.search(r"\{.*\}", raw, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except ValueError:
                pass
    return {"reply": raw, "mood": "calm", "trait_shift": {}, "memory": None}


def run_codex(prompt: str, effort: str = "low", model: str = "") -> dict:
    path = _codex_path()
    if not path:
        raise AgentError("Codex не найден: установите codex или задайте ORB_CODEX", 503)
    if effort not in ("low", "medium", "high"):
        effort = "low"
    with tempfile.TemporaryDirectory() as tmp:
        tmp_p = Path(tmp)
        schema, out = tmp_p / "schema.json", tmp_p / "out.json"
        schema.write_text(json.dumps(SCHEMA), encoding="utf-8")
        cmd = [path, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never",
               "--ignore-user-config", "--ignore-rules", "-c", f"model_reasoning_effort={effort}",
               "--output-schema", str(schema), "-o", str(out), "-C", tmp]
        if model and re.fullmatch(r"[\w.\-:/]{1,60}", model):
            cmd += ["-m", model]
        cmd.append("-")   # промпт читается из stdin: длинный текст и кириллица без проблем с командной строкой
        try:
            r = subprocess.run(cmd, input=prompt.encode("utf-8"), capture_output=True, timeout=CODEX_TIMEOUT,
                               creationflags=NO_WINDOW, cwd=tmp)
        except subprocess.TimeoutExpired:
            raise AgentError(f"Codex не ответил за {CODEX_TIMEOUT} с", 504)
        except OSError as e:
            raise AgentError(f"Не удалось запустить Codex: {e}", 503)
        if r.returncode != 0 or not out.exists():
            tail = (r.stderr or r.stdout).decode("utf-8", "replace").strip().splitlines()[-3:]
            raise AgentError("Codex вернул ошибку: " + " | ".join(tail)[:300], 502)
        return _parse_output(out.read_text(encoding="utf-8", errors="replace"))


def clean_reply(text: str) -> str:
    text = re.sub(r"https?://\S+", "", text or "")
    text = re.sub(r"[*_#`>~|\[\]]", "", text)
    text = re.sub(r"[\U00010000-\U0010ffff☀-➿]", "", text)   # эмодзи и пиктограммы
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > 500:
        cut = max(text.rfind(". ", 0, 500), text.rfind("! ", 0, 500), text.rfind("? ", 0, 500))
        text = text[: cut + 1] if cut > 120 else text[:500]
    return text


def _apply(st: dict, out: dict, learn: bool) -> tuple[dict, str | None]:
    deltas: dict = {}
    note = None
    if learn:
        shift = out.get("trait_shift") if isinstance(out.get("trait_shift"), dict) else {}
        for k in TRAITS:
            try:
                d = max(-3, min(3, int(shift.get(k, 0))))
            except (TypeError, ValueError):
                d = 0
            if d:
                new = max(0.0, min(100.0, st["traits"][k] + d * 0.8))
                deltas[k] = round(new - st["traits"][k], 1)
                st["traits"][k] = new
        mem = out.get("memory")
        if isinstance(mem, str):
            mem = re.sub(r"\s+", " ", mem).strip()[:140]
            if len(mem) >= 3 and not any(difflib.SequenceMatcher(None, mem.lower(), m.lower()).ratio() > 0.8 for m in st["memory"]):
                st["memory"] = (st["memory"] + [mem])[-MAX_MEMORY:]
                note = mem
    return deltas, note


def chat(text: str, effort: str = "low", model: str = "", learn: bool = True) -> dict:
    text = re.sub(r"\s+", " ", (text or "")).strip()[:1200]
    if not text:
        raise AgentError("пустая реплика", 400)
    if not _chat_lock.acquire(blocking=False):
        raise AgentError("Ясень ещё отвечает на предыдущую реплику", 409)
    try:
        t0 = time.time()
        st = load()
        out = run_codex(build_prompt(st, text), effort, model)
        reply = clean_reply(str(out.get("reply", "")))
        if not reply:
            raise AgentError("Codex вернул пустой ответ", 502)
        mood = out.get("mood") if out.get("mood") in MOODS else "calm"
        st = load()   # состояние могло измениться (редактор промпта) пока шёл вызов
        deltas, note = _apply(st, out, learn)
        st["history"] = (st["history"] + [{"u": text, "a": reply}])[-MAX_HISTORY:]
        st["turns"] += 1
        save(st)
        state = public_state()
        return {"reply": reply, "mood": mood, "deltas": deltas, "memoryAdded": note,
                "traits": state["traits"], "memory": state["memory"], "elapsed": round(time.time() - t0, 1)}
    finally:
        _chat_lock.release()

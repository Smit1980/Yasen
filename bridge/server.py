"""Локальный сервер Voice Orb: раздаёт страницу (http :8780), ретранслирует
JSON-сообщения между агентом и страницей (websocket :8781), синтезирует речь (POST /tts, голоса Windows),
распознаёт речь локально (POST /stt, faster-whisper) и отвечает от лица Ясеня через Codex CLI (POST /agent/chat).

Слушает только 127.0.0.1. Запуск: python bridge/server.py
"""
import asyncio
import functools
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import webbrowser
from pathlib import Path

import websockets

import agent
import stt

ROOT = Path(__file__).resolve().parent.parent
HOST = "127.0.0.1"
HTTP_PORT = 8780
WS_PORT = 8781
ALLOWED_ORIGINS = {f"http://{HOST}:{HTTP_PORT}", f"http://localhost:{HTTP_PORT}"}
MAX_BODY = 20_000        # байт на запрос /tts
MAX_TEXT = 1_500         # символов на один фрагмент
MAX_AUDIO = 2_000_000    # байт на запрос /stt (~60 с моно 16 кГц)
# служебные пути не отдаём как статику: там код моста и личные данные (характер, память, разговоры)
PRIVATE_PREFIXES = ('/data', '/bridge', '/.git', '/server.log')
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

clients: set = set()

# Текст, голос и скорость передаются через файл и переменные окружения, а не в командной строке,
# поэтому произвольный текст не может выполниться как команда.
PS_SPEAK = r"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:ORB_VOICE) { try { $s.SelectVoice($env:ORB_VOICE) } catch {} }
$s.Rate = [int]$env:ORB_RATE
$s.SetOutputToWaveFile($env:ORB_OUT)
$s.Speak([IO.File]::ReadAllText($env:ORB_IN, [Text.Encoding]::UTF8))
$s.Dispose()
"""
PS_VOICES = r"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }
$s.Dispose()
"""


def run_ps(script: str, env_extra: dict, workdir: Path) -> subprocess.CompletedProcess:
    if sys.platform != "win32":
        raise RuntimeError("синтез речи на сервере доступен только на Windows")
    ps = workdir / "s.ps1"
    ps.write_text(script, encoding="utf-8-sig")
    env = dict(os.environ, **env_extra)
    return subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps)],
        env=env, capture_output=True, timeout=60, creationflags=NO_WINDOW,
    )


_voices_cache: list | None = None


def list_voices() -> list:
    global _voices_cache
    if _voices_cache is None:
        with tempfile.TemporaryDirectory() as d:
            r = run_ps(PS_VOICES, {}, Path(d))
        voices = []
        for line in r.stdout.decode("utf-8", "replace").splitlines():
            name, sep, culture = line.strip().partition("|")
            if sep:
                voices.append({"name": name, "culture": culture})
        _voices_cache = voices
    return _voices_cache


def synth(text: str, voice: str, rate: int) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        inp, out = Path(d) / "in.txt", Path(d) / "out.wav"
        inp.write_text(text, encoding="utf-8")
        r = run_ps(PS_SPEAK, {"ORB_IN": str(inp), "ORB_OUT": str(out), "ORB_VOICE": voice, "ORB_RATE": str(rate)}, Path(d))
        if r.returncode != 0 or not out.exists():
            raise RuntimeError(r.stderr.decode("utf-8", "replace")[:300] or "синтез не удался")
        return out.read_bytes()


async def relay(ws):
    clients.add(ws)
    try:
        async for msg in ws:
            websockets.broadcast(clients - {ws}, msg)
    finally:
        clients.discard(ws)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _origin_ok(self) -> bool:
        # браузер всегда шлёт Origin при POST; чужие сайты отсекаем
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def _body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > limit:
            raise agent.AgentError("слишком большой или пустой запрос", 413)
        return self.rfile.read(length)

    def _guard(self, ctype: str | None = None) -> bool:
        """Только со страницы проекта: проверка Origin и типа содержимого (чужой сайт не сможет вызвать)."""
        if not self._origin_ok():
            self._json(403, {"error": "origin"})
            return False
        if ctype and not (self.headers.get("Content-Type") or "").lower().startswith(ctype):
            self._json(415, {"error": f"нужен Content-Type: {ctype}"})
            return False
        return True

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith(PRIVATE_PREFIXES):
            return self._json(404, {"error": "not found"})
        if path == "/tts/voices":
            if not self._guard():
                return
            try:
                return self._json(200, list_voices())
            except Exception as e:  # noqa: BLE001
                return self._json(501, {"error": str(e)})
        if path == "/agent/status":
            if not self._guard():
                return
            return self._json(200, {"codex": agent.codex_status(), "stt": stt.status(), "persona": agent.public_state()})
        if path == "/agent/persona":
            if not self._guard():
                return
            return self._json(200, agent.public_state())
        return super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/tts":
                return self._tts()
            if self.path == "/stt":
                if not self._guard("audio/wav"):
                    return
                q = self.headers.get("X-Lang", "ru")[:8]
                return self._json(200, stt.transcribe(self._body(MAX_AUDIO), q))
            if self.path == "/stt/warm":
                if not self._guard("application/json"):
                    return
                self._body(1000)
                stt.warm()
                return self._json(200, stt.status())
            if self.path == "/agent/chat":
                if not self._guard("application/json"):
                    return
                d = json.loads(self._body(MAX_BODY))
                return self._json(200, agent.chat(str(d.get("text", "")), str(d.get("effort", "low")),
                                                  str(d.get("model", "")), bool(d.get("learn", True))))
            if self.path == "/agent/persona":
                if not self._guard("application/json"):
                    return
                d = json.loads(self._body(MAX_BODY))
                if d.get("reset"):
                    return self._json(200, agent.reset(str(d["reset"])))
                return self._json(200, agent.set_prompt(str(d.get("prompt", ""))))
            return self._json(404, {"error": "not found"})
        except agent.AgentError as e:
            return self._json(e.code, {"error": str(e)})
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": f"{type(e).__name__}: {e}"[:300]})

    def _tts(self):
        if not self._guard():
            return
        try:
            data = json.loads(self._body(MAX_BODY))
            text = str(data.get("text", "")).strip()[:MAX_TEXT]
            if not text:
                return self._json(400, {"error": "пустой текст"})
            voice = str(data.get("voice", ""))[:80]
            rate = max(-10, min(10, int(data.get("rate", 0))))
            wav = synth(text, voice, rate)
        except agent.AgentError as e:
            return self._json(e.code, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self._json(501, {"error": str(e)})
        self._send(200, wav, "audio/wav")


def serve_http():
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer((HOST, HTTP_PORT), handler) as srv:
        srv.serve_forever()


async def main():
    threading.Thread(target=serve_http, daemon=True).start()
    async with websockets.serve(relay, HOST, WS_PORT):
        url = f"http://{HOST}:{HTTP_PORT}/"
        print(f"Voice Orb: {url}   (ws://{HOST}:{WS_PORT})  Ctrl+C - выход")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

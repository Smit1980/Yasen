"""Клиент для вашего ИИ-агента: шлёт состояние и уровень голоса в Voice Orb.

    from orb_client import OrbClient
    orb = OrbClient()
    orb.state("thinking")
    orb.say("Привет!", state="speaking")
    orb.level(0.6)                       # вызывать 30-60 раз/с, пока звучит голос
    orb.stream_wav("reply.wav")          # уровни из WAV-файла в реальном времени

Аудио этот клиент не проигрывает: играйте звук своим способом (или пошлите
audioUrl, тогда его проиграет страница), а уровни отправляйте параллельно.
"""
import array
import json
import math
import time
import wave

from websockets.sync.client import connect

STATES = ("idle", "listening", "thinking", "speaking")
SHAPES = ("head", "sphere", "wave", "torus")
VOICES = ("clean", "assistant", "vocoder", "choir")


class OrbClient:
    def __init__(self, url: str = "ws://127.0.0.1:8781"):
        self.ws = connect(url)

    def send(self, **msg) -> None:
        self.ws.send(json.dumps(msg, ensure_ascii=False))

    def state(self, name: str, text: str | None = None) -> None:
        assert name in STATES, f"state must be one of {STATES}"
        self.send(state=name, **({"text": text} if text else {}))

    def shape(self, name: str) -> None:
        assert name in SHAPES, f"shape must be one of {SHAPES}"
        self.send(shape=name)

    def voice(self, name: str) -> None:
        """Голосовой эффект для звука, который проигрывает страница (audioUrl / файл)."""
        assert name in VOICES, f"voice must be one of {VOICES}"
        self.send(voice=name)

    def read(self, text: str) -> None:
        """Страница прочитает текст вслух (синтез на сервере, голосовой режим и мимика включатся сами)."""
        self.send(read=text)

    def say(self, text: str, state: str = "speaking") -> None:
        self.send(state=state, text=text)

    def burst(self, power: float = 1.0) -> None:
        self.send(burst=power)

    def level(self, level: float, bands: tuple[float, float, float] | None = None) -> None:
        msg = {"level": round(float(level), 4)}
        if bands:
            msg["bands"] = [round(float(b), 4) for b in bands]
        self.send(**msg)

    def stream_wav(self, path: str, chunk_ms: int = 20, gain: float = 3.2) -> None:
        """Читает 16-bit PCM WAV и в реальном времени шлёт RMS-уровень."""
        with wave.open(path, "rb") as w:
            assert w.getsampwidth() == 2, "нужен 16-bit PCM WAV"
            ch, rate = w.getnchannels(), w.getframerate()
            frames = int(rate * chunk_ms / 1000)
            t0 = time.perf_counter()
            n = 0
            while True:
                raw = w.readframes(frames)
                if not raw:
                    break
                s = array.array("h", raw)
                rms = math.sqrt(sum(v * v for v in s) / max(len(s), 1)) / 32768
                self.level(min(1.0, rms * gain))
                n += 1
                delay = t0 + n * chunk_ms / 1000 - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
        self.level(0.0)

    def close(self) -> None:
        self.ws.close()


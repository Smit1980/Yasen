"""Локальное распознавание речи (faster-whisper, всё на этом компьютере, без интернета).

Модель берётся строго из локального кэша Hugging Face (local_files_only): ничего не скачивается.
Переменные окружения: ORB_STT_MODEL (по умолчанию small; есть base), ORB_STT_THREADS.
"""
import io
import os
import threading
import time
import wave

os.environ.setdefault("HF_HUB_OFFLINE", "1")   # даже случайно не ходить в сеть

MODEL_NAME = os.environ.get("ORB_STT_MODEL", "small")
MAX_SECONDS = 30

# частые «галлюцинации» модели на тишине и шуме
HALLUCINATIONS = (
    "продолжение следует", "субтитры сделал", "субтитры создавал", "редактор субтитров", "спасибо за просмотр",
    "подписывайтесь на канал", "благодарю за внимание", "thanks for watching", "subtitles by", "amara.org",
)

_model = None
_lock = threading.Lock()
_loading = False
_error: str | None = None


def _load() -> None:
    global _model, _error, _loading
    try:
        from faster_whisper import WhisperModel
        threads = int(os.environ.get("ORB_STT_THREADS", "0")) or 0
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
        _error = None
    except Exception as e:  # noqa: BLE001
        _error = f"{type(e).__name__}: {e}"[:300]
    finally:
        _loading = False


def warm() -> None:
    """Загрузить модель в фоне (первый запрос тогда не ждёт)."""
    global _loading
    with _lock:
        if _model is None and not _loading:
            _loading = True
            threading.Thread(target=_load, daemon=True).start()


def status() -> dict:
    try:
        import faster_whisper  # noqa: F401
        available = True
    except ImportError:
        available = False
    return {"engine": "faster-whisper", "model": MODEL_NAME, "available": available,
            "loaded": _model is not None, "loading": _loading, "error": _error}


def transcribe(wav_bytes: bytes, lang: str = "ru") -> dict:
    """WAV 16 кГц моно 16 бит -> {text, lang, ms}."""
    import numpy as np

    try:
        with wave.open(io.BytesIO(wav_bytes)) as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != 16000:
                raise ValueError("нужен WAV 16 кГц, моно, 16 бит")
            if w.getnframes() / 16000 > MAX_SECONDS:
                raise ValueError(f"запись длиннее {MAX_SECONDS} с")
            pcm = w.readframes(w.getnframes())
    except wave.Error as e:
        raise ValueError(f"некорректный WAV: {e}") from e

    global _model
    with _lock:
        if _model is None:
            global _loading
            _loading = True
            _load()
    if _model is None:
        raise RuntimeError(_error or "модель распознавания не загрузилась")

    t0 = time.time()
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, info = _model.transcribe(
        audio, language=None if lang in ("", "auto") else lang, beam_size=1, temperature=0.0,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False, no_speech_threshold=0.6,
    )
    parts = []
    for s in segments:
        if s.no_speech_prob > 0.6 or s.avg_logprob < -1.3:
            continue
        parts.append(s.text.strip())
    text = " ".join(p for p in parts if p).strip()
    low = text.lower()
    if any(h in low for h in HALLUCINATIONS):
        text = ""
    return {"text": text, "lang": info.language, "ms": int((time.time() - t0) * 1000)}

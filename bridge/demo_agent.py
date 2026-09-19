"""Пример «агента»: проходит по состояниям и формам, имитируя реплику.
Запустите сначала server.py, откройте страницу, затем: python bridge/demo_agent.py
"""
import math
import time

from orb_client import OrbClient

orb = OrbClient()
try:
    orb.state("listening", "Слушаю...")
    time.sleep(2)
    orb.state("thinking", "Думаю над ответом...")
    time.sleep(2.5)
    orb.state("speaking", "Готово! Вот как выглядит мой голос.")
    t0 = time.perf_counter()
    while (t := time.perf_counter() - t0) < 6:
        gate = max(0.0, math.sin(t * 0.9 + 0.3))
        syl = max(0.0, math.sin(t * 9 + math.sin(t * 2.3) * 2))
        lvl = syl * gate
        orb.level(lvl, (lvl * 0.9, lvl * 0.7, lvl * 0.45))
        time.sleep(1 / 50)
    orb.burst(1.0)
    for shape in ("sphere", "wave", "torus", "head"):
        orb.shape(shape)
        time.sleep(2.2)
    orb.state("idle", "")
finally:
    orb.close()

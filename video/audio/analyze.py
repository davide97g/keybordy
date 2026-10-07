"""Tempo, beats and an energy map of a track, to choose the music edit.

    uv run python analyze.py <file>...
"""
from __future__ import annotations

import sys

import librosa
import numpy as np


def describe(path: str) -> None:
    y, sr = librosa.load(path, sr=22050, mono=True)
    dur = len(y) / sr
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    rms = librosa.feature.rms(y=y, hop_length=512)[0]
    t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=512)
    db = 20 * np.log10(rms / rms.max() + 1e-6)
    print(f"\n{path}\n  {dur:.1f} s, tempo {float(np.atleast_1d(tempo)[0]):.1f} BPM, {len(beats)} beats, first beat {beats[0]:.2f}s")
    # energy per 2 s
    line = []
    for s in np.arange(0, dur, 2.0):
        m = (t >= s) & (t < s + 2)
        line.append(f"{int(s):3d}:{db[m].mean():5.1f}")
    for i in range(0, len(line), 8):
        print("  " + "  ".join(line[i:i + 8]))
    # biggest jumps in energy (candidate drops)
    win = int(1.0 * sr / 512)
    sm = np.convolve(db, np.ones(win) / win, mode="same")
    jump = sm[win:] - sm[:-win]
    idx = np.argsort(jump)[::-1]
    picks = []
    for i in idx:
        tt = t[i + win // 2]
        if all(abs(tt - p) > 4 for p in picks):
            picks.append(tt)
        if len(picks) == 6:
            break
    print("  energy jumps at:", ", ".join(f"{p:.1f}s" for p in sorted(picks)))


if __name__ == "__main__":
    for p in sys.argv[1:]:
        describe(p)

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
diarize.py —— 用 sherpa-onnx 做发言人分离（离线、CPU 可跑、无需 HuggingFace token）

用法：
  python diarize.py --wav 输入.wav --out 输出.json [--speakers 2] [--threshold 0.5]
输入要求：16kHz 单声道 16bit wav（make-notes 的前处理已经产出这种）
输出：{"speakers": N, "segments": [{"start": 0.0, "end": 3.2, "speaker": 0}, ...]}
"""
import argparse
import json
import os
import sys
import tarfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # 课堂笔记\
MODEL_DIR = os.path.join(ROOT, '模型')
SEG_TAR = os.path.join(MODEL_DIR, 'seg.tar.bz2')
SEG_DIR = os.path.join(MODEL_DIR, 'segmentation')
EMB = os.path.join(MODEL_DIR, '3dspeaker.onnx')


def ensure_segmentation():
    if os.path.isdir(SEG_DIR):
        for dirpath, _dirs, files in os.walk(SEG_DIR):
            for f in files:
                if f.endswith('.onnx'):
                    return os.path.join(dirpath, f)
    if not os.path.exists(SEG_TAR):
        raise SystemExit('缺少分段模型：' + SEG_TAR)
    os.makedirs(SEG_DIR, exist_ok=True)
    with tarfile.open(SEG_TAR, 'r:bz2') as tf:
        tf.extractall(SEG_DIR)
    for dirpath, _dirs, files in os.walk(SEG_DIR):
        for f in files:
            if f.endswith('.onnx'):
                return os.path.join(dirpath, f)
    raise SystemExit('解压后没找到 .onnx')


def read_wav(path):
    with wave.open(path, 'rb') as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        data = w.readframes(n)
    if ch != 1:
        raise SystemExit('需要单声道 wav，当前 %d 声道' % ch)
    if sw != 2:
        raise SystemExit('需要 16bit wav，当前 %d 字节/样本' % sw)
    samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wav', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--speakers', type=int, default=-1, help='已知人数就填，未知填 -1 自动聚类')
    ap.add_argument('--threshold', type=float, default=0.5, help='聚类阈值，越小越容易合并为同一人')
    args = ap.parse_args()

    try:
        import sherpa_onnx
    except ImportError:
        raise SystemExit('未安装 sherpa-onnx：请运行 python -m pip install sherpa-onnx')

    seg_model = ensure_segmentation()
    if not os.path.exists(EMB):
        raise SystemExit('缺少声纹模型：' + EMB)

    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg_model),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMB),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=args.speakers, threshold=args.threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if hasattr(cfg, 'validate') and not cfg.validate():
        raise SystemExit('配置校验失败，请检查模型文件')

    samples, sr = read_wav(args.wav)
    if sr != 16000:
        raise SystemExit('输入必须是 16kHz，当前 %d Hz' % sr)

    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    result = sd.process(samples)

    segments = []
    try:
        items = result.sort_by_start_time()
    except Exception:
        items = list(result)
    for s in items:
        try:
            start, end, spk = float(s.start), float(s.end), int(s.speaker)
        except AttributeError:
            start, end, spk = float(s[0]), float(s[1]), int(s[2])
        segments.append({'start': round(start, 3), 'end': round(end, 3), 'speaker': spk})
    speakers = sorted(set(x['speaker'] for x in segments)) if segments else []

    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump({'speakers': len(speakers), 'segments': segments}, fh, ensure_ascii=False)
    print('发言人 %d 位｜片段 %d 段｜总时长 %.1f 秒 → %s' % (
        len(speakers), len(segments), sum(x['end'] - x['start'] for x in segments), args.out))
    # 说话时长占比，便于判断谁是主讲
    if segments:
        total = {}
        for x in segments:
            total[x['speaker']] = total.get(x['speaker'], 0.0) + (x['end'] - x['start'])
        for k in sorted(total, key=lambda k: -total[k]):
            print('  S%d: %.1f 秒 (%.0f%%)' % (k, total[k], 100.0 * total[k] / sum(total.values())))
    return 0


if __name__ == '__main__':
    sys.exit(main())

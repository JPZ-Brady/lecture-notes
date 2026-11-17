/*
 * _test-chunk.js —— 长音频分段转写自测（纯函数 + 真实切段，不跑 whisper、不花 GPU/API）
 *
 * 为什么要有它（2026-10-13 的真实故障）：
 *   105 分钟的录音里只有课间那 8 分钟（54.5–62.8）陷入循环幻觉，可质量门是**整条**的 ——
 *   8 分钟不干净就否掉整份 105 分钟，于是「5 个参数档 × 3 个模型 = 15 次」全试一遍，
 *   每次 160–230 秒，用户看到的就是「一直在转写」（最多 ~50 分钟）。
 *   修法＝长音频分段转写 + 逐段质量门 + 坏段突发去重/丢弃 + 合并 srt。
 *   这个套件守住其中**不需要 whisper 也能验**的那部分：去重口径、srt 合并与时间轴平移、切段。
 *
 * 用法：node _test-chunk.js        （全绿退出码 0，有红退出码 1）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('./make-notes.js');

let pass = 0, fail = 0;
const chk = (cond, good, bad) => {
  if (cond) { pass++; console.log('[√] ' + good); } else { fail++; console.log('[X] ' + bad); }
};

/* ---------- ① srt 时间戳格式化 ---------- */
chk(M.srtTime(0) === '00:00:00,000' && M.srtTime(3661.5) === '01:01:01,500',
  'srtTime 基本格式（0 → 00:00:00,000；3661.5 → 01:01:01,500）',
  'srtTime 格式错：' + M.srtTime(0) + ' / ' + M.srtTime(3661.5));
chk(M.srtTime(59.9996) === '00:01:00,000',
  'srtTime 毫秒进位不越界（59.9996 → 00:01:00,000，不会写成 00:00:60,000）',
  'srtTime 进位错：' + M.srtTime(59.9996));

/* ---------- ② 突发去重（循环幻觉 vs 真话重复）---------- */
chk(M.normLine('  Is there a GIRLFRIEND?! ') === 'is there a girlfriend',
  'normLine：大小写/标点/空白归一，用来判断"是不是同一句"',
  'normLine 归一错：' + JSON.stringify(M.normLine('  Is there a GIRLFRIEND?! ')));

const segs2 = [
  { start: 1, end: 3, text: 'Hello there.' },
  { start: 3.5, end: 4, text: 'Hello there.' },      /* 2.5 秒后重复 → 循环幻觉，该丢 */
  { start: 40, end: 42, text: 'Hello there.' },      /* 40 秒后重复 → 像真话，该留 */
];
const d2 = M.dedupeBursts(segs2, 30);
chk(d2.segs.length === 3 - 1 && d2.dropped.length === 1 && d2.segs[1].start === 40,
  '突发去重：30 秒内重复的丢掉、间隔 40 秒的真重复保留（105 分钟录音里 "Is there a girlfriend?" 连发 15 次就是这么清的）',
  '突发去重口径不对：留下 ' + d2.segs.length + ' 段、丢掉 ' + d2.dropped.length + ' 段');

const chain = [];
for (let i = 0; i < 6; i++) chain.push({ start: i * 2, end: i * 2 + 1.5, text: 'It is hot.' });
const d3 = M.dedupeBursts(chain, 30);
chk(d3.segs.length === 1 && d3.dropped.length === 5,
  '连续循环（每 2 秒一次、共 6 次）只留第一次：链式重复也清得掉',
  '链式循环没清干净：留下 ' + d3.segs.length + ' 段');

/* ---------- ③ srt 合并：时间轴平移 + 连续编号 ---------- */
const shift = M.srtOf([{ start: 0, end: 2.5, text: 'a' }, { start: 600, end: 601, text: 'b' }], 600, 7);
const back = M.parseSrt(shift);
chk(back.length === 2 && back[0].start === 600 && back[1].start === 1200 && /^7\r?\n/.test(shift),
  'srtOf：时间轴按段偏移平移（0→600、600→1200）、编号从指定值连续编，且能被 parseSrt 原样读回',
  'srt 合并错：' + JSON.stringify(back));
chk(M.parseSrt(M.srtOf([], 0, 1)).length === 0,
  'srtOf 空输入不产生垃圾段（整段被丢弃时不会写出半截 srt）',
  '空输入却产出了段落');

/* ---------- ④ 切段（真跑一次 ffmpeg，不跑 whisper）---------- */
const TMP = path.join(os.tmpdir(), 'test-chunk-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const ffmpeg = M.findFfmpeg();
const wav = path.join(TMP, 'tone.wav');
M.run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=150',
  '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 'ffmpeg');
const parts = M.chunkAudio(ffmpeg, wav, path.join(TMP, 'seg'), 60);
const total = parts.reduce((s, x) => s + x.durSec, 0);
chk(parts.length === 3 && parts[0].offsetSec === 0 && Math.abs(parts[1].offsetSec - 60) < 0.5
  && Math.abs(parts[2].offsetSec - 120) < 0.5 && Math.abs(total - 150) < 1,
  '切段：150 秒音频按 60 秒切成 3 段，偏移 0/60/120 秒、总时长不丢（' + parts.length + ' 段，合计 ' + total.toFixed(1) + 's）',
  '切段不对：' + JSON.stringify(parts.map((x) => ({ off: x.offsetSec, dur: x.durSec }))));
chk(parts.every((x) => x.durSec > 0 && /^c\d+\.wav$/.test(path.basename(x.file))),
  '切段产物命名与时长都正常（c000.wav/c001.wav…，每段都能算出时长）',
  '切段产物异常：' + JSON.stringify(parts.map((x) => path.basename(x.file))));

/* ---------- ⑤ 质量打分与阈值常量 ---------- */
const cleanTxt = [
  'We can prove that for all x, phi of x holds.',
  'The constant does not occur anywhere else in the sequent.',
  'A model assigns every variable some element of the domain.',
  'Equality is symmetric, reflexive and substitutive.',
  'The existential quantifier commutes with disjunction.',
].join(' ');
const loopTxt = ('I do not know how to read it. '.repeat(20));
const scClean = M.scoreText(cleanTxt, 600), scLoop = M.scoreText(loopTxt, 600);
chk(scLoop.top > 3 && scClean.top <= 1 && scLoop.score < scClean.score,
  'scoreText：整段复读被打成不达标（top ×' + scLoop.top + '），正常讲课文本 top ×' + scClean.top,
  'scoreText 没能区分复读与正常文本：' + JSON.stringify({ loop: scLoop.top, clean: scClean.top }));
chk(M.CHUNK_MIN_SEC > M.CHUNK_SEC_DEFAULT && M.CHUNK_SEC_DEFAULT >= 300 && M.BURST_WINDOW_SEC >= 10
  && M.CHUNK_MAX_ATTEMPTS >= 3 && M.CHUNK_MAX_ATTEMPTS <= 9,
  '阈值自洽：分段阈值（' + M.CHUNK_MIN_SEC + 's）大于段长（' + M.CHUNK_SEC_DEFAULT + 's），去重窗口 ' + M.BURST_WINDOW_SEC
    + 's，单段最多试 ' + M.CHUNK_MAX_ATTEMPTS + ' 档（不把 15 档全磨一遍）',
  '阈值常量不合理：' + [M.CHUNK_MIN_SEC, M.CHUNK_SEC_DEFAULT, M.BURST_WINDOW_SEC, M.CHUNK_MAX_ATTEMPTS].join('/'));

/* ---------- ⑥ 幻觉区间：只丢课间那一小段，不整段丢 ---------- */
const spansA = M.hallucSpans([
  { start: 10, end: 12, text: 'x' }, { start: 14, end: 16, text: 'x' },     /* 第一簇 */
  { start: 500, end: 502, text: 'y' }, { start: 505, end: 507, text: 'y' }, /* 第二簇，离得远 */
], 600, 120);
chk(spansA.length === 2 && spansA[0].from === 9 && spansA[0].to === 17 && spansA[1].from === 499 && spansA[1].to === 508,
  '幻觉区间：相隔很远的两次循环切成两个区间（两端各外扩 1 秒）→ ' + JSON.stringify(spansA),
  '幻觉区间切错：' + JSON.stringify(spansA));
const spansB = M.hallucSpans([{ start: 0.5, end: 2, text: 'z' }, { start: 100, end: 600, text: 'z' }], 600, 120);
chk(spansB.length === 1 && spansB[0].from === 0 && spansB[0].to === 600,
  '幻觉区间：从头坏到尾就合成一个区间、并夹在 [0, 时长] 内（这时才整段丢）',
  '首尾都坏时区间不对：' + JSON.stringify(spansB));
chk(M.hallucSpans([], 600, 120).length === 0,
  '幻觉区间：没有可去重的段 → 不产生区间（不会误删真课堂）',
  '空输入却产生了区间');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }

console.log('');
console.log(fail ? ('结论：' + fail + ' 项未通过（通过 ' + pass + '）') : ('全部 ' + pass + ' 项通过'));
process.exit(fail ? 1 : 0);

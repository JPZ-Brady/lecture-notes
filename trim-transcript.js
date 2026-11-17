/*
 * trim-transcript.js —— 按时间窗口从**已有转写稿**里删掉一段（课间闲聊 / 幻觉残留）
 *
 * 什么时候需要它：分段转写（见 交接文档 §1.22）能清掉"复读机"碎片，但**课间那几分钟**
 * 常有两类残留抓不到 —— ① 学生闲聊（不再重复，去重类规则无效）
 * ② 去重占比没到「整段丢弃」阈值（30%）。这一段对笔记没用，但会留在转写稿里。
 *
 * 用法：
 *   node trim-transcript.js --course "DEMO1006M Knowledge Repres. & Reasoning" --date 2026-10-13 \
 *        --from 54:18 --to 1:02:57              # 只报告（默认 --dry）
 *   …同上，末尾加 --yes                            # 落盘（先备份到 _备份\）
 *   node trim-transcript.js --file "<某份 .srt 的绝对/相对路径>" --from … --to … [--yes]
 *
 * 规则（重要）：
 *   ① **只删 [from,to) 之间"起点"的段**；窗口两端由人来定，工具不猜 —— 起止两句真课堂要留在外面。
 *   ② 默认 dry-run，`--yes` 才写；写前备份 `_备份\<原名>.bak-裁剪前-<时间戳>`。
 *   ③ `.srt` 删段后**重新编号**（时间戳不动：音频没变，[mm:ss] 回听点仍然对得上）。
 *   ④ `.txt` 两种情况都能对付：一行一句的，整行删；**一整行是一大段**（走重试/去重的段会写成一行）
 *      的，按句子**行内逐个抠掉**。抠的时候按时间顺序**顺序查找**（避免删错同名的真句子）；
 *      只要有一句找不到就**中止不写**（fail-closed），并打印是哪一句。
 *   ⑤ 删完打印残留复读检查（复用 make-notes.js 的 dedupeBursts），不假装干净。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./make-notes.js');

const ROOT = __dirname;
const BAK = path.join(ROOT, '_备份');
const argv = process.argv.slice(2);
const valOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && argv[i + 1].slice(0, 2) !== '--' ? argv[i + 1] : ''; };
const WRITE = argv.includes('--yes');

const toSec = (s) => {
  const m = /^(?:(\d+):)?(\d+):(\d+)$/.exec(String(s || '').trim());
  return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) : NaN;
};
const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const die = (msg) => { console.log('[X] ' + msg); process.exit(1); };

/* ---------- 找文件 ---------- */
const FROM = toSec(valOf('--from'));
const TO = toSec(valOf('--to'));
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || TO <= FROM) {
  die('参数不对。用法：node trim-transcript.js --course "<课程文件夹>" --date YYYY-MM-DD --from 54:18 --to 1:02:57 [--yes]');
}
let srtPath = valOf('--file') ? path.resolve(ROOT, valOf('--file')) : '';
if (!srtPath) {
  const course = valOf('--course'), date = valOf('--date');
  if (!course || !date) die('要么给 --file，要么给 --course + --date');
  const dir = path.join(ROOT, '录音稿', course, date);
  if (!fs.existsSync(dir)) die('没有这个目录：' + dir);
  const srts = fs.readdirSync(dir).filter((f) => /\.srt$/i.test(f));
  if (srts.length !== 1) die('该目录下 .srt 不是恰好一份（' + srts.length + ' 份）→ 请用 --file 指定');
  srtPath = path.join(dir, srts[0]);
}
if (!fs.existsSync(srtPath)) die('找不到文件：' + srtPath);
const txtPath = srtPath.replace(/\.srt$/i, '.txt');

/* ---------- 解析 srt（时间格式 hh:mm:ss,mmm）---------- */
const srtRaw = fs.readFileSync(srtPath, 'utf8');
const nl = srtRaw.includes('\r\n') ? '\r\n' : '\n';
const secOf = (x) => {
  const m = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(String(x || '').trim());
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : NaN;
};
const parsed = srtRaw.split(/\r?\n\r?\n/).filter((b) => b.trim() !== '').map((b) => {
  const lines = b.split(/\r?\n/);
  const m = /^(.+?) --> (.+)$/.exec(lines[1] || '');
  return {
    lines: lines,
    times: lines[1],
    start: m ? secOf(m[1]) : NaN,
    end: m ? secOf(m[2]) : NaN,
    text: lines.slice(2).join(' '),
  };
});
const bad = parsed.filter((p) => !Number.isFinite(p.start));
if (bad.length) die('有 ' + bad.length + ' 段时间戳解析失败，先查文件');

const dropped = parsed.filter((p) => p.start >= FROM && p.start < TO);
const kept = parsed.filter((p) => !(p.start >= FROM && p.start < TO));
if (!dropped.length) die('[' + mmss(FROM) + ',' + mmss(TO) + ') 之间没有段 —— 检查时间参数');

/* ---------- .srt 输出（重新编号）---------- */
const srtOut = kept.map((p, i) => String(i + 1) + nl + p.times + nl + p.lines.slice(2).join(nl)).join(nl + nl) + nl;

/* ---------- .txt 输出（顺序抠句）---------- */
let txtOut = null, txtMiss = [];
if (fs.existsSync(txtPath)) {
  const txtRaw = fs.readFileSync(txtPath, 'utf8');
  const tnl = txtRaw.includes('\r\n') ? '\r\n' : '\n';
  let body = txtRaw;
  let cursor = 0;
  for (const p of dropped) {
    const t = p.text.trim();
    if (!t) continue;
    const idx = body.indexOf(t, cursor);
    if (idx < 0) { txtMiss.push(mmss(p.start) + ' ' + t.slice(0, 50)); continue; }
    let a = idx, b = idx + t.length;
    while (a > 0 && body[a - 1] === ' ') a--;                       /* 顺手吃掉左右空格 */
    while (b < body.length && body[b] === ' ') b++;
    body = body.slice(0, a) + body.slice(b);
    cursor = a;
  }
  /* 抠空的整行删掉（保留原有换行风格） */
  const lines = body.split(/\r?\n/);
  const keepLines = lines.filter((l, i, arr) => !(l.trim() === '' && i !== arr.length - 1));
  txtOut = keepLines.join(tnl) + tnl;
}

/* ---------- 报告 ---------- */
console.log('文件：' + path.relative(ROOT, srtPath) + (txtOut !== null ? '  +  ' + path.relative(ROOT, txtPath) : '（没有同名 .txt）'));
console.log('窗口：[' + mmss(FROM) + ', ' + mmss(TO) + ')  →  删 ' + dropped.length + ' 段（' +
  mmss(dropped[0].start) + '–' + mmss(dropped[dropped.length - 1].end) + '）');
console.log('srt ：' + parsed.length + ' 段 → ' + kept.length + ' 段');
if (txtOut !== null) console.log('txt ：' + (txtMiss.length ? '有 ' + txtMiss.length + ' 句在 txt 里找不到（见下）' : '已按句子顺序抠掉'));
if (txtMiss.length) txtMiss.slice(0, 5).forEach((x) => console.log('    ✗ ' + x));
console.log('首尾各 2 段（确认两端真句子还在）：');
kept.filter((p) => p.end <= dropped[0].start).slice(-2).forEach((p) => console.log('    ' + mmss(p.start) + '  ' + p.text.slice(0, 70)));
kept.filter((p) => p.start >= dropped[dropped.length - 1].end).slice(0, 2).forEach((p) => console.log('    ' + mmss(p.start) + '  ' + p.text.slice(0, 70)));
const segs = kept.map((p) => ({ start: p.start, end: p.end, text: p.text }));
const dd = M.dedupeBursts(segs, M.BURST_WINDOW_SEC);
console.log('残留复读检查（' + M.BURST_WINDOW_SEC + 's 窗口）：命中 ' + dd.dropped.length + ' 处' +
  (dd.dropped.length ? '，例：' + dd.dropped.slice(0, 3).map((x) => mmss(x.start) + ' ' + x.text.slice(0, 36)).join(' ｜ ') : ''));

if (txtMiss.length) die('txt 里有句子没找到 → 一律不写盘（避免只改一半）');
if (!WRITE) { console.log('\n（默认 dry-run：没有写盘。确认无误后加 --yes）'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const written = [];
for (const [src, out] of [[srtPath, srtOut], [txtPath, txtOut]]) {
  if (out === null || !fs.existsSync(src)) continue;
  const bak = path.join(BAK, path.basename(src) + '.bak-裁剪前-' + stamp);
  fs.writeFileSync(bak, fs.readFileSync(src));
  fs.writeFileSync(src, out, 'utf8');
  written.push(path.basename(src) + '（' + fs.statSync(src).size + ' B，备份 ' + path.basename(bak) + '）');
}
console.log('\n[√] 已写：' + written.join('；'));
console.log('     接着跑 node make-notes.js 用新转写稿重建笔记（或双击 生成笔记.cmd）。');

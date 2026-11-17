/*
 * _verify-transcript.js —— 转写稿质检（时间轴口径，抓「静音处编话」这类幻觉）
 *
 * 为什么需要它：make-notes.js 内置的质量闸门只统计「同一片段重复次数」，
 * 对**花样翻新**的幻觉无效。实测（2026-09-26，38.3 分钟讲座）该稿被判「✓ 质量达标」，
 * 可实际 0:00–1:40 整段是编造的（英文稿里还出现中文「完成」）。
 *
 * 用法：
 *   node _verify-transcript.js                     # 体检 录音稿\ 下全部 .srt
 *   node _verify-transcript.js "录音稿\某课程\某文件.srt"
 *
 * 四个信号：① ≤4 词的空洞短段 ② 同一句重复 ≥3 次 ③ >8 秒空白（幻觉温床）④ 英文稿混入中文
 * 判定：high = 建议核对笔记 / mid = 有可疑区段但可用 / ok = 干净
 * 退出码：0 = 没有 high；1 = 至少一份 high；10 = 参数或路径错误
 *
 * 注意这是**启发式**，不是判官：小组讨论里 "Yeah." "Windows." 这类真实短句也会被算作短段，
 * 所以别只看「短段比例」，要看 ②③④ 三个硬信号，并和另一份稿子对照着看。
 * 逻辑与 make-notes.js 共用同一份实现（不复制粘贴），保证「体检口径 = 管线口径」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./make-notes.js');

const R = __dirname;
const DIR = path.join(R, '录音稿');

function collect() {
  if (process.argv[2]) return [path.resolve(R, process.argv[2])];
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) walk(q);
      else if (it.name.toLowerCase().endsWith('.srt')) out.push(q);
    });
  };
  walk(DIR);
  return out.sort();
}

const files = collect();
if (!files.length) {
  console.log('[!] 没找到 .srt（转写稿）。先跑一次 一键出笔记.cmd，或指定路径。');
  process.exit(10);
}

let high = 0, mid = 0, ok = 0, bad = 0, err = 0;
files.forEach((f) => {
  const rel = f.replace(R + path.sep, '');
  if (!fs.existsSync(f)) { console.log('[X] 不存在：' + rel); bad++; return; }
  if (!f.toLowerCase().endsWith('.srt')) {
    console.log('[X] 时间轴质检需要 .srt（.txt 没有时间信息）：' + rel);
    bad++;
    return;
  }
  const segs = M.parseSrt(fs.readFileSync(f, 'utf8'));
  if (segs.length < 3) { console.log('[X] 段落太少（' + segs.length + ' 段），无法体检：' + rel); bad++; return; }

  const qa = M.qaSegments(segs);
  const lv = M.qaVerdict(qa);
  const flt = M.dropHallucinated(segs, 'en');
  const mark = lv === 'ok' ? '[√]' : (lv === 'mid' ? '[~]' : '[!]');
  if (lv === 'high') high++; else if (lv === 'mid') mid++; else ok++;

  console.log(mark + ' ' + rel);
  console.log('    全长 ' + (qa.dur / 60).toFixed(1) + ' 分钟 / ' + qa.total + ' 段'
    + '　短段 ' + qa.short + ' 段（' + (qa.short / qa.total * 100).toFixed(0) + '%，讨论型录音天然偏高）'
    + '　判定：' + (lv === 'ok' ? '干净' : (lv === 'mid' ? '有可疑区段（可用）' : '疑似幻觉较多（建议核对笔记）')));
  if (qa.loops.length) console.log('    ② 同一句重复 ≥3 次 ' + qa.loops.length + ' 种：' + qa.loops.slice(0, 4).map((k) => '「' + k.slice(0, 26) + '」').join(' '));
  if (qa.gaps.length) console.log('    ③ >8 秒空白 ' + qa.gaps.length + ' 处，合计 ' + Math.round(qa.gaps.reduce((a, x) => a + x.dur, 0)) + ' 秒');
  if (qa.cjkCount) console.log('    ④ 英文稿混入中文 ' + qa.cjkCount + ' 段，首处 ' + M.buildTimestamped([qa.cjkFirst]).slice(0, 40));
  if (flt.dropped.length) {
    const at = flt.dropped.slice(0, 3).map((g) => (g.start / 60).toFixed(1) + 'min').join(' / ');
    console.log('    → 生成笔记时会自动剔除 ' + flt.dropped.length + '/' + segs.length + ' 段铁证幻觉（约 ' + at + ' …）');
  } else {
    console.log('    → 无需剔除');
  }
  /* ⑤ 勘误表：转写稿里不该再有「已知听错词」（有＝那次生成时勘误表还没生效 → 跑 node fix-errata.js 补上） */
  const errLeft = [];
  M.loadErrata().rules.forEach((r) => {
    const re = new RegExp(String(r.from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), r.ci ? 'gi' : 'g');
    const c = (segs.filter((g) => re.test(g.text))).length;
    if (c) errLeft.push(r.from + ' ×' + c);
  });
  if (errLeft.length) {
    console.log('    ⑤ 勘误表：仍含已知听错词 ' + errLeft.join('，') + ' → 跑一次 node fix-errata.js（零 API）');
    err++;
  }
  console.log('');
});

console.log('== 汇总：干净 ' + ok + ' 份｜可疑 ' + mid + ' 份｜疑似幻觉较多 ' + high + ' 份'
  + (err ? '｜含已知听错词 ' + err + ' 份' : '') + (bad ? '｜无法体检 ' + bad + ' 份' : '') + ' ==');
console.log('提示：high 不等于笔记一定错——实测模型会自动跳过首尾垃圾；但值得拿笔记里的断言回 grep 转写稿原文核对（见 交接文档 §8）。');
process.exit(high > 0 || bad > 0 || err > 0 ? 1 : 0);

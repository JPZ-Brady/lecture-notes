'use strict';
/*
 * fix-embedded-json.js —— 把笔记 HTML 里内嵌的数据副本按同名 .json 文件重建。零 API、幂等、fail-closed。
 *
 * 为什么需要它：
 *   每份笔记其实有两份数据 —— `<课程>\<日期>\….json`，以及 HTML 里内嵌的**同一个对象**
 *   （make-notes.js 用 JSON.stringify(d).replace(/</g,'\\u003c').replace(/>/g,'\\u003e') 写进
 *   <script type="application/json" id="raw">）。HTML 的问答、术语、思维导图、课件核对全靠这份副本渲染，
 *   所以两者必须完全一致。
 *   2026-10-09 发现：`fix-errata.js` 的**纯文本替换**会伸进这份副本，把「课件核对」的记录字段改掉
 *   （rows[*].fromAudio = 录音当时怎么说的、patches[*].replace = 当时改成了什么），而 .json 那侧是豁免的
 *   —— 两份数据从此不一致，记录也不再是当时的真相。实测受害两份：KRR 2026-09-29（AR-10s→KRR 那条把
 *   fromAudio 改成了 KRR）、DEMO1001M 2026-10-07（1986-01-27→01-28 那条把 patches[0].replace 改了）。
 *   根因已在 fix-errata.js 修掉（数据副本跟「课件核对区块」一起遮蔽）；本工具把**已经不一致的**重建回来，
 *   `_verify-output.js` 的「内嵌 JSON ↔ .json 文件」那一项会一直盯着这条不变量。
 *
 * 用法：
 *   node fix-embedded-json.js --dry    只报告哪几份不一致、差在哪个字段
 *   node fix-embedded-json.js          真重建（先备份到 `<课程>\_备份\内嵌JSON重建-<时间戳>\`）
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DRY = process.argv.includes('--dry');
const STAMP = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); })();

/* 键序无关的规范化：递归按键名排序后再序列化（.json 是缩进过的，内嵌副本是压缩过的，只能比语义） */
function canon(o) {
  return JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.keys(v).sort().reduce((a, k2) => { a[k2] = v[k2]; return a; }, {}) : v);
}

/* 找出前几处差异（带字段路径）——报告用，也让「差在哪」一眼可见 */
function diffs(a, b, p, out) {
  out = out || [];
  if (out.length >= 5) return out;
  const ta = a === null ? 'null' : typeof a, tb = b === null ? 'null' : typeof b;
  if (ta !== tb) { out.push(p + '：类型不同（内嵌 ' + ta + ' / 文件 ' + tb + '）'); return out; }
  if (ta === 'object') {
    const keys = Array.from(new Set(Object.keys(a || {}).concat(Object.keys(b || {}))));
    for (const k of keys) {
      const key = Array.isArray(a) ? p + '[' + k + ']' : (p ? p + '.' + k : k);
      if (!(k in (a || {}))) { out.push(key + '：只存在于 .json（' + JSON.stringify(b[k]).slice(0, 80) + '）'); continue; }
      if (!(k in (b || {}))) { out.push(key + '：只存在于内嵌副本（' + JSON.stringify(a[k]).slice(0, 80) + '）'); continue; }
      diffs(a[k], b[k], key, out);
      if (out.length >= 5) return out;
    }
    return out;
  }
  if (a !== b) out.push(p + '：内嵌 = ' + JSON.stringify(a).slice(0, 90) + '　文件 = ' + JSON.stringify(b).slice(0, 90));
  return out;
}

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === '_备份') continue; walk(f, out); }
    else if (/\.html$/i.test(e.name)) out.push(f);
  }
  return out;
}

const RE_BLOCK = /(<script[^>]*type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/;
const bad = [], fixed = [], skipped = [];

for (const html of walk(path.join(ROOT, '笔记'))) {
  const rel = path.relative(ROOT, html).replace(/\\/g, '/');
  const jp = html.replace(/\.html$/i, '.json');
  const mm = fs.readFileSync(html, 'utf8').match(RE_BLOCK);
  if (!mm) { skipped.push([rel, 'HTML 里没有内嵌 JSON 数据块']); continue; }
  if (!fs.existsSync(jp)) { skipped.push([rel, '没有同名 .json 文件']); continue; }
  let emb, jf;
  try { emb = JSON.parse(mm[2]); } catch (e) { skipped.push([rel, '内嵌 JSON 解析失败：' + e.message]); continue; }
  try { jf = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch (e) { skipped.push([rel, '.json 解析失败：' + e.message]); continue; }
  if (canon(emb) === canon(jf)) continue;

  const why = diffs(emb, jf, '', []);
  bad.push([rel, why]);
  if (DRY) continue;

  /* 按 make-notes.js:2493 的写法重建（同样的压缩 + 同样的 < > 转义），保证与生成器逐字节一致 */
  const rawJson = JSON.stringify(jf).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const src = fs.readFileSync(html, 'utf8');
  const m2 = src.match(RE_BLOCK);
  if (!m2) { skipped.push([rel, '⚠ 二次定位数据块失败 → 未改（fail-closed）']); continue; }
  const out = src.slice(0, m2.index) + m2[1] + rawJson + m2[3] + src.slice(m2.index + m2[0].length);

  /* 备份进课程目录的 _备份\（项目纪律：备份不散落在根目录） */
  const courseDir = path.dirname(path.dirname(html));
  const bakDir = path.join(courseDir, '_备份', '内嵌JSON重建-' + STAMP);
  fs.mkdirSync(bakDir, { recursive: true });
  fs.copyFileSync(html, path.join(bakDir, path.basename(html)));
  fs.writeFileSync(html, out, 'utf8');
  fixed.push(rel);
}

console.log('=== 笔记 HTML 内嵌数据副本 ↔ 同名 .json 文件 ===' + (DRY ? '（--dry：只看不改）' : ''));
for (const [rel, why] of bad) {
  console.log('  ' + (DRY ? '✗' : '✔ 已重建') + ' ' + rel);
  why.forEach((w) => console.log('      ' + w));
}
for (const [rel, why] of skipped) console.log('  · ' + rel + '　' + why);
if (!bad.length) console.log('  ✓ 全部一致，不用改');
if (DRY && bad.length) console.log('\n（--dry：实际未动。去掉 --dry 就会按上面的差异重建，每份先备份到 <课程>\\_备份\\内嵌JSON重建-' + STAMP + '\\）');
if (!DRY && fixed.length) console.log('\n共重建 ' + fixed.length + ' 份；原文件已备份到各自的 <课程>\\_备份\\内嵌JSON重建-' + STAMP + '\\');

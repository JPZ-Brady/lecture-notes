'use strict';
/*
 * fix-errata.js —— 把 勘误表.json 里的替换应用到**已有产物**上（零 API、机械、幂等）
 *
 * 用法：
 *   node fix-errata.js --dry          只报告会改什么，不落盘
 *   node fix-errata.js                真正落盘
 *   node fix-errata.js --only 笔记     只处理路径含「笔记」的文件
 *
 * 覆盖范围：录音稿（.txt/.srt/.讲者.txt）、笔记（.json/.md/.html）、英语学习台 notes-cards.js
 *
 * 纪律（为什么这么写）：
 *  ① 只做用户自己维护的替换表，零模型参与；
 *  ② skipIfNear 命中的句子跳过 —— 那是在「解释这个错词」（如「转写听错：…不是"AR-10s"」）；
 *  ③ 笔记的「课件核对」视图是**抓错记录**，整块不动（否则记录会自相矛盾）；
 *  ④ .json 与 HTML 内嵌 JSON 走「解析 → 改 → 再序列化」，并逐字段核对只有预期的字段变了；
 *  ⑤ 任何一步不确定就**不写**（fail-closed），并打印原因。
 */
const fs = require('fs');
const path = require('path');
const M = require('./make-notes.js');

const ROOT = __dirname;
const DRY = process.argv.includes('--dry');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
const ERR = M.loadErrata();

/* handout.* ＝「课件核对」那条抓错记录（deck/range/rows/applied/skipped/leftovers 全都是记录）→ 整棵子树不动。
   ⚠ 2026-10-09 修：原来只豁免 rows[*].fromAudio|note，于是 rows[*].fromSlides（课件原话）、
   rows[*].patches[*].find/replace（当时改了什么）、rows[*].patched、applied[*].* 会被勘误表改写 ——
   记录会变成「课件说 X、系统当时改成了 Y」，而 Y 其实是**后来**人工勘误的产物，与当时真发生的事不符。
   规则 ③ 说的「整块不动」原先只在文本视图（md 的 ## 课件核对 / html 的 <section id="handout">）那一半做到了。 */
const EXEMPT = /^handout\./;

function walk(dir, re, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, re, out);
    else if (re.test(e.name)) out.push(f);
  }
  return out;
}

/* 把 [start,end) 换成等长 \u0000 占位：替换时匹配不到这些区块（也不会有跨区块的匹配），
   替换完按「占位游程」把原文放回 —— 期间别的替换会改变长度，所以不能按绝对偏移还原。 */
function maskRanges(text, spans) {
  if (!spans.length) return { masked: text, restore: (t) => t };
  const parts = [];
  let masked = '', pos = 0;
  for (const [a, b] of spans) {
    parts.push(text.slice(a, b));
    masked += text.slice(pos, a) + '\u0000'.repeat(b - a);
    pos = b;
  }
  masked += text.slice(pos);
  return {
    masked: masked,
    restore: (t) => {
      let i = 0;
      const out = t.replace(/\u0000+/g, (run) => {
        const orig = parts[i++];
        if (!orig || orig.length !== run.length) throw new Error('遮蔽恢复失败：占位与原文长度不符');
        return orig;
      });
      if (i !== parts.length) throw new Error('遮蔽恢复失败：占位数量不符（' + i + '/' + parts.length + '）');
      return out;
    },
  };
}

/* 把若干 [start,end) 区间并成互不重叠的一份（maskRanges 要求升序且不重叠）：
   「数据副本」完全可能落在「课件核对区块」里面或与它重叠，先并起来再遮蔽。 */
function mergeSpans(spans) {
  const s = spans.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/* 课件核对区块＝抓错记录：md 的「## 课件核对」到下一个二级标题；html 的 <section …id="handout"…>…</section> */
function handoutSpans(text, kind) {
  const spans = [];
  if (kind === 'md') {
    const h = text.indexOf('## 课件核对');
    if (h < 0) return { spans: spans, ok: true };
    const next = text.indexOf('\n## ', h + 1);
    spans.push([h, next < 0 ? text.length : next + 1]);
  } else if (kind === 'html') {
    let i = text.indexOf('id="handout"');
    while (i >= 0) {
      const s = text.lastIndexOf('<section', i);
      const e = text.indexOf('</section>', i);
      if (s < 0 || e < 0) return { spans: spans, ok: false };
      if (text.indexOf('<section', i + 1) >= 0 && text.indexOf('<section', i + 1) < e) return { spans: spans, ok: false }; // 有嵌套 → 不敢动
      spans.push([s, e + '</section>'.length]);
      i = text.indexOf('id="handout"', e);
    }
  }
  return { spans: spans, ok: true };
}

function setByPath(root, p, val) {
  const keys = p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = val;
}

/* JSON 文本：解析 → 递归替换（整个 handout.* 子树是抓错记录，一律不动）→ 再序列化
   ⚠ html 参数：HTML 里内嵌的 JSON 按模板约定要把 < > 转义成 \u003c \u003e
   （make-notes.js:2051 就是这么写的）。不照做的话，重新序列化会把 $4 \u003e 3$ 变成 $4 > 3$；
   更糟的是万一原来是 \u003c/script，就会把整个文档的 <script> 提前闭合。 */
function repairJson(jsonText, indent, html) {
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { ok: false, why: 'JSON 解析失败：' + e.message }; }
  const changed = [];
  (function rec(node, p) {
    if (Array.isArray(node)) { node.forEach((v, i) => rec(v, p + '[' + i + ']')); return; }
    if (node && typeof node === 'object') { Object.keys(node).forEach((k) => rec(node[k], p ? p + '.' + k : k)); return; }
    if (typeof node !== 'string' || EXEMPT.test(p)) return;
    const r = M.applyErrata(node, ERR);
    if (!r.hits.length) return;
    changed.push({ p: p, n: r.hits.length, what: M.summarizeErrata(r.hits) });
    setByPath(obj, p, r.text);
  })(obj, '');
  if (!changed.length) return { ok: true, text: jsonText, changed: changed };
  let out = JSON.stringify(obj, null, indent);
  if (html) out = out.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return { ok: true, text: out, changed: changed };
}

const results = [];
function handle(file, kind) {
  if (ONLY && file.indexOf(ONLY) < 0) return;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { results.push({ rel: rel, n: 0, note: '⚠ 读不了：' + e.message }); return; }

  if (kind === 'jsonfile') {
    let std = null;
    try { std = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { std = null; }
    if (std !== raw) { results.push({ rel: rel, n: 0, note: '⚠ 不是标准 JSON.stringify(…,2) 格式（可能手改过）→ 拒绝整篇重写' }); return; }
    const r = repairJson(raw, 2);
    if (!r.ok) { results.push({ rel: rel, n: 0, note: '⚠ ' + r.why + ' → 未动' }); return; }
    const n = r.changed.reduce((a, b) => a + b.n, 0);
    results.push({ rel: rel, n: n, what: r.changed.map((c) => c.p + '×' + c.n).join('，') });
    if (n && !DRY) fs.writeFileSync(file, r.text, 'utf8');
    return;
  }

  let body = raw;
  let jsonPaths = [];
  let dataSpans = [];          // HTML 里「数据副本」的位置（.json 的那份内嵌拷贝）
  if (kind === 'html') {
    /* 先改内嵌 JSON（它会改变文本长度），再定位「课件核对」区块 —— 顺序反了偏移就错了 */
    body = body.replace(/(<script[^>]*type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/g, (all, a, json, c) => {
      const r = repairJson(json, 0, true);
      if (!r.ok || !r.changed.length) return all;
      r.changed.forEach((x) => jsonPaths.push('内嵌JSON:' + x.p + '×' + x.n));
      return a + r.text + c;
    });
    /* ⚠ 2026-10-09 修：数据副本必须跟「课件核对区块」一样遮蔽掉 —— 否则下面那趟**纯文本替换**
       会伸进副本里，把记录字段（rows[*].fromAudio = 录音当时怎么说的、patches[*].replace = 当时改成了什么、
       rows[*].fromSlides = 课件当时怎么写的）一并改掉，而上面那步 JSON 处理是刻意豁免 handout.* 的。
       实测踩过两次：AR-10s→KRR 那条把 KRR 笔记记录里的 fromAudio 改成了 KRR（那是「录音原话」列）；
       1986-01-27→01-28 这条把今天那份内嵌副本的 patches[0].replace 改了。副本按 JSON 规则改，正文按文本规则改。 */
    const reData = /<script[^>]*type="application\/json"[^>]*>[\s\S]*?<\/script>/g;
    let dm;
    while ((dm = reData.exec(body))) dataSpans.push([dm.index, dm.index + dm[0].length]);
  }
  const jsonN = jsonPaths.length
    ? jsonPaths.reduce((a, s) => a + Number(String(s).split('×').pop()), 0) : 0;
  const hs = handoutSpans(body, kind === 'md' ? 'md' : kind === 'html' ? 'html' : 'none');
  if (!hs.ok) { results.push({ rel: rel, n: 0, note: '⚠ 定位不到「课件核对」区块边界 → 拒绝改写（fail-closed）' }); return; }
  const mk = maskRanges(body, mergeSpans(hs.spans.concat(dataSpans)));
  const r = M.applyErrata(mk.masked, ERR);
  const out = mk.restore(r.text);
  const n = r.hits.length + jsonN;
  results.push({
    rel: rel, n: n,
    what: [r.hits.length ? M.summarizeErrata(r.hits) : '', jsonPaths.join('，')].filter(Boolean).join('；'),
    note: hs.spans.length ? '（课件核对区块已跳过）' : '',
  });
  if (n && !DRY) fs.writeFileSync(file, out, 'utf8');
}

function main() {
  if (!ERR.rules.length) { console.log('勘误表里没有启用的规则，什么都不用做。'); return; }
  console.log('勘误表规则：' + ERR.rules.map((r) => r.from + ' → ' + r.to).join('，') + (DRY ? '　（--dry：只看不改）' : ''));

  for (const f of walk(path.join(ROOT, '录音稿'), /\.(txt|srt)$/i)) handle(f, 'text');
  for (const f of walk(path.join(ROOT, '笔记'), /\.json$/i)) handle(f, 'jsonfile');
  for (const f of walk(path.join(ROOT, '笔记'), /\.md$/i)) handle(f, 'md');
  for (const f of walk(path.join(ROOT, '笔记'), /\.html$/i)) handle(f, 'html');
  for (const f of walk(path.join(ROOT, '..', 'English Learning'), /^notes-cards\.js$/)) handle(f, 'text');

  const hit = results.filter((x) => x.n > 0);
  console.log('\n=== ' + (DRY ? '将要修改' : '已处理') + ' ===');
  for (const x of results) {
    if (!x.n && !x.note) continue;
    console.log('  ' + String(x.n).padStart(3) + ' 处  ' + x.rel + (x.what ? '   [' + x.what + ']' : '') + (x.note ? '  ' + x.note : ''));
  }
  console.log('\n合计：' + hit.length + ' 个文件，共 ' + hit.reduce((a, b) => a + b.n, 0) + ' 处' + (DRY ? '（--dry，实际未动）' : ''));
}

/* 被 require 时保持静默（_verify-output.js 会 require 它来检查「抓错记录不被改写」这条不变量），
   只有直接 `node fix-errata.js` 才跑主流程 */
if (require.main === module) main();
module.exports = { EXEMPT: EXEMPT, repairJson: repairJson, handoutSpans: handoutSpans, maskRanges: maskRanges, DRY: DRY };

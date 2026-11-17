/*
 * pick-cards.js —— 选卡页：逐张决定哪些课堂卡进英语学习台
 *
 * 为什么需要一个本地服务：file:// 页面**不能写磁盘**。所以这里起一个只绑 127.0.0.1 的一次性
 * HTTP 服务，页面点「确认」时 POST 回来，服务端写清单 + 立即重跑一次同步，然后自己退出。
 *
 * 用法：
 *   node pick-cards.js                  # 选卡页（默认只勾「最近生成的那份笔记」带来的卡）
 *   node pick-cards.js --latest         # 同上（一键出笔记.cmd 用的是这个）
 *   node pick-cards.js --all            # 默认范围改成全部课程
 *   node pick-cards.js --no-open        # 不自动开浏览器（自测用）
 *   node pick-cards.js --port 8799      # 指定端口（自测用）
 *
 * 关键设计：排除清单落成 课堂笔记\不加入学习台.json，sync-fsrs.js 会读它。
 * 因为 sync-fsrs 是**全量重建**，只靠 --no-sync 跳过一次的话下次同步会把卡又加回来。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const sync = require('./sync-fsrs.js');

const argv = process.argv.slice(2);
const has = (k) => argv.indexOf(k) >= 0;
const valOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const ALL = sync.build();                       // 权威卡片列表（已按规则去重/过滤，带 k/src）
const notes = Array.from(new Set(ALL.terms.concat(ALL.qas).map((c) => c.src)))
  .sort((a, b) => fs.statSync(path.join(__dirname, '笔记', b)).mtimeMs - fs.statSync(path.join(__dirname, '笔记', a)).mtimeMs);
const latest = notes[0] || '';

/* 课程名 / 日期：从 笔记\<课程>\<文件名>.json 里取，给页面做标签 */
function label(src) {
  const parts = String(src || '').split('/');
  const course = parts.length > 1 ? parts[0] : '(未分类)';
  const m = String(src || '').match(/(\d{4}-\d{2}-\d{2})/);
  return { course: course, date: m ? m[1] : '' };
}

const cards = ALL.terms.concat(ALL.qas).map((c) => {
  const L = label(c.src);
  return {
    k: c.k, kind: c.t === 'qa' ? 'qa' : 'term', src: c.src, course: L.course, date: L.date,
    en: c.en, zh: c.zh, q: c.q || '', a: c.a || '', ex: c.ex || [],
  };
});
const excl = sync.loadExclude();
const excludedKeys = Array.from(excl.terms).concat(Array.from(excl.qa));

/* ---------- 「排除清单失效」面板的数据（2026-10-01 加）----------
   为什么必须在选卡页里修：key 里**嵌着原文**，笔记一重跑、措辞变了，老 key 就匹配不上，
   那些卡会**悄悄回到词库**（sync 只报条数，改不了）。以前只能跑命令行 rematch-excluded.js；
   现在页面里直接能看到「哪几条失效了 / 最像哪张卡 / 接回还是删掉」。
   算法与候选排序**完全复用** rematch-excluded.js 的 analyze()，不另写一套。 */
const RM = require('./rematch-excluded.js');
let EX = null;
try { EX = RM.analyze(); } catch (e) { console.log('[!] 排除清单分析失败（不影响选卡）：' + e.message); }
const exPayload = EX ? {
  scanned: EX.scanned, nTerms: EX.nTerms, nQas: EX.nQas,
  staleTerm: EX.termRows.map((x) => ({ key: x.key, old: x.key, cands: x.top.map((t) => ({ k: t.c.k, text: t.c.en, zh: t.c.zh || '', s: +t.s.toFixed(3) })) })),
  staleQa: EX.qaRows.map((x) => ({ key: x.key, old: x.oldQ, course: x.course, cands: x.top.map((t) => ({ k: t.c.k, text: t.c.q, zh: '', s: +t.s.toFixed(3) })) })),
  liveTerm: EX.live.terms.map((x) => ({ key: x.key, text: x.card ? x.card.en : x.key, zh: x.card ? (x.card.zh || '') : '' })),
  liveQa: EX.live.qas.map((x) => ({ key: x.key, text: x.card ? x.card.q : x.key, zh: '' })),
  HIGH: RM.HIGH, MID: RM.MID,
} : { scanned: 0, nTerms: 0, nQas: 0, staleTerm: [], staleQa: [], liveTerm: [], liveQa: [], HIGH: 0.7, MID: 0.55 };

if (!cards.length) {
  console.log('[!] 还没有任何课堂卡（笔记\\ 里没有可用的 terms / qa）。先跑一次 一键出笔记.cmd。');
  process.exit(0);
}

const payload = JSON.stringify({
  cards: cards, excluded: excludedKeys, latest: latest,
  defaultScope: has('--all') ? 'all' : 'latest',
  ex: exPayload,
});

/* ---------------- 页面（单文件、离线自包含） ---------------- */
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>选卡 · 课堂笔记 → 英语学习台</title>
<style>
:root{--sans:system-ui,-apple-system,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
  --bg:#f1f2f4;--surface:#fff;--ink:#191a1c;--ink-soft:#45484d;--ink-mute:#5f6369;
  --line:#e0e3e7;--line-soft:#eceff2;--accent:#a63d2f;--accent-ink:#8a2f23;--wash:#f3e8e4;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121319;--surface:#191b23;--ink:#e9e8ef;--ink-soft:#bcbbc7;
  --ink-mute:#8e8d9b;--line:#2b2e39;--line-soft:#23252f;--accent:#e0a458;--accent-ink:#f0bd7d;--wash:#221f26;--on-accent:#121319}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 var(--sans)}
.wrap{max-width:1000px;margin:0 auto;padding:26px 20px 120px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:var(--ink-mute);font-size:13px;margin:0 0 18px}
h1::after{content:"";display:block;width:34px;height:2px;background:var(--accent);margin-top:8px;border-radius:2px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0 10px;padding:10px 12px;
  background:var(--surface);border:1px solid var(--line);border-radius:12px}
button{font:inherit;font-size:13px;padding:6px 12px;border-radius:9px;border:1px solid var(--line);
  background:var(--bg);color:var(--ink);cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent-ink)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
select,input[type=search]{font:inherit;font-size:13px;padding:6px 10px;border-radius:9px;
  border:1px solid var(--line);background:var(--bg);color:var(--ink)}
input[type=search]{flex:1;min-width:180px}
.count{font-family:var(--mono);font-size:12.5px;color:var(--ink-mute);margin-left:auto}
h2{font-size:14px;letter-spacing:.06em;color:var(--ink-mute);margin:24px 0 8px;font-weight:620}
.row{display:flex;gap:11px;align-items:flex-start;padding:10px 12px;border-bottom:1px solid var(--line-soft);
  background:var(--surface)}
.row:first-of-type{border-top:1px solid var(--line)}
.list{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row input{margin-top:3px;width:16px;height:16px;accent-color:var(--accent);flex:0 0 auto}
.row .txt{min-width:0}
.row .en{font-weight:600;word-break:break-word}
.row .zh{color:var(--ink-soft);font-size:13.5px}
.row .ex{color:var(--ink-mute);font-size:12.5px;margin-top:3px}
.row.off{opacity:.45}
.tag{font-family:var(--mono);font-size:11px;color:var(--accent-ink);background:var(--wash);
  border-radius:6px;padding:1px 7px;margin-right:7px;white-space:nowrap}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--surface);border-top:1px solid var(--line);
  padding:12px 20px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap}
#go{background:var(--accent);color:var(--on-accent);border-color:var(--accent);padding:9px 22px;font-size:14px;font-weight:620}
#go:disabled{opacity:.5;cursor:default}
#msg{font-size:13px;color:var(--ink-soft)}
.empty{padding:26px;text-align:center;color:var(--ink-mute);background:var(--surface)}
/* ---- 排除清单面板（2026-10-01 加） ---- */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.panel .hd{padding:12px 14px;border-bottom:1px solid var(--line-soft);font-size:13.5px;color:var(--ink-soft)}
.panel .hd b{color:var(--accent-ink)}
.prow{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;padding:11px 14px;border-bottom:1px solid var(--line-soft)}
.prow:last-child{border-bottom:0}
.prow .what{flex:1;min-width:200px}
.prow .old{font-weight:600;word-break:break-word}
.prow .meta{font-family:var(--mono);font-size:11.5px;color:var(--ink-mute);margin-top:2px}
.prow .acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cand{font-size:12.5px;padding:5px 10px}
.cand .s{font-family:var(--mono);font-size:11px;opacity:.75;margin-right:5px}
.cand.hi{border-color:var(--accent);color:var(--accent-ink)}
.cand.on{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.cand.on .s{opacity:.9}
.del{font-size:12.5px;padding:5px 10px;color:var(--ink-mute)}
.del.on{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.prow.gone{opacity:.5;text-decoration:line-through}
.prow.gone .acts{text-decoration:none}
.ok-line{padding:12px 14px;color:var(--ink-mute);font-size:13px}
#exgo{background:var(--accent);color:var(--on-accent);border-color:var(--accent);padding:8px 18px;font-size:13.5px;font-weight:620}
#exgo:disabled{opacity:.45;cursor:default}
#exmsg{font-size:12.5px;color:var(--ink-soft);margin-left:8px}
</style></head><body>
<div class="wrap">
  <h1>选卡：这节课的单词要不要进英语学习台</h1>
  <p class="sub">勾选＝加入学习台（默认全勾）。取消勾选会写进「不加入学习台.json」，<b>以后每次全量重建都会尊重它</b>。</p>
  <div class="bar">
    <select id="scope"></select>
    <input type="search" id="q" placeholder="筛选：输入英文或中文…" autocomplete="off">
    <button id="all">全选</button><button id="none">全不选</button>
    <button id="termonly">只看术语</button><button id="qaonly">只看问答</button>
    <span class="count" id="cnt">—</span>
  </div>
  <div id="lists"></div>
  <h2>排除清单体检</h2>
  <div id="exwrap"></div>
</div>
<footer>
  <button id="go">确认并写入学习台</button>
  <span id="msg">点左边按钮才会改动学习台（现在还没写）。</span>
</footer>
<script>
var DATA = __PAYLOAD__;
var state = {};                       // key -> 是否勾选
DATA.cards.forEach(function (c) { state[c.k] = DATA.excluded.indexOf(c.k) < 0; });
var scopeEl = document.getElementById('scope'), qEl = document.getElementById('q');
var kindFilter = 'all';

function scoped() {
  var s = scopeEl.value;
  return DATA.cards.filter(function (c) {
    if (s === 'latest' && c.src !== DATA.latest) return false;
    if (kindFilter !== 'all' && c.kind !== kindFilter) return false;
    var kw = qEl.value.trim().toLowerCase();
    if (kw && (c.en + ' ' + c.zh + ' ' + (c.q || '') + ' ' + (c.a || '')).toLowerCase().indexOf(kw) < 0) return false;
    return true;
  });
}
function render() {
  var list = scoped();
  var terms = list.filter(function (c) { return c.kind === 'term'; });
  var qas = list.filter(function (c) { return c.kind === 'qa'; });
  var html = '';
  function sec(title, arr) {
    if (!arr.length) return '';
    var out = '<h2>' + title + '（' + arr.length + ' 张）</h2><div class="list">';
    arr.forEach(function (c) {
      var on = state[c.k];
      var ex = (c.ex && c.ex.length) ? '<div class="ex">例：' + esc(c.ex[0].e || '') + '</div>' : '';
      var body = c.kind === 'qa'
        ? '<div class="en">' + esc(c.q) + '</div><div class="zh">' + esc(c.a) + '</div>'
        : '<div class="en">' + esc(c.en) + '</div><div class="zh">' + esc(c.zh) + '</div>' + ex;
      out += '<label class="row' + (on ? '' : ' off') + '" data-k="' + esc(c.k) + '">'
        + '<input type="checkbox"' + (on ? ' checked' : '') + '><span class="txt">'
        + '<span class="tag">' + (c.kind === 'qa' ? '问答' : '术语') + '</span>' + body + '</span></label>';
    });
    return out + '</div>';
  }
  html += sec('术语卡', terms) + sec('问答卡', qas);
  document.getElementById('lists').innerHTML = html || '<div class="list"><div class="empty">这个范围 / 筛选下没有卡片</div></div>';
  document.querySelectorAll('.row input').forEach(function (box) {
    box.addEventListener('change', function () {
      var k = box.closest('.row').getAttribute('data-k');
      state[k] = box.checked;
      box.closest('.row').classList.toggle('off', !box.checked);
      count();
    });
  });
  count();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function count() {
  var list = scoped(), n = list.filter(function (c) { return state[c.k]; }).length;
  document.getElementById('cnt').textContent = '已选 ' + n + ' / ' + list.length + ' 张';
}
/* 范围下拉 */
function nice(src) {
  var parts = String(src || '').split('/');
  var course = parts.length > 1 ? parts[0] : (src || '（未分类）');
  var m = String(src || '').match(/(\\d{4}-\\d{2}-\\d{2})/);
  return course + (m ? ' · ' + m[1] : '');
}
var seen = {};
seen['latest'] = 1;
var opts = '<option value="latest">本次：' + esc(nice(DATA.latest)) + '</option>';
DATA.cards.forEach(function (c) {
  if (c.src !== DATA.latest && !seen[c.src]) {
    seen[c.src] = 1;
    opts += '<option value="src:' + esc(c.src) + '">' + esc(nice(c.src)) + '</option>';
  }
});
opts += '<option value="all">全部课程</option>';
scopeEl.innerHTML = opts;
scopeEl.value = DATA.defaultScope === 'all' ? 'all' : 'latest';
scopeEl.addEventListener('change', render);
qEl.addEventListener('input', render);
document.getElementById('all').onclick = function () { scoped().forEach(function (c) { state[c.k] = true; }); render(); };
document.getElementById('none').onclick = function () { scoped().forEach(function (c) { state[c.k] = false; }); render(); };
document.getElementById('termonly').onclick = function () { kindFilter = 'term'; render(); };
document.getElementById('qaonly').onclick = function () { kindFilter = 'qa'; render(); };

/* scope 下拉里那些 src: 开头的选项，按单份笔记筛选 */
var _scoped = scoped;
scoped = function () {
  var s = scopeEl.value;
  if (s.indexOf('src:') === 0) {
    var target = s.slice(4);
    return DATA.cards.filter(function (c) {
      if (c.src !== target) return false;
      if (kindFilter !== 'all' && c.kind !== kindFilter) return false;
      var kw = qEl.value.trim().toLowerCase();
      if (kw && (c.en + ' ' + c.zh + ' ' + (c.q || '') + ' ' + (c.a || '')).toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
  }
  return _scoped();
};

document.getElementById('go').onclick = function () {
  var btn = this, msg = document.getElementById('msg');
  var list = scoped();
  var scopeKeys = list.map(function (c) { return c.k; });
  var unchecked = list.filter(function (c) { return !state[c.k]; }).map(function (c) { return c.k; });
  btn.disabled = true; msg.textContent = '正在写入…';
  fetch('/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: scopeKeys, unchecked: unchecked })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) throw new Error(j.error || '写入失败');
    msg.innerHTML = '✅ 已写入学习台：术语卡 ' + j.terms + ' 张、问答卡 ' + j.qas + ' 张'
      + (j.skippedTerm + j.skippedQa ? '（按你的选择排除 ' + j.skippedTerm + '+' + j.skippedQa + ' 张）' : '')
      + '　—　可以关闭本页了';
  }).catch(function (e) {
    btn.disabled = false; msg.textContent = '写入失败：' + e.message + '（服务可能已退出，重跑一次 选卡.cmd）';
  });
};

/* ---------- 排除清单面板 ----------
   背景：不加入学习台.json 的 key 里**嵌着原文**（术语＝英文原词、问答＝课程+问题），
   所以笔记一重新生成、措辞变了，老 key 就匹配不上 → 那些卡**悄悄回到词库**。
   这一块就是让人**看得见、点得动**：看到失效了哪几条、最像哪张卡、是接回还是彻底删掉。
   所有改动先在浏览器里攒着（fix.attach / fix.drop），点「应用」才 POST 回服务端写盘。 */
var EX = DATA.ex || { staleTerm: [], staleQa: [], liveTerm: [], liveQa: [], HIGH: 0.7, MID: 0.55 };
var fix = { attach: {}, drop: {} };

function exDirty() { return Object.keys(fix.attach).length + Object.keys(fix.drop).length; }

function exRender() {
  var wrap = document.getElementById('exwrap');
  var stale = EX.staleTerm.concat(EX.staleQa.map(function (x) {
    x.kindLabel = '问答'; return x;
  }));
  EX.staleTerm.forEach(function (x) { x.kindLabel = '术语'; });
  EX.staleTerm.forEach(function (x) { x.kind = 'term'; });
  EX.staleQa.forEach(function (x) { x.kind = 'qa'; });
  var liveN = EX.liveTerm.length + EX.liveQa.length;
  var html = '';

  if (!stale.length && !liveN) {
    wrap.innerHTML = '<div class="panel"><div class="ok-line">清单是空的 —— 你还没有排除过任何卡片。</div></div>';
    return;
  }

  html += '<div class="panel">';
  if (stale.length) {
    html += '<div class="hd">⚠ <b>' + stale.length + ' 条已失效</b>：清单里有这些 key、但当前卡片里一张都对不上 ——'
      + ' 它们<b>已经回到词库</b>了。挑一张接回去，或者直接删掉这条；不选就保持现状。</div>';
    stale.forEach(function (x) {
      var gone = fix.drop[x.key];
      var cands = x.cands.length
        ? x.cands.map(function (c, i) {
            var on = fix.attach[x.key] === c.k;
            var cls = 'cand' + (on ? ' on' : (c.s >= EX.HIGH ? ' hi' : ''));
            return '<button class="' + cls + '" data-att="' + esc(x.key) + '" data-to="' + esc(c.k) + '">'
              + '<span class="s">' + c.s.toFixed(2) + '</span>' + esc(c.text) + '</button>';
          }).join('')
        : '<span class="meta">同课程里没有候选（这张卡多半是真没了 → 建议删掉这条）</span>';
      html += '<div class="prow' + (gone ? ' gone' : '') + '" data-row="' + esc(x.key) + '">'
        + '<span class="txt what"><span class="tag">' + (x.kind === 'qa' ? '问答' : '术语') + '</span>'
        + '<div class="old">' + esc(x.old) + '</div>'
        + (x.course ? '<div class="meta">课程：' + esc(x.course) + '</div>' : '')
        + '</span>'
        + '<span class="acts">' + cands
        + '<button class="del' + (gone ? ' on' : '') + '" data-drop="' + esc(x.key) + '">'
        + (gone ? '将删除' : '删除这条排除') + '</button></span></div>';
    });
  } else {
    html += '<div class="ok-line">✅ 没有失效项 —— 排除清单里的每一条都还对得上卡片。</div>';
  }
  if (liveN) {
    html += '<div class="hd" style="border-top:1px solid var(--line-soft)">生效中的排除 ' + liveN + ' 条'
      + '（这些卡现在<b>不在</b>学习台里）。点「放回」＝删掉这条排除，卡片立刻回到词库。</div>';
    EX.liveTerm.forEach(function (x) { html += exLiveRow('术语', x, 'term'); });
    EX.liveQa.forEach(function (x) { html += exLiveRow('问答', x, 'qa'); });
  }
  html += '</div><div style="display:flex;align-items:center;gap:8px;margin:10px 0 0">'
    + '<button id="exgo">应用排除清单改动</button>'
    + '<span id="exmsg">改动只在你点这个按钮时才写盘。</span></div>';
  wrap.innerHTML = html;
  exBind();
}
function exLiveRow(tag, x, kind) {
  var gone = fix.drop[x.key];
  return '<div class="prow' + (gone ? ' gone' : '') + '">'
    + '<span class="txt what"><span class="tag">' + tag + '</span><div class="old">' + esc(x.text) + '</div>'
    + (x.zh ? '<div class="meta">' + esc(x.zh) + '</div>' : '') + '</span>'
    + '<span class="acts"><button class="del' + (gone ? ' on' : '') + '" data-drop="' + esc(x.key) + '">'
    + (gone ? '将放回' : '放回') + '</button></span></div>';
}
function exBind() {
  document.querySelectorAll('[data-att]').forEach(function (b) {
    b.onclick = function () {
      var k = b.getAttribute('data-att'), to = b.getAttribute('data-to');
      if (fix.attach[k] === to) delete fix.attach[k]; else { fix.attach[k] = to; delete fix.drop[k]; }
      exRender();
    };
  });
  document.querySelectorAll('[data-drop]').forEach(function (b) {
    b.onclick = function () {
      var k = b.getAttribute('data-drop');
      if (fix.drop[k]) delete fix.drop[k]; else { fix.drop[k] = true; delete fix.attach[k]; }
      exRender();
    };
  });
  var go = document.getElementById('exgo');
  if (go) go.onclick = exApply;
  exMsg();
}
function exMsg() {
  var m = document.getElementById('exmsg');
  if (!m) return;
  var n = exDirty();
  m.textContent = n ? ('待应用：接回 ' + Object.keys(fix.attach).length + ' 条、放回/删除 ' + Object.keys(fix.drop).length + ' 条')
    : '改动只在你点这个按钮时才写盘。';
}
function exApply() {
  if (!exDirty()) return;
  var btn = document.getElementById('exgo'), m = document.getElementById('exmsg');
  btn.disabled = true; m.textContent = '正在写盘并重建词库…';
  fetch('/rematch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attach: fix.attach, drop: Object.keys(fix.drop) })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) throw new Error(j.error || '写入失败');
    fix = { attach: {}, drop: {} };
    m.innerHTML = '✅ 已应用（接回 ' + j.attached + ' 条、删除 ' + j.dropped + ' 条）'
      + (j.staleLeft != null ? '｜还剩 ' + j.staleLeft + ' 条失效' : '')
      + '　备份：' + esc(j.backup) + '　—　可以关闭本页了';
  }).catch(function (e) {
    btn.disabled = false; m.textContent = '写入失败：' + e.message + '（服务可能已退出，重跑一次 选卡.cmd）';
  });
}

render();
exRender();
</script></body></html>`;

const html = PAGE.replace('__PAYLOAD__', payload);

/* ---------------- 服务 ---------------- */
function apply(body) {
  const scope = new Set(body.scope || []);
  const unchecked = new Set(body.unchecked || []);
  const raw = (() => { try { return JSON.parse(fs.readFileSync(sync.EXCLUDE, 'utf8')); } catch (e) { return {}; } })();
  const keepTerm = (raw.excludedTerms || []).filter((k) => !scope.has(String(k).toLowerCase()));
  const keepQa = (raw.excludedQa || []).filter((k) => !scope.has(String(k).toLowerCase()));
  const termSet = new Set(keepTerm.map((x) => String(x).toLowerCase()));
  const qaSet = new Set(keepQa.map((x) => String(x).toLowerCase()));
  ALL.terms.forEach((c) => { if (unchecked.has(c.k)) termSet.add(c.k); });
  ALL.qas.forEach((c) => { if (unchecked.has(c.k)) qaSet.add(c.k); });
  const out = {
    note: '由 课堂笔记\\选卡.cmd（pick-cards.js）生成 —— 这些卡不加入英语学习台。手改也行：删掉对应条目即可恢复。',
    updated: new Date().toLocaleString('zh-CN'),
    excludedTerms: Array.from(termSet).sort(),
    excludedQa: Array.from(qaSet).sort(),
  };
  fs.writeFileSync(sync.EXCLUDE, JSON.stringify(out, null, 2), 'utf8');
  const r = sync.run({});
  return { ok: true, terms: r.terms.length, qas: r.qas.length, skippedTerm: r.skippedTerm || 0, skippedQa: r.skippedQa || 0 };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.indexOf('/?') === 0)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'POST' && req.url === '/apply') {
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 4e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = apply(JSON.parse(buf || '{}')); } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
      res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      if (out.ok) setTimeout(() => { server.close(); process.exit(0); }, 400);
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/rematch') {
    /* 修「排除清单失效」：把生效不了的旧 key 接到现存卡上 / 或直接删掉。
       ⚠ 这里**不关服务** —— 用户可能还想接着点「确认并写入学习台」（那个端点才负责收尾退出）。 */
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 4e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try {
        if (!RM) throw new Error('排除清单分析模块没加载成功，无法改动');
        const body = JSON.parse(buf || '{}');
        const rr = RM.applyChanges(body.attach || {}, body.drop || []);
        const after = RM.analyze();
        out = {
          ok: true, attached: rr.attached, dropped: rr.dropped, backup: rr.backup,
          staleLeft: after.staleTerm.length + after.staleQa.length,
        };
        const syncR = sync.run({});
        out.terms = syncR.terms.length; out.qas = syncR.qas.length;
        EX = after;                                   /* 让页面下次渲染拿到最新状态 */
      } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
      res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

const port = Number(valOf('--port') || 0);
server.listen(port, '127.0.0.1', () => {
  const p = server.address().port;
  const url = 'http://127.0.0.1:' + p + '/';
  const inScope = has('--all') ? cards.length : cards.filter((c) => c.src === latest).length;
  console.log('选卡页已就绪：' + url);
  console.log('  卡片总数 ' + cards.length + '（本次这节课 ' + inScope + ' 张）｜ 已排除 ' + excludedKeys.length + ' 张');
  console.log('  清单文件：' + sync.EXCLUDE);
  console.log('  采完卡点「确认并写入学习台」，服务会自动退出。');
  if (!has('--no-open')) {
    try { cp.spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
  }
});
setTimeout(() => { console.log('（30 分钟无操作，自动退出）'); process.exit(0); }, 30 * 60 * 1000);

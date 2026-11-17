/*
 * weekly-review.js —— 把本周的课堂笔记汇总成一个"周复习台"HTML
 *
 * 用法：
 *   node weekly-review.js               汇总最近有笔记的那一周
 *   node weekly-review.js --week 2026-W39
 *   node weekly-review.js --list        只列出各周有哪些笔记
 *
 * 产物：复习台\<年>-W<周>.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NOTES_DIR = path.join(ROOT, '笔记');
const OUT_DIR = path.join(ROOT, '复习台');

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return { year: t.getUTCFullYear(), week: w, key: t.getUTCFullYear() + '-W' + String(w).padStart(2, '0') };
}

// 递归收集文件（返回相对路径，用 / 分隔）
function listFilesDeep(dir, match) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, pre) => {
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) walk(q, pre ? pre + "/" + it.name : it.name);
      else if (!match || match.test(it.name)) out.push(pre ? pre + "/" + it.name : it.name);
    });
  };
  walk(dir, "");
  return out;
}

function collect() {
  if (!fs.existsSync(NOTES_DIR)) throw new Error('找不到笔记目录：' + NOTES_DIR);
  const items = [];
  listFilesDeep(NOTES_DIR, /\.json$/).forEach((f) => {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, f), 'utf8')); } catch (e) { return; }
    const m = f.match(/_(\d{4})-(\d{2})-(\d{2})\.json$/);
    let d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(fs.statSync(path.join(NOTES_DIR, f)).mtime);
    const wk = isoWeek(d);
    items.push({
      file: f,
      htmlFile: f.replace(/\.json$/, '.html'),
      date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
      week: wk.key,
      data: j,
    });
  });
  items.sort((a, b) => (a.date < b.date ? 1 : -1));
  return items;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* 周复习台在 复习台\<周>.html，笔记在 笔记\<课程>\<日期>\<文件>.html（2026-09-29 起多了一层日期文件夹）。
   ⚠ 必须**逐段编码**：整体 encodeURIComponent 会把 / 变成 %2F，浏览器不当路径分隔符 → 链接点不开。
   （这个 bug 实际存在过：实测生成的 href 是 ../笔记/DEMO1013M%20Communication%20for%20EPS%2F...html）*/
function relHref(relFromNotes) {
  return '../笔记/' + String(relFromNotes).split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/');
}

const SHELL = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>周复习台 WK</title><style>
:root{--sans:system-ui,-apple-system,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,Consolas,monospace;--ease:cubic-bezier(.16,1,.3,1)}
body[data-theme="paper"]{color-scheme:light;--bg:#f1f2f4;--surface:#fff;--ink:#191a1c;--ink-soft:#45484d;--ink-mute:#5f6369;--line:#e0e3e7;--line-soft:#eceff2;--accent:#a63d2f;--accent-ink:#8a2f23;--wash:#f3e8e4;--wash2:#eedcd6;--glow1:rgba(166,61,47,.12);--glow2:rgba(120,130,150,.14)}
body[data-theme="forest"]{color-scheme:light;--bg:#f1f5f0;--surface:#fbfdf9;--ink:#16211a;--ink-soft:#3f4f45;--ink-mute:#5f6b62;--line:#d9e3da;--line-soft:#e8efe9;--accent:#2f6b4b;--accent-ink:#24543a;--wash:#e6f0ea;--wash2:#dbeae1;--glow1:rgba(47,107,75,.14);--glow2:rgba(130,190,140,.13)}
body[data-theme="cobalt"]{color-scheme:light;--bg:#f3f6fb;--surface:#fff;--ink:#131a24;--ink-soft:#414c5c;--ink-mute:#5d6878;--line:#dde4ee;--line-soft:#eaeff7;--accent:#2f5bd0;--accent-ink:#2648a8;--wash:#e8eefc;--wash2:#dde7fa;--glow1:rgba(47,91,208,.13);--glow2:rgba(90,160,220,.13)}
body[data-theme="dusk"]{color-scheme:dark;--bg:#121319;--surface:#191b23;--ink:#e9e8ef;--ink-soft:#bcbbc7;--ink-mute:#94939f;--line:#2b2e39;--line-soft:#23252f;--accent:#e0a458;--accent-ink:#f0bd7d;--wash:#221f26;--wash2:#2a262f;--glow1:rgba(224,164,88,.14);--glow2:rgba(120,110,200,.14)}
body[data-theme="jade"]{color-scheme:dark;--bg:#0f1513;--surface:#161d1a;--ink:#e5efea;--ink-soft:#b3c4bc;--ink-mute:#8b9b93;--line:#26302c;--line-soft:#1e2724;--accent:#4fd1a5;--accent-ink:#7ce0bc;--wash:#1b2622;--wash2:#213029;--glow1:rgba(79,209,165,.14);--glow2:rgba(60,140,150,.13)}
body[data-theme="aurora"]{color-scheme:dark;--bg:#0f0c17;--surface:#171327;--ink:#ece9f7;--ink-soft:#bdb6d6;--ink-mute:#948dab;--line:#292243;--line-soft:#201a34;--accent:#b28dff;--accent-ink:#c9b0ff;--wash:#1e1834;--wash2:#251d40;--glow1:rgba(178,141,255,.16);--glow2:rgba(90,200,250,.12)}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15.5px;line-height:1.72}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
a{color:var(--accent-ink);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 40%,transparent)}
.hero{background:radial-gradient(110% 130% at 8% -10%,var(--glow1) 0,transparent 58%),radial-gradient(90% 110% at 92% 0%,var(--glow2) 0,transparent 62%),var(--bg);border-bottom:1px solid var(--line)}
.wrap{max-width:1000px;margin:0 auto;padding:0 24px}
.hero-in{padding:54px 0 30px}
h1{font-size:clamp(26px,3.4vw,38px);letter-spacing:-.024em;line-height:1.14;margin:0;font-weight:680}
.lead{margin:16px 0 0;font-size:17.5px;color:var(--ink-soft);max-width:56ch}
.bar{display:flex;gap:7px;align-items:center;margin:24px 0 0;flex-wrap:wrap}
.sw{width:22px;height:22px;padding:0;border-radius:50%;border:1px solid var(--line);cursor:pointer;position:relative}
.sw[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:2px}
.sw i{position:absolute;inset:4px;border-radius:50%}
main{padding:0 0 90px}
section{padding-top:34px;margin-top:36px;border-top:1px solid var(--line-soft)}
section:first-of-type{border-top:0;margin-top:30px;padding-top:10px}
h2{font-size:23px;letter-spacing:-.016em;margin:0 0 18px;font-weight:660}
h2::after{content:"";display:block;width:34px;height:2px;background:var(--accent);margin-top:9px;border-radius:2px}
.course{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:14px 0;background:var(--surface)}
.course h3{margin:0 0 6px;font-size:18px}
.course .meta{font-size:12.5px;color:var(--ink-mute);font-variant-numeric:tabular-nums}
.course ul{margin:10px 0 0;padding-left:20px}
.course li{margin:5px 0}
.course li::marker{color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:14.5px;margin:12px 0}
th{text-align:left;font-weight:620;font-size:13px;color:var(--ink-mute);padding:8px 14px 8px 0;border-bottom:1px solid var(--line)}
td{padding:10px 14px 10px 0;border-bottom:1px solid var(--line-soft);vertical-align:top}
tbody tr:nth-child(2n){background:color-mix(in srgb,var(--wash) 45%,transparent)}
td:first-child{font-weight:560}
.map{font-family:var(--mono);font-size:13.5px;line-height:1.8;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;white-space:pre-wrap;overflow:auto}
.qa{border:1px solid var(--line);border-radius:14px;padding:22px 24px 18px;background:var(--surface);max-width:74ch}
.qa .q{font-size:19px;font-weight:650;margin:0;line-height:1.45;min-height:3em}
.qa .a{margin:12px 0 0;color:var(--ink-soft);min-height:3em}
.qa .a[hidden]{display:none}
.ctrl{display:flex;gap:9px;align-items:center;margin-top:16px;padding-top:14px;border-top:1px solid var(--line-soft)}
button{font:inherit;font-size:13px;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:7px 14px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent-ink)}
.count{margin-left:auto;font-size:12.5px;color:var(--ink-mute)}
ul.todos{list-style:none;margin:0;padding:0;max-width:74ch}
ul.todos li{display:flex;gap:11px;padding:10px 12px;border-bottom:1px solid var(--line-soft);border-radius:8px}
ul.todos li:hover{background:var(--wash)}
ul.todos input{margin:5px 0 0;width:16px;height:16px;accent-color:var(--accent)}
ul.todos li.done label{color:var(--ink-mute);text-decoration:line-through}
footer{max-width:1000px;margin:0 auto;padding:22px 24px 60px;border-top:1px solid var(--line-soft);color:var(--ink-mute);font-size:12.5px}
.empty{color:var(--ink-mute)}
@media print{body{--bg:#fff;--surface:#fff;--ink:#000;--line:#ccc;--line-soft:#e4e4e4;--wash:#f4f4f4;--accent:#000;--accent-ink:#000}.bar,.ctrl{display:none}.hero{background:#fff}}
</style></head><body data-theme="paper">
<header class="hero"><div class="wrap hero-in">
  <h1>周复习台 · WK</h1>
  <p class="lead">RANGE 共 NCOURSE 节课 ｜ NPOINT 条要点 ｜ NTERM 个术语 ｜ NQA 组问答</p>
  <div class="bar">
    THEMESWATCH
  </div>
</div></header>
<main class="wrap">
<section><h2>本周课程</h2>COURSES</section>
<section><h2>知识地图（各课导图第一层）</h2><div class="map">MAP</div></section>
<section><h2>术语汇总</h2>TERMS</section>
<section><h2>跨课抽查</h2><div class="qa"><p class="q" id="q">—</p><p class="a" id="a" hidden></p>
<div class="ctrl"><button id="prev">上一题</button><button id="show">显示答案</button><button id="next">下一题</button><span class="count" id="cnt">0 / 0</span></div></div></section>
<section><h2>待办汇总</h2>TODOS</section>
</main>
<footer>由 weekly-review.js 生成 · GENAT ｜ 点上面色点可换主题 ｜ 勾选状态保存在本机</footer>
<script>
(function(){
  var T=['paper','forest','cobalt','dusk','jade','aurora'],K='weekly-theme';
  function sys(){ return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dusk':'paper'; }
  function apply(t){ if(T.indexOf(t)<0)t=sys(); document.body.setAttribute('data-theme',t);
    Array.prototype.forEach.call(document.querySelectorAll('.sw'),function(b){ b.setAttribute('aria-pressed', b.getAttribute('data-theme')===t?'true':'false'); }); }
  apply(localStorage.getItem(K)||sys());
  Array.prototype.forEach.call(document.querySelectorAll('.sw'),function(b){ b.onclick=function(){ var t=b.getAttribute('data-theme'); localStorage.setItem(K,t); apply(t); }; });
  var QA=window.__WEEK_QA__||[], i=0;
  var elQ=document.getElementById('q'), elA=document.getElementById('a'), elC=document.getElementById('cnt');
  function draw(){ if(!QA.length){ elQ.textContent='（本周没有问答）'; elC.textContent='0 / 0'; return; }
    elQ.textContent=QA[i].q; elA.textContent=QA[i].a; elA.hidden=true; elC.textContent=(i+1)+' / '+QA.length; }
  document.getElementById('show').onclick=function(){ elA.hidden=!elA.hidden; };
  document.getElementById('next').onclick=function(){ if(QA.length){ i=(i+1)%QA.length; draw(); } };
  document.getElementById('prev').onclick=function(){ if(QA.length){ i=(i-1+QA.length)%QA.length; draw(); } };
  draw();
  Array.prototype.forEach.call(document.querySelectorAll('ul.todos input[type=checkbox]'),function(box,idx){
    var k='weekly-todo:'+idx;
    if(localStorage.getItem(k)==='1'){ box.checked=true; box.closest('li').classList.add('done'); }
    box.onchange=function(){ localStorage.setItem(k,box.checked?'1':'0'); box.closest('li').classList.toggle('done',box.checked); };
  });
})();
</script></body></html>`;

function build(weekKey) {
  const all = collect();
  const list = weekKey ? all.filter((x) => x.week === weekKey) : all.slice(0, 0).concat(all.filter((x) => x.week === (all[0] && all[0].week)));
  if (!list.length) return { empty: true, all: all };
  const dates = list.map((x) => x.date).sort();
  const range = dates[0] + ' ～ ' + dates[dates.length - 1];

  // 课程卡片
  const courses = list.map((x) => {
    const d = x.data;
    const kp = (d.keyPoints || []).slice(0, 6).map((k) => '<li>' + esc(k.text || k) + '</li>').join('');
    return '<div class="course"><h3>' + esc(d.title || d.course || x.file) + '</h3>'
      + '<div class="meta">' + esc(x.date) + ' ｜ ' + esc(d.course || '') + ' ｜ 要点 ' + (d.keyPoints || []).length
      + ' ｜ <a href="' + relHref(x.htmlFile) + '">打开当日笔记</a></div>'
      + (kp ? '<ul>' + kp + '</ul>' : '') + '</div>';
  }).join('');

  // 知识地图
  const map = list.map((x) => {
    const lines = String(x.data.mindmap || '').split('\n').filter((l) => l.trim());
    const top = lines.filter((l) => /^\S/.test(l) || /^ {2}\S/.test(l)).slice(0, 8);
    return '【' + (x.data.title || x.data.course || x.date) + '】\n' + (top.length ? top.join('\n') : '（无导图）');
  }).join('\n\n');

  // 术语汇总（去重）
  const seen = new Set();
  const termRows = [];
  list.forEach((x) => (x.data.terms || []).forEach((t) => {
    const key = String(t.en || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    termRows.push('<tr><td>' + esc(t.en) + '</td><td>' + esc(t.zh) + '</td><td>' + esc(t.note || '') + '</td><td>' + esc(x.date) + '</td></tr>');
  }));

  // 跨课问答（随机抽 15，带出处）
  const pool = [];
  list.forEach((x) => (x.data.qa || []).forEach((q) => pool.push({ q: q.q, a: q.a, src: (x.data.title || x.date) + (q.t ? ' @' + q.t : '') })));
  const picked = [];
  const copy = pool.slice();
  while (picked.length < 15 && copy.length) picked.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);

  // 待办
  const todos = [];
  list.forEach((x) => (x.data.todos || []).forEach((t) => todos.push({ t: t, src: x.date })));

  const html = SHELL
    .replace('WK', weekKey)
    .replace('WK', weekKey)
    .replace('RANGE', esc(range))
    .replace('NCOURSE', String(list.length))
    .replace('NPOINT', String(list.reduce((a, x) => a + (x.data.keyPoints || []).length, 0)))
    .replace('NTERM', String(termRows.length))
    .replace('NQA', String(pool.length))
    .replace('COURSES', courses)
    .replace('MAP', esc(map))
    .replace('TERMS', termRows.length
      ? '<table><thead><tr><th style="width:24%">英文</th><th style="width:20%">中文</th><th>说明</th><th style="width:14%">出处</th></tr></thead><tbody>' + termRows.join('') + '</tbody></table>'
      : '<p class="empty">（本周没有术语）</p>')
    .replace('TODOS', todos.length
      ? '<ul class="todos">' + todos.map((x, i) => '<li><input type="checkbox" id="w' + i + '"><label for="w' + i + '">' + esc(x.t) + ' <span class="count">' + esc(x.src) + '</span></label></li>').join('') + '</ul>'
      : '<p class="empty">（本周没有待办）</p>')
    .replace('THEMESWATCH', ['paper', 'forest', 'cobalt', 'dusk', 'jade', 'aurora'].map((t) =>
      '<button class="sw" type="button" data-theme="' + t + '" aria-label="' + t + '"><i style="background:' +
      ({ paper: '#a63d2f', forest: '#2f6b4b', cobalt: '#2f5bd0', dusk: '#e0a458', jade: '#4fd1a5', aurora: '#b28dff' })[t] + '"></i></button>').join(''))
    .replace('GENAT', esc(new Date().toLocaleString('zh-CN')))
    + '<script>window.__WEEK_QA__=' + JSON.stringify(picked.map((x) => ({ q: x.q + '　（' + x.src + '）', a: x.a }))).replace(/</g, '\\u003c') + ';<\/script>';

  return { html: html, week: weekKey, courses: list.length, terms: termRows.length, qa: pool.length, todos: todos.length, range: range };
}

// ---------------- CLI ----------------
const args = process.argv.slice(2);
const all = collect();
if (args.includes('--list')) {
  const byWeek = {};
  all.forEach((x) => { (byWeek[x.week] = byWeek[x.week] || []).push(x); });
  Object.keys(byWeek).sort().reverse().forEach((w) => {
    console.log(w + '：' + byWeek[w].length + ' 节');
    byWeek[w].forEach((x) => console.log('   ' + x.date + '  ' + (x.data.title || x.file)));
  });
  process.exit(0);
}
const wi = args.indexOf('--week');
const weekKey = wi >= 0 ? args[wi + 1] : (all[0] && all[0].week);
if (!all.length) { console.log('[!] 笔记目录里还没有 JSON，先跑一次 一键出笔记。'); process.exit(0); }
const r = build(weekKey);
if (r.empty) { console.log('[!] 该周没有笔记：' + weekKey + '（用 node weekly-review.js --list 看有哪些周）'); process.exit(0); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, r.week + '.html');
fs.writeFileSync(out, r.html, 'utf8');
console.log('[√] 周复习台已生成：' + out);
console.log('    ' + r.week + ' ｜ ' + r.range + ' ｜ ' + r.courses + ' 节课 ｜ 术语 ' + r.terms + ' ｜ 问答池 ' + r.qa + ' ｜ 待办 ' + r.todos);
if (process.argv.includes('--open')) { require('child_process').spawn('cmd', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' }).unref(); }

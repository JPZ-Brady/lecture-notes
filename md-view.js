/*
 * md-view.js —— 把 .md 变成**双击就能看的单文件 HTML**（离线自包含，零外链）
 *   node md-view.js "课件\DEMO1006M Knowledge Repres. & Reasoning"   # 该目录下所有 .md
 *   node md-view.js "课件\某课程\课程地图.md"                          # 指定某一份
 *   node md-view.js --dir "课件"                                      # 递归整个子树
 *
 * 为什么不用现成软件：本机已有 VS Code（F:\Microsoft VS Code，PATH 里有 code），
 * 看 .md 完全够用；但 .json 是给程序读的，而且笔记系统本身全是 HTML——
 * 课件文档保持同一套观感、还能搜索，就不用再装 Markdown 阅读器了。
 * 受限支持：标题 / 列表 / 表格 / 引用 / 分隔线 / 粗体 / 行内代码 / 链接 / 围栏代码块。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* 行内标记：先转义，再按「行内代码 → 粗体 → 斜体 → 链接」的顺序处理 */
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (m, a) => '<code>' + a + '</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

function render(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let title = '';
  let i = 0;
  const listStack = [];
  const closeLists = (to) => { while (listStack.length > to) out.push('</' + listStack.pop() + '>'); };
  let inCode = false, para = [];

  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };

  for (; i < lines.length; i++) {
    const ln = lines[i];

    if (/^```/.test(ln)) {
      flushPara(); closeLists(0);
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(ln)); continue; }

    if (!ln.trim()) { flushPara(); closeLists(0); continue; }

    let m;
    if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); closeLists(0);
      if (m[1].length === 1 && !title) { title = m[2].trim(); continue; }
      const lv = Math.min(m[1].length + 1, 5);
      out.push('<h' + lv + ' id="h' + out.length + '">' + inline(m[2]) + '</h' + lv + '>');
      continue;
    }
    if (/^(---+|\*\*\*+)$/.test(ln.trim())) { flushPara(); closeLists(0); out.push('<hr>'); continue; }

    /* 表格：本行是 |…| 且下一行是分隔行 */
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara(); closeLists(0);
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
      out.push('<table><thead><tr>' + cells(ln).map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>');
      i += 2;
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        out.push('<tr>' + cells(lines[i]).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      }
      i--;
      out.push('</tbody></table>');
      continue;
    }

    if ((m = ln.match(/^>\s?(.*)$/))) {
      flushPara(); closeLists(0);
      const buf = [m[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) buf.push(lines[++i].replace(/^>\s?/, ''));
      out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    if ((m = ln.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/))) {
      flushPara();
      const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2) + 1;
      const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
      while (listStack.length > depth) out.push('</' + listStack.pop() + '>');
      if (listStack.length === depth && listStack[depth - 1] !== kind) { out.push('</' + listStack.pop() + '>'); }
      if (listStack.length < depth) { out.push('<' + kind + '>'); listStack.push(kind); }
      out.push('<li>' + inline(m[3]) + '</li>');
      continue;
    }

    para.push(ln.trim());
  }
  flushPara(); closeLists(0);
  if (inCode) out.push('</code></pre>');
  return { title: title || '文档', body: out.join('\n') };
}

function page(title, body, subtitle) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f4f1ec;--surface:#fffefb;--ink:#1a1815;--ink-soft:#46423c;--ink-mute:#635d55;
  --line:#e0dad0;--line-soft:#ebe6dd;--accent:#a63d2f;--wash:#f1e7e2}
body[data-theme="dusk"]{--bg:#13151d;--surface:#1b1e28;--ink:#eceae9;--ink-soft:#c1bfc8;--ink-mute:#9492a0;
  --line:#2e3240;--line-soft:#252936;--accent:#e6ab63;--wash:#241f1d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 0 12px}
.wrap{max-width:900px;margin:0 auto;padding:0 24px}
h1{margin:0;font-size:clamp(19px,2.4vw,25px);line-height:1.3;letter-spacing:-.01em}
.sub{margin:4px 0 0;color:var(--ink-mute);font-size:12.5px}
.bar{display:flex;gap:10px;align-items:center;margin-top:11px;flex-wrap:wrap}
#q{flex:1 1 240px;min-width:0;padding:8px 12px;border:1px solid var(--line);border-radius:9px;
  background:var(--surface);color:var(--ink);font:inherit;font-size:13.5px}
#q:focus{outline:2px solid var(--accent);outline-offset:1px}
#n{color:var(--ink-mute);font-size:12.5px;white-space:nowrap}
button{padding:7px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface);
  color:var(--ink-soft);font:inherit;font-size:12.5px;cursor:pointer}
button:hover{color:var(--accent)}
main{max-width:900px;margin:0 auto;padding:22px 24px 90px}
h2{font-size:19px;margin:30px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line-soft)}
h3{font-size:16px;margin:22px 0 8px}
h4,h5{font-size:14.5px;margin:16px 0 6px}
p{margin:9px 0}
ul,ol{margin:8px 0;padding-left:24px}
li{margin:4px 0}
ol>li::marker{content:counter(list-item) ". "}
ul>li::marker{content:"•  "}
li::marker{color:var(--accent)}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
code{background:var(--wash);padding:1.5px 5px;border-radius:5px;font-size:.9em;
  font-family:ui-monospace,Consolas,"Courier New",monospace}
pre{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:12px 0;padding:9px 14px;border-left:3px solid var(--accent);background:var(--surface);
  border-radius:0 9px 9px 0;color:var(--ink-soft)}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--surface);font-weight:600}
a{color:var(--accent)}
.hide{display:none}
mark{background:color-mix(in srgb,var(--accent) 22%,transparent);color:inherit;padding:0 1px;border-radius:3px}
@media print{.top{position:static}button,#q{display:none}}
</style>
</head>
<body data-theme="paper">
<div class="top"><div class="wrap">
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(subtitle || '')}</p>
  <div class="bar">
    <input id="q" type="search" placeholder="搜索本文档（标题/正文/表格都能搜）…" autocomplete="off">
    <span id="n"></span>
    <button id="t" type="button">深色</button>
    <button id="p" type="button">打印 / PDF</button>
  </div>
</div></div>
<main id="doc">
${body}
</main>
<script>
(function(){
  var body=document.body, q=document.getElementById('q'), n=document.getElementById('n');
  var blocks=[].slice.call(document.querySelectorAll('#doc li,#doc p,#doc tr,#doc h2,#doc h3,#doc h4,#doc blockquote'));
  var total=blocks.length;
  n.textContent=total+' 块';
  q.addEventListener('input',function(){
    var k=q.value.trim().toLowerCase();
    if(!k){ blocks.forEach(function(b){ b.classList.remove('hide'); }); n.textContent=total+' 块'; return; }
    var hit=0;
    blocks.forEach(function(b){
      var on=b.textContent.toLowerCase().indexOf(k)>=0;
      b.classList.toggle('hide',!on);
      if(on) hit++;
    });
    n.textContent='命中 '+hit+' / '+total;
  });
  var t=document.getElementById('t');
  try{ var saved=localStorage.getItem('mdview:theme'); if(saved) body.dataset.theme=saved; }catch(e){}
  var paint=function(){ t.textContent = body.dataset.theme==='dusk' ? '浅色' : '深色'; };
  paint();
  t.addEventListener('click',function(){
    body.dataset.theme = body.dataset.theme==='dusk' ? 'paper' : 'dusk';
    try{ localStorage.setItem('mdview:theme', body.dataset.theme); }catch(e){}
    paint();
  });
  document.getElementById('p').addEventListener('click',function(){ window.print(); });
})();
</script>
</body>
</html>`;
}

function convert(mdPath) {
  const md = fs.readFileSync(mdPath, 'utf8');
  const r = render(md);
  const out = mdPath.replace(/\.md$/i, '.html');
  const src = path.basename(mdPath);
  const stat = fs.statSync(mdPath);
  const stamp = new Date(stat.mtimeMs).toLocaleString('zh-CN', { hour12: false });
  fs.writeFileSync(out, page(r.title, r.body, '由 ' + src + ' 生成（' + stamp + '）· 离线自包含，可搜索、可打印'), 'utf8');
  return out;
}

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((it) => {
    const q = path.join(dir, it.name);
    if (it.isDirectory()) { if (it.name !== '_待归档') walk(q, out); }
    else if (it.name.toLowerCase().endsWith('.md')) out.push(q);
  });
  return out;
}

module.exports = { render, page, convert };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const recursive = argv.indexOf('--dir') >= 0;
  const args = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--dir');
  const targets = args.length ? args : ['.'];
  let list = [];
  targets.forEach((t) => {
    const p = path.resolve(__dirname, t);
    if (!fs.existsSync(p)) { console.log('[X] 找不到：' + p); return; }
    if (fs.statSync(p).isDirectory()) list = list.concat(recursive ? walk(p, []) : fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith('.md')).map((f) => path.join(p, f)));
    else list.push(p);
  });
  if (!list.length) { console.log('没有找到 .md（用法：node md-view.js "<目录或.md>"）'); process.exit(0); }
  list.forEach((f) => {
    try { console.log('  ✓ ' + convert(f).replace(__dirname + path.sep, '')); }
    catch (e) { console.log('  ✗ ' + f + '：' + (e && e.message ? e.message : e)); }
  });
}

/*
 * similar-courses.js —— 「这门课跟国内哪门课像 / 网上有没有能提前学的」的半自动入口
 *   node similar-courses.js                       # 自动挑最近更新的那门有课程地图的课
 *   node similar-courses.js "课件\某课程"          # 指定课程目录
 *   node similar-courses.js --no-open             # 只生成，不开浏览器
 * 配套：双击 查近似课程.cmd
 *
 * ⚠ 诚实边界（很重要）：
 *   这一步**不能**由脚本自动得出结论。理由：脚本里没有可靠的搜索 API，
 *   而"哪门课像哪门课"是**事实性判断**，必须有可点开的来源；靠模型记忆猜出来的课程名
 *   没有事实约束，拿来当结论就是编（本项目已把它写进纪律：模型推测不得当结论用）。
 *   所以脚本做它能确定做到的两件事：
 *     ① 从课程地图里抽出「靠什么去搜」（模块代码、课名、前若干讲讲题），生成好各个站的搜索链接
 *     ② 生成一张**待填的对照表**（讲次已按课件结构预填），你或 AI 把核实过的结论填进去
 *   结论最终落在同目录的 近似课程对比.md（这份文件才是交付物，见 §10.5 Phase C）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const CW = path.join(ROOT, '课件');
const argv = process.argv.slice(2);
const NO_OPEN = argv.indexOf('--no-open') >= 0;
const given = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--no-open');

/* ---- 找课程目录：优先用给的，否则挑「课程地图.json 最新」的那门 ---- */
function pickCourseDir() {
  if (given) {
    const p = path.isAbsolute(given) ? given : path.join(ROOT, given);
    return fs.existsSync(p) ? p : '';
  }
  if (!fs.existsSync(CW)) return '';
  const cands = fs.readdirSync(CW, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_待归档')
    .map((d) => path.join(CW, d.name))
    .filter((d) => fs.existsSync(path.join(d, '课程地图.json')));
  if (!cands.length) return '';
  cands.sort((a, b) => fs.statSync(path.join(b, '课程地图.json')).mtimeMs - fs.statSync(path.join(a, '课程地图.json')).mtimeMs);
  return cands[0];
}

const dir = pickCourseDir();
if (!dir) {
  console.log('没找到带 课程地图.json 的课程目录。先把课件归位：双击 整理课件.cmd（或 node import-slides.js）');
  process.exit(10);
}
const course = path.basename(dir);
/* 用**共享地图**（＝页数最多那份课件，一般是整学期总课件），它才能反映整门课的结构；
   单节课件的地图是 课程地图-<课件名>.json。 */
const mapFile = path.join(dir, '课程地图.json');
let map = null;
try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch (e) { /* 下面报错 */ }
if (!map || !Array.isArray(map.lectures) || !map.lectures.length) {
  console.log('[X] ' + mapFile + ' 里没有 lectures —— 先跑 node read-slides.js "' + course + '"');
  process.exit(10);
}

/* ---- 从课程地图里抽「搜索用的关键词」（全部来自课件本身，不靠猜） ---- */
const code = (course.match(/^[A-Z]{2,}\d{3,}[A-Z]?/) || [''])[0];
const nameEn = course.replace(/^[A-Z]{2,}\d{3,}[A-Z]?\s*/, '').trim();
const lecNames = map.lectures.map((l) => l.name).filter(Boolean);
const coreTopics = lecNames.slice(0, 8).join('; ');
const queryA = [code, nameEn].filter(Boolean).join(' ');
const queryB = nameEn + ' lecture notes syllabus';
const queryC = (map.toc || []).slice(0, 6).map((t) => t.title).join(' ');
const queryD = lecNames.slice(0, 4).join(' ');

const enc = encodeURIComponent;
/* ⚠ 这里一律放**原始**关键词，编码只在拼 href 时做一次 —— 否则页面上会显示成一串 %20 */
const searchers = [
  ['Bing', 'https://www.bing.com/search?q=', queryA],
  ['Bing（找公开课/讲义）', 'https://www.bing.com/search?q=', queryB],
  ['Google', 'https://www.google.com/search?q=', queryA],
  ['DuckDuckGo', 'https://duckduckgo.com/?q=', queryA],
  ['GitHub（找别人的笔记/复习资料）', 'https://github.com/search?type=repositories&q=', queryA],
  ['知乎（中文经验帖：这门课对应国内哪门）', 'https://www.zhihu.com/search?type=content&q=', nameEn + ' 对应 国内 课程'],
  ['中国大学MOOC', 'https://www.icourse163.org/search.htm?search=', nameEn],
  ['学堂在线', 'https://www.xuetangx.com/search?query=', nameEn],
  ['国家高等教育智慧教育平台', 'https://higher.smartedu.cn/search?keyword=', nameEn],
  ['NPTEL（印度公开课，英文、免费、成体系）', 'https://nptel.ac.in/courses?search=', nameEn],
  ['MIT OCW', 'https://ocw.mit.edu/search/?q=', nameEn],
  ['按讲题搜讲义（Bing）', 'https://www.bing.com/search?q=', queryC + ' lecture slides'],
  ['按讲题搜讲义（Google）', 'https://www.google.com/search?q=', queryD + ' lecture slides'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>近似课程 · 待核实入口 · ${esc(course)}</title>
<style>
:root{--bg:#f4f1ec;--surface:#fffefb;--ink:#1a1815;--ink-soft:#46423c;--ink-mute:#635d55;
 --line:#e0dad0;--line-soft:#ebe6dd;--accent:#a63d2f;--wash:#f1e7e2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:26px 24px 90px}
h1{margin:0 0 6px;font-size:clamp(19px,2.4vw,25px)}
h2{font-size:18px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line-soft)}
.sub{color:var(--ink-mute);font-size:12.5px;margin:0}
.warn{margin:14px 0;padding:11px 14px;border-left:3px solid var(--accent);background:var(--surface);
 border-radius:0 10px 10px 0;color:var(--ink-soft);font-size:13.5px}
.q{margin:3px 0 9px;font-size:13px;color:var(--ink-mute);font-family:ui-monospace,Consolas,monospace;
 background:var(--wash);padding:5px 9px;border-radius:7px;word-break:break-all}
ul.links{list-style:none;margin:0;padding:0;display:grid;gap:7px}
ul.links a{display:block;padding:9px 13px;background:var(--surface);border:1px solid var(--line);
 border-radius:10px;color:var(--ink);text-decoration:none;font-size:14px}
ul.links a:hover{border-color:var(--accent);color:var(--accent)}
ul.links span{color:var(--ink-mute);font-weight:400}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin:10px 0}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:var(--surface)}
td.fill{color:var(--ink-mute)}
code{background:var(--wash);padding:1.5px 5px;border-radius:5px;font-size:.9em}
ol{padding-left:22px}
</style></head><body><div class="wrap">
<h1>近似课程 · 待核实入口</h1>
<p class="sub">课程：<b>${esc(course)}</b>　课件：${esc(map.deck || '')}（${map.pages} 页 / ${map.lectures.length} 讲）　生成：${new Date().toLocaleString('zh-CN', { hour12: false })}</p>

<div class="warn">
  <b>这份页面只负责「把搜索入口开好」，不负责下结论。</b><br>
  「这门课跟国内哪门像、网上有没有能提前学的」是<b>事实判断</b>，必须有<b>能点开的来源</b>才算数。
  脚本里没有可靠的搜索接口，模型凭记忆报出来的课程名<b>没有事实约束</b>——所以本项目的纪律是：
  模型推测<b>不得当结论用</b>。下面的链接点开核实后，把结论写进
  <code>${esc(dir.replace(ROOT + path.sep, ''))}\\近似课程对比.md</code>（那是交付物）。
</div>

<h2>一、搜索用的关键词（全部抽自你自己的课件，不是我猜的）</h2>
<p class="sub">模块代码：<b>${esc(code || '（文件名里没有模块代码）')}</b>　课名：<b>${esc(nameEn)}</b><br>
前几讲讲题：${esc(coreTopics || '（课程地图里没有讲题）')}</p>
<p class="q">${esc(queryA)}</p>
<p class="q">${esc(queryB)}</p>

<h2>二、点这些入口去搜（新标签打开）</h2>
<ul class="links">
${searchers.map(([label, base, q]) => '  <li><a target="_blank" rel="noopener" href="' + base + esc(enc(q)) + '">' + esc(label) + ' <span>· ' + esc(String(q).slice(0, 70)) + '</span></a></li>').join('\n')}
</ul>

<h2>三、待填的对照表（讲次已按课件结构预填）</h2>
<p class="sub">填法：每行写「哪门课覆盖了这一讲 / 覆盖到什么程度 / 来源链接」。没有对应的就写「没有」——<b>写"没有"比硬凑一门课更诚实</b>。</p>
<table>
<thead><tr><th style="width:64px">讲次</th><th style="width:42%">这讲讲什么（课件原文标题）</th><th style="width:26%">国内哪门课覆盖</th><th>来源链接 / 覆盖程度</th></tr></thead>
<tbody>
${map.lectures.map((l) => '  <tr><td>KRR-' + l.no + '</td><td>' + esc(l.name || '') +
  '</td><td class="fill">待填</td><td class="fill">待填</td></tr>').join('\n')}
</tbody></table>

<h2>四、写结论时的纪律（照抄即可）</h2>
<ol>
  <li>每条结论后面必须跟<b>能点开的来源</b>（官方模块页、课程主页、公开课页面）。</li>
  <li>区分三档：<b>等价课</b>（内容几乎一一对应）／<b>部分重合</b>（说清重合的是哪一半）／<b>没有对应</b>。</li>
  <li>模型自己生成的「近似课程」推测一律标注为推测，<b>不得当结论</b>。</li>
  <li>只补逻辑那一半就够的，直接说明「离散数学的数理逻辑章节够用」，别硬推一门整课。</li>
</ol>
</div></body></html>`;

const out = path.join(dir, '近似课程-待核实.html');
fs.writeFileSync(out, html, 'utf8');
console.log('== 近似课程 · 待核实入口 ==');
console.log('  课程：' + course);
console.log('  关键词：' + queryA);
console.log('  搜索入口：' + searchers.length + ' 个（浏览器里点开即可）');
console.log('  产物：' + out);
console.log('  结论请写进：' + path.join(dir, '近似课程对比.md'));

if (!NO_OPEN) {
  try { cp.spawn('cmd', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' }).unref(); console.log('  已在浏览器打开'); }
  catch (e) { console.log('  （自动打开失败，手动双击那个 html 即可）'); }
}

/*
 * _verify-guide.js —— 使用说明.html 的体检
 *
 * 为什么需要它：这份说明**不在任何验收套件里**，所以它自己静默过期过一次
 * （界面写成「单长文档 + 粘性目录」、项数写 28/21、课表写 25 个课时、还推荐了已删除的模型）。
 * 改完说明后跑一遍，防止再犯。
 *
 * 用法：node _verify-guide.js
 * 退出码：0 = 全过；1 = 有失败
 */
'use strict';
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '使用说明.html');
if (!fs.existsSync(P)) { console.log('[X] 找不到 使用说明.html'); process.exit(1); }
const s = fs.readFileSync(P, 'utf8');
let pass = 0, fail = 0;
const ok = (m) => { console.log('[√] ' + m); pass++; };
const no = (m) => { console.log('[X] ' + m); fail++; };

/* 1. 标签平衡 */
const tags = ['div', 'section', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ol', 'ul', 'li', 'p', 'pre',
  'h1', 'h2', 'h3', 'span', 'b', 'code', 'a', 'button', 'header', 'main', 'footer', 'script', 'style', 'i'];
const unbal = tags.filter((t) => {
  const open = (s.match(new RegExp('<' + t + '(?=[\\s>])', 'g')) || []).length;
  const selfc = (s.match(new RegExp('<' + t + '[^>]*?/>', 'g')) || []).length;
  const close = (s.match(new RegExp('</' + t + '>', 'g')) || []).length;
  return open - selfc !== close;
});
unbal.length ? no('标签不平衡：' + unbal.join(', ')) : ok('标签平衡（' + tags.length + ' 种标签）');

/* 2. 模板占位符残留（这份文档不是模板生成的，不该出现） */
const toks = s.match(/<!--(TITLE|ONELINE|FACTS|TOC|SIBLINGS|KEYPOINTS|NOTES|BILINGUAL|TERMS|MINDMAP|PLAYER|TODOS|RAWJSON|GENAT)-->/g) || [];
toks.length ? no('模板占位符残留：' + toks.join(' ')) : ok('无模板占位符残留');

/* 3. 正文里的裸 <（会被当标签解析，路径要写成 &lt; &gt;）；script/style/DOCTYPE 不算 */
const raw = [];
let inScript = false;
s.split('\n').forEach((line, i) => {
  const t = line.trim();
  if (/^<script/.test(t)) inScript = true;
  if (inScript && /<\/script>/.test(t)) { inScript = false; return; }
  if (inScript || /^<style/.test(t) || /^<!DOCTYPE/.test(t)) return;
  if (/<[^\s]/.test(t.replace(/<\/?[a-zA-Z][^>]*>/g, ''))) raw.push((i + 1) + ': ' + t.slice(0, 70));
});
raw.length ? no('正文有裸 < 号：\n      ' + raw.join('\n      ')) : ok('正文无裸 < 号（路径都写成 &lt; &gt;）');

/* 4. 离线自包含：只允许纯文字超链接，不许任何资源引用 */
const res = (s.match(/(src|@import|url\(http|<link)/g) || []);
res.length ? no('出现资源级外链（必须完全离线自包含）：' + res.join(' ')) : ok('无资源级外链（离线自包含）');
const ext = (s.match(/href="(?!#|mailto)[^"]*"/g) || []);
ok('纯文字超链接 ' + ext.length + ' 个' + (ext.length ? '：' + ext.join(' ') : ''));

/* 5. 六套主题：CSS 变量块 + 切换按钮一一对应 */
const themes = ['paper', 'forest', 'cobalt', 'dusk', 'jade', 'aurora'];
const miss = themes.filter((t) => s.indexOf('body[data-theme="' + t + '"]{') < 0
  || !(new RegExp('data-theme="' + t + '"\\s+aria-label').test(s)));
const btn = (s.match(/class="sw" type="button" data-theme=/g) || []).length;
miss.length ? no('主题缺失：' + miss.join(',')) : ok('六套主题齐全（CSS 变量块 + ' + btn + ' 个切换按钮）');

/* 6. 关键声明必须还在（数字只在这一个地方写；下面 9 节还会用它核对 操作手册.md）
   ⚠ 2026-10-01：课件自测的项数**不再是固定值** —— 第①节改成遍历所有课程后，总分 = 固定项 + 11 × 有课件的课程数。
     所以这里不再钉数字，改成钉**口径**：「项数随课程数增加」。两项体检工具都这么写。
     旧的「43 项 / 43/43」已进下面 FORBID 黑名单，防止写回去。 */
const NUM = { out: 41, tt: 79, chunk: 14, launchers: 6, guide: 12 };
const MUST = [
  [NUM.out + ' 项', '产物体检项数'],
  [NUM.tt + ' 项', '课表自测项数'],
  [NUM.chunk + ' 项', '长音频分段转写自测项数'],
  ['项数随课程数增加', '课件自测项数是动态的口径（不再写死数字）'],
  ['13 门模块 + 29 个固定课时', '课表规模'],
  ['_verify-transcript.js', '转写稿质检工具'],
  ['trim-transcript.js', '转写稿裁剪工具'],
  ['rematch-excluded.js', '排除清单重匹配工具'],
  ['_verify-slides.js', '课件管线自测工具'],
  ['_test-chunk.js', '长音频分段转写自测工具'],
  ['_verify-guide.js', '本工具自身'],
  ['上课日期', '日期口径说明'],
  ['分离不可靠', '发言人分离结论'],
  ['选卡.cmd', '挑卡入口'],
  ['整理课件.cmd', '课件归位入口'],
  ['查近似课程.cmd', '近似课程搜索入口'],
  ['md-view.js', '.md 转单文件 HTML'],
  ['_待归档', '认不出课程的课件兜底目录'],
  ['不加入学习台.json', '卡片排除清单'],
  ['v4', '版本号'],
];
const m1 = MUST.filter((m) => s.indexOf(m[0]) < 0);
m1.length ? no('缺少声明：' + m1.map((m) => m[1] + '（' + m[0] + '）').join('；')) : ok('关键声明齐备（' + MUST.length + ' 项）');

/* 7. 旧版失实描述不许复活（把"上一版的数字"也钉进去，改数字时别只改一处）
   注意别放太泛的串：「29 项」是正文里的实测事实（核出 29 项）、「5 个」也到处都有，会误报。 */
/* 旧数字黑名单：出现过就说明文档又写回老口径了。
   ⚠ 别把**当前**数字加进来（'41 项' 现在是产物体检的正确项数；它曾经是课件自测的旧项数，但同一个字符串没法只禁一种）
   规则：数字变了就同步 使用说明.html / 操作手册.md / 这里的 NUM，并把**被淘汰的**那个数字加进来。 */
const FORBID = ['粘性目录', '28 项', '21 项', '34 项', '35 项', '36 项', '40 项', '67 项', '33 项',
  '43 项', '43/43', '44 项', '42/42',
  '25 个固定课时', '单长文档 + 粘性目录', '三个 .cmd'];
const alive = FORBID.filter((f) => s.indexOf(f) >= 0);
alive.length ? no('旧描述复活：' + alive.join(' / ')) : ok('旧版失实描述已清除（' + FORBID.length + ' 项）');

/* 7b. 已删除的模型可以「作为历史」被提到，但不许再作为可用选项出现 */
const DEAD = 'ggml-large-v3-q8_0.bin';
if (s.indexOf(DEAD) >= 0 && !/已删除|一并删除/.test(s)) {
  no('推荐了已删除的模型 ' + DEAD + '，却没说明它已删除');
} else if (s.indexOf(DEAD) >= 0) {
  ok('已删除模型的提及带删除说明（' + DEAD + '）');
} else {
  ok('未提及已删除的模型');
}

/* 8. 设计底线：小于 11px 的功能性文字（impeccable 报过 3 条） */
const small = [];
(s.match(/font-size:\s*([\d.]+)px/g) || []).forEach((m) => {
  const v = parseFloat(m.replace(/[^\d.]/g, ''));
  if (v < 11 && v > 0) small.push(v);
});
small.length ? no('有 < 11px 的字号：' + small.join(', ') + 'px') : ok('无小于 11px 的功能性字号（impeccable 的底线）');

/* 9. 操作手册.md —— 同一套数字与入口名必须一致（两份文档最容易一个改了一个没改） */
const MP = path.join(__dirname, '操作手册.md');
if (!fs.existsSync(MP)) {
  no('找不到 操作手册.md（给用户看的一页版操作手册）');
} else {
  const m = fs.readFileSync(MP, 'utf8');
  const need = [
    [NUM.out + '/' + NUM.out, '产物体检 41/41'],
    [NUM.tt + '/' + NUM.tt, '课表自测 ' + NUM.tt + '/' + NUM.tt],
    [NUM.chunk + '/' + NUM.chunk, '分段转写自测 ' + NUM.chunk + '/' + NUM.chunk],
    ['全部通过」（项数随课程数增加）', '课件自测：口径一致（动态项数）'],
    [NUM.guide + ' 项全过', '本工具自身项数'],
    [NUM.launchers + '/' + NUM.launchers, '启动器 6/6'],
    ['一键出笔记.cmd', '出笔记入口'],
    ['整理课件.cmd', '课件归位入口'],
    ['查近似课程.cmd', '近似课程搜索入口'],
    ['选卡.cmd', '挑卡入口'],
    ['周复习.cmd', '周复习入口'],
    ['生成笔记.cmd', '只重跑笔记入口'],
    ['录音\\', '收件箱文件夹'],
    ['课件\\', '课件总文件夹'],
    ['_待归档', '认不出课程的兜底目录'],
    ['交接文档', '指向技术交接文档'],
  ];
  const bad = need.filter((x) => m.indexOf(x[0]) < 0);
  bad.length ? no('操作手册缺声明：' + bad.map((x) => x[1] + '（' + x[0] + '）').join('；'))
    : ok('操作手册与使用说明口径一致（' + need.length + ' 项）');
  const dead = FORBID.filter((f) => m.indexOf(f) >= 0);
  dead.length ? no('操作手册里有旧数字/旧描述：' + dead.join(' / ')) : ok('操作手册无过期数字');
}

console.log('');
console.log('文件：' + P);
console.log('大小：' + (fs.statSync(P).size / 1024).toFixed(1) + ' KB' +
  (fs.existsSync(MP) ? '　＋　操作手册.md ' + (fs.statSync(MP).size / 1024).toFixed(1) + ' KB' : ''));
console.log('');
console.log(fail ? ('结论：' + fail + ' 项未通过（通过 ' + pass + ' 项）') : ('结论：使用说明 + 操作手册体检全部通过（' + pass + ' 项）'));
process.exit(fail ? 1 : 0);

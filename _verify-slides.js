/*
 * _verify-slides.js —— 课件管线自测（离线，不联网、不调模型、不动你的文件）
 *   node _verify-slides.js
 *
 * 覆盖三件事：
 *   ① 课件产物本身：课程地图的结构、讲号连续性、页范围、与 Contents 的交叉核对
 *   ② 一门课一个文件夹之后「目录里有多份课件」的选择规则（曾经会悄悄只挑第一份）
 *   ③ 认课规则的三层证据 + 「领先不够就不认」的安全阀（曾把 KRR 课件认成 Machine Learning）
 *   ④ 搬运的安全不变量：先复制→逐字节比对→删源；同名不同内容绝不覆盖
 *
 * 退出码：0 全过 / 1 有失败
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const CW = path.join(ROOT, '课件');
const INBOX = path.join(ROOT, '录音');
const PENDING = path.join(CW, '_待归档');
const TMP = path.join(ROOT, '_tmp-verify-slides');

let pass = 0, fail = 0;
/* TAG：体检某个课程目录时给每条断言打上课程名前缀（2026-10-01 第①节改成遍历所有课程后加的），
   这样一条失败能一眼看出是哪门课。平时为空串，输出与以前完全一致。 */
let TAG = '';
const ok = (m) => { pass++; console.log('[√] ' + (TAG ? TAG + ' ' : '') + m); };
const no = (m) => { fail++; console.log('[X] ' + (TAG ? TAG + ' ' : '') + m); };
const chk = (cond, good, bad) => (cond ? ok(good) : no(bad));

const mn = require('./make-notes.js');
const imp = require('./import-slides.js');
const { pickDeck, listDecks, loadCourseware, deckBaseOf } = mn;            /* 用哪份课件 */
const { guessCourse, acronymOf, countIn, moveVerified } = imp; /* 认课 / 搬运 */

/* ---------- 找出第一个"有课件"的课程目录 ---------- */
const courseDirs = fs.existsSync(CW)
  ? fs.readdirSync(CW, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_待归档')
    .map((d) => path.join(CW, d.name)).sort()
  : [];
const withDeck = courseDirs.filter((d) => listDecks(d).length);
if (!withDeck.length) {
  console.log('[X] 课件目录里一个 *_文本.txt 都没有 —— 先跑：node import-slides.js');
  process.exit(1);
}
console.log('课件目录（' + withDeck.length + ' 门有课件）：' + withDeck.map((d) => path.basename(d)).join('、'));
console.log('');

/* 课程目录名以模块代码开头（<CODE> <Name>）→ 取出代码；取不到返回 ''（那条断言会失败并报出来） */
const courseCodeOf = (d) => (path.basename(d).match(/^[A-Z]{4}\d{4}M/) || [''])[0];
/* 某个 *_文本.txt 旁边的那份课件原件（与上面 decks 的配对口径同一套） */
const decksOf = (d, rel) => {
  const dd = path.dirname(path.join(d, rel)), b = deckBaseOf(rel);
  return fs.readdirSync(dd).find((x) => /\.(pdf|pptx|docx)$/i.test(x) && x.replace(/\.[^.]+$/, '') === b) || '';
};

/* ============ ① 产物结构（**遍历所有课程**）============
   课件可以在课程根目录，也可以在 <总课件>\ / <日期>\ 子文件夹里（2026-09-29 起）→ 这里与管线用
   **同一套递归口径**，否则课件全部嵌套时体检会误报「一份课件都没有」。

   ⚠ 2026-10-01 改：原来只体检「字母序第一门课」（withDeck[0]），另外两门课的
     「地图字段齐备 / 页数一致 / 讲号连续 / 每讲页范围 / 交叉核对 / .md 成文」全都没被断言 ——
     三门课里两门是盲区。现在**每门课都查一遍**（断言自动带 [课程名] 前缀，靠上面的 TAG）。

   代价与对策：**总分随课程数增长**（每门课恒定 11 条）→ 文档里不能再写死数字，
   统一改成「应全绿；项数随课程数增加」，`_verify-guide.js` 也改为核对这句口径。
   为了不让分数再随**数据**漂（某门课缺 课程地图.json 时断言会少 7 条），
   缺地图时用 ok() 占位补齐 —— 每门课**永远恰好 11 条**。 */
function checkCourseStructure(dir) {
  TAG = '[' + path.basename(dir) + ']';
  const deckRels = listDecks(dir);                  /* 相对 dir 的路径 */
  const txts = deckRels.map((f) => path.basename(f)).sort();
  const decks = deckRels.map((f) => {
    const dd = path.dirname(path.join(dir, f)), b = deckBaseOf(f);
    return fs.readdirSync(dd).find((x) => /\.(pdf|pptx|docx)$/i.test(x) && x.replace(/\.[^.]+$/, '') === b) || '';
  }).filter(Boolean);
  chk(decks.length > 0, '目录里有课件原件（' + decks.join('、') + '）', '目录里没有 pdf/pptx/docx 原件');
  chk(decks.length === txts.length,
    '每份课件都有对应的原件与 _文本.txt（' + decks.length + '/' + txts.length + '）',
    '有 _文本.txt 但旁边找不到原件：' + txts.join('、'));

  const txtRel = deckRels[0];                 /* 「排序第一份」——只给下面"按关键词选课件"那条断言用 */
  const base = deckBaseOf(txtRel);

  const mapPath = path.join(dir, '课程地图.json');
  let map = null;
  try { map = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch (e) { /* 下面统一报 */ }
  chk(!!map, '课程地图.json 可解析', '课程地图.json 读不出来或不是合法 JSON');

  /* ⚠ 比对主体必须是**共享地图所属的那份课件**，不能是「排序第一份」：
     共享地图只归「页数最多那份」（read-slides.js 的归属规则），而排序第一份完全可能是另一份课件。
     2026-10-03 实测踩过：新导入的 42 页周课件排在最前，共享地图归的却是 48 页那份 → 误报「页数不一致 42 vs 48」。
     一门课只要有 ≥2 份课件，拿第一份去比就必然踩（旧布局下课件都在课程根目录、顺序碰巧对上，所以一直没暴露）。 */
  const ownerRel = deckRels.find((f) => deckBaseOf(f) === (map && map.deck)) || deckRels[0];
  const ownerBase = deckBaseOf(ownerRel);
  const ownerDir = path.dirname(path.join(dir, ownerRel));
  const ownerPages = ownerBase + '_pages.json';
  chk(fs.existsSync(path.join(ownerDir, ownerPages)),
    '页清单在位：' + ownerPages + '（共享地图所属课件）', '缺少 ' + ownerPages);

  if (map) {
    chk(map.pages > 0 && map.chars > 0 && Array.isArray(map.lectures) && Array.isArray(map.toc),
      '课程地图字段齐备（' + map.pages + ' 页 / ' + map.chars + ' 字符 / ' + map.lectures.length + ' 讲）',
      '课程地图字段缺失');

    let pg = [];
    try { pg = JSON.parse(fs.readFileSync(path.join(ownerDir, ownerPages), 'utf8')); } catch (e) {}
    chk(pg.length === map.pages, '页清单页数与课程地图一致（' + pg.length + ' = ' + map.pages + '）',
      '页数不一致：页清单 ' + pg.length + ' vs 课程地图 ' + map.pages);

    /* 讲号连续 —— 但**从这份地图自己的第一个讲号算起**，不是硬性从 1 开始：
       共享地图只归属**一份**课件（页数最多那份 / 上次已归好的那份），按周发的课件自己是第 2、3… 讲时，
       它的地图里就只有 [2] —— 那不是缺口。真正的缺口是 [1,2,4] 这种中间断开。
       ⚠ 2026-10-09：原来硬从 1 数起，用户 10-06 导入 `week02` 后 DEMO1009M 立刻报「讲号有缺（缺 1 个）」，
         而那份地图本来就该只有第 2 讲（课件的「自己的地图」在 2026-10-06\ 里，是 [2] ✓）。 */
    const nos = map.lectures.map((l) => l.no);
    const nMin = nos.length ? Math.min.apply(null, nos) : 0;
    const nMax = nos.length ? Math.max.apply(null, nos) : 0;
    let gap = 0;
    for (let i = nMin; i <= nMax; i++) if (nos.indexOf(i) < 0) gap++;
    chk(gap === 0 && nos.length > 0, '讲号连续：' + nMin + '…' + nMax, '讲号有缺（缺 ' + gap + ' 个）');

    let bad = [];
    map.lectures.forEach((l, i) => {
      if (!(l.startPage > 0) || !(l.endPage >= l.startPage)) bad.push('第' + l.no + '讲页范围非法');
      if (i && l.startPage <= map.lectures[i - 1].endPage) bad.push('第' + l.no + '讲与上一讲重叠');
      if (!(l.slideTitles || []).length) bad.push('第' + l.no + '讲没有标题骨架');
    });
    chk(bad.length === 0, '每讲页范围合法、递增不重叠、都有标题骨架（共 ' +
      map.lectures.reduce((a, l) => a + l.slideTitles.length, 0) + ' 个标题）', bad.slice(0, 4).join('；'));

    /* 交叉核对只在「课件自带 Contents 页」时成立：单节课件/按周发的课件本来就没有 Contents，
       那不是缺陷（`read-slides.js` 的兜底就是「认不出扉页就整份＝一讲」）。
       所以这里**永远恰好出 1 条**断言：有 Contents → 要求条数 == 讲数；没有 → 明确说明跳过。
       ⚠ 别退回「无条件要求相等」，否则新增一份周课件就会误报（2026-10-01 实测踩过）。 */
    if (map.toc.length > 0) {
      chk(map.toc.length === map.lectures.length,
        '交叉核对：Contents 讲的条数 == 扉页找到的讲数（' + map.toc.length + '）',
        '交叉核对不过：Contents ' + map.toc.length + ' 条 vs 扉页 ' + map.lectures.length + ' 讲');
    } else {
      ok('交叉核对：这份课件没有 Contents 页 → 跳过条数核对（单节课件/按周发的课件属正常，' +
        map.lectures.length + ' 讲）');
    }

    const md = fs.readFileSync(path.join(dir, '课程地图.md'), 'utf8');
    const missing = map.lectures.filter((l) => l.name && md.indexOf(l.name.slice(0, 18)) < 0);
    /* 判据用**内容**而不是**字数**：
       ⚠ 2026-10-01 修正：原来卡 `md.length > 1000`（**字符数**），可中文 1 字符占 3 字节 ——
         DEMO1009M 单节课件的地图只有 880 字符 / 1592 字节，被误判成"没成文"；
         而且失败信息一律说"缺讲"，真正的原因（长度）根本看不出来。
         现在改查：① 开头确实是标题行 ② 每讲的名字都在 ③ **每讲的页码范围字符串**都在。
         短课件的地图短是正常的，只要该有的都在就算成文。 */
    const missRange = map.lectures.filter((l) => md.indexOf('p' + l.startPage + '–p' + l.endPage) < 0);
    const headOk = md.indexOf('# 课程地图') === 0;
    chk(headOk && missing.length === 0 && missRange.length === 0,
      '课程地图.md 成文（' + md.length + ' 字符 / ' + map.lectures.length + ' 讲都在，含页码范围）',
      '课程地图.md 有问题：' + (headOk ? '' : '开头不是标题行；')
        + (missing.length ? '缺讲 ' + missing.map((l) => l.no).join(',') + '；' : '')
        + (missRange.length ? '缺页码范围 ' + missRange.map((l) => l.no).join(',') : ''));

    /* --intro 是显式开关：开了就必须每讲都有导语并落进 md；没开就不该有（保持"纯机械"口径）。
       ⚠ 2026-10-01 改：原来 if/else 分别出 **2 条 / 1 条**断言 → **总分随"被体检的那门课有没有导语"漂**
         （给 Data Science 买完导语后总分 42→44，文档里写死的数字守不住）。
         现在合并成**永远恰好 1 条**，只如实报告。 */
    const withIntro = map.lectures.filter((l) => l.intro);
    const introInMd = withIntro.length ? md.indexOf(withIntro[0].intro.slice(0, 12)) >= 0 : true;
    if (map.introBy) {
      chk(withIntro.length === map.lectures.length && introInMd,
        '开了 --intro：' + map.lectures.length + ' 讲导语齐全并写进 md（' +
        (withIntro[0] ? withIntro[0].intro.slice(0, 18) + '…' : '') + '）',
        '--intro 有问题：导语只拿到 ' + withIntro.length + '/' + map.lectures.length + ' 讲' +
        (introInMd ? '' : '，且没写进 md'));
    } else {
      chk(withIntro.length === 0, '没开 --intro：课程地图保持纯机械（无模型内容）', '没开 --intro 却出现了导语');
    }
  }

  /* 缺 课程地图.json 也要补齐条数，别让总分随数据漂 */
  if (!map) {
    ['课程地图字段齐备', '页清单页数与课程地图一致', '讲号连续', '每讲页范围合法、递增不重叠',
      '交叉核对（Contents vs 扉页）', '课程地图.md 成文', '--intro 口径'].forEach((w) =>
      ok('跳过（这门课还没有 课程地图.json）：' + w));
  }
  TAG = '';
  return { deckRels: deckRels, txts: txts, decks: decks, map: map };
}

/* 每门课都过一遍（原来自动取第一门，是覆盖盲区） */
const perCourse = withDeck.map((d) => checkCourseStructure(d));
console.log('');

/* 第②节及其后仍以「第一门有课件的课」为对象（口径与以前一致，避免连带改动） */
const DIR = withDeck[0];
const st0 = perCourse[0];
const deckRels = st0.deckRels;
const txts = st0.txts;
let map = st0.map;
const txtRel = deckRels[0];                 /* 「排序第一份」——只给下面"按关键词选课件"那条断言用 */
const base = deckBaseOf(txtRel);

/* ============ ①b 不变量：每份课件的地图都至少有一讲 ============
   2026-09-29 真事故：DEMO1009M 的单节课件（week01-introduction，11 页、没有扉页）被识别成 **0 讲**，
   出笔记时就只能报「没定位到对应讲」。根因是讲边界只认「Lecture KRR-<n>」这一种写法。
   现在：多套扉页模式 + 「认不出扉页就整份当作一讲」。这条断言遍历所有课程目录，防止再犯。 */
const allCourses = fs.existsSync(CW)
  ? fs.readdirSync(CW, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_待归档').map((d) => path.join(CW, d.name))
  : [];
const zeroDeck = [], checkedDecks = [];
allCourses.forEach((cd) => {
  listDecks(cd).forEach((f) => {                       /* 递归：课件可能在 <日期>\ 子文件夹里 */
    const b = deckBaseOf(f);
    const deckDir = path.dirname(path.join(cd, f));
    const mp = path.join(deckDir, '课程地图-' + b + '.json');   /* 每份课件的地图就在它自己旁边 */
    checkedDecks.push(b + (path.relative(cd, deckDir) ? '[' + path.relative(cd, deckDir).replace(/\\/g, '/') + ']' : ''));
    if (!fs.existsSync(mp)) { zeroDeck.push(b + '（没有单独的地图）'); return; }
    try {
      const j = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (!Array.isArray(j.lectures) || !j.lectures.length) zeroDeck.push(b + '（0 讲）');
      else if (j.lectures.some((l) => !(l.startPage >= 1) || !(l.endPage >= l.startPage))) zeroDeck.push(b + '（页范围非法）');
    } catch (e) { zeroDeck.push(b + '（地图读不出来）'); }
  });
});
chk(zeroDeck.length === 0,
  '每份课件的地图都至少有一讲（共查 ' + checkedDecks.length + ' 份课件）',
  '这些课件的地图是空的/坏了——出笔记时会报「没定位到对应讲」：' + zeroDeck.join('；'));

/* ============ ② 多份课件时的选择规则 ============ */
const dks = listDecks(DIR);
chk(dks.length === txts.length && JSON.stringify(dks) === JSON.stringify(dks.slice().sort()),
  'listDecks 与目录一致且排序确定（' + dks.length + ' 份）', 'listDecks 结果不对');
const p0 = pickDeck(DIR, '');
chk(!!p0.file && p0.why.length > 0, '不带参数时能选出课件并说明理由：' + (p0.file || '') + '（' + p0.why + '）',
  '默认选择没给出理由');
const pHit = pickDeck(DIR, base.slice(0, 6).toLowerCase());
chk(pHit.file === txtRel, '带关键词时按关键词命中：' + base, '关键词没命中：' + JSON.stringify(pHit));
chk(pickDeck(DIR, 'zzz-不存在的课件').file === '', '关键词无匹配时返回空（不硬挑一份）', '关键词无匹配却仍挑了一份');
const cw = loadCourseware(DIR);
chk(cw && cw.pages.length > 0 && cw.lectures.length > 0 && cw.mapFrom,
  'loadCourseware 能加载（' + (cw ? cw.pages.length : 0) + ' 页 / ' + (cw ? cw.lectures.length : 0) + ' 讲，地图来自 ' + (cw ? cw.mapFrom : '?') + '）',
  'loadCourseware 加载失败');
chk(!!cw && cw.lectures.length === map.lectures.length,
  'loadCourseware 读到的讲结构与地图一致（' + (cw ? cw.lectures.length : 0) + ' 讲）——不会读到别份课件的地图',
  'loadCourseware 读到的讲数与地图对不上');

/* ---- 真隐患回归：单节课件绝不许顶掉整学期的共享地图 ----
   造一个临时课程目录：一份"整学期"（3 讲）+ 一份"单节课"（1 讲，名字排序在前）。 */
const HZ = path.join(ROOT, '_tmp-verify-hazard');
let hzOk = true, hzMsg = [];
try {
  fs.rmSync(HZ, { recursive: true, force: true });
  fs.mkdirSync(HZ, { recursive: true });
  const mkDeck = (base, nPages, nLec) => {
    const lines = [];
    for (let p = 1; p <= nPages; p++) lines.push('=== p' + p + ' ===');
    lines.length = 0;
    const body = [];
    for (let p = 1; p <= nPages; p++) {
      const isFace = p === 1 || (nLec > 1 && p === Math.floor(nPages / 2) + 1);
      body.push('=== p' + p + ' ===\n' + (isFace ? 'Lecture KRR-' + (p === 1 ? 1 : 2) + '\nFake Lecture Title\n— footer' : 'Slide Title ' + p + '\nbody text'));
    }
    fs.writeFileSync(path.join(HZ, base + '_文本.txt'), body.join('\n\n'), 'utf8');
    const idx = [];
    for (let p = 1; p <= nPages; p++) idx.push({ n: p, chars: 20, images: 0, title: 'Slide Title ' + p });
    fs.writeFileSync(path.join(HZ, base + '_pages.json'), JSON.stringify(idx), 'utf8');
  };
  mkDeck('A_Semester_2026_09_01', 40, 3);   /* 学期总课件：40 页 */
  mkDeck('B_Extra_2026_10_06', 6, 1);      /* 后加的单节课件：6 页，但名字排序在 A 之后 */
  /* ⚠ 沙箱下**不能**用管道捕获子进程输出（stdio 默认 'pipe' 会 EPERM/拒绝访问），
     所以用 stdio:'ignore'：我们只要退出码和落盘的文件，不要它的输出。 */
  const runRS = (args) => cp.spawnSync(process.execPath, [path.join(ROOT, 'read-slides.js'), HZ].concat(args || []),
    { stdio: 'ignore' });
  runRS([]);                                  /* 先建共享地图（A） */
  const shared1 = JSON.parse(fs.readFileSync(path.join(HZ, '课程地图.json'), 'utf8'));
  hzMsg.push('建库后共享地图 deck=' + shared1.deck);
  hzOk = hzOk && shared1.deck === 'A_Semester_2026_09_01';

  runRS(['--deck', 'B_Extra']);                /* 再处理单节课件——关键：不能顶掉共享地图 */
  const shared2 = JSON.parse(fs.readFileSync(path.join(HZ, '课程地图.json'), 'utf8'));
  hzMsg.push('处理单节课件后共享地图 deck=' + shared2.deck);
  hzOk = hzOk && shared2.deck === 'A_Semester_2026_09_01';
  hzOk = hzOk && fs.existsSync(path.join(HZ, '课程地图-B_Extra_2026_10_06.json'));

  /* 按上课日期自动选课件（老师常把单讲课件按日期命名） */
  const byDate = pickDeck(HZ, '', '2026-10-06');
  hzMsg.push('按日期 2026-10-06 选到=' + byDate.file);
  hzOk = hzOk && byDate.file === 'B_Extra_2026_10_06_文本.txt';
  /* 而且必须读「这份课件自己的」地图，不是共享那份 */
  const cwB = loadCourseware(HZ, 'B_Extra');
  hzMsg.push('B 的地图来自=' + (cwB ? cwB.mapFrom : '?') + '（' + (cwB ? cwB.lectures.length : 0) + ' 讲）');
  hzOk = hzOk && !!cwB && cwB.mapFrom === '课程地图-B_Extra_2026_10_06.json' && cwB.lectures.length === 1;

  /* 反例：明确 --primary 时，才允许把单节课件设成共享地图 */
  runRS(['--deck', 'B_Extra', '--primary']);
  const shared3 = JSON.parse(fs.readFileSync(path.join(HZ, '课程地图.json'), 'utf8'));
  hzMsg.push('--primary 后共享地图 deck=' + shared3.deck);
  hzOk = hzOk && shared3.deck === 'B_Extra_2026_10_06';

  chk(hzOk, '隐患回归：单节课件不会顶掉共享地图（' + hzMsg.join('；') + '）',
    '共享地图被单节课件顶掉了：' + hzMsg.join('；'));
} catch (e) {
  no('隐患回归测试自己出错了：' + (e && e.message ? e.message : e));
} finally {
  try { fs.rmSync(HZ, { recursive: true, force: true }); } catch (e) {}
}

/* ---- 日期子文件夹回归（2026-09-29 用户要求：单节课件按日期归类）----
   造一个临时课程目录：学期总课件放**课程根目录**，另一份单节课件放 **<日期>\ 子文件夹**，
   断言：两份都能被发现、能按关键词精确选中、子文件夹那份的地图写在**它自己目录**里、
   共享地图仍归根目录那份（不会被嵌套那份顶掉）。 */
const ND = path.join(ROOT, '_tmp-verify-nested');
let ndOk = true, ndMsg = [];
try {
  fs.rmSync(ND, { recursive: true, force: true });
  fs.mkdirSync(ND, { recursive: true });
  const mkDeckAt = (dir0, base, nPages, nLec) => {
    fs.mkdirSync(dir0, { recursive: true });
    const body = [];
    for (let p = 1; p <= nPages; p++) {
      const isFace = p === 1 || (nLec > 1 && p === Math.floor(nPages / 2) + 1);
      body.push('=== p' + p + ' ===\n' + (isFace ? 'Lecture KRR-' + (p === 1 ? 1 : 2) + '\nFake Lecture Title\n— footer' : 'Slide Title ' + p + '\nbody text'));
    }
    fs.writeFileSync(path.join(dir0, base + '_文本.txt'), body.join('\n\n'), 'utf8');
    const idx = [];
    for (let p = 1; p <= nPages; p++) idx.push({ n: p, chars: 20, images: 0, title: 'Slide Title ' + p });
    fs.writeFileSync(path.join(dir0, base + '_pages.json'), JSON.stringify(idx), 'utf8');
  };
  mkDeckAt(ND, 'Semester_Slides', 40, 3);              /* 总课件：课程根目录 */
  mkDeckAt(path.join(ND, '2026-10-06'), 'week05-deck', 6, 1); /* 单节课件：日期子文件夹里 */
  const decksNow = listDecks(ND);
  ndMsg.push('listDecks 找到 ' + decksNow.length + ' 份：' + decksNow.join(' | '));
  ndOk = ndOk && decksNow.length === 2 && decksNow.some((f) => f.indexOf('2026-10-06/') === 0);
  const byKey = pickDeck(ND, 'week05', '');
  ndMsg.push('--deck week05 → ' + byKey.file);
  ndOk = ndOk && byKey.file === '2026-10-06/week05-deck_文本.txt';
  const rsN = (args) => cp.spawnSync(process.execPath, [path.join(ROOT, 'read-slides.js'), ND].concat(args || []), { stdio: 'ignore' });
  /* ① 先给课程根目录那份（页数最多）建共享地图 */
  rsN(['--deck', 'Semester']);
  const sharedN = fs.existsSync(path.join(ND, '课程地图.json')) ? JSON.parse(fs.readFileSync(path.join(ND, '课程地图.json'), 'utf8')) : {};
  ndMsg.push('共享地图 deck=' + (sharedN.deck || '（无）'));
  ndOk = ndOk && sharedN.deck === 'Semester_Slides';
  /* ② 再给日期子文件夹里那份建自己的地图：必须写在**它自己目录**里，且不许动共享地图 */
  const r2 = rsN(['--deck', 'week05']);
  ndOk = ndOk && r2.status === 0
    && fs.existsSync(path.join(ND, '2026-10-06', '课程地图-week05-deck.json'))
    && fs.existsSync(path.join(ND, '2026-10-06', '课程地图-week05-deck.md'));
  ndMsg.push('嵌套地图写在 2026-10-06/ 里=' + fs.existsSync(path.join(ND, '2026-10-06', '课程地图-week05-deck.json')));
  const sharedN2 = JSON.parse(fs.readFileSync(path.join(ND, '课程地图.json'), 'utf8'));
  ndOk = ndOk && sharedN2.deck === 'Semester_Slides';
  /* ③ 出笔记时读到的必须是嵌套那份自己的地图（1 讲），而不是共享的 3 讲 */
  const cwN = loadCourseware(ND, 'week05');
  ndMsg.push('嵌套那份：' + (cwN ? cwN.lectures.length + ' 讲、地图来自 ' + cwN.mapFrom : '读不到'));
  ndOk = ndOk && !!cwN && cwN.lectures.length === 1 && cwN.mapFrom === '课程地图-week05-deck.json'
    && path.resolve(cwN.deckDir) === path.resolve(path.join(ND, '2026-10-06'));
  chk(ndOk, '日期子文件夹里的单节课件能被正确发现与配对（' + ndMsg.join('；') + '）',
    '嵌套课件处理不对：' + ndMsg.join('；'));
} catch (e) {
  no('日期子文件夹回归自己出错了：' + (e && e.message ? e.message : e));
} finally {
  try { fs.rmSync(ND, { recursive: true, force: true }); } catch (e) {}
}

/* ---- 通用扉页写法 + 「整份＝一讲」兜底（原来只认 Lecture KRR-<n>） ---- */
const GEN = path.join(ROOT, '_tmp-verify-generic');
try {
  fs.rmSync(GEN, { recursive: true, force: true });
  fs.mkdirSync(GEN, { recursive: true });
  const writeDeck = (base, pagesArr) => {
    const body = pagesArr.map((p, i) => '=== p' + (i + 1) + ' ===\n' + p);
    fs.writeFileSync(path.join(GEN, base + '_文本.txt'), body.join('\n\n'), 'utf8');
    fs.writeFileSync(path.join(GEN, base + '_pages.json'),
      JSON.stringify(pagesArr.map((p, i) => ({ n: i + 1, chars: p.length, images: 0, title: String(p).split('\n')[0] }))), 'utf8');
  };
  const runGEN = (deck) => cp.spawnSync(process.execPath,
    [path.join(ROOT, 'read-slides.js'), GEN].concat(deck ? ['--deck', deck] : []), { stdio: 'ignore' });

  /* ① 「Lecture 3」写法（没有模块代码） */
  writeDeck('D_Lecture3', ['Lecture 3\nPropositional Logic\nslide', 'body', 'body',
    'Lecture 4\nResolution\nslide', 'body']);
  runGEN('D_Lecture3');
  const g1 = JSON.parse(fs.readFileSync(path.join(GEN, '课程地图-D_Lecture3.json'), 'utf8'));
  chk(g1.lectures.length === 2 && g1.lectures[0].no === 3 && g1.lectures[1].no === 4,
    '通用扉页写法「Lecture 3 / Lecture 4」能认出（' + g1.lectures.map((l) => l.no + ':p' + l.startPage + '–p' + l.endPage).join('，') + '）',
    '「Lecture 3」这种写法没认出来：' + JSON.stringify(g1.lectures));

  /* ② 完全没有扉页的单节课件 → 整份当作一讲（目录里有两份，所以必须指定处理哪份） */
  writeDeck('E_NoFace', ['COMP9999M\nFancy Module Title\nSomeone', 'Learning objectives\nstuff',
    'Today aims\nstuff', 'Assessments\nstuff', 'body']);
  runGEN('E_NoFace');
  const g2 = JSON.parse(fs.readFileSync(path.join(GEN, '课程地图-E_NoFace.json'), 'utf8'));
  chk(g2.lectures.length === 1 && g2.lectures[0].whole === true &&
    g2.lectures[0].startPage === 1 && g2.lectures[0].endPage === 5,
    '没有扉页的单节课件 → 整份当作一讲（p1–p5，讲题「' + g2.lectures[0].name + '」）',
    '没有扉页时没兜住：' + JSON.stringify(g2.lectures));
  /* 而且 make-notes 那边能直接用它（一讲就走「课件只有一讲」分支，不再花调用判讲） */
  const cwE = loadCourseware(GEN, 'E_NoFace');
  chk(cwE && cwE.lectures.length === 1 && cwE.lectures[0].whole === true,
    'loadCourseware 能直接拿到这一讲（出笔记时不再报「没定位到对应讲」）',
    'loadCourseware 拿不到整份一讲');
} catch (e) {
  no('通用扉页测试自己出错了：' + (e && e.message ? e.message : e));
} finally {
  try { fs.rmSync(GEN, { recursive: true, force: true }); } catch (e) {}
}

/* ---- 课件归到哪一天：进度时间线（2026-10-09 用户报的 bug 的永久回归）----
   现场：`Week 3 EDA and Viz .pdf`（10-08 23:55 下载）被归到 2026-10-14，而它是 **2026-10-07** 那节的
   —— 老师文件名里的周号错了整整一周（课件自己第 71 页写着「Learning Resources: Week 2 EDA and Viz」，
   这门课第 1 份课件的 Module Delivery Plan 也是 `2 (5/10/26) Exploratory Data Analysis and Visualization`）。
   这里给纯函数 pickDeckDay 喂**合成数据**（不碰文件系统 → 断言不随数据漂），
   另外拿**真实课表**校 lecDaysOf / dayFromWeekNo（输入是 课程表.json，稳定）。 */
const { pickDeckDay: pdDay, lecDaysOf: lDaysOf, clockInName: ckClock } = imp;
const SL5122 = lDaysOf('DEMO1001M Data Science').days.map((x) => x.day);
const B5122 = { termStart: '2026-09-28', slotDays: SL5122 };
const busy = (list) => (d) => list.indexOf(d) < 0;

const rb1 = pdDay({ ...B5122, arriveDay: '2026-10-08', lastKnownDay: '2026-10-02',
  currentDirDay: '2026-10-14', labelDay: '2026-10-14', labelWeek: '3', isFree: busy(['2026-10-02']) });
chk(rb1.day === '2026-10-07' && /不采信/.test(String(rb1.warn)),
  '进度时间线：老师文件名周号错一周时能救回来（Week 3 的 EDA 课件 → ' + rb1.day + '，附 ⚠ 说明与 --date 补救）',
  '周号错一周救不回来：算出 ' + JSON.stringify(rb1.day) + '／warn=' + JSON.stringify(rb1.warn));

const rb2 = pdDay({ ...B5122, arriveDay: '2026-10-09', lastKnownDay: '2026-10-07',
  currentDirDay: '', labelDay: '2026-10-09', labelWeek: '2', isFree: busy(['2026-10-07']) });
chk(rb2.day === '2026-10-09' && !rb2.warn,
  '周号与到货时间吻合时仍按周号走（Week 2 的周五课件 → ' + rb2.day + '，无 ⚠）',
  '高置信档被破坏了：' + JSON.stringify(rb2.day) + '／warn=' + JSON.stringify(rb2.warn));

const rb3 = pdDay({ ...B5122, arriveDay: '2026-10-08', lastKnownDay: '2026-10-14',
  currentDirDay: '2026-10-07', labelDay: '2026-10-09', labelWeek: '2', isFree: busy(['2026-10-02', '2026-10-14']) });
chk(rb3.day === '2026-10-07' && /保持不动/.test(String(rb3.warn)),
  '重跑不漂移：已经在 <课程>\\2026-10-07\\ 里的课件再评估一次仍留在 ' + rb3.day,
  '已归好的课件被挪走了：' + JSON.stringify(rb3.day) + '／warn=' + JSON.stringify(rb3.warn));

const rb4 = pdDay({ ...B5122, arriveDay: '2026-10-08', lastKnownDay: '2026-10-09',
  currentDirDay: '', labelDay: '2026-10-14', labelWeek: '3',
  isFree: busy(['2026-10-02', '2026-10-07', '2026-10-09']) });
chk(rb4.day === '2026-10-14' && /请核对/.test(String(rb4.src)),
  '窗口里一个空位都没有时退回周号并提醒核对（→ ' + rb4.day + '）',
  '无空位时没退回周号：' + JSON.stringify(rb4.day) + '／src=' + JSON.stringify(rb4.src));

chk(SL5122.indexOf('2026-10-07') >= 0 && SL5122.indexOf('2026-10-09') >= 0
  && SL5122.indexOf('2026-10-14') >= 0 && SL5122.indexOf('2026-11-04') >= 0
  && !SL5122.some((d) => d >= '2026-10-26' && d <= '2026-10-30'),
  '讲座日按「课表 + 模块 weeks」展开（含 10-07/10-09/10-14，跳过阅读周 10-26~10-30，共 ' + SL5122.length + ' 个）',
  '讲座日展开不对：' + JSON.stringify(SL5122));

const s2cases = [['DEMO1007M Machine Learning', 'Week 1 Slides.pdf', '2027-01-25'],
  ['DEMO1008M Deep Learning', 'Week 1.pdf', '2027-01-26'],
  ['DEMO1002M Cloud Computing Systems', 'Lecture 3.pdf', '2027-02-09']];
const s2bad = s2cases.filter((c) => imp.dayFromWeekNo(c[0], c[1], '') !== c[2]);
chk(s2bad.length === 0,
  'S2 课件周号按「绝对教学周」换算（模块第 1 周 = 第 14 周 → ' + s2cases.map((c) => c[2]).join(' / ') + '）',
  'S2 周号算错（会被静悄悄退回"最近一份笔记的日期"）：' + JSON.stringify(s2bad));

chk(ckClock('录音_2026.10.7_15点至16点.m4a') === '15:00' && ckClock('录音_2026.10.7.m4a') === ''
  && ckClock('录音_2026.9.30_15.05.00.m4a') === '15:05',
  '录音文件名里的时刻解析（15点 → 15:00；纯日期文件名不会把 `.7` 误判成时刻）',
  '录音时刻解析错：' + [ckClock('录音_2026.10.7_15点至16点.m4a'), ckClock('录音_2026.10.7.m4a'), ckClock('录音_2026.9.30_15.05.00.m4a')].join('／'));

/* ---- 选哪一份课件：老师这节课接着讲上一节那份（2026-10-09 用户问出来的缺口）----
   场景：一节课没讲完、下节课继续用同一份课件 → 这门课**不会有**本节课的 <日期>\ 文件夹，
   旧的兜底是「页数最多」—— 那纯粹按页数排，跟"这节课用的是哪份"没关系，会拿错的课件去核对。
   这里用**跑测试时才生成的合成课件树**（内容由本文件写死 → 断言不随真实数据漂），
   关键是让「页数最大的那份」**不是**该选的那份，否则新旧逻辑分不出来。 */
const FXA = path.join(__dirname, '.tmp', '_fixture-deck');
const mkDeck = (root, sub, name, pages) => {
  const p = path.join(root, sub);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, name + '_文本.txt'), '=== p1 ===\n' + name + '\n', 'utf8');
  fs.writeFileSync(path.join(p, name + '_pages.json'), JSON.stringify(Array.from({ length: pages }, () => ({}))), 'utf8');
};
mkDeck(FXA, '2026-10-01', 'big60', 60);    /* 页数最多 —— 但它是更早那节的 */
mkDeck(FXA, '2026-10-02', 'mid42', 42);
mkDeck(FXA, '2026-10-07', 'carry20', 20);  /* 接着讲的就是这份（页数最小） */

const dHit = pickDeck(FXA, '', '2026-10-07');
chk(dHit.file === '2026-10-07/carry20_文本.txt' && dHit.src === 'date',
  '选课件：有本节课日期的文件夹时按日期命中（→ ' + dHit.file + '，src=' + dHit.src + '）',
  '日期命中坏了：' + JSON.stringify({ file: dHit.file, src: dHit.src }));

const dCarry = pickDeck(FXA, '', '2026-10-09');
chk(dCarry.file === '2026-10-07/carry20_文本.txt' && dCarry.src === 'carry'
  && /沿用最近一次课件/.test(String(dCarry.why)),
  '选课件：这节课没有新课件时**沿用最近一次那份**（10-09 → ' + dCarry.file + '），而不是页数最多的 big60',
  '按页数兜底把该选的换掉了：' + JSON.stringify({ file: dCarry.file, src: dCarry.src, why: dCarry.why }));

const dHint = pickDeck(FXA, 'mid', '2026-10-09');
chk(dHint.file === '2026-10-02/mid42_文本.txt' && dHint.src === 'hint',
  '选课件：--deck 关键词仍然优先于「沿用最近一次」', '--deck 被新档盖过了：' + JSON.stringify({ file: dHint.file, src: dHint.src }));

const FXB = path.join(__dirname, '.tmp', '_fixture-deck2');
mkDeck(FXB, '总课件', 'all299', 299);
mkDeck(FXB, '2026-10-01', 'w1', 30);
const dTot = pickDeck(FXB, '', '2026-10-09');
chk(dTot.file === '总课件/all299_文本.txt' && dTot.src === 'rank',
  '选课件：有整学期总课件时不启用「沿用」（总课件本来就每节都用，用哪几讲交给判讲那一档）',
  '总课件被「沿用」档盖掉了：' + JSON.stringify({ file: dTot.file, src: dTot.src }));

/* ---- 笔记模板：沿用上一节课件时，HTML 与 MD 都必须写明课件来源 ----
   （用合成数据直接调 renderHtml / toMarkdown —— 不花 API、不写真实数据。
    ⚠ 找「课件来源」必须去掉 <script>…</script>：内联脚本/数据块里也有这几个字。
    ⚠ 2026-10-09：模板里那份客户端「复制 Markdown」的 buildMd（shell.html）**不含课件核对一节**
    （顶栏那两个按钮早就撤掉了，那段是死代码），所以这里只验「可见正文渲染了」＋「内嵌数据带着 deckSrc」，
    别再断言客户端脚本里有 raw.handout.deckSrc —— 那永远为 false。） */
const HO0 = { deck: 'D', range: 'p1–p2', rows: [{ item: 'x', verdict: 'same', fromAudio: 'a', fromSlides: 'a', note: '' }], extra: [] };
const synth = (handout) => ({ course: 'X', title: 'T', keyPoints: [], bilingual: [], terms: [], qa: [], todos: [],
  notes: '## 正文\n内容\n', mindmap: '', handout: handout });
const CARRY = Object.assign({}, HO0, { basis: 'single', how: '课件只有一讲（没有扉页，整份课件）',
  deckSrc: 'carry', deckWhy: '沿用最近一次课件（日期文件夹「2026-10-07」）；这节课没有新课件' });
const DATEH = Object.assign({}, HO0, { basis: 'single', how: '课件只有一讲（没有扉页，整份课件）',
  deckSrc: 'date', deckWhy: '日期文件夹「2026-10-07」＝这节课的日期 20261007' });
const visOf = (s) => String(s).replace(/<script[\s\S]*?<\/script>/g, '');
const hCarry = mn.renderHtml(synth(CARRY), {}), hDate = mn.renderHtml(synth(DATEH), {});
chk(visOf(hCarry).includes('沿用最近一次课件') && !visOf(hDate).includes('课件来源')
  && /"deckSrc":"carry"/.test(hCarry),
  '笔记 HTML：沿用上一节课件时渲染「⚠ 课件来源：…」（可见正文），且内嵌数据里带着 deckSrc（日期命中时不渲染）',
  'HTML 的课件来源渲染不对：可见=' + visOf(hCarry).includes('课件来源') + '／内嵌 deckSrc=' + /"deckSrc":"carry"/.test(hCarry)
  + '／date=' + visOf(hDate).includes('课件来源'));
const mCarry = mn.toMarkdown(synth(CARRY)), mDate = mn.toMarkdown(synth(DATEH));
chk(/> ⚠ 课件来源：/.test(mCarry) && !mDate.includes('课件来源'),
  '笔记 MD（导出的 .md）同样写明课件来源',
  'MD 的课件来源渲染不对：carry=' + /> ⚠ 课件来源：/.test(mCarry) + '／date=' + mDate.includes('课件来源'));

/* ============ ③ 认课规则 ============ */
chk(acronymOf('Knowledge Repres. & Reasoning') === 'krr', '缩写生成：Knowledge Repres. & Reasoning → krr', '缩写生成错');
chk(acronymOf('Machine Learning') === '' && acronymOf('Data Science') === '',
  '只有两个实义词的模块名不生成缩写（避免 2 字母乱命中）', '两词模块名也生成了缩写');
chk(countIn('knowledge representation and reasoning', 'repres', true) === 1,
  '前缀匹配：repres 命中 Representation', '前缀匹配失效');

/* 真实课件认课：**逐份**核对（不是只看字母序第一份 —— 那是隐式依赖，新增课程就翻车）。
   2026-10-01 实测踩过：新增 DEMO1001M 后它排到了最前，于是这条断言拿 Data Science 的结果去比 KRR 的期望值。
   现在按「目录里有哪几份真实课件」逐份要求认对，新课加进来自动纳入体检。 */
for (const d of courseDirs) {
  const rel = listDecks(d)[0];
  if (!rel) continue;
  const txt = path.join(d, rel);
  const deckFile = decksOf(d, rel);
  const g = guessCourse(txt, deckFile);
  const want = courseCodeOf(d);
  chk(!!want && g.course.indexOf(want) === 0,
    '真实课件认课正确：' + g.course + '（' + g.tier + '层：' + g.why + '）',
    '真实课件认课错：' + d.replace(ROOT + path.sep, '') + ' → ' + JSON.stringify(g));
}

/* 合成件：代码层必须压过其它线索 */
fs.mkdirSync(TMP, { recursive: true });
const mk = (name, text) => { const p = path.join(TMP, name); fs.writeFileSync(p, text, 'utf8'); return p; };
const f1 = mk('a_文本.txt', 'DEMO1007M Machine Learning\nlecture notes about data mining and data science');
const g1 = guessCourse(f1, 'a.pdf');
chk(g1.course.indexOf('DEMO1007M') === 0 && g1.tier === '代码',
  '合成件：出现模块代码 → 代码层命中 ' + g1.course, '合成件代码层没命中：' + JSON.stringify(g1));

/* 合成件：只有零星的别课名 → 领先不够，必须"不认"（这是当初踩坑的反例） */
const f2 = mk('b_文本.txt', 'this slide mentions machine learning once\n' +
  'machine learning\ndeep learning\ndata science\nsoftware engineering\nprogramming');
const g2 = guessCourse(f2, 'b.pdf');
chk(g2.course === '', '合成件：线索分散且不领先 → 明确"认不出"（不硬猜）', '合成件冒险认成了：' + g2.course + '（' + g2.why + '）');

/* 合成件：名称关键词全命中且明显领先 → 关键词层命中 */
const f3 = mk('c_文本.txt', 'Blockchain Technologies blockchain technologies blockchain technologies\n' +
  'blockchain technologies blockchain technologies');
const g3 = guessCourse(f3, 'c.pdf');
chk(g3.course.indexOf('DEMO1003M') === 0, '合成件：关键词全命中且领先 → ' + g3.course + '（' + g3.tier + '层）',
  '合成件关键词层没命中：' + JSON.stringify(g3));

/* 合成件：什么都没有 → 认不出 */
const g4 = guessCourse(mk('d_文本.txt', 'weekly seminar notes with no module signals at all'), 'd.pdf');
chk(g4.course === '' && g4.tier === '无', '合成件：毫无线索 → tier=无（会进 课件\\_待归档\\）', '无线索却认出了课');

/* ============ ④ 搬运安全不变量 ============ */
const s1 = path.join(TMP, 'src1.bin'); fs.writeFileSync(s1, 'hello-课件');
const r1 = moveVerified(s1, path.join(TMP, 'dst'), 'src1.bin');
chk(!fs.existsSync(s1) && fs.existsSync(r1.dst) && fs.readFileSync(r1.dst, 'utf8') === 'hello-课件',
  '搬运：复制→校验一致→删源', '搬运过程不对：' + JSON.stringify(r1));
const s2 = path.join(TMP, 'src2.bin'); fs.writeFileSync(s2, '不同内容');
const r2 = moveVerified(s2, path.join(TMP, 'dst'), 'src1.bin');
chk(path.basename(r2.dst) === 'src1-2.bin' && fs.readFileSync(path.join(TMP, 'dst', 'src1.bin'), 'utf8') === 'hello-课件',
  '同名不同内容：绝不覆盖，新文件改名（src1-2.bin）', '同名不同内容时把原文件覆盖了');
const s3 = path.join(TMP, 'src3.bin'); fs.writeFileSync(s3, 'hello-课件');
const r3 = moveVerified(s3, path.join(TMP, 'dst'), 'src1.bin');
chk(!fs.existsSync(s3) && /去重/.test(r3.action), '同名同内容：算去重，删掉多余的源文件', '同名同内容没走去重');
/* 反例：源和目标同一个文件（重跑扫到 课件\_待归档\ 里的东西）——绝不能被"去重"删掉 */
const s4 = path.join(TMP, 'dst', 'same.bin'); fs.writeFileSync(s4, '别删我');
const r4 = moveVerified(s4, path.join(TMP, 'dst'), 'same.bin');
chk(fs.existsSync(s4) && fs.readFileSync(s4, 'utf8') === '别删我' && /原地/.test(r4.action),
  '源=目标同一文件：原地不动（不会把自己当"重复"删掉）', '源=目标时把文件删了！');

/* ============ ⑤ 双击就能看的 HTML（md-view.js 产物） ============ */
const views = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.html'));
chk(views.length > 0, '课件目录里有可直接打开的 HTML：' + views.join('、'), '课件目录里没有 .html（跑 node md-view.js "<目录>"）');
let viewBad = [], viewOk = 0;
views.forEach((f) => {
  const h = fs.readFileSync(path.join(DIR, f), 'utf8');
  const kb = Buffer.byteLength(h) / 1024;
  const probs = [];
  if (kb < 5) probs.push('只有 ' + kb.toFixed(1) + ' KB');
  if (/<script[^>]*\ssrc=/i.test(h)) probs.push('有外链 script');
  if (/<link\b/i.test(h)) probs.push('有 <link>（外部样式/字体）');
  /* 注意：正文里的 <a href="https://…"> 是**引用来源**，属于内容、必须保留；
     这里只挑真正的"资源级"外链（图片/样式/脚本/内联 CSS 的 url()）。 */
  if (/<img[^>]*\ssrc\s*=\s*"(?!data:)/i.test(h)) probs.push('有外部图片');
  if (/url\(\s*['"]?https?:/i.test(h)) probs.push('CSS 里有外部资源');
  /* 搜索框只要求 md-view.js 出的文档页（它带 mdview 标记）；
     像 近似课程-待核实.html 那种"入口页"本来就不该有搜索框。 */
  if (h.indexOf('mdview:theme') >= 0 && h.indexOf('id="q"') < 0) probs.push('没有搜索框');
  if (probs.length) viewBad.push(f + '：' + probs.join('、')); else viewOk++;
});
chk(viewBad.length === 0, 'HTML 离线自包含（' + viewOk + ' 份；文档页另带搜索框）', viewBad.join('；'));
if (map && views.indexOf('课程地图.html') >= 0) {
  const h = fs.readFileSync(path.join(DIR, '课程地图.html'), 'utf8');
  const miss = map.lectures.filter((l) => l.name && h.indexOf(l.name.slice(0, 18)) < 0);
  chk(miss.length === 0, '课程地图.html 里 18 讲都在（正文/标题可搜）', '课程地图.html 缺讲：' + miss.map((l) => l.no).join(','));
}
/* 近似课程对比.html 必须保住可点开的来源链接（md → html 转换别把链接吃掉）。
   ⚠ 2026-10-01 改：原来只看「被体检的那门课」（`views.indexOf(...)`），于是**数量随"哪门课排在最前"漂**
     —— 补上 DEMO1009M 的对比文档后总分从 42 变 43，文档里写死的数字立刻失守。
     现在**遍历所有课程**且**永远恰好 1 条断言**：一份都没有算通过（还没做 ≠ 坏），但要如实报出份数。 */
{
  const cmpHtmls = [];
  for (const d of courseDirs) {
    const cmpPath = path.join(d, '近似课程对比.html');
    if (!fs.existsSync(cmpPath)) continue;
    const links = (fs.readFileSync(cmpPath, 'utf8').match(/<a [^>]*href="https?:/g) || []).length;
    cmpHtmls.push({ name: path.basename(d), links: links });
  }
  const cmpBad = cmpHtmls.filter((x) => x.links < 5);
  chk(cmpBad.length === 0,
    '近似课程对比.html 保住了可点开的来源链接（' + cmpHtmls.length + ' 份' +
    (cmpHtmls.length ? '，最少 ' + Math.min.apply(null, cmpHtmls.map((x) => x.links)) + ' 个' : '') + '）',
    '这些课程的 近似课程对比.html 链接太少：' + cmpBad.map((x) => x.name + '(' + x.links + ')').join('、'));
}

/* ============ ⑥ 目录卫生 ============ */
const stray = fs.existsSync(INBOX)
  ? fs.readdirSync(INBOX, { withFileTypes: true }).filter((x) => x.isFile() && /\.(pdf|pptx|docx)$/i.test(x.name)).map((x) => x.name)
  : [];
chk(stray.length === 0, '录音\\ 顶层没有课件残留（课件应该都在 课件\\<课程>\\）', '录音\\ 里还有课件：' + stray.join('、'));
const pen = fs.existsSync(PENDING) ? fs.readdirSync(PENDING) : [];
chk(pen.length === 0, '课件\\_待归档\\ 里没有待处理文件', '课件\\_待归档\\ 里还有 ' + pen.length + ' 个文件：' + pen.slice(0, 5).join('、'));

/* 清理自测临时目录 */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { no('临时目录清理失败：' + TMP); }

/* ============ ⑦ 交付物完整性：每门课都该有「近似课程对比」（只报告，不计分） ============
   用户 2026-10-01 要求「以后所有新课都要有」。但**结论必须联网核实**（事实判断，要有可点开的来源），
   脚本做不到也不该假装做到 —— 所以这里只**如实列出还缺哪几门**，不产生红条。
   ⚠ 用 console.log 而不是 chk()：它不属于"回归"，属于"还没做的活儿"，不该把体检变成红的。 */
(function () {
  const lack = [];
  const all = fs.existsSync(CW) ? fs.readdirSync(CW, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_待归档') : [];
  for (const d of all) {
    const dir = path.join(CW, d.name);
    if (!listDecks(dir).length) continue;                       // 没课件的课程目录不算
    if (!fs.existsSync(path.join(dir, '近似课程对比.md'))) lack.push(d.name);
  }
  if (lack.length) {
    console.log('');
    console.log('· 待补交付物：这 ' + lack.length + ' 门课还没有「近似课程对比.md」——');
    lack.forEach((x) => console.log('    ' + x));
    console.log('  （要补就联网核实后写进 课件\\<课程>\\近似课程对比.md；下结论必须有可点开的来源）');
  }
})();

console.log('');
console.log('结论：' + pass + ' 项通过，' + fail + ' 项未通过');
process.exit(fail ? 1 : 0);

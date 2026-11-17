/*
 * read-slides.js —— 把课件提成「课程地图」（机械口径，零幻觉）
 *
 * 原则：能机械得到的绝不交给模型。
 *   · 每讲的边界 = 幻灯片里「Lecture KRR-<n>」扉页（PDF 自带）
 *   · 每讲的骨架 = 该页范围内每一页的首行（就是幻灯片标题）
 *   · 目录页原文（Contents）一并附上，用来**交叉核对**讲数与顺序
 * 模型只在需要「说人话」的地方出场（--intro 才调用，可选）。
 *
 * 用法：
 *   node read-slides.js "课件\DEMO1006M Knowledge Repres. & Reasoning"
 *   node read-slides.js "课件\..." --deck KRR      # 目录里有多份课件时，用名字含 KRR 的那一份
 *   node read-slides.js "课件\..." --intro        # 额外请模型给每讲写 1-2 句中文导语
 *
 * 产物：<课件目录>\课程地图.md（人看）+ 课程地图.json（后续逐讲互校要读）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const R = __dirname;
const argv = process.argv.slice(2);
const has = (k) => argv.indexOf(k) >= 0;
const valOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
const target = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--deck' && argv[i - 1] !== '--pages');
if (!target) { console.log('用法：node read-slides.js "课件\\<课程目录>" [--deck 关键词] [--intro]'); process.exit(10); }
const dir = path.isAbsolute(target) ? target : path.join(R, target);
if (!fs.existsSync(dir)) { console.log('[X] 找不到：' + dir); process.exit(10); }

/* ---- 选课件：一门课一个文件夹后，目录里可能有好几份 ----
 *
 * ⚠ 2026-09-29 修掉一个真实隐患：原来「目录里有多份课件」时，本次选中的那份会**无条件**写进
 * 共享的 课程地图.md/.json。于是老师后来发了一份**单节课课件**、恰好名字排序靠前，
 * 整学期的地图就被它顶掉了 —— 以后每次判讲都只剩那一讲，而且**不报错**。
 * 现在：
 *   ① 每份课件永远各自有一份 课程地图-<课件名>.md/.json/html（谁都不会丢）
 *   ② 共享的 课程地图.* 只留给「**页数最多**的那份」（＝整学期总课件）；本次选的不够大就不动它
 *   ③ 想强制把某份设为共享地图：加 --primary
 */
/* 课件可以放在课程根目录，也可以放在 <日期> 子文件夹里（2026-09-29 起：单节课件按日期归类）
   → 这里递归找，decks 里存**相对 dir 的路径**；每份课件的产物（_文本/_pages/自己的地图）都跟它同目录。 */
function listDecksRec(d0) {
  const out = [];
  const walk = (d, pre) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) { if (it.name !== '_待归档') walk(q, pre ? pre + '/' + it.name : it.name); }
      else if (it.name.endsWith('_文本.txt')) out.push(pre ? pre + '/' + it.name : it.name);
    });
  };
  walk(d0, '');
  return out.sort();
}
function dirOfDeck(f) { return path.join(dir, path.dirname(String(f))); }
function deckBase(f) { return path.basename(String(f)).replace(/_文本\.txt$/, ''); }
function deckPages(f) {
  const dd = dirOfDeck(f), b = deckBase(f);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dd, b + '_pages.json'), 'utf8'));
    if (Array.isArray(j) && j.length) return j.length;
  } catch (e) { /* 没有页清单就退回文本大小 */ }
  try { return Math.round(fs.statSync(path.join(dd, b + '_文本.txt')).size / 400); } catch (e) { return 0; }
}
const decks = listDecksRec(dir);
const deckHint = String(valOf('--deck') || '').toLowerCase();
const txtFile = deckHint ? decks.find((f) => f.toLowerCase().indexOf(deckHint) >= 0) : decks[0];
if (!txtFile) {
  if (!decks.length) { console.log('[X] 这个目录里没有 *_文本.txt —— 先跑：python slides-extract.py "课件\\<课程>"（或直接 node import-slides.js）'); process.exit(10); }
  console.log('[X] --deck「' + valOf('--deck') + '」没匹配到，现有：' + decks.map(deckBase).join('、'));
  process.exit(10);
}
const myBase = deckBase(txtFile);
const myDir = dirOfDeck(txtFile);          // 本次这份课件自己所在目录
/* 共享地图归谁：页数最多的那份（并列时取名称排序第一份，保证确定性） */
const ranked = decks.map((f) => ({ file: f, base: deckBase(f), n: deckPages(f) }))
  .sort((a, b) => (b.n - a.n) || a.base.localeCompare(b.base));
const primaryBase = ranked.length ? ranked[0].base : myBase;
const primaryDir = ranked.length ? dirOfDeck(ranked[0].file) : dir;
if (decks.length > 1) {
  console.log('· 目录里有 ' + decks.length + ' 份课件，本次处理「' + myBase + '」'
    + (deckHint ? '（--deck 指定）' : '（默认取名称排序第一份）'));
  console.log('  共享的 课程地图.* 归页数最多的「' + primaryBase + '」（' + (ranked[0] ? ranked[0].n : 0) + ' 页）；'
    + '每份课件还会各存一份 课程地图-<课件名>.*，互不影响');
}
const pagesFile = fs.existsSync(path.join(myDir, myBase + '_pages.json')) ? myBase + '_pages.json' : null;

const raw = fs.readFileSync(path.join(dir, txtFile), 'utf8');
const pages = [];
raw.split(/^=== p(\d+) ===$/m).forEach((chunk, i) => {
  if (i === 0) return;
  // 交替出现：奇数下标是页码，偶数下标是正文
});
const parts = raw.split(/=== p(\d+) ===/);
for (let i = 1; i < parts.length; i += 2) {
  pages.push({ n: Number(parts[i]), text: String(parts[i + 1] || '').trim() });
}
const index = pagesFile ? JSON.parse(fs.readFileSync(path.join(myDir, pagesFile), 'utf8')) : [];
const titleOf = (n) => {
  const it = index.find((x) => x.n === n);
  return it ? it.title : '';
};

/* ---- 每讲边界 ----
 * 原来只认「Lecture KRR-<n>」——那是 KRR 那份课件的写法。2026-09-29 老师发了一份
 * DEMO1009M 的单节课件（week01-introduction，11 页，根本没有扉页），结果识别出 **0 讲**，
 * 笔记流程就只能报「没定位到对应讲」。现在分三层：
 *   ① 扉页写法（多套模式）：Lecture <代码>-<n> / Lecture <n> / Week|Session|Unit|Chapter <n>（只在短页上认，避免正文里的 "Week 5 is reading week" 误判）
 *   ② 都认不出来时：**整份课件当作一讲**（单片课件本来就该这样），页范围 p1–pN
 *   ③ 讲题：优先扉页行；没有扉页就取首页里最像标题的一行，再不行用文件名
 */
const CODE_LINE = /^[A-Z]{2,6}\d{3,5}[A-Z]?$/;          /* DEMO1009M */
const NOISE_LINE = /^[\d\s.·•\-–—]+$|@|^https?:/i;      /* 页码、邮箱、网址 */

function titleLinesFrom(pageText) {
  const lines = String(pageText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const body = [];
  for (let i = 1; i < lines.length; i++) {   /* [0] 通常是页眉 */
    const s = lines[i];
    if (/^KR\s*∧?\s*R\b/.test(s) || /^[—–-]{2,}/.test(s)) break;   /* 页脚，停 */
    if (/^Lecture\b/i.test(s)) continue;                            /* 标记行本身不要 */
    body.push(s);
  }
  return body;
}
/* 首页没有扉页时，猜一个讲题：跳过模块代码行/邮箱/页码，取最像标题的一行 */
function guessTitleFromFirstPage() {
  const lines = String((pages[0] && pages[0].text) || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const s of lines) {
    if (CODE_LINE.test(s) || NOISE_LINE.test(s)) continue;
    if (s.length < 8 && !/\s/.test(s)) continue;      /* 人名、单词这种太短的跳过 */
    return s.replace(/\s+/g, ' ').slice(0, 90);
  }
  return '';
}

const bounds = [];
pages.forEach((p) => {
  let no = 0;
  let m = p.text.match(/Lecture\s+[A-Za-z]{2,6}\s*[-–]?\s*(\d{1,2})\b/i);   /* Lecture KRR-3 */
  if (m) no = Number(m[1]);
  if (!no) { m = p.text.match(/\bLecture\s+(\d{1,2})\b/i); if (m) no = Number(m[1]); }   /* Lecture 3 */
  if (!no && p.text.length <= 220) {                                        /* 只在短页（标题页）上认 */
    m = p.text.match(/^\s*(?:Week|Session|Unit|Chapter|Part|Topic)\s*(\d{1,2})\b/im);
    if (m) no = Number(m[1]);
  }
  if (!no) return;
  bounds.push({ no: no, page: p.n, name: titleLinesFrom(p.text).join(' ').replace(/\s+/g, ' ').slice(0, 90).trim() });
});
bounds.sort((a, b) => a.page - b.page);
/* 同一讲号出现多次（页眉重复）时只留第一次 */
const seenNo = {};
const boundsU = bounds.filter((b) => (seenNo[b.no] ? false : (seenNo[b.no] = true)));

/* 目录页（Contents）：机械抓「<数字>. <标题>」的行，用于交叉核对 */
const toc = [];
pages.slice(0, 6).forEach((p) => {
  p.text.split('\n').forEach((line) => {
    const m = line.match(/^\s*(\d{1,2})\.\s+(.{4,90}?)\s*(⇒|➔|->)?\s*$/);
    if (m) toc.push({ no: Number(m[1]), title: m[2].trim() });
  });
});

/* ---- 每讲的页范围 + 幻灯片标题骨架 ---- */
function buildLectures(bs) {
  return bs.map((b, i) => {
    const end = i + 1 < bs.length ? bs[i + 1].page - 1 : pages.length;
    const titles = [];
    pages.filter((p) => p.n > b.page && p.n <= end).forEach((p) => {
      const t = titleOf(p.n);
      if (t && !/^KR\s*∧?R\s*[—-]/.test(t) && titles.indexOf(t) < 0) titles.push(t);
    });
    return { no: b.no, startPage: b.page, endPage: end, pages: end - b.page + 1, name: b.name, slideTitles: titles };
  });
}
let wholeDeck = false;
let lectures = buildLectures(boundsU);
if (!lectures.length && pages.length) {
  /* ② 没有扉页 → 整份当作一讲（单片课件最常见的情形） */
  wholeDeck = true;
  const titles = [];
  pages.forEach((p) => {
    const t = titleOf(p.n);
    if (t && !/^KR\s*∧?\s*R\s*[—-]/.test(t) && titles.indexOf(t) < 0) titles.push(t);
  });
  lectures = [{
    no: 1, startPage: 1, endPage: pages.length, pages: pages.length,
    name: guessTitleFromFirstPage() || deckNameFallback(),
    slideTitles: titles, whole: true,
  }];
}
function deckNameFallback() { return txtFile.replace(/_文本\.txt$/, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim(); }

const supported = ['pdf', 'pptx', 'docx'];
/* 课件名＝文件基名（**不带文件夹**）：课件在 <日期>\ 子文件夹里时，
   名字里混进文件夹会写出 课程地图-2026-10-06/week05-deck.md 这种嵌套路径（实测直接 ENOENT）。 */
const deckName = myBase;

/* ---- 可选的「每讲一句话导语」--------------------------------------------------
   默认**关**：课程地图的定位是机械口径（讲边界 + 标题骨架），不掺模型输出。
   但只有标题和页码确实不好读，所以给一个显式开关：--intro 才花一次 API 调用，
   给每讲写 1-2 句中文导语（讲什么、和前后讲什么关系），写进 md 与 json 的 intro 字段。
   失败不影响机械部分：导语拿不到就照旧输出纯机械版。 */
const WANT_INTRO = has('--intro');
/* --intro 是"花钱买来的"内容，别因为一次不带参数的重跑就丢掉：没有 --intro 时，
   先看看已有的地图（同名课件那份 → 共享那份）里有没有导语，有就沿用。
   ⚠ 顺序很重要：**先看这份课件自己所在目录（myDir），再看课程根目录（dir）**。
     课件进了子文件夹（`<日期>\` / `总课件\`，2026-10-01 起）之后，它自己的地图是跟它在一起的；
     只看 dir 会找不到 → 重跑一次就把买来的导语丢了。
     （实测中招：DEMO1001M 的「Week 1 Data Quality」在 2026-09-30\ 里，而共享地图归的是**另一份**课件，
       于是 `课程地图.json` 那条 `j.deck !== deckName` 被跳过 → 导语全丢。） */
function carryOverIntro() {
  const dirs = myDir === dir ? [dir] : [myDir, dir];
  for (const d of dirs) {
    for (const f of ['课程地图-' + deckName + '.json', '课程地图.json']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        if (j.deck !== deckName || !Array.isArray(j.lectures)) continue;
        const map = {};
        j.lectures.forEach((l) => { if (l.intro) map[String(l.no)] = l.intro; });
        const n = Object.keys(map).length;
        if (!n) continue;
        lectures.forEach((l) => { if (!l.intro && map[String(l.no)]) l.intro = map[String(l.no)]; });
        console.log('· 沿用了 ' + (d === dir ? '' : path.basename(d) + '\\') + f + ' 里已有的 ' + n +
          ' 条导语（重新生成导语请加 --intro）');
        return true;
      } catch (e) { /* 没有就算了 */ }
    }
  }
  return false;
}
async function addIntro() {
  if (!WANT_INTRO) return false;
  const mn = require('./make-notes.js');
  const k = mn.loadApiKey();
  if (!k) { console.log('· --intro：没找到 DeepSeek API Key，跳过导语（机械部分照常输出）'); return false; }
  const ctx = lectures.map((l) => '[第 ' + l.no + ' 讲] ' + (l.name || '（无讲题）')
    + '　p' + l.startPage + '–p' + l.endPage + '\n  ' + (l.slideTitles || []).slice(0, 14).join('；')).join('\n');
  const messages = [
    {
      role: 'system',
      content: '你是利兹大学 EPS 学院的助教。给你一门课的课件结构（每讲的标题骨架），'
        + '请为每一讲写 1-2 句中文导语，说清：这一讲讲什么、关键概念是哪几个、与前后讲是什么关系。'
        + '只依据给定的标题信息，不要编造没出现的知识点，不要写"本讲将介绍"这类空话。'
        + '输出严格 JSON：{"intro":{"1":"…","2":"…"}}，键是讲号字符串，值是导语（每讲 30-60 个汉字）。',
    },
    { role: 'user', content: '课程：' + path.basename(dir) + '\n课件：' + deckName + '\n\n' + ctx },
  ];
  console.log('· --intro：请模型给 ' + lectures.length + ' 讲写导语（送 ' + ctx.length + ' 字符，1 次调用）…');
  const raw = await mn.callDeepSeek(k.key, messages, { json: true, max_tokens: 4000, temperature: 0.4 });
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { console.log('  ✗ 返回不是 JSON，跳过导语'); return false; }
  const map = (j && j.intro) || {};
  let n = 0;
  lectures.forEach((l) => {
    const t = String(map[String(l.no)] || '').trim();
    if (t) { l.intro = t; n++; }
  });
  console.log('  ✓ 拿到 ' + n + '/' + lectures.length + ' 讲导语（key 来源：' + k.from + '）');
  return n > 0;
}

/* 组装 + 落盘：放在 async 里，因为 --intro 要等一次 API 调用（顶层 await 会和 CommonJS 打架） */
(async function finish() {
  const got = await addIntro();
  if (!got) carryOverIntro();

  /* ---- 组装 Markdown ---- */
  const L = [];
  L.push('# 课程地图 · ' + path.basename(dir));
  L.push('');
  L.push('> 由 `read-slides.js` 从课件机械抽取（讲边界＝幻灯片扉页，骨架＝每页首行标题）'
    + (lectures.some((l) => l.intro) ? '；**每讲导语由模型生成**（已标注）' : '，**不含模型生成内容**') + '。');
  L.push('> 课件文件：`' + deckName + '`　共 ' + pages.length + ' 页，' + pages.reduce((a, p) => a + p.text.length, 0) + ' 字符。');
  if (wholeDeck) {
    L.push('>');
    L.push('> ⓘ **这份课件没有扉页（多半是单节课件），已按「整份＝一讲」处理**：p1–p' + pages.length
      + ' 全归第 1 讲，笔记流程可以直接拿它对账。');
  }
  L.push('');
  L.push('## 全课目录（课件自带 Contents 页，逐字抄录）');
  L.push('');
  if (toc.length) toc.forEach((t) => L.push(t.no + '. ' + t.title));
  else L.push('（这份课件前几页没有可机械识别的目录行）');
  L.push('');
  L.push('## 逐讲结构（' + lectures.length + ' 讲' + (wholeDeck ? '（整份＝一讲）' : '') + '）');
  L.push('');
  lectures.forEach((lec) => {
    L.push('### 第 ' + lec.no + ' 讲 · ' + (lec.name || '（扉页没写讲题）'));
    L.push('');
    if (lec.intro) { L.push('> ' + lec.intro + '　　<sub>（模型生成的导语，仅供参考）</sub>'); L.push(''); }
    L.push('- 页码范围：**p' + lec.startPage + '–p' + lec.endPage + '**（' + lec.pages + ' 页）'
      + (lec.whole ? '　← 没找到扉页，整份课件当作一讲' : ''));
    L.push('- 幻灯片标题骨架（' + lec.slideTitles.length + ' 个）：');
    lec.slideTitles.forEach((t, i) => L.push('  ' + (i + 1) + '. ' + t));
    L.push('');
  });
  L.push('---');
  L.push('');
  L.push('## 交叉核对（机械，供你判断抽取是否可信）');
  L.push('');
  L.push('- Contents 页列出的讲数：' + (toc.length || '（无）'));
  L.push('- 扉页实际找到的讲数：' + (wholeDeck ? '0 → 已按「整份课件＝一讲」处理' : lectures.length));
  L.push('- 缺号/乱序：' + (() => {
    const nos = lectures.map((x) => x.no);
    const miss = [];
    for (let i = 1; i <= Math.max.apply(null, nos.concat([0])); i++) if (nos.indexOf(i) < 0) miss.push(i);
    return miss.length ? ('缺 ' + miss.join(', ')) : '无（1…' + Math.max.apply(null, nos.concat([0])) + ' 连续）';
  })());

  /* ---- 落盘：每份课件一份自己的地图；共享的那份只给「页数最多」的课件 ----
     这样「后来发了一份单节课件」再也不会把整学期的地图顶掉。 */
  const payload = JSON.stringify({
    deck: deckName, pages: pages.length,
    chars: pages.reduce((a, p) => a + p.text.length, 0),
    introBy: lectures.some((l) => l.intro) ? 'model(--intro)' : null,
    toc: toc, lectures: lectures, generatedFrom: txtFile,
  }, null, 1);
  const mdText = L.join('\n');

  const mineMd = path.join(myDir, '课程地图-' + deckName + '.md');
  fs.writeFileSync(mineMd, mdText, 'utf8');
  fs.writeFileSync(path.join(myDir, '课程地图-' + deckName + '.json'), payload, 'utf8');

  const forced = has('--primary');
  const isPrimary = forced || deckName === primaryBase;
  let sharedMd = '';
  if (isPrimary) {
    /* 共享地图＝整学期总课件那份的地图 → 永远写在**课程根目录**（即使这份课件在日期子文件夹里） */
    sharedMd = path.join(dir, '课程地图.md');
    fs.writeFileSync(sharedMd, mdText, 'utf8');
    fs.writeFileSync(path.join(dir, '课程地图.json'), payload, 'utf8');
  } else {
    console.log('· 共享的 课程地图.* 保持「' + primaryBase + '」不动（本次这份只写了 课程地图-' + deckName + '.*）'
      + '；确实要顶掉它：加 --primary');
  }

  console.log('');
  console.log('== 课件结构 ==');
  console.log('  课件：' + deckName + '　' + pages.length + ' 页'
    + (path.relative(dir, myDir) ? '（在 ' + path.relative(dir, myDir).replace(/\\/g, '/') + '/ 里）' : '（课程根目录）'));
  console.log('  Contents 页列出 ' + toc.length + ' 讲；扉页找到 ' + lectures.length + ' 讲；支持格式 ' + supported.join('/'));
  console.log('');
  console.log('  讲号  页码范围      页数  讲题');
  lectures.forEach((l) => {
    console.log('  ' + String(l.no).padStart(3) + '   p' + String(l.startPage).padStart(3) + '–p' + String(l.endPage).padStart(3)
      + '   ' + String(l.pages).padStart(4) + '  ' + (l.name || '').slice(0, 46));
  });
  console.log('');
  console.log('产物：');
  console.log('  ' + mineMd + '　（这份课件的地图）');
  console.log('  ' + path.join(myDir, '课程地图-' + deckName + '.json'));
  if (sharedMd) console.log('  ' + sharedMd + '　（共享地图，本次已更新）');

  /* 顺手出一份「双击就能看」的 HTML（离线自包含、能搜索、能打印）——
     课件文件夹里原本只有 .md/.json，用户反馈"缺个能打开的软件"。 */
  const { convert } = require('./md-view.js');
  [mineMd, sharedMd].filter(Boolean).forEach((m) => {
    try {
      console.log('  ' + convert(m) + '　← 双击就能看（可搜索/可打印）');
    } catch (e) {
      console.log('  （' + path.basename(m) + ' 转 HTML 失败，不影响 md/json：' + (e && e.message ? e.message : e) + '）');
    }
  });
})();

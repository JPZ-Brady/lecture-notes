/*
 * sync-fsrs.js —— 把课堂笔记里的「术语」和「问答」转成学习台的词库分片
 *
 * 产物：..\English Learning\notes-cards.js
 *   学习台通过 <script src="notes-cards.js"></script> 加载，自动并入 FSRS 调度。
 *
 * 用法：
 *   node sync-fsrs.js            扫描 笔记\*.json 全量重建（幂等）
 *   node sync-fsrs.js --dry      只统计不写文件
 */
'use strict';
const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, '笔记');
const TARGET = path.join(__dirname, '..', 'English Learning', 'notes-cards.js');
// 排除清单：由 选卡.cmd（pick-cards.js）写入。**必须**在这里生效——
// 因为本脚本是全量重建，只靠 --no-sync 跳过一次的话，下次同步会把不想要的卡又加回来。
const EXCLUDE = path.join(__dirname, '不加入学习台.json');
const dry = process.argv.includes('--dry');

/* 卡片 key：选卡页与同步必须用同一套规则，否则勾了不生效 —— 所以导出给 pick-cards.js 复用 */
function termKey(en) { return String(en || '').trim().toLowerCase(); }
function qaKey(course, q) { return (String(course || '') + '|' + String(q || '')).slice(0, 120).toLowerCase(); }

function loadExclude() {
  try {
    const j = JSON.parse(fs.readFileSync(EXCLUDE, 'utf8'));
    return {
      terms: new Set((j.excludedTerms || []).map((x) => String(x).toLowerCase())),
      qa: new Set((j.excludedQa || []).map((x) => String(x).toLowerCase())),
    };
  } catch (e) {
    return { terms: new Set(), qa: new Set() };
  }
}

function shortCourse(s) {
  let t = String(s || '未命名课程').replace(/\s+/g, ' ').trim();
  t = t.replace(/^Leeds\s+/i, '');
  // 有分隔符时取最后一段（"Leeds Welcome Week · Academic English" → "Academic English"）
  const segs = t.split(/\s*[·|—-]\s*/).filter((x) => x.length >= 4);
  if (segs.length > 1) t = segs[segs.length - 1];
  return t.length > 22 ? t.slice(0, 22) + '…' : t;
}
// 把术语和例句做匹配：优先挑含该术语的课堂原句
function findExamples(term, bilingual, limit) {
  const needle = String(term).toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (!needle) return [];
  const out = [];
  for (const b of bilingual || []) {
    const en = String(b && b.en || '');
    if (!en) continue;
    const hay = en.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    if (hay.includes(needle)) {
      out.push({ e: en.trim(), z: String(b.zh || '').trim() });
      if (out.length >= (limit || 2)) break;
    }
  }
  return out;
}

function build() {
  if (!fs.existsSync(NOTES_DIR)) throw new Error('找不到笔记目录：' + NOTES_DIR);
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
/* 旧版本副本目录（_备份 / 重跑前-…）里的 .json 是**被新版取代的旧措辞**，不能当卡片来源：
   否则新版里删掉的术语会从旧副本悄悄溜回词库（2026-10-14 实测：旧迎新周笔记的 "MSc Project" 一直在词库里）。
   注意与 _verify-output.js 的口径一致：它只认 课程\日期\ 这种正式目录。 */
const isOldCopy = (rel) => rel.split('/').some((seg) => seg === '_备份' || /^重跑前/.test(seg));
const allFiles = listFilesDeep(NOTES_DIR, /\.json$/);
const files = allFiles.filter((f) => !isOldCopy(f)).map((f) => ({ f: f, t: fs.statSync(path.join(NOTES_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t); // 新的在前，重复时新版优先
const skippedOld = allFiles.length - files.length;

  const terms = new Map(); // en -> card
  const qas = new Map();
  const excl = loadExclude();   // 注意别叫 ex：下面 findExamples 的返回值也叫 ex（同名会撞 TDZ）
  let scanned = 0, termHits = 0, qaHits = 0, skippedTerm = 0, skippedQa = 0;
  /* 排除清单的 key 里含着「术语原文 / 问题原文」，所以**笔记一旦重新生成、措辞变了，老 key 就再也匹配不上**，
     用户取消过的卡会悄悄回到词库（2026-09-29 实测：DEMO1009M 重生成后 17 条问答排除里 15 条失效）。
     这里把「用上的 key」记下来，跑完对照清单报出失效条数 —— 静默等于骗人。 */
  const usedTermKeys = new Set(), usedQaKeys = new Set();

  for (const item of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, item.f), 'utf8')); } catch (e) { continue; }
    scanned++;
    const course = shortCourse(j.course || j.title);
    const cat = course;

    (j.terms || []).forEach((t) => {
      const en = String(t && t.en || '').trim();
      if (!en || en.length > 60) return;
      if (!/[A-Za-z]/.test(en)) return;
      const key = termKey(en);
      if (excl.terms.has(key)) { skippedTerm++; usedTermKeys.add(key); return; }   // 用户在选卡页里去掉的
      if (terms.has(key)) return;                 // 同名术语只留最新一节
      const zh = [t.zh, t.note].filter(Boolean).join(' ｜ ');
      // k = 排除清单用的 key；src = 来自哪份笔记（选卡页要按「本次这节课」筛选）
      const card = { k: key, src: item.f, c: '课堂笔记 · ' + cat, en: en, zh: zh || '（见笔记）' };
      const ex = findExamples(en, j.bilingual, 2);
      if (ex.length) card.ex = ex;
      terms.set(key, card);
      termHits++;
    });

    (j.qa || []).forEach((x, i) => {
      const q = String(x && x.q || '').trim();
      const a = String(x && x.a || '').trim();
      if (!q || !a) return;
      const key = qaKey(course, q);
      if (excl.qa.has(key)) { skippedQa++; usedQaKeys.add(key); return; }        // 用户在选卡页里去掉的
      if (qas.has(key)) return;
      qas.set(key, {
        k: key,
        src: item.f,
        t: 'qa',
        c: '课堂笔记问答 · ' + cat,
        en: '【' + cat + '】' + q.replace(/\s+/g, ' ').slice(0, 70),
        q: q,
        a: a,
        zh: a.slice(0, 60),
      });
      qaHits++;
    });
  }

  const termList = Array.from(terms.values());
  const qaList = Array.from(qas.values());
  const header = '/* 自动生成，请勿手改 —— 由 课堂笔记\\sync-fsrs.js 生成，' +
    new Date().toLocaleString('zh-CN') + '\n' +
    '   来源：' + scanned + ' 份笔记 ｜ 术语卡 ' + termList.length + ' 张 ｜ 问答卡 ' + qaList.length + ' 张 */\n';
  // 写进学习台前剥掉内部字段（k / src 只给选卡页用，不必污染词库）
  const strip = (o) => { const c = Object.assign({}, o); delete c.k; delete c.src; return c; };
  const body = 'window.DECK_PARTS = window.DECK_PARTS || {};\n' +
    'window.DECK_PARTS["90-lecture-terms"] = ' + JSON.stringify(termList.map(strip)) + ';\n' +
    'window.DECK_PARTS["91-lecture-qa"] = ' + JSON.stringify(qaList.map(strip)) + ';\n';

  return {
    header: header, body: body, scanned: scanned, terms: termList, qas: qaList,
    skippedTerm: skippedTerm, skippedQa: skippedQa,
    staleTerm: (excl.terms ? Array.from(excl.terms).filter((k) => !usedTermKeys.has(k)) : []),
    staleQa: (excl.qa ? Array.from(excl.qa).filter((k) => !usedQaKeys.has(k)) : []),
    skippedOld: skippedOld,
  };
}

function run(opts) {
  opts = opts || {};
  const r = build();
  const log = opts.quiet ? function () {} : console.log;
  log('扫描笔记        ：' + r.scanned + ' 份' + (r.skippedOld ? '（另有 ' + r.skippedOld + ' 份 _备份/重跑前 旧副本已跳过）' : ''));
  log('生成术语卡      ：' + r.terms.length + ' 张' + (r.terms.length ? '（示例：' + r.terms.slice(0, 3).map(function (x) { return x.en; }).join(' / ') + '）' : ''));
  log('生成问答卡      ：' + r.qas.length + ' 张');
  const withEx = r.terms.filter(function (x) { return x.ex && x.ex.length; }).length;
  log('含课堂原句例句  ：' + withEx + ' / ' + r.terms.length + ' 张术语卡');
  if (r.skippedTerm || r.skippedQa) {
    log('按你的选择排除  ：术语 ' + r.skippedTerm + ' 张、问答 ' + r.skippedQa + ' 张（清单：不加入学习台.json）');
  }
  if (r.staleTerm.length || r.staleQa.length) {
    log('⚠ 清单已失效    ：术语 ' + r.staleTerm.length + ' 条、问答 ' + r.staleQa.length + ' 条对不上任何卡片');
    log('   （多半是那份笔记重新生成后措辞变了——排除清单的 key 里含着原文；');
    log('    这些卡**已经回到词库**。想重新去掉就双击 选卡.cmd；示例：'
      + String((r.staleQa[0] || r.staleTerm[0] || '')).slice(0, 46) + '）');
  }
  if (opts.dry) { log('（--dry：未写入）'); return r; }
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, r.header + r.body, 'utf8');
  log('已写入学习台词库：' + TARGET + '（' + Math.round(fs.statSync(TARGET).size / 1024) + ' KB）');
  return r;
}

module.exports = {
  run: run, build: build, TARGET: TARGET, EXCLUDE: EXCLUDE,
  termKey: termKey, qaKey: qaKey, loadExclude: loadExclude, shortCourse: shortCourse,
};

if (require.main === module) {
  try {
    run({ dry: process.argv.includes('--dry') });
  } catch (e) {
    console.log('[X] 同步失败：' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

/*
 * rematch-excluded.js —— 修「排除清单失效」的工具（可复用）
 *
 * 为什么需要它：不加入学习台.json 的 key 里**嵌着问题/术语原文**（见 sync-fsrs.js 的 qaKey/termKey），
 * 所以**笔记一旦重新生成、措辞变了，老 key 就再也匹配不上** —— 用户取消过的卡会悄悄回到词库。
 * sync-fsrs.js 已经把「失效了几条」报出来（不静默），这个脚本负责**把它们接回去**。
 *
 * 用法：
 *   node rematch-excluded.js                 # 只分析：逐条列出失效项 + 同课程候选（按重叠度排序）
 *   node rematch-excluded.js --apply 1,3,5   # 按编号把选中的几条接到**第 1 候选**上
 *   node rematch-excluded.js --apply 7:2     # 第 7 条接到**第 2 候选**上（贪心 top-1 会错时用它）
 *   node rematch-excluded.js --apply-high    # 只接「重叠 ≥0.70」的高置信项（保守用法）
 *
 * 设计取舍（重要，别改成"全自动"）：
 *   字符串相似度**达不到语义级**。实测同一道题换个说法，重叠度能从 0.86 掉到 0.29
 *   （如「迟交会有什么后果？」→「迟交作业的惩罚是什么？」只有 0.29，但明明是同一题）。
 *   反过来也有假阳性（不加课程限制时，「迟交…」会匹到别的课的卡）。
 *   **更阴的坑（2026-10-01 实测）**：两条旧条目会**同时**贪心选中同一张新卡 ——
 *   旧「使用生成式 AI 的正确方式」和旧「对生成式 AI 的使用底线」，top-1 都是「可以使用生成式AI吗？」，
 *   其实该分别对应「讲师对使用生成式AI的核心建议」和「可以使用生成式AI吗」。
 *   **所以本工具只做机械排序与候选收敛，不替用户下判断** —— 应用哪些、接到第几个候选，都必须显式给。
 *
 * 安全：写清单前先备份成 不加入学习台.json.bak-重匹配前-<时间戳>；
 *       应用后立刻重跑一次同步，让词库当场生效。
 *
 * 2026-10-01：分析部分抽成导出的 `analyze()`，给**选卡页（pick-cards.js）**复用 ——
 *   页面里那份「已失效的排除项」面板就是拿它算的。CLI 行为与输出保持不变（同一套数值、同一套排序）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const sync = require('./sync-fsrs.js');
const EXCLUDE = sync.EXCLUDE;

const HIGH = 0.70, MID = 0.55;
const CAND_N = 3;                                   /* 每条失效项给几个候选 */

/* ---------- 文本相似度：同课程 + 重叠系数（对长短句比 Dice 公平） ---------- */
const stripPunct = (s) => String(s || '').toLowerCase()
  .replace(/[\s，。？！、：；「」『』（）()\[\]【】“”"'’‘·,.\-—?!:;~/\\]/g, '');
function grams(s) { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
function overlap(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}
const courseOf = (k) => { const i = String(k).indexOf('|'); return i >= 0 ? String(k).slice(0, i) : ''; };
const qOf = (k) => { const i = String(k).indexOf('|'); return i >= 0 ? String(k).slice(i + 1) : String(k); };

/* ---------- 分析（CLI 与选卡页共用）----------
   返回：
     scanned/nTerms/nQas   概况
     qaRows / termRows     失效项，每条带 top[N] = {c: 卡片, s: 重叠度}
     live                  仍然生效的排除项（key 能对上当前卡片），用于"放回" */
function analyze() {
  const r = sync.build();
  const qaRows = r.staleQa.map((key, idx) => {
    const course = courseOf(key), oldQ = qOf(key);
    const pool = r.qas.filter((c) => courseOf(c.k) === course);       /* ⚠ 只在本课程内找 */
    const top = pool.map((c) => ({ c: c, s: overlap(stripPunct(oldQ), stripPunct(c.q)) }))
      .sort((a, b) => b.s - a.s).slice(0, CAND_N);
    return { no: idx + 1, kind: 'qa', key: key, course: course, oldQ: oldQ, top: top };
  });
  const termRows = r.staleTerm.map((k, i) => ({
    no: i + 1, kind: 'term', key: k, oldQ: k, course: '',
    top: r.terms.map((c) => ({ c: c, s: overlap(stripPunct(k), stripPunct(c.en)) }))
      .sort((a, b) => b.s - a.s).slice(0, CAND_N),
  }));
  /* 仍然生效的：**别拿 r.terms/r.qas 去比对** —— 那两份是"已经剔除掉排除项之后"的卡片表
     （sync-fsrs 第 102/118 行命中排除就 `return` 了），拿它们求交集永远是 0（实测踩过）。
     正确口径是**补集**：清单里的 key 减去失效的那批。 */
  const raw = (() => { try { return JSON.parse(fs.readFileSync(EXCLUDE, 'utf8')); } catch (e) { return {}; } })();
  const staleTermSet = new Set((r.staleTerm || []).map((k) => String(k).toLowerCase()));
  const staleQaSet = new Set((r.staleQa || []).map((k) => String(k).toLowerCase()));
  const rawTerms = (raw.excludedTerms || []).map((k) => String(k));
  const rawQas = (raw.excludedQa || []).map((k) => String(k));
  const live = {
    /* 术语的 key 就是英文原词（termKey＝en 小写），直接拿来显示；找不到原始大小写也不影响读 */
    terms: rawTerms.filter((k) => !staleTermSet.has(k.toLowerCase()))
      .map((k) => ({ key: k, card: { en: k, zh: '' } })),
    /* 问答的 key 是「课程|问题」，问题原文完整保留在 key 里 */
    qas: rawQas.filter((k) => !staleQaSet.has(k.toLowerCase()))
      .map((k) => ({ key: k, card: { q: qOf(k), course: courseOf(k) } })),
  };
  return {
    scanned: r.scanned, nTerms: r.terms.length, nQas: r.qas.length,
    skippedTerm: r.skippedTerm, skippedQa: r.skippedQa,
    staleTerm: r.staleTerm, staleQa: r.staleQa,
    qaRows: qaRows, termRows: termRows, live: live,
  };
}

/* ---------- 应用（CLI 与选卡页共用）----------
   attach: { 旧key: 新key }   把某条失效项接到某张现存卡上
   drop:   [key]              直接删掉某条排除（卡片回到词库）
   返回 { ok, backup, attached, dropped }；写盘前一定先备份。 */
function applyChanges(attach, drop) {
  attach = attach || {}; drop = drop || [];
  const raw = fs.readFileSync(EXCLUDE, 'utf8');
  const j = JSON.parse(raw);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  /* 备份统一进 _备份\（本项目约定：根目录不留零散 .bak） */
  const bakDir = path.join(ROOT, '_备份');
  fs.mkdirSync(bakDir, { recursive: true });
  const bak = path.join(bakDir, path.basename(EXCLUDE) + '.bak-重匹配前-' + stamp);
  fs.writeFileSync(bak, raw, 'utf8');
  const norm = (k) => String(k).toLowerCase();
  const attachMap = new Map(Object.keys(attach).map((k) => [norm(k), attach[k]]));
  const dropSet = new Set(drop.map(norm));
  let attached = 0, dropped = 0;
  const fix = (arr) => {
    const out = [];
    for (const item of (arr || [])) {
      const k = norm(item);
      if (dropSet.has(k)) { dropped++; continue; }
      if (attachMap.has(k)) { out.push(String(attachMap.get(k)).toLowerCase()); attached++; continue; }
      out.push(String(item));
    }
    return Array.from(new Set(out)).sort();
  };
  j.excludedTerms = fix(j.excludedTerms);
  j.excludedQa = fix(j.excludedQa);
  j.updated = new Date().toLocaleString('zh-CN');
  fs.writeFileSync(EXCLUDE, JSON.stringify(j, null, 2), 'utf8');
  return { ok: true, backup: path.basename(bak), attached: attached, dropped: dropped };
}

module.exports = { analyze, applyChanges, overlap, stripPunct, grams, courseOf, qOf, HIGH, MID, EXCLUDE, ROOT };

/* ================= CLI（只在直接运行时执行）================= */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const valOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const APPLY = valOf('--apply');
  const APPLY_HIGH = argv.includes('--apply-high');
  const DROP_QA = valOf('--drop-qa');
  const DROP_TERMS = valOf('--drop-terms');

  const A = analyze();
  console.log('扫描笔记：' + A.scanned + ' 份｜当前术语卡 ' + A.nTerms + ' 张｜问答卡 ' + A.nQas + ' 张');
  console.log('失效的排除项：术语 ' + A.staleTerm.length + ' 条、问答 ' + A.staleQa.length + ' 条');

  if (!A.staleQa.length && !A.staleTerm.length) {
    console.log('\n[√] 清单没有失效项，不需要修。');
    process.exit(0);
  }

  const rows = A.qaRows;
  console.log('\n================= 失效的问答排除项（同课程候选，按重叠度排序）=================');
  for (const x of rows) {
    const best = x.top[0];
    const tag = !best ? '【无候选】' : (best.s >= HIGH ? '【高置信】' : (best.s >= MID ? '【需确认】' : '【太弱】'));
    console.log('\n' + String(x.no).padStart(2) + '. ' + tag + ' 旧：' + x.oldQ);
    console.log('    课程：' + JSON.stringify(x.course) + '｜同课程候选 ' + x.top.length + ' 个');
    x.top.forEach((t) => console.log('        ' + t.s.toFixed(3) + '  ' + t.c.q));
  }

  if (A.staleTerm.length) {
    console.log('\n================= 失效的术语排除项 =================');
    A.termRows.forEach((x, i) => {
      console.log('  ' + (i + 1) + '. ' + JSON.stringify(x.key) + '  →  ' +
        (x.top.length ? x.top.map((y) => y.s.toFixed(2) + ' ' + y.c.en).join(' ｜ ') : '（无候选）'));
    });
  }

  /* ---------- 应用 ---------- */
  /* 语法：--apply "1,3,5" 或 "7:2"（第 7 条接到第 2 候选，1-based） */
  let picks = [];
  if (APPLY_HIGH) picks = rows.filter((x) => x.top[0] && x.top[0].s >= HIGH).map((x) => x.no);
  if (APPLY) picks = APPLY.split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
    const parts = spec.split(':');
    return { no: parseInt(parts[0], 10), cand: parts[1] ? parseInt(parts[1], 10) : 1 };
  });

  /* 卡片已经不在了（笔记重新生成后换了措辞、或这条早已删掉）→ 直接清掉这条排除项 */
  const numList = (s) => String(s || '').split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0);
  const dropKeys = [];
  numList(DROP_QA).forEach((n) => {
    const r = rows.find((x) => x.no === n);
    if (!r) { console.log('[!] --drop-qa 里没有第 ' + n + ' 条'); return; }
    dropKeys.push(r.key);
    console.log('  ⊘ 清掉问答排除：' + r.oldQ);
  });
  numList(DROP_TERMS).forEach((n) => {
    const r = A.termRows[n - 1];
    if (!r) { console.log('[!] --drop-terms 里没有第 ' + n + ' 条'); return; }
    dropKeys.push(r.key);
    console.log('  ⊘ 清掉术语排除：' + JSON.stringify(r.key));
  });

  if (!picks.length && !dropKeys.length) {
    console.log('\n（只分析。要接回去就显式给编号，例：node rematch-excluded.js --apply 1,3,5）');
    console.log('（卡片已经不在了就 --drop-qa 2,4 / --drop-terms 1；也可以在选卡页 选卡.cmd 里点着改）');
    process.exit(0);
  }

  const picked = picks.map((p) => {
    const row = rows.find((x) => x.no === p.no);
    if (!row) return null;
    return { row: row, cand: row.top[(p.cand || 1) - 1] };
  }).filter(Boolean);
  const noCand = picked.filter((x) => !x.cand);
  if (noCand.length) {
    console.log('\n[X] 这些编号没有对应候选，无法接回：' + noCand.map((x) => x.row.no).join(','));
    process.exit(1);
  }

  const attach = {};
  picked.forEach((x) => { attach[x.row.key] = x.cand.c.k; });
  const res = applyChanges(attach, dropKeys);
  console.log('\n[√] 已备份原清单：' + res.backup);
  if (picked.length) {
    console.log('[√] 接回 ' + picked.length + ' 条：');
    picked.forEach((x) => console.log('    ' + x.row.oldQ + '\n          →  ' + x.cand.c.q + '   (重叠 ' + x.cand.s.toFixed(2) + ')'));
  }
  if (dropKeys.length) console.log('[√] 清掉 ' + dropKeys.length + ' 条已经没有对应卡片的排除项');
  console.log('\n旧 key 已移除；新 key 已写入。现在重跑同步让词库生效…\n');
  try {
    const r2 = cp.spawnSync(process.execPath, [path.join(ROOT, 'sync-fsrs.js')], { cwd: ROOT, stdio: 'inherit' });
    if (r2.status !== 0) console.log('[!] 同步退出码 ' + r2.status + '，请手动跑 node sync-fsrs.js 查看');
  } catch (e) {
    console.log('[!] 同步没跑起来：' + (e && e.message ? e.message : e) + '；请手动跑 node sync-fsrs.js');
  }
}

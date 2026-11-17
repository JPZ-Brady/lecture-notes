/*
 * import-slides.js —— 课件「自动归位 + 建图」一条龙（用户第 4 条诉求）
 *
 * 背景：课件原来随手放在 录音\ 里，产物（_文本.txt / _pages.json / 课程地图）也跟着散在各处。
 * 这个脚本把「老师给的一份新课件」自动放到 课件\<课程名>\ 下，并就地生成课程地图，
 * 目标是**以后每门课各自一个文件夹**，和 录音稿\ / 笔记\ 的归法一致。
 *
 * 认课依据（客观、可核对，不靠模型）：
 *   ① 课件正文里出现的**模块代码**（如 DEMO1006M）——直接对上 课程表.json 的 modules
 *   ② 模块名（去掉空格/标点后比对），以及课表里带名字的场次名
 *   ③ 都没有 → 问你一句（有 TTY 时）；无人值守时落到 课件\_待归档\，绝不猜着乱放
 *
 * 安全约定：**先复制、逐字节比对、一致才删源文件**；目标同名文件已存在且内容相同＝只算去重；
 *          内容不同＝两个都留（新文件加 -2 后缀）并告警，绝不覆盖。
 *
 * 用法：
 *   node import-slides.js                  # 扫 录音\（顶层）与 课件\_待归档\ 里的 pdf/pptx/docx
 *   node import-slides.js --dry            # 只报告会怎么归位，不动文件
 *   node import-slides.js "D:\某处\xx.pdf"  # 指定某一（几）份
 *   node import-slides.js --course DEMO1006M "D:\某处\xx.pdf"   # 手工指定课程
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const ROOT = __dirname;
const CW_ROOT = path.join(ROOT, '课件');
const INBOX = path.join(ROOT, '录音');
const PENDING = path.join(CW_ROOT, '_待归档');
const DECK_EXT = ['.pdf', '.pptx', '.docx'];

/* 「整学期总课件」的页数下限。
   ⚠ 2026-10-01 用户要求从 40 提高：「那个就是周课件而不是总课件，总课件肯定是大几百页起步的，不可能这么少」。
   实测本机：真·总课件 KRR = 299 页 / 18 讲；周课件只有 48 / 42 / 11 页 → 200 能干净分开。
   要再调就改这一个数（_verify-slides.js 的合成用例直接引用它，不会漂）。 */
const MIN_TOTAL_PAGES = 200;

/* 文件名看起来像「单周 / 单讲」吗？（总课件是整学期一份，不会在名字里标周次）
   实测命中：Week1_What is Data Science / Week 1 Data Quality / week01-introduction(1) - Tagged；
   实测不命中（＝真总课件）：KRR_MSc_Slides_2026_09_28。
   想覆盖这个判断：加 --total 强制当总课件。 */
function looksLikeSingleDeck(n) {
  /* ⚠ 末尾不能用 `\b`：下划线在正则里**算单词字符**，`Week1_What` 的 `1_` 之间没有边界 → 会漏判。
     改用「后面不再跟数字」的负向先行断言。 */
  return /\b(?:week|lecture|lec|unit|session|topic|chapter|part)\s*[-_ ]?\s*\d{1,2}(?!\d)/i.test(String(n || ''));
}

const argv = process.argv.slice(2);
const has = (k) => argv.indexOf(k) >= 0;
const valOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
const DRY = has('--dry');
const FORCE = valOf('--course');
const given = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--course' && argv[i - 1] !== '--slides');

/* ---------------- 课表 ---------------- */
function loadTimetable() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, '课程表.json'), 'utf8'));
    return Array.isArray(j.modules) ? j.modules : [];
  } catch (e) { return []; }
}
const MODULES = loadTimetable();
const label = (m) => String((m.code ? m.code + ' ' : '') + (m.name || '')).trim();
const norm = (x) => String(x || '').toLowerCase().replace(/[\s.&,;:()\-_/]+/g, '');

/* ---------------- 「Week N」→ 真实上课日期 ---------------- */

/* 课表原始对象：`loadTimetable()` 只给 modules，这里还要 termStart / slots / weekEpoch */
function loadTimetableRaw() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, '课程表.json'), 'utf8')); } catch (e) { return {}; }
}

/* 星期几 → 距周一的天数（Mon=0 … Sun=6） */
const DOW_OFFSET = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/* 周次区间判断（"1-4, 6-11" / "even" / "odd"）——与 make-notes.js 的 weeksMatch 同口径，
   这里自带一份以免 import-slides 反向依赖 make-notes（那个文件很大、且有自己的启动副作用） */
function weeksMatchLocal(range, n) {
  const s = String(range || '').trim();
  if (!s) return true;
  if (/^even$/i.test(s)) return n % 2 === 0;
  if (/^odd$/i.test(s)) return n % 2 === 1;
  return s.split(',').some((part) => {
    const t = part.trim();
    const r = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (r) return n >= +r[1] && n <= +r[2];
    const one = t.match(/^(\d+)$/);
    return one ? n === +one[1] : false;
  });
}

/* 这个日期文件夹里**已经放了别的课件**吗？（同一周有多个讲座时，用来错开）
   ⚠ 判据是"别的课件"：要排除**自己**（重跑整理时，自己已经在这个文件夹里，不能被算成"被占用"）。 */
function dayHasOtherDeck(courseDir, day, myBase) {
  const d = path.join(courseDir, day);
  try {
    return fs.readdirSync(d).some((f) => f.endsWith('_文本.txt') && f.slice(0, -'_文本.txt'.length) !== myBase);
  } catch (e) { return false; }
}

/* ---------------- 「这份课件是哪一节课的」（进度时间线）----------------
   ⚠ 2026-10-09 用户报的 bug：`Week 3 EDA and Viz .pdf`（10-08 23:55 下载）被归到 **2026-10-14**，
     而它是 **2026-10-07（第 2 周周三）** 那节课的 —— 老师文件名里的周号**错了整整一周**：
       · 课件自己第 71 页写着「Learning Resources: **Week 2** EDA and Viz」
       · 这门课第 1 份课件的「Module Delivery Plan」写着 `2 (5/10/26) Exploratory Data Analysis and Visualization`
       · 课表：DEMO1001M 周三 15:00 ＋ 周五 12:00，第 2 周 ＝ 10-05~10-09
     旧逻辑**只信文件名里的周号**，于是算到第 3 周周三 —— 一个还没发生的日子。

   所以主判据改成「**进度时间线**」：把课表上这个模块的讲座日按顺序排开，找**第一个还没有课件**的日子；
   文件名里的周号只有在**跟到货时间吻合**时才采信。为什么能这样卡：老师承诺"至少提前 48 小时"放出，
   而**本机实测三份课件全是课后当晚下载的** ——
     · `Week1_What is Data Science.pdf` 09-30 23:46 → 09-30（当天那节）
     · `Week 1 Data Quality.pdf`       10-02 23:59 → 10-02（当天那节）
     · `Week 3 EDA and Viz .pdf`       10-08 23:55 → **10-07**（老师周号错一周时救回来）
   → 到货日之后 LEAD_DAYS 天以外的讲座日，不可能是它要上/刚上过的那节。

   窗口：下界 from = max(开学日, 到货日 − LOOKBACK_DAYS 天, min(已归档的最新讲座日, 课件当前所在的日期文件夹))
         上界 to   = 到货日 + LEAD_DAYS
     · 下界把 **currentDirDay** 一起取 min，是为了**重跑不漂移**：一份已经归到 10-07 的课件，
       哪怕别的课件已经做到 10-14，重跑时下界仍锚在 10-07，不会被挪到后面去。
     · lastKnown 必须**排除自己所在的那个日期文件夹**，否则错归的课件会把自己锚在错的日子上。
   返回 { day, src, warn, timeline, label, win, from, to }；算不出时 day=''，交调用方回退。 */

const LEAD_DAYS = 4;       /* 到货日之后几天内的讲座日才可能是它的（老师承诺提前 48h，实测都是当晚下载） */
const LOOKBACK_DAYS = 10;  /* 到货日之前最多回看几天（防熬夜跨天/时区把下界卡死） */
const AUDIO_EXT = ['.m4a', '.mp3', '.wav', '.aac', '.m4b', '.flac', '.opus', '.wma', '.ogg'];
const DATE_DIR_RE = /^(\d{4}-\d{2}-\d{2})$/;
const WEEKNUM_RE = /\b(?:week|lecture|lec|unit|session|topic|chapter|part)\s*[-_ ]?\s*(\d{1,2})(?!\d)/i;

/* 'YYYY-MM-DD' ± n 天（锚到中午，避开夏令时把日期挪走） */
function shiftDay(day, n) {
  const d = new Date(String(day) + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/* 本地时区的 Date → 'YYYY-MM-DD' */
function localDay(dt) {
  const p = (x) => String(x).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

/* 这个模块**在课表上的讲座日**，按"模块第几周"展开成具体日期（同一天有多个时段只留第一个）。
   时段口径与 dayFromWeekNo 一致：优先有名字的 LEC → 有名字的任意时段 → noName 兜底。
   ⚠ 周次过滤用**绝对教学周号**（S1 baseWeek=1、S2 baseWeek=14），理由见 dayFromWeekNo 里的注释。 */
function lecDaysOf(courseDirName) {
  const code = (String(courseDirName || '').match(/^[A-Z]{4}\d{4}M/) || [''])[0];
  if (!code) return { code: '', sem: '', termStart: '', days: [] };
  const tt = loadTimetableRaw();
  const mod = (tt.modules || []).find((x) => String(x.code).toUpperCase() === code);
  const sem = String((mod && mod.sem) || '1');
  const epoch = (tt.weekEpoch || {})[sem];
  const epochAuthoritative = !!(epoch && epoch.from);
  const teach = (tt.teaching || {})[sem];
  const termStart = (epoch && epoch.from) || (Array.isArray(teach) && teach[0]) || (sem === '1' ? tt.termStart : '');
  const slots = (tt.slots || []).filter((s) => String(s.code).toUpperCase() === code
    && String(s.sem) === sem && DOW_OFFSET[s.day] !== undefined);
  if (!termStart || !slots.length) return { code, sem, termStart: termStart || '', days: [] };
  const named = slots.filter((s) => !s.noName);
  const lec = named.filter((s) => /LEC/i.test(s.act || ''));
  const pool = (lec.length ? lec : (named.length ? named : slots)).slice()
    .sort((a, b) => (DOW_OFFSET[a.day] - DOW_OFFSET[b.day]) || String(a.start).localeCompare(String(b.start)));
  const baseWeek = (epoch && epoch.week) ? Number(epoch.week) : 1;
  const inWin = (day) => {
    if (!Array.isArray(teach) || teach.length < 2) return true;
    const t = new Date(day + 'T12:00:00').getTime();
    return t >= new Date(teach[0] + 'T00:00:00').getTime() && t <= new Date(teach[1] + 'T23:59:59').getTime();
  };
  const days = [], seen = new Set();
  for (let w = 1; w <= 30; w++) {                     /* 一学期最多 30 周，够覆盖到教学窗口结束 */
    const abs = baseWeek + (w - 1);
    for (const s of pool) {
      if (epochAuthoritative && !weeksMatchLocal(String(s.weeks || ''), abs)) continue;
      const day = shiftDay(termStart, (w - 1) * 7 + DOW_OFFSET[s.day]);
      if (!day || !inWin(day) || seen.has(day)) continue;
      seen.add(day);
      days.push({ day, dow: DOW_OFFSET[s.day], start: s.start || '', end: s.end || '', week: w, act: s.act || '' });
    }
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { code, sem, termStart, days };
}

/* 这门课**已经归档到**的讲座日（笔记 / 音频 / 录音稿 / 已处理录音 / 课件 的日期文件夹，外加笔记文件名里的日期）。
   skipDay 用来排除"这份课件自己现在所在的那个日期文件夹"，否则错归的课件会把自己锚在错的日子上。 */
function knownLectureDays(courseDirName, skipDay) {
  const out = [];
  const push = (day) => { if (day && day !== skipDay) out.push(day); };
  const roots = [
    [path.join(ROOT, '笔记', courseDirName), true],
    [path.join(ROOT, '音频', courseDirName), false],
    [path.join(ROOT, '录音稿', courseDirName), false],
    [path.join(ROOT, '录音', '已处理', courseDirName), false],
    [path.join(CW_ROOT, courseDirName), false],
  ];
  for (const [r, scanFiles] of roots) {
    let ents = [];
    try { ents = fs.readdirSync(r, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (e.isDirectory()) {
        const m = e.name.match(DATE_DIR_RE);
        /* ⚠ 必须**非空**才算数：空的日期文件夹是搬运半途留下的壳（2026-10-09 实测踩到 ——
           把错归的课件从 2026-10-14\ 搬走后那个空壳还在，结果它把时间线的下界锚到了 10-14，
           新逻辑又算回 10-14 去了）。 */
        if (m && fs.readdirSync(path.join(r, e.name)).length) push(m[1]);
        continue;
      }
      if (scanFiles) push(dayInName(e.name));          /* 老布局：日期写在文件名里 */
    }
  }
  return out.sort();
}

/* 这份课件现在是不是躺在 `<课程>\<日期>\` 里？是则返回那个日期，否则 '' */
function currentDateFolderOf(deckPath, courseDirName) {
  if (!deckPath) return '';
  const dir = path.dirname(path.resolve(String(deckPath)));
  const courseDir = path.resolve(path.join(CW_ROOT, String(courseDirName || '')));
  if (path.dirname(dir) !== courseDir) return '';
  const m = path.basename(dir).match(DATE_DIR_RE);
  return m ? m[1] : '';
}

/* 录音文件名里的时刻：`录音_2026.10.7_15点至16点.m4a` → '15:00'；认不出返回 ''。
   ⚠ 必须先剥掉日期，否则 `2026.10.7` 里的 `.7` 会被当成时刻。 */
function clockInName(name) {
  const s = String(name || '').replace(/20\d{2}[-_.]\d{1,2}[-_.]\d{1,2}/, ' ');
  let m = s.match(/(\d{1,2})\s*[点時时]\s*(\d{1,2})?/);            /* 15点 / 15点30 / 下午三点（中文数字这里认不出，无妨） */
  if (!m) m = s.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);            /* 15:05 */
  if (!m) m = s.match(/(?<![\d.])(\d{1,2})\s*\.\s*(\d{2})(?!\d)/); /* 15.05 */
  if (!m) return '';
  const h = parseInt(m[1], 10);
  const mi = m[2] === undefined ? 0 : parseInt(m[2], 10);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return '';
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

/* `录音\` 里**还没处理**（不在 录音\已处理\）的录音，日期刚好落在这门课的某个讲座日上。
   只当**旁证**写进日志，不参与判断 —— 它说明"这节课的录音还没做笔记"，正是用户在整理的这份课件要配的。 */
function pendingRecordingDays(courseDirName) {
  const want = new Set(lecDaysOf(courseDirName).days.map((x) => x.day));
  if (!want.size) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '已处理' && e.name !== '_备份') walk(q, depth + 1); continue; }
      if (AUDIO_EXT.indexOf(path.extname(e.name).toLowerCase()) < 0) continue;
      const day = dayInName(e.name);
      if (day && want.has(day)) out.push({ day, clock: clockInName(e.name), name: e.name });
    }
  };
  walk(path.join(ROOT, '录音'), 0);
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/* 纯函数：只吃数据、不碰文件系统 —— 自测直接喂合成输入（全部字段可注入）。 */
function pickDeckDay(o) {
  const opt = o || {};
  const arrive = String(opt.arriveDay || '');
  const slotDays = (opt.slotDays || []).filter((d) => DATE_DIR_RE.test(d)).slice().sort();
  const free = (d) => (typeof opt.isFree === 'function' ? !!opt.isFree(d) : true);
  const anchors = [opt.lastKnownDay, opt.currentDirDay].filter((d) => d && DATE_DIR_RE.test(d)).sort();
  const lowAnchor = anchors.length ? anchors[0] : (arrive ? shiftDay(arrive, -LOOKBACK_DAYS) : '');
  const from = [opt.termStart || '', lowAnchor].filter(Boolean).sort().pop() || '';
  const to = arrive ? shiftDay(arrive, LEAD_DAYS) : '';
  const inWin = (d) => (!from || d >= from) && (!to || d <= to);
  const win = slotDays.filter(inWin);
  const timeline = win.filter(free)[0] || '';
  const label = String(opt.labelDay || '');
  const cur = String(opt.currentDirDay || '');
  const labelInWin = !!label && win.indexOf(label) >= 0;
  const labelOk = labelInWin && free(label);
  /* 已经在某个日期文件夹里 → 只要那个日期还在窗口内、也没被别的课件占着，就**不动它**
     （上一次运行/用户已经定过的归类优先于文件名周号；重跑才能幂等、不来回漂）。
     它**不在**窗口内（例如错归到未来的 10-14）才重算 —— 这正是这次要修的 bug。 */
  const curOk = !!cur && inWin(cur) && free(cur);
  const lw = opt.labelWeek ? ('Week ' + opt.labelWeek + '（按课表 = ' + label + '）') : label;
  let day = '', src = '', warn = '';
  if (curOk) {
    day = cur;
    src = '沿用现有的日期文件夹（' + cur + '）';
    if (label && label !== cur && labelInWin) {
      warn = '⚠ 文件名周号按课表算的是 ' + lw + '，但这份课件已经在 ' + cur + ' 里了 → 保持不动；要改就加 --date ' + label;
    }
  } else if (labelOk) {
    day = label;
    src = '文件名里的周号 + 课表';
    if (timeline && timeline !== label) {
      warn = '⚠ 但更早的 ' + timeline + ' 还空着（这门课还没做过的讲座日）—— 如果这份是那节课的，加 --date '
        + timeline + ' 重跑';
    }
  } else if (timeline) {
    day = timeline;
    src = '按进度推断（' + (opt.lastKnownDay ? '这门课已做到 ' + opt.lastKnownDay + '，' : '')
      + '下一个还没课件的讲座日是 ' + timeline + '）';
    if (label) {
      warn = '⚠ 文件名写的是 ' + lw + '，与到货日 ' + arrive + ' 差得太远（>' + LEAD_DAYS + ' 天）→ **不采信**，'
        + '按进度归到 ' + timeline + '；如果这份真是那节课的，加 --date ' + label + ' 重跑';
    }
  } else if (label) {
    day = label;
    src = '文件名里的周号 + 课表（⚠ 算出来与到货时间差得多，请核对）';
  }
  return { day, src, warn, timeline, label, labelInWin, win, from, to, arrive };
}

/* 采集现场数据 → 调 pickDeckDay 决策 → 附一条录音旁证。返回同一个对象，外加 note/arriveDay 等。 */
function deckDayGuess(courseDirName, deckName, deckPath) {
  const courseDir = path.join(CW_ROOT, String(courseDirName || ''));
  const cur = currentDateFolderOf(deckPath, courseDirName);
  let arrive = '';
  try { if (deckPath && fs.existsSync(deckPath)) arrive = localDay(new Date(fs.statSync(deckPath).mtimeMs)); } catch (e) {}
  const plan = lecDaysOf(courseDirName);
  const known = knownLectureDays(courseDirName, cur);
  const label = dayFromWeekNo(courseDirName, deckName, deckPath);
  const m = String(deckName || '').match(WEEKNUM_RE);
  const myBase = path.basename(String(deckName || '')).replace(/\.[^.]+$/, '');
  const res = pickDeckDay({
    arriveDay: arrive,
    slotDays: plan.days.map((x) => x.day),
    termStart: plan.termStart,
    lastKnownDay: known.length ? known[known.length - 1] : '',
    currentDirDay: cur,
    labelDay: label,
    labelWeek: m ? m[1] : '',
    isFree: (d) => !dayHasOtherDeck(courseDir, d, myBase),
  });
  res.arriveDay = arrive;
  res.currentDirDay = cur;
  res.lastKnownDay = known.length ? known[known.length - 1] : '';
  const recs = pendingRecordingDays(courseDirName);
  if (recs.length) {
    const hit = recs.filter((r) => r.day === res.day);
    res.note = hit.length
      ? '旁证：录音\\ 里 ' + hit[0].day + (hit[0].clock ? ' ' + hit[0].clock : '') + ' 那节课的录音还没处理 → 与上面的判断一致'
      : '旁证：录音\\ 里还有没处理的 ' + recs.map((r) => r.day + (r.clock ? '（' + r.clock + '）' : '')).join('、');
  }
  return res;
}

/* 把文件名里的「Week N / Lecture N / Unit N」+ 课表，换算成那一周的**上课日期**。
   为什么需要（2026-10-01 实测发现）：老师按周发课件，而且**上课前 48 小时就发**（本课课件 p6 明说）；
   这时「这门课最近一份笔记的日期」还停在**上一周** → 会归到错的日期文件夹。
   实测三份周课件的文件名全都只有周号、没有日期（Week1_… / Week 1 … / week01-…）。

   一周有**多个讲座日**时怎么挑（2026-10-01 补，两轮才定下来）：
   DEMO1001M 一周两讲（周三 15:00 + 周五 12:00），光看 "Week 1" 分不出是哪个。实测证据：
   `Week 1 Data Quality.pdf` 的导语写「以2020年英格兰 COVID-19 漏报事件开篇」，而 **10-02（周五）** 那份笔记
   的标题正是「数据质量与数据形态…英国新冠接触者追踪数据事故」→ 它属于**周五**那节；`Week1_What is Data Science`
   属于周三那节。
   ⚠ 第一版规则「跳过已经有别的课件的日期」**有顺序依赖、会翻车**：两份课件互相把对方看成"占了周三"，
   结果双双落到周五。所以改用**课件文件 mtime 就近匹配**（mtime ≈ 你下载/拿到它的时间，紧贴对应那节课）：
     · `Week1_What is Data Science.pdf` mtime 09-30 23:46 → 候选 09-30 / 10-02 → 选 **09-30** ✓
     · `Week 1 Data Quality.pdf`     mtime 10-03 00:00 → 候选 09-30 / 10-02 → 选 **10-02** ✓
   拿不到文件时退回「跳过已被别人占用的日期」，再退回最早的候选。要覆盖判断用 `--date`。

   返回 'YYYY-MM-DD'；算不出（没周号 / 没模块代码 / 不在教学窗口内）返回 ''，交调用方回退。 */
function dayFromWeekNo(courseDirName, deckName, deckPath) {
  const m = String(deckName || '').match(/\b(?:week|lecture|lec|unit|session|topic|chapter|part)\s*[-_ ]?\s*(\d{1,2})(?!\d)/i);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  if (!(n >= 1 && n <= 30)) return '';
  const code = (String(courseDirName || '').match(/^[A-Z]{4}\d{4}M/) || [''])[0];   /* 课程目录名以模块代码开头 */
  if (!code) return '';
  const tt = loadTimetableRaw();
  const mod = (tt.modules || []).find((x) => String(x.code).toUpperCase() === code);
  const sem = String((mod && mod.sem) || '1');                    /* 学期以模块表为准，别硬编码 1 */
  /* 该学期「第 1 周周一」的两个来源，**权威度不同**：
       · weekEpoch[sem].from —— 权威（S1 = 2026-09-28，已核对是周一）
       · teaching[sem][0]    —— 近似（S1 那份是 2026-09-21＝迎新周，比第 1 周早一周！所以只作兜底）
     ⚠ 实测 课程表.json 的 `weekEpoch["2"]` 是 **null**，只有 teaching["2"][0] = 2027-01-25 可用；
       而 2027-01-25 已被 [官方 term dates](https://www.leeds.ac.uk/term-dates) 独立核实为 S2 教学首日 ✓ */
  const epoch = (tt.weekEpoch || {})[sem];
  const epochAuthoritative = !!(epoch && epoch.from);
  const teach = (tt.teaching || {})[sem];
  const termStart = (epoch && epoch.from) || (Array.isArray(teach) && teach[0]) || (sem === '1' ? tt.termStart : '');
  if (!termStart) return '';
  const slots = (tt.slots || []).filter((s) => String(s.code).toUpperCase() === code
    && String(s.sem) === sem && DOW_OFFSET[s.day] !== undefined);
  if (!slots.length) return '';
  /* 候选时段：优先**有名字的讲座**（act=LEC）→ 退到**有名字的任意时段** → 最后才用 `noName` 的
     （`noName` 只表示"别拿它的名字当课名"，不代表没日期）。
     实测：DEMO1009M 在课表里**只有两个 noName 的 DROP-IN**（它是自学模块、没有讲座），
     所以靠最后那档兜底 —— 它算出 2026-09-29，与用户那份笔记的实际日期**完全一致**。 */
  const named = slots.filter((s) => !s.noName);
  const lec = named.filter((s) => /LEC/i.test(s.act || ''));
  const pool = (lec.length ? lec : (named.length ? named : slots)).slice()
    .sort((a, b) => (DOW_OFFSET[a.day] - DOW_OFFSET[b.day]) || String(a.start).localeCompare(String(b.start)));
  if (!pool.length) return '';
  /* 周次过滤**只在 epoch 权威时**做，而且必须拿**绝对教学周号**去比：
     文件名里的 N 是"这门课的第几周"（模块相对），而 课程表.json 的 `weeks` 写的是**教学周日历**——
     S1 两者重合（epoch.week = 1），S2 差 13 周（`weeks:"14-21, 22-24"` ＝ 模块第 1~8、9~11 周）。
     ⚠ 2026-10-09 修：原来直接拿 n 去比，S2 课件（模块第 1 周 → n=1，而 weeks 里最小是 14）**全被误杀**，
       表现是 dayFromWeekNo 一律返回 ''、静悄悄退回"最近一份笔记的日期"，一点也不报错。 */
  const baseWeek = (epoch && epoch.week) ? Number(epoch.week) : 1;
  const absWeek = baseWeek + (n - 1);
  let use = pool.filter((s) => !epochAuthoritative || weeksMatchLocal(String(s.weeks || ''), absWeek));
  if (!use.length) return '';
  const mon0 = new Date(termStart + 'T12:00:00');                 /* 锚到中午，避开夏令时把日期挪走 */
  if (isNaN(mon0.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  const dateOf = (s) => {
    const d = new Date(mon0);
    d.setDate(d.getDate() + (n - 1) * 7 + DOW_OFFSET[s.day]);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  /* 教学窗口护栏：越界的候选直接丢掉（防学期/周次口径不一致时给出看着像样、其实错的日期） */
  const inWin = (day) => {
    if (!Array.isArray(teach) || teach.length < 2) return true;
    const t = new Date(day + 'T12:00:00').getTime();
    return t >= new Date(teach[0] + 'T00:00:00').getTime() && t <= new Date(teach[1] + 'T23:59:59').getTime();
  };
  const cands = use.map(dateOf).filter(inWin);
  if (!cands.length) return '';
  if (cands.length === 1) return cands[0];
  /* 一周多个讲座日：**优先用课件文件的 mtime 就近匹配**（见函数头注释）。
     mtime 就是"用户什么时候拿到这份课件"，紧贴对应那节课 —— 比"哪个日期还空着"可靠得多。 */
  let mtime = 0;
  try { if (deckPath && fs.existsSync(deckPath)) mtime = fs.statSync(deckPath).mtimeMs; } catch (e) {}
  if (mtime) {
    const mid = (day) => Math.abs(new Date(day + 'T12:00:00').getTime() - mtime);
    const near = cands.slice().sort((a, b) => mid(a) - mid(b));
    return near[0];
  }
  /* 拿不到文件（例如合成数据）→ 退回「跳过已被别人占用的日期」→ 再退回最早的候选 */
  const courseDir = path.join(CW_ROOT, String(courseDirName || ''));
  const myBase = path.basename(String(deckName || '')).replace(/\.[^.]+$/, '');
  return cands.find((day) => !dayHasOtherDeck(courseDir, day, myBase)) || cands[0];
}

/* ---------------- Python ---------------- */
function findPython() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) {}
  const cands = [];
  if (cfg.python) cands.push(cfg.python);
  cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'));
  cands.push('F:\\python.exe');
  cands.push('python');
  for (const c of cands) {
    if (c === 'python') return c;
    if (c && fs.existsSync(c)) return c;
  }
  return 'python';
}

/* ---------------- 收集待归档的课件 ---------------- */
function isDeck(f) { return DECK_EXT.indexOf(path.extname(f).toLowerCase()) >= 0; }
function collect() {
  if (given.length) return given.map((p) => path.resolve(ROOT, p)).filter((p) => fs.existsSync(p));
  const out = [];
  if (fs.existsSync(INBOX)) {
    fs.readdirSync(INBOX, { withFileTypes: true }).forEach((it) => {
      if (it.isFile() && isDeck(it.name)) out.push(path.join(INBOX, it.name));
    });
  }
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) walk(q);
      else if (it.isFile() && isDeck(it.name)) out.push(q);
    });
  };
  walk(PENDING);
  return out;
}

/* ---------------- 提文本（就地生成 <名>_文本.txt / _pages.json） ---------------- */
function extractText(deck) {
  const base = deck.replace(/\.[^.]+$/, '');
  const txt = base + '_文本.txt';
  const pgs = base + '_pages.json';
  if (fs.existsSync(txt) && fs.existsSync(pgs) &&
    fs.statSync(txt).mtimeMs >= fs.statSync(deck).mtimeMs) return { txt, pgs, cached: true };
  const py = findPython();
  const r = cp.spawnSync(py, [path.join(ROOT, 'slides-extract.py'), deck], { stdio: 'inherit' });
  if (!fs.existsSync(txt)) throw new Error('提取失败（' + py + ' 退出码 ' + r.status + '）');
  return { txt, pgs, cached: false };
}

/* ---------------- 认课 ----------------
 * 三层证据，从硬到软（都是机械计数，可复核；不调模型）：
 *   ① 模块代码（DEMO1006M…）在正文/文件名里出现 —— 最硬
 *   ② 模块缩写：由模块名的实义词首字母拼（Knowledge Repres. & Reasoning → KRR），按词边界计数
 *      —— 实测这份 KRR 课件：代码 0 次、缩写 331 次，一口气就能定死（课件里根本不写 DEMO1006M）
 *   ③ 名称关键词全命中 + 总频次（`repres` 这类缩写要按**前缀**匹配，才能命中 "Representation"）
 * 只有"明显领先"才自动落位：领先不到 3 倍就当没认出来，交给你确认，绝不赌。
 * （踩过的坑：最初只按"模块名子串"匹配，"Machine Learning" 在这份课件里出现 1 次就把它认成了
 *   DEMO1007M —— 一份 KRR 课件被塞进 Machine Learning 文件夹。所以现在必须"领先 + 高频"两条都满足。）
 */
const STOP = /^(and|of|the|for|a|an|to|in|on|with|amp)$/;
const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) || [];
const rx = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* 词边界计数；prefix=true 时按前缀匹配（repres 命中 Representation） */
function countIn(hay, w, prefix) {
  const re = new RegExp('(^|[^a-z0-9])' + rx(w) + (prefix ? '[a-z0-9]*' : '') + '([^a-z0-9]|$)', 'g');
  return (hay.match(re) || []).length;
}
function acronymOf(name) {
  const t = words(name).filter((w) => !STOP.test(w) && w.length >= 2);
  return t.length >= 3 ? t.map((w) => w[0]).join('') : '';
}
function guessCourse(txtFile, deckName) {
  const raw = fs.readFileSync(txtFile, 'utf8').toLowerCase();
  const fname = String(deckName || '').toLowerCase();
  const rows = MODULES.map((m) => {
    const code = String(m.code || '').toLowerCase();
    const ac = acronymOf(m.name);
    const toks = words(m.name).filter((w) => !STOP.test(w) && w.length >= 4);
    const tk = toks.map((w) => ({ w, n: countIn(raw, w, true) + countIn(fname, w, true) * 3 }));
    return {
      course: label(m), code: m.code,
      codeN: code ? (countIn(raw, code) + countIn(fname, code) * 3) : 0,
      ac, acN: ac ? (countIn(raw, ac) + countIn(fname, ac) * 3) : 0,
      toks: tk, tokN: (tk.length && tk.every((x) => x.n > 0)) ? tk.reduce((a, x) => a + x.n, 0) : 0,
    };
  });
  const lead = (list) => list.length === 0 ? null
    : (list.length === 1 ? { top: list[0], sure: true }
      : { top: list[0], sure: list[0][1] >= 3 * list[1][1] });

  const byCode = rows.filter((r) => r.codeN > 0).sort((a, b) => b.codeN - a.codeN);
  if (byCode.length) {
    const l = lead(byCode.map((r) => [r, r.codeN]));
    if (l.sure) return { course: l.top[0].course, why: '正文/文件名出现模块代码 ' + l.top[0].code + ' ×' + l.top[0].codeN, tier: '代码' };
    return { course: '', why: '多个模块代码同时出现（' + byCode.map((r) => r.code + '×' + r.codeN).join('、') + '），分不出主次', tier: '代码' };
  }
  const byAc = rows.filter((r) => r.acN > 0).sort((a, b) => b.acN - a.acN);
  if (byAc.length) {
    const l = lead(byAc.map((r) => [r, r.acN]));
    if (l.sure) return { course: l.top[0].course, why: '模块缩写 ' + l.top[0].ac.toUpperCase() + ' 出现 ×' + l.top[0].acN, tier: '缩写' };
    return {
      course: '', why: '缩写线索不唯一（' + byAc.slice(0, 3).map((r) => r.ac + '×' + r.acN).join('、') + '）',
      tier: '缩写', cands: byAc.slice(0, 4).map((r) => r.course),
    };
  }
  const byTok = rows.filter((r) => r.tokN > 0).sort((a, b) => b.tokN - a.tokN);
  if (byTok.length) {
    const l = lead(byTok.map((r) => [r, r.tokN]));
    if (l.sure) return { course: l.top[0].course, why: '名称关键词全命中　' + l.top[0].toks.map((x) => x.w + '×' + x.n).join(' '), tier: '关键词' };
    return {
      course: '', why: '关键词线索不唯一（' + byTok.slice(0, 3).map((r) => r.course + '=' + r.tokN).join('、') + '）',
      tier: '关键词', cands: byTok.slice(0, 4).map((r) => r.course),
    };
  }
  return { course: '', why: '正文里既没有模块代码，也没有模块缩写/关键词', tier: '无', cands: MODULES.map(label) };
}

/* ---------------- 交互 ---------------- */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(String(a || '').trim()); });
  });
}

/* ---------------- 安全搬运：复制→逐字节比对→删源 ---------------- */
function moveVerified(src, dstDir, dstName) {
  fs.mkdirSync(dstDir, { recursive: true });
  let dst = path.join(dstDir, dstName);
  /* ⚠ 源和目标就是同一个文件（例如已经在 课件\_待归档\ 里、重跑又被扫到）：
     必须原地不动。曾经走"去重"分支把它自己删了 —— 自测抓到的真实数据丢失。 */
  if (path.resolve(src) === path.resolve(dst)) return { dst, action: '原地不动，无需搬动（源与目标同一文件）' };
  if (fs.existsSync(dst)) {
    if (Buffer.compare(fs.readFileSync(src), fs.readFileSync(dst)) === 0) {
      fs.unlinkSync(src);
      return { dst, action: '去重（目标已有同样内容，删源文件）' };
    }
    const ext = path.extname(dstName);
    let n = 2;
    while (fs.existsSync(path.join(dstDir, path.basename(dstName, ext) + '-' + n + ext))) n++;
    const alt = path.basename(dstName, ext) + '-' + n + ext;
    console.log('    ⚠ 目标已有同名但内容不同的文件，新文件改名：' + alt);
    dst = path.join(dstDir, alt);
  }
  fs.copyFileSync(src, dst);
  if (Buffer.compare(fs.readFileSync(src), fs.readFileSync(dst)) !== 0) {
    throw new Error('复制后校验不一致，已保留原文件：' + dst);
  }
  fs.unlinkSync(src);
  return { dst, action: '已搬运（复制→校验一致→删源）' };
}

/* ---------------- 放哪儿：日期归类用的小工具（2026-09-29 新增） ----------------
 * 规则见主流程注释：总课件留根，单节课件按「文件名日期 → 这门课最近笔记日期」进 <日期>\ 子文件夹。 */
function pageCountOf(pagesJson) {
  try {
    const j = JSON.parse(fs.readFileSync(pagesJson, 'utf8'));
    return Array.isArray(j) ? j.length : 0;
  } catch (e) { return 0; }
}
function listDeckFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) walk(q);
      else if (it.name.endsWith('_文本.txt')) out.push(q);
    });
  };
  walk(dir);
  return out;
}
function deckBaseName(f) { return path.basename(String(f)).replace(/_文本\.txt$/, ''); }
/* 文件名里的日期：2026-09-28 / 2026_09_28 / 2026.09.28 / 20260928 都认 */
function dayInName(name) {
  const s = String(name || '');
  let m = s.match(/(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  m = s.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return '';
}
/* 这门课最近一份笔记的上课日期（笔记文件名里带日期；找不到返回空串） */
function latestNoteDay(courseDir) {
  const notesRoot = path.join(ROOT, '笔记', path.basename(courseDir));
  const days = [];
  const walk = (d, depth) => {
    if (depth > 2 || !fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) { if (it.name !== '_备份') walk(q, depth + 1); }
      else {
        const m = it.name.match(/(20\d{2}-\d{2}-\d{2})/);
        if (m && it.name.toLowerCase().endsWith('.json')) days.push(m[1]);
      }
    });
  };
  walk(notesRoot, 0);
  return days.sort().pop() || '';
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const decks = collect();
  console.log('== 课件归位 ==');
  console.log('待处理课件：' + decks.length + ' 份' + (DRY ? '（--dry：只看不动）' : ''));
  if (!decks.length) {
    console.log('  （录音\\ 顶层与 课件\\_待归档\\ 里没有 pdf/pptx/docx —— 把新课件丢进 录音\\ 再跑一次即可）');
    return;
  }

  for (const deck of decks) {
    const name = path.basename(deck);
    console.log('\n· ' + deck.replace(ROOT + path.sep, ''));
    let picked = FORCE;
    let why = FORCE ? '命令行 --course 指定' : '';
    let txt = '', pgs = '';

    try {
      /* 认课要靠正文，所以 --dry 也会提取一次（会在源目录留下 _文本.txt/_pages.json 两个副产物） */
      const e = extractText(deck);
      txt = e.txt; pgs = e.pgs;
      if (e.cached) console.log('  文本已存在，直接复用（不重复提取）');

      if (!picked) {
        const g = guessCourse(txt, name);
        picked = g.course; why = g.why;
        console.log('  认课：' + (picked ? picked + '（' + g.tier + '层证据：' + why + '）' : '✗ ' + why));
        if (!picked && process.stdin.isTTY && !DRY) {
          if (g.cands && g.cands.length) console.log('  候选：' + g.cands.join('　|　'));
          const a = await ask('  这份课件属于哪门课？填模块代码或课程名（直接回车＝先进 课件\\_待归档\\）：');
          const hit = MODULES.find((m) => norm(m.code) === norm(a) || norm(label(m)) === norm(a) || norm(m.name) === norm(a));
          picked = hit ? label(hit) : (a || '');
          why = a ? '你手工指定' : '你没指定';
          console.log('  → 认课改为：' + (picked || '（待归档）'));
        }
      } else {
        console.log('  认课：' + picked + '（' + why + '）');
      }

      /* ---- 放哪儿：**每份课件都进一个自己的文件夹**（2026-10-01 用户要求）----
         ① 这份是**本课页数最多**、**≥ MIN_TOTAL_PAGES 页**、且**文件名不像单周/单讲** → 整学期总课件
            → `<课程>\总课件\`（共享课程地图也归它）
         ② 文件名里有日期（2026-09-28 / 2026_09_28 / 20260928）→ 用那个日期 → `<课程>\<日期>\`
         ③ 否则用**这门课最近一份笔记的上课日期** → `<课程>\<日期>\`
         ④ 都不行 → `<课程>\无日期\`
         显式开关：`--total` 强制当总课件、`--root` 强制留课程根、`--date YYYY-MM-DD` 强制某天。

         ⚠ 阈值 40 → MIN_TOTAL_PAGES（2026-10-01 用户要求提高）：
           用户原话「那个就是周课件而不是总课件，**总课件肯定是大几百页起步的，不可能这么少**」。
           实测本机：真·总课件 KRR = **299 页 / 18 讲**；而三份周课件分别只有 48 / 42 / 11 页。
           旧阈值 40 会把 48 页的 `Week1_What is Data Science` 误判成总课件（它名字里就写着 Week1）。
         ⚠ 另加**文件名否决**：名字里带 week/lecture/unit/session/topic/chapter/part + 序号的，
           一律不算总课件 —— 总课件是"整学期一份"，不会在文件名里标周次。实测三份周课件全部被正确否决。

         ⚠ 2026-09-30 的第一版是「总课件**留课程根目录**」，结果它的 **6 个产物**（原件 + _文本 + _pages +
           它自己的地图 ×3）平铺在课程根，和共享地图、近似课程文档混在一起 —— 用户 2026-10-01 指出太乱。
           用户原话本就是「总课件**跟所有依据日期整理的文件夹放在一起**」= 它该是**一个和日期文件夹并排的文件夹**，
           所以现在统一成 `总课件\`。课程根只留**课程级**成果（共享地图 + 近似课程对比）。 */
      let targetDir = picked ? path.join(CW_ROOT, picked) : PENDING;
      if (picked) {
        const courseDir = path.join(CW_ROOT, picked);
        const myPages = pageCountOf(pgs);
        let bestPages = 0;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(courseDir, '课程地图.json'), 'utf8'));
          for (const f of listDeckFiles(courseDir)) if (deckBaseName(f) === j.deck) bestPages = pageCountOf(path.join(path.dirname(f), deckBaseName(f) + '_pages.json'));
        } catch (e) { /* 没有共享地图就按"这门课目前没有总课件"处理 */ }
        const forceRoot = has('--root');
        const forceTotal = has('--total');
        const forceDay = String(valOf('--date') || '');
        const weekish = looksLikeSingleDeck(name);
        if (forceRoot) {
          console.log('  归类：--root 指定 → 留在课程根目录');
        } else if (forceTotal || (myPages >= MIN_TOTAL_PAGES && myPages >= bestPages && !weekish)) {
          targetDir = path.join(courseDir, '总课件');
          console.log('  归类：' + myPages + ' 页，是本课页数最多的（≥' + MIN_TOTAL_PAGES + ' 页）→ 整学期总课件 → 总课件\\'
            + (forceTotal && (myPages < MIN_TOTAL_PAGES || weekish) ? '（--total 强制）' : ''));
        } else {
          if (weekish && myPages >= MIN_TOTAL_PAGES) {
            console.log('  · 注意：' + myPages + ' 页虽然够长，但文件名带周次/讲次（' + name + '）→ 按单节课件处理');
          }
          /* 2026-10-09 改：主判据从「只信文件名周号」换成 deckDayGuess 的**课表进度时间线**
             （用户报的 bug：`Week 3 EDA and Viz .pdf` 被归到 10-14，而它是 10-07 那节课的）。 */
          const guess = deckDayGuess(picked, name, deck);
          const dInName = dayInName(name);
          const day = forceDay || dInName || guess.day || latestNoteDay(courseDir);
          if (day) {
            targetDir = path.join(courseDir, day);
            const src = forceDay ? '--date 指定'
              : (dInName ? '文件名里的日期'
                : (guess.day ? guess.src : '这门课最近一份笔记的上课日期'));
            console.log('  归类：单节课件（' + myPages + ' 页）→ ' + day + '\\（' + src + '）');
            if (guess.day === day && guess.warn) console.log('  ' + guess.warn);
            if (guess.day === day && guess.note) console.log('  · ' + guess.note);
          } else {
            targetDir = path.join(courseDir, '无日期');
            console.log('  归类：文件名没日期、这门课也还没有笔记 → 无日期\\（出完笔记后重跑整理，会挪进对应日期文件夹）');
          }
        }
      }

      if (DRY) {
        console.log('  → 会放到：' + targetDir.replace(ROOT + path.sep, '') + '\\');
        continue;
      }
      if (!picked) console.log('  → 没有可靠课程，先进 课件\\_待归档\\（改名/补代码后再跑一次即可）');

      /* 本来就在目标目录里（例如已在 _待归档 又被扫到）：别搬、更别删，只建图 */
      const sameDir = path.resolve(path.dirname(deck)) === path.resolve(targetDir);
      if (sameDir) console.log('  已经在目标目录里，只重建课程地图，不动文件');
      const r = sameDir ? { dst: deck, action: '留在原地' } : moveVerified(deck, targetDir, name);
      console.log('  ✓ ' + r.action + ' → ' + r.dst.replace(ROOT + path.sep, ''));

      /* 提取产物 + **这份课件自己的地图**，一起跟着走。
         ⚠ 地图也要搬：read-slides 会在新目录重建它，但旧目录会留下孤儿
           `课程地图-<课件名>.md/.json/.html`；而且它还是「沿用导语」的依据（见 read-slides 的 carryOverIntro）。
         顺序：先把地图搬到新目录，再调 read-slides —— 它在新目录里就能读到并沿用导语（零 API）。 */
      /* ⚠ 别用 deckBaseName()：它只剥 `_文本.txt`、**不剥 `.pdf`**（它要的是 listDeckFiles 的产物路径）。
         这里要的是"课件文件去掉扩展名"，才是地图命名的口径（`课程地图-<去扩展名的课件名>.json`）。 */
      const ownBase = path.basename(String(name)).replace(/\.[^.]+$/, '');
      const ownMaps = ['课程地图-' + ownBase + '.md', '课程地图-' + ownBase + '.json', '课程地图-' + ownBase + '.html']
        .map((f) => path.join(path.dirname(deck), f)).filter((f) => fs.existsSync(f));
      for (const extra of [txt, pgs].concat(ownMaps)) {
        if (!extra || !fs.existsSync(extra)) continue;
        if (path.resolve(path.dirname(extra)) === path.resolve(targetDir)) { console.log('  ✓ 附带文件：' + path.basename(extra) + '（留在原地）'); continue; }
        const er = moveVerified(extra, targetDir, path.basename(extra));
        console.log('  ✓ 附带文件：' + path.basename(extra) + '（' + er.action + '）');
      }

      /* 建课程地图（机械，零 API；加 --intro 才花一次调用让模型给每讲写导语）
         ⚠ 必须把**课程根目录**（不是日期子文件夹）交给 read-slides：
            它自己会递归找到刚归位的那份课件，并把「每份课件自己的地图」写在课件旁边、
            把「共享地图」写在课程根目录。传子文件夹会让共享地图也跟着写进子文件夹（实测踩过）。
         ⚠ 明确指定 --deck <刚归位的那份>：否则目录里有多份课件时，可能去给「别人」建图。 */
      if (picked) {
        /* 导语：用户 2026-10-01 明确要求「以后所有新课都要有导语」→ **默认就给**（1 次调用）。
           但**已经买过的别再买一次**：这份课件自己的地图里若已有导语，就不传 --intro，
           交给 read-slides.js 的「沿用已有导语」逻辑（零 API）。
           显式跳过：`--no-intro`（想省钱或纯机械时用）。 */
        const wantIntro = !has('--no-intro') && !deckAlreadyHasIntro(picked, name);
        console.log('  建课程地图' + (wantIntro ? '（含模型导语，1 次调用）' : '（纯机械 / 沿用已有导语，零 API）') + '…');
        const rsArgs = [path.join(ROOT, 'read-slides.js'), path.join(CW_ROOT, picked), '--deck', name.replace(/\.[^.]+$/, '')];
        if (wantIntro) rsArgs.push('--intro');
        const rr = cp.spawnSync(process.execPath, rsArgs, { stdio: 'inherit' });
        if (rr.status !== 0) console.log('  ⚠ read-slides.js 退出码 ' + rr.status + '（不致命：课件已经放好了）');

        /* 「近似课程对比」每门课都该有一份（用户 2026-10-01 要求「以后所有新课都要」）。
           ⚠ 脚本**不能**自动下结论：「哪门课像哪门课」是**事实判断**，必须有可点开的来源，
             模型凭记忆报的课名没有事实约束（本项目纪律：推测不得当结论用）。
           所以这里只做能确定做到的事 —— **把它显式点出来，不静默**，并给出确切的下一步。 */
        try {
          const cmpMd = path.join(CW_ROOT, picked, '近似课程对比.md');
          if (!fs.existsSync(cmpMd)) {
            console.log('');
            console.log('  ⚠ 这门课还没有「近似课程对比」：' + path.join('课件', picked, '近似课程对比.md'));
            console.log('     这是每门课都该有的交付物（和 DEMO1006M 那份同格式）。要补上，二选一：');
            console.log('       · 在对话里说：帮我核实 ' + picked + ' 的近似课程（要带可点开的来源）');
            console.log('       · 先自己搜：双击 查近似课程.cmd（生成 13 个搜索入口的待核实页）');
          }
        } catch (e) { /* 只提示，不影响归位 */ }
      }
    } catch (e) {
      console.log('  ✗ 出错：' + (e && e.message ? e.message : e));
      console.log('    （原文件保持不动；修好后重跑本脚本即可）');
    }
  }
  console.log('\n完成。课件都在 课件\\<课程名>\\ 下；课程地图.md 就在该目录里。');
}

/* 这份课件自己的地图里**已经**有导语了吗？
   有 → 别再花一次调用买一遍（read-slides.js 不带 --intro 时会自动沿用）。
   找的是 `课程地图-<课件基名>.json`，与 read-slides.js 的命名口径一致；跳过 _备份\。
   ⚠ 别退化成「看整个课程目录里有没有导语」—— 那样加第二份课件时会误判成"已有导语"而永远不买。 */
function deckAlreadyHasIntro(courseDirName, deckFile) {
  const base = String(deckFile || '').replace(/\.[^.]+$/, '');
  if (!base) return false;
  const want = '课程地图-' + base + '.json';
  const stack = [path.join(CW_ROOT, courseDirName)];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_备份') stack.push(p); continue; }
      if (e.name !== want) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if ((j.lectures || []).some((l) => l && l.intro)) return true;
      } catch (err) { /* 坏文件当没有，交给 read-slides 重建 */ }
    }
  }
  return false;
}

/* 作为模块被 require（自测脚本）时只导出纯函数，不跑主流程 */
module.exports = {
  MODULES, label, norm, words, countIn, acronymOf, guessCourse,
  collect, extractText, moveVerified, findPython, listModules: () => MODULES.map(label),
  pageCountOf, listDeckFiles, deckBaseName, dayInName, latestNoteDay,
  deckAlreadyHasIntro,
  MIN_TOTAL_PAGES, looksLikeSingleDeck,
  dayFromWeekNo, weeksMatchLocal, dayHasOtherDeck,
  LEAD_DAYS, LOOKBACK_DAYS, shiftDay, localDay, clockInName,
  lecDaysOf, knownLectureDays, currentDateFolderOf, pendingRecordingDays,
  pickDeckDay, deckDayGuess,
};

if (require.main === module) main();

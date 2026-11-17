// 校验笔记 HTML：结构可用性 + 设计底线（离线自检，不联网）
//   node _verify-output.js                 → 自动挑「当前模板产出的最新一份」
//   node _verify-output.js <笔记.html>      → 指定某一份（补样式后 mtime 会变，别靠"最新"猜）
// 为什么要按模板筛：模板改版后，旧产物天然缺新模板块（回听索引/本课统计等已被删掉），
// 拿它体检会报一堆"模板级"失败，看着像真出故障。
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '笔记');
const deep = (d, pre) => {
  let out = [];
  fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
    const q = path.join(d, it.name);
    if (it.isDirectory()) out = out.concat(deep(q, pre ? pre + '/' + it.name : it.name));
    else if (it.name.endsWith('.html')) out.push({ f: pre ? pre + '/' + it.name : it.name, t: fs.statSync(q).mtimeMs });
  });
  return out;
};
const list = deep(dir, "").sort((a, b) => b.t - a.t);
const isCurrent = (rel) => {
  try {
    const s = fs.readFileSync(path.join(dir, rel), 'utf8');
    return !/id="recap"/.test(s) && !/id="stats"/.test(s) && !/id="btnMd"/.test(s)
      && !/id="btnJson"/.test(s) && !/id="stageHead"/.test(s);
  } catch (e) { return false; }
};
let p;
if (process.argv[2]) {
  p = path.resolve(__dirname, process.argv[2]);
  if (!fs.existsSync(p)) { console.log('[X] 找不到指定的笔记：' + p); process.exit(1); }
} else {
  if (!list.length) { console.log('[X] 笔记目录里没有 HTML'); process.exit(1); }
  const cur = list.filter((x) => isCurrent(x.f))[0];
  if (!cur) console.log('（提示：笔记目录里没有"当前模板产出"的那份，退回最新的一份；旧的会报模板级失败）');
  p = path.join(dir, (cur || list[0]).f);
}
const h = fs.readFileSync(p, 'utf8');
const n = (re) => (h.match(re) || []).length;

let embedded = null, perr = null;
const m = h.match(/<script type="application\/json" id="raw">([\s\S]*?)<\/script>/);
if (m) { try { embedded = JSON.parse(m[1]); } catch (e) { perr = e.message; } }

const tok = h.match(/<!--(TITLE|CRUMB|ONELINE|FACTS|TOC|KEYPOINTS|NOTES|BILINGUAL|TERMS|MINDMAP|HANDOUT|TODOS|RAWJSON|GENAT)-->/g);

/* 两个对象（内嵌数据副本 vs .json 文件）第一处差异的字段路径 —— 不一致时报出来，好直接定位 */
function firstDiff(a, b, p0) {
  const walk0 = (x, y, p1) => {
    const tx = x === null ? 'null' : typeof x, ty = y === null ? 'null' : typeof y;
    if (tx !== ty) return p1 + '（类型不同）';
    if (tx === 'object') {
      const keys = Array.from(new Set(Object.keys(x || {}).concat(Object.keys(y || {}))));
      for (const k of keys) {
        const key = Array.isArray(x) ? p1 + '[' + k + ']' : (p1 ? p1 + '.' + k : k);
        if (!(k in (x || {}))) return key + '（只存在于 .json）';
        if (!(k in (y || {}))) return key + '（只存在于内嵌副本）';
        const r = walk0(x[k], y[k], key);
        if (r) return r;
      }
      return '';
    }
    return x === y ? '' : p1;
  };
  return walk0(a, b, p0) || '（未知字段）';
}

// 术语表行数：只数**第一张** table.terms（课件核对用的是同一套表格样式，别把它的行也算进来）
const firstTerms = (h.match(/class="terms"[\s\S]*?<\/table>/) || [''])[0];
const termRows = (firstTerms.match(/<tr>/g) || []).length;
const checks = [
  // --- 结构可用性 ---
  ['占位符全部替换', !tok, tok ? tok.join(',') : '0 个残留'],
  ['思维导图树 + 节点标签', h.includes('class="tree"') && n(/class="lbl"/g) >= 3, n(/class="lbl"/g) + ' 个节点'],
  ['导图折叠按钮（SVG 图标注入）', h.includes("className = 'tog'") && h.includes('insertBefore(btn')],
  ['问答卡容器 + 数据', h.includes('id="qaQ"') && embedded && embedded.qa && embedded.qa.length > 0, embedded && embedded.qa ? embedded.qa.length + ' 组' : '无'],
  ['术语表数据行', termRows - 1 > 0, (termRows - 1) + ' 行'],
  ['中英对照条目', n(/class="pair"/g) > 0, n(/class="pair"/g) + ' 组'],
  ['待办真实复选框', h.includes('class="todos"') && h.includes('type="checkbox"')],
  /* 内嵌数据副本必须与同名 .json 文件一致 —— HTML 的问答/术语/导图/课件核对全靠这份副本渲染。
     真实事故（2026-10-09 抓）：`fix-errata.js` 的纯文本替换伸进了副本，把「课件核对」的**记录字段**
     改掉了（KRR 的 fromAudio 被 AR-10s→KRR 改成了 KRR；DEMO1001M 的 patches[0].replace 被 01-27→01-28
     改成了 01-28），而 .json 那侧是豁免的 ⇒ 两份数据从此不一致、记录也不再是当时的真相。
     根因已在 fix-errata.js 修掉；不一致时跑 `node fix-embedded-json.js` 重建。 */
  (function () {
    if (perr) return ['内嵌 JSON 可解析', false, perr];
    if (!embedded) return ['内嵌 JSON 可解析', false, '找不到内嵌的 <script type="application/json" id="raw">'];
    let jf = null, jerr = '';
    try { jf = JSON.parse(fs.readFileSync(p.replace(/\.html$/i, '.json'), 'utf8')); } catch (e) { jerr = e.message; }
    if (!jf) return ['内嵌 JSON 与 .json 文件一致', false, '读不了同名 .json：' + jerr];
    const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v))
      ? Object.keys(v).sort().reduce((a, k2) => { a[k2] = v[k2]; return a; }, {}) : v);
    const a = canon(embedded), b = canon(jf);
    if (a === b) return ['内嵌 JSON 与 .json 文件一致', true, 'terms=' + (embedded.terms ? embedded.terms.length : '?') + '，' + Math.round(a.length / 1024) + ' KB 与同名 .json 完全等价'];
    return ['内嵌 JSON 与 .json 文件一致', false, '差在 ' + firstDiff(embedded, jf, '') + '　（跑 node fix-embedded-json.js 重建）'];
  })(),
  ['目录锚点齐全', n(/class="[^"]*\btoc\b[^"]*"/g) > 0 && (h.match(/href="#(points|notes|bilingual|terms|mindmap|qa|todos|handout)"/g) || []).length >= 3],
  // 工作台骨架：视图台 / 工具台 必须存在（这是「切换式浏览」的结构前提）
  // 防回归：曾经用「body 固定视口 + 面板内部滚动」，结果内容被裁且滑不动（真实事故）
  ['布局可滚动（无固定视口外壳）', !/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/.test(h) && !/html,body\{height:100%\}/.test(h) && !/\.wb\{[^}]*overflow:hidden/.test(h)],
  ['工作台骨架（视图台+工具台+切换逻辑）', /class="[^"]*\bviews\b[^"]*"/.test(h) && /id="tools"/.test(h) && /data-view/.test(h) && /id="findTerms"/.test(h)],
  // 防回归：底部状态栏曾经「只有 position:sticky、连背景都没有」，结果是透明文字浮在正文上＝
  // 滚过去像压字（2026-09-29 用户实际报的就是这个）。必须同时满足：
  // ① 基底 flex 规则在 ② 吸底规则带不透明底色 ③ 上沿有渐隐（正文溶进背景，而不是被切成半行）。
  ['吸底状态栏不透明（滚过的正文不压字）',
    /\.statusbar\{display:flex/.test(h) &&
    /\.statusbar\{position:sticky[^}]*background:var\(--bg\)/.test(h) &&
    /\.statusbar::before\{[^}]*linear-gradient/.test(h),
    /\.statusbar\{position:sticky/.test(h) ? '不透明底 + 上沿 22px 渐隐' : '窄屏为静态页脚'],
  // 2026-09-29 用户要求精简：这些重复/用不上的区块不该再出现
  // （回听索引＝用户点名；本课统计与底部状态栏重复；复制MD/导出JSON 与同目录 .md/.json 重复；面包屑与左栏高亮重复）
  ['已精简的冗余区块未复活', !/id="recap"/.test(h) && !/id="stats"/.test(h) && !/id="btnMd"/.test(h) && !/id="btnJson"/.test(h) && !/id="stageHead"/.test(h)],
  // 精简后 JS 仍须完好：删掉元素不能打断脚本（取元素一律判空）
  ['精简后脚本未被打断（取元素判空）', /getElementById\('btnMd'\)/.test(h) && /if \(_btnMd\)/.test(h)],
  // 不变量：有 [mm:ss] 时间点小圆片就必须有内嵌播放器，否则点了不跳转（曾因 meta.audioSrc 过期而漏渲染）
  ['时间点配播放器（有 [mm:ss] 就有 <audio id="lecAudio">）', n(/class="ts[ "]/g) === 0 || /<audio[^>]*id="lecAudio"/.test(h), n(/class="ts[ "]/g) + ' 个时间点'],
  // 课件核对视图：有数据就必须渲染出表 + 结论标签 + 目录锚点；没有数据时不许出现在左栏（同其它视图的规则）
  (function () {
    const rows = (embedded && embedded.handout && embedded.handout.rows) ? embedded.handout.rows.length : 0;
    if (rows) {
      /* 判讲依据（2026-10-03 新增）：这次核对是走「AI 按主题判讲」（可靠）还是「词重叠兜底」
         （实测曾把 18 讲里的 14 讲全选中、送进 14 万字符课件原文），读的人必须看得出来。
         ⚠ 只对**记了依据的笔记**（`handout.how`/`basis` 存在）要求渲染出来 ——
           该字段上线前生成的老笔记两样都没有，那属于"笔记旧"，不是模板缺陷；
           若不加这个条件，这条断言就会**随"体检到哪一份笔记"忽过忽不过**（本项目栽过多次的坑）。
         断言仍是 1 条，总分不受影响。 */
      const hasHow = !!(embedded && embedded.handout && (embedded.handout.how || embedded.handout.basis));
      /* ⚠ 判据必须落在**可见正文**上（先把 <script>…</script> 全去掉）：模板的内联导出脚本里
         本身就有「判讲依据：」「课件来源：」这些字面量，拿整份 HTML 去 includes **永远为真** ——
         这条断言原本就是这么写的，2026-10-09 才发现它其实抓不到"记了依据却没渲染出来"。 */
      const hVis = h.replace(/<script[\s\S]*?<\/script>/g, '');
      const rendered = hVis.includes('判讲依据：');
      /* 课件来源（2026-10-09 新增）：这次核对用的课件是**这节课的**，还是"这节课没有新课件、
         按进度沿用最近一次那份"（deckSrc === 'carry'）。只有 carry 档需要渲染出 ⚠ 说明 ——
         否则读者会以为核对用的就是这节课的课件。同样只对记了该字段的笔记要求渲染（老笔记跳过）。 */
      const car = !!(embedded && embedded.handout && embedded.handout.deckSrc === 'carry');
      const carOk = !car || hVis.includes('课件来源');
      const note = hasHow
        ? (rendered ? '判讲依据已写明' : '⚠ 记了依据却没渲染出来')
        : '旧笔记未记判讲依据（重跑即可补上）';
      /* 「⚠ 仍可疑」（2026-10-06 新增渲染）：课件里没有、笔记里还留着的值。
         有 leftovers 就必须在笔记里看得见 —— 以前只打在控制台，读的人会以为都改干净了。
         同一条断言内判断，总分不变。 */
      const lo = (embedded && embedded.handout && Array.isArray(embedded.handout.leftovers))
        ? embedded.handout.leftovers.length : 0;
      const loOk = lo === 0 || h.includes('处仍可疑');
      const okHo = h.includes('id="handout"') && h.includes('class="ho-v') && h.includes('href="#handout"')
        && (h.match(/class="ho-v/g) || []).length >= rows
        && (!hasHow || rendered) && carOk && loOk;
      return ['课件核对视图（' + rows + ' 项）', okHo,
        (h.match(/class="ho-v/g) || []).length + ' 个结论标签，' + note
        + (car ? (carOk ? '，课件来源（沿用）已写明' : '，⚠ 记了课件来源却没渲染') : '')
        + (lo ? '，' + lo + ' 处仍可疑' + (loOk ? '已渲染' : '⚠ 未渲染') : '')];
    }
    return ['课件核对视图（本次无课件）', !h.includes('href="#handout"'), '未出现在左栏'];
  })(),
  // 勘误表：读者能看到的正文里不该残留「whisper 听错的词」（真实事故：KRR 被写成 AR-10s，进了正文与学习台卡片）
  // 判据＝勘误表.json 里启用的规则，且把两处「记录」排除在外：可见的课件核对区块 + <script> 里的数据副本
  (function () {
    let E = null;
    try { E = JSON.parse(fs.readFileSync(path.join(__dirname, '勘误表.json'), 'utf8')); } catch (e) { E = null; }
    const rules = E && Array.isArray(E.replace) ? E.replace.filter((x) => x && x.from && x.to && x.enabled !== false) : [];
    if (!rules.length) return ['勘误表（无启用规则）', true, '勘误表.json 里没有启用的替换'];
    let body = h;
    const hs = body.indexOf('id="handout"');
    if (hs >= 0) {                                   // 课件核对区块＝抓错记录，允许保留错词原文
      const s0 = body.lastIndexOf('<section', hs), e0 = body.indexOf('</section>', hs);
      if (s0 >= 0 && e0 > s0) body = body.slice(0, s0) + body.slice(e0);
    }
    body = body.replace(/<script[\s\S]*?<\/script>/g, '');  // 数据副本不进正文判定
    const left = [];
    rules.forEach((r) => {
      const re = new RegExp(String(r.from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), r.ci ? 'gi' : 'g');
      const c = (body.match(re) || []).length;
      if (c) left.push(r.from + ' ×' + c);
    });
    return ['勘误表：正文不残留听错词' + (left.length ? '（' + left.join('，') + '）' : ''),
      left.length === 0, rules.map((r) => r.from + '→' + r.to).join('，') + '（课件核对记录与数据副本已豁免）'];
  })(),
  /* 目录布局（2026-09-29 用户要求）：笔记必须落在 笔记\<课程>\<上课日期>\ 里 */
  (function () {
    const dayDir = path.basename(path.dirname(p));
    const courseDir = path.basename(path.dirname(path.dirname(p)));
    const isDay = /^\d{4}-\d{2}-\d{2}$/.test(dayDir);
    const stamp = (path.basename(p).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    return ['日期文件夹布局（笔记在 <课程>/<日期>/ 里）', isDay && (!stamp || stamp === dayDir),
      isDay ? (courseDir + '/' + dayDir) : ('✗ 上层目录不是日期：' + dayDir)];
  })(),
  /* 不变量：笔记里播放器指向的音频必须真的存在（相对路径过期过 → 「点了不出声」） */
  (function () {
    const m0 = h.match(/<audio[^>]*\bsrc="([^"]+)"/);
    if (!m0) return ['音频引用可达（播放器 src 指向真实文件）', true, '本份没有播放器'];
    let target = '';
    try { target = path.resolve(path.dirname(p), decodeURIComponent(m0[1])); } catch (e) { target = ''; }
    return ['音频引用可达（播放器 src 指向真实文件）', !!target && fs.existsSync(target),
      target ? (fs.existsSync(target) ? '文件存在' : '打不开：' + target) : '解不开这个 src'];
  })(),
  /* 不变量：同一天的四处产物必须在同一个日期文件夹里（缺一处＝归档/拷贝漏了） */
  (function () {
    const day = path.basename(path.dirname(p)), course = path.basename(path.dirname(path.dirname(p)));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ['四处一致（笔记/录音稿/音频/已处理 同一天同一个日期文件夹）', true, '非日期布局，跳过'];
    const root = path.dirname(path.dirname(path.dirname(path.dirname(p))));   // …\<工作目录>
    const spots = [
      ['笔记', path.join(root, '笔记', course, day)],
      ['录音稿', path.join(root, '录音稿', course, day)],
      ['音频', path.join(root, '音频', course, day)],
      ['已处理', path.join(root, '录音', '已处理', course, day)],
    ];
    const miss = spots.filter((x) => {
      try { return !fs.readdirSync(x[1]).filter((f) => !/\.bak-/.test(f)).length; } catch (e) { return true; }
    }).map((x) => x[0]);
    return ['四处一致（笔记/录音稿/音频/已处理 同一天同一个日期文件夹）', miss.length === 0,
      miss.length ? '缺：' + miss.join('、') : '四处都在'];
  })(),
  /* 周复习台的「打开当日笔记」链接：必须**逐段编码**（整体编码会把 / 变 %2F → 浏览器不认 → 点不开，真出过这个 bug） */
  (function () {
    const dir = path.join(__dirname, '复习台');
    if (!fs.existsSync(dir)) return ['周复习台链接可达（逐段编码，无 %2F）', true, '还没有复习台'];
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.html') && !/\.bak-/.test(x)).sort().pop();
    if (!f) return ['周复习台链接可达（逐段编码，无 %2F）', true, '还没有复习台'];
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const hrefs = [...s.matchAll(/href="([^"]*笔记[^"]*)"/g)].map((m) => m[1]);
    if (!hrefs.length) return ['周复习台链接可达（逐段编码，无 %2F）', true, f + '：没有笔记链接'];
    const enc = hrefs.filter((x) => x.indexOf('%2F') >= 0);
    const dead = hrefs.filter((x) => !fs.existsSync(path.resolve(dir, decodeURIComponent(x))));
    return ['周复习台链接可达（逐段编码，无 %2F）', enc.length === 0 && dead.length === 0,
      f + '：' + hrefs.length + ' 条' + (enc.length ? '，' + enc.length + ' 条含 %2F' : '') + (dead.length ? '，' + dead.length + ' 条打不开' : '')];
  })(),
  /* 课件核对的「回改正文」：唯一匹配才改、有歧义/找不到就不改（fail-closed）。
     2026-09-30 用户发现：核对表算出「三项权重全错」，正文却还是错的 —— 因为核对只出报告。现在会回改。 */
  (function () {
    let F = null;
    try { F = require('./make-notes.js').applyHandoutPatches; } catch (e) { F = null; }
    if (typeof F !== 'function') return ['课件核对：回改正文（唯一匹配才改）', false, 'make-notes.js 没有导出 applyHandoutPatches'];
    const mk = () => ({
      notes: '## 考核构成\n- 编程作业：30%\n- 小组项目：20%\n',
      keyPoints: [{ t: '14:33', text: '考核构成：编程作业30%、小组项目20%' }],
      qa: [{ q: '迟交？', a: '最多7天，每天5%' }],
      terms: [{ en: 'x', zh: '30% 权重' }],
      bilingual: [],
    });
    /* ① 唯一匹配 → 必须改 */
    const d1 = mk();
    const r1 = F(d1, [{ item: '权重', verdict: 'fixed', patch: { find: '编程作业：30%', replace: '编程作业：20%' } }]);
    const ok1 = r1.applied.length === 1 && d1.notes.indexOf('编程作业：20%') >= 0 && d1.notes.indexOf('编程作业：30%') < 0;
    /* ② 同一个视图里出现两次 → **那个视图**不许改（真歧义）；其余视图照改，并如实报出没动的视图。
       ⚠ 口径 2026-10-06 收紧过：原来是「**所有视图加起来**只出现 1 次才改」——
         可同一个错值往往在正文/要点/问答/导图里各写了一遍，加起来 3-4 次 → 于是**全都不改**，
         只能报「有歧义，请人工」。实测一轮下来 12 处"需人工"，绝大多数就是这个原因，
         而那些恰恰是最该一次改全的。现在按**每个视图内部**判断。 */
    const d2 = mk();
    d2.notes = '## 考核构成\n- 小组项目：20%\n- 小组项目：30%\n';      /* 正文里 2 次 */
    const r2 = F(d2, [{ item: '权重', verdict: 'fixed', patch: { find: '小组项目', replace: '小组项目（改）' } }]);
    const ok2 = d2.notes.indexOf('小组项目（改）') < 0                  /* 有歧义的视图不动 */
      && r2.applied.length === 1 && r2.skipped.length === 1            /* 要点唯一→改；正文没动要报出来 */
      && d2.keyPoints[0].text.indexOf('小组项目（改）') >= 0;
    /* ②b 同一片段在多个视图里各出现一次 → **全都要改**（跨视图一次改全，这是本轮新能力） */
    const d2b = mk();
    d2b.mindmap = '考核\n  小组项目';
    const r2b = F(d2b, [{ item: '权重', verdict: 'fixed', patch: { find: '小组项目', replace: '小组项目（改）' } }]);
    const ok2b = r2b.applied.length === 3 && d2b.notes.indexOf('小组项目（改）') >= 0
      && d2b.keyPoints[0].text.indexOf('小组项目（改）') >= 0 && d2b.mindmap.indexOf('小组项目（改）') >= 0;
    /* ③ 找不到 → 不许改，且要在 note 里写明 */
    const d3 = mk();
    const row3 = { item: '不存在的片段', verdict: 'fixed', note: '原说明', patch: { find: '这段正文里没有', replace: 'x' } };
    const r3 = F(d3, [row3]);
    const ok3 = r3.applied.length === 0 && r3.skipped.length === 1 && /未自动回改/.test(row3.note);
    /* ④ same / notInSlides 行即使带补丁也不改 */
    const d4 = mk();
    const r4 = F(d4, [{ item: 'x', verdict: 'same', patch: { find: '编程作业：30%', replace: '编程作业：99%' } }]);
    const ok4 = r4.applied.length === 0 && d4.notes.indexOf('编程作业：30%') >= 0;
    /* ⑤ 改到要点上也算成功（正文里没有、要点里有唯一匹配） */
    const d5 = mk();
    const r5 = F(d5, [{ item: '要点', verdict: 'fixed', patch: { find: '编程作业30%、小组项目20%', replace: '编程作业20%、小组项目60%' } }]);
    const ok5 = r5.applied.length === 1 && d5.keyPoints[0].text.indexOf('编程作业20%') >= 0;
    /* ⑥ 残留复查：同一错值在表格里还在（正文另一处 30%、课件里没有这个数）→ 必须报出来 */
    const d6 = mk();
    d6.notes = '| 作业 | 30% |\n- 编程作业（coursework）：30%，要求编写函数\n';
    const r6 = F(d6, [{ item: '权重', verdict: 'fixed', fromAudio: '编程作业30%', fromSlides: 'Coursework: 20%',
      patch: { find: '编程作业（coursework）：30%，要求编写函数', replace: '编程作业（coursework）：20%，要求编写函数' } }]);
    const ok6 = r6.applied.length === 1 && r6.leftovers.length === 1 && r6.leftovers[0].value === '30%';
    return ['课件核对：回改正文（视图内唯一匹配才改，歧义/找不到就跳过；改完复查残留）',
      ok1 && ok2 && ok2b && ok3 && ok4 && ok5 && ok6,
      (ok1 ? '视图内唯一✅' : '视图内唯一❌') + (ok2 ? '／本视图歧义不改✅' : '／本视图歧义不改❌')
      + (ok2b ? '／跨视图一次改全✅' : '／跨视图一次改全❌') + (ok3 ? '／找不到不改✅' : '／找不到不改❌')
      + (ok4 ? '／非 fixed 不改✅' : '／非 fixed 不改❌') + (ok5 ? '／点到要点✅' : '／点到要点❌') + (ok6 ? '／残留报警✅' : '／残留报警❌')];
  })(),

  // --- 设计底线（来自 impeccable craft-floor 的机械项）---
  ['无"卡片堆叠"结构', !/class="card"/.test(h) && !/\.card\s*\{/.test(h)],
  ['无彩色 3px border-left', !/border-left:\s*[2-9]px/.test(h)],
  ['无 Unicode 符号冒充图标', !/[☐▾▸▪●○✓✗]/u.test(h.replace(/#raw[\s\S]*?<\/script>/, ''))],
  ['键盘可达（focus-visible）', h.includes(':focus-visible')],
  ['降低动效偏好', h.includes('prefers-reduced-motion')],
  ['多主题（≥6 套配色）', (h.match(/body\[data-theme="/g) || []).length >= 6, (h.match(/body\[data-theme="/g) || []).length + ' 套主题'],
  ['主题含浅色与深色', h.includes('color-scheme:light') && h.includes('color-scheme:dark')],
  ['主题切换控件 + 记忆', h.includes('class="sw"') && h.includes('applyTheme') && h.includes(':theme')],
  ['主题色板变量完整', ['--bg:', '--surface:', '--ink:', '--accent:', '--wash:', '--glow1:'].every(function(k){ return h.includes(k); })],
  ['导图分层底色', h.includes('ul.tree .lbl') && h.includes('--wash2')],
  ['问答卡渐变描边', h.includes('linear-gradient(135deg')],
  ['入场动效（可关闭）', h.includes('.reveal') && h.includes('prefers-reduced-motion')],
  ['存疑标记样式化', h.includes('.flag{')],
  ['英文原句可朗读（按钮数）', (h.match(/data-say="/g) || []).length >= 10, (h.match(/data-say="/g) || []).length + ' 个朗读按钮'],
  ['朗读脚本（Web Speech，英式优先）', h.includes('speechSynthesis') && h.includes('pickEnVoice') && h.includes("'en-GB'")],
  ['打印样式', h.includes('@media print')],
  ['跳转正文链接', h.includes('class="skip"')],
  ['单一强调色（只有 --accent 系）', !/--accent2|--accent-2/.test(h)],
  ['正文阅读宽度受控', /--col:\s*\d+ch/.test(h)],
];
let ok = true;
for (const [name, pass, extra] of checks) {
  if (!pass) ok = false;
  console.log((pass ? '[√] ' : '[X] ') + name + (extra ? '  (' + extra + ')' : ''));
}
console.log('\n文件：' + p);
console.log('大小：' + Math.round(h.length / 1024) + ' KB');
console.log(ok ? '\n结论：结构与设计底线检查全部通过' : '\n结论：有项目未通过');
process.exit(ok ? 0 : 1);

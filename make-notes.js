'use strict';
/*
 * 课堂笔记工作台 —— 把英授课转写稿加工成中文学习资料
 * 输入：录音稿/*.txt（听悟/腾讯会议/Buzz 导出的转写文本，或直接粘贴另存）
 * 输出：笔记/<课程>_<日期>.html（双击即开，含中英对照/精简笔记/术语表/思维导图/问答卡/待办）
 *
 * 用法：
 *   node make-notes.js                     自动取 录音稿/ 里最新的 .txt/.md
 *   node make-notes.js "录音稿\xxx.txt"     指定文件
 *   node make-notes.js --course "Machine Learning"   自定义课程名
 *   node make-notes.js --check             只测 API Key 与网络是否通
 *   node make-notes.js --mock              不联网，用内置样例数据测渲染链路
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const IN_DIR = path.join(ROOT, '录音稿');
const OUT_DIR = path.join(ROOT, '笔记');
const AUDIO_DIR = path.join(ROOT, '录音');
const WHISPER_ROOT = path.join(path.dirname(ROOT), 'whisper');
const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_CHARS = 18000;
let QUIET_MODE = false; // --quiet：不转发 whisper/ffmpeg 的过程输出

/* ---------------- 参数 ---------------- */
/* ---------------- 运行日志（便于事后定位失败原因） ---------------- */
let LOG_PATH = null;
function startLog() {
  try {
    const dir = path.join(ROOT, '日志');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, "0");
    LOG_PATH = path.join(dir, d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '_' +
      p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.log');
    fs.writeFileSync(LOG_PATH, "=== 课堂笔记管线日志 " + new Date().toLocaleString("zh-CN") + " ===\n", "utf8");
    const orig = console.log.bind(console);
    console.log = function () {
      const line = Array.prototype.map.call(arguments, (a) => (typeof a === "string" ? a : String(a))).join(" ");
      try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch (e) { /* 忽略 */ }
      orig.apply(null, arguments);
    };
    console.error = console.log;
  } catch (e) { /* 日志失败不影响主流程 */ }
}
function parseArgs(argv) {
  const o = { mock: false, check: false, where: false, file: null, course: null, audio: null, lang: 'en', only: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') o.mock = true;
    else if (a === '--check') o.check = true;
    else if (a === '--where') o.where = true;
    else if (a === '--force') o.force = true;
    else if (a === '--only') o.only = true;
    else if (a === '--stats') {
      const nx = argv[i + 1];
      o.stats = (nx && !nx.startsWith('--')) ? argv[++i] : true;
    }
    else if (a === '--no-vad') o.noVad = true;
    else if (a === '--no-sync') o.noSync = true;
    else if (a === '--no-pick') o.noPick = true;
    else if (a === '--slides') o.slides = argv[++i];
    else if (a === '--deck') o.deck = argv[++i];
    else if (a === '--pages') o.pages = argv[++i];
    else if (a === '--no-handout') o.noHandout = true;
    else if (a === '--no-handout-patch') o.noHandoutPatch = true;   // 只出核对表、不回改正文（默认是回改的）
    else if (a === '--no-audio-copy') o.noAudioCopy = true;
    else if (a === '--no-archive') o.noArchive = true;
    else if (a === '--all') o.all = true;
    else if (a === '--date') { o.date = argv[++i]; }
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--diarize') o.diarize = true;
    else if (a === '--no-diarize') o.diarize = false;
    else if (a === '--vad') o.vad = true;
    else if (a === '--keep-context') o.keepContext = true;
    else if (a === '--no-normalize') o.noNormalize = true;
    else if (a === '--no-chunk') o.noChunk = true;                       // 关掉长音频分段（回到整条一次的老路径）
    else if (a === '--chunk-sec') o.chunkSec = parseInt(argv[++i], 10) || CHUNK_SEC_DEFAULT;
    else if (a === '--build-prompt') o.buildPrompt = true;
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--course') o.course = argv[++i];
    else if (a === '--lang') o.lang = argv[++i] || 'en';
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--audio') {
      const nx = argv[i + 1];
      o.audio = (nx && !nx.startsWith('--')) ? argv[++i] : true;
    }
    else if (!a.startsWith('--')) o.file = a;
  }
  return o;
}

/* ---------------- 音频转写（本地 whisper.cpp） ---------------- */
function readConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}
function findUpward(startDir, pick) {
  let d = startDir;
  for (let i = 0; i < 6 && d && fs.existsSync(d); i++) {
    const hit = pick(d);
    if (hit) return hit;
    d = path.dirname(d);
  }
  return null;
}
function findExe(name, extra) {
  const cfg = readConfig();
  const list = [];
  if (cfg[name]) list.push(cfg[name]);
  if (extra) list.push.apply(list, extra);
  for (const c of list) if (fs.existsSync(c)) return c;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = ['.exe', ''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
/* ---------------- 术语提示自动累积（喂给 whisper 的初始提示） ---------------- */
function normCourse(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}
function buildPromptFile(courseHint) {
  const cfg = readConfig();
  const manualPath = cfg.termsManual || path.join(WHISPER_ROOT, 'terms-manual.txt');
  const promptPath = cfg.promptFile || path.join(WHISPER_ROOT, 'prompt.txt');
  const terms = new Map(); // lower -> {en, count, order}
  const hint = normCourse(courseHint);

  const add = (raw, order) => {
    const t = String(raw || '').replace(/[\r\n]+/g, ' ').trim();
    if (!t || t.length > 48) return;
    if (!/[A-Za-z]/.test(t)) return;
    const k = t.toLowerCase();
    const cur = terms.get(k);
    if (cur) { cur.count += 1; if (order < cur.order) cur.order = order; }
    else terms.set(k, { en: t, count: 1, order: order });
  };

  // 1) 手动词表最高优先（whisper\terms-manual.txt，每行一个词/短语，# 开头为注释）
  let manualCount = 0;
  if (fs.existsSync(manualPath)) {
    fs.readFileSync(manualPath, 'utf8').split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;
      add(s, -1);
      manualCount++;
    });
  }

  // 2) 历史笔记术语：本课程优先（order 0..），其它课程垫后（order +1000），避免跨课程污染
  const files = listFilesDeep(OUT_DIR, /\.json$/).map((f) => ({ f: f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }));
  files.sort((a, b) => b.t - a.t);
  let fromNotes = 0, sameCourse = 0;
  files.forEach((item, idx) => {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, item.f), 'utf8')); } catch (e) { return; }
    const c = normCourse(j.course);
    const isSame = !!(hint && c && (c.indexOf(hint) >= 0 || hint.indexOf(c) >= 0));
    if (isSame) sameCourse++;
    const order = isSame ? idx : (idx + 1000);
    (j.terms || []).forEach((x) => { if (x && x.en) { add(x.en, order); fromNotes++; } });
  });

  const ranked = Array.from(terms.values())
    .sort((a, b) => (a.order - b.order) || (b.count - a.count) || a.en.localeCompare(b.en));

  // whisper 初始提示上限约 n_text_ctx/2 tokens（224），英文 ≈4 字符/token → 保守取 800 字符
  const MAX = 800;
  const picked = [];
  let len = 0;
  for (const t of ranked) {
    if (len + t.en.length + 2 > MAX) break;
    picked.push(t.en);
    len += t.en.length + 2;
  }
  const content = picked.length ? ('Lecture terminology (English): ' + picked.join(', ') + '.') : '';
  fs.mkdirSync(WHISPER_ROOT, { recursive: true });
  fs.writeFileSync(promptPath, content, 'utf8');
  return { path: promptPath, terms: picked.length, chars: content.length, manualCount: manualCount, fromNotes: fromNotes, sameCourse: sameCourse, skipped: ranked.length - picked.length, courseHint: courseHint || '' };
}

function findVadModel() {
  const cfg = readConfig();
  const cands = [];
  if (cfg.vadModel) cands.push(cfg.vadModel);
  ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin'].forEach((m) => cands.push(path.join(WHISPER_ROOT, 'models', m)));
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

function findFfmpeg() {
  const guesses = [
    path.join(WHISPER_ROOT, 'bin', 'ffmpeg.exe'),
  ];
  // 自动在 whisper\src\ffmpeg 下找
  const srcDir = path.join(WHISPER_ROOT, 'src');
  if (fs.existsSync(srcDir)) {
    for (const top of fs.readdirSync(srcDir)) {
      if (!/ffmpeg/i.test(top)) continue;
      const base = path.join(srcDir, top);
      for (const sub of ['bin', '.']) {
        const p = path.join(base, sub, 'ffmpeg.exe');
        if (fs.existsSync(p)) guesses.push(p);
      }
      if (fs.existsSync(base)) {
        for (const d2 of fs.readdirSync(base)) {
          const p = path.join(base, d2, 'bin', 'ffmpeg.exe');
          if (fs.existsSync(p)) guesses.push(p);
        }
      }
    }
  }
  return findExe('ffmpeg', guesses);
}
function findWhisperCli() {
  const guesses = [];
  for (const variant of ['cuda', 'cublas', 'cpu']) {
    for (const sub of ['Release', '.']) {
      guesses.push(path.join(WHISPER_ROOT, 'src', variant, sub, 'whisper-cli.exe'));
    }
  }
  return findExe('whisper-cli', guesses);
}
function findModels() {
  const cfg = readConfig();
  const list = [];
  if (cfg.model) list.push(cfg.model);
  ['ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3-turbo-q8_0.bin', 'ggml-large-v3-turbo.bin', 'ggml-large-v3-q5_0.bin', 'ggml-medium-q5_0.bin', 'ggml-medium.bin', 'ggml-small.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin']
    .forEach((m) => list.push(path.join(WHISPER_ROOT, 'models', m)));
  const seen = {};
  return list.filter((m) => {
    if (!m || seen[m] || !fs.existsSync(m)) return false;
    seen[m] = 1;
    // 明显不完整的文件（<8MB 或 ggml 魔数不对）直接跳过，避免半截下载被当可用模型
    const st = fs.statSync(m);
    if (st.size < 8 * 1024 * 1024) { console.log('  （跳过过小的模型文件 ' + path.basename(m) + '，' + Math.round(st.size / 1048576) + 'MB）'); return false; }
    try {
      const fd = fs.openSync(m, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      // GGML 魔数 uint32 0x67676d6c，按文件字节序为 6c 6d 67 67（"lmgg"）
      if (!(buf[0] === 0x6c && buf[1] === 0x6d && buf[2] === 0x67 && buf[3] === 0x67)) {
        console.log('  （跳过损坏的模型文件 ' + path.basename(m) + '：GGML 魔数不匹配）');
        return false;
      }
    } catch (e) { return false; }
    return true;
  });
}
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|flac|ogg|wma|mp4|mov|opus|amr|3gp)$/i;
// 待处理音频清单：递归扫 录音\（跳过 已处理\），按时间从旧到新
function listInbox() {
  if (!fs.existsSync(AUDIO_DIR)) return [];
  const out = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((it) => {
      const q = path.join(dir, it.name);
      if (it.isDirectory()) { if (it.name !== '已处理') walk(q); return; }
      if (AUDIO_EXT.test(it.name)) out.push({ p: q, t: fs.statSync(q).mtimeMs });
    });
  };
  walk(AUDIO_DIR);
  out.sort((a, b) => a.t - b.t);
  return out.map((x) => x.p);
}
// 文件夹名：只去掉非法字符，保留空格（给人看的目录）
function safeDir(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 60) || "course"; }
// 去掉文件名末尾的日期，避免 <课程>_<日期>.m4a 再加日期变成双日期
function stripDate(s) { return String(s || "").replace(/[_\- ]?20\d{2}[-_.]\d{2}[-_.]\d{2}$/, ""); }
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

function pickAudio(fileArg) {
  if (fileArg) {
    const p = path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg);
    if (!fs.existsSync(p)) throw new Error('找不到音频：' + p);
    return p;
  }
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const list = listInbox();
  if (!list.length) throw new Error('录音\\ 里没有待处理的音频（支持 m4a/mp3/wav/aac/flac 等；已处理\\ 里的不算）');
  return list[list.length - 1]; // 最新的一个
}
function run(cmd, args, label, timeoutMs) {
  const { spawnSync } = require('child_process');
  const t0 = Date.now();
  const opts = { stdio: QUIET_MODE ? 'ignore' : 'inherit' };
  if (timeoutMs) opts.timeout = timeoutMs;
  const r = spawnSync(cmd, args, opts);
  const secs = (Date.now() - t0) / 1000;
  if (r.error && r.error.code === 'ETIMEDOUT') {
    throw new Error(label + ' 超过 ' + Math.round(timeoutMs / 1000) + ' 秒仍未完成（判定为卡死，已终止）');
  }
  if (r.status !== 0) throw new Error(label + ' 执行失败（退出码 ' + r.status + '）');
  return secs;
}
function wavDuration(wavPath) {
  try {
    const st = fs.statSync(wavPath);
    return Math.max(0, (st.size - 44) / (16000 * 2)); // 16kHz 单声道 16bit
  } catch (e) { return null; }
}
/* ---------------- 音频体检 + 自适应参数（针对"每节课收音都不一样"） ---------------- */
function analyzeWav(wavPath) {
  const st = fs.statSync(wavPath);
  const dataStart = 44; // 我们自己用 ffmpeg 生成的 PCM wav，标准 44 字节头
  const bytes = st.size - dataStart;
  const n = Math.floor(bytes / 2);
  const fd = fs.openSync(wavPath, 'r');
  const buf = Buffer.alloc(bytes);
  fs.readSync(fd, buf, 0, bytes, dataStart);
  fs.closeSync(fd);
  const frame = 320; // 20ms @16kHz
  const rms = [];
  for (let i = 0; i + frame <= n; i += frame) {
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const s = buf.readInt16LE((i + j) * 2) / 32768;
      sum += s * s;
    }
    rms.push(Math.sqrt(sum / frame));
  }
  const db = (v) => 20 * Math.log10(Math.max(v, 1e-6));
  const sorted = rms.slice().sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] || 0;
  const noise = pct(0.10), med = pct(0.50), speech = pct(0.92);
  // 静音判定：只与"该录音自身的语音电平"挂钩（用噪声底×4 会把持续有背景声的录音误判成 98% 静音）
  const speechThresh = Math.max(speech * 0.15, 0.0015);
  const silenceRatio = rms.length ? rms.filter((v) => v < speechThresh).length / rms.length : 1;
  return {
    durationSec: n / 16000,
    medianDb: db(med),
    noiseFloorDb: db(noise),
    speechLevelDb: db(speech),
    snrDb: db(speech) - db(noise),
    silenceRatio: silenceRatio,
  };
}

const PROFILES = {
  quiet_farfield: { name: 'quiet_farfield', filter: 'highpass=f=100,dynaudnorm=f=200:g=15:p=0.9', vad: false, desc: '远场弱电平：强动态增益归一化' },
  noisy_farfield: { name: 'noisy_farfield', filter: 'highpass=f=100,afftdn=nf=-25,dynaudnorm=f=200:g=15:p=0.9', vad: false, desc: '低信噪比远场：降噪＋强归一化' },
  normal: { name: 'normal', filter: 'highpass=f=100,dynaudnorm=f=150:g=8:p=0.9', vad: false, desc: '常规电平：轻度归一化' },
  clean: { name: 'clean', filter: 'highpass=f=80', vad: false, desc: '近场清晰：仅去低频噪声' },
  long_silence: { name: 'long_silence', filter: 'highpass=f=100,dynaudnorm=f=200:g=15:p=0.9', vad: true, desc: '长段静音且信噪比尚可：启用 VAD 跳过静音' },
};

// 依据体检结果排出"先试谁"的顺序；后面的作为自动重试的备选
function decideProfiles(stats, opts) {
  if (opts.profile) {
    const p = PROFILES[opts.profile];
    if (!p) throw new Error('未知参数档：' + opts.profile + '（可选 ' + Object.keys(PROFILES).join('/') + '）');
    return [p];
  }
  const order = [];
  if (stats.snrDb < 8) order.push(PROFILES.noisy_farfield);
  if (stats.medianDb < -30) order.push(PROFILES.quiet_farfield);
  if (stats.silenceRatio > 0.45 && stats.snrDb >= 12 && stats.medianDb > -32) order.push(PROFILES.long_silence);
  order.push(PROFILES.normal, PROFILES.quiet_farfield, PROFILES.noisy_farfield, PROFILES.clean, PROFILES.long_silence);
  const seen = {};
  return order.filter((p) => (p && !seen[p.name]) ? (seen[p.name] = 1) : false);
}

// 质量打分：字/分钟越高越好，出现大段重复则重罚
function scoreText(text, durationSec) {
  const cpm = durationSec > 0 ? text.length / (durationSec / 60) : 0;
  const words = text.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const counts = new Map();
  for (let i = 0; i + 8 <= words.length; i++) {
    const k = words.slice(i, i + 8).join(' ');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let top = 0, topPhrase = '';
  counts.forEach((v, k) => { if (v > top) { top = v; topPhrase = k; } });
  const score = cpm - 60 * Math.max(0, top - 3);
  return { chars: text.length, cpm: cpm, top: top, topPhrase: topPhrase, score: score };
}

/* ---------------- 时间戳：解析 srt、生成紧凑的带时间转写稿 ---------------- */
function tsToSec(s) {
  const m = String(s || '').match(/(\d+):(\d{2}):(\d{2})/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  const m2 = String(s || '').match(/(\d+):(\d{2})/);
  if (m2) return (+m2[1]) * 60 + (+m2[2]);
  return null;
}
function fmtTs(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? (h + ':' + p(m) + ':' + p(ss)) : (p(m) + ':' + p(ss));
}
function parseSrt(content) {
  const out = [];
  const blocks = String(content || '').replace(/\r/g, '').split('\n\n');
  for (const b of blocks) {
    const lines = b.split('\n').filter((x) => x.trim());
    if (!lines.length) continue; // 曾经写成 return：遇到一个空块就会静默丢掉后面全部内容
    const tm = lines.find((l) => l.indexOf('-->') >= 0);
    if (!tm) continue;
    const halves = tm.split('-->');
    const start = tsToSec(halves[0]);
    const end = tsToSec(halves[1]);
    const text = lines.filter((l) => l.indexOf('-->') < 0 && !/^\d+$/.test(l.trim())).join(' ').replace(/\s+/g, ' ').trim();
    if (start == null || !text) continue;
    out.push({ start: start, end: (end == null || end < start ? start : end), text: text });
  }
  return out;
}
// 把 srt 段合并成 ~45 秒的窗口，输出 [mm:ss] 文本 的紧凑稿（省 token，且够定位）
function buildTimestamped(segs) {
  const lines = [];
  let cur = null;
  for (const s of segs) {
    if (!cur || s.start - cur.start > 45) {
      if (cur) lines.push('[' + fmtTs(cur.start) + '] ' + cur.text);
      cur = { start: s.start, text: s.text };
    } else {
      cur.text += ' ' + s.text;
    }
  }
  if (cur) lines.push('[' + fmtTs(cur.start) + '] ' + cur.text);
  return lines.join('\n');
}

/* ---------------- 转写稿质检：抓「静音处编话」这类幻觉 ----------------
 * 实测背景（2026-09-26，38.3 分钟讲座）：0:00–1:40 整段是编造的（英文稿里还蹦出中文「完成」），
 * 而内置质量闸门只统计「同一片段重复次数」（该稿最高 ×2）→ 判了「✓ 质量达标」。
 * 幻觉的花样是变的，靠重复计数抓不到；这里改用四个时间轴信号交叉判断。 */
function qaSegments(segs) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z\s']/g, '').replace(/\s+/g, ' ').trim();
  const wc = (s) => String(s || '').replace(/[^\w\s']/g, ' ').split(/\s+/).filter(Boolean).length;
  const cnt = {};
  segs.forEach((g) => {
    const k = norm(g.text);
    // 只统计 ≥2 个词的重复：单词重复（"Yeah." "Okay."）是口语常态，不是幻觉指纹
    if (k && k.split(' ').length >= 2) cnt[k] = (cnt[k] || 0) + 1;
  });
  const loops = Object.keys(cnt).filter((k) => cnt[k] >= 3).sort((a, b) => cnt[b] - cnt[a]);
  const loopSet = {};
  loops.forEach((k) => { loopSet[k] = 1; });
  const short = segs.filter((g) => wc(g.text) <= 4 && g.text.length < 24);
  const cjk = segs.filter((g) => /[\u4e00-\u9fff]/.test(g.text));
  const gaps = [];
  for (let i = 1; i < segs.length; i++) {
    const d = segs[i].start - segs[i - 1].end;
    if (d > 8) gaps.push({ at: segs[i - 1].end, dur: d });
  }
  const last = segs.length ? segs[segs.length - 1] : { start: 0, end: 0 };
  return {
    total: segs.length, dur: last.end || last.start, norm: norm, loopSet: loopSet,
    short: short.length, loops: loops, cjkCount: cjk.length, cjkFirst: cjk.length ? cjk[0] : null,
    gaps: gaps,
  };
}
// ok / mid / high —— 只在真有信号时才吭声，避免天天狼来了
function qaVerdict(qa) {
  if (qa.cjkCount >= 2 || qa.loops.length >= 3) return 'high';
  if (qa.cjkCount > 0 || qa.loops.length > 0 || qa.gaps.length >= 3) return 'mid';
  return 'ok';
}
function printQa(qa) {
  const lv = qaVerdict(qa);
  if (lv === 'ok') return;
  console.log('  ⚠ 转写稿质检：' + (lv === 'high' ? '疑似幻觉较多' : '有可疑区段')
    + '（全长 ' + (qa.dur / 60).toFixed(1) + ' 分钟）');
  if (qa.cjkCount) console.log('      · 英文稿里混入中文 ' + qa.cjkCount + ' 段，例：' + fmtTs(qa.cjkFirst.start) + '「' + qa.cjkFirst.text.slice(0, 40) + '」');
  if (qa.loops.length) console.log('      · 同一句重复 ≥3 次 ' + qa.loops.length + ' 种：' + qa.loops.slice(0, 3).map((k) => '「' + k.slice(0, 28) + '」').join(' '));
  if (qa.gaps.length >= 3) console.log('      · >8 秒空白 ' + qa.gaps.length + ' 处（合计 ' + Math.round(qa.gaps.reduce((a, x) => a + x.dur, 0)) + ' 秒）——空白处最容易凭空编话');
  console.log('      · 深度体检：node _verify-transcript.js "录音稿\\<课程>\\<文件>.srt"');
}
/* 只剔除两类「铁证」幻觉，宁少勿多：
 *   ① 同一句重复 ≥3 次 —— 幻觉循环的指纹；② 英文稿里出现中文字符 —— 物理上不可能。
 * 其余可疑段落一律保留（小组讨论里 "Yeah." 这类短句是真实对话，不能误删）。 */
function dropHallucinated(segs, lang) {
  const isEn = !lang || String(lang).toLowerCase().indexOf('en') === 0;
  const qa = qaSegments(segs);
  const kept = [], dropped = [];
  segs.forEach((g) => {
    if (qa.loopSet[qa.norm(g.text)]) { dropped.push(g); return; }
    if (isEn && /[\u4e00-\u9fff]/.test(g.text)) { dropped.push(g); return; }
    kept.push(g);
  });
  return { kept: kept, dropped: dropped, qa: qa };
}

/* ---------------- 术语勘误表：把 whisper 听错的词机械改回来 ----------------
 * 实测背景（2026-09-29，DEMO1006M）：讲者说的 KRR 被转写成 "AR-10s"，进了笔记正文与学习台卡片。
 * 幻觉是「编出来的话」，这个不一样 —— 是**真实说过的内容被写错**，所以纠正它不违背「转写稿原样保留」：
 * ① 只做用户自己维护的机械替换表（勘误表.json），零模型参与；② 每次都打印替换了什么、几处，不静默改；
 * ③ 正在解释这个错词的句子（如笔记「课件核对」里的「转写听错：…不是"AR-10s"」）整句跳过，否则自相矛盾。 */
const ERRATA_PATH = path.join(ROOT, '勘误表.json');
function loadErrata() {
  if (!fs.existsSync(ERRATA_PATH)) return { rules: [], skip: [] };
  try {
    const j = JSON.parse(fs.readFileSync(ERRATA_PATH, 'utf8'));
    const rules = (Array.isArray(j.replace) ? j.replace : [])
      .filter((x) => x && x.from && x.to && x.enabled !== false)
      .map((x) => ({
        from: String(x.from), to: String(x.to), note: x.note || '',
        re: new RegExp(String(x.from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), x.ci ? 'gi' : 'g'),
      }));
    const skip = (Array.isArray(j.skipIfNear) ? j.skipIfNear : []).map(String).filter(Boolean);
    return { rules: rules, skip: skip };
  } catch (e) {
    console.log('  ⚠ 勘误表.json 读不出来（本次不做替换，不影响其它流程）：' + (e && e.message ? e.message : e));
    return { rules: [], skip: [] };
  }
}
function applyErrata(text, rules) {
  const E = rules || loadErrata();
  const hits = [];
  let out = String(text == null ? '' : text);
  if (!E.rules || !E.rules.length) return { text: out, hits: hits };
  for (const r of E.rules) {
    out = out.replace(r.re, (m, ...rest) => {
      const off = rest[rest.length - 2]; // 回调倒数第二个参数＝匹配位置
      const win = out.slice(Math.max(0, off - 30), off + String(m).length + 30);
      if (E.skip.some((s) => win.indexOf(s) >= 0)) return m; // 正在解释这个错词的句子不动
      hits.push({ from: m, to: r.to, rule: r.from });
      return r.to;
    });
  }
  return { text: out, hits: hits };
}
function summarizeErrata(hits) {
  const by = {};
  (hits || []).forEach((h) => { const k = h.from + ' → ' + h.to; by[k] = (by[k] || 0) + 1; });
  return Object.keys(by).map((k) => k + ' ×' + by[k]).join('，');
}
/* 转写一落盘就纠正（.txt 与 .srt 一起改）：笔记、学习台卡片、以后 grep 回原文都对得上 */
function applyErrataToFiles(paths) {
  const E = loadErrata();
  const changed = [];
  for (const p of paths) {
    if (!p || !fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    const res = applyErrata(raw, E);
    if (!res.hits.length) continue;
    fs.writeFileSync(p, res.text, 'utf8');
    changed.push({ file: path.basename(p), n: res.hits.length, what: summarizeErrata(res.hits) });
  }
  return changed;
}

/* ---------------- 发言人分离（sherpa-onnx，离线，需 Python 3.11） ---------------- */
/* ---------------- 课程名册：自动命名，免手动 ---------------- */
const COURSE_MAP = path.join(ROOT, '课程.json');
function loadCourseMap() { try { return JSON.parse(fs.readFileSync(COURSE_MAP, "utf8")); } catch (e) { return {}; } }
function saveCourseMap(m) { try { fs.writeFileSync(COURSE_MAP, JSON.stringify(m, null, 2), "utf8"); } catch (e) { /* 忽略 */ } }
function safeName(s) { return String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "course"; }

/* ---------------- 目录布局：一节课一个日期文件夹（2026-09-29 用户要求） ----------------
 * 笔记 / 录音稿 / 音频 / 录音·已处理 四处都按 <课程>/<上课日期>/ 放：
 * 「同一节课的 4 类产物」永远在同一个日期文件夹里，四个目录结构一致（这是原有纪律，只是多了一层）。
 * 文件夹名＝上课日期（文件名里的日期或 --date 给的），拿不到才退回生成日期。
 * 备份文件统一进 <课程>/_备份/（文件名不变，仍能一眼看出是谁的哪次备份）。 */
function layoutOf(courseDir, day) {
  return {
    day: day,
    note: path.join(OUT_DIR, courseDir, day),
    transcript: path.join(IN_DIR, courseDir, day),
    audio: path.join(ROOT, '音频', courseDir, day),
    archive: path.join(AUDIO_DIR, '已处理', courseDir, day),
    backup: path.join(OUT_DIR, courseDir, '_备份'),
    courseRoot: path.join(OUT_DIR, courseDir),
  };
}
/* 相对链接：从 fromDir 指向 toPath，**逐段编码**。
   ⚠ 不能整体 encodeURIComponent —— 那会把 / 变成 %2F，浏览器不当路径分隔符用 → 链接点不开。
   （2026-09-29 实测：周复习台的「打开当日笔记」链接就是这么坏的。）*/
function relHref(fromDir, toPath) {
  return path.relative(fromDir, toPath).split(path.sep).filter(Boolean).map(encodeURIComponent).join('/');
}
/* 一门课下所有笔记 html（含日期子文件夹；跳过 _备份）——「同门课其它讲次」要用 */
function listNoteHtmls(courseRoot) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2 || !fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) { if (it.name !== '_备份') walk(q, depth + 1); }
      else if (it.name.toLowerCase().endsWith('.html')) out.push(q);
    });
  };
  walk(courseRoot, 0);
  return out;
}

/* 打开选卡页（本机一次性 HTTP 服务，只绑 127.0.0.1；用户点确认后写完清单就自己退出）。
 * 之所以要起服务：file:// 页面不能写磁盘，勾选结果必须靠一个本地接口落盘。 */
function openPicker() {
  try {
    require('child_process').spawn(process.execPath, [path.join(ROOT, 'pick-cards.js'), '--latest'],
      { detached: true, stdio: 'ignore' }).unref();
    console.log('   选卡页已打开：不想加的卡取消勾选 → 点「确认并写入学习台」（想跳过这一步就加 --no-pick）');
  } catch (e) {
    console.log('   （选卡页没能打开，可稍后双击 选卡.cmd：' + (e && e.message ? e.message : e) + '）');
  }
}
// 优先级：命令行 > 音频所在子文件夹名 > 课程.json 历史 > AI 识别 > 音频文件名
// AI 偶尔会回「未指定/未知」这类占位词，不能拿它当文件名（实测出现过）
const PLACEHOLDER = /^(未指定|未命名|未知|不确定|不明确|无法确定|无|无标题|待定|略|N\/?A|None|Unknown|Untitled|TBD)$/i;
function plausibleCourse(s) {
  const v = String(s || "").trim();
  if (v.length < 2 || v.length > 40) return false;
  if (PLACEHOLDER.test(v)) return false;
  if (/未指定|无法确定|不明确|未知课程|无具体/.test(v)) return false;
  return true;
}

/* 课程表时间线索（模块级：buildMessages 要用；TT_SLOT 只给主流程用） */
let TT_HINT = '', TT_SLOT = null;

/* ---------------- 课程表：按时间 + 按内容认课 ---------------- */
const TIMETABLE = path.join(ROOT, '课程表.json');
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function loadTimetable() {
  try {
    const j = JSON.parse(fs.readFileSync(TIMETABLE, 'utf8'));
    return {
      termStart: j.termStart || '',
      teaching: j.teaching || {},
      weekEpoch: j.weekEpoch || {},
      modules: Array.isArray(j.modules) ? j.modules.filter((m) => m && (m.name || m.code)) : [],
      slots: Array.isArray(j.slots) ? j.slots.filter((s) => s && s.day && s.start) : [],
    };
  } catch (e) { return { termStart: '', teaching: {}, weekEpoch: {}, modules: [], slots: [] }; }
}
function moduleLabel(m) { return String(((m && m.code) ? m.code + ' ' : '') + ((m && m.name) || '')).trim(); }
// 课时的显示名：优先 slot 自带 course，否则按 code 去模块表里找
function slotLabel(slot, tt) {
  if (!slot) return '';
  if (slot.course) return String(slot.course);
  const t0 = tt || loadTimetable();
  const code = String(slot.code || '').toUpperCase();
  const m = t0.modules.find((x) => String(x.code || '').toUpperCase() === code);
  return m ? moduleLabel(m) : String(slot.code || '');
}
// 9-12 月算第 1 学期，1-5 月算第 2 学期，6-8 月（暑期/项目期）不做学期过滤
// AI 给的课名是否指向课表里的某个模块（含代码即算命中，容错名称写法差异）
function matchesTimetable(name) {
  const tt = loadTimetable();
  const s = String(name || "").trim();
  if (!s || !tt.modules.length) return "";
  const norm = (x) => String(x || "").toLowerCase().replace(/[\s.&,;:()\-_/]+/g, "");
  const nrm = norm(s);
  for (const m of tt.modules) {
    const code = String(m.code || "").toLowerCase();
    if (!code) continue;
    if (nrm.indexOf(code) >= 0 || nrm === norm(moduleLabel(m))) return moduleLabel(m);
  }
  // 也认「场次名」（迎新周场次等）；noName 的答疑/联合实验课不算，避免拿它当课名
  for (const s of tt.slots) {
    const lab = String(s.course || "").trim();
    if (s.noName || lab.length < 6) continue;
    const nl = norm(lab);
    if (nrm === nl || (nl.length >= 6 && nrm.indexOf(nl) >= 0)) return lab;
  }
  return "";
}
function semOfDate(d) { const m = d.getMonth() + 1; return (m >= 9 && m <= 12) ? 1 : (m >= 1 && m <= 5) ? 2 : 0; }
// 交给大模型的课程表块
function timetableBlock(hint) {
  const tt = loadTimetable();
  if (!tt.modules.length && !tt.slots.length) return '';
  const out = ['【本学期课程表（判定 course 的权威依据）】'];
  tt.modules.forEach((m) => {
    out.push('- ' + moduleLabel(m) + (m.sem ? '（第 ' + m.sem + ' 学期）' : '') + (m.full ? '：' + m.full : ''));
  });
  if (tt.slots.length) {
    out.push('【这些课有固定时间（星期 起-止，周次）】');
    tt.slots.forEach((s) => {
      out.push('- ' + slotLabel(s, tt) + '：' + s.day + ' ' + s.start + '-' + s.end
        + (s.weeks ? '（第 ' + s.weeks + ' 周）' : '') + (s.room ? '，' + s.room : ''));
    });
  }
  const tw = [];
  Object.keys(loadTimetable().teaching || {}).forEach((k) => {
    const r = loadTimetable().teaching[k];
    if (r && r.length >= 2) tw.push('第 ' + k + ' 学期教学期 ' + r[0] + ' 至 ' + r[1]);
  });
  if (tw.length) out.push('（' + tw.join('；') + '）');
  if (hint) out.push('（这条录音的时间线索：' + hint + '；仅供参考，与内容冲突时以内容为准）');
  out.push([
    '判定 course，按下面顺序（宁可自起一个准确的名字，也不要硬套一个对不上的模块）：',
    '1) 内容是某一门模块课的教学（讲该学科的知识点、原理、方法，或布置作业/考核）→ 原样填该门的「代码 + 名称」；',
    '2) 内容是迎新周/导览类场次（学院欢迎会、服务介绍、语言支持介绍、学习方法讲座、行政说明、导师见面等）→ 若上表里有对应的「迎新周 · …」场次，就填那个场次名；',
    '3) 其余（学术讲座、社团活动、非本专业内容、听不清主题）→ 按内容自己起一个准确简短的中文名（不超过 16 字）。',
    '注意：模块课（如 Communication for EPS 这类正式课程）与「语言中心服务介绍」是两回事，不要因为都跟英语有关就填成模块代码。',
  ].join('\n'));
  return out.join('\n');
}
function toMin(hhmm) { const m = String(hhmm || '').match(/^(\d{1,2})[:.](\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
// 周次锚点：epoch 可为 "YYYY-MM-DD"（等价于第 1 周）或 { from, week }；为空则不做周次过滤
function weekNoOf(d, epoch) {
  if (!epoch) return null;
  const from = typeof epoch === 'string' ? epoch : epoch.from;
  const base = (typeof epoch === 'string') ? 1 : (epoch.week || 1);
  if (!from) return null;
  const a = new Date(from + 'T00:00:00');
  if (isNaN(a)) return null;
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return base + Math.floor(Math.round((b - a) / 86400000) / 7);
}
// 是否在官方教学窗口内（窗口外的录音不按时间匹配，避免假期/暑期误配）
function inTeaching(d, sem, tt) {
  const w = (tt || loadTimetable()).teaching || {};
  const r = w[String(sem)];
  if (!r || r.length < 2) return sem !== 0; // 没配窗口时：暑期(6-8月)一律不匹配
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return day >= new Date(r[0] + 'T00:00:00').getTime() && day <= new Date(r[1] + 'T23:59:59').getTime();
}
function weeksMatch(spec, wk) {
  if (!spec || wk == null) return true; // 没填 termStart 时不做周次过滤（避免误杀）
  for (const raw of String(spec).split(',')) {
    const s = raw.trim();
    const r = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (r) { if (wk >= +r[1] && wk <= +r[2]) return true; continue; }
    if (/^\d+$/.test(s) && +s === wk) return true;
    if (/^(odd|单周)$/i.test(s) && wk % 2 === 1) return true;
    if (/^(even|双周)$/i.test(s) && wk % 2 === 0) return true;
  }
  return false;
}
// 中文时间写法：「11点到1点」「11点」「9点半」「9点05分」——手机录音常这么起名
// （用户的习惯是「录音_20260929_11点到1点.m4a」，旧正则认不出，害得每节课都只能走 AI 认课）
const ZH_TIME = /(\d{1,2})\s*[点時时]\s*(半|\d{1,2})?\s*分?/;
/* 中文数字 → 阿拉伯数字（只覆盖 0-29，够表达小时与分钟了） */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumToInt(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t === '十') return 10;
  let m = t.match(/^十([一二三四五六七八九])$/);                    /* 十一…十九 */
  if (m) return 10 + CN_DIGIT[m[1]];
  m = t.match(/^([一二三四五六七八九])十([一二三四五六七八九])?$/);   /* 二十…二十九 */
  if (m) return CN_DIGIT[m[1]] * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  m = t.match(/^([零一二两三四五六七八九])$/);          /* ⚠ 别漏「两」：凌晨两点/两点半都用它 */
  return m ? CN_DIGIT[m[1]] : null;
}
/* 把「下午三点」「晚上7点」「上午九点半」规整成 24 小时制的数字写法，好让 ZH_TIME 直接吃。
   为什么需要（2026-10-01 用户实际命名）：`录音_2026.9.30_下午三点到四点.m4a`
   —— 旧 ZH_TIME 只认阿拉伯数字，于是只解析出**日期、没有时刻** → 用不上课表时段匹配 → 退回 AI 认课。
   规整后 →「15点到四点」→ ZH_TIME 取到 15:00 → 课表里 DEMO1001M 周三 15:00 那节 → **确定性认课，零调用**。
   注意：只吃第一个「N点」（即区间的**开始**），「A点到B点」取 A —— 与既有行为一致。 */
const CN_TIME_FULL = /(上午|早上|早晨|凌晨|中午|下午|傍晚|晚上|夜里)?\s*([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\s*[点時时]\s*(半|一刻|三刻|[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})?\s*分?/g;
function normalizeCnTime(s) {
  return String(s == null ? '' : s).replace(CN_TIME_FULL, (full, period, hRaw, mRaw) => {
    let h = cnNumToInt(hRaw);
    if (h === null || h > 23) return full;                          /* 认不出/超范围就原样留着 */
    /* 分钟：半=30、一刻=15、三刻=45；其余按数字读。
       ⚠「一刻」必须排在中文数字类**前面**，否则「一」会被当成 1 分（实测踩过）。 */
    let mi;
    if (mRaw === '半') mi = 30;
    else if (mRaw === '一刻') mi = 15;
    else if (mRaw === '三刻') mi = 45;
    else if (mRaw) { mi = cnNumToInt(mRaw); if (mi === null || mi > 59) mi = 0; }
    else mi = 0;
    if (period) {
      if (/下午|傍晚|晚上|夜里/.test(period) && h < 12) h += 12;
      else if (/上午|早上|早晨|凌晨/.test(period) && h === 12) h = 0;
      else if (period === '中午' && h < 12) h = 12;
    }
    return h + '点' + (mi ? mi + '分' : '');
  });
}
// 推断这节课发生的时间：优先文件名里的日期，否则退回文件修改时间（多为拷贝时间，仅供参考）
function parseWhen(filePath, nameOverride) {
  const base = String(nameOverride || path.basename(filePath || ''));
  /* ⚠ 月/日要允许**一位数**：手机录音常写成「录音_2026-9-29_17点-18点.m4a」，
     原来写死 (\d{2}) 认不出来 → 整条退回文件修改时间（＝拷贝时间）。
     2026-09-29 实测：DEMO1009M 那节课的日期就是从 mtime 猜的，只因为当天拷贝才碰巧对。 */
  const m = base.match(/(20\d{2})[-_.]?(\d{1,2})[-_.]?(\d{1,2})(?:[-_. T]?(\d{2})[-_.:]?(\d{2}))?/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    let hh = m[4] ? +m[4] : null, mi = m[5] ? +m[5] : 0, hasTime = !!m[4];
    if (!hasTime) {
      const zh = normalizeCnTime(base).match(ZH_TIME);
      if (zh) {
        const H = +zh[1];
        if (H >= 0 && H <= 23) {
          hh = H;
          mi = zh[2] === '半' ? 30 : (zh[2] && /^\d+$/.test(zh[2]) ? Math.min(59, +zh[2]) : 0);
          hasTime = true;
        }
      }
    }
    const d = new Date(+m[1], +m[2] - 1, +m[3], hh == null ? 12 : hh, mi);
    if (!isNaN(d)) return { date: d, from: hasTime ? '文件名里的日期与时间' : '文件名里的日期', hasTime: hasTime };
  }
  if (filePath && fs.existsSync(filePath)) return { date: fs.statSync(filePath).mtime, from: '文件修改时间（很可能是拷贝时间，不准）', hasTime: true };
  return null;
}
// 按星期 + 时间落在哪一节去课表里找
function matchSlot(when) {
  if (!when || !when.hasTime) return null;
  const tt = loadTimetable();
  if (!tt.slots.length) return null;
  const d = when.date;
  const dayKey = DAY_KEYS[d.getDay()];
  const mins = d.getHours() * 60 + d.getMinutes();
  const sem = semOfDate(d);
  if (!inTeaching(d, sem, tt)) return null; // 假期/暑期：不做时间匹配，交给 AI 按内容判
  const wkMap = tt.weekEpoch || {};
  let ep = wkMap[String(sem)];
  if (ep === undefined && Object.keys(wkMap).length === 0) ep = tt.termStart || null; // 只有 termStart 的老配置
  if (ep === undefined) ep = null;
  const wk = weekNoOf(d, ep);
  const hits = [];
  tt.slots.forEach((s) => {
    if (s.sem && sem && +s.sem !== sem) return;
    const md = String(s.day || '').toLowerCase().slice(0, 3);
    if (md && md !== dayKey) return;
    const st = toMin(s.start), en = toMin(s.end);
    if (st == null || !weeksMatch(s.weeks, wk)) return;
    if (mins < st - 40 || mins > (en != null ? en + 25 : st + 150)) return;
    hits.push({ slot: s, diff: Math.abs(mins - st) });
  });
  if (!hits.length) return null;
  hits.sort((x, y) => x.diff - y.diff);
  const best = hits[0];
  const labels = [];
  hits.forEach((h) => { const l = slotLabel(h.slot, tt); if (labels.indexOf(l) < 0) labels.push(l); });
  // 联合实验课（noName）不参与命名，只作为时间线索
  const ambiguous = best.slot.noName ? Math.max(1, labels.length - 1) : labels.length - 1;
  return { slot: best.slot, label: slotLabel(best.slot, tt), from: when.from, week: wk, others: ambiguous };
}

/* 已存在的课程文件夹里，有没有和 name「规范化后相同」的？
   为什么需要（2026-10-01 实测踩过）：`--file` 重跑时课程名取自**转写稿文件名**，而那个名字里的空白
   早被消毒成下划线了（`迎新周_·_个人导师见面会（导师）`），于是**另起了一个文件夹** ——
   音频/录音稿的兄弟目录对不上 → 笔记里**没有播放器**、体检报「四处一致 缺：录音稿、音频、已处理」。
   命中就把名字换成那个已存在的真名，从根上杜绝重复建目录。
   顺序固定（按名字排序）以保证确定性。*/
function existingCourseDir(name) {
  const want = safeName(name).toLowerCase();
  if (!want) return '';
  const bases = [OUT_DIR, IN_DIR, path.join(ROOT, '音频'), path.join(ROOT, '录音', '已处理')];
  for (const b of bases) {
    try {
      const hit = fs.readdirSync(b, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '_备份' && d.name !== '_待归档'
          && safeName(d.name).toLowerCase() === want)
        .map((d) => d.name).sort()[0];
      if (hit) return hit;
    } catch (e) { /* 目录不在就算了 */ }
  }
  return '';
}
function resolveCourseName(o) {
  const r = resolveCourseNameRaw(o);
  const ex = existingCourseDir(r.name);
  if (ex && ex !== r.name) {
    return { name: ex, from: r.from + '，但对齐到**已存在**的课程文件夹「' + ex + '」（避免另起一个消毒名目录）' };
  }
  return r;
}
function resolveCourseNameRaw(o) {
  if (o.argsCourse) return { name: o.argsCourse, from: "命令行 --course" };
  // 录音时间唯一命中课表：这是最客观的依据，优先于文件夹名（文件夹常被用作「10月」「未整理」这类组织用途）
  if (o.timetableName) return { name: o.timetableName, from: "课表按时段匹配（唯一）" };
  if (o.audioPath) {
    const map = loadCourseMap();
    const key = path.basename(o.audioPath);
    if (map[key]) return { name: map[key], from: "课程.json 里记住的名字（可手工订正）" };
    const parent = path.basename(path.dirname(path.resolve(o.audioPath)));
    if (parent && parent !== path.basename(AUDIO_DIR) && parent !== "已处理" && parent !== path.basename(ROOT)) {
      const hit = matchesTimetable(parent);
      return hit ? { name: hit, from: '文件夹名（已对齐课表）' }
        : { name: parent, from: "文件夹名（把音频丢进 录音\\" + parent + "\\ 即可）" };
    }
  }

  // 只重跑笔记这一步（没有音频）时，默认沿用转写稿的名字，否则每次重跑都会多出一个新文件；
  // 但若 AI 已认出课表里的模块，模块名是确定性的（同一份课表每次都一样），用它更准且仍然稳定
  if (!o.audioPath && o.transcriptName) {
    const hit = o.aiCourse ? matchesTimetable(o.aiCourse) : "";
    if (hit) return { name: hit, from: "AI 按内容认出课表模块（重跑仍稳定）" };
    return { name: stripDate(o.transcriptName) || o.transcriptName, from: "转写稿文件名（重跑不换名）" };
  }

  if (o.aiCourse && plausibleCourse(o.aiCourse)) return { name: o.aiCourse, from: "AI 识别（大模型读内容起名）" };
  if (o.audioPath) { const b0 = path.basename(o.audioPath).replace(/\.[^.]+$/, ""); return { name: stripDate(b0) || b0, from: "音频文件名" }; }
  return { name: "未命名课程", from: "默认" };
}

function findPython() {
  const cfg = readConfig();
  const cands = [];
  if (cfg.python) cands.push(cfg.python);
  cands.push(path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "python.exe"));
  cands.push("F:\\python.exe");
  cands.push("python");
  for (const c of cands) {
    if (!c) continue;
    if (c === "python") return c;
    if (fs.existsSync(c)) return c;
  }
  return null;
}
function diarizeAvailable() {
  const seg = path.join(ROOT, "模型", "seg.tar.bz2");
  const emb = path.join(ROOT, "模型", "3dspeaker.onnx");
  const py = path.join(ROOT, "tools", "diarize.py");
  return fs.existsSync(seg) && fs.existsSync(emb) && fs.existsSync(py) && !!findPython();
}
function runDiarize(wav16k) {
  const { spawnSync } = require("child_process");
  const python = findPython();
  const script = path.join(ROOT, "tools", "diarize.py");
  const outJson = path.join(require("os").tmpdir(), "diar_" + Date.now() + ".json");
  const r = spawnSync(python, [script, "--wav", wav16k, "--out", outJson], { stdio: QUIET_MODE ? "ignore" : "inherit" });
  if (!fs.existsSync(outJson)) {
    throw new Error("diarize.py 未产出结果（退出码 " + r.status + "）");
  }
  const j = JSON.parse(fs.readFileSync(outJson, "utf8"));
  try { fs.unlinkSync(outJson); } catch (e) {}
  return j;
}
// 把 whisper 的 srt 段按时间重叠归到某位发言人；主讲（说得最多）标为“主讲”，其余标“其他人”
function labelBySpeaker(srtSegs, diar) {
  const segs = (diar && diar.segments) || [];
  if (!segs.length) return { text: "", speakers: 0, primaryPct: 0 };
  const talk = {};
  segs.forEach((s) => { talk[s.speaker] = (talk[s.speaker] || 0) + (s.end - s.start); });
  const total = Object.keys(talk).reduce((a, k) => a + talk[k], 0) || 1;
  const primary = Object.keys(talk).sort((a, b) => talk[b] - talk[a])[0];
  const label = (spk) => (String(spk) === String(primary) ? "主讲" : "其他人");
  const pick = (a, b) => {
    let best = null, bestOv = 0;
    segs.forEach((s) => {
      const ov = Math.min(a, s.end) - Math.max(b, s.start);
      if (ov > bestOv) { bestOv = ov; best = s; }
    });
    if (best) return best.speaker;
    // 没有时间重叠（弱录音下分离覆盖不全）→ 取时间上最近的一段，5 秒内算数
    let near = null, nd = 1e9;
    segs.forEach((s) => { const d = Math.min(Math.abs(s.start - a), Math.abs(b - s.end)); if (d < nd) { nd = d; near = s; } });
    return (near && nd <= 5) ? near.speaker : null;
  };
  const lines = srtSegs.map((s) => {
    const spk = pick(s.end || (s.start + 3), s.start);
    return "[" + fmtTs(s.start) + "] " + (spk == null ? "？" : label(spk)) + "：" + s.text;
  });
  const span = srtSegs.length ? (srtSegs[srtSegs.length - 1].start - srtSegs[0].start) : 0;
  const cov = span > 0 ? Math.round(100 * total / span) : 0;
  return {
    text: lines.join("\n"),
    speakers: Object.keys(talk).length,
    primaryPct: Math.round(100 * (talk[primary] || 0) / total),
    coveragePct: cov,
  };
}
/* ---------------- 长音频分段转写（2026-10-13 新增） ----------------
   为什么要有这一段（真实故障）：105 分钟的录音里只有 54.5–62.8 分钟那 8 分钟陷入循环幻觉，
   可旧逻辑的质量门是「整条」的 —— 8 分钟不干净就否掉整份 105 分钟 → 5 个参数档 × 3 个模型
   = 15 次全试一遍，每次 160–230 秒，用户看到的就是「一直在转写」（最多 ~50 分钟）。
   分段后：每段各自判定，好的段跑一次就过，坏段才在同一段里多试几次。 */
const CHUNK_SEC_DEFAULT = 600;   // 每段 10 分钟
const CHUNK_MIN_SEC = 1200;      // 超过 20 分钟才分段（短录音保持原来的单趟路径，行为不变）
const BURST_WINDOW_SEC = 30;     // 同一句在这个窗口内再次出现 → 判为循环幻觉（真实口语重复间隔都在几十秒以上）
const CHUNK_MAX_ATTEMPTS = 6;    // 单段最多试几档（坏段常见的课间会一直不达标，别把 15 档全磨一遍；好的段 1–3 档就过）

function srtTime(sec) {
  const total = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(total / 3600000), m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000), ms = total % 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
}
// 把若干段（可带时间偏移）写成良构 srt：连续编号 + 时间轴平移（笔记侧 parseSrt 消费）
function srtOf(segs, offsetSec, startIndex) {
  const off = Number(offsetSec) || 0;
  const out = [];
  let n = Number(startIndex) || 1;
  for (const s of (segs || [])) {
    if (!s || !s.text) continue;
    out.push(String(n++));
    out.push(srtTime(s.start + off) + ' --> ' + srtTime(s.end + off));
    out.push(String(s.text).replace(/\s+/g, ' ').trim());
    out.push('');
  }
  return out.join('\n');
}
// 只留字母数字与汉字，用于判断"是不是同一句"
function normLine(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// 突发去重：某句与它「上一次出现」的间隔 ≤ windowSec 就丢掉（循环幻觉每 2–3 秒重复一次；
// 真实的口语重复间隔都在几十秒以上，不会被误删）
function dedupeBursts(segs, windowSec) {
  const win = Number(windowSec) || BURST_WINDOW_SEC;
  const last = new Map();
  const kept = [], dropped = [];
  for (const s of (segs || [])) {
    const key = normLine(s && s.text);
    if (key) {
      const prev = last.get(key);
      last.set(key, s.start);
      if (prev != null && (s.start - prev) <= win) { dropped.push(s); continue; }
    }
    kept.push(s);
  }
  return { segs: kept, dropped: dropped };
}
// 循环幻觉在时间上是成簇的（课间/离场那一小段里连着吐同一句话）。
// 把被去掉的那些段按时间聚簇：簇内相邻间隔 ≤ gapSec 算同一段幻觉，返回每簇的 [from, to]。
// 于是要丢的是「这些区间」，而不是整段录音——区间外的真课堂能留下来。
function hallucSpans(dropped, durSec, gapSec) {
  const gap = Number(gapSec) || 120;
  const list = (dropped || []).filter((x) => x && isFinite(x.start) && isFinite(x.end)).sort((a, b) => a.start - b.start);
  const spans = [];
  for (const x of list) {
    const last = spans[spans.length - 1];
    if (last && (x.start - last.to) <= gap) last.to = Math.max(last.to, x.end);
    else spans.push({ from: x.start, to: x.end });
  }
  // 两端各外扩 1 秒（紧贴幻觉的那半句也一起丢），并夹在 [0, durSec] 内
  return spans.map((sp) => ({
    from: Math.max(0, sp.from - 1),
    to: Math.min(durSec > 0 ? durSec : sp.to + 1, sp.to + 1),
  }));
}
// 按时间切成等长小段（在 16kHz 单声道 PCM wav 上做，-c copy 不会重编码）
function chunkAudio(ffmpeg, wavPath, outDir, sec) {
  fs.mkdirSync(outDir, { recursive: true });
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath,
    '-f', 'segment', '-segment_time', String(Math.max(60, Number(sec) || CHUNK_SEC_DEFAULT)),
    '-c', 'copy', path.join(outDir, 'c%03d.wav')], 'ffmpeg');
  const files = fs.readdirSync(outDir).filter((f) => /^c\d+\.wav$/.test(f)).sort();
  let off = 0;
  return files.map((f) => {
    const full = path.join(outDir, f);
    const d = wavDuration(full) || 0;
    const rec = { file: full, offsetSec: off, durSec: d };
    off += d;
    return rec;
  });
}
// 在一份 wav 上跑「参数档 × 模型」矩阵，达标即停
function runMatrix(c) {
  const tmpDir = require('os').tmpdir();
  const profiles = c.profiles || decideProfiles(c.stats, c.opts);
  let best = null;
  const attempts = [];
  for (let pi = 0; pi < profiles.length; pi++) {
    const prof = profiles[pi];
    const workWav = prof.filter ? path.join(tmpDir, 'prof_' + Date.now() + '_' + pi + '.wav') : c.srcWav;
    if (prof.filter) run(c.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', c.srcWav, '-af', prof.filter, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', workWav], 'ffmpeg');
    const useVad = (c.opts.vad === true) ? true : (c.opts.vad === false ? false : prof.vad);
    // 卡死保护：允许的最长转写时间（正常约 10-24× 实时；给到 0.5× 实时即判定异常）
    const limitMs = Math.max(90000, Math.round(((c.dur || 600) * 1000) / 2));
    let stopNow = false;
    for (let mi = 0; mi < c.models.length && !stopNow; mi++) {
      if (c.maxAttempts && attempts.length >= c.maxAttempts) {
        console.log((c.tag || '·') + ' ⓘ 这一段已试 ' + attempts.length + ' 档都没达标，不再往下试（单段上限 '
          + c.maxAttempts + ' 档）→ 用目前最好的一次 + 清循环碎片');
        stopNow = true;
        break;
      }
      const model = c.models[mi];
      const args = ['-m', model, '-f', workWav, '-l', c.lang, '-otxt', '-osrt', '-of', c.outBase, '--no-prints'];
      if (c.antiLoop) args.push('-mc', '0', '-sns'); // 实测：关闭上文携带 + 抑制非语音 token，把循环幻觉 ×177 降到 ×1
      if (c.promptVal) { args.push('--prompt', c.promptVal); if (c.antiLoop) args.push('--carry-initial-prompt'); }
      if (useVad && c.vadModel) args.push('--vad', '-vm', c.vadModel, '-vt', '0.5', '-vspd', '250', '-vsd', '300', '-vp', '30');
      console.log((c.tag || '·') + ' 尝试【' + prof.name + '】' + prof.desc + '（模型 ' + path.basename(model) + (mi ? ' 备用' : '') + '，VAD ' + (useVad && c.vadModel ? '开' : '关') + '，上限 ' + Math.round(limitMs / 1000) + 's）…');
      const t0 = Date.now();
      try {
        run(c.cli, args, 'whisper-cli', limitMs);
      } catch (e) {
        console.log('    ⚠ ' + e.message);
        if (mi + 1 < c.models.length) console.log('      → 自动降级到备用模型 ' + path.basename(c.models[mi + 1]));
        continue;
      }
      const el = (Date.now() - t0) / 1000;
      const tp = c.outBase + '.txt';
      const txt = fs.existsSync(tp) ? fs.readFileSync(tp, 'utf8').trim() : '';
      const sc = scoreText(txt, c.dur || 0);
      attempts.push({ profile: prof.name, model: path.basename(model), chars: sc.chars, cpm: sc.cpm, top: sc.top, secs: el });
      console.log('    → ' + sc.chars + ' 字符（' + sc.cpm.toFixed(0) + ' 字/分钟），最高重复片段 ×' + sc.top + '，耗时 ' + el.toFixed(1) + 's');
      let segs = [];
      const sp = c.outBase + '.srt';
      if (fs.existsSync(sp)) { try { segs = parseSrt(fs.readFileSync(sp, 'utf8')); } catch (e) { segs = []; } }
      const cand = { profile: prof.name, text: txt, segs: segs, score: sc.score, chars: sc.chars, cpm: sc.cpm, top: sc.top, secs: el, whisperModel: path.basename(model) };
      if (!best || sc.score > best.score) best = cand;
      if ((best.score >= 300 && best.top <= 3) || best.top <= 1) {
        console.log('    ✓ 质量达标（无重复循环），不再重试');
        stopNow = true;
      }
    }
    if (prof.filter) { try { fs.unlinkSync(workWav); } catch (e) { /* 忽略 */ } }
    if (stopNow) break;
  }
  const hit = !!(best && ((best.score >= 300 && best.top <= 3) || best.top <= 1));
  return { best: best, attempts: attempts, hit: hit };
}
// 长音频：逐段转写 + 逐段质量门 + 坏段去重/丢弃 + 合并 srt
function transcribeChunked(c) {
  const chunkDir = path.join(require('os').tmpdir(), 'lecture_chunks_' + Date.now());
  const chunks = chunkAudio(c.ffmpeg, c.srcWav, chunkDir, c.chunkSec);
  console.log('· 长音频分段转写：共 ' + chunks.length + ' 段，每段约 ' + Math.round(c.chunkSec / 60) + ' 分钟'
    + '（逐段判定：好的段跑一次就过，坏段才在同一段里多试，不必整条重来）');
  const attempts = [], segsAll = [], txtParts = [], profs = [];
  let chars = 0, top = 0, secs = 0, droppedChunks = 0, skippedChunks = 0;
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const cdur = ch.durSec || wavDuration(ch.file) || 0;
    const cs = analyzeWav(ch.file);
    const from = Math.floor(ch.offsetSec / 60), to = Math.round((ch.offsetSec + cdur) / 60);
    console.log('· 第 ' + (i + 1) + '/' + chunks.length + ' 段（' + from + '–' + to + ' 分钟，中位 ' + cs.medianDb.toFixed(0)
      + ' dB／静音 ' + (cs.silenceRatio * 100).toFixed(0) + '%）');
    if (cs.speechLevelDb < -55) {
      console.log('    ⓘ 这一段几乎没人声，跳过（不产生文本）');
      skippedChunks++;
      continue;
    }
    const base = path.join(chunkDir, 'out' + String(i).padStart(3, '0'));
    const r = runMatrix(Object.assign({}, c, { srcWav: ch.file, outBase: base, dur: cdur, stats: cs, tag: '  ·', profiles: decideProfiles(cs, c.opts), maxAttempts: CHUNK_MAX_ATTEMPTS }));
    for (const a of r.attempts) { a.chunk = from + '–' + to + ' 分钟'; attempts.push(a); }
    if (!r.best) { console.log('    ⚠ 这一段所有档位都失败，跳过（其余段不受影响）'); skippedChunks++; continue; }
    let segs = r.best.segs, text = r.best.text, note = '';
    if (!r.hit && segs.length) {
      const dd = dedupeBursts(segs, BURST_WINDOW_SEC);
      if (dd.dropped.length) {
        const re = scoreText(dd.segs.map((x) => x.text).join(' '), cdur);
        segs = dd.segs; text = dd.segs.map((x) => x.text).join(' ');
        const droppedChars = dd.dropped.reduce((s, x) => s + String((x && x.text) || '').length, 0);
        const dropFrac = r.best.chars ? droppedChars / r.best.chars : 0;
        console.log('    · 这一段没达标（原 ×' + r.best.top + '），去掉 ' + dd.dropped.length + ' 处突发重复（占 ' + Math.round(dropFrac * 100) + '% 字数）→ ×' + re.top);
        const clean2 = (re.top <= 1) || (re.score >= 300 && re.top <= 3);
        if (!clean2 && (dropFrac > 0.3 || cs.silenceRatio > 0.55 || re.cpm > 1200)) {
          // 只丢「幻觉区间」，不整段丢：循环幻觉总挤在课间/离场那一小段，
          // 整段丢会把区间前后的真课堂一起扔掉（2026-10-13 第 6 段实测：前 4 分钟是真课堂）。
          const spans = hallucSpans(dd.dropped, cdur, 120);
          const inside = (x) => spans.some((sp) => x.start < sp.to && x.end > sp.from);
          const keep = dd.segs.filter((x) => !inside(x));
          console.log('    ⚠ 去掉重复后仍像循环幻觉（重复占 ' + Math.round(dropFrac * 100) + '% 字数、静音 '
            + (cs.silenceRatio * 100).toFixed(0) + '%）');
          spans.forEach((sp) => console.log('      → 幻觉区间 ' + ((ch.offsetSec + sp.from) / 60).toFixed(1) + '–'
            + ((ch.offsetSec + sp.to) / 60).toFixed(1) + ' 分钟（多半是课间/离场）'));
          segs = keep; text = keep.map((x) => x.text).join(' ');
          note = '（丢幻觉区间 ' + spans.map((sp) => ((ch.offsetSec + sp.from) / 60).toFixed(1) + '–'
            + ((ch.offsetSec + sp.to) / 60).toFixed(1)).join('、') + ' 分钟）';
          if (!keep.length) {
            console.log('      → 这一段的真课堂也没剩下（整段丢弃：宁可空，不要错）');
            droppedChunks++; note = '（整段丢弃：疑似循环幻觉）';
          } else {
            console.log('      → 丢 ' + (dd.segs.length - keep.length) + ' 段，保留区间外 '
              + keep.length + ' 段（约 ' + (keep.reduce((s, x) => s + Math.max(0, x.end - x.start), 0) / 60).toFixed(1) + ' 分钟真课堂）');
          }
        } else if (!clean2) {
          console.log('    ⚠ 这一段仍不完全干净（最高 ×' + re.top + '），保留原文');
          note = '（去重 ' + dd.dropped.length + ' 处，仍 ×' + re.top + '）';
        } else {
          note = '（去重 ' + dd.dropped.length + ' 处）';
        }
      } else {
        console.log('    ⚠ 这一段没达标（最高 ×' + r.best.top + '）但没有可去重的突发重复，保留原文');
        note = '（⚠ 最高重复 ×' + r.best.top + '）';
      }
    }
    txtParts.push(text);
    segs.forEach((x) => segsAll.push({ start: x.start + ch.offsetSec, end: x.end + ch.offsetSec, text: x.text }));
    chars += text.length;
    top = Math.max(top, r.best.top);
    secs += r.best.secs || 0;
    if (profs.indexOf(r.best.profile) < 0) profs.push(r.best.profile);
    console.log('    → ✓ ' + text.length + ' 字符' + note + '，这一段采用【' + r.best.profile + '】');
  }
  try { fs.unlinkSync(chunkDir); } catch (e) { /* 临时目录，删不掉也不影响 */ }
  const merged = txtParts.filter((x) => x && x.trim()).join('\n');
  fs.writeFileSync(c.outBase + '.txt', merged, 'utf8');
  fs.writeFileSync(c.outBase + '.srt', srtOf(segsAll, 0, 1), 'utf8');
  const scAll = scoreText(merged, c.dur || 0);
  console.log('  ✓ 分段合并：' + chunks.length + ' 段（跳过 ' + skippedChunks + ' 段、丢弃 ' + droppedChunks + ' 段）→ '
    + scAll.chars + ' 字符（' + scAll.cpm.toFixed(0) + ' 字/分钟），合并后最高重复 ×' + scAll.top);
  if (scAll.top > 3) console.log('    ⓘ 合并后仍有重复片段（×' + scAll.top + '），多半横跨段边界；已按原样保留。');
  return {
    best: {
      profile: (profs.join('+') || '-'), text: merged, segs: null, chars: scAll.chars, cpm: scAll.cpm,
      top: scAll.top, secs: secs, whisperModel: (attempts.length ? attempts[attempts.length - 1].model : ''),
    },
    attempts: attempts,
  };
}
function transcribeAudio(audioPath, lang, opts) {
  opts = opts || {};
  const ffmpeg = findFfmpeg();
  const cli = findWhisperCli();
  const models = opts.model ? [opts.model] : findModels();
  const vadModel = findVadModel(); // 仅在 --vad 时使用（默认关闭，见下方实测结论）
  if (!cli) throw new Error('找不到 whisper-cli.exe，请先运行 安装Whisper.cmd');
  if (!models.length) throw new Error('找不到可用模型文件（whisper\\models\\*.bin），请先运行 安装Whisper.cmd');
  if (!ffmpeg) throw new Error('找不到 ffmpeg.exe，请先运行 安装Whisper.cmd');

  const base = path.basename(audioPath).replace(/\.[^.]+$/, '');
  const tmpWav = path.join(require('os').tmpdir(), 'lecture_' + Date.now() + '.wav');
  const outBase = path.join(IN_DIR, base);
  if (!fs.existsSync(IN_DIR)) fs.mkdirSync(IN_DIR, { recursive: true });
  // 实测结论（2026-09-21，22 分钟真实课堂录音）：远场弱录音(平均 -35dB)下
  //   ① 高通+动态增益归一化 ② -mc 0（关闭上文携带）③ -sns（抑制非语音 token）
  //   三者合起来把"循环幻觉 ×177"降到 ×1；VAD 在该录音上反而把 8 倍真实语音裁成静音，故默认关闭。
  const cfgW = readConfig();
  const normFilter = opts.noNormalize ? null : (cfgW.ffmpegFilter || 'highpass=f=100,dynaudnorm=f=200:g=15:p=0.9');

  console.log('· ffmpeg 转 16kHz 单声道基准 wav…');
  const cSecs = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], 'ffmpeg');
  const dur = wavDuration(tmpWav);
  const stats = analyzeWav(tmpWav);
  console.log('  音频体检：中位电平 ' + stats.medianDb.toFixed(1) + ' dB｜信噪比 ' + stats.snrDb.toFixed(1) + ' dB｜静音占比 ' + (stats.silenceRatio * 100).toFixed(0) + '%');
  const profiles = decideProfiles(stats, opts);
  console.log('  参数档顺序：' + profiles.map((p) => p.name).join(' → '));
  if (stats.speechLevelDb < -55) { // 连最响的 8% 帧都近乎无声 → 整段确实没有语音（用中位数会误杀长停顿录音）
    console.log('  ⓘ 整段近乎无声，跳过转写（不产生任何文本）');
    fs.writeFileSync(outBase + '.txt', '', 'utf8');
    return { txtPath: outBase + '.txt', text: '', profile: 'silence-skip', attempts: [] };
  }

  const promptFile = path.join(WHISPER_ROOT, 'prompt.txt');
  let promptVal = '';
  if (fs.existsSync(promptFile)) promptVal = fs.readFileSync(promptFile, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 800);

  const antiLoop = !opts.keepContext;
  const chunkSec = opts.chunkSec || cfgW.chunkSec || CHUNK_SEC_DEFAULT;
  const chunkMin = cfgW.chunkMinSec || CHUNK_MIN_SEC;
  const mat = { ffmpeg, cli, models, vadModel, lang, opts, promptVal, antiLoop, profiles };
  let best = null, attempts = [];
  if (!opts.noChunk && dur > chunkMin) {
    const r = transcribeChunked(Object.assign({}, mat, { srcWav: tmpWav, outBase: outBase, dur: dur, stats: stats, chunkSec: chunkSec }));
    best = r.best; attempts = r.attempts;
  } else {
    const r = runMatrix(Object.assign({}, mat, { srcWav: tmpWav, outBase: outBase, dur: dur, stats: stats, tag: '·' }));
    best = r.best; attempts = r.attempts;
  }
  try { fs.unlinkSync(tmpWav); } catch (e) { /* 忽略 */ }
  if (!best) throw new Error('转写失败：所有参数档都没产出结果');
  fs.writeFileSync(outBase + '.txt', best.text, 'utf8'); // 回写最终采用的那一版

  const txtPath = outBase + '.txt';
  if (!fs.existsSync(txtPath)) {
    // VAD 判定整段没有有效语音时，whisper 不会产出文本文件——这是正常结果，不是错误
    fs.writeFileSync(txtPath, '', 'utf8');
    console.log('  ⓘ VAD 判定这段音频没有有效语音（静音），转写稿为空');
  }
  let text = fs.readFileSync(txtPath, 'utf8').trim();

  console.log('');
  console.log('[√] 转写完成并已保存：' + txtPath);
  console.log('    采用参数档【' + best.profile + '】' + (attempts.length > 1 ? '（共试了 ' + attempts.length + ' 档）' : ''));
  console.log('    音频时长 ' + (dur ? dur.toFixed(1) + ' 秒' : '未知') + ' / 转码 ' + cSecs.toFixed(1) + ' 秒 / 转写 ' + best.secs.toFixed(1) + ' 秒'
    + (dur && best.secs ? '  → 速度 ' + (dur / best.secs).toFixed(1) + '× 实时' : ''));
  console.log('    质量：' + best.chars + ' 字符（' + best.cpm.toFixed(0) + ' 字/分钟），最高重复片段 ×' + best.top);
  console.log('    转写字数 ' + text.length + ' 字符');
  const srtPath = outBase + '.srt';
  let srtSegs = [];
  if (fs.existsSync(srtPath)) { try { srtSegs = parseSrt(fs.readFileSync(srtPath, 'utf8')); } catch (e) { srtSegs = []; } }

  /* 勘误表：转写刚落盘就纠正听错的词（.txt/.srt 一起改），后面读到的都是改好的 */
  const fixedFiles = applyErrataToFiles([txtPath, srtPath]);
  if (fixedFiles.length) {
    console.log('  · 勘误表：' + fixedFiles.map((x) => x.file + ' 改 ' + x.n + ' 处（' + x.what + '）').join('；'));
    text = fs.readFileSync(txtPath, 'utf8').trim();
    try { srtSegs = parseSrt(fs.readFileSync(srtPath, 'utf8')); } catch (e) { srtSegs = []; }
  }
  return {
    txtPath, text, profile: best.profile, attempts: attempts, durationSec: dur,
    srtPath: fs.existsSync(srtPath) ? srtPath : null,
    whisperModel: (best && best.whisperModel) || path.basename(models[0]),
    srtSegs: srtSegs,
    quality: best.chars + ' 字符 / ' + best.cpm.toFixed(0) + ' 字/分钟 / 最高重复 ×' + best.top,
  };
}


/* ---------------- API Key ---------------- */
function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return { key: process.env.DEEPSEEK_API_KEY.trim(), from: '环境变量 DEEPSEEK_API_KEY' };
  }
  const cfg = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfg)) {
    try {
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (j.apiKey && j.apiKey.trim()) return { key: j.apiKey.trim(), from: 'config.json' };
    } catch (e) { /* 忽略，继续找 */ }
  }
  const cands = [];
  if (process.env.DSH_HOME) cands.push(path.join(process.env.DSH_HOME, '.env'));
  cands.push(path.join(os.homedir(), '.dsh', '.env'));
  for (const f of cands) {
    if (fs.existsSync(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/m);
      if (m) return { key: m[1].trim().replace(/^["']|["']$/g, ''), from: f };
    }
  }
  return null;
}

/* ---------------- 找转写稿 ---------------- */
function pickTranscript(fileArg) {
  if (fileArg) {
    const p = path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg);
    if (!fs.existsSync(p)) throw new Error('找不到文件：' + p);
    return p;
  }
  if (!fs.existsSync(IN_DIR)) throw new Error('找不到文件夹：' + IN_DIR);
  const files = listFilesDeep(IN_DIR, /\.(txt|md)$/i)
    .filter((f) => !/\.讲者\.txt$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(IN_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error('录音稿/ 里还没有 .txt 或 .md 文件');
  return path.join(IN_DIR, files[0].f);
}

/* ---------------- 调 DeepSeek ---------------- */
async function callDeepSeek(key, messages, opts) {
  opts = opts || {};
  const body = {
    model: MODEL,
    messages,
    temperature: opts.temperature == null ? 0.3 : opts.temperature,
    max_tokens: opts.max_tokens || 8000,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 180000);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 300));
      const j = JSON.parse(text);
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) throw new Error('返回内容为空：' + text.slice(0, 200));
      return content;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      console.log('  第 ' + attempt + ' 次调用失败：' + e.message);
      if (attempt < 5) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

/* ---------------- Prompt ---------------- */
function schemaHint(withTs) {
  const kp = withTs ? '[{"t":"12:34","text":"核心要点"}]（严格 3-7 条）' : '["核心要点1", "核心要点2", "（3-7条）"]';
  const bi = withTs ? '[{"t":"12:34","en":"讲师原话","zh":"中文翻译"}]' : '[{"en":"讲师原话","zh":"中文翻译"}]';
  const qa = withTs ? '[{"t":"12:34","q":"复习问题","a":"答案"}]' : '[{"q":"复习问题","a":"答案"}]';
  return `{
  "course": "课程名",
  "title": "本次课主题（中文，一句）",
  "oneLine": "整节课一句话概括（中文，40字内）",
  "keyPoints": ${kp},
  "bilingual": ${bi},
  "notes": "结构化中文笔记（Markdown：## 小节标题、要点列表、公式用 LaTeX、术语保留英文）",
  "terms": [{"en": "英文术语", "zh": "中文", "note": "30字内解释"}],
  "mindmap": "思维导图大纲，纯缩进文本，每级两个空格，根节点为课程主题",
  "qa": ${qa},
  "todos": ["需要自己完成的事，如作业/阅读/待查证点"]
}`;
}

function buildMessages(courseHint, text, partInfo, withTs) {
  const sys = [
    '你是利兹大学 EPS 学院的资深学术助教，擅长把英授课的课堂转写稿加工成中文学习资料。',
    '你的产出必须严格、忠实于转写稿：不编造讲师没讲的内容；转写稿里明显是识别错误、听不懂或残缺的地方，在相应位置标注 [存疑]（直接写这三个字加方括号，绝对不要输出任何 HTML 标签或 Markdown 以外的标记）；',
    '所有专业术语保留英文原文并给中文；公式一律用 LaTeX 书写；英文原句要原样摘录，不要自行改写后再翻译。',
    withTs ? '转写稿每段行首有 [mm:ss] 时间标记。请为每条核心要点、每组中英对照、每个问答标注它出现的那个时间点，t 字段填 "mm:ss"（直接取该内容所在段的标记；确实找不到就填 ""）。' : '',
    '只输出一个 JSON 对象，不要输出任何解释文字或 Markdown 代码围栏，JSON 结构如下：',
    schemaHint(!!withTs),
    timetableBlock(TT_HINT),
    // 2026-09-29 改版：用户反馈「要点不够详细、不够聚焦知识」。
    // 实测诊断：95 分钟的课 notes 正文只有 3,911 字符——8000 token 的输出预算被对照/术语/问答先吃掉，
    // 正文只剩零头。所以这里把 notes 明确立为「主体、长度不设上限」，卡片类字段按段数摊薄。
    '【产出原则，按重要性排序】',
    '① 一切以「知识本身」为中心：概念定义、原理与动机、推导与公式、例证、易错点、与其它知识点的联系。',
    '② 讲者的口头补充往往比幻灯片更有价值（举例、类比、强调"这里容易考/容易错"、现场演示的思路），要保留。',
    '③ 行政与事务性内容（课程网站怎么用、软件怎么装、报名流程、服务介绍、纯日期提醒）只在与考核直接相关时保留一句，',
    '   其余不要写进 notes 正文；确实要跟进的放 todos，一两句即可。',
    '④ 不要写"本段介绍了…""讲者提到了…"这类空泛概括，直接写知识本身。',
    '字段要求：',
    '　· notes 是**主体**：按讲者的知识脉络分节（## 小节标题），每节把细节写足——定义 → 为什么 → 怎么用 → 例子/公式；',
    '　　长度不设上限，宁可长而具体，也不要短而空泛。',
    partInfo
      ? ('　· 本段是第 ' + partInfo.i + '/' + partInfo.n + ' 段，卡片类字段按段摊薄以免合并后失控：'
        + 'keyPoints 3-6 条、bilingual 6-10 组、terms 6-12 个、qa 3-6 组；mindmap 3-4 层。'
        + '**只写本段出现的内容，不要与其它段重复**（同一术语在本段出现过的，别段不必再列）。')
      : ('　· keyPoints 5-9 条（每条含具体结论/条件/数字，不要"介绍了…"）；bilingual 12-20 组（挑真有信息量或语言价值的原句，不要凑数）；'
        + 'terms 12-25 个（同一个词不要重复列出）；qa 6-12 组（能拿来自测的问题）；mindmap 3-4 层，节点精炼。'),
  ].filter(Boolean).join('\n');

  const head = [
    partInfo ? '【注意】这是同一节课转写稿的第 ' + partInfo.i + '/' + partInfo.n + ' 段，只处理本段内容，字段含义同上。' : '',
    '课程：' + (courseHint || '未指定'),
    withTs ? '以下是带时间标记的课堂转写稿（行首 [mm:ss] 为该段起始时间）：' : '以下是课堂转写稿（可能含时间戳、说话人标记、识别噪声，请忽略这些噪声）：',
    '----- 转写稿开始 -----',
    text,
    '----- 转写稿结束 -----',
    '请以 JSON 输出上述结构。',
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: sys }, { role: 'user', content: head }];
}

/* ---------------- JSON 解析（带抢救） ---------------- */
function parseJsonLoose(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

function normalize(d) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const pt = (x) => {
    if (typeof x === 'string') return { t: '', text: x };
    return { t: (x && (x.t || x.time || x.ts)) || '', text: (x && (x.text || x.zh || x.kp)) || '' };
  };
  return {
    course: d.course || '',
    title: d.title || '',
    oneLine: d.oneLine || d.summary || '',
    keyPoints: arr(d.keyPoints).map(pt),
    bilingual: arr(d.bilingual).map((x) => ({ t: (x && (x.t || x.time)) || '', en: (x && (x.en || x.english)) || '', zh: (x && (x.zh || x.chinese)) || '' })),
    notes: d.notes || d.notesMarkdown || '',
    terms: arr(d.terms).map((x) => ({ en: (x && (x.en || x.term)) || '', zh: (x && (x.zh || x.cn)) || '', note: (x && x.note) || '' })),
    mindmap: d.mindmap || d.mindMap || '',
    qa: arr(d.qa).map((x) => ({ t: (x && (x.t || x.time)) || '', q: (x && (x.q || x.question)) || '', a: (x && (x.a || x.answer)) || '' })),
    todos: arr(d.todos).map((x) => (typeof x === 'string' ? x : (x && (x.text || x.todo)) || '')),
  };
}

async function runAnalysis(key, courseHint, text, withTs) {
  if (text.length <= MAX_CHARS) {
    console.log('  转写稿 ' + text.length + ' 字符，单次处理');
    const raw = await callDeepSeek(key, buildMessages(courseHint, text, null, withTs), { json: true, max_tokens: 8000 });
    return normalize(parseJsonLoose(raw));
  }
  const lines = text.split('\n');
  const parts = [];
  let buf = [];
  let size = 0;
  for (const ln of lines) {
    buf.push(ln); size += ln.length + 1;
    if (size >= MAX_CHARS) { parts.push(buf.join('\n')); buf = []; size = 0; }
  }
  if (buf.length) parts.push(buf.join('\n'));
  console.log('  转写稿较长（' + text.length + ' 字符），分 ' + parts.length + ' 段处理');
  const results = [];
  for (let i = 0; i < parts.length; i++) {
    console.log('  · 第 ' + (i + 1) + '/' + parts.length + ' 段…');
    const raw = await callDeepSeek(key, buildMessages(courseHint, parts[i], { i: i + 1, n: parts.length }, withTs), { json: true, max_tokens: 8000 });
    results.push(normalize(parseJsonLoose(raw)));
  }
  const merged = results[0];
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    merged.keyPoints = merged.keyPoints.concat(r.keyPoints);
    merged.bilingual = merged.bilingual.concat(r.bilingual);
    merged.terms = merged.terms.concat(r.terms);
    merged.qa = merged.qa.concat(r.qa);
    merged.todos = merged.todos.concat(r.todos);
    merged.notes += '\n\n## 【第 ' + (i + 1) + ' 部分】\n' + r.notes;
    merged.mindmap += '\n【第 ' + (i + 1) + ' 部分】\n' + r.mindmap;
  }
  // 2026-09-29 修：两段各出一份同名术语 → 合并后术语重复（实测 6 个）。
  // 提示词里已要求不要跨段重复，这里是兜底去重（保持首次出现的顺序，去掉后面重复的）。
  const uniqBy = (arr, keyFn) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = String(keyFn(x) || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const before = { kp: merged.keyPoints.length, bi: merged.bilingual.length, tm: merged.terms.length, qa: merged.qa.length };
  merged.keyPoints = uniqBy(merged.keyPoints, (x) => x.text);
  merged.bilingual = uniqBy(merged.bilingual, (x) => x.en);
  merged.terms = uniqBy(merged.terms, (x) => x.en);
  merged.qa = uniqBy(merged.qa, (x) => x.q);
  const dropped = (before.kp - merged.keyPoints.length) + (before.bi - merged.bilingual.length)
    + (before.tm - merged.terms.length) + (before.qa - merged.qa.length);
  if (dropped) {
    console.log('  · 合并去重：去掉 ' + dropped + ' 条重复（要点 ' + (before.kp - merged.keyPoints.length)
      + ' / 对照 ' + (before.bi - merged.bilingual.length) + ' / 术语 ' + (before.tm - merged.terms.length)
      + ' / 问答 ' + (before.qa - merged.qa.length) + '）');
  }
  merged.oneLine = merged.oneLine || (results[0].title || '');
  return merged;
}

/* ---------------- 课件（幻灯片）读取 + 录音×课件互校 ----------------
 * 设计：互校**单独一次调用**，不塞进生成笔记的那次调用——
 *   ① 它要对着「整节课」核对，而生成笔记是分段做的，塞进去只能核对第一段；
 *   ② 万一它失败，笔记照常出，只是「课件核对」视图显示未核对（fail-safe）。
 * 所有能机械做的仍不交给模型：讲边界、页范围、词重叠匹配都在本地算，并把判断依据打出来供审计。 */
/* 一门课一个文件夹之后，目录里可能攒了好几份课件（整学期总课件 + 单讲课件）。
   `fs.readdirSync().find()` 的先后是文件系统给的、不稳定，会**悄悄**只挑一份。
   2026-09-29 统一（并修掉一个隐患：单讲课件曾可能顶掉整学期的课程地图）：
     ① `--deck 关键词` 指定 → 优先
     ② 文件名里带**这节课的日期**的那份 → 最精确（老师常按日期命名单讲课件）
     ③ 否则取**页数最多**的那份（＝整学期总课件）——这是最稳的默认
     ④ 地图也要配对：优先读「这份课件自己的」课程地图-<课件名>.json，读不到才看共享的那份（且必须 deck 对得上）
   任何时候多于一份都会把「用了哪份、为什么」打出来，不静默。 */
function listDecks(dir) {
  /* 课件可以放在课程根目录，也可以放在日期子文件夹里（单节课件按日期归类，2026-09-29 起）→ 递归找，
     返回**相对 dir 的路径**（如 2026-09-29/week01_文本.txt），配对时用 deckDirOf 求它自己所在目录。 */
  const out = [];
  const walk = (d, pre) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((it) => {
      const q = path.join(d, it.name);
      if (it.isDirectory()) { if (it.name !== '_待归档') walk(q, pre ? pre + '/' + it.name : it.name); }
      else if (it.name.endsWith('_文本.txt')) out.push(pre ? pre + '/' + it.name : it.name);
    });
  };
  walk(dir, '');
  return out.sort();
}
function deckBaseOf(f) { return path.basename(String(f)).replace(/_文本\.txt$/, ''); }
function deckDirOf(dir, f) { return path.join(dir, path.dirname(String(f))); }
/* 课件规模：优先数页清单里的页数，没有就按文本大小粗估（只为排序用） */
function deckPages(dir, f) {
  const dd = deckDirOf(dir, f), base = deckBaseOf(f);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dd, base + '_pages.json'), 'utf8'));
    if (Array.isArray(j) && j.length) return j.length;
  } catch (e) { /* 落到下面 */ }
  try { return Math.round(fs.statSync(path.join(dd, base + '_文本.txt')).size / 400); } catch (e) { return 0; }
}
function rankDecks(dir, decks) {
  return decks.map((f) => ({ file: f, base: deckBaseOf(f), n: deckPages(dir, f) }))
    .sort((a, b) => (b.n - a.n) || a.base.localeCompare(b.base));
}
/* 一份课件属于哪一天：优先看它所在的 <YYYY-MM-DD> 日期文件夹（listDecks 返回的是相对路径），
   没有再看文件名里的日期（如 KRR_MSc_Slides_2026_09_28）。都认不出来就返回 ''。 */
function deckDayOf(f) {
  const segs = String(f).split('/');
  const base = segs.pop() || '';
  for (let i = segs.length - 1; i >= 0; i--) if (/^\d{4}-\d{2}-\d{2}$/.test(segs[i])) return segs[i];
  const m = base.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}
function pickDeck(dir, hint, day) {
  const decks = listDecks(dir);
  if (!decks.length) return { decks: decks, file: '', why: '目录里没有课件', src: 'none' };
  if (hint) {
    const h = String(hint).toLowerCase();
    const hit = decks.find((f) => f.toLowerCase().indexOf(h) >= 0);
    return { decks: decks, file: hit || '', src: hit ? 'hint' : 'none', why: hit ? '--deck「' + hint + '」指定' : '--deck「' + hint + '」没匹配到' };
  }
  const d8 = String(day || '').replace(/\D/g, '');
  if (d8.length === 8) {
    /* ⚠ 匹配的是**相对路径**（listDecks 返回相对 dir 的路径），所以日期可以来自
       ①课件文件名  ②它所在的 <日期> 子文件夹。措辞必须说清是哪一个 —— 否则日志读起来
       像是文件名命中，实际是文件夹命中（2026-10-03 修正）。 */
    const hit = decks.find((f) => f.replace(/\D/g, '').indexOf(d8) >= 0);
    if (hit) {
      const seg = path.dirname(String(hit));
      const inFolder = !!(seg && seg !== '.' && seg !== '' && seg.replace(/\D/g, '').indexOf(d8) >= 0);
      return {
        decks: decks, file: hit, src: 'date',
        why: inFolder
          ? '日期文件夹「' + seg + '」＝这节课的日期 ' + d8
          : '课件文件名里带这节课的日期 ' + d8,
      };
    }
  }
  const ranked = rankDecks(dir, decks);
  /* ⚠ 「页数最多」≠「整学期总课件」：总课件还有 ≥200 页 + 名字不带周次的门槛（见 import-slides.js）。
     这门课可能**根本没有**总课件（老师只发周课件，如 DEMO1001M 的 48/42 页两份），
     所以措辞要按页数如实说，别一律写「＝整学期总课件」（会误导）。
     阈值直接引用 import-slides.js 的常量，保证只有一处定义。 */
  let isSemester = false, minPages = 200;
  try {
    const imp = require('./import-slides.js');
    minPages = imp.MIN_TOTAL_PAGES;
    isSemester = ranked[0].n >= minPages;
  } catch (e) {}
  /* ---- 第三档（2026-10-09 新增）：老师这节课接着讲**上一节那份课件** ----
     场景：一节课没讲完，下节课继续用同一份课件 → 这门课**不会有**本节课的 <日期>\ 文件夹，
     上面那档「日期命中」必然落空。旧逻辑在这里直接退到「页数最多」—— 那纯粹是按页数排的，
     跟"这节课用的是哪份"没关系：实测 DEMO1001M（48/42/72 页三份）在 10-09 会选 72 页那份，
     只是碰巧等于"最新那份"；只要老师接着讲的是较小的一份，就会拿**错的课件**去核对，
     而核对是「以课件为准」的，还可能把正文改歪。
     这里改成按**进度**沿用：日期 ≤ 这节课日期的日期文件夹里，最近的那一份。
     ⚠ 有整学期总课件（≥ MIN_TOTAL_PAGES 页）时**不启用**这一档 —— 总课件本来就是每节课都用，
       该用哪几讲交给「判讲」那一档挑（KRR 的 299 页总课件正是靠这条）。
     ⚠ 判据只看日期、不看内容：老师若已发新课件但还没整理进来，这次仍会沿用旧的 ——
       所以笔记里会渲染一行 ⚠ 课件来源（deckSrc === 'carry'），让人知道这次是按进度推的。 */
  const dayIso = d8.length === 8 ? d8.slice(0, 4) + '-' + d8.slice(4, 6) + '-' + d8.slice(6, 8) : '';
  if (!isSemester && dayIso) {
    const dated = decks.map((f) => ({ f: f, d: deckDayOf(f) })).filter((x) => x.d && x.d <= dayIso);
    if (dated.length) {
      const top = dated.map((x) => x.d).sort().pop();
      const best = rankDecks(dir, dated.filter((x) => x.d === top).map((x) => x.f))[0];
      return {
        decks: decks, file: best.file, src: 'carry',
        why: '沿用最近一次课件（日期文件夹「' + top + '」）；这节课没有新课件',
      };
    }
  }
  return {
    decks: decks, file: ranked[0].file, src: 'rank',
    why: decks.length > 1
      ? ('页数最多（' + ranked[0].n + ' 页' + (isSemester ? '，＝整学期总课件' : '；本课没有 ≥' + minPages + ' 页的总课件，按最大的选') + '）')
      : '目录里只有这一份',
  };
}
function loadCourseware(dir, deckHint, day) {
  const d = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(d)) return null;
  const picked = pickDeck(d, deckHint, day);
  const txtFile = picked.file;
  if (!txtFile) {
    if (deckHint) console.log('· 课件：' + picked.why + '，现有：' + picked.decks.map(deckBaseOf).join('、'));
    return null;
  }
  const base = deckBaseOf(txtFile);
  const txtPath = path.join(d, txtFile);
  const dd = path.dirname(txtPath);          // 这份课件自己所在的目录（可能是 <日期> 子文件夹）
  if (picked.decks.length > 1) {
    console.log('· 课件：该目录有 ' + picked.decks.length + ' 份课件，本次用「' + base + '」（' + picked.why + '）'
      + '；全部：' + picked.decks.map((f) => deckBaseOf(f) + (path.dirname(String(f)) !== '.' ? '[' + path.dirname(String(f)) + ']' : '')).join('、') + '（想换一份加 --deck 关键词）');
  }
  const raw = fs.readFileSync(txtPath, 'utf8');
  const parts = raw.split(/=== p(\d+) ===/);
  const pages = [];
  for (let i = 1; i < parts.length; i += 2) pages.push({ n: Number(parts[i]), text: String(parts[i + 1] || '').trim() });
  /* 地图必须和课件配对：读错地图＝拿别份课件的页码范围去核对，而且不会报错。
     先看这份课件自己那份（跟课件同目录），再退到共享那份（先它自己的目录，再课程根目录）。 */
  let lectures = [], mapFrom = '';
  const mine = path.join(dd, '课程地图-' + base + '.json');
  try {
    const j = JSON.parse(fs.readFileSync(mine, 'utf8'));
    if (j.deck === base) { lectures = j.lectures || []; mapFrom = '课程地图-' + base + '.json'; }
  } catch (e) { /* 没有这份课件自己的地图，往下看共享的 */ }
  if (!mapFrom) {
    for (const sharedPath of [path.join(dd, '课程地图.json'), path.join(d, '课程地图.json')]) {
      if (mapFrom) break;
      try {
        const j = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
        if (j.deck === base) { lectures = j.lectures || []; mapFrom = '课程地图.json'; }
        else console.log('· 课件：共享的 课程地图.json 描述的是「' + j.deck + '」，不是本次要用的「' + base
          + '」→ 本次没有可用的讲结构（先跑 node read-slides.js "' + dir + '" --deck ' + base + '）');
      } catch (e) { /* 没有地图就用空讲表：后面会退回 --pages / 词重叠 */ }
    }
  }
  /* deckSrc/deckWhy：这份课件是**怎么选出来的**（'--deck' / 'date' 日期命中 / 'carry' 沿用最近一次
     / 'rank' 按页数兜底）。'carry' 表示这节课没有新课件、是按进度沿用的 —— 笔记里要写明，
     否则读者会以为"核对用的就是这节课的课件"（2026-10-09 起）。 */
  return { dir: d, deck: base, deckDir: dd, deckFile: txtFile, pages: pages, lectures: lectures,
    mapFrom: mapFrom, deckSrc: picked.src || '', deckWhy: picked.why || '' };
}
function slideText(cw, from, to) {
  return cw.pages.filter((p) => p.n >= from && p.n <= to).map((p) => '[p' + p.n + '] ' + p.text).join('\n\n');
}
// 机械词重叠只能给候选：实测一课时的录音会同时"命中" KRR-2/3/8 等好几讲（得分全挤在 0.31~0.34），
// 所以真正的判讲交给模型读「课件目录 + 各讲标题 + 笔记摘要」，词重叠退化为兜底与旁证。
async function pickLecturesByModel(key, courseHint, digest, cw) {
  const ctx = cw.lectures.map((l) => 'KRR-' + l.no + '（p' + l.startPage + '–p' + l.endPage + '）' + (l.name || '')
    + '｜' + (l.slideTitles || []).slice(0, 10).join('；')).join('\n');
  const sys = [
    '你在帮学生把一份课堂录音对到课程课件上。只依据给定信息判断，不要猜。',
    '判断依据：录音笔记摘要里的主题，与各讲标题、幻灯片标题的重合程度。',
    '一段录音可能覆盖连续的好几讲（常见 1~3 讲）。',
    '只输出一个 JSON，不要解释文字：{"lectures":[1,2],"confidence":"high|mid|low","reason":"一句话中文理由"}',
    'lectures 必须是从小到大的连续讲号；拿不准就把 confidence 写 low。',
  ].join('\n');
  const head = [
    '课程：' + (courseHint || '未指定'),
    '----- 课件各讲（目录与标题）-----',
    ctx,
    '----- 本次录音的笔记摘要 -----',
    String(digest).slice(0, 6000),
    '----- 结束 -----',
    '这段录音覆盖了哪几讲？以 JSON 输出。',
  ].join('\n');
  const raw = await callDeepSeek(key, [{ role: 'system', content: sys }, { role: 'user', content: head }], { json: true, max_tokens: 800 });
  const j = parseJsonLoose(raw);
  const nos = (Array.isArray(j.lectures) ? j.lectures : []).map(Number).filter((n) => n >= 1).sort((a, b) => a - b);
  return { nos: nos, confidence: String(j.confidence || ''), reason: String(j.reason || '') };
}
// 没给 --pages 时：把转写稿和每一讲做词重叠打分，取「最高分那一档」的讲合并成一个页范围。
// ⚠ 实测这条**只可作兜底**：一节课的词会同时命中好几十讲，所以判讲交给 pickLecturesByModel。
// 兜底规则：从最高分那讲出发，只并入「得分 ≥ 0.9×最高分 **且** 与当前范围相邻」的讲。
function guessRange(cw, transcript) {
  const words = (s) => {
    const out = new Set();
    (String(s).toLowerCase().match(/[a-z][a-z\-]{4,}/g) || []).forEach((w) => out.add(w));
    return out;
  };
  if (!cw.lectures.length) return null;
  const tt = words(transcript);
  const scored = cw.lectures.map((l) => {
    const lt = words(slideText(cw, l.startPage, l.endPage));
    let hit = 0;
    lt.forEach((w) => { if (tt.has(w)) hit++; });
    // 余弦相似度（不是 hit/|讲|：那样小讲占便宜，6 页的 KRR-1 命中率虚高）
    return { lec: l, score: (lt.size && tt.size) ? hit / Math.sqrt(lt.size * tt.size) : 0 };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score <= 0) return null;
  const cut = top.score * 0.9;
  let from = top.lec.startPage, to = top.lec.endPage;
  let grew = true;
  while (grew) {
    grew = false;
    scored.forEach((x) => {
      if (x.score < cut) return;
      if (x.lec.startPage >= from && x.lec.endPage <= to) return;
      if (x.lec.startPage <= to + 1 && x.lec.endPage >= from - 1) {
        from = Math.min(from, x.lec.startPage); to = Math.max(to, x.lec.endPage); grew = true;
      }
    });
  }
  const inside = cw.lectures.filter((l) => l.startPage >= from && l.endPage <= to).map((l) => l.no);
  return { from: from, to: to, lectures: inside, top: scored.slice(0, 3) };
}
/* ⚠ 2026-10-06：新增 withQa 开关。
   课件核对必须把**问答与思维导图**也喂给模型 —— 否则模型根本看不见那两处，给不出补丁，
   同一处错误就会留在卡片和导图里（实测：`公平原则` 在正文被改对，问答卡与思维导图仍写着错的那句）。
   判讲那一路（pickLecturesByModel）不需要这些，传 false 保持原样，省 token、也不改变既有行为。 */
function noteDigest(d, limit, withQa) {
  const L = [];
  if (d.keyPoints && d.keyPoints.length) {
    L.push('【核心要点】');
    d.keyPoints.forEach((k) => L.push('- ' + (k.text || '')));
  }
  if (d.terms && d.terms.length) {
    L.push('【术语表】');
    d.terms.forEach((t) => L.push('- ' + t.en + '｜' + t.zh + '｜' + (t.note || '')));
  }
  if (d.notes) {
    L.push('【结构化笔记】');
    L.push(String(d.notes).slice(0, limit || 8000));
  }
  if (withQa) {
    if (d.qa && d.qa.length) {
      L.push('【复习问答】');
      d.qa.forEach((x, i) => L.push((i + 1) + '. 问：' + (x.q || '') + '　答：' + (x.a || '')));
    }
    if (d.mindmap) {
      L.push('【思维导图（纯文本，缩进表示层级；这里的错值同样要改）】');
      L.push(String(d.mindmap).slice(0, 4000));
    }
  }
  return L.join('\n');
}
function handoutMessages(courseHint, digest, slides, deck, rangeLabel) {
  const sys = [
    '你是利兹大学 EPS 学院的资深学术助教。这次的任务是：**拿课件原文去核对课堂笔记**，把两者对不上的地方挑出来。',
    '规则：',
    '① 术语拼写、数字、比例、公式、定义——**一律以课件为准**；',
    '② 笔记里说了、但课件上没有的，verdict 标 notInSlides，不要因为课件没写就断言笔记错；',
    '③ 两边一致的只挑重要的（最多 4 条），不要罗列全部；',
    '④ 绝对不要编造课件里没有的内容；课件原文里识别不到的东西就不写；',
    '⑤ 如果是转写听错造成的（把 A 听成 B），要点明并给出课件的正确写法。',
    '⑥ 凡是 verdict=fixed 的行，尽量给出一组 `patches`（**数组**），用来**直接改正笔记**：',
    '   - 每项含 find / replace 两个字段；find：从「课堂笔记摘要」里**逐字复制**的一小段'
      + '（含标点，不要改写、不要加省略号，6–60 字为宜），必须能唯一确定位置；',
    '   - replace：按课件改写后的那一段（同样长度量级）；',
    '   - 只改**事实性内容**（数字、比例、公式、术语拼写、定义、专有名词），**不要润色措辞、不要改标点风格、不要合并句子**；',
    '   - 摘要里找不到可用的原文片段（或同一片段出现多次）就**不要给这一项**，只留 note 说明。',
    '   - ⚠ **同一个错值在笔记里出现在几处，就要给几项 patches**。要逐处检查这六个地方：'
      + '**核心要点、结构化笔记正文、正文里的 Markdown 表格行、术语表的 note、复习问答的答案、思维导图**。'
      + '每处的 find 各自逐字复制（各处措辞往往**不完全一样**，别拿同一段去套）；'
      + '只给一项会让别处的错值留下来 —— 那等于笔记自己打自己的脸。',
    '   - 思维导图是**纯文本缩进树**，find 就复制那一行里的短语（不要带缩进、不要带 markdown 记号）；',
    '   - 正文里有 **Markdown 表格**（`| 列 | 列 |` 这种）时，表格里的错值要**单独给一项**，'
      + 'find 就复制那一行（含竖线），例如 `| 课程作业 | 30% |` → `| 课程作业 | 20% |`；'
      + '表格照着改整行更稳，别只给单元格里那几个字。',
    '   - 给 patches 之前**先在摘要里确认 find 原样存在**（一个字符都不能差）；不确定就不给这一项，只留 note —— '
      + '给了对不上的 find，这次就白改了。',
    '   - find / replace 里**不要出现英文双引号、反斜杠或换行**（要引号就用「」），否则整段 JSON 会坏掉、这次核对就白做了。',
    '只输出一个 JSON 对象，不要任何解释文字或代码围栏：',
    '{"rows":[{"item":"被核对的对象","fromAudio":"笔记/录音里的说法","fromSlides":"课件里的说法","verdict":"fixed|same|notInSlides","note":"一句话说明","patches":[{"find":"从笔记摘要里逐字复制的片段","replace":"按课件改写后的片段"}]}],"extra":["课件里有、课堂笔记没覆盖到的要点（最多 6 条）"]}',
    'verdict 取值：fixed＝笔记有误、按课件纠正；same＝两边一致；notInSlides＝课件里没提。',
    '注意：patches 只在 verdict=fixed 时给（**数组，同一错值出现在几处就给几项**）；same / notInSlides 不要给。',
  ].join('\n');
  const head = [
    '课程：' + (courseHint || '未指定'),
    '课件：' + deck + '（' + rangeLabel + '）',
    '----- 课件原文开始 -----',
    slides,
    '----- 课件原文结束 -----',
    '',
    '----- 课堂笔记摘要开始 -----',
    digest,
    '----- 课堂笔记摘要结束 -----',
    '请以 JSON 输出上述结构。',
  ].join('\n');
  return [{ role: 'system', content: sys }, { role: 'user', content: head }];
}
async function runHandoutCheck(key, courseHint, digest, slides, deck, rangeLabel) {
  const msgs = handoutMessages(courseHint, digest, slides, deck, rangeLabel);
  let j = null, lastErr = null;
  /* JSON 偶尔会坏（2026-09-30 实测遇到过一次：模型在 patch 片段里把引号/换行转义坏了）。
     所以解析失败要**重试一次**——这类失败是随机的，重试基本就过；两次都坏才认输，并如实上报。 */
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callDeepSeek(key, msgs, { json: true, max_tokens: 6000 });
    try { j = parseJsonLoose(raw); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      console.log('  （核对返回的 JSON 解析失败' + (e && e.message ? '：' + e.message : '')
        + (attempt < 2 ? '，重试一次…' : '，放弃这次核对）'));
    }
  }
  if (!j) return { rows: [], extra: [], failed: String((lastErr && lastErr.message) || '返回不是合法 JSON') };
  const rows = (Array.isArray(j.rows) ? j.rows : []).map((r) => {
    const out = {
      item: String((r && r.item) || '').trim(),
      fromAudio: String((r && r.fromAudio) || '').trim(),
      fromSlides: String((r && r.fromSlides) || '').trim(),
      verdict: (['fixed', 'same', 'notInSlides'].indexOf(r && r.verdict) >= 0) ? r.verdict : 'same',
      note: String((r && r.note) || '').trim(),
    };
    /* 定向补丁（只在 fixed 行上有意义）：find 必须逐字来自笔记摘要，replace 是课件写法。
       ⚠ 2026-10-06：`patches`（**数组**）是新的主格式，`patch`（单数）是旧格式、仍然接受。
       **两种都必须收** —— 只收单数会把模型返回的整个数组丢掉，表现是"核对跑了但一处都没改"，
       而且**完全不报错**（实测踩过：改了提示词与 applier，却漏了这一层规范化）。
       规范化时顺手丢掉空项/缺字段的项，下游 applyHandoutPatches 就能直接用。 */
    const normPatch = (p) => ((p && p.find && p.replace)
      ? { find: String(p.find).trim(), replace: String(p.replace).trim() } : null);
    const plist = (Array.isArray(r && r.patches) ? r.patches : []).map(normPatch).filter(Boolean);
    const psingle = normPatch(r && r.patch);
    if (psingle) plist.push(psingle);
    if (plist.length) out.patches = plist;
    return out;
  }).filter((r) => r.item || r.fromAudio || r.fromSlides);
  const extra = (Array.isArray(j.extra) ? j.extra : []).map((x) => String(x || '').trim()).filter(Boolean);
  return { rows: rows, extra: extra };
}

/* ---------------- 残留复查（第二轮，2026-10-06 新增）----------------
   为什么需要第二轮：**模型第一轮不总会枚举穷尽**。实测同一处错误在四五个视图里各写了一遍，
   第一轮只给了正文/要点/问答的补丁，**术语表的 note 与思维导图里还留着**。
   第一轮的任务是"通读全文找问题"（宽），第二轮只做一件更窄的事：**在这几处短视图里找残留**。
   目标单一 → 命中率高得多。只在第一轮**确实发现了错误**时才跑（笔记本来就干净 → 零额外开销）。 */
function residualDigest(d) {
  const L = [];
  if (d.keyPoints && d.keyPoints.length) {
    L.push('【核心要点】');
    d.keyPoints.forEach((k, i) => L.push((i + 1) + '. ' + (k.text || '')));
  }
  if (d.terms && d.terms.length) {
    L.push('【术语表】');
    d.terms.forEach((t, i) => L.push((i + 1) + '. ' + t.en + '｜' + t.zh + '｜' + (t.note || '')));
  }
  if (d.qa && d.qa.length) {
    L.push('【复习问答】');
    d.qa.forEach((x, i) => L.push((i + 1) + '. 问：' + (x.q || '') + '　答：' + (x.a || '')));
  }
  if (d.mindmap) {
    L.push('【思维导图】');
    L.push(String(d.mindmap));
  }
  return L.join('\n');
}
function residualMessages(courseHint, digest, slides, deck, fixedList) {
  const sys = [
    '你是利兹大学 EPS 学院的资深学术助教。**这是课件核对的第二轮，只做一件事**：',
    '第一轮已经拿课件核对过这篇笔记、并改掉了一批错处（清单在用户消息末尾）。',
    '现在请**只检查下面这几处短视图**（核心要点、术语表、复习问答、思维导图）里',
    '**是否还残留着与课件不符的说法** —— 同一个错值往往在好几处各写了一遍、措辞还不一样，',
    '第一轮最容易漏掉的是**术语表的 note** 和**思维导图**。',
    '规则：',
    '① 只报**与课件明确冲突**的（数字、比例、公式、术语拼写、定义、专有名词）；课件里没提的**不要报**；',
    '② 每找到一处给一项：find ＝从下面原文里**逐字复制**的一小段（含标点，不要改写、不要加省略号）；'
      + 'replace ＝按课件改写后的那一段；',
    '③ find 必须在**同一处视图里只出现一次**（出现多次就换一段更长、能唯一确定的）；',
    '④ 思维导图是纯文本缩进树：find 复制那一行里的短语即可，**不要带缩进、不要带 markdown 记号**；',
    '⑤ find / replace 里不要出现英文双引号、反斜杠或换行（要引号就用「」）；',
    '⑥ **已经改过的不要再报**（清单在末尾）；没有残留就返回空数组 —— 空数组是完全正常的答案，不要硬凑。',
    '只输出一个 JSON 对象，不要任何解释文字或代码围栏：',
    '{"residuals":[{"item":"残留的是哪一处","find":"逐字复制的片段","replace":"按课件改写后的片段"}]}',
  ].join('\n');
  const head = [
    '课程：' + (courseHint || '未指定'),
    '课件：' + deck,
    '----- 课件原文开始 -----',
    slides,
    '----- 课件原文结束 -----',
    '',
    '----- 待复查的短视图开始 -----',
    digest,
    '----- 待复查的短视图结束 -----',
    '',
    '----- 第一轮已经改过的（不用再报）-----',
    fixedList.length
      ? fixedList.map((x, i) => (i + 1) + '. ' + x.where + '：'
        + String(x.find).slice(0, 40) + ' → ' + String(x.replace).slice(0, 40)).join('\n')
      : '(无)',
  ].join('\n');
  return [{ role: 'system', content: sys }, { role: 'user', content: head }];
}
async function runHandoutResiduals(key, courseHint, digest, slides, deck, fixedList) {
  const msgs = residualMessages(courseHint, digest, slides, deck, fixedList || []);
  let j = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callDeepSeek(key, msgs, { json: true, max_tokens: 3000 });
      j = parseJsonLoose(raw);
      break;
    } catch (e) { if (attempt === 2) return { rows: [], failed: String((e && e.message) || e) }; }
  }
  if (!j) return { rows: [] };
  const norm = (p) => ((p && p.find && p.replace)
    ? { find: String(p.find).trim(), replace: String(p.replace).trim() } : null);
  const rows = (Array.isArray(j.residuals) ? j.residuals : []).map((x, i) => {
    const p = norm(x);
    if (!p) return null;
    return {
      item: '(残留复查) ' + String((x && x.item) || ('第 ' + (i + 1) + ' 处')),
      fromAudio: '', fromSlides: '', note: '', verdict: 'fixed', patches: [p],
    };
  }).filter(Boolean);
  return { rows: rows };
}

/* ---------------- 课件核对结论 → 回改正文（2026-09-30 新增） ----------------
 * 为什么要有它（用户实测发现的矛盾）：核对表能算出「笔记三项权重全部与课件不符，课件为 20%/60%/20%」，
 * 可正文还是 30%/20%/2% —— 因为核对只出报告、从不回写，读的人看到的就是自相矛盾。
 * 做法（机械、fail-closed，不让模型悄悄重写正文）：
 *   核对那次调用顺便给出定向补丁 {find, replace}（find 必须从笔记摘要里逐字复制）；
 *   这里在 正文 / 要点 / 术语 / 问答 / 中英对照 里找 find，**恰好出现 1 次**才替换；
 *   找不到或有歧义一律不动，并把「没回改」的原因写进核对表的 note。
 *   每一次回改都打印出来，并在核对表里留记录（原文仍在 fromAudio 那一列）。 */
function patchTargets(d) {
  const T = [];
  T.push({ label: '正文', get: () => String(d.notes || ''), set: (v) => { d.notes = v; } });
  /* ⚠ 2026-10-06 补上思维导图：原来 patchTargets **不含 mindmap**，于是导图里的错值
     永远无法被自动回改 —— 而导图恰好是复习时最常看的视图。（"唯一匹配才改"的规则照样适用。） */
  if (d.mindmap !== undefined) {
    T.push({ label: '思维导图', get: () => String(d.mindmap || ''), set: (v) => { d.mindmap = v; } });
  }
  (d.keyPoints || []).forEach((k, i) => T.push({ label: '要点[' + (i + 1) + ']', get: () => String(k.text || ''), set: (v) => { k.text = v; } }));
  (d.terms || []).forEach((t, i) => {
    T.push({ label: '术语[' + (i + 1) + '].zh', get: () => String(t.zh || ''), set: (v) => { t.zh = v; } });
    if (t.note !== undefined) T.push({ label: '术语[' + (i + 1) + '].note', get: () => String(t.note || ''), set: (v) => { t.note = v; } });
  });
  (d.qa || []).forEach((x, i) => {
    T.push({ label: '问答[' + (i + 1) + '].a', get: () => String(x.a || ''), set: (v) => { x.a = v; } });
    T.push({ label: '问答[' + (i + 1) + '].q', get: () => String(x.q || ''), set: (v) => { x.q = v; } });
  });
  (d.bilingual || []).forEach((b, i) => T.push({ label: '对照[' + (i + 1) + '].zh', get: () => String(b.zh || ''), set: (v) => { b.zh = v; } }));
  return T;
}
function applyHandoutPatches(d, rows) {
  const applied = [], skipped = [];
  (rows || []).forEach((r) => {
    if (!r || r.verdict !== 'fixed') return;
    /* ⚠ 2026-10-06：`patch`（单个）→ `patches`（数组）。
       根因：提示词早就写着「同一个错值出现在几处就分别给几个 patch」，但 JSON 模板只允许**一个** ——
       提示词与 schema 自相矛盾，模型没法照做，于是同一处错误只改了正文，问答卡/思维导图/术语 note 留着。
       数组里每一项**独立**按「唯一匹配才改」应用（各项措辞通常不同，因为各视图句式不一样）。
       仍兼容老格式的单个 `patch`。 */
    const list = Array.isArray(r.patches) ? r.patches : (r.patch ? [r.patch] : []);
    const done = [], miss = [];
    list.forEach((p) => {
      const find = p ? String(p.find || '').trim() : '';
      const repl = p ? String(p.replace || '') : '';
      if (!find || !repl || find === repl) return;          // 没给补丁 → 只出报告
      /* 「唯一匹配才改」的口径（2026-10-06 收紧过一次）：
         ⚠ 原来是「**所有视图加起来**只出现 1 次才改」—— 可同一个错值往往在正文/要点/问答/导图里
           各写了一遍，加起来 3-4 次 → 于是**全都不改**，只能报「有歧义，请人工」。
           实测：一轮下来 12 处"需人工"，绝大多数就是这个原因（而且那些恰恰是最该一次改全的）。
         现在改成：**在每个视图内部**判断 —— 某个视图里恰好出现 1 次 → 就在那个视图里改；
           某个视图里出现 ≥2 次 → 那个视图不动（真歧义），但其余视图照改，并如实报出哪些视图没动。
         安全阀：`replace` 里若带 markdown 记号，写进**思维导图**（纯文本树）前先剥掉，
           免得把 `**加粗**` 带进导图。 */
      const uniq = [], amb = [];
      patchTargets(d).forEach((t) => {
        const s = t.get();
        if (!s) return;
        const n = s.split(find).length - 1;
        if (n === 1) uniq.push(t);
        else if (n > 1) amb.push(t.label);
      });
      if (!uniq.length) {
        const reason = amb.length ? '这段原文在这些视图里出现多次（有歧义）：' + amb.join('、') : '笔记里找不到这段原文';
        skipped.push({ item: r.item, reason: reason, find: find });
        miss.push(reason + '「' + find.slice(0, 22) + '」');
        return;
      }
      uniq.forEach((t) => {
        const use = (t.label === '思维导图') ? repl.replace(/\*\*/g, '').replace(/`/g, '') : repl;
        t.set(t.get().split(find).join(use));
        applied.push({ item: r.item, where: t.label, find: find, replace: use });
        done.push(t.label);
      });
      if (amb.length) {
        skipped.push({ item: r.item, reason: '这些视图里同一片段出现多次（有歧义），只改了其余视图：' + amb.join('、'), find: find });
        miss.push('『' + amb.join('、') + '』里有歧义');
      }
    });
    const bits = [];
    if (done.length) bits.push('已按课件回改 ' + done.join('、'));
    if (miss.length) bits.push('⚠ ' + miss.length + ' 处未自动回改（' + miss.join('；') + '），请按课件为准');
    if (bits.length) r.note = (r.note ? r.note + '　' : '') + '（' + bits.join('；') + '）';
    if (done.length) r.patched = done.join('、');
  });
  /* 补丁只改「能唯一定位」的那一处 —— 同一个错值在别处（正文表格、导图）可能还在。
     这里拿 fromAudio 里的数字复查一遍：**只报「所有行的课件原文里都没有、笔记里还在」的那种数**
     （不猜着乱改）。⚠ 判据要用**全部行**的 fromSlides 的并集：只看本行会把「别的行已经改对的同一个数」误报成可疑
     —— 实测过：小组项目 20%→60% 改对后，正文里新出现的 20%（课程作业/线上测试的正确值）被误报过。 */
  const left = [];
  const hay = patchTargets(d).map((t) => ({ label: t.label, s: t.get() }));
  const slidesAll = (rows || []).map((r) => String((r && r.fromSlides) || '')).join(' ');
  (rows || []).forEach((r) => {
    if (!r || r.verdict !== 'fixed') return;
    const nums = String(r.fromAudio || '').match(/\d+(?:\.\d+)?\s*%/g) || [];
    nums.forEach((raw) => {
      const n = raw.replace(/\s+/g, '');
      if (slidesAll.indexOf(n) >= 0) return;                         // 课件原文（任一行）里有这个数 → 不算可疑
      const where = Array.from(new Set(hay.filter((x) => x.s && x.s.indexOf(n) >= 0).map((x) => x.label)));
      if (where.length) {
        left.push({ item: r.item, value: n, where: where.slice(0, 4) });
        r.note = (r.note ? r.note + '　' : '') + '⚠ 笔记里还有「' + n + '」（' + where.slice(0, 2).join('、') + '），课件里没有这个数，请按课件核对';
      }
    });
  });
  return { applied: applied, skipped: skipped, leftovers: left };
}

/* ---------------- 渲染 ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// ---------- 离线 LaTeX → Unicode/上下标（不引外部库，保证离线可用） ----------
const TEX_SYM = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', approx: '≈', neq: '≠', leq: '≤', geq: '≥',
  ll: '≪', gg: '≫', propto: '∝', partial: '∂', nabla: '∇', sum: 'Σ', prod: '∏', int: '∫',
  infty: '∞', ldots: '…', dots: '…', cdots: '⋯',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  rightarrow: '→', to: '→', longrightarrow: '⟶', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  sqrt: '√', angle: '∠', perp: '⊥', parallel: '∥', endash: '–', quad: ' ', qquad: '  ',
};
function texBody(b) {
  let x = String(b);
  // \frac{a}{b} → (a)/(b)（支持一层嵌套）
  for (let i = 0; i < 2; i++) x = x.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
  x = x.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
  x = x.replace(/\\([A-Za-z]+)/g, (m, w) => (Object.prototype.hasOwnProperty.call(TEX_SYM, w) ? TEX_SYM[w] : w));
  x = x.replace(/\^\{([^{}]*)\}/g, '<sup>$1</sup>').replace(/\^(\\?\w)/g, '<sup>$1</sup>');
  x = x.replace(/_\{([^{}]*)\}/g, '<sub>$1</sub>').replace(/_(\\?\w)/g, '<sub>$1</sub>');
  x = x.replace(/\\[,;:! ]/g, ' ').replace(/\\left|\.|\\right/g, '').replace(/[{}]/g, '');
  x = x.replace(/\s*([×·÷±∓≈≠≤≥≪≫∝→←↔⇒⇐⇔∈∉⊂⊆⊃⊇∪∩∧∨])\s*/g, '$1'); // 运算符两侧不留空格
  return x;
}
// 只有「含 LaTeX 命令」或「含上下标写法」的行内公式才转换，避免把 $100 这种金额误伤
function texInline(s) {
  return String(s)
    .replace(/\$\$?([^$]*\\[A-Za-z]+[^$]*|\\[A-Za-z]+[^$]*)\$\$?/g, (m, b) => '<span class="tex">' + texBody(b) + '</span>')
    .replace(/\$\$?([^$]*[_^]\{[^$]*)\$\$?/g, (m, b) => '<span class="tex">' + texBody(b) + '</span>')
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, b) => '<span class="tex">' + texBody(b) + '</span>');
}

function inline(s) {
  let t = esc(s);
  // 模型偶尔直接吐出 HTML 标记：只白名单还原存疑标签（否则页面上会出现裸标签，实测出现过）
  t = t.replace(/&lt;span class=(?:&quot;|&#39;)flag(?:&quot;|&#39;)&gt;([\s\S]*?)&lt;\/span&gt;/g, '<span class="flag">$1</span>');
  // 纯文字标记 [存疑] 等也渲染成同一样式，避免页面上出现裸方括号
  t = t.replace(/\[(存疑|不确定|听不清|待核实|待查证)\]/g, '<span class="flag">$1</span>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = texInline(t); // 离线渲染行内公式（$...$ / \(...\)）
  return t;
}
function mdToHtml(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let inUl = false, inOl = false;
  const close = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '').replace(/\[存疑\]/g, '<span class="flag">存疑</span>');
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = line.match(/^(#{1,5})\s+(.*)$/))) { close(); const lvl = Math.min(m[1].length + 1, 5); out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>'); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { close(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if (inOl) { out.push('</ol>'); inOl = false; } if (!inUl) { out.push('<ul>'); inUl = true; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (inUl) { out.push('</ul>'); inUl = false; } if (!inOl) { out.push('<ol>'); inOl = true; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { close(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); continue; }
    close(); out.push('<p>' + inline(line) + '</p>');
  }
  close();
  return out.join('\n');
}
function mindmapToHtml(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) return '<p style="color:var(--ink-mute);font-size:14px">（本次笔记没有生成思维导图）</p>';
  const items = lines.map((l) => {
    const m = l.match(/^(\s*)(.*)$/);
    const indent = m[1].replace(/\t/g, '  ');
    return { depth: Math.floor(indent.length / 2), text: m[2].replace(/^[-*+]\s*/, '').trim() };
  }).filter((x) => x.text);
  const base = Math.min.apply(null, items.map((x) => x.depth));
  const root = { text: '', children: [] };
  const stack = [root];
  for (const it of items) {
    const d = it.depth - base;
    while (stack.length > d + 1) stack.pop();
    const node = { text: it.text, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  const list = (nodes) => nodes.map((n) => {
    const kids = n.children.length ? list(n.children) : '';
    const mark = n.children.length ? '' : '<span class="leafmark"><i></i></span>';
    return '<li><div class="row">' + mark + '<span class="lbl">' + inline(n.text) + '</span></div>'
      + (kids ? '<ul>' + kids + '</ul>' : '') + '</li>';
  }).join('');
  return '<ul class="tree">' + list(root.children) + '</ul>';
}
// 要点可能是字符串（老数据）或 {t,text} 对象（带时间戳的现格式）——
// 直接 '- ' + k 会输出 "- [object Object]"（4 份 .md 备份都中过这个招，2026-09-29 修）
function kpText(k) {
  if (k == null) return '';
  if (typeof k === 'string') return k;
  return (k.t ? '[' + k.t + '] ' : '') + (k.text || '');
}
function toMarkdown(d) {
  const L = [];
  L.push('# ' + (d.title || '课堂笔记'));
  if (d.course) L.push('课程：' + d.course);
  if (d.oneLine) L.push('\n> ' + d.oneLine);
  if (d.keyPoints.length) { L.push('\n## 核心要点'); d.keyPoints.forEach((k) => L.push('- ' + kpText(k))); }
  if (d.notes) L.push('\n## 笔记\n' + d.notes);
  if (d.bilingual.length) { L.push('\n## 中英对照'); d.bilingual.forEach((b, i) => L.push('**' + (i + 1) + '.** ' + b.en + '\n> ' + b.zh)); }
  if (d.terms.length) { L.push('\n## 术语表'); L.push('| 英文 | 中文 | 说明 |'); L.push('| --- | --- | --- |'); d.terms.forEach((t) => L.push('| ' + t.en + ' | ' + t.zh + ' | ' + t.note + ' |')); }
  if (d.mindmap) L.push('\n## 思维导图\n```\n' + d.mindmap + '\n```');
  if (d.qa.length) { L.push('\n## 复习问答'); d.qa.forEach((x, i) => L.push((i + 1) + '. **' + x.q + '**\n   ' + x.a)); }
  if (d.todos.length) { L.push('\n## 待办'); d.todos.forEach((t) => L.push('- [ ] ' + t)); }
  if (d.handout && d.handout.rows && d.handout.rows.length) {
    const V = { fixed: '以课件为准', same: '一致', notInSlides: '课件未提及' };
    L.push('\n## 课件核对（' + (d.handout.deck || '课件') + '　' + (d.handout.range || '') + '）');
    if (d.handout.how) L.push('> 判讲依据：' + (d.handout.basis === 'overlap' ? '⚠ ' : '') + d.handout.how);
    /* 课件是按进度沿用的（这节课没有新课件）时要写明来源 —— 否则读者以为"核对用的就是这节课的课件"。 */
    if (d.handout.deckSrc === 'carry') L.push('> ⚠ 课件来源：' + String(d.handout.deckWhy || '沿用最近一次课件')
      + '（老师若已发新课件：先跑一次 整理课件.cmd 再重跑本笔记；想手动指定加 --deck 关键词）');
    /* ⚠ 仍可疑（2026-10-06 起也渲染进 MD）：课件里没有、笔记里还留着的值 —— 以前只打控制台。 */
    if (d.handout.leftovers && d.handout.leftovers.length) {
      L.push('> ⚠ 仍可疑 ' + d.handout.leftovers.length + ' 处（课件里没有这些值、笔记里还在）：'
        + d.handout.leftovers.map((x) => x.value + '（' + (x.where || []).join('、') + '）').join('、'));
    }
    if (d.handout.applied && d.handout.applied.length) {
      L.push('> 已按课件**回改正文 ' + d.handout.applied.length + ' 处**：'
        + d.handout.applied.map((x) => (x.where || '正文') + '「' + String(x.item || '').slice(0, 24) + '」').join('、'));
    }
    if (d.handout.skipped && d.handout.skipped.length) {
      L.push('> ⚠ 有 ' + d.handout.skipped.length + ' 处**未能自动回改**（原文找不到或有歧义），请按课件为准：'
        + d.handout.skipped.map((x) => String(x.item || '').slice(0, 24)).join('、'));
    }
    L.push('| 项目 | 笔记/录音 | 课件 | 结论 |');
    L.push('| --- | --- | --- | --- |');
    d.handout.rows.forEach((r) => L.push('| ' + r.item + ' | ' + r.fromAudio + ' | ' + r.fromSlides + ' | ' + (V[r.verdict] || '一致') + ' |'));
    if (d.handout.extra && d.handout.extra.length) {
      L.push('');
      L.push('**课件里有、笔记没覆盖到的要点：**');
      d.handout.extra.forEach((x) => L.push('- ' + x));
    }
  }
  return L.join('\n');
}

const SHELL_BUILTIN = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title><!--TITLE--> · 课堂笔记</title>
<style>
/* ---------- 设计系统：单一强调色 + 中性表面 + 排版尺度 ---------- */
:root{
  --paper:#fbfaf8; --surface:#ffffff; --ink:#1b1a17; --ink-soft:#4a4844; --ink-mute:#6f6c66;
  --line:#e5e2dc; --line-soft:#eeebe5; --accent:#0f766e; --accent-ink:#0b5d57; --accent-wash:#eef7f5;
  --shadow:0 1px 2px rgba(28,26,22,.05), 0 8px 24px -12px rgba(28,26,22,.18);
  --r:14px; --r-sm:8px;
  --sans:system-ui,-apple-system,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,"Noto Sans Mono CJK SC",monospace;
  --col:74ch;
}
@media (prefers-color-scheme: dark){
  :root{ --paper:#141516; --surface:#1b1d1e; --ink:#eceae6; --ink-soft:#c3c0ba; --ink-mute:#96938c;
         --line:#2c2f30; --line-soft:#242728; --accent:#5eead4; --accent-ink:#8ff3e2; --accent-wash:#14302e;
         --shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 30px -14px rgba(0,0,0,.6); }
}
body.light{ --paper:#fbfaf8; --surface:#ffffff; --ink:#1b1a17; --ink-soft:#4a4844; --ink-mute:#6f6c66;
  --line:#e5e2dc; --line-soft:#eeebe5; --accent:#0f766e; --accent-ink:#0b5d57; --accent-wash:#eef7f5;
  --shadow:0 1px 2px rgba(28,26,22,.05), 0 8px 24px -12px rgba(28,26,22,.18); }
body.dark{ --paper:#141516; --surface:#1b1d1e; --ink:#eceae6; --ink-soft:#c3c0ba; --ink-mute:#96938c;
  --line:#2c2f30; --line-soft:#242728; --accent:#5eead4; --accent-ink:#8ff3e2; --accent-wash:#14302e;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 30px -14px rgba(0,0,0,.6); }

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
  font-size:15.5px;line-height:1.72;font-variant-numeric:proportional-nums;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
@media (prefers-reduced-motion:no-preference){ html{scroll-behavior:smooth} }
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
a{color:var(--accent-ink);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}
a:hover{border-bottom-color:var(--accent)}
.skip{position:absolute;left:-9999px}
.skip:focus{left:12px;top:12px;background:var(--surface);padding:8px 12px;border-radius:var(--r-sm);z-index:9}

.progress{position:fixed;inset:0 0 auto 0;height:2px;background:transparent;z-index:8}
.progress i{display:block;height:100%;width:0;background:var(--accent);opacity:.55}

.shell{max-width:1180px;margin:0 auto;padding:0 24px 96px}
.masthead{padding:56px 0 28px;max-width:var(--col)}
h1{font-size:clamp(26px,3.4vw,38px);line-height:1.14;letter-spacing:-.022em;margin:0;font-weight:660}
.lead{margin:16px 0 0;font-size:17.5px;line-height:1.62;color:var(--ink-soft);max-width:60ch}
.facts{margin:22px 0 0;display:flex;flex-wrap:wrap;gap:6px 22px;font-size:13px;color:var(--ink-mute)}
.facts div{display:flex;gap:6px}
.facts b{font-weight:560;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin:26px 0 0}
button{font:inherit;font-size:13px;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);
  border-radius:999px;padding:7px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;
  transition:transform .16s cubic-bezier(.2,.8,.2,1), border-color .16s, color .16s}
button:hover{border-color:var(--accent);color:var(--accent-ink)}
button:active{transform:translateY(1px)}
button svg{width:15px;height:15px;flex:none}

.layout{display:grid;grid-template-columns:1fr;gap:0}
@media (min-width:1080px){
  .layout{grid-template-columns:212px minmax(0,1fr);gap:56px}
  .toc{position:sticky;top:28px;align-self:start;max-height:calc(100vh - 56px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
}
.toc nav{padding-top:8px}
.toc h2{font-size:12.5px;font-weight:600;color:var(--ink-mute);margin:0 0 10px;letter-spacing:.02em}
.toc ol{list-style:none;margin:0;padding:0;counter-reset:t}
.toc li{margin:0}
.toc a{display:block;padding:5px 0 5px 12px;font-size:13.5px;color:var(--ink-soft);border:0;max-width:100%;
  border-left:1px solid transparent;transition:color .16s,border-color .16s}
.toc a:hover{color:var(--accent-ink)}
.toc a.on{color:var(--accent-ink);border-left-color:var(--accent)}

main{min-width:0}
section{padding-top:34px;margin-top:38px;border-top:1px solid var(--line-soft);scroll-margin-top:24px}
section:first-of-type{border-top:0;margin-top:8px;padding-top:0}
h2.sec{font-size:19px;line-height:1.3;letter-spacing:-.012em;margin:0 0 18px;font-weight:640}
.prose{max-width:var(--col)}
.prose h3{font-size:16px;margin:30px 0 10px;letter-spacing:-.008em;font-weight:620}
.prose h4{font-size:14.5px;margin:22px 0 8px;font-weight:620;color:var(--ink-soft)}
.prose p{margin:0 0 14px}
.prose ul,.prose ol{margin:0 0 16px;padding-left:22px}
.prose li{margin:6px 0}
.prose strong{font-weight:640}
.prose blockquote{margin:16px 0;padding:2px 0 2px 16px;border-left:1px solid var(--line);color:var(--ink-soft)}
.prose hr{border:0;border-top:1px solid var(--line-soft);margin:26px 0}
code{font-family:var(--mono);font-size:13px;background:var(--line-soft);padding:1.5px 5px;border-radius:5px}

ol.points{margin:0;padding:0 0 0 30px;max-width:var(--col)}
ol.points li{margin:12px 0;padding-left:4px}
ol.points li::marker{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:600}

.bi{display:grid;grid-template-columns:1fr;gap:0;max-width:var(--col)}
@media (min-width:900px){ .bi{grid-template-columns:1fr 1fr;column-gap:32px;max-width:none} }
.bi .row{display:contents}
.bi .pair{padding:16px 0;border-top:1px solid var(--line-soft)}
@media (min-width:900px){
  .bi .pair{padding:16px 0}
  .bi .pair:nth-child(2n){border-left:1px solid var(--line-soft);padding-left:32px;margin-left:-32px}
}
.bi .en{margin:0;font-size:15.5px;line-height:1.62;color:var(--ink)}
.bi .zh{margin:7px 0 0;font-size:14.5px;line-height:1.7;color:var(--ink-mute)}
.bi .idx{font-size:12px;color:var(--ink-mute);font-variant-numeric:tabular-nums;margin-right:8px}

table.terms{width:100%;border-collapse:collapse;font-size:14.5px}
table.terms th{text-align:left;font-weight:600;font-size:13px;color:var(--ink-mute);padding:0 14px 10px 0;
  border-bottom:1px solid var(--line);white-space:nowrap}
table.terms td{padding:11px 14px 11px 0;border-bottom:1px solid var(--line-soft);vertical-align:top}
table.terms td:first-child{color:var(--ink);font-weight:520;white-space:nowrap}
table.terms td:nth-child(2){color:var(--ink-soft)}
table.terms td:last-child{color:var(--ink-mute);padding-right:0}
table.terms tr:last-child td{border-bottom:0}

ul.tree,ul.tree ul{list-style:none;margin:0;padding:0}
ul.tree ul{margin-left:11px;padding-left:20px;border-left:1px solid var(--line-soft)}
ul.tree li{position:relative;padding:3px 0}
ul.tree .row{display:flex;align-items:flex-start;gap:7px}
ul.tree .tog{flex:none;width:18px;height:18px;margin-top:2px;padding:0;border:1px solid var(--line);border-radius:5px;
  background:var(--surface);color:var(--ink-mute);display:grid;place-items:center;cursor:pointer}
ul.tree .tog svg{width:10px;height:10px;transition:transform .18s cubic-bezier(.2,.8,.2,1)}
ul.tree li.open>.row>.tog svg{transform:rotate(90deg)}
ul.tree .lbl{font-size:14.5px;color:var(--ink-soft);line-height:1.55}
ul.tree>li>.row>.lbl{font-size:16px;font-weight:620;color:var(--ink)}
ul.tree>li>ul>li>.row>.lbl{font-weight:600;color:var(--ink)}
ul.tree li:not(.open)>ul{display:none}
ul.tree .leafmark{flex:none;width:18px;height:18px;margin-top:3px;display:grid;place-items:center}
ul.tree .leafmark i{width:4px;height:4px;border-radius:50%;background:var(--line);display:block}

.qa{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);
  padding:26px 26px 20px;max-width:var(--col)}
.qa .q{font-size:18px;line-height:1.45;font-weight:620;margin:0;letter-spacing:-.01em;min-height:3.1em}
.qa .a{margin:12px 0 0;font-size:15px;line-height:1.68;color:var(--ink-soft);min-height:3.4em;
  opacity:0;transform:translateY(-4px);transition:opacity .24s cubic-bezier(.2,.8,.2,1),transform .24s cubic-bezier(.2,.8,.2,1)}
.qa.revealed .a{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){ .qa .a{transition:none;opacity:1;transform:none} }
.qa .ctrl{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line-soft)}
.qa .count{font-size:12.5px;color:var(--ink-mute);font-variant-numeric:tabular-nums;margin-left:auto}
.kbd{font-family:var(--mono);font-size:11px;color:var(--ink-mute);border:1px solid var(--line);border-radius:5px;padding:1px 5px}

ul.todos{list-style:none;margin:0;padding:0;max-width:var(--col)}
ul.todos li{display:flex;gap:11px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line-soft)}
ul.todos li:last-child{border-bottom:0}
ul.todos input{margin:4px 0 0;width:16px;height:16px;accent-color:var(--accent);flex:none}
ul.todos label{font-size:15px;color:var(--ink-soft);cursor:pointer}
ul.todos li.done label{color:var(--ink-mute);text-decoration:line-through;text-decoration-thickness:1px}

footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line-soft);color:var(--ink-mute);font-size:12.5px;line-height:1.9}

@media print{
  :root,body{--paper:#fff;--surface:#fff;--ink:#000;--ink-soft:#333;--ink-mute:#555;--line:#ccc;--line-soft:#e2e2e2}
  .progress,.toc,.bar,.qa .ctrl,footer .noprint{display:none}
  .shell{max-width:none;padding:0}
  .layout{display:block}
  section{break-inside:avoid;border-top:1px solid #ddd}
  .qa{box-shadow:none}
  .qa .a{opacity:1;transform:none}
  ul.tree li:not(.open)>ul{display:block}
  a{color:#000;border:0}
}
</style>
</head>
<body>
<a class="skip" href="#start">跳到正文</a>
<div class="progress" aria-hidden="true"><i id="pg"></i></div>

<div class="shell">
  <header class="masthead">
    <h1><!--TITLE--></h1>
    <p class="lead"><!--ONELINE--></p>
    <div class="facts"><!--FACTS--></div>
    <div class="bar">
      <button id="btnTheme" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>主题</button>
      <button id="btnMd" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>复制 Markdown</button>
      <button id="btnJson" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>导出 JSON</button>
      <button id="btnPrint" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8V3h10v5"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 14h10v7H7z"/></svg>打印 / PDF</button>
    </div>
  </header>

  <div class="layout" id="start">
    <aside class="toc">
      <nav aria-label="目录">
        <h2>本页内容</h2>
        <ol><!--TOC--></ol>
      </nav>
    </aside>

    <main>
      <section id="points">
        <h2 class="sec">核心要点</h2>
        <!--KEYPOINTS-->
      </section>

      <section id="notes">
        <h2 class="sec">结构化笔记</h2>
        <div class="prose"><!--NOTES--></div>
      </section>

      <section id="bilingual">
        <h2 class="sec">中英对照</h2>
        <div class="bi"><!--BILINGUAL--></div>
      </section>

      <section id="terms">
        <h2 class="sec">术语表</h2>
        <!--TERMS-->
      </section>

      <section id="mindmap">
        <h2 class="sec">思维导图</h2>
        <p class="hint" style="font-size:13px;color:var(--ink-mute);margin:-8px 0 14px">点方框可展开／收起；也可整块复制后粘进 XMind。</p>
        <!--MINDMAP-->
      </section>

      <section id="qa">
        <h2 class="sec">复习问答</h2>
        <div class="qa" id="qa">
          <p class="q" id="qaQ">—</p>
          <p class="a" id="qaA"></p>
          <div class="ctrl">
            <button id="qaPrev" type="button" aria-label="上一题"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>上一题</button>
            <button id="qaShow" type="button">显示答案 <span class="kbd">空格</span></button>
            <button id="qaNext" type="button" aria-label="下一题">下一题<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>
            <span class="count" id="qaCount">0 / 0</span>
          </div>
        </div>
      </section>

      <section id="todos">
        <h2 class="sec">待办</h2>
        <!--TODOS-->
      </section>
    </main>
  </div>

  <footer>
    由本地 pipeline 生成：whisper.cpp 转写 + DeepSeek 加工 · <!--GENAT--><br>
    转写稿中识别存疑处标有 [存疑]；重要数字、公式与截止日期请回看课件核对。
    <span class="noprint">勾选状态保存在本机浏览器里。</span>
  </footer>
</div>

<script type="application/json" id="raw"><!--RAWJSON--></script>
<script>
(function(){
  var raw = JSON.parse(document.getElementById('raw').textContent);
  var KEY = 'lecture-notes:' + (raw.title || 'untitled');

  /* 主题：默认跟随系统，手动选择后记住 */
  var saved = localStorage.getItem(KEY + ':theme');
  if (saved === 'light') document.body.classList.add('light');
  if (saved === 'dark') document.body.classList.add('dark');
  document.getElementById('btnTheme').onclick = function(){
    var isDark = document.body.classList.contains('dark') ||
      (!document.body.classList.contains('light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.remove('light','dark');
    var next = isDark ? 'light' : 'dark';
    document.body.classList.add(next);
    localStorage.setItem(KEY + ':theme', next);
  };

  /* 阅读进度 */
  var pg = document.getElementById('pg');
  function onScroll(){
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    pg.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
  }
  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* 目录高亮 */
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  var secs = links.map(function(a){ return document.querySelector(a.getAttribute('href')); });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        var i = secs.indexOf(en.target);
        links.forEach(function(l, k){ l.classList.toggle('on', k === i); });
      });
    }, { rootMargin: '-10% 0px -70% 0px' });
    secs.forEach(function(s){ if (s) io.observe(s); });
  }

  /* 思维导图：默认展开一层，点方框折叠 */
  document.querySelectorAll('ul.tree li').forEach(function(li){
    var sub = li.querySelector(':scope > ul');
    if (!sub) return;
    li.classList.add('tree-branch');
    var row = li.querySelector(':scope > .row');
    if (!row) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tog';
    btn.setAttribute('aria-expanded', 'true');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
    var mark = row.querySelector('.leafmark');
    if (mark) mark.remove();
    btn.onclick = function(e){
      e.preventDefault();
      var open = li.classList.toggle('open');
      li.classList.toggle('collected', !open);
      btn.setAttribute('aria-expanded', String(open));
    };
    row.insertBefore(btn, row.firstChild);
    li.classList.add('open');
  });

  /* 问答卡 */
  var qa = raw.qa || [], qi = 0, revealed = false;
  var elQ = document.getElementById('qaQ'), elA = document.getElementById('qaA'),
      elC = document.getElementById('qaCount'), elCard = document.getElementById('qa'),
      elShow = document.getElementById('qaShow');
  function drawQa(){
    if (!qa.length) { elQ.textContent = '（本次笔记没有生成问答）'; elC.textContent = '0 / 0'; elShow.disabled = true; return; }
    elQ.textContent = qa[qi].q || '';
    elA.textContent = revealed ? (qa[qi].a || '') : '';
    elCard.classList.toggle('revealed', revealed);
    elShow.textContent = revealed ? '隐藏答案' : '显示答案';
    elC.textContent = (qi + 1) + ' / ' + qa.length;
  }
  elShow.onclick = function(){ revealed = !revealed; drawQa(); };
  elCard.onclick = function(e){ if (e.target.closest('.ctrl')) return; revealed = !revealed; drawQa(); };
  document.getElementById('qaNext').onclick = function(){ if (!qa.length) return; qi = (qi + 1) % qa.length; revealed = false; drawQa(); };
  document.getElementById('qaPrev').onclick = function(){ if (!qa.length) return; qi = (qi - 1 + qa.length) % qa.length; revealed = false; drawQa(); };
  document.addEventListener('keydown', function(e){
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''))) return;
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); revealed = !revealed; drawQa(); }
    if (e.key === 'ArrowRight') { document.getElementById('qaNext').click(); }
    if (e.key === 'ArrowLeft') { document.getElementById('qaPrev').click(); }
  });
  drawQa();

  /* 待办勾选持久化 */
  document.querySelectorAll('ul.todos input[type=checkbox]').forEach(function(box, i){
    var k = KEY + ':todo:' + i;
    if (localStorage.getItem(k) === '1') { box.checked = true; box.closest('li').classList.add('done'); }
    box.onchange = function(){
      localStorage.setItem(k, box.checked ? '1' : '0');
      box.closest('li').classList.toggle('done', box.checked);
    };
  });

  /* 导出 */
  function buildMd(){
    var L = [], t = raw.title || '课堂笔记';
    L.push('# ' + t);
    if (raw.course) L.push('课程：' + raw.course);
    if (raw.oneLine) L.push('', '> ' + raw.oneLine);
    function kpT(k){ return k == null ? '' : (typeof k === 'string' ? k : (k.t ? '[' + k.t + '] ' : '') + (k.text || '')); }
    if ((raw.keyPoints || []).length) { L.push('', '## 核心要点'); raw.keyPoints.forEach(function(k){ L.push('- ' + kpT(k)); }); }
    if (raw.notes) L.push('', '## 笔记', raw.notes);
    if ((raw.bilingual || []).length) { L.push('', '## 中英对照'); raw.bilingual.forEach(function(b, n){ L.push('**' + (n + 1) + '.** ' + b.en, '> ' + b.zh); }); }
    if ((raw.terms || []).length) { L.push('', '## 术语表', '| 英文 | 中文 | 说明 |', '| --- | --- | --- |'); raw.terms.forEach(function(x){ L.push('| ' + x.en + ' | ' + x.zh + ' | ' + x.note + ' |'); }); }
    if (raw.mindmap) L.push('', '## 思维导图', raw.mindmap);
    if ((raw.qa || []).length) { L.push('', '## 复习问答'); raw.qa.forEach(function(x, n){ L.push((n + 1) + '. **' + x.q + '**', '   ' + x.a); }); }
    if ((raw.todos || []).length) { L.push('', '## 待办'); raw.todos.forEach(function(x){ L.push('- [ ] ' + x); }); }
    if (raw.handout && raw.handout.rows && raw.handout.rows.length) {
      var VV = { fixed: '以课件为准', same: '一致', notInSlides: '课件未提及' };
      L.push('', '## 课件核对（' + (raw.handout.deck || '课件') + '　' + (raw.handout.range || '') + '）');
      if (raw.handout.how) L.push('> 判讲依据：' + (raw.handout.basis === 'overlap' ? '⚠ ' : '') + raw.handout.how);
      if (raw.handout.deckSrc === 'carry') L.push('> ⚠ 课件来源：' + String(raw.handout.deckWhy || '沿用最近一次课件')
        + '（老师若已发新课件：先跑一次 整理课件.cmd 再重跑本笔记；想手动指定加 --deck 关键词）');
      if ((raw.handout.leftovers || []).length) {
        L.push('> ⚠ 仍可疑 ' + raw.handout.leftovers.length + ' 处（课件里没有这些值、笔记里还在）：'
          + raw.handout.leftovers.map(function (x) { return x.value + '（' + (x.where || []).join('、') + '）'; }).join('、'));
      }
      L.push('| 项目 | 笔记/录音 | 课件 | 结论 |', '| --- | --- | --- | --- |');
      raw.handout.rows.forEach(function(r){ L.push('| ' + r.item + ' | ' + r.fromAudio + ' | ' + r.fromSlides + ' | ' + (VV[r.verdict] || '一致') + ' |'); });
      (raw.handout.extra || []).forEach(function(x){ L.push('- ' + x); });
    }
    return L.join('\\n');
  }
  document.getElementById('btnMd').onclick = function(){
    var txt = buildMd();
    function ok(){ flash('Markdown 已复制'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(ok, function(){ fallback(txt); });
    } else { fallback(txt); }
    function fallback(t){
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { alert('复制失败，请手动选择正文'); }
      ta.remove();
    }
  };
  document.getElementById('btnJson').onclick = function(){
    var blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (raw.title || 'notes') + '.json';
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
  };
  document.getElementById('btnPrint').onclick = function(){ window.print(); };

  function flash(msg){
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--ink);' +
      'color:var(--paper);padding:9px 16px;border-radius:999px;font-size:13px;z-index:20;opacity:0;transition:opacity .2s';
    document.body.appendChild(d);
    requestAnimationFrame(function(){ d.style.opacity = '1'; });
    setTimeout(function(){ d.style.opacity = '0'; setTimeout(function(){ d.remove(); }, 250); }, 1600);
  }
})();
</script>
</body>
</html>`;

// 模板外置：优先读同目录 shell.html（调视觉不用动逻辑；文件缺失时回退到内置版）
const SHELL = (function () {
  try {
    const p = path.join(__dirname, 'shell.html');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (e) { /* 回退 */ }
  return SHELL_BUILTIN;
})();

function renderHtml(d, meta) {
  const esc2 = esc;
  const hasPlayer = !!(meta && meta.audioSrc);
  const tsChip = (ts) => {
    if (!ts) return '';
    const sec = tsToSec(ts);
    if (sec == null) return '';
    return hasPlayer
      ? '<span class="ts" data-t="' + sec + '" title="跳到录音此处">' + esc2(ts) + '</span>'
      : '<span class="ts plain" title="录音时间点">' + esc2(ts) + '</span>';
  };
  const playerHtml = hasPlayer
    ? '<div class="player"><audio id="lecAudio" controls preload="metadata" src="' + esc2(meta.audioSrc) + '"></audio><span class="hint">点 [时间] 可跳听原话</span></div>'
    : '';
  const course = d.course || meta.course || '未指定课程';

  // 左栏元信息：只留对学习有用的（时长 + 日期）。
  // 转写模型 / 参数档 / 字数统计 / 发言人覆盖率属于技术细节，用户 2026-09-29 明确要求去掉——
  // 那一栏要留给知识本身；这些诊断信息在控制台日志和笔记同名 .json 里都还在。
  const facts = [];
  if (meta.durationLabel) facts.push(['时长', meta.durationLabel]);
  if (meta.dateLabel) facts.push([meta.dateFrom || '记录日期', meta.dateLabel]);
  const factsHtml = facts.map((f) => '<div><b>' + esc2(f[0]) + '</b><span>' + esc2(f[1]) + '</span></div>').join('');

  const kp = d.keyPoints.length
    ? '<ol class="points">' + d.keyPoints.map((k) => '<li>' + tsChip(k.t) + inline(k.text) + '</li>').join('') + '</ol>'
    : '<p style="color:var(--ink-mute)">（本次没有生成要点）</p>';

  const SAY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/></svg>';
  const sayBtn = (text) => '<button class="say" type="button" data-say="' + esc2(text) + '" title="朗读（英式发音）" aria-label="朗读这句英文">' + SAY_ICON + '</button>';

  const bi = d.bilingual.length
    ? d.bilingual.map((b, i) => '<div class="pair"><p class="en">' + tsChip(b.t) + '<span class="idx">' + (i + 1) + '</span>' + inline(b.en) + ' ' + sayBtn(b.en)
      + '</p><p class="zh">' + inline(b.zh) + '</p></div>').join('')
    : '<p style="color:var(--ink-mute)">（本次没有生成中英对照）</p>';

  const terms = d.terms.length
    ? '<table class="terms"><thead><tr><th style="width:24%">英文</th><th style="width:18%">中文</th><th>说明</th></tr></thead><tbody>'
      + d.terms.map((t) => '<tr><td>' + esc2(t.en) + ' ' + sayBtn(t.en) + '</td><td>' + esc2(t.zh) + '</td><td>' + inline(t.note) + '</td></tr>').join('')
      + '</tbody></table>'
    : '<p style="color:var(--ink-mute)">（本次没有提取术语）</p>';

  const todos = d.todos.length
    ? '<p style="font-size:13px;color:var(--ink-mute);margin:-8px 0 12px"><span id="todoBar">0 / ' + d.todos.length + ' 已完成</span></p>'
      + '<ul class="todos">' + d.todos.map((t, i) => '<li><input type="checkbox" id="td' + i + '"><label for="td' + i + '">' + inline(t) + '</label></li>').join('') + '</ul>'
    : '<p style="color:var(--ink-mute)">（本次没有待办）</p>';

  /* 课件核对：拿幻灯片原文对账（术语/数字/公式以课件为准）。
     ⚠ 用词底线（2026-09-30 更新）：这个视图现在**会**回改正文（applyHandoutPatches：唯一匹配才改、逐条打印），
     所以可以诚实地说「已按课件回改 N 处」——N 来自 data.handout.applied，不是空话；
     但**没改成的必须写明原因**，绝不能让人以为正文已经改好。 */
  const HO_V = { fixed: ['以课件为准', 'fix'], same: ['一致', 'same'], notInSlides: ['课件未提及', 'same'] };
  const ho = (d.handout && d.handout.rows && d.handout.rows.length) ? d.handout : null;
  /* 判讲依据：让「这次核对可不可信」在笔记里一眼可见。
     ⚠ 为什么必须落盘：词重叠兜底档实测会把 18 讲里的 14 讲全选中（送进 14 万字符课件原文），
     而它和「AI 按主题判讲」在笔记里长得**一模一样** —— 只有日志能区分，过几天就无从判断。
     basis 取值：manual（--pages）/ single（课件只有一讲）/ model（AI 判讲）/ overlap（词重叠兜底）。 */
  const hoWhy = (ho && ho.how) ? String(ho.how) : '';
  const hoBasisLine = ho
    ? '<br>判讲依据：' + (hoWhy
      ? (ho.basis === 'overlap'
        ? '<b style="color:#b4531f">' + esc2(hoWhy) + '</b>'
        : esc2(hoWhy))
      : '<span style="color:var(--ink-mute)">未记录（这份笔记生成于该字段上线之前；重跑一次即可补上）</span>')
    : '';
  /* 课件来源：只有「沿用最近一次那份」（这节没有新课件）才需要提醒 —— 那是按进度推的，
     老师若已发新课件而还没整理进来，这次核对就是拿旧课件对的（而核对是「以课件为准」的）。 */
  const hoDeckLine = (ho && ho.deckSrc === 'carry')
    ? '<br><b style="color:#b4531f">⚠ 课件来源：' + esc2(String(ho.deckWhy || '沿用最近一次课件')) + '</b>'
      + '<span style="color:var(--ink-mute)">（老师若已发新课件：先跑一次 <code>整理课件.cmd</code> 再重跑本笔记；'
      + '想手动指定就加 <code>--deck</code> 关键词）</span>'
    : '';
  const handout = ho
    ? '<p class="ho-src">核对来源：' + esc2(ho.deck || '课件') + '（' + esc2(ho.range || '') + '）'
      + '　共核对 ' + ho.rows.length + ' 项'
      + (ho.applied && ho.applied.length ? '　<b>已按课件回改正文 ' + ho.applied.length + ' 处</b>' : '')
      + (ho.skipped && ho.skipped.length ? '　' + ho.skipped.length + ' 处未能自动回改（见下表备注）' : '')
      + (ho.extra && ho.extra.length ? '　课件另有 ' + ho.extra.length + ' 条要点是笔记没覆盖的' : '')
      /* ⚠ 仍可疑（2026-10-06 起也渲染进笔记）：这些是「课件里没有、笔记里还在」的数，
         以前只打在控制台、笔记里看不到 —— 读的人就以为都改干净了。 */
      + (ho.leftovers && ho.leftovers.length
        ? '　<b style="color:#b4531f">⚠ ' + ho.leftovers.length + ' 处仍可疑</b>'
          + '（课件里没有、笔记里还在：' + ho.leftovers.map((x) => esc2(String(x.value))).join('、') + '，见表中备注）'
        : '')
      + hoBasisLine
      + hoDeckLine
      + '<br>本视图<b>拿课件核对正文</b>：标「以课件为准」的行，能唯一定位原文的<b>已直接改好正文</b>；'
      + '改不动的会在备注里写明原因（原文仍保留在「笔记 / 录音里的说法」那一列，便于对照）。'
      + '<br><span style="color:var(--ink-mute)">想只要报告、不改正文：重跑时加 <code>--no-handout-patch</code>。</span></p>'
      + '<div class="tablewrap"><table class="terms ho"><thead><tr>'
      + '<th>项目</th><th>笔记 / 录音里的说法</th><th>课件里的说法</th><th>结论</th>'
      + '</tr></thead><tbody>'
      + ho.rows.map((r) => {
        const v = HO_V[r.verdict] || HO_V.same;
        return '<tr><td>' + inline(r.item) + '</td><td>' + inline(r.fromAudio) + '</td><td>' + inline(r.fromSlides) + '</td>'
          + '<td><span class="ho-v ' + v[1] + '">' + v[0] + '</span>'
          + (r.note ? '<br><span style="color:var(--ink-mute);font-size:12.5px">' + inline(r.note) + '</span>' : '') + '</td></tr>';
      }).join('')
      + '</tbody></table></div>'
      + (ho.extra && ho.extra.length
        ? '<ul class="ho-extra">' + ho.extra.map((x) => '<li>' + inline(x) + '</li>').join('') + '</ul>' : '')
    : '<p style="color:var(--ink-mute)">（本次没有找到对应课件，未做核对；把该课程的幻灯片放进 <b>课件\\&lt;课程名&gt;\\</b> 再重跑一次即可）</p>';

  const sections = [
    ['points', '核心要点', d.keyPoints.length],
    ['notes', '结构化笔记', (d.notes || '').trim().length],
    ['bilingual', '中英对照', d.bilingual.length],
    ['terms', '术语表', d.terms.length],
    ['mindmap', '思维导图', (d.mindmap || '').trim().length],
    ['qa', '复习问答', d.qa.length],
    ['todos', '待办', d.todos.length],
    ['handout', '课件核对', ho ? ho.rows.length : 0],
  ].filter((s) => s[2]);
  const tocHtml = sections.map((s) => '<li><a href="#' + s[0] + '">' + s[1] + '</a></li>').join('');

  const rawJson = JSON.stringify(d).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

  // 注意：模板里部分占位符会出现多次（如标题），必须全局替换
  const set = (tpl, token, value) => tpl.split(token).join(value);
  let html = SHELL;
  html = set(html, '<!--TITLE-->', esc2(d.title || course || '课堂笔记'));
  html = set(html, '<!--ONELINE-->', esc2(d.oneLine || ''));
  html = set(html, '<!--FACTS-->', factsHtml);
  html = set(html, '<!--TOC-->', tocHtml);
  html = set(html, '<!--SIBLINGS-->', (meta && meta.siblings) || '');
  html = set(html, '<!--KEYPOINTS-->', kp);
  html = set(html, '<!--NOTES-->', mdToHtml(d.notes));
  html = set(html, '<!--BILINGUAL-->', bi);
  html = set(html, '<!--TERMS-->', terms);
  html = set(html, '<!--MINDMAP-->', mindmapToHtml(d.mindmap));
  html = set(html, '<!--PLAYER-->', playerHtml);
  html = set(html, '<!--TODOS-->', todos);
  html = set(html, '<!--HANDOUT-->', handout);
  html = set(html, '<!--RAWJSON-->', rawJson);
  html = set(html, '<!--GENAT-->', esc2(new Date().toLocaleString('zh-CN')));
  return html;
}

/* ---------------- Mock（离线测渲染） ---------------- */
const MOCK_DATA = {
  course: '示例课程（离线测试）',
  title: '卷积神经网络与反向传播',
  oneLine: '本节课讲清卷积层的前向计算、池化作用与反向传播的梯度推导。',
  keyPoints: ['卷积核在输入上滑动做加权求和，输出特征图', '池化只降维不改变通道数，起平移不变性作用', '反向传播用链式法则逐层回传梯度', '学习率过大会导致损失震荡不收敛'],
  bilingual: [
    { en: 'A convolution is basically a sliding dot product between the kernel and the input patch.', zh: '卷积本质上就是卷积核与输入小块之间的滑动点积。' },
    { en: 'Pooling does not change the number of channels; it only reduces the spatial resolution.', zh: '池化不改变通道数，只降低空间分辨率。' },
    { en: 'If your learning rate is too high, you will see the loss oscillate instead of going down.', zh: '如果学习率过大，你会看到损失震荡而不是下降。' },
  ],
  notes: '## 1. 卷积层\n- 输入 $H\\times W\\times C_{in}$，卷积核 $k\\times k$，输出通道数 $C_{out}$\n- 输出尺寸 $H_{out} = \\lfloor (H - k + 2p)/s \\rfloor + 1$\n- 参数量：$k\\cdot k\\cdot C_{in}\\cdot C_{out}$\n\n## 2. 池化层\n- 常见 2×2 最大池化，步长 2，空间尺寸减半\n- 无可学习参数，反向传播时梯度只回传给最大值位置\n\n## 3. 反向传播\n- 链式法则：$\\frac{\\partial L}{\\partial w} = \\frac{\\partial L}{\\partial y}\\cdot\\frac{\\partial y}{\\partial w}$\n- 讲师强调：先手推两层网络再调库，否则调参全靠猜\n\n## 4. 实践注意\n- 学习率 1e-2 以上容易震荡[存疑：讲师原话数量级略含糊]\n- 数据标准化能显著影响收敛速度',
  terms: [
    { en: 'convolution kernel', zh: '卷积核', note: '在输入上滑动做点积的小矩阵' },
    { en: 'feature map', zh: '特征图', note: '卷积输出的二维激活图' },
    { en: 'backpropagation', zh: '反向传播', note: '用链式法则从输出向输入逐层求梯度' },
    { en: 'learning rate', zh: '学习率', note: '每步参数更新的缩放系数' },
  ],
  mindmap: '卷积神经网络\n  卷积层\n    滑动点积\n    输出尺寸公式\n    参数量\n  池化层\n    最大池化\n    反向传播只回传最大值\n  反向传播\n    链式法则\n    先手推再调库\n  实践\n    学习率过大→震荡\n    数据标准化',
  qa: [
    { q: '卷积输出的空间尺寸怎么算？', a: '$H_{out} = \\lfloor (H-k+2p)/s \\rfloor + 1$，注意向下取整。' },
    { q: '池化层有可学习参数吗？', a: '没有。反向传播时梯度只回传给被选中的最大值位置。' },
    { q: '为什么学习率不能设太大？', a: '会导致损失震荡甚至发散，而不是稳定下降。' },
  ],
  todos: ['手推一个两层网络的完整反向传播', '用 PyTorch 复现课上公式并与输出尺寸对照', '复习课件里关于初始化方法的部分'],
};

/* ---------------- 主流程 ---------------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  QUIET_MODE = !!args.quiet;
  startLog();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (args.where) {
    const k = loadApiKey();
    if (!k) { console.log('[X] 没找到 DeepSeek API Key（可写 config.json 或设环境变量 DEEPSEEK_API_KEY）'); process.exit(2); }
    console.log('[√] 找到 Key：来源 = ' + k.from + '，长度 ' + k.key.length + '，前缀 ' + k.key.slice(0, 6) + '…');
    return;
  }

  if (args.check) {
    const k = loadApiKey();
    if (!k) { console.log('[X] 没找到 DeepSeek API Key。请把 key 写进 课堂笔记/config.json：{"apiKey":"sk-..."}'); process.exit(2); }
    console.log('使用 Key 来源：' + k.from);
    try {
      const r = await callDeepSeek(k.key, [{ role: 'user', content: '回复两个字：可用' }], { max_tokens: 16 });
      console.log('[√] API 连通，返回：' + r.trim());
    } catch (e) { console.log('[X] API 调用失败：' + e.message); process.exit(3); }
    return;
  }

  if (args.buildPrompt) {
    const r = buildPromptFile(args.course);
    console.log('[√] 术语提示已重建：' + r.path);
    console.log('    收录 ' + r.terms + ' 个（手动 ' + r.manualCount + '，本课程笔记份数 ' + r.sameCourse + '，历史术语记录 ' + r.fromNotes + '），' + r.chars + ' 字符'
      + (r.skipped > 0 ? '，省略 ' + r.skipped + ' 个' : '')
      + (r.courseHint ? '，课程筛选：' + r.courseHint : '（未指定课程，按新旧排序）'));
    console.log('    内容预览：' + fs.readFileSync(r.path, 'utf8').slice(0, 200));
    return;
  }

  if (args.stats) {
    const ffmpeg0 = findFfmpeg();
    if (!ffmpeg0) { console.log('[X] 找不到 ffmpeg.exe'); process.exit(2); }
    const a = pickAudio(args.stats === true ? null : args.stats);
    const w = path.join(require('os').tmpdir(), 'stats_' + Date.now() + '.wav');
    console.log('音频：' + a);
    run(ffmpeg0, ['-hide_banner', '-loglevel', 'error', '-y', '-i', a, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', w], 'ffmpeg');
    const s = analyzeWav(w);
    try { fs.unlinkSync(w); } catch (e) { /* 忽略 */ }
    console.log('  时长        ' + s.durationSec.toFixed(0) + ' 秒（' + (s.durationSec / 60).toFixed(1) + ' 分钟）');
    console.log('  中位电平    ' + s.medianDb.toFixed(1) + ' dB' + (s.medianDb < -30 ? '   ← 偏弱（远场典型）' : ''));
    console.log('  语音电平    ' + s.speechLevelDb.toFixed(1) + ' dB');
    console.log('  噪声底      ' + s.noiseFloorDb.toFixed(1) + ' dB');
    console.log('  信噪比      ' + s.snrDb.toFixed(1) + ' dB' + (s.snrDb < 8 ? '   ← 偏低，转写易出错（建议坐前排/靠近讲者）' : (s.snrDb < 15 ? '   ← 一般' : '   ← 良好')));
    console.log('  静音占比    ' + (s.silenceRatio * 100).toFixed(0) + '%');
    console.log('  预计参数档  ' + decideProfiles(s, {}).map((p) => p.name).join(' → '));
    return;
  }

  /* ---- 批量模式：把 录音\ 里所有待处理音频逐个跑完 ---- */
  if (args.all && !args.audio && !args.file) {
    const list = listInbox();
    if (!list.length) { console.log('[!] 录音\\ 里没有待处理的音频（已处理\\ 里的不算）'); return; }
    console.log('· 待处理音频 ' + list.length + ' 个，按时间从旧到新依次处理：');
    list.forEach((q, i) => console.log('   ' + (i + 1) + '. ' + path.relative(ROOT, q)));
    if (args.course) console.log("（注意：批量模式下 --course 会被忽略；要指定课名请用子文件夹，或单独跑某一个文件）");
    if (args.date) console.log("（注意：批量模式下 --date 会被忽略）");
    const pass = [];
    if (args.model) pass.push('--model', args.model);
    if (args.lang && args.lang !== 'en') pass.push('--lang', args.lang);
    if (args.vad) pass.push('--vad');
    if (args.noVad) pass.push('--no-vad');
    if (args.force) pass.push('--force');
    if (args.quiet) pass.push('--quiet');
    if (args.only) pass.push('--only');
    if (args.noSync) pass.push('--no-sync');
    if (args.noAudioCopy) pass.push('--no-audio-copy');
    if (args.noArchive) pass.push('--no-archive');
    if (args.diarize) pass.push('--diarize');
    if (args.keepContext) pass.push('--keep-context');
    if (args.noNormalize) pass.push('--no-normalize');
    if (args.noChunk) pass.push('--no-chunk');
    if (args.chunkSec) pass.push('--chunk-sec', String(args.chunkSec));
    pass.push('--no-pick');   // 批量时只在最后开一次选卡页，别每个文件都弹一遍
    let ok = 0, bad = 0;
    list.forEach((q, i) => {
      console.log('\n=========== [' + (i + 1) + '/' + list.length + '] ' + path.basename(q) + ' ===========');
      const r = require('child_process').spawnSync(process.execPath, [__filename, '--audio', q].concat(pass), { cwd: ROOT, stdio: 'inherit' });
      if (r.status === 0) ok++;
      else { bad++; console.log('[!] 上面这个文件没跑成功（退出码 ' + r.status + '）；它仍留在 录音\\ 里，可以单独重跑。'); }
    });
    console.log('\n===== 批量结束：成功 ' + ok + ' 个' + (bad ? '，失败 ' + bad + ' 个' : '') + ' =====');
    if (bad) console.log('单独重跑某一个：一键出笔记.cmd --audio "文件名"');
    if (!args.noPick && ok > 0) openPicker();
    return;
  }

  let audioResult = null, audioSrc = null, llmText = null, withTs = false, diarSummary = '', srcBase = '', audioUsed = null, transcriptUsed = null;
  // 可靠的上课时间（文件名里的日期 / 用户 --date 明确指定）。文件修改时间不算——那是拷贝时刻。
  let lessonDate = null;
  // 原始转写稿（不带时间戳）——给课件「词重叠自动匹配」用
  let transcriptForMatch = '';
  /* SRT → 带 [mm:ss] 的稿：抽成一处，两条路共用
     ① 现转现用（--audio）② 笔记重跑时复用已有 .srt（--file）
     ⚠ 2026-09-29 踩到的坑：原来只有 ①，于是「笔记重跑」（生成笔记.cmd，不带 --audio）
     出来的笔记**没有 [mm:ss] 回听点**（实测 48 → 0），而且不报错 —— 静默降级。 */
  function useSrt(srtPath, tag) {
    if (!srtPath || !fs.existsSync(srtPath)) return false;
    try {
      const segs = parseSrt(fs.readFileSync(srtPath, 'utf8'));
      if (segs.length < 3) return false;
      const flt = dropHallucinated(segs, args.lang);
      printQa(flt.qa);
      /* 勘误表：磁盘上的 .srt 可能还没纠正（例如笔记重跑复用的是旧转写稿），这里再兜一层 */
      const errR = loadErrata();
      const errHits = [];
      flt.kept.forEach((s) => {
        const r = applyErrata(s.text, errR);
        if (r.hits.length) { s.text = r.text; errHits.push.apply(errHits, r.hits); }
      });
      if (errHits.length) {
        console.log('  · 勘误表：转写稿里改 ' + errHits.length + ' 处（' + summarizeErrata(errHits) + '）');
      }
      if (flt.dropped.length) {
        console.log('  · 已剔除 ' + flt.dropped.length + '/' + segs.length + ' 段铁证幻觉（重复句 / 英文稿里的中文），不送入模型');
      }
      llmText = buildTimestamped(flt.kept);
      withTs = true;
      console.log('· ' + tag + '：' + segs.length + ' 段 → ' + llmText.length + ' 字符（笔记会带 [mm:ss] 回听点）');
      return true;
    } catch (e) { console.log('（时间戳解析失败，改用纯文本：' + e.message + '）'); return false; }
  }
  if (args.audio) {
    console.log('== 本地转写（whisper.cpp）==');
    const audio = pickAudio(args.audio === true ? null : args.audio);
    console.log('音频：' + audio);
    const hint = args.course || path.basename(audio).replace(/\.[^.]+$/, '');
    srcBase = path.basename(audio).replace(/\.[^.]+$/, '');
    const pr = buildPromptFile(hint);
    console.log('· 术语提示已刷新：' + pr.terms + ' 个 / ' + pr.chars + ' 字符'
      + '（手动 ' + pr.manualCount + '，本课程笔记 ' + pr.sameCourse + ' 份，其它课程垫后；因上限省略 ' + pr.skipped + ' 个）');
    audioResult = transcribeAudio(audio, args.lang, { model: args.model, vad: args.vad, keepContext: args.keepContext, noNormalize: args.noNormalize, noChunk: args.noChunk, chunkSec: args.chunkSec, course: hint });

    // 时间戳稿：让笔记里的要点/句子带上 [mm:ss]，可点击回听
    useSrt(audioResult.srtPath, '已整理带时间戳转写稿');

    audioUsed = audio; // 音频的拷贝与归档放到「知道课程名之后」再做
    const when0 = args.date
      ? (() => {
          const raw = String(args.date).trim();
          const hasTime0 = /[:.]\d{2}/.test(raw); // 有没有给具体时刻
          // 只给日期时锚到中午：new Date("2026-09-25") 按 UTC 解析，夏令时下会被挪成前一天凌晨
          const d = new Date(raw.replace(" ", "T") + (hasTime0 ? "" : "T12:00"));
          return isNaN(d) ? null : { date: d, from: "--date 手动指定", hasTime: hasTime0 };
        })()
      : parseWhen(audio);
    if (when0) {
      console.log("· 录音时间推断：" + (when0.hasTime ? when0.date.toLocaleString()
        : (when0.date.getFullYear() + '-' + String(when0.date.getMonth() + 1).padStart(2, '0') + '-' + String(when0.date.getDate()).padStart(2, '0') + "（只给到日期，无具体时刻）"))
        + "（来源：" + when0.from + "）");
      if (/文件名|--date/.test(when0.from)) lessonDate = when0.date; // 只有这两类来源才当作「真的上课时间」
      TT_HINT = when0.date.toLocaleString() + "（来源：" + when0.from + "）";
      const sl = matchSlot(when0);
      if (sl) {
        TT_SLOT = sl;
        console.log("· 课表匹配：" + sl.label + (sl.week ? "（第 " + sl.week + " 周）" : "") + (sl.others ? "；同时段还有 " + sl.others + " 门，改由 AI 按内容判定" : "（唯一）"));
      } else if (loadTimetable().modules.length) {
        console.log("· 课表匹配：时间对不上任何一节，改由 AI 按内容从课程表里认课");
      }
    }

    // 发言人分离（默认关闭：--diarize 或 config.json 里 "diarize": true 开启；长录音需数分钟）
    const wantDiar = args.diarize || readConfig().diarize === true;
    if (wantDiar && diarizeAvailable() && audioResult.srtSegs && audioResult.srtSegs.length) {
      try {
        console.log("· 发言人分离中（sherpa-onnx，CPU）…");
        const normWav = path.join(require("os").tmpdir(), "diar_norm_" + Date.now() + ".wav");
        run(findFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", audio, "-af", "highpass=f=120,afftdn=nr=15:nf=-30,dynaudnorm=f=200:g=25:p=0.95,volume=15dB,loudnorm=I=-14:TP=-1.0:LRA=9", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", normWav], "ffmpeg");
        const diar = runDiarize(normWav);
        try { fs.unlinkSync(normWav); } catch (e) {}
        const lab = labelBySpeaker(audioResult.srtSegs, diar);
        const speakPath = path.join(IN_DIR, path.basename(audioResult.txtPath).replace(/\.txt$/, "") + ".讲者.txt");
        const diarOk = lab.coveragePct >= 60;
        // 覆盖率不够时**不报数字**：实测 6~8 人的导师小组被分成 107 位，报「107 位」是把噪声当事实。
        const speakHead = diarOk ? ''
          : '【警告】发言人分离覆盖率仅 ' + lab.coveragePct + '%（低于 60% 阈值），下面的「主讲/其他人」标签不可靠：\n'
            + '        实测同一个人会被拆成几十位、主讲本人也会被标成「其他人」。**仅作时间轴参考，请勿据此判断谁在说话。**\n\n';
        fs.writeFileSync(speakPath, speakHead + lab.text, "utf8");
        diarSummary = diarOk
          ? (lab.speakers + " 位（主讲 " + lab.primaryPct + "%，分离覆盖 " + lab.coveragePct + "%）")
          : ("分离不可靠（仅覆盖 " + lab.coveragePct + "%，请勿据此判断谁在说话）");
        if (!diarOk) console.log("  ⚠ 分离覆盖率仅 " + lab.coveragePct + "%（低于 60% 阈值）：本次分出 " + lab.speakers + " 个聚类，无参考价值 → 笔记里只标「不可靠」，不报数字");
        console.log("· 发言人：" + diarSummary + " → " + speakPath);
      } catch (e) { console.log("（发言人分离失败，不影响其余流程：" + e.message + "）"); }
    }
    if (args.only) { console.log('（--only：只转写，不生成笔记）'); return; }
    console.log('');
  }

  let data, meta;
  if (args.mock) {
    console.log('== 离线模式（--mock）：不联网，用内置样例测试渲染链路 ==');
    data = normalize(MOCK_DATA);
    meta = { course: data.course, sourceName: '内置样例', chars: 0, model: 'mock' };
  } else {
    const keyInfo = loadApiKey();
    if (!keyInfo) {
      console.log('[X] 没找到 DeepSeek API Key。两种办法：');
      console.log('    1) 在 课堂笔记 文件夹里建 config.json，内容：{"apiKey":"sk-你的key"}');
      console.log('    2) 或设置环境变量 DEEPSEEK_API_KEY');
      process.exit(2);
    }
    console.log('Key 来源：' + keyInfo.from);
    let file, text;
    if (audioResult) {
      file = audioResult.txtPath;
      text = audioResult.text;
    } else {
      file = pickTranscript(args.file);
      console.log('读取转写稿：' + file);
      /* 记在函数作用域上：下面「转写稿归入 录音稿\<课程>\<日期>\」那一段在 else 块之外，
         原来用 typeof file 判断，而 file 是这个块里的 let → 永远 undefined，
         于是**只生成笔记（生成笔记.cmd / node make-notes.js）这条路从来不归档转写稿**，
         笔记看起来正常，体检才报「四处一致 缺：录音稿、音频、已处理」。2026-10-14 修。 */
      transcriptUsed = file;
      /* 上课日期：转写稿是这个管线自己产出的（录音稿\<课程>\<日期>\<课程>_<日期>.txt），
         文件名里就带上课日期 → 笔记重跑才会落回**同一个日期文件夹、同名覆盖**。
         不看文件修改时间（那是拷贝时刻）。拿不到就退回生成日期。 */
      if (!lessonDate) {
        const d0 = parseWhen(file);
        if (d0 && /文件名/.test(d0.from)) {
          lessonDate = d0.date;
          console.log('· 上课日期（取自转写稿文件名）：' + d0.date.getFullYear() + '-'
            + String(d0.date.getMonth() + 1).padStart(2, '0') + '-' + String(d0.date.getDate()).padStart(2, '0'));
        }
      }
      text = fs.readFileSync(file, 'utf8').replace(/\r/g, '').trim();
      /* 勘误表：纯文本这条路口径也要一致（否则「有 SRT」与「没 SRT」两条路出来的词不一样） */
      const erTxt = applyErrata(text);
      if (erTxt.hits.length) {
        console.log('  · 勘误表：转写稿里改 ' + erTxt.hits.length + ' 处（' + summarizeErrata(erTxt.hits) + '）');
        text = erTxt.text;
      }
      /* 复用旁边的 .srt：不然重跑出来的笔记会丢掉 [mm:ss] 回听点（静默降级，2026-09-29 实测） */
      const srt0 = file.replace(/\.(txt|md)$/i, '.srt');
      if (!useSrt(srt0, '复用已有 SRT（笔记重跑）')) {
        console.log('  （没找到 ' + path.basename(srt0) + '：本次笔记不会带 [mm:ss] 回听点；'
          + '想要的话双击 一键出笔记.cmd 重新转写一遍）');
      }
    }
    srcBase = path.basename(file).replace(/\.[^.]+$/, '');
    transcriptForMatch = text;   // 原始转写稿（不带时间戳），给课件匹配用
    if (text.length < 200 && !args.force) {
      console.log('[!] 转写稿只有 ' + text.length + ' 字符 —— 音频可能过短、几乎全是静音，或选错了文件。');
      console.log('    已跳过笔记生成（转写稿本身已保留：' + file + '）');
      console.log('    确实想生成的话，加参数 --force 再跑一次。');
      process.exit(4);
    }
    console.log('调用 DeepSeek 生成笔记…（长稿需要 1-3 分钟，请勿关闭窗口）');
    data = await runAnalysis(keyInfo.key, args.course, llmText || text, withTs);
    if (!data.course && args.course) data.course = args.course;
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const labelDate = lessonDate || now; // 有可靠上课时间就用它，否则退回生成日期
    meta = {
      course: data.course,
      sourceName: path.basename(file),
      dateLabel: labelDate.getFullYear() + '-' + pad2(labelDate.getMonth() + 1) + '-' + pad2(labelDate.getDate()),
      dateFrom: lessonDate ? '上课日期' : '生成日期',
      chars: text.length,
      model: MODEL,
      profile: audioResult ? audioResult.profile : '转写稿直读',
      whisperModel: audioResult ? (audioResult.whisperModel || '') : '',
      quality: audioResult ? audioResult.quality : '',
      audioSrc: audioSrc || '',
      diar: diarSummary || '',
      durationLabel: audioResult && audioResult.durationSec
        ? (audioResult.durationSec / 60).toFixed(1) + ' 分钟'
        : '',
    };
  }

  /* ---- 自动定名 + 音频归档 ---- */
  const _now = lessonDate || new Date(); // 文件名带日期 / --date 指定时，文件名与「上课日期」用上课那天
  const _p2 = (x) => String(x).padStart(2, "0");
  const _day = _now.getFullYear() + "-" + _p2(_now.getMonth() + 1) + "-" + _p2(_now.getDate());
  const rc = resolveCourseName({
    argsCourse: args.course, audioPath: audioUsed,
    transcriptName: audioUsed ? "" : srcBase,
    // 「课表按时段匹配」只有在时间是**可靠来源**时才算数：文件名自带的日期，或用户 --date 明确指定。
    // （曾经只认文件名，导致 --date 与文档说的「用于自动对课程表」不符；文件修改时间是拷贝时刻，永远不算。）
    timetableName: (TT_SLOT && /文件名|--date/.test(TT_SLOT.from) && TT_SLOT.others === 0) ? TT_SLOT.label : "",
    aiCourse: data.course,
  });
  srcBase = rc.name;
  const _cardDir = safeDir(rc.name);
  const _fileBase = safeName(rc.name) + "_" + _day;
  const LAY = layoutOf(_cardDir, _day);   // 这节课的四处目录（笔记/录音稿/音频/已处理）
  data.course = /命令行|课表|课程\.json|文件夹名/.test(rc.from) ? rc.name : (data.course || rc.name);
  if (audioUsed || args.course) console.log("· 课程名：" + rc.name + "　（来源：" + rc.from + "）");
  if (audioUsed && !args.course) {
    const map = loadCourseMap();
    const key = path.basename(audioUsed);
    if (map[key] !== rc.name) {
      map[key] = rc.name;
      saveCourseMap(map);
      console.log("  已记住这个名字，下次同文件名自动沿用（想改就编辑 课堂笔记\\课程.json）");
    }
  }
  // 转写稿：移进 录音稿/<课程>/<上课日期>/ 并改名成 <课程>_<日期>.txt（.srt 与讲者稿一起）
  try {
    const tsrc = audioResult ? audioResult.txtPath : transcriptUsed;
    if (tsrc && fs.existsSync(tsrc)) {
      const rel0 = path.relative(IN_DIR, path.resolve(tsrc));
      if (rel0 && rel0.indexOf("..") !== 0) {
        const dstDir = LAY.transcript;
        fs.mkdirSync(dstDir, { recursive: true });
        const pairs = [[tsrc, "txt"], [tsrc.replace(/\.(txt|md)$/i, ".srt"), "srt"], [tsrc.replace(/\.(txt|md)$/i, ".讲者.txt"), "讲者.txt"]];
        pairs.forEach((pair) => {
          const src = pair[0], ext = pair[1];
          if (!src || !fs.existsSync(src)) return;
          const dst = path.join(dstDir, _fileBase + "." + ext);
          if (path.resolve(src) !== path.resolve(dst)) fs.renameSync(src, dst);
        });
        console.log("  转写稿已归入：录音稿/" + _cardDir + "/" + _day + "/" + _fileBase + ".txt");
      }
    }
  } catch (e) { console.log("  （转写稿归档失败，不影响笔记：" + e.message + "）"); }

  /* 笔记重跑（手里没有音频）时，复用 音频\<课程>\<日期>\ 里已有的副本——
     否则重跑出来的笔记虽然有 [mm:ss]，点下去却没有音频可播。
     （先看这节课的日期文件夹；没有就退回课程根目录，兼容历史上平铺的副本。） */
  if (!audioSrc && !args.noAudioCopy) {
    try {
      const cands = [LAY.audio, path.join(ROOT, '音频', _cardDir)];
      for (const AUD0 of cands) {
        if (!fs.existsSync(AUD0)) continue;
        const cand = fs.readdirSync(AUD0).filter((f) => AUDIO_EXT.test(f));
        if (!cand.length) continue;
        const d8 = _day.replace(/\D/g, '');
        let pick0 = cand.find((f) => f.replace(/\D/g, '').indexOf(d8) >= 0) || cand[0];
        audioSrc = relHref(LAY.note, path.join(AUD0, pick0));
        console.log('· 回听副本复用（笔记重跑）：音频/' + _cardDir + '/' + path.basename(AUD0) + '/' + pick0
          + '（' + (fs.statSync(path.join(AUD0, pick0)).size / 1048576).toFixed(1) + ' MB）');
        break;
      }
    } catch (e) { /* 没有就算了，笔记照样出 */ }
  }

  if (audioUsed && !args.noAudioCopy) {    try {
      const st = fs.statSync(audioUsed);
      const ext0 = (path.extname(audioUsed) || ".m4a").toLowerCase();
      const lossless = [".wav", ".flac", ".aiff", ".aif"].indexOf(ext0) >= 0;
      const AUD = LAY.audio;
      fs.mkdirSync(AUD, { recursive: true });
      const base0 = _fileBase + (lossless ? ".m4a" : ext0);
      const target = path.join(AUD, base0);
      if (lossless) {
        if (!fs.existsSync(target)) {
          console.log("· 音频是 " + ext0 + "（" + Math.round(st.size / 1048576) + " MB），转成压缩 m4a 供回听…");
          run(findFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", audioUsed, "-vn", "-c:a", "aac", "-b:a", "96k", "-ac", "1", target], "ffmpeg");
        }
      } else if (st.size <= 300 * 1024 * 1024) {
        if (!fs.existsSync(target)) fs.copyFileSync(audioUsed, target);
        console.log("  音频已就位（笔记里可点时间点回听）：音频\\" + _cardDir + "\\" + _day + "\\" + base0 + "（" + Math.round(st.size / 1048576) + " MB）");
      } else {
        console.log("  音频超过 300 MB，未内嵌播放器（笔记仍带时间点）");
      }
      if (fs.existsSync(target)) {
        audioSrc = relHref(LAY.note, target);
        console.log("  回听副本 → 音频/" + _cardDir + "/" + _day + "/" + path.basename(target) + "（" + (fs.statSync(target).size / 1048576).toFixed(1) + " MB）");
      }
    } catch (e) { console.log("  （音频拷贝失败，笔记仍带时间点：" + e.message + "）"); }
  }
  if (audioUsed && !args.noArchive) {
    try {
      const rel = path.relative(AUDIO_DIR, path.resolve(audioUsed));
      const inInbox = !!rel && !rel.startsWith('..') && rel.split(path.sep).indexOf('已处理') < 0;
      if (inInbox) {
        const ARCH = LAY.archive;
        fs.mkdirSync(ARCH, { recursive: true });
        const dest = path.join(ARCH, _fileBase + (path.extname(audioUsed) || ".m4a"));
        if (!fs.existsSync(dest)) fs.renameSync(audioUsed, dest);
        else { try { fs.unlinkSync(audioUsed); } catch (e) { /* 已存在同名归档 */ } }
        console.log("  收件箱已清空：录音\\已处理\\" + _cardDir + "\\" + _day + "\\" + path.basename(dest));
      }
    } catch (e) { console.log("  （归档失败，不影响笔记：" + e.message + "）"); }
  }
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = stamp.getFullYear() + '-' + pad(stamp.getMonth() + 1) + '-' + pad(stamp.getDate());
  // 文件名用"课程/来源 + 日期"，保证重复生成是覆盖同一个文件（不会越堆越多）；
  // AI 生成的中文标题写在文档内部（<title> 与 H1）
  const stable = srcBase || data.course || 'course';
  const safe = String(stable).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  const noteDir = LAY.note;
  fs.mkdirSync(noteDir, { recursive: true });
  const htmlPath = path.join(noteDir, _fileBase + ".html");
  const mdPath = path.join(noteDir, _fileBase + ".md");
  const jsonPath = path.join(noteDir, _fileBase + ".json");

  // meta 是在转写阶段建的，而音频副本/转码在定名之后才做 —— 渲染前必须刷新 audioSrc，
  // 否则笔记里没有 <audio> 播放器，时间点小圆片点了也不会跳（曾真实发生过）
  // 同门课其它讲次：扫描 笔记/<课程>/ 下**所有日期文件夹**里的其它笔记，注入左栏
  let siblingHtml = "";
  try {
    const mine = path.resolve(htmlPath);
    const items = listNoteHtmls(LAY.courseRoot).filter((q) => path.resolve(q) !== mine).map((q) => {
      const f = path.basename(q);
      let title = f.replace(/\.html$/, '');
      try { const s = fs.readFileSync(q, 'utf8'); const m0 = s.match(/<title>([^<]{2,90})<\/title>/); if (m0) title = m0[1].trim(); } catch (e) {}
      const dm = q.match(/(\d{4}-\d{2}-\d{2})/);
      return { href: relHref(noteDir, q), title: title, d: dm ? dm[1] : '' };
    }).sort((x, y) => (x.d < y.d ? 1 : -1));
    if (items.length) {
      siblingHtml = '<div class="sibs-hd">同门课其它讲次</div><ol class="sibs">'
        + items.map((x) => '<li><a href="' + x.href + '"><span class="d">' + esc(x.d) + '</span><span>' + esc(x.title) + '</span></a></li>').join('')
        + '</ol>';
      console.log("  同门课其它讲次：" + items.length + " 讲已注入左栏");
    }
  } catch (e) { /* 没有同门课笔记就留空 */ }

  /* ---- 录音 × 课件互校（单独一次调用；失败也不影响笔记）---- */
  if (!args.noHandout && !args.mock) {
    try {
      const cwDir = args.slides || path.join('课件', rc.name);
      const cw = loadCourseware(cwDir, args.deck, _day);
      if (!cw) {
        console.log('· 课件：没找到「' + cwDir + '」→ 跳过互校（把该课程幻灯片放进 课件\\<课程名>\\ 再重跑即可）');
      } else {
        /* ⚠ 课件是按进度猜的（这节课没有新课件 → 沿用最近一次那份）时必须明说：
           老师若已发新课件而还没整理进来，这次就是拿旧课件对的 —— 而核对是「以课件为准」的。 */
        if (cw.deckSrc === 'carry') {
          console.log('  ⚠ 这节课没有新课件 → ' + cw.deckWhy
            + '（老师若已发新课件：先双击 整理课件.cmd 再重跑本笔记；要手动指定就加 --deck 关键词）');
        }
        let range = null, why = '', basis = '';
        const mp = String(args.pages || '').match(/^(\d+)\s*[-–~]\s*(\d+)$/);
        if (mp) { range = { from: +mp[1], to: +mp[2], lectures: [] }; why = '--pages 手动指定'; basis = 'manual'; }
        /* 单节课件（整份＝一讲）不用再让模型判讲：只有一讲，判它没有意义，还白花一次调用 */
        if (!range && cw.lectures.length === 1) {
          const only = cw.lectures[0];
          range = { from: only.startPage, to: only.endPage, lectures: [only.no] };
          why = only.whole ? '课件只有一讲（没有扉页，整份课件）' : '课件只有一讲';
          basis = 'single';
        }
        if (!range) {
          // 先让模型读目录判讲（词重叠判不准：一节课会同时命中十几讲）
          try {
            const k0 = loadApiKey();
            if (k0 && cw.lectures.length) {
              const pick = await pickLecturesByModel(k0.key, rc.name, noteDigest(data), cw);
              const sel = cw.lectures.filter((l) => pick.nos.indexOf(l.no) >= 0);
              if (sel.length) {
                range = {
                  from: Math.min.apply(null, sel.map((l) => l.startPage)),
                  to: Math.max.apply(null, sel.map((l) => l.endPage)),
                  lectures: pick.nos,
                };
                why = '按笔记主题判讲（' + (pick.confidence || '未标置信度') + (pick.reason ? '：' + pick.reason : '') + '）';
                basis = 'model';
              }
            }
          } catch (e) { console.log('  （模型判讲失败，退回词重叠兜底：' + (e && e.message ? e.message : e) + '）'); }
        }
        if (!range) {
          const g = guessRange(cw, transcriptForMatch || '');
          if (g) { range = g; basis = 'overlap'; why = '按词重叠兜底（**判讲可能不准，建议用 --pages 手动指定**；前三名 ' + (g.top || []).map((x) => 'KRR-' + x.lec.no + ' ' + x.score.toFixed(2)).join(' / ') + '）'; }
        }
        if (!range) {
          const hint = cw.lectures.length
            ? '课件里有 ' + cw.lectures.length + ' 讲，但没定位到本讲'
            : '课件里一讲都没有（先跑 node read-slides.js "' + cwDir + '" --deck ' + cw.deck + ' 重建课程地图）';
          console.log('· 课件：没定位到对应讲（' + hint + '；可用 --pages 3-30 手动指定）');
        } else {
          const label = 'p' + range.from + '–p' + range.to + (range.lectures && range.lectures.length ? '，第 ' + range.lectures.join('/') + ' 讲' : '');
          console.log('· 课件：' + cw.deck + '　' + label + '（' + why + '）');
          const st = slideText(cw, range.from, range.to);
          console.log('  送去核对的课件原文 ' + st.length + ' 字符，开始核对…');
          const k2 = loadApiKey();
          if (!k2) throw new Error('没找到 API Key');
          /* withQa=true：把「复习问答」与「思维导图」也喂给核对模型 —— 否则它看不见那两处，
             同一处错误就只会改正文，卡片与导图留着错的（2026-10-06 实测踩过：
             `公平原则` 正文改成 `准确性原则`，问答卡与思维导图仍写着错的那句）。 */
          const ho = await runHandoutCheck(k2.key, rc.name, noteDigest(data, 16000, true), st, cw.deck, label);
          if (ho.failed) {
            console.log('  ⚠ 课件核对这次没成：模型返回的不是合法 JSON（' + ho.failed + '）。'
              + '笔记照常出、但这次没有「课件核对」视图 —— 重跑一次（生成笔记.cmd）就会重试。');
          } else {
            /* 判讲依据必须落盘：否则笔记里看不出这次核对是走「AI 按主题判讲」（可靠）
               还是「词重叠兜底」（实测曾把 18 讲里的 14 讲全选中、送进 14 万字符）。
               以前只有日志里有、笔记里没有 —— 过几天就无从判断这次核对可不可信。 */
            data.handout = { deck: cw.deck, range: label, rows: ho.rows, extra: ho.extra, basis: basis, how: why,
              deckSrc: cw.deckSrc, deckWhy: cw.deckWhy };
            const fixedN = ho.rows.filter((r) => r.verdict === 'fixed').length;
            console.log('  ✓ 核对完成：' + ho.rows.length + ' 项（其中 ' + fixedN + ' 项按课件纠正）'
              + (ho.extra.length ? '，另有 ' + ho.extra.length + ' 条课件要点是笔记没覆盖的' : ''));
            /* 把核对结论**回改**进正文（fail-closed：唯一匹配才改；不静默，逐条打印） */
            if (!args.noHandoutPatch) {
              const ap = applyHandoutPatches(data, ho.rows);
              ap.applied.forEach((x) => console.log('  · 已按课件回改：' + x.where + '　「' + x.find.slice(0, 42) + '」→「' + x.replace.slice(0, 42) + '」'));
              ap.skipped.forEach((x) => console.log('  · 未回改（' + x.reason + '）：' + x.item));
              (ap.leftovers || []).forEach((x) => console.log('  ⚠ 仍可疑：' + x.item + '　「' + x.value + '」还在 ' + x.where.join('、') + '（课件里没有这个数）'));
              /* ---- 第二轮：残留复查（模型第一轮不总会枚举穷尽；实测术语 note 与思维导图会漏）----
                 只在第一轮**确实发现了错误**时才跑：笔记本来就干净 → 零额外开销。
                 这一步只问一件窄事（这几处短视图里还有没有残留），所以命中率高得多。 */
              if (fixedN > 0) {
                try {
                  const rres = await runHandoutResiduals(k2.key, rc.name, residualDigest(data), st, cw.deck, ap.applied);
                  if (rres.rows.length) {
                    const ap2 = applyHandoutPatches(data, rres.rows);
                    ap.applied = ap.applied.concat(ap2.applied);
                    ap.skipped = ap.skipped.concat(ap2.skipped);
                    const seenLo = new Set((ap.leftovers || []).map((x) => x.value));
                    (ap2.leftovers || []).forEach((x) => {
                      if (!seenLo.has(x.value)) { ap.leftovers.push(x); seenLo.add(x.value); }
                    });
                    ap2.applied.forEach((x) => console.log('  · 残留复查又改：' + x.where
                      + '　「' + x.find.slice(0, 42) + '」→「' + x.replace.slice(0, 42) + '」'));
                    ap2.skipped.forEach((x) => console.log('  · 残留复查未改（' + x.reason + '）：' + x.item));
                    if (!ap2.applied.length && !ap2.skipped.length) console.log('  · 残留复查：报了 ' + rres.rows.length + ' 条但对不上原文，未改');
                  } else {
                    console.log('  · 残留复查：术语表/问答/思维导图/要点里没有残留');
                  }
                } catch (e) {
                  console.log('  （残留复查这一步失败，不影响已改的部分：' + (e && e.message ? e.message : e) + '）');
                }
              }
              data.handout.applied = ap.applied.map((x) => ({ item: x.item, where: x.where }));
              data.handout.skipped = ap.skipped;
              data.handout.leftovers = ap.leftovers || [];
              console.log('  ✓ 回改结果：' + ap.applied.length + ' 处已改、' + ap.skipped.length + ' 处需人工'
                + ((ap.leftovers || []).length ? '、' + ap.leftovers.length + ' 处仍可疑（见上）' : '')
                + '（原文保留在核对表「录音/笔记」那一列）'
                + (ap.applied.length ? '' : '；想只出报告不回改：加 --no-handout-patch'));
            }
          }
        }
      }
    } catch (e) {
      console.log('  （课件互校失败，不影响笔记：' + (e && e.message ? e.message : e) + '）');
    }
  }

  const metaForRender = Object.assign({}, meta, { audioSrc: audioSrc || (meta && meta.audioSrc) || '', siblings: siblingHtml });
  fs.writeFileSync(htmlPath, renderHtml(data, metaForRender), 'utf8');
  fs.writeFileSync(mdPath, toMarkdown(data), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

  console.log('');
  console.log('[√] 生成完成：');
  console.log('    HTML（双击打开）：' + htmlPath);
  console.log('    Markdown（备份）  ：' + mdPath);
  console.log('    JSON（可再加工）  ：' + jsonPath);
  if (LOG_PATH) console.log('    完整日志：' + LOG_PATH);
  console.log('    要点 ' + data.keyPoints.length + ' 条 / 中英对照 ' + data.bilingual.length + ' 组 / 术语 ' + data.terms.length + ' 个 / 问答 ' + data.qa.length + ' 组');

  // 自动同步到 FSRS 学习台（--no-sync 可跳过）
  if (!args.noSync) {
    console.log('');
    console.log('== 同步复习卡到学习台 ==');
    try {
      const sync = require('./sync-fsrs.js');
      sync.run({});
    } catch (e) {
      console.log('（同步失败，不影响笔记：' + (e && e.message ? e.message : e) + '）');
      console.log('  可稍后单独运行：node sync-fsrs.js');
    }
  }
  // 同步完之后请用户挑卡（--no-pick 跳过；--mock 是离线渲染自测，不该弹页面；批量模式在父进程里只开一次）
  if (!args.noPick && !args.mock) openPicker();
  if (!args.mock) {
    const { spawn } = require('child_process');
    // 打开时带版本号：浏览器会把 file:// 的同一路径当同一资源，带上 ?v= 才会加载新渲染（曾因此看到旧版页面）
      const openUrl = 'file:///' + htmlPath.replace(/\\/g, '/') + '?v=' + Date.now();
      spawn('cmd', ['/c', 'start', '', openUrl], { detached: true, stdio: 'ignore' }).unref();
      console.log('    已在新标签打开（带版本号，绕过缓存）');
  }
}

// 作为模块被 require 时（例如自测脚本），只导出工具函数，不执行主流程
module.exports = {
  WHISPER_ROOT, IN_DIR, OUT_DIR, AUDIO_DIR,
  findFfmpeg, findWhisperCli, findModels, findVadModel,
  buildPromptFile, pickAudio, listInbox, run, wavDuration, buildMessages,
  analyzeWav, scoreText, decideProfiles, PROFILES,
  srtTime, srtOf, normLine, dedupeBursts, hallucSpans, chunkAudio, CHUNK_SEC_DEFAULT, CHUNK_MIN_SEC, CHUNK_MAX_ATTEMPTS, BURST_WINDOW_SEC,
  inline, texInline, texBody, parseSrt, buildTimestamped, qaSegments, qaVerdict, printQa, dropHallucinated,
  loadErrata, applyErrata, applyErrataToFiles, summarizeErrata, ERRATA_PATH,
  toMarkdown, kpText, renderHtml,
  loadCourseware, slideText, guessRange, pickLecturesByModel, noteDigest, loadApiKey,
  handoutMessages, runHandoutCheck, applyHandoutPatches, patchTargets,
  residualDigest, residualMessages, runHandoutResiduals,
  layoutOf, relHref, listNoteHtmls, listDecks, deckBaseOf, deckDirOf, deckPages,
  callDeepSeek, listDecks, pickDeck,
  resolveCourseName, plausibleCourse, safeName, loadCourseMap, saveCourseMap, COURSE_MAP,
  existingCourseDir,
  loadTimetable, moduleLabel, slotLabel, semOfDate, matchesTimetable, inTeaching, timetableBlock, parseWhen, matchSlot, weekNoOf, weeksMatch, TIMETABLE,
  normalizeCnTime, cnNumToInt,
};

if (require.main === module) {
  main().catch((e) => {
    console.log('[X] 出错了：' + (e && e.message ? e.message : e));
  if (LOG_PATH) console.log('    完整日志：' + LOG_PATH);
  console.log('');
  console.log('补救办法：转写稿已保存在 录音稿\\ 里，直接双击 生成笔记.cmd 重跑「笔记生成」这一步即可（不必重新转写）。');
    process.exit(1);
  });
}





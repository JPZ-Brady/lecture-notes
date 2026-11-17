/*
 * _verify-launchers.js —— 启动器体检：.cmd 必须纯 ASCII + CRLF，且引用的脚本真实存在
 *
 * 2026-09-29 改：不再写死文件名，改成**自动扫描**本目录下所有 .cmd——
 * 否则新增一个启动器就会悄悄落在体检之外（使用说明.html 就这样静默过期过一次）。
 * 用法：node _verify-launchers.js
 * 退出码：0 = 全过；1 = 有不合格
 */
'use strict';
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter((f) => /\.cmd$/i.test(f) && !/\.bak/i.test(f))
  .filter((f) => fs.statSync(path.join(__dirname, f)).isFile())
  .sort();
if (!files.length) { console.log('[X] 没找到任何 .cmd 启动器'); process.exit(1); }

let bad = 0;
files.forEach((f) => {
  const b = fs.readFileSync(path.join(__dirname, f));
  const s = b.toString('latin1');
  const nonAscii = [...b].filter((x) => x > 126).length;
  const lines = (s.match(/\r\n/g) || []).length;
  const refs = (s.match(/"%~dp0([^"]+)"/g) || []).map((x) => x.slice(6, -1));
  const exists = refs.map((r) => r + (fs.existsSync(path.join(__dirname, r)) ? ' ✓' : ' ✗缺失'));
  const ok = nonAscii === 0 && lines > 0 && refs.length > 0 && !exists.some((e) => e.includes('✗'));
  if (!ok) bad++;
  console.log((ok ? '[√] ' : '[X] ') + f.padEnd(18) + ' 非ASCII字节=' + nonAscii + '  CRLF行=' + lines + '  引用→ ' + exists.join('  '));
});
console.log(bad ? ('\n有 ' + bad + ' / ' + files.length + ' 个启动器不合格') : ('\n' + files.length + ' 个启动器全部合格'));
process.exit(bad ? 1 : 0);

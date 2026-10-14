/**
 * Mindstrike 浏览器端到端冒烟测试 + 新界面截图(可选依赖)
 *
 * 需要: 本机 Chrome(或 CHROME 环境变量指向可执行文件) + puppeteer-core
 *   npm_config_cache=/tmp/ms-npm-cache npm i -D puppeteer-core   # 项目内安装
 *   或: NODE_PATH=<含 puppeteer-core 的 node_modules 路径> node test/e2e.test.js
 *
 * 覆盖: 主菜单 → 建房/加入 → 大厅(双方占座/改键/就绪) → 双人联机 BO3
 *      (脚本化出招: 蓄力→蓄力揭示→大攻击K.O.→对方扳回→决胜局→结算)
 *      → 头顶对话框揭示 / 小人动作 / 结算面板 → 再来一局 → AI 练习模式冒烟
 *      并在 preview/ 输出截图。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch (e) {
  console.error('缺少 puppeteer-core, 跳过浏览器冒烟测试(不影响其他测试)。');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'preview');
const ERRORS = [];
let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

async function runOnce(attempt) {
  const exe = chromePath();
  const port = 8800 + Math.floor(Math.random() * 300);
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = 'http://127.0.0.1:' + port;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('服务器启动超时')), 8000);
    (function poll() {
      fetch(base + '/').then(r => { if (r.ok) { clearTimeout(t); res(); } else setTimeout(poll, 150); })
        .catch(() => setTimeout(poll, 150));
    })();
  });
  console.log('E2E 第 ' + attempt + ' 次尝试 · ' + base);

  const browser = await puppeteer.launch({
    executablePath: exe, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio', '--window-size=1280,800']
  });
  let closed = false;
  const kill = async () => {
    if (closed) return; closed = true;
    try { await Promise.race([browser.close(), wait(2500)]); } catch (e) { }
    server.kill();
  };

  const page = async (name) => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    p.on('pageerror', e => ERRORS.push('[' + name + '] pageerror: ' + e.message));
    p.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text() || '';
      if (/Failed to load resource|Autoplay|The play\(\) request/i.test(t)) return; // 素材探测/自动播放噪音
      ERRORS.push('[' + name + '] console: ' + t.slice(0, 300));
    });
    await p.goto(base, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(`!document.getElementById('viewMenu').classList.contains('hide')`, { timeout: 10000 });
    await wait(300);
    return p;
  };
  const shot = async (p, file) => { if (p) { await p.screenshot({ path: path.join(PREVIEW, file) }); console.log('    📸 ' + file); } };
  const click = async (p, sel) => {
    for (let k = 0; k < 3; k++) {
      try {
        const el = await p.$(sel);
        if (!el) throw new Error('找不到 ' + sel);
        await el.evaluate(b => b.click());
        return;
      } catch (e) {
        if (k === 2) throw e;
        await wait(400);
      }
    }
  };
  const waitFor = async (p, expr, what, ms) => {
    try { await p.waitForFunction(expr, { timeout: ms || 20000, polling: 100 }); }
    catch (e) { throw new Error('等待超时: ' + what + ' —— ' + expr); }
  };
  const pick = async (p, i) => {
    await p.evaluate((i) => {
      const b = document.querySelectorAll('#cards .act')[i];
      if (b && !b.disabled) b.click();
    }, i);
  };
  const inputStart = (p) => waitFor(p, `!document.getElementById('timerWrap').classList.contains('hide')`, '出招窗口开始');
  const reveal = (p) => waitFor(p, `document.getElementById('line').classList.contains('show')`, '结算揭示');
  const waitLineHide = (p) => waitFor(p, `!document.getElementById('line').classList.contains('show')`, '揭示行隐藏');
  const bubOf = async (p, s) => p.evaluate((s) => {
    const b = document.querySelectorAll('.bub.show')[s];
    return b ? (b.querySelector('.bt').textContent || '') : '';
  }, s);

  /* ---------- 主菜单 → 大厅 ---------- */
  try {
  const A = await page('房主A');
  await shot(A, '01-主菜单.png');

  /* ---------- 房主踢人 UI(放在主流程前: 需要空房间) ---------- */
  console.log('== 房主踢人 ==');
  const E = await page('房主E');
  await click(E, '#btnNet');
  await waitFor(E, `!document.getElementById('viewLobby').classList.contains('hide')`, 'E 建房大厅');
  const F = await page('被踢F');
  await click(F, '#btnNet');
  await waitFor(E, `!document.getElementById('btnReady').disabled === false`, 'E 看到 F 就位');
  await waitFor(E, `!document.getElementById('kick1').classList.contains('hide')`, '房主 E 看到"移出"按钮');
  await waitFor(F, `document.getElementById('kick0').classList.contains('hide') && document.getElementById('kick1').classList.contains('hide')`, '非房主 F 看不到"移出"按钮');
  await click(E, '#kick1');
  await waitFor(E, `!document.getElementById('ovKick').classList.contains('hide')`, '移出确认弹窗');
  await click(E, '#btnKickYes');
  await waitFor(F, `!document.getElementById('viewMenu').classList.contains('hide')`, 'F 被移出后回到主菜单', 10000);
  await waitFor(E, `document.getElementById('seatSt1').textContent.indexOf('空位') >= 0`, 'E 房主座位空出');
  ok('踢人功能: 房主移出对手 → 被踢者退回主菜单并提示, 房主房间空出可补位');
  await click(E, '#btnLeave');   // E 也退出, 把房间让给主流程
  await waitFor(E, `!document.getElementById('viewMenu').classList.contains('hide')`, 'E 回主菜单');
  await wait(300);

  await click(A, '#btnNet');
  await waitFor(A, `!document.getElementById('viewLobby').classList.contains('hide')`, 'A 进入大厅');

  const B = await page('挑战者B');
  await click(B, '#btnNet');
  await waitFor(B, `!document.getElementById('viewLobby').classList.contains('hide')`, 'B 加入大厅');

  // 两个座位都被服务器确认占据(两页各自视角)
  for (const [nm, p] of [['A', A], ['B', B]]) {
    await waitFor(p, `document.querySelectorAll('.seat.open').length === 0`, nm + ' 看到双方占座');
  }
  ok('房主与挑战者各自看到双方占座');
  await shot(A, '02-准备大厅.png');

  // 改键冒烟: A 的 蓄力 改为 A 键
  await A.evaluate(() => { document.querySelectorAll('#keysList .bindrow .bk')[0].click(); });
  await wait(200);
  await A.keyboard.press('KeyA');
  await waitFor(A, `document.querySelectorAll('#keysList kbd.kc')[0].textContent === 'A'`, '改键生效');

  await click(A, '#btnReady');
  await click(B, '#btnReady');
  await waitFor(A, `!document.getElementById('viewBattle').classList.contains('hide')`, 'A 进入对战');
  await waitFor(B, `!document.getElementById('viewBattle').classList.contains('hide')`, 'B 进入对战');
  await inputStart(A); await inputStart(B);

  for (const [nm, p] of [['A', A], ['B', B]]) {
    const n = await p.evaluate(() => document.querySelectorAll('#cards .act').length);
    if (n !== 5) throw new Error(nm + ' 页面卡片数 ' + n);
  }
  const keysA = await A.evaluate(() => Array.from(document.querySelectorAll('#cards kbd')).map(x => x.textContent).join(''));
  const keysB = await B.evaluate(() => Array.from(document.querySelectorAll('#cards kbd')).map(x => x.textContent).join(''));
  ok('双方页面都只渲染自己的 5 张出招卡(无对方按键)');
  ok('A 键位 ' + keysA + ' / B 键位 ' + keysB + ' (各按各的键盘)');
  if (!/A2345/.test(keysA)) throw new Error('A 改键未生效: ' + keysA);
  if (keysB !== '67890') throw new Error('B 键位异常: ' + keysB);
  await shot(A, '03-对战出招.png');

  // 布局审计(防止界面重叠/越界/被覆盖层挡住)
  const auditBattle = async (p, nm) => {
    const d = await p.evaluate((nm) => {
      const box = id => { const e = document.getElementById(id); if (!e) return null;
        const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const hit = (x, y) => { const el = document.elementFromPoint(x, y); if (!el) return 'none';
        const v = el.closest('.view, .overlay');
        return v ? v.id + '/' + (el.className || el.tagName) : el.tagName; };
      const cs = id => { const e = document.getElementById(id); const c = getComputedStyle(e);
        return { d: c.display, v: c.visibility, o: c.opacity }; };
      const t = box('stage'), w = box('timerWrap'), dock = box('dock');
      const cards = document.querySelectorAll('#cards .act');
      const enA = getComputedStyle(document.querySelector('#hudA .ener')).display;
      const enB = getComputedStyle(document.querySelector('#hudB .ener')).display;
      return {
        nm, vw: innerWidth, vh: innerHeight,
        stage: t, timer: w, timerVisible: !document.getElementById('timerWrap').classList.contains('hide'),
        timerCs: cs('timerWrap'),
        fig0: box('figw0'), fig1: box('figw1'),
        dock: dock,
        dockInside: dock.y + dock.h <= innerHeight + 1,
        stageAboveDock: t.y + t.h <= dock.y + 1,
        cards: cards.length,
        enAvis: enA, enBvis: enB,          // 双方能量显示状态
        youA: document.getElementById('hudA').classList.contains('you'),
        cardHit: hit(Math.round(innerWidth / 2), Math.round(innerHeight - 30)),
        charLHit: hit(Math.round(innerWidth * 0.23), Math.round(innerHeight * 0.62)),
        charRHit: hit(Math.round(innerWidth * 0.77), Math.round(innerHeight * 0.62)),
        figVisible: (() => {
          const f = document.getElementById('figw0').querySelector('.fig');
          const r = f.getBoundingClientRect();
          const c = getComputedStyle(f);
          return { w: Math.round(r.width), h: Math.round(r.height), d: c.display, v: c.visibility };
        })()
      };
    }, nm);
    console.log('  LAYOUT[' + nm + '] ' + JSON.stringify(d));
    const bad = [];
    if (!d.dock || d.dock.h < 60) bad.push('dock 过矮');
    if (!d.dockInside) bad.push('dock 超出屏幕底部');
    if (!d.stageAboveDock) bad.push('stage 与 dock 重叠');
    if (d.figVisible && d.figVisible.w < 40) bad.push('小人不可见');
    if (d.cards !== 5) bad.push('卡片数量异常');
    if (d.cardHit.indexOf('viewBattle') < 0 && d.cardHit.indexOf('act') < 0 && d.cardHit !== 'none') bad.push('卡片被遮挡: ' + d.cardHit);
    if (!d.timerCs || d.timerCs.d === 'none') bad.push('计时条样式异常');
    // 能量保密: 只显示自己的能量, 对方面板不显示能量
    const mineVis = d.youA ? d.enAvis : d.enBvis;
    const oppVis = d.youA ? d.enBvis : d.enAvis;
    if (mineVis === 'none' || oppVis !== 'none') bad.push('能量显示违反"只显示自己的能量": 自己=' + mineVis + ' 对方=' + oppVis);
    if (bad.length) throw new Error('布局问题: ' + bad.join('; '));
    return d;
  };
  await auditBattle(A, '房主A');
  await auditBattle(B, '挑战者B');
  ok('对战布局几何审计通过(计时条/双方小人/出招卡/无遮挡)');

  /* ---------- 小局 1: 蓄力 → 大攻击斩杀小攻击 ---------- */
  for (let r = 1; r <= 5; r++) {
    await inputStart(A);
    await pick(A, 0); await pick(B, 0);       // 双方蓄力
    await reveal(A);
    if (r === 1) {
      const a = await bubOf(A, 0), b1 = await bubOf(A, 1);
      ok('双方头顶对话框揭示选项(蓝: ' + a + ' · 红: ' + b1 + ')');
      const bubGeo = await A.evaluate(() => {
        const s = document.getElementById('stage').getBoundingClientRect();
        const inS = id => { const b = document.getElementById(id).getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.y >= s.y - 2 && b.y + b.height <= s.y + s.height + 2 &&
                 b.x >= s.x - 2 && b.x + b.width <= s.x + s.width + 2; };
        return { b0: inS('bub0'), b1: inS('bub1'), n: document.querySelectorAll('.bub.show').length };
      });
      if (!bubGeo.b0 || !bubGeo.b1 || bubGeo.n !== 2) throw new Error('头顶对话框越界或数量异常: ' + JSON.stringify(bubGeo));
      ok('头顶对话框都完整显示在舞台内');
      await shot(A, '04-头顶对话框揭示.png');
      /* 表情互动: 发 😂 → 双方屏幕弹出 1 秒, 1.5 秒冷却期间按钮禁用 */
      await A.evaluate(() => { const b = document.querySelectorAll('#emojiBar .eb')[0]; if (!b.disabled) b.click(); });
      await waitFor(A, `document.querySelectorAll('#emojiFx .em').length >= 1`, 'A 端弹出表情');
      await waitFor(B, `document.querySelectorAll('#emojiFx .em').length >= 1`, 'B 端收到表情(服务器转发)', 4000);
      const emTxt = await B.evaluate(() => { const e = document.querySelector('#emojiFx .em'); return e ? e.textContent : ''; });
      if (emTxt !== '😂') throw new Error('表情内容错误: ' + emTxt);
      const cdOn = await A.evaluate(() => document.querySelectorAll('#emojiBar .eb')[0].disabled);
      if (!cdOn) throw new Error('表情冷却未生效(按钮未禁用)');
      await waitFor(A, `document.querySelectorAll('#emojiFx .em').length === 0`, '表情 1 秒后消失', 4000);
      await waitFor(A, `document.querySelectorAll('#emojiBar .eb')[0].disabled === false`, '1.5s 冷却结束按钮恢复', 5000);
      ok('表情互动: 点击即弹(双方同步)+1s 消失+1.5s 冷却+音效 ✓');
    }
    await waitLineHide(A);
  }
  await inputStart(A);
  await pick(A, 3); await pick(B, 1);         // A 大攻击 vs B 小攻击(新规则: 大压小)
  await reveal(A);
  await waitFor(A, `document.getElementById('bang').classList.contains('show') && document.getElementById('bang').textContent.indexOf('K.O.') >= 0`, 'K.O. 横幅');
  ok('规则: 大攻击压过小攻击, 出小攻击的红方被斩杀 → K.O.');
  await shot(A, '05-大攻击斩杀小攻击-KO.png');
  await waitFor(A, `document.getElementById('bang').textContent.indexOf('第 2 小局') >= 0`, '第 2 小局开场');
  // 小局结束 → 能量必须清零(联机与 AI 同规则)
  const enOf = async (p, id) => p.evaluate((i) => document.getElementById(i).textContent, id);
  if ((await enOf(A, 'en0')) !== '0' || (await enOf(B, 'en1')) !== '0') {
    throw new Error('小局结束能量未清零: A=' + await enOf(A, 'en0') + ' B=' + await enOf(B, 'en1'));
  }
  ok('小局结束能量清零: 第 2 小局双方从 0 能量开始');
  await shot(A, '06-第二小局开场.png');

  /* ---------- 小局 2: 先打格挡回合(粒子爆发), 再被红方大攻击斩杀小攻击 ---------- */
  // r7: 双方蓄力(为小攻击攒 1 能量)
  await inputStart(A);
  await pick(A, 0); await pick(B, 0);
  await reveal(A); await waitLineHide(A);
  // r8: A 小攻击 vs B 小防御 → 被挡: 格挡音效 + 盾面粒子爆发
  await inputStart(A);
  await pick(A, 1); await pick(B, 2);
  await reveal(A);
  await waitFor(A, `document.querySelectorAll('#fx1 span.p').length >= 6`, '格挡火花粒子爆发');
  ok('攻击打在防御上: 格挡火花粒子爆发 ✓');
  await shot(A, '07-格挡粒子爆发.png');
  await waitLineHide(A);
  // r9-r10: 双方蓄力(B 攒到 3 能量放大)
  for (let r = 9; r <= 10; r++) {
    await inputStart(A);
    await pick(A, 0); await pick(B, 0);
    await reveal(A); await waitLineHide(A);
  }
  // r11: A 小攻击 vs B 大攻击 → A(小攻击方)被斩杀, B 扳回
  await inputStart(A);
  await pick(A, 1); await pick(B, 3);
  await reveal(A);
  await waitFor(A, `document.getElementById('bang').classList.contains('show') && document.getElementById('bang').textContent.indexOf('K.O.') >= 0`, 'K.O. 横幅2');
  ok('小局 2: 红方大攻击斩杀蓝方小攻击 → 扳平 1:1');
  await shot(B, '08-红方视角斩杀.png');
  await waitFor(A, `document.getElementById('bang').textContent.indexOf('第 3 小局') >= 0`, '第 3 小局开场');

  /* ---------- 决胜小局 3 → 结算面板 ---------- */
  for (let r = 1; r <= 3; r++) {
    await inputStart(A);
    await pick(A, 0); await pick(B, 0);
    await reveal(A);
    await waitLineHide(A);
  }
  await inputStart(A);
  await pick(A, 3); await pick(B, 1);         // A 大攻击斩杀 B 小攻击 → 蓝方 2:1 夺冠
  await reveal(A);
  await waitFor(A, `!document.getElementById('ovFinal').classList.contains('hide')`, '结算面板');
  ok('BO3 结束 2:1(蓝方胜, 决胜局同为"大斩小")');
  await shot(A, '09-整场结算.png');
  const finalA = await A.evaluate(() => document.getElementById('finalBig').textContent);
  const finalB = await B.evaluate(() => document.getElementById('finalBig').textContent);
  if (finalA.indexOf('赢') < 0) throw new Error('A 结算文案异常: ' + finalA);
  if (finalB.indexOf('输') < 0) throw new Error('B 结算文案异常: ' + finalB);

  await click(A, '#btnAgain'); await click(B, '#btnAgain');
  await waitFor(A, `document.getElementById('turnNo').textContent === '1' && !document.getElementById('viewBattle').classList.contains('hide')`, '重赛开局');
  ok('双方点"再来一局"自动开新场(比分清零)');

  /* ---------- AI 练习模式冒烟 ---------- */
  const C = await page('练习C');
  await click(C, '#btnAI');
  await inputStart(C);
  await pick(C, 0);
  await reveal(C);
  const aiBub = await C.evaluate(() => Array.from(document.querySelectorAll('.bub.show .bt')).map(x => x.textContent).join('/'));
  if (aiBub.indexOf('蓄力') < 0) throw new Error('AI 头顶对话框未揭示: ' + aiBub);
  ok('AI 练习模式: 双方头顶对话框揭示(' + aiBub + ')');
  await shot(C, '10-AI练习模式.png');

  const jsErrors = ERRORS.filter(x => !/Target closed|Session closed/i.test(x));
  if (jsErrors.length) {
    console.error('⚠️ 页面 JS 错误:');
    jsErrors.slice(0, 8).forEach(e => console.error('  ' + e));
  } else ok('全程无页面 JS 错误');

  await kill();
  return { shots: 10 };
  } catch (e) {
    try { await kill(); } catch (e2) { /* 忽略清理错误 */ }
    throw e;
  }
}

async function main() {
  fs.mkdirSync(PREVIEW, { recursive: true });
  const exe = chromePath();
  if (!exe) { console.error('未找到 Chrome(可用 CHROME 环境变量指定), 跳过浏览器测试'); process.exit(0); }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await runOnce(attempt);
      console.log('\n✅ E2E 冒烟通过: ' + passed + ' 项 (截图见 preview/)');
      process.exit(0);
    } catch (e) {
      console.error('\n❌ E2E 尝试 ' + attempt + ' 失败: ' + (e && e.message || e));
      if (attempt === 3) {
        if (ERRORS.length) { console.error('页面错误记录:'); ERRORS.slice(0, 12).forEach(x => console.error('  ' + x)); }
        process.exit(1);
      }
      await wait(1200);
    }
  }
}
main();

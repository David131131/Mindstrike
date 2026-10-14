/**
 * Mindstrike(心战) — 零依赖本地联机服务器(Node.js 内置模块即可)
 *
 * 作用:
 *  1. 托管游戏页面(静态文件): 房主电脑跑起来后, 同一局域网的好友用浏览器
 *     直接访问 http://房主IP:8765 即可, 无需安装任何东西。
 *  2. 权威对局服务: 房间 / 就绪 / 回合时钟(2 秒出招窗口) / 结算 全部以
 *     本服务器时间为准, 两台电脑的出招窗口完全同步。
 *  3. 长轮询 JSON API: 客户端轮询拉取状态快照(rev 变化才返回新数据)。
 *
 * 运行:  node server.js            # 默认端口 8765
 *        PORT=9000 node server.js  # 自定义端口
 *        HOST=127.0.0.1 node server.js   # 只允许本机访问
 *
 * 规则与 game.js 一致: 1 滴血、命中即 K.O.、每小局 40 回合僵局判平重开、
 * BO3 先赢 2 小局者胜。回合内无能量约束外的动作合法性由服务器校验。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./game.js');

const ROOT = __dirname;

const EMOJI_MAX = 8;      // 表情数量上限(与 app.js 保持一致)
const EMOJI_CD_MS = 1500; // 表情冷却

/* ---------- 节奏参数(客户端动画时长必须短于服务端节拍, 见 app.js) ---------- */
const INPUT_MS   = 2000;  // 出招窗口
const GRACE_MS   = 250;   // 网络迟到宽容
const INTRO_MS   = 1600;  // "第 N 小局" 展示
const AFTER_OK_MS  = 2000; // 无击杀回合结算后的停留
const AFTER_KO_MS  = 3400; // 击杀结算后的停留
const OVER_MS      = 800;  // 整场结束到弹结算面板
const STALE_MATCH_MS = 10000; // 对局中无任何心跳判定掉线(长轮询自带 5s 心跳)
const STALE_LOBBY_MS = 40000; // 大厅中闲置释放座位

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2'
};

function lanUrls(port) {
  const out = [];
  const seen = new Set();
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const it of ifs[k] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      const ip = it.address;
      // 过滤虚拟网卡/回环等明显不能给好友用的地址
      if (ip.startsWith('0.') || ip.startsWith('169.254.') || seen.has(ip)) continue;
      seen.add(ip);
      out.push('http://' + ip + ':' + port);
    }
  }
  return out;
}

/**
 * 创建对局服务器。opts: {speed} 加速因子(测试用, 所有节拍除以 speed)
 * 返回 { server, roomState, close() }
 */
function createServer(opts) {
  opts = opts || {};
  const S = (ms) => Math.max(1, Math.round((ms || 0) / (opts.speed || 1)));

  let room = null;       // 当前房间
  let seq = 0;           // 状态版本号
  let nextTimer = null;  // 阶段推进定时器
  const pollers = [];    // 长轮询挂起请求 {res, timer, token}
  const lan = [];

  const server = http.createServer(onReq);

  /* ================= 状态快照(按观看者裁剪) ================= */
  function emptySeat() {
    return { token: null, present: false, ready: false, lastSeen: 0, picked: false };
  }
  function freshRoom() {
    return {
      phase: 'lobby', msg: '',
      seats: [emptySeat(), emptySeat()],
      hostSeat: -1,           // 房主(可踢人); 房主离开时自动转让给在场者
      bans: new Map(),        // 被踢 token → 到期时间(60s 内禁止重连)
      score: [0, 0], setNo: 1, turn: 0, e: [0, 0],
      input: null, result: null,
      over: null,
      stats: { turns: 0, voids: 0 },
      emojiEvt: null, lastEmoji: [0, 0],
      lan: lan.slice()
    };
  }
  /** 房主缺席时转让给在场的另一位玩家; 无人时置 -1 */
  function refreshHost() {
    if (!room) return;
    const present = room.seats.map(x => x.present);
    if (room.hostSeat < 0 || room.hostSeat > 1 || !present[room.hostSeat]) {
      room.hostSeat = present[0] ? 0 : (present[1] ? 1 : -1);
    }
  }
  function isBanned(token) {
    if (!room || !room.bans || !token) return false;
    const exp = room.bans.get(token);
    if (!exp) return false;
    if (exp > Date.now()) return true;
    room.bans.delete(token);
    return false;
  }
  function snapshot(token) {
    if (!room) return null;              // 房间已清空(双方都退出): 无快照可发
    const now = Date.now();
    const s = {
      seq: seq,
      srvT: now,
      net: true,
      phase: room.phase,
      msg: room.msg,
      host: room.hostSeat,
      seats: room.seats.map(x => ({ present: x.present, ready: x.ready, picked: x.picked })),
      score: room.score.slice(), setNo: room.setNo, turn: room.turn, e: room.e.slice(),
      input: room.input ? { deadline: room.input.deadline } : null,
      result: room.result, over: room.over,
      stats: Object.assign({}, room.stats),
      emoji: room.emojiEvt,   // 最近一次表情事件 {seq, seat, e}; 客户端按 seq 去重
      lan: room.lan,
      me: token ? { seat: room.seats.findIndex(x => x.token === token) } : null
    };
    return s;
  }
  function flushPollers(payload) {
    const body = JSON.stringify(payload);
    for (const p of pollers.splice(0)) {
      clearTimeout(p.timer);
      if (p.keep) clearInterval(p.keep);
      if (p.res && !p.res.writableEnded) p.res.end(body);
    }
  }
  function bump() {
    if (!room) { flushPollers({ ok: false, err: 'token' }); return; }  // 兜底: 避免空房间后崩溃
    seq++;
    const s = snapshot();
    flushPollers({ ok: true, state: s });
  }
  function clearNext() { if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; } }
  function later(ms, fn) { clearNext(); nextTimer = setTimeout(fn, S(ms)); }

  /* ================= 房间 / 座位 ================= */
  function seatIdx(token) {
    if (!room) return -1;
    for (let i = 0; i < 2; i++) if (room.seats[i].token === token) return i;
    return -1;
  }
  function join(token) {
    if (isBanned(token)) return { ok: false, err: 'kicked' };   // 被踢出的 token 60s 内不能回来
    if (!room) room = freshRoom();
    const i = seatIdx(token);          // 刷新后凭 token 重连原座位
    if (i >= 0) {
      room.seats[i].present = true;
      room.seats[i].lastSeen = Date.now();
      return { ok: true, seat: i, token: room.seats[i].token };
    }
    for (let k = 0; k < 2; k++) {
      const st = room.seats[k];
      if (!st.present && !st.token) {
        st.token = crypto.randomBytes(9).toString('hex');
        st.present = true; st.ready = false; st.picked = false;
        st.lastSeen = Date.now();
        if (room.hostSeat < 0) room.hostSeat = k;   // 第一个进房的人当房主
        if (room.phase !== 'lobby') abortMatch('对手已离开，本小局取消'); // 中途补位 → 先回大厅
        bump();
        return { ok: true, seat: k, token: st.token };
      }
    }
    return { ok: false, err: 'full' };
  }
  function leave(token) {
    const i = seatIdx(token);
    if (i < 0) return;
    const st = room.seats[i];
    const inMatch = room.phase !== 'lobby';
    const wasHost = room.hostSeat === i;
    st.present = false; st.ready = false; st.token = null; st.picked = false;
    if (wasHost) refreshHost();       // 房主离开 → 转让房主身份
    if (inMatch) abortMatch('对手离开了对局');
    else if (room.seats.every(x => !x.present)) room = null;
    if (room) bump();
  }
  /** 房主踢人: 被踢座位清空 + token 加入 60s 黑名单(防止立刻重连) */
  function kickPlayer(token) {
    const i = seatIdx(token);
    if (i < 0) return { ok: false, err: 'token' };
    if (room.hostSeat !== i) return { ok: false, err: 'host' };
    const j = 1 - i;
    const st = room.seats[j];
    if (!st || !st.present) return { ok: false, err: 'solo' };
    if (st.token) room.bans.set(st.token, Date.now() + 60000);
    st.present = false; st.ready = false; st.token = null; st.picked = false;
    if (room.phase !== 'lobby') {
      abortMatch('对手被房主移出了对局');   // 对局中踢人 → 回大厅(含 bump)
    } else {
      refreshHost();
      bump();
    }
    return { ok: true };
  }
  function poke(token) {
    const i = seatIdx(token);
    if (i >= 0) room.seats[i].lastSeen = Date.now();
  }

  /* ================= 对局流程(权威时钟) =================
   * 对外广播的 phase 与客户端一一对应: lobby | intro | input | result | over
   * 每个阶段由 nextTimer 推进, 阶段定时器触发时都会复查 phase 是否仍然正确
   * (中途离开/掉线会 abortMatch 清空定时器并回 lobby)。
   */
  function readyUp(token, ready) {
    const i = seatIdx(token);
    if (i < 0 || room.phase !== 'lobby') return { ok: false, err: 'phase' };
    room.seats[i].ready = !!ready;
    bump();
    const bothPresent = room.seats[0].present && room.seats[1].present;
    const bothReady = room.seats[0].ready && room.seats[1].ready;
    if (bothPresent && bothReady) beginMatch();
    return { ok: true };
  }
  function beginMatch() {
    room.score = [0, 0];
    room.stats = { turns: 0, voids: 0 };
    room.over = null;
    room.setNo = 1;
    setIntro('对局开始');
  }
  /** 小局介绍(intro 事件) → 介绍结束后自动进入首回合 */
  function setIntro(msg) {
    room.turn = 0;
    room.e = [0, 0];
    room.result = null;
    room.input = null;
    room.pickVal = null;
    room.phase = 'intro';
    room.msg = msg;
    bump();
    later(INTRO_MS, () => { if (room && room.phase === 'intro') beginNextRound(); });
  }
  /** 开启一个新的出招回合(input 事件) */
  function beginNextRound() {
    if (!room || (room.phase !== 'intro' && room.phase !== 'result')) return;
    if (room.turn >= core.SET_MAX_TURNS) {
      // 40 回合无人阵亡 → 判平重开(比分不变, 同一小局从第 1 回合重来)
      room.stats.voids++;
      room.turn = 0; room.e = [0, 0]; room.result = null;
      room.phase = 'intro';
      room.msg = '超过 ' + core.SET_MAX_TURNS + ' 回合无人被击中，本小局判平重开';
      bump();
      later(INTRO_MS, () => { if (room && room.phase === 'intro') beginNextRound(); });
      return;
    }
    room.turn++;
    room.input = { deadline: Date.now() + INPUT_MS };
    room.pickVal = [null, null];
    room.seats.forEach(st => { st.picked = false; });
    room.phase = 'input';
    bump();
    later(INPUT_MS + GRACE_MS, () => { if (room && room.phase === 'input') resolveRound(); });
  }
  function pick(token, move) {
    const i = seatIdx(token);
    if (i < 0 || room.phase !== 'input') return { ok: false, err: 'phase' };
    if (!core.ACTIONS[move] || move === core.NONE) return { ok: false, err: 'move' };
    if (core.ACTIONS[move].cost > room.e[i]) return { ok: false, err: 'energy' };
    room.pickVal[i] = move;
    room.seats[i].picked = true;
    bump(); // 让对手看到"已锁定"状态(不泄露内容)
    return { ok: true };
  }
  function resolveRound() {
    if (!room || room.phase !== 'input') return;
    const a1 = room.pickVal && room.pickVal[0] ? room.pickVal[0] : core.NONE;
    const a2 = room.pickVal && room.pickVal[1] ? room.pickVal[1] : core.NONE;
    const r = core.exchange({ e1: room.e[0], e2: room.e[1] }, a1, a2);
    room.e = [r.e1, r.e2];
    room.result = {
      turn: room.turn, m1: r.a1, m2: r.a2,
      e1: r.e1, e2: r.e2,
      clash: r.clash, hitP1: r.hitP1, hitP2: r.hitP2
    };
    room.stats.turns++;
    room.input = null;
    room.phase = 'result';
    bump();

    if (r.hitP1 || r.hitP2) {
      const loser = r.hitP1 ? 0 : 1;
      room.score[1 - loser]++;
      later(AFTER_KO_MS, () => {
        if (!room || room.phase !== 'result') return;
        if (room.score[1 - loser] >= 2) finishMatch(1 - loser);
        else { room.setNo++; setIntro('第 ' + room.setNo + ' 小局'); }
      });
    } else {
      later(AFTER_OK_MS, () => { if (room && room.phase === 'result') beginNextRound(); });
    }
  }
  function finishMatch(winner) {
    room.phase = 'over';
    room.over = { winner: winner, rematch: [false, false] };
    bump();
  }
  function rematch(token, want) {
    const i = seatIdx(token);
    if (i < 0 || room.phase !== 'over' || !room.over) return { ok: false, err: 'phase' };
    room.over.rematch[i] = !!want;
    bump();
    if (room.over.rematch[0] && room.over.rematch[1]) {
      room.over = null;
      beginMatch();
    }
    return { ok: true };
  }
  /** 表情互动: 转发给对方屏幕。每座位 1.5s 冷却(服务端强制) */
  function sendEmoji(token, idx) {
    const i = seatIdx(token);
    if (i < 0) return { ok: false, err: 'token' };
    if (!(idx >= 0 && idx < EMOJI_MAX)) return { ok: false, err: 'move' };
    const now = Date.now();
    if (now - (room.lastEmoji[i] || 0) < EMOJI_CD_MS) return { ok: false, err: 'cd' };
    room.lastEmoji[i] = now;
    room.emojiEvt = { seq: seq + 1, seat: i, e: idx, t: now };
    bump(); // seq 增到 evt.seq, 快照里的 emoji.seq 与 seq 一致, 客户端据此去重
    return { ok: true, evt: room.emojiEvt.seq };
  }
  function abortMatch(msg) {
    clearNext();
    room.phase = 'lobby';
    room.msg = msg;
    room.input = null; room.result = null; room.over = null;
    room.pickVal = null;
    room.emojiEvt = null; room.lastEmoji = [0, 0];
    room.e = [0, 0]; room.score = [0, 0]; room.setNo = 1; room.turn = 0;
    room.seats.forEach(st => { st.ready = false; st.picked = false; });
    bump();
  }

  /* ================= 掉线巡检 ================= */
  setInterval(() => {
    if (!room) return;
    const now = Date.now();
    const inMatch = room.phase !== 'lobby';
    const lim = inMatch ? STALE_MATCH_MS : STALE_LOBBY_MS;
    let freed = false;
    for (let i = 0; i < 2; i++) {
      const st = room.seats[i];
      if (st.present && now - st.lastSeen > lim) {
        const wasHost = room.hostSeat === i;
        st.present = false; st.ready = false; st.token = null; st.picked = false;
        freed = true;
        if (inMatch) abortMatch('对手连接中断，对局已取消');  // 任何对局阶段掉线都中止
        else if (wasHost) refreshHost();
      }
    }
    if (freed) {
      if (room && room.seats.every(x => !x.present)) room = null;
      else if (room) refreshHost();
    }
    // 顺手清理过期的踢人黑名单
    if (room && room.bans) for (const [tk, exp] of room.bans) if (exp <= now) room.bans.delete(tk);
  }, 2000).unref();

  /* ================= HTTP ================= */
  function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(obj)); }

  function onReq(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p.startsWith('/api/')) {
      const parts = p.split('/');
      const api = parts[2];
      if (req.method === 'POST') {
        let body = '';
        req.on('data', d => { if (body.length < 1e5) body += d; });
        req.on('end', () => {
          let data = {};
          try { data = body ? JSON.parse(body) : {}; } catch (e) { /* 忽略 */ }
          const token = data.token || '';
          let out;
          switch (api) {
            case 'join': out = join(token); break;
            case 'leave': leave(token); out = { ok: true }; break;
            case 'ready': out = readyUp(token, !!data.ready); break;
            case 'pick': out = pick(token, data.move); break;
            case 'rematch': out = rematch(token, !!data.want); break;
            case 'emoji': out = sendEmoji(token, data.e); break;
            case 'kick': out = kickPlayer(token); break;
            default: out = { ok: false, err: 'unknown' };
          }
          poke(token);
          sendJson(res, 200, out);
        });
        return;
      }
      if (api === 'poll' || api === 'state') {
        const token = u.searchParams.get('token') || '';
        poke(token);
        const bannedErr = () => ({ ok: false, err: isBanned(token) ? 'kicked' : 'token' });
        if (!room || seatIdx(token) < 0) return sendJson(res, 200, bannedErr());
        const last = parseInt(u.searchParams.get('seq') || '0', 10) || 0;
        if (api === 'state' || seq !== last) return sendJson(res, 200, { ok: true, state: snapshot(token) });
        const pollObj = {
          res: res,
          timer: null,
          keep: null,
          token: token
        };
        pollObj.timer = setTimeout(() => {
          if (pollObj.keep) clearInterval(pollObj.keep);
          const k = pollers.indexOf(pollObj);
          if (k >= 0) pollers.splice(k, 1);
          if (res.writableEnded) return;
          if (!room || seatIdx(token) < 0) return res.end(JSON.stringify(bannedErr())); // 空房间/已退出/被踢
          res.end(JSON.stringify({ ok: true, state: snapshot(token) }));
        }, Math.max(1500, Math.round(20000 / (opts.speed || 1)))); // 长轮询上限; 加速测试时同步缩短
        pollObj.timer.unref && pollObj.timer.unref();
        pollObj.keep = setInterval(() => poke(token), 5000);  // 挂起期间维持心跳
        pollObj.keep.unref && pollObj.keep.unref();
        pollers.push(pollObj);
        return;
      }
      return sendJson(res, 404, { ok: false, err: 'unknown' });
    }
    /* 静态文件 */
    let file = null;
    try { file = p === '/' ? '/index.html' : decodeURIComponent(p); }
    catch (e) { return sendJson(res, 400, { ok: false, err: 'bad path' }); }
    const full = path.normalize(path.join(ROOT, file));
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return sendJson(res, 403, { ok: false, err: 'forbidden' });
    fs.readFile(full, (err, buf) => {
      if (err) return sendJson(res, 404, { ok: false, err: 'not found' });
      const ext = path.extname(full).toLowerCase();
      // 图片/代码一律 no-cache(换素材/改版即时生效); 仅大体积音频走缓存
      const heavy = ['.mp4', '.webm', '.mp3', '.ogg', '.wav'].indexOf(ext) >= 0;
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': heavy ? 'public, max-age=86400' : 'no-cache'
      });
      res.end(buf);
    });
  }

  return {
    server: server,
    seq: () => seq,
    roomState: () => room,
    lan: lan,
    listen(port, host, cb) {
      if (host) server.listen(port, host, () => { const addr = server.address(); if (cb) cb(addr); });
      else server.listen(port, () => { const addr = server.address(); if (cb) cb(addr); }); // 双栈: localhost(::1/IPv4) 都能访问
      return server;
    },
    close() { clearNext(); server.close(); }
  };
}

/** 用系统默认浏览器打开地址(仅本机)。失败静默, 不影响服务器。 */
function openBrowser(port) {
  const url = 'http://localhost:' + port;
  try {
    let cmd, args;
    if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
    else { cmd = 'xdg-open'; args = [url]; }
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.unref();
  } catch (e) { /* 忽略 */ }
}

function main() {
  const port = parseInt(process.env.PORT || '8765', 10);
  const host = process.env.HOST || ''; // 默认双栈全接口(0.0.0.0 + ::), localhost 也能访问
  const speed = parseFloat(process.env.MS_SPEED || '1'); // 测试/演示加速: MS_SPEED=5 node server.js
  const app = createServer({ speed: speed > 0 ? speed : 1 });

  // 启动失败给友好提示(而不是一堆堆栈)
  app.server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('');
      console.error('  ⚠️  端口 ' + port + ' 已被占用(可能有旧的服务器进程还在运行)。');
      console.error('     解决: ① 关掉旧的终端窗口/进程后再试; ② 或换个端口:  PORT=9000 node server.js');
      console.error('');
    } else if (e && e.code === 'EACCES') {
      console.error('');
      console.error('  ⚠️  没有权限使用端口 ' + port + '(端口 < 1024 需要管理员权限)。');
      console.error('     解决: 换个大端口, 如:  PORT=8765 node server.js');
      console.error('');
    } else {
      console.error('  ⚠️  服务器启动失败:', e && e.message || e);
    }
    process.exit(1);
  });

  app.lan.push(...lanUrls(port));
  app.listen(port, host || undefined, (addr) => {
    console.log('');
    console.log('  ⚔️  Mindstrike · 联机服务器已启动  (Ctrl+C 停止)');
    console.log('  ─────────────────────────────────────────────');
    console.log('  ✓ 本机(这台电脑)打开:  http://localhost:' + addr.port);
    const lan = lanUrls(addr.port);
    for (const u of lan) console.log('  ✓ 局域网好友(同一Wi-Fi)打开: ' + u);
    if (!lan.length) {
      console.log('  ⚠️  未检测到局域网地址: 请确认本机已连接 Wi-Fi/网线, 否则好友无法加入。');
    }
    console.log('  ─────────────────────────────────────────────');
    console.log('  提示: "localhost" 只在这台电脑的浏览器里有效;');
    console.log('  好友电脑必须访问上面 192.168.x.x 的那个地址(不要用 localhost)。');
    console.log('  双方打开后 → 点 "联机对战" 建房/加入 → 准备就绪开打。');
    console.log('');
    // 自检: 服务器自己请求一次首页, 证明可访问
    fetch('http://127.0.0.1:' + addr.port + '/', { signal: AbortSignal.timeout(2500) })
      .then(r => {
        if (r.ok) {
          console.log('  ✓ 自检通过: 本机可正常访问 http://localhost:' + addr.port + '  → 现在打开这个地址即可');
          if (process.env.MS_OPEN === '1') openBrowser(addr.port); // 一键启动时自动打开浏览器
        }
      })
      .catch(() => console.log('  ⚠️  自检未完成(不影响使用, 请直接尝试打开上面的地址)'));
  });
}

if (require.main === module) main();
module.exports = { createServer, INPUT_MS, GRACE_MS };

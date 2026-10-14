/**
 * Mindstrike(心战) — 客户端主逻辑
 *
 * 三种入口:
 *  - 联机对战(服务器在局域网内): 创建/加入房间 → 大厅(改键/准备) → 对局
 *  - 单人练习(AI): 本地生成同样的阶段事件流, 新对战界面直接可用(无需服务器)
 *
 * 设计要点:
 *  - 双方在各自电脑上只显示"自己"的 5 张出招卡片(不显示对方按键);
 *  - 出招期间对方头顶只显示"思考中/已锁定", 锁定后双方统一揭示:
 *    各自头顶对话框 + 小人做出对应动作(蓄力/挥击/举盾/发呆);
 *  - 联机时钟以服务器为准(deadline 用服务器时间戳 + 本地时钟偏移换算),
 *    2 秒窗口结束时超时未出招 = 发呆(会被打);
 *  - 小人默认是纯 CSS 素材, 若放置 素材/p0.png(p1.png/svg/webp 亦可)会自动换图。
 */
(function () {
  'use strict';

  var core = window.MindCore;
  var Sfx = window.MindSfx;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function fmt(n) { return (n < 10 ? '0' : '') + n; }

  /* ================= 全局状态 ================= */
  var isFile = location.protocol === 'file:';
  var G = {
    mode: 'menu',          // menu | lobby | battle
    net: false, ai: false,
    seat: -1, token: '',
    phase: 'idle',         // lobby | intro | input | result | over
    phaseSeq: 0,
    score: [0, 0], setNo: 1, turn: 0, e: [0, 0],
    sel: null,             // 本机本轮锁定的动作(下标), null=未锁定
    picked: [false, false],
    present: [false, false],   // 两个座位是否有人
    host: -1,                  // 房主座位(可踢人)
    inputUntil: 0,         // 出招截止(本机时钟, 已折算网络偏移)
    result: null,
    over: null,
    stats: { turns: 0, voids: 0 },
    skew: 0,
    timers: [], raf: 0, tickSec: -1,
    bindRow: -1,
    keys: null,
    inMatch: false,
    emojiSeen: 0, emojiCdT: 0,
    menuImg: null,
    lastBangHide: 0
  };
  var NAMES = ['你', '🤖 电脑'];
  var EMOJIS = ['😂', '😭', '😡', '👍', '😮', '🤯', '🥳', '💀'];  // 表情栏(需 ≤ 服务器 EMOJI_MAX)
  var EMOJI_MS = 1000;   // 表情显示时长
  var EMOJI_CD = 1500;   // 表情冷却

  /* ================= 语言(中/英) ================= */
  var LAN = (function () { try { return localStorage.getItem('ms.lang') === 'en' ? 'en' : 'zh'; } catch (e) { return 'zh'; } })();
  function isEn() { return LAN === 'en'; }
  function tr(zh, en) { return isEn() ? en : zh; }
  function setLang(l) {
    LAN = (l === 'en') ? 'en' : 'zh';
    try { localStorage.setItem('ms.lang', LAN); } catch (e) { }
    applyLang();
  }
  /** 动作显示名/提示(小攻击→挥砍, 大攻击→重击, 小防御→格挡, 大防御→举盾) */
  var ACT_TXT = {
    charge: { zh: { n: '蓄力', t: '获得 1 点能量(无上限)' }, en: { n: 'Charge', t: 'Gain 1 energy (unlimited)' } },
    small:  { zh: { n: '挥砍', t: '耗 1 能量, 命中即杀' }, en: { n: 'Slash', t: 'Costs 1 energy, kills on hit' } },
    guard:  { zh: { n: '格挡', t: '免费 · 挡下挥砍' }, en: { n: 'Block', t: 'Free · blocks Slash' } },
    heavy:  { zh: { n: '重击', t: '耗 3 能量, 命中即杀' }, en: { n: 'Smash', t: 'Costs 3 energy, kills on hit' } },
    wall:   { zh: { n: '举盾', t: '耗 1 能量 · 挡下重击与挥砍' }, en: { n: 'Shield', t: 'Costs 1 energy · blocks Smash & Slash' } }
  };
  function actName(id) { if (!core.ACTIONS[id]) return tr('发呆', 'Idle'); return isEn() ? ACT_TXT[id].en.n : ACT_TXT[id].zh.n; }
  function actTip(id) { if (!core.ACTIONS[id]) return ''; return isEn() ? ACT_TXT[id].en.t : ACT_TXT[id].zh.t; }
  function actChip(a) {
    if (a.gain) return tr('蓄 1', 'Gain +1');
    return tr('耗 ' + a.cost, 'Cost ' + a.cost);
  }
  /** 界面静态文字同步(切换语言时调用) */
  function applyLang() {
    var E = isEn();
    var b = $('btnLang');
    if (b) b.textContent = E ? '中文' : 'EN';
    if ($('mw1')) { $('mw1').textContent = E ? 'Set' : '第'; }
    if ($('mw2')) { $('mw2').textContent = E ? '' : '小局'; }
    if ($('mw3')) { $('mw3').textContent = E ? 'Turn' : '回合'; }
    if ($('fbSub')) $('fbSub').textContent = E ? 'PVP duel · 2s to act · 1 hit K.O. · BO3' : '心战 · 2 秒出招 · 命中即 K.O. · BO3';
    if ($('lobbyTitle')) $('lobbyTitle').textContent = E ? '🛡️ Ready Room' : '🛡️ 准备房间';
    if ($('keysHead')) $('keysHead').textContent = E ? '⌨️ My keys (click [Edit], then press the key — or just click cards)' : '⌨️ 我的按键 (点击 [改键] 后按下新键 · 也可直接鼠标点卡片)';
    if ($('btnLeave')) $('btnLeave').textContent = E ? '← Leave room' : '← 离开房间';
    ['kick0', 'kick1'].forEach(function (id) { var k = $(id); if (k) k.textContent = '🚫 ' + (E ? 'Kick' : '移出'); });
    ['btnRules2', 'btnRules3'].forEach(function (id) { var r = $(id); if (r) r.textContent = E ? 'Rules & Help' : '规则 & 操作'; });
    if ($('qtT')) $('qtT').textContent = E ? 'Leave the current match?' : '离开当前对局?';
    if ($('qtP')) $('qtP').textContent = E ? 'The match ends immediately (opponent gets notified)' : '对局将直接结束(对手会收到通知)';
    if ($('btnQuitYes')) $('btnQuitYes').textContent = E ? 'Leave' : '离开';
    if ($('btnQuitNo')) $('btnQuitNo').textContent = E ? 'Cancel' : '取消';
    if ($('ktT')) $('ktT').textContent = E ? '🚫 Kick the opponent?' : '🚫 把对手移出房间?';
    if ($('ktP')) $('ktP').textContent = E ? 'They are removed immediately (cannot rejoin for 60s).' : '对方将被立刻移出(60 秒内无法重连)。此操作不可撤销。';
    if ($('btnKickYes')) $('btnKickYes').textContent = E ? 'Kick' : '确认移出';
    if ($('btnKickNo')) $('btnKickNo').textContent = E ? 'Cancel' : '取消';
    if ($('lostT')) $('lostT').textContent = E ? '⚠️ Connection lost' : '⚠️ 连接已断开';
    if ($('btnLostRetry')) $('btnLostRetry').textContent = E ? 'Retry' : '重试';
    if ($('btnLostMenu')) $('btnLostMenu').textContent = E ? 'Menu' : '回主菜单';
    if ($('btnAgain')) $('btnAgain').textContent = E ? '🔄 Rematch' : '🔄 再来一局';
    if ($('btnMenu')) $('btnMenu').textContent = E ? '🏠 Main Menu' : '🏠 返回主菜单';
    document.body.classList.toggle('lang-en', E);
    syncSoundLabels();
    syncNetTip();
    if (G.mode === 'battle') { buildHudNames(); buildCards(); updateKickBtnsSafe(); }
    else if (G.mode === 'lobby') { if (G.net) refreshState(); else renderKeysList(); }
    else if (!G.net && !$('ovRules').classList.contains('hide')) rebuildRules();
  }
  function updateKickBtnsSafe() { refreshKickUI(); }
  function soundLabelOn(on) { return tr('♪ 声音: 开', '♪ Sound: On') + (on ? '' : ''); }
  function syncSoundLabels() {
    var on = Sfx.isMaster();
    var t = isEn() ? (on ? '♪ Sound: On' : '♪ Sound: Off') : (on ? '♪ 声音: 开' : '♪ 声音: 关');
    ['btnSnd1', 'btnSnd2'].forEach(function (id) { var x = $(id); if (x) x.textContent = t; });
  }

  /** 服务器下发的中文消息 → 英文(仅显示层转换) */
  function svcMsg(zh) {
    if (!zh || !isEn()) return zh;
    var m = zh.match(/^第\s*(\d+)\s*小局/);
    if (m) return 'Set ' + m[1];
    if (zh.indexOf('对局开始') >= 0) return 'Match Start';
    if (zh.indexOf('判平') >= 0) return 'Tie — restarting this set (no KO in ' + core.SET_MAX_TURNS + ' turns)';
    if (zh.indexOf('移出了对局') >= 0) return 'Opponent was removed by the host';
    if (zh.indexOf('离开') >= 0) return 'Opponent left the match';
    if (zh.indexOf('连接中断') >= 0) return 'Opponent disconnected — match cancelled';
    return zh;
  }

  function later(fn, ms) { var id = setTimeout(fn, ms); G.timers.push(id); return id; }
  function clearTimers() { G.timers.forEach(clearTimeout); G.timers = []; }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(G.toastTimer);
    G.toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }
  function serverNow() { return Date.now() + G.skew; }
  function blurFocus() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }

  /* ================= 按键绑定 ================= */
  var KEY_DEFAULT = [
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'],
    ['Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']
  ];
  function keyLabel(code) {
    if (!code) return '?';
    var m = code.match(/^Digit(\d)$/); if (m) return m[1];
    m = code.match(/^Key([A-Z])$/); if (m) return m[1];
    m = code.match(/^Arrow(.*)$/); if (m) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[m[1]] || code;
    if (code === 'Space') return '空格';
    if (code === 'Minus') return '-';
    if (code === 'Equal') return '=';
    if (code === 'Comma') return ',';
    if (code === 'Period') return '.';
    if (code === 'Slash') return '/';
    if (code === 'Semicolon') return ';';
    if (code === 'Quote') return "'";
    if (code === 'BracketLeft') return '[';
    if (code === 'BracketRight') return ']';
    if (code === 'Backslash') return '\\';
    if (code === 'Backquote') return '`';
    if (/^Numpad\d$/.test(code)) return '小键盘' + code.slice(6);
    return code.replace(/^Key/, '').replace(/^Digit/, '');
  }
  function loadKeys() {
    var k = [[], []];
    for (var s = 0; s < 2; s++) {
      var raw = null;
      try { raw = JSON.parse(localStorage.getItem('ms.keys.' + s)); } catch (e) { }
      k[s] = (raw && raw.length === 5) ? raw : KEY_DEFAULT[s].slice();
    }
    return k;
  }
  function saveKeys() {
    for (var s = 0; s < 2; s++) localStorage.setItem('ms.keys.' + s, JSON.stringify(G.keys[s]));
  }

  /* ================= 视图切换 ================= */
  function showView(v) {
    ['viewMenu', 'viewLobby', 'viewBattle'].forEach(function (id) {
      $(id).classList.toggle('hide', id !== v);
    });
    if (v === 'viewMenu') { Sfx.battleStop(); Sfx.startMenuMusic(); }
    else { Sfx.stopMenuMusic(); }
    blurFocus();
  }
  function showMenu() {
    clearTimers(); stopCountdown();
    G.mode = 'menu'; G.net = false; G.ai = false; G.inMatch = false;
    G.phase = 'idle'; G.phaseSeq = 0;
    G.host = -1; G.present = [false, false];
    closeAllOv();
    hideLost();
    showView('viewMenu');
    renderSndBtns();
  }
  function closeAllOv() {
    ['ovRules', 'ovFinal', 'ovQuit', 'ovKick'].forEach(function (id) { $(id).classList.add('hide'); });
  }

  /* ================= 菜单 / 大厅 ================= */
  function setNetTip(t) { var e = $('netModeTip'); if (e) e.textContent = t || ''; }
  function syncNetTip() {
    if (!isFile) { setNetTip(''); return; }
    setNetTip(isEn()
      ? 'Online play needs the server first: double-click "启动联机.command" (Mac) / "启动联机.bat" (Windows), then open http://localhost:8765'
      : '联机请先双击项目里的 "启动联机.command"(Mac) 或 "启动联机.bat"(Windows) 启动服务器, 然后访问 http://localhost:8765 (把地址发给好友即可加入)');
  }

  function clickNet() {
    if (isFile) {
      toast(tr('浏览器直接打开文件时不能联机', 'Online play needs the server — file:// mode is offline only'));
      syncNetTip();
      return;
    }
    netJoin();
  }
  function clickAI() { startLocalMatch(); }

  function updateSeatView(st) {
    // st = 完整状态快照 {seats, host}; 本机座次由 G.seat 提供
    var E = isEn();
    var seats = st ? st.seats : null;
    var host = st ? st.host : -1;
    for (var s = 0; s < 2; s++) {
      var box = $('seat' + s);
      var stx = seats ? seats[s] : null;
      var mine = s === G.seat;
      box.classList.toggle('mine', mine);
      box.classList.toggle('open', !stx || !stx.present);
      $('selfTag' + s).classList.toggle('hide', !mine);
      if ($('selfTag' + s)) $('selfTag' + s).textContent = E ? 'You' : '你';
      var who = $('who' + s);
      who.innerHTML = (E ? (s === 0 ? 'Blue' : 'Red') : (s === 0 ? '蓝方' : '红方')) +
        (stx && stx.present && host === s ? ' <span class="hosttag">' + (E ? 'Host' : '房主') + '</span>' : '');
      var txt = '';
      if (!stx || !stx.present) txt = E ? '👤 Empty · waiting for a player…' : '👤 空位 · 等待玩家加入…';
      else {
        var r = stx.ready ? (E ? '✔ Ready' : '✔ 已准备') : (E ? '○ Not ready' : '○ 尚未准备');
        txt = r + (mine ? (E ? ' (you)' : '（你）') : '');
      }
      $('seatSt' + s).textContent = txt;
      // 房主才可见的"移出"按钮(只出现在对手座位上)
      $('kick' + s).classList.toggle('hide', !(G.host === G.seat && host === G.seat && s !== G.seat && stx && stx.present));
    }
    var addrEl = $('lobbyAddr');
    var showA = !!(seats && seats[0] && seats[0].present && !(seats[1] && seats[1].present));
    addrEl.classList.toggle('hide', !showA);
    if (showA) addrEl.innerHTML = (E ? 'Send this address to your friend: ' : '把这段地址发给好友加入: ') +
      '<code>' + location.host + '</code>';
    // 就绪按钮状态
    var btn = $('btnReady');
    var other = seats && seats[1 - G.seat];
    var otherReady = !!(other && other.present);
    var myReady = !!(seats && seats[G.seat] && seats[G.seat].ready);
    btn.disabled = !otherReady || myReady;
    btn.textContent = !otherReady ? (E ? 'Waiting for opponent…' : '等待对手加入…')
      : (myReady ? (E ? '✔ Ready · waiting for opponent' : '✔ 已准备 · 等待对手') : (E ? '⚔️ Ready!' : '⚔️ 准备就绪'));
    refreshKickUI();
  }
  /** 对战顶栏的房主踢人按钮显隐 */
  function refreshKickUI() {
    var b = $('btnKick');
    if (!b) return;
    var canKick = !G.ai && G.host === G.seat && G.seat >= 0;
    b.classList.toggle('hide', !(canKick && G.mode === 'battle' && G.inMatch && G.present[1 - G.seat]));
  }
  function askKick() {
    if (G.ai || G.host !== G.seat) return;
    $('ovKick').classList.remove('hide');
  }
  function doKick() {
    $('ovKick').classList.add('hide');
    post('kick', { token: G.token }).then(function (r) {
      if (r && r.ok) toast(tr('已将对手移出房间', 'Opponent removed'));
      else if (r && r.err === 'host') toast(tr('只有房主可以移出玩家', 'Only the host can kick players'));
      else if (r && r.err === 'solo') toast(tr('当前没有可移出的玩家', 'No player to remove right now'));
      else toast(tr('移出失败, 请重试', 'Kick failed, please retry'));
    }).catch(function () { lostNet('连接中断'); });
  }
  function showLobby() {
    G.mode = 'lobby'; G.ai = false;
    closeAllOv(); hideLost();
    showView('viewLobby');
    renderKeysList();
    updateReadyBtn();
  }

  /* ================= 联机客户端 ================= */
  var polling = false;
  function post(api, body) {
    return fetch('/api/' + api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }
  function netJoin() {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('ms.net')) || null; } catch (e) { }
    post('join', { token: saved ? saved.token : '' }).then(function (r) {
      if (!r.ok) { toast(tr('房间已满或不可加入', 'Room is full or cannot be joined')); return; }
      G.net = true; G.ai = false;
      G.seat = r.seat; G.token = r.token;
      sessionStorage.setItem('ms.net', JSON.stringify({ token: r.token }));
      showLobby();
      if (!polling) startPoll();
      refreshState();
    }).catch(function () { lostNet('无法连接对局服务器'); });
  }
  function refreshState() {
    return fetch('/api/state?token=' + encodeURIComponent(G.token))
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) applyState(r.state);
        else if (r.err === 'kicked') kickedOut();
        else if (r.err === 'token') return netRebind();
        return r;
      })
      .catch(function () { lostNet('连接中断'); });
  }
  function netRebind() {
    return post('join', { token: G.token }).then(function (r) {
      if (r.ok) { G.seat = r.seat; G.token = r.token; sessionStorage.setItem('ms.net', JSON.stringify({ token: r.token })); return refreshState(); }
      if (r.err === 'kicked') { kickedOut(); return null; }
      lostNet('对局房间已不存在，请回到主菜单重新开始');
      return null;
    }).catch(function () { lostNet('连接中断'); });
  }
  function startPoll() {
    polling = true;
    (function loop() {
      if (!G.net || !polling) return;
      fetch('/api/poll?token=' + encodeURIComponent(G.token) + '&seq=' + G.phaseSeq)
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (!polling) return;
          if (r.ok && r.state) {
            G.skew = Math.round(0.6 * G.skew + 0.4 * (r.state.srvT - Date.now()));
            applyState(r.state);
          } else if (r.err === 'kicked') {
            kickedOut();
            return;
          } else if (r.err === 'token') {
            netRebind().then(function () { if (polling) loop(); });
            return;
          }
          loop();
        })
        .catch(function () {
          if (polling) { polling = false; lostNet('与服务器的连接中断'); }
        });
    })();
  }
  function uxMsg(zh) {
    if (!zh || !isEn()) return zh;
    if (zh.indexOf('连接中断') >= 0) return 'Connection lost — check your network';
    if (zh.indexOf('无法连接') >= 0) return 'Cannot reach the game server';
    if (zh.indexOf('房间已不存在') >= 0) return 'The room no longer exists — go back to the main menu';
    return zh;
  }
  function lostNet(msg) {
    polling = false;
    $('lostMsg').textContent = uxMsg(msg) || tr('与对局服务器的连接中断了', 'Connection to the game server was lost');
    $('ovLost').classList.remove('hide');
    Sfx.battleStop();
  }
  function hideLost() { $('ovLost').classList.add('hide'); }

  /** 被房主移出: 停止一切联机状态, 回主菜单 */
  function kickedOut() {
    polling = false;
    G.net = false; G.seat = -1; G.token = '';
    G.inMatch = false; G.host = -1;
    try { sessionStorage.removeItem('ms.net'); } catch (e) { }
    clearTimers(); stopCountdown(); Sfx.battleStop();
    closeAllOv(); hideLost();
    showMenu();
    toast(tr('你已被房主移出房间', 'You were removed by the host'));
  }

  function doLeave() {
    if (G.net && G.token) post('leave', { token: G.token }).catch(function () { });
    try { sessionStorage.removeItem('ms.net'); } catch (e) { }
    G.net = false; G.seat = -1; G.token = '';
    polling = false;
    showMenu();
  }

  /* ---------- 网络状态应用 ---------- */
  function applyState(st) {
    if (!st) return;
    var prevPhase = G.phase, prevSeq = G.phaseSeq, prevTurn = G.turn;
    G.phase = st.phase;
    G.phaseSeq = st.seq;
    if (st.seats && st.seats.length === 2) {
      G.picked = [st.seats[0].picked, st.seats[1].picked];
      G.present = [st.seats[0].present, st.seats[1].present];
    }
    if (typeof st.host === 'number') G.host = st.host;
    var fresh = st.seq !== prevSeq;
    var moving = st.phase !== prevPhase ||
      (st.phase === 'input' && st.turn !== prevTurn) ||
      (st.phase === 'result' && (!G.result || G.result.turn !== st.turn)) ||
      (st.phase === 'over' && !G.over);
    if (st.result) G.result = st.result;
    if (st.over) G.over = st.over;

    /* 表情事件(自己广播回来的 + 对方的) → 弹表情, 按 evt.seq 去重 */
    if (st.emoji && st.emoji.seq !== G.emojiSeen && G.mode === 'battle') {
      G.emojiSeen = st.emoji.seq;
      if (EMOJIS[st.emoji.e]) showEmoji(st.emoji.seat, EMOJIS[st.emoji.e]);
    }

    if (st.phase === 'lobby') {
      if (G.mode === 'battle') {
        Sfx.battleStop();
        $('ovFinal').classList.add('hide');
        if (st.msg) toast(svcMsg(st.msg) || tr('回到了大厅', 'Back in the lobby'));
      }
      G.inMatch = false;
      G.result = null; G.over = null;
      if (G.mode !== 'lobby') showLobby();
      updateSeatView(st);
      return;
    }
    if (!fresh) { syncMeta(st); return; }

    if (G.mode !== 'battle') enterBattle();
    syncMeta(st);
    setEnergyUI(0); setEnergyUI(1);

    if (!moving) { updateWaitIfOver(); refreshKickUI(); return; }

    if (st.phase === 'intro') onIntro(st);
    else if (st.phase === 'input') onInput(st);
    else if (st.phase === 'result') onResult(st);
    else if (st.phase === 'over') onOver(st);

    refreshKickUI();

    /* 出招窗口内: 根据服务器座位状态同步头顶锁定气泡(不泄露内容) */
    if (st.phase === 'input' && G.mode === 'battle' && !G.ai && G.seat >= 0) {
      var s0 = st.seats && st.seats[0];
      var s1 = st.seats && st.seats[1];
      for (var s = 0; s < 2; s++) {
        var ss = s === 0 ? s0 : s1;
        if (!ss) continue;
        showBub(s, ss.picked ? '🔒' : '❔', ss.picked ? tr('已出招', 'Locked!') : tr('思考中…', 'thinking…'), 'think');
      }
    }
  }
  function updateWaitIfOver() {
    if (G.mode === 'battle' && G.phase === 'over' && G.over) updateWait(G.over);
  }

  function syncMeta(st) {
    G.score = st.score.slice(); G.setNo = st.setNo; G.turn = st.turn; G.e = st.e.slice();
    $('setNo').textContent = st.setNo;
    $('turnNo').textContent = st.turn;
    for (var s = 0; s < 2; s++) {
      var kids = $('score' + s).children;
      for (var i = 0; i < 2; i++) kids[i].classList.toggle('on', i < G.score[s]);
    }
  }

  /* ================= 本地(AI)模式: 生成与服务器一致的事件流 ================= */
  function startLocalMatch() {
    G.ai = true; G.net = false; G.seat = 0;
    G.keys = loadKeys();
    G.skew = 0;
    G.score = [0, 0]; G.setNo = 1; G.turn = 0; G.e = [0, 0];
    G.stats = { turns: 0, voids: 0 };
    G.sel = null; G.aiPicked = false; G.botSel = null;
    closeAllOv(); hideLost();
    enterBattle(null);
    G.result = null; G.over = null;
    localIntro({ msg: '对局开始', score: [0, 0], setNo: 1, turn: 0, e: [0, 0] });
  }
  function localState(phase, extra) {
    var st = {
      phase: phase,
      seq: ++G.phaseSeq,
      msg: extra && extra.msg || '',
      seats: [
        { present: true, ready: true, picked: !!G.sel },
        { present: true, ready: true, picked: G.aiPicked }
      ],
      score: G.score.slice(), setNo: G.setNo, turn: G.turn, e: G.e.slice(),
      stats: { turns: G.stats.turns, voids: G.stats.voids },
      local: true
    };
    if (extra && extra.input) st.input = { deadline: Date.now() + extra.input };
    if (extra && extra.result) st.result = extra.result;
    if (extra && extra.over) st.over = extra.over;
    return st;
  }
  var AI_DELAY = { min: 260, max: 1500 };
  function botPickLater() {
    var delay = AI_DELAY.min + Math.random() * (AI_DELAY.max - AI_DELAY.min);
    later(function () {
      if (G.phase !== 'input') return;
      var legal = core.legalActions(G.e[1]);
      var id = legal[(Math.random() * legal.length) | 0];
      G.aiPicked = true;
      setPickUI();           // 对方头顶出现 "已锁定"
      G.botSel = id;
    }, delay);
  }
  function localIntro(extra) {
    var msg = extra.msg;
    var st = localState('intro', { msg: msg });
    applyLocal(st);
    var wait = (msg === '对局开始') ? 1500 : 1600;
    later(function () { localInput(); }, wait);
  }
  /** 与服务器 setIntro 镜像: 每小局开始(含判平重开)时能量清零、回合归零 */
  function localSetStart(msg) {
    G.turn = 0; G.e = [0, 0]; G.result = null;
    G.sel = null; G.aiPicked = false; G.botSel = null;
    localIntro({ msg: msg });
  }
  function localInput() {
    if (G.phase !== 'intro' && G.phase !== 'result') return;
    if (G.turn >= core.SET_MAX_TURNS) {
      G.stats.voids++;
      localSetStart('超过 ' + core.SET_MAX_TURNS + ' 回合无人被击中，本小局判平重开');
      return;
    }
    G.turn++;
    G.sel = null; G.aiPicked = false; G.botSel = null;
    applyLocal(localState('input', { msg: '', input: 2000 }));
    botPickLater();
    later(function () { localResolve(); }, 2150);
  }
  function localResolve() {
    if (G.phase !== 'input') return;
    var a1 = (G.sel !== null) ? core.IDS[G.sel] : core.NONE;
    var a2 = G.botSel || core.NONE;
    var r = core.exchange({ e1: G.e[0], e2: G.e[1] }, a1, a2);
    G.e = [r.e1, r.e2];
    G.stats.turns++;
    var res = {
      turn: G.turn, m1: r.a1, m2: r.a2,
      e1: r.e1, e2: r.e2, clash: r.clash, hitP1: r.hitP1, hitP2: r.hitP2
    };
    G.result = res;
    applyLocal(localState('result', { result: res }));
    if (r.hitP1 || r.hitP2) {
      var loser = r.hitP1 ? 0 : 1;
      G.score[1 - loser]++;
      later(function () {
        if (G.score[1 - loser] >= 2) {
          G.stats = G.stats;
          var st = localState('over', { over: { winner: 1 - loser, rematch: [false, false], score: G.score.slice(), turns: G.stats.turns, voids: G.stats.voids } });
          applyLocal(st);
        } else {
          // 小局结束 → 下一小局: 能量清零 / 回合归零 / 比分保留(与联机一致)
          G.setNo++;
          localSetStart('第 ' + G.setNo + ' 小局');
        }
      }, 3500);
    } else {
      later(function () { localInput(); }, 2100);
    }
  }
  function aiAgain() {
    G.score = [0, 0]; G.setNo = 1; G.turn = 0; G.e = [0, 0];
    G.stats = { turns: 0, voids: 0 };
    G.phase = 'idle';
    $('ovFinal').classList.add('hide');
    localIntro({ msg: '对局开始', score: [0, 0], setNo: 1, turn: 0, e: [0, 0] });
  }
  function applyLocal(st) {
    var prevPhase = G.phase;
    var prevSeq = G.phaseSeq;
    var prevTurn = G.turn;
    G.phase = st.phase; G.phaseSeq = st.seq;
    if (st.seats) G.picked = [st.seats[0].picked, st.seats[1].picked];
    G.score = st.score.slice(); G.setNo = st.setNo; G.turn = st.turn; G.e = st.e.slice();
    if (prevSeq === st.seq && prevPhase === st.phase) return;
    var moving = st.phase !== prevPhase ||
      (st.phase === 'input' && st.turn !== prevTurn) ||
      (st.phase === 'over' && !G.over);
    if (st.phase === 'intro') onIntro(st);
    else if (st.phase === 'input') { if (moving) onInput(st); }
    else if (st.phase === 'result') { if (moving) onResult(st); }
    else if (st.phase === 'over') { if (moving) onOver(st); }
    syncMeta(st);
  }

  /* ================= 对战页 ================= */
  function enterBattle() {
    if (G.mode === 'battle') return;
    G.mode = 'battle';
    G.inMatch = true;
    G.keys = loadKeys();
    clearTimers(); stopCountdown();
    closeAllOv(); hideLost();
    showView('viewBattle');
    Sfx.battleStart();
    buildHudNames();
    buildCards();
    buildScoreDots();
    buildEmojiBar();
    hideBub(0); hideBub(1);
    resetFighters();
    refreshKickUI();
  }

  /* ---------- 表情互动 ---------- */
  function buildEmojiBar() {
    var bar = $('emojiBar');
    bar.innerHTML = '';
    EMOJIS.forEach(function (ch, i) {
      var b = el('button', 'eb');
      b.type = 'button';
      b.textContent = ch;
      b.title = '发个表情 (冷却 ' + (EMOJI_CD / 1000) + 's)';
      b.addEventListener('click', function () { sendEmoji(i); });
      bar.appendChild(b);
    });
    emojiBarCd(false);
  }
  function emojiBarCd(on) {
    var bar = $('emojiBar');
    if (!bar) return;
    var btns = bar.children;
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !!on;
    bar.style.opacity = on ? '0.55' : '';
  }
  function emojiReadySoon() {
    clearTimeout(G.emojiCdT);
    G.emojiCdT = setTimeout(function () { emojiBarCd(false); }, EMOJI_CD);
  }
  /** 屏幕中央弹出表情(本机与对方都会看到), 播放点击音效 */
  function showEmoji(seat, ch) {
    var box = $('emojiFx');
    if (!box) return;
    var sp = el('span', 'em s' + (seat || 0));
    sp.textContent = ch;
    sp.style.top = (seat ? 52 : 46) + '%';
    box.appendChild(sp);
    Sfx.play('emoji');
    setTimeout(function () { sp.remove(); }, EMOJI_MS + 120);
  }
  function sendEmoji(idx) {
    if (!G.inMatch || G.mode !== 'battle' || !EMOJIS[idx]) return;
    emojiBarCd(true);            // 先本地禁点(1.5s 冷却), 服务器也会强制校验
    if (G.ai) {
      showEmoji(G.seat, EMOJIS[idx]);
      emojiReadySoon();
      return;
    }
    post('emoji', { token: G.token, e: idx }).then(function (r) {
      if (r && r.ok) {
        G.emojiSeen = r.evt || 0;          // 自己这条的广播回来时不再重复弹
        showEmoji(G.seat, EMOJIS[idx]);
      }
      emojiReadySoon();
    }).catch(function () {
      emojiReadySoon();
      lostNet('连接中断');
    });
  }
  function buildScoreDots() {
    ['score0', 'score1'].forEach(function (id) {
      var d = $(id); d.innerHTML = '';
      for (var i = 0; i < 2; i++) d.appendChild(el('i'));
    });
  }
  function buildHudNames() {
    var my = G.seat, opp = 1 - my;
    var E = isEn();
    var meN = G.ai ? tr('你', 'You') : (E ? 'Blue Player' : '蓝方玩家');
    var opN = G.ai ? (E ? '🤖 CPU' : '🤖 电脑') : (E ? 'Red Player' : '红方玩家');
    $('name0').textContent = meN;
    $('name1').textContent = opN;
    $('hudA').classList.toggle('mine', my === 0);
    $('hudB').classList.toggle('mine', my === 1);
    $('hudA').classList.toggle('you', my === 0);
    $('hudB').classList.toggle('you', my === 1);
    $('hudA').classList.toggle('opp', my !== 0);
    $('hudB').classList.toggle('opp', my !== 1);
    $('sName0').textContent = G.ai ? tr('你', 'You') : (E ? 'Blue' : '蓝');
    $('sName1').textContent = G.ai ? (E ? 'CPU' : '电脑') : (E ? 'Red' : '红');
    if (G.ai) { NAMES[0] = tr('你', 'You'); NAMES[1] = E ? '🤖 CPU' : '🤖 电脑'; }
    else { NAMES[0] = E ? 'Blue Player' : '蓝方玩家'; NAMES[1] = E ? 'Red Player' : '红方玩家'; }
    void opp;
  }
  function buildCards() {
    var wrap = $('cards');
    wrap.innerHTML = '';
    core.IDS.forEach(function (id, i) {
      var a = core.ACTIONS[id];
      var b = el('button', 'act');
      b.dataset.i = i;
      b.innerHTML =
        '<span class="ic">' + a.icon + '</span>' +
        '<span class="nm">' + actName(id) + '</span>' +
        '<span class="tp">' + actTip(id) + '</span>' +
        '<span class="chip">' + actChip(a) + '</span>' +
        '<kbd>' + keyLabel(G.keys[G.seat][i]) + '</kbd>';
      b.addEventListener('click', function () { tryPick(Number(this.dataset.i)); });
      wrap.appendChild(b);
    });
  }
  function updateLegal() {
    var my = G.seat;
    if (my < 0) return;
    var btns = $('cards').children;
    for (var i = 0; i < core.IDS.length; i++) {
      var ok = core.canUse(G.e[my], core.IDS[i]);
      btns[i].disabled = !ok;
      if (!ok) btns[i].classList.remove('sel');
    }
    if (G.phase === 'input') markMyCard();
  }
  function markMyCard() {
    var btns = $('cards').children;
    for (var i = 0; i < core.IDS.length; i++) btns[i].classList.toggle('sel', i === G.sel);
  }

  function showLine(html) {
    var l = $('line');
    l.innerHTML = html || '';
    l.classList.add('show');
    clearTimeout(G.lineT);
    G.lineT = setTimeout(function () { l.classList.remove('show'); }, 3400);
  }
  function bang(txt, kind, ms) {
    var b = $('bang');
    b.textContent = txt;
    b.className = kind === 'small' ? 'small' : '';
    if (kind === 'gold') b.className = 'gold';
    else if (kind === 'small') b.className = 'small';
    else if (kind === 'smallgold') b.className = 'small gold';
    void b.offsetWidth;
    b.classList.add('show');
    var dur = ms || 1150;
    b.style.animationDuration = dur + 'ms';
    clearTimeout(G.bangT);
    G.bangT = setTimeout(function () { b.classList.remove('show'); }, dur + 60);
  }
  function shakeStage() {
    var st = $('stage');
    st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake');
    setTimeout(function () { st.classList.remove('shake'); }, 500);
  }

  /* ---------- 小人的通用操作 ---------- */
  var DX = { 0: 1, 1: -1 };
  function mvOf(s) { return $('mv' + s); }
  function unitOf(s) { return $('unit' + s); }
  function armL(s) { return $('armL' + s); }
  function armR(s) { return $('armR' + s); }
  function shieldEl(s) { return $('sh' + s); }
  function figOf(s) { return $('fig' + s); }
  function resetFighters() {
    for (var s = 0; s < 2; s++) {
      var mv = mvOf(s), fig = figOf(s), u = unitOf(s);
      mv.style.transform = ''; mv.style.transition = '';
      mv.style.animation = 'none';
      armL(s).className = 'arm aL';
      armR(s).className = 'arm aR';
      shieldEl(s).className = 'shield';
      fig.classList.remove('dead');   // hasimg(素材模式)不属于逐局重置状态, 不能删
      u.classList.remove('noidle');
      setHeart(s, false);
    }
  }
  function setHeart(s, dead) {
    var h = $('heart' + s);
    h.textContent = dead ? '💔' : '❤️';
    h.classList.toggle('dead', dead);
  }
  function setEnergyUI(s) {
    var b = $('en' + s);
    if (b.textContent !== String(G.e[s])) {
      b.textContent = G.e[s];
      b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump');
    }
  }
  function hideBub(s) {
    var b = $('bub' + s);
    b.classList.remove('show');
  }
  function showBub(s, ico, txt, cls) {
    var b = $('bub' + s);
    b.querySelector('.bi').textContent = ico || '';
    b.querySelector('.bt').textContent = txt || '';
    b.className = 'bub' + (cls ? ' ' + cls : '');
    void b.offsetWidth;
    b.classList.add('show');
  }
  function fxAt(s, emoji, topPct, big) {
    var box = $('fx' + s);
    var sp = el('span', big ? 'big' : '');
    sp.textContent = emoji;
    sp.style.top = (topPct || 45) + '%';
    sp.style.left = '50%';
    sp.style.marginLeft = '-18px';
    box.appendChild(sp);
    setTimeout(function () { sp.remove(); }, 900);
  }
  /** 粒子爆发: kind = 'spark'(格挡/命中火花) | 'hit'(命中大爆散) | 'dust'(倒地扬尘) */
  function fxBurst(s, kind, xPct, yPct) {
    var box = $('fx' + s);
    if (!box) return;
    var n, colors, cls;
    if (kind === 'hit') { n = 16; colors = ['#fff', '#ffd75e', '#ff8a5c', '#ff5d73', '#ffe9a8']; cls = 'p'; }
    else if (kind === 'dust') { n = 9; colors = ['rgba(205,220,255,.55)', 'rgba(150,170,230,.4)', 'rgba(255,255,255,.35)']; cls = 'dust'; }
    else { n = 12; colors = ['#fff', '#ffd75e', '#8fd0ff', '#ffb3c1', '#ffe9a8']; cls = 'p'; }
    xPct = xPct || 50; yPct = yPct || 46;
    for (var i = 0; i < n; i++) {
      var sp = el('span', cls);
      sp.style.left = (xPct + (Math.random() * 18 - 9)) + '%';
      sp.style.top = (yPct + (Math.random() * 16 - 8)) + '%';
      if (cls === 'p') {
        var sz = 3.5 + Math.random() * 5;
        sp.style.width = sz + 'px'; sp.style.height = sz + 'px';
        var c = colors[(Math.random() * colors.length) | 0];
        sp.style.background = c;
        sp.style.boxShadow = '0 0 7px ' + c;
      }
      sp.style.setProperty('--dx', Math.round(Math.random() * 84 - 42) + 'px');
      sp.style.setProperty('--dy', Math.round(kind === 'dust' ? Math.random() * 26 + 6 : Math.random() * 56 - 16) + 'px');
      box.appendChild(sp);
      (function (node) { setTimeout(function () { node.remove(); }, 950); })(sp);
    }
  }
  function poseCharge(s) {
    armL(s).classList.add('raise');
    armR(s).classList.add('raise');
    var mv = mvOf(s);
    mv.style.transition = 'transform .12s ease-out';
    mv.style.transform = 'translateY(7px) scale(.96,.93)';
    later(function () {
      fxAt(s, '⚡', 18); fxAt(s, '⚡', 40);
      mv.style.transition = 'transform .25s cubic-bezier(.2,1.6,.4,1)';
      mv.style.transform = '';
    }, 140);
    later(function () {
      armL(s).className = 'arm aL'; armR(s).className = 'arm aR';
    }, 480);
  }
  function poseGuard(s, wall) {
    var sh = shieldEl(s);
    sh.className = 'shield up' + (wall ? ' big' : '');
    armL(s).className = 'arm aL fwdL';
    armR(s).className = 'arm aR fwdR';
    later(function () { Sfx.play('guardup'); }, 60);
    if (wall) later(function () { fxAt(s, '✨', 30); }, 120);
  }
  function poseVoid(s) {
    armR(s).classList.add('raise');
    later(function () { armR(s).className = 'arm aR'; }, 700);
    later(function () { fxAt(s, '💦', 30); }, 250);
  }
  function poseShrug(s) {
    fxAt(s, '💤', 28);
  }
  function actionBody(s, move, isHitVictim) {
    var a = core.ACTIONS[move];
    if (!a) return;              // 发呆
    if (a.kind === 'gain') poseCharge(s);
    else if (a.kind === 'block') poseGuard(s, move === 'wall');
    else if (isHitVictim) { /* 该动作是被打对象自己的牌: 攻击方仍要挥出 */ poseFlinchAfter(s); }
  }
  function poseFlinchAfter(s) {
    later(function () {
      var mv = mvOf(s);
      mv.style.transition = 'transform .18s';
      mv.style.transform = 'translateY(10px) rotate(' + (8 * DX[s]) + 'deg)';
      later(function () { mv.style.transform = ''; }, 200);
    }, 320);
  }
  function doDash(s, heavy) {
    var mv = mvOf(s);
    var dist = (heavy ? 74 : 46) * DX[s];
    mv.style.transition = 'transform .12s ease-in';
    mv.style.transform = 'translateX(' + dist + 'px)';
    armR(s).classList.add('raise');           // 出手
    later(function () {
      armR(s).className = 'arm aR';
      mv.style.transition = 'transform .22s cubic-bezier(.3,1.7,.4,1)';
      mv.style.transform = '';
    }, 140);
  }
  function koFall(s) {
    var u = unitOf(s);
    var mv = mvOf(s);
    u.classList.add('noidle');
    figOf(s).classList.add('dead');
    shieldEl(s).className = 'shield';
    var dir = -1;   // 内层逆时针旋转; 红方经镜像后表现为顺时针, 双方均向"远离对手"方向倒地
    // 为该座位注入一次性的倒地动画
    var stId = 'koKey' + s;
    if (!document.getElementById(stId)) {
      var st = el('style');
      st.id = stId;
      st.textContent = '@keyframes koFall' + s + '{0%{transform:translateY(0) rotate(0);}' +
        '30%{transform:translateY(-26px) rotate(' + (-3 * dir) + 'deg);}' +
        '60%{transform:translateY(2px) rotate(' + (88 * dir) + 'deg);}' +
        '100%{transform:translateY(8px) rotate(' + (94 * dir) + 'deg);opacity:.98;}}';
      document.head.appendChild(st);
    }
    mv.style.transition = '';
    mv.style.animation = 'koFall' + s + ' .68s ease-in forwards';
    later(function () { fxAt(s, '💫', 12); fxAt(s, '💧', 44); }, 520);
    later(function () { fxBurst(s, 'dust', 50, 78); }, 430);   // 倒地扬尘
    setHeart(s, true);
  }
  function vHop(s) {
    var mv = mvOf(s);
    for (var k = 0; k < 3; k++) {
      (function (k) {
        later(function () {
          if (!G.inMatch) return;
          mv.style.transition = 'transform .16s';
          mv.style.transform = 'translateY(-24px)';
          later(function () { mv.style.transform = ''; }, 170);
        }, k * 260);
      })(k);
    }
  }

  /* ---------- 阶段处理 ---------- */
  function onIntro(st) {
    clearTimers(); stopCountdown(); Sfx.setTension(false);
    resetFighters();
    hideBub(0); hideBub(1);
    var l = $('line'); l.classList.remove('show');
    $('ovFinal').classList.add('hide');
    syncMeta(st);
    setEnergyUI(0); setEnergyUI(1);
    updateLegal();
    var msg = st.msg || '';
    var v = svcMsg(msg);
    if (msg.indexOf('判平') >= 0) {
      bang(tr('⚖️ 判平重开', '⚖️ DRAW — RESTART'), 'smallgold', 1500);
      showLine('<span class="glod">' + v + '</span>');
    } else if (msg.indexOf('第') === 0) {
      bang(isEn() ? 'Set ' + G.setNo : '第 ' + G.setNo + ' 小局', 'gold', 1300);
    } else {
      bang(tr('⚔️ 开 战 ⚔️', '⚔️ FIGHT ⚔️'), 'gold', 1300);
    }
    if (G.mode === 'battle') Sfx.battleStart();
  }
  function onInput(st) {
    clearTimers(); stopCountdown(); Sfx.setTension(false);
    resetInputFX();
    var l = $('line'); l.classList.remove('show');
    syncMeta(st);
    setEnergyUI(0); setEnergyUI(1);
    updateLegal();
    G.sel = null;
    G.picked = [false, false];
    markMyCard();
    showBub(0, '❔', G.ai && G.seat !== 0 ? '' : tr('思考中…', 'thinking…'), 'think');
    showBub(1, '❔', tr('思考中…', 'thinking…'), 'think');
    var dur = 2000;
    G.inputUntil = (st.input && st.input.deadline) ? st.input.deadline : serverNow() + dur;
    startCountdown(dur);
  }
  function resetInputFX() {
    stopCountdown();
    G.tickSec = -1;
    $('timerWrap').classList.add('hide');
    $('timerTxt').classList.add('hide');
    $('turnChip').classList.add('hide');
  }
  function startCountdown(dur) {
    stopCountdown();
    var bar = $('timerBar'), wrap = $('timerWrap'), txt = $('timerTxt');
    wrap.classList.remove('hide', 'hot');
    txt.classList.remove('hide');
    txt.textContent = '2.0';
    var t0 = performance.now();
    G.raf = requestAnimationFrame(function tick() {
      var left = G.inputUntil - serverNow();
      if (left <= 0) {
        bar.style.width = '0%'; txt.textContent = '0.0';
        wrap.classList.add('hot');
        G.raf = requestAnimationFrame(tick);   // 保持到结算
        return;
      }
      var pct = Math.max(0, left / dur * 100);
      bar.style.width = pct + '%';
      var sec = Math.ceil(left / 1000);
      var show = (left / 1000).toFixed(1);
      txt.textContent = show;
      wrap.classList.toggle('hot', left < 700);
      Sfx.setTension(left < 700);
      if (sec !== G.tickSec && sec <= 2 && sec >= 1) {
        G.tickSec = sec; Sfx.play('tick');
      }
      G.raf = requestAnimationFrame(tick);
    });
  }
  function stopCountdown() {
    if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
    Sfx.setTension(false);
  }

  /* ---------- 结算演出 ---------- */
  function onResult(st) {
    clearTimers(); stopCountdown(); Sfx.setTension(false);
    var r = st.result;
    if (!r) return;
    G.result = r;
    G.e = [r.e1, r.e2];
    syncMeta(st);
    setEnergyUI(0); setEnergyUI(1);
    updateLegal();
    resetInputFX();

    var m1 = r.m1, m2 = r.m2;
    var none1 = m1 === core.NONE, none2 = m2 === core.NONE;
    var act1 = core.ACTIONS[m1], act2 = core.ACTIONS[m2];
    var hits = [r.hitP1, r.hitP2];          // 谁被击中
    var loser = hits[0] ? 0 : (hits[1] ? 1 : -1);
    var clash = r.clash;
    var oppBlocked = [false, false];        // 对方挡住了我
    if (!clash && loser < 0) {
      // 攻击 vs 防御 → 被挡
      for (var i = 0; i < 2; i++) {
        var atk = (i === 0) ? m2 : m1;
        var def = (i === 0) ? m1 : m2;
        if (core.ACTIONS[atk] && core.ACTIONS[atk].kind === 'attack' &&
            core.ACTIONS[def] && core.ACTIONS[def].kind === 'block') {
          oppBlocked[i] = true;
        }
      }
    }

    // 头顶对话框: 统一揭示双方选项
    showBub(0, none1 ? '💤' : act1.icon, none1 ? tr('发呆', 'Idle') : actName(m1));
    showBub(1, none2 ? '💤' : act2.icon, none2 ? tr('发呆', 'Idle') : actName(m2));
    if (none1) poseShrug(0);
    if (none2) poseShrug(1);

    // 叙事行
    var line = '';
    line += '<span class="b0">' + (none1 ? '💤 ' + tr('发呆', 'Idle') : act1.icon + ' ' + actName(m1)) + '</span>';
    line += '　╳　';
    line += '<span class="b1">' + (none2 ? '💤 ' + tr('发呆', 'Idle') : act2.icon + ' ' + actName(m2)) + '</span>';
    if (clash) line += ' — <span class="glod">' + tr('⚔️ 攻击相撞 · 无事发生', '⚔️ Clash — nothing happens') + '</span>';
    else if (loser >= 0) line += ' — <span class="b' + loser + '">' + tr('命中! K.O.!', 'Hit! K.O.!') + '</span>';
    else line += ' — ' + tr('无人受伤 · 继续', 'No damage · next round');
    showLine(line);

    // 动作姿势: 攻击者稍后挥出; 防御者先举盾; 蓄力者聚气; 发呆者(已摇头)
    if (core.ACTIONS[m1] && core.ACTIONS[m1].kind !== 'attack') actionBody(0, m1, hits[0] && core.ACTIONS[m2] && core.ACTIONS[m2].kind === 'attack');
    if (core.ACTIONS[m2] && core.ACTIONS[m2].kind !== 'attack') actionBody(1, m2, hits[1] && core.ACTIONS[m1] && core.ACTIONS[m1].kind === 'attack');

    var heavy = [];
    if (act1 && act1.kind === 'attack') heavy[0] = m1 === 'heavy';
    if (act2 && act2.kind === 'attack') heavy[1] = m2 === 'heavy';

    /* 攻击动画时间轴 */
    later(function () {
      if (heavy[0]) { doDash(0, true); Sfx.play('heavy'); fxAt(0, '💥', 30, true); }
      else if (act1 && act1.kind === 'attack') { doDash(0, false); Sfx.play('slash'); }
      if (heavy[1]) { doDash(1, true); Sfx.play('heavy'); fxAt(1, '💥', 30, true); }
      else if (act2 && act2.kind === 'attack') { doDash(1, false); Sfx.play('slash'); }
    }, 140);

    /* 相撞: 火花 */
    if (clash) {
      later(function () {
        Sfx.play('clash');
        fxAt(0, '💫', 40); fxAt(1, '💫', 40);
        shakeStage();
        bang(tr('⚔️ 攻击相撞', '⚔️ CLASH'), 'small', 1000);
      }, 300);
      return;
    }
    /* 被挡 / 命中 */
    later(function () {
      if (hits[0] || hits[1]) {
        Sfx.play('hit'); shakeStage();
        var victim = hits[0] ? 0 : 1;
        var heavyHit = (victim === 0 ? act2 : act1) === core.ACTIONS.heavy;
        later(function () {
          fxAt(victim, heavyHit ? '💥' : '💢', 34, heavyHit);
          fxBurst(victim, 'hit', 50, 34);
        }, 40);
      }
      else if (oppBlocked[0] || oppBlocked[1]) {
        // 攻击打上防御: 格挡音效 + 盾面火花粒子爆发
        var heavyBlocked = (oppBlocked[0] && m2 === 'heavy') || (oppBlocked[1] && m1 === 'heavy');
        Sfx.play(heavyBlocked ? 'blockHeavy' : 'clank');
        if (heavyBlocked) shakeStage();
        var tBlock = function (seat) {
          shieldEl(seat).classList.add('hitflash');
          setTimeout(function () { shieldEl(seat).classList.remove('hitflash'); }, 340);
          fxBurst(seat, 'spark', 52, 46);
          fxAt(seat, '✦', 30);
        };
        if (oppBlocked[0]) tBlock(0);
        if (oppBlocked[1]) tBlock(1);
      }
    }, 300);

    if (loser >= 0) {
      later(function () {
        bang('K.O.!', '', 1500);
        Sfx.play('ko');
        koFall(loser);
        var winner = 1 - loser;
        setHeart(loser, true);
        later(function () { vHop(winner); Sfx.play('setSting'); }, 800);
      }, 560);
    }
  }

  function onOver(st) {
    clearTimers(); stopCountdown(); Sfx.setTension(false);
    G.over = st.over;
    syncMeta(st);
    Sfx.battleStop();   // 先停战斗鼓点, 再播整场胜负音乐
    var o = st.over;
    var me = G.seat;
    var iWin = o.winner === me;
    later(function () { Sfx.play(iWin ? 'win' : 'lose'); }, 250);  // 胜者: 胜利音乐 / 败者: 失败音乐
    $('finalBig').textContent = (iWin ? tr('🏆 你赢了!', '🏆 YOU WIN!') : tr('你输了', 'You lose')) + (G.ai && !iWin ? ' 🤖' : '');
    $('finalBig').style.color = iWin ? '#f7c948' : '#ff9aab';
    $('finalCards').innerHTML = '';
    for (var s = 0; s < 2; s++) {
      var nm = G.ai ? NAMES[s] : (isEn() ? (s === 0 ? 'Blue Player' : 'Red Player') : (s === 0 ? '蓝方玩家' : '红方玩家'));
      var c = el('div', 'fcard' + (o.winner === s ? ' win' : ''));
      c.innerHTML = '<div class="who">' + nm + '</div>' +
        '<div class="wins">' + G.score[s] + ' ' + tr('小局', 'sets') + (o.winner === s ? (isEn() ? ' · WINNER' : ' · 胜者') : '') + '</div>';
      $('finalCards').appendChild(c);
    }
    var m = 'BO3 · ' + tr('大比分 ', 'score ') + G.score[0] + ' : ' + G.score[1];
    m += ' · ' + tr('共 ', 'total ') + (st.stats ? st.stats.turns : 0) + ' ' + tr('回合', 'turns');
    if (st.stats && st.stats.voids) m += ' · ' + tr('判平重开 ', 'draw restarts ') + st.stats.voids + ' ' + tr('次', 'times');
    $('finalSub').textContent = m;
    updateWait(G.over);
    $('ovFinal').classList.remove('hide');
  }
  function updateWait(o) {
    var both = o && o.rematch && o.rematch[0] && o.rematch[1];
    var meReady = o && o.rematch && o.rematch[G.seat];
    $('finalWait').textContent = both ? '' : (meReady ? tr('已发送请求，等待对手点击“再来一局”…', 'Request sent — waiting for your opponent to hit Rematch…') : (G.ai ? '' : ''));
  }

  /* ================= 交互: 选招 ================= */
  function tryPick(idx) {
    if (G.phase !== 'input') { toast(tr('现在不能出招', 'Cannot act right now')); return; }
    var my = G.seat;
    var id = core.IDS[idx];
    if (core.ACTIONS[id].cost > G.e[my]) { toast(tr('⛔ 能量不足: 先蓄力攒能量!', '⛔ Not enough energy — charge first!')); Sfx.play('deny'); return; }
    G.sel = idx;
    markMyCard();
    var b = $('cards').children[idx];
    b.classList.remove('glow'); void b.offsetWidth; b.classList.add('glow');
    Sfx.play('pick');
    showBub(my, '🔒', tr('已出招', 'Locked!'));
    var other = 1 - my;
    if (G.ai) {
      if (G.aiPicked) setPickUI();                 // 电脑也已锁定
      else showBub(other, '❔', tr('思考中…', 'thinking…'), 'think');
    } else {
      post('pick', { token: G.token, move: id }).then(function (r) {
        if (r && !r.ok) {
          toast(r.err === 'energy' ? tr('⛔ 能量不足', '⛔ Not enough energy') : tr('出招失败', 'Move failed'));
          G.sel = null; markMyCard();
          showBub(my, '❔', tr('思考中…', 'thinking…'), 'think');
        }
      }).catch(function () { });
    }
  }
  function setPickUI() {
    if (!G.ai) return;               // 联机模式下由服务器事件流驱动
    if (G.sel !== null) showBub(0, '🔒', tr('已出招', 'Locked!'));
    else showBub(0, '❔', tr('思考中…', 'thinking…'), 'think');
    showBub(1, '🔒', tr('已出招', 'Locked!'));   // 电脑锁定(内容不泄露)
  }

  function onKey(ev) {
    if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // 改键中
    if (G.bindRow >= 0) {
      ev.preventDefault();
      if (ev.code === 'Escape') { cancelBind(); return; }
      assignKey(G.bindRow, ev.code);
      return;
    }
    if (G.mode === 'battle' && G.phase === 'input') {
      var my = G.seat;
      if (my < 0) return;
      var idx = G.keys[my].indexOf(ev.code);
      if (idx >= 0) {
        ev.preventDefault();
        tryPick(idx);
      }
    }
  }

  /* ================= 改键界面 ================= */
  function renderKeysList() {
    if (G.seat < 0) return;
    var wrap = $('keysList');
    wrap.innerHTML = '';
    core.IDS.forEach(function (id, i) {
      var a = core.ACTIONS[id];
      var row = el('div', 'bindrow');
      row.dataset.i = i;
      row.innerHTML =
        '<span class="ico">' + a.icon + '</span>' +
        '<span class="nm">' + actName(id) + '</span>' +
        '<span class="cost">' + (a.gain ? tr('蓄力 +1', 'Gain +1') : tr('消耗 ' + a.cost, 'Cost ' + a.cost)) + '</span>' +
        '<kbd class="kc">' + keyLabel(G.keys[G.seat][i]) + '</kbd>' +
        '<button class="bk">' + tr('改键', 'Edit') + '</button>';
      row.querySelector('.bk').addEventListener('click', function (e) {
        e.stopPropagation();
        startBind(i);
      });
      wrap.appendChild(row);
    });
  }
  function startBind(i) {
    clearWarns();
    G.bindRow = i;
    renderKeysList();
    var rows = $('keysList').children;
    rows[i].classList.add('pending');
    rows[i].querySelector('.nm').innerHTML += ' <span class="hintkey">← ' + tr('按新键 (Esc 取消)', 'press new key (Esc cancels)') + '</span>';
    blurFocus();
  }
  function cancelBind() {
    G.bindRow = -1;
    renderKeysList();
  }
  function clearWarns() {
    var rows = $('keysList').children;
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('warn', 'pending');
  }
  function assignKey(i, code) {
    var my = G.seat;
    if (i < 0 || i > 4) { cancelBind(); return; }
    var dup = G.keys[my].indexOf(code);
    if (dup >= 0 && dup !== i) {
      // 冲突: 两个动作不能同一键
      renderKeysList();
      var rows = $('keysList').children;
      rows[dup].classList.add('warn');
      rows[i].classList.add('warn');
      rows[dup].querySelector('.nm').innerHTML += ' <span class="err">' + tr('与上冲突', 'conflicts above') + '</span>';
      rows[i].querySelector('.nm').innerHTML += ' <span class="err">' + tr('冲突!', 'CONFLICT!') + '</span>';
      G.bindRow = -1;
      toast(tr('这个键已被使用, 请换一个', 'Key already in use — pick another'));
      return;
    }
    G.keys[my][i] = code;
    saveKeys();
    G.bindRow = -1;
    renderKeysList();
    toast(tr('已绑定: ', 'Bound: ') + keyLabel(code));
  }

  /* ================= 大厅按钮状态 ================= */
  function updateReadyBtn() {
    var b = $('btnReady');
    if (G.mode !== 'lobby') return;
    // 简单起见: 大厅状态行已给出提示, 这里只需显示文本
  }
  function clickReady() {
    if (G.seat < 0) return;
    post('ready', { token: G.token, ready: true }).then(function (r) {
      if (!r.ok) toast(tr('无法准备', 'Cannot set ready'));
    }).catch(function () { lostNet('连接中断'); });
  }

  /* ================= 规则 ================= */
  /** 规则面板内容(中英双语, 动作名用新称谓: 挥砍/重击/格挡/举盾) */
  function actionRow(id) {
    var a = core.ACTIONS[id], t = isEn() ? ACT_TXT[id].en : ACT_TXT[id].zh;
    return '<tr><td><b>' + a.icon + ' ' + t.n + '</b></td><td>' + t.t + '</td></tr>';
  }
  function rulesHtml() {
    var E = isEn();
    if (E) {
      return '<h2 style="text-align:center;margin-top:2px;">Rules &amp; How to Play</h2>' +
        '<h3>◈ Core rules</h3>' +
        '<p style="margin:2px 0">Every round both players pick <u>simultaneously and secretly</u> within <b>2 seconds</b>. Each starts with 1 HP and 0 energy. ' +
        'Charge gives +1 energy (no cap, resets when a set ends). An unblocked attack hits = K.O. — that player loses the set. Whole match is <b>BO3</b>: first to win 2 sets wins.</p>' +
        '<h3>◈ Actions</h3>' +
        '<table>' + core.IDS.map(actionRow).join('') + '</table>' +
        '<p class="dim">Both attack at once? <b>Same tier</b> (Slash vs Slash / Smash vs Smash) clashes — nothing happens (energy still spent). ' +
        '<b>Smash vs Slash: the Slash side gets knocked out</b> (Block cannot stop Smash).</p>' +
        '<h3>◈ Playing online</h3>' +
        '<p style="margin:2px 0">The host double-clicks <code>启动联机.command</code> (Mac) / <code>启动联机.bat</code> (Windows) to start the server (browser opens automatically). ' +
        'Both computers (or phones) on the <b>same network</b> open the page: one clicks Online Battle to host, the other joins. Set your own keys in the <b>ready room</b>, both hit Ready to start.</p>' +
        '<p class="dim">Each screen only shows <b>your own</b> 5 cards and keys — the opponent&#39;s choice stays hidden. After the timer, both moves are revealed via <b>head bubbles</b> and character actions. No move in time = <b>Idle</b>: no energy, no defense — you can be hit.</p>' +
        '<h3>◈ Extras</h3>' +
        '<p class="dim">1) No KO after 40 turns in a set → draw, set restarts. 2) Battle BGM is synthesized tension drums (toggle with ♪).</p>' +
        '<button class="linkbtn" id="btnRulesClose">Close</button>';
    }
    return '<h2 style="text-align:center;margin-top:2px;">规则 &amp; 操作</h2>' +
      '<h3>◈ 核心规则</h3>' +
      '<p style="margin:2px 0">每回合双方<u>同时、秘密</u>出招, 时限 <b>2 秒</b>。各 1 滴血、0 能量开局; ' +
      '蓄力 +1 能量(无上限, 小局结束清零)。攻击未被挡下 = 命中 = K.O., 输掉本小局; 整场 <b>BO3</b>, 先赢 2 小局者胜。</p>' +
      '<h3>◈ 动作表</h3>' +
      '<table>' + core.IDS.map(actionRow).join('') + '</table>' +
      '<p class="dim">双方同时出攻击: <b>同级</b>(挥砍vs挥砍 / 重击vs重击)相撞抵消、无事发生(能量照耗); ' +
      '<b>重击 vs 挥砍 → 重击直接压过, 出挥砍的一方被斩杀 K.O.</b>(格挡挡不住重击)。</p>' +
      '<h3>◈ 联机流程</h3>' +
      '<p style="margin:2px 0">房主先双击项目里的 <code>启动联机.command</code>(Mac)/ <code>启动联机.bat</code>(Windows) 启动服务器(会自动打开浏览器); 两台电脑(或手机)在<b>同一网络</b>下打开网页: ' +
      '一人点“联机对战”建房, 另一人同样点“联机对战”加入。双方在<b>准备界面</b>把 5 个动作改成自己顺手的按键, 都点准备后开战。</p>' +
      '<p class="dim">联机后每台电脑只显示<b>自己</b>的 5 张卡片与按键(对方选项看不到)。' +
      '出招窗口结束双方统一揭示 —— 对方选项通过<b>头顶对话框</b>和小人动作(格挡/举盾/蓄力/发呆)区分。' +
      '超时未出招 = 发呆: 不获能量、无法防御, 会被打。</p>' +
      '<h3>◈ 补充设定</h3>' +
      '<p class="dim">① 单小局超过 40 回合无人阵亡 → 判平重开; ② 对局 BGM 为程序实时合成的紧张鼓点(默认开, 点 ♪ 可关)。</p>' +
      '<button class="linkbtn" id="btnRulesClose">' + (E ? 'Close' : '关闭') + '</button>';
  }
  function rebuildRules() {
    var c = $('rulesCard');
    c.innerHTML = rulesHtml();
    c.querySelector('#btnRulesClose').addEventListener('click', closeRules);
  }

  function openRules() {
    var c = $('rulesCard');
    if (!c.innerHTML) { rebuildRules(); }
    $('ovRules').classList.remove('hide');
    blurFocus();
  }
  function closeRules() { $('ovRules').classList.add('hide'); }

  /* ================= 结束面板 ================= */
  function clickAgain() {
    if (G.ai) { aiAgain(); return; }
    if (G.net && G.over) {
      var meReady = G.over.rematch[G.seat];
      post('rematch', { token: G.token, want: !meReady }).then(function (r) {
        if (r.ok) refreshState();
      }).catch(function () { lostNet('连接中断'); });
    }
  }

  /* ================= 画面素材(可选: 素材/p0.png、p1.png…) ================= */
  function tryAssets() {
    var cand = ['png', 'svg', 'webp', 'gif', 'jpg', 'jpeg'];
    for (var s = 0; s < 2; s++) {
      (function (s) {
        var fig = $('fig' + s), img = fig.querySelector('img.art');
        for (var i = 0; i < cand.length; i++) {
          var path = '素材/p' + s + '.' + cand[i];
          var probe = new Image();
          probe.onload = function () {
            fig.classList.add('hasimg');
            img.src = this.src;
          };
          probe.onerror = function () { };
          probe.src = path;
        }
      })(s);
    }
  }

  /** 战斗背景照片(可选: 素材/bg.jpg|png|webp|jpeg): 全屏 cover 自适应, 加载成功才启用 */
  function tryBg() {
    var cand = ['jpg', 'jpeg', 'png', 'webp'];
    for (var i = 0; i < cand.length; i++) {
      (function (i) {
        var path = '素材/bg.' + cand[i];
        var probe = new Image();
        probe.onload = function () {
          var stage = $('stage');
          stage.style.backgroundImage = "url('" + path + "')";
          stage.style.backgroundSize = 'cover';
          stage.style.backgroundPosition = 'center center';
          stage.classList.add('photo');   // 关闭程序化星月/地面, 打开暗化层
        };
        probe.onerror = function () { };
        probe.src = path;
      })(i);
    }
  }

  /** 主菜单照片按键配置(单位 %): 中心坐标与碰撞箱尺寸按照片实际按钮单独设定。
   *  新换主界面图时改这里即可(OCR 可得到文字框, 碰撞箱一般取文字框外扩)。 */
  /* Start Game: 恢复第一版大小(≈397×101px @1280×800); 下面三项统一大小且位置贴图上文字中心 */
  var MENU_SPOTS = [
    { id: 'btnNet',     name: 'Start Game', cx: 50.0, cy: 49.9, w: 31, h: 10.5 },
    { id: 'btnRules1',  name: 'Rules',      cx: 50.0, cy: 59.5, w: 24, h: 7.5 },
    { id: 'btnAI',      name: 'Practice',   cx: 50.0, cy: 68.2, w: 24, h: 7.5 },
    { id: 'btnQuitApp', name: 'Quit',       cx: 50.0, cy: 77.5, w: 24, h: 7.5 }
  ];
  function buildMenuButtons() {
    var map = $('menuMap');
    if (!map || map.childElementCount) return;
    MENU_SPOTS.forEach(function (sp) {
      var b = el('button', 'mapbtn');
      b.id = sp.id;
      b.title = sp.name;
      b.setAttribute('aria-label', sp.name);
      b.style.left = (sp.cx - sp.w / 2).toFixed(2) + '%';
      b.style.top = (sp.cy - sp.h / 2).toFixed(2) + '%';
      b.style.width = sp.w + '%';
      b.style.height = sp.h + '%';
      map.appendChild(b);
    });
  }

  /** 主菜单照片(素材/menu.jpg|png|webp) + 热区映射层尺寸(与 cover 裁剪严格同步) */
  function layoutMenuBox() {
    var map = $('menuMap');
    if (!map || !G.menuImg) return;
    var W = G.menuImg.naturalWidth, H = G.menuImg.naturalHeight;
    if (!W || !H) return;
    var sc = Math.max(innerWidth / W, innerHeight / H);
    map.style.width = Math.round(W * sc) + 'px';
    map.style.height = Math.round(H * sc) + 'px';
  }
  function tryMenuBg() {
    var cand = ['jpg', 'jpeg', 'png', 'webp'];
    var applied = false;
    for (var i = 0; i < cand.length; i++) {
      (function (i) {
        var path = '素材/menu.' + cand[i];
        var probe = new Image();
        probe.onload = function () {
          if (applied) return;
          applied = true;
          G.menuImg = this;
          $('viewMenu').classList.add('hasphoto');
          $('menuPhoto').style.backgroundImage = "url('" + path + "')";
          layoutMenuBox();
          window.addEventListener('resize', layoutMenuBox);
        };
        probe.onerror = function () { };
        probe.src = path;
      })(i);
    }
  }

  /* ================= 初始化 ================= */
  function init() {
    G.keys = loadKeys();
    buildMenuButtons();   // 先按照片生成主菜单热区, 下面 forEach 才会绑上事件
    ['btnNet', 'btnAI', 'btnRules1', 'btnRules2', 'btnRules3', 'btnSnd1', 'btnSnd2',
     'btnReady', 'btnLeave', 'btnQuit', 'btnQuitYes', 'btnQuitNo', 'btnLostRetry', 'btnLostMenu',
     'btnAgain', 'btnMenu', 'btnKick', 'btnKickYes', 'btnKickNo', 'kick0', 'kick1',
     'btnCredits', 'btnQuitApp'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      var map = {
        btnNet: clickNet, btnAI: clickAI,
        btnRules1: openRules, btnRules2: openRules, btnRules3: openRules,
        btnReady: clickReady, btnLeave: function () { doLeave(); },
        btnQuit: openQuit, btnQuitYes: function () { $('ovQuit').classList.add('hide'); doLeave(); },
        btnQuitNo: function () { $('ovQuit').classList.add('hide'); },
        btnLostRetry: function () { hideLost(); if (G.net) { polling = true; startPoll(); refreshState(); } },
        btnLostMenu: function () { doLeave(); },
        btnAgain: clickAgain, btnMenu: function () { doLeave(); },
        btnKick: askKick,
        btnKickYes: doKick, btnKickNo: function () { $('ovKick').classList.add('hide'); },
        kick0: askKick, kick1: askKick,
        btnCredits: function () { toast(isEn() ? '⚔️ Mindstrike — 2-player PVP guess-and-strike duel · BO3' : '⚔️ Mindstrike · 心战 — 双人 PVP 猜招对决 · BO3'); },
        btnQuitApp: function () {
          try { window.close(); } catch (e) { /* 忽略 */ }
          setTimeout(function () { toast(tr('浏览器不允许网页自动关闭, 请直接关闭标签页', 'Browsers block auto-close — please close the tab manually')); }, 250);
        }
      };
      b.addEventListener('click', function (ev) {
        if (id.indexOf('btnSnd') === 0) { Sfx.setMaster(!Sfx.isMaster()); return; }
        Sfx.ensureCtx();
        if (map[id]) map[id](ev);
      });
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', function () {
      Sfx.ensureCtx();
      if (G.mode === 'menu' && Sfx.isMaster()) Sfx.startMenuMusic();  // 浏览器自动播放策略: 首次交互后再试
    });
    document.addEventListener('keydown', function () {
      Sfx.ensureCtx();
      if (G.mode === 'menu' && Sfx.isMaster()) Sfx.startMenuMusic();
    });
    window.addEventListener('beforeunload', function () { if (G.net && G.token) navigator.sendBeacon('/api/leave', JSON.stringify({ token: G.token })); });

    Sfx.onLabel(function () { syncSoundLabels(); });
    renderSndBtns();
    tryAssets();
    tryBg();
    tryMenuBg();
    syncNetTip();
    $('btnNet').disabled = isFile;
    var lb = $('btnLang');
    if (lb) lb.addEventListener('click', function () { setLang(isEn() ? 'zh' : 'en'); });
    applyLang();
    showMenu();
  }
  function renderSndBtns() { syncSoundLabels(); }
  function openQuit() {
    $('ovQuit').classList.remove('hide');
    blurFocus();
  }

  init();
})();

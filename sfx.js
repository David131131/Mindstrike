/**
 * Mindstrike(心战) — 声音引擎(纯 WebAudio, 无任何外部素材依赖)
 *
 *  - 主菜单音乐: 复用 index.html 里的 <video src="音效/游戏初始背景音乐.mp4">,
 *    仅主菜单页循环播放(浏览器要求先有用户手势)。
 *  - 对局 BGM: WebAudio 实时编排的紧张鼓点循环(150 BPM 底鼓 + 军鼓 + 踩镲 +
 *    贝斯), 出招窗口最后 0.7 秒自动提速加码(tension), 烘托对局节奏。
 *  - 音效: 出招/命中/格挡/相撞/K.O./小局/整场胜负 等提示音。
 *  - 总开关记忆在 localStorage(ms.master)。
 *
 * 后续想替换对局 BGM 为真实音频文件: 在 battleStart() 里换成 <audio> 循环即可
 * (提示: 文件应放 音效/ 目录并由 server.js 一并托管)。
 */
(function () {
  'use strict';

  var KEY = 'ms.master';
  var master = localStorage.getItem(KEY) !== '0';   // 默认开
  var ctx = null;
  var masterGain = null, sfxGain = null, musGain = null, endGain = null;

  var noiseBuf = null;
  var menuVid = null;      // <video> 主菜单音乐
  var menuPlaying = false;

  /* ---------- 基础 ---------- */
  function ensureCtx() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(function () { }); return ctx; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = master ? 0.9 : 0;
      sfxGain = ctx.createGain(); sfxGain.gain.value = 1;
      musGain = ctx.createGain(); musGain.gain.value = 1;
      endGain = ctx.createGain(); endGain.gain.value = 1;   // 整场胜负音乐独立通道(可随时淡出切断)
      masterGain.connect(ctx.destination);
      sfxGain.connect(masterGain);
      musGain.connect(masterGain);
      endGain.connect(masterGain);
      noiseBuf = null;
      return ctx;
    } catch (e) { return null; }
  }
  function noise() {
    if (!noiseBuf) {
      var c = ensureCtx(); if (!c) return null;
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  function tick(ms) { return ctx.currentTime + ms / 1000; }

  /** 短包络: f(g, t, peak, attack, decay) */
  function env(g, t, peak, a, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  function osc(type, t, freq, dur, peak, dest) {
    var c = ensureCtx(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    env(g, t, peak, 0.005, dur);
    o.connect(g); g.connect(dest || sfxGain);
    o.start(t); o.stop(t + dur + 0.06);
    return o;
  }
  function noiseHit(t, dur, peak, filterType, freq, q, dest) {
    var c = ensureCtx(); if (!c || !noise()) return;
    var src = c.createBufferSource(); src.buffer = noise();
    var f = c.createBiquadFilter(); f.type = filterType || 'bandpass';
    f.frequency.value = freq || 2000; f.Q.value = q || 1;
    var g = c.createGain();
    env(g, t, peak, 0.003, dur);
    src.connect(f); f.connect(g); g.connect(dest || sfxGain);
    src.start(t); src.stop(t + dur + 0.06);
  }
  function sweep(type, t0, f0, f1, dur, peak) {
    var c = ensureCtx(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    env(g, t0, peak, 0.005, dur);
    o.connect(g); g.connect(sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.08);
  }

  /* ================= 音效 ================= */
  var SFX = {
    ui: function () { var t = tick(0); osc('sine', t, 700, 0.05, 0.06); },
    pick: function () { var t = tick(0); osc('sine', t, 660, 0.07, 0.14); osc('sine', t + 0.05, 990, 0.09, 0.12); },
    deny: function () { var t = tick(0); osc('square', t, 190, 0.1, 0.12); osc('square', t + 0.09, 150, 0.12, 0.12); },
    tick: function () { var t = tick(0); osc('square', t, 1500, 0.035, 0.07); },
    charge: function () { sweep('sawtooth', tick(0), 180, 900, 0.16, 0.12); sweep('sine', tick(0), 900, 1600, 0.14, 0.07); },
    slash: function () { noiseHit(tick(0), 0.1, 0.2, 'bandpass', 3600, 2); },
    heavy: function () { noiseHit(tick(0), 0.22, 0.26, 'lowpass', 900, 1); sweep('sine', tick(0), 300, 70, 0.18, 0.24); },
    guardup: function () { noiseHit(tick(0), 0.12, 0.1, 'highpass', 2400, 1); },
    clank: function () {
      var t = tick(0);
      osc('square', t, 2100, 0.08, 0.1); osc('square', t, 1500, 0.12, 0.09);
      noiseHit(t, 0.09, 0.14, 'bandpass', 5200, 3);
    },
    clash: function () {
      var t = tick(0);
      noiseHit(t, 0.32, 0.32, 'bandpass', 3000, 0.7);
      sweep('sawtooth', t, 900, 120, 0.28, 0.18);
      osc('sine', t, 120, 0.22, 0.3);
    },
    hit: function () {
      var t = tick(0);
      sweep('sine', t, 140, 36, 0.3, 0.5);
      noiseHit(t, 0.22, 0.4, 'lowpass', 1400, 0.8);
      noiseHit(t + 0.02, 0.12, 0.18, 'highpass', 3000, 1);
    },
    ko: function () {
      var t = tick(0);
      sweep('sine', t, 120, 30, 0.7, 0.6);
      sweep('sawtooth', t + 0.05, 700, 90, 0.5, 0.2);
      noiseHit(t, 0.5, 0.4, 'lowpass', 900, 1);
      noiseHit(t + 0.18, 0.3, 0.15, 'highpass', 2000, 1);
    },
    setSting: function () {
      var t = tick(0), notes = [523, 659, 784];
      for (var i = 0; i < 3; i++) osc('triangle', t + i * 0.09, notes[i], 0.14, 0.12);
    },
    blockHeavy: function () {
      var t = tick(0);
      noiseHit(t, 0.2, 0.24, 'bandpass', 1100, 0.8);
      osc('square', t, 640, 0.12, 0.09);
      osc('square', t, 460, 0.16, 0.08);
      sweep('sine', t, 160, 60, 0.22, 0.28);
    },
    win: function () { playEndMusic('win'); },   // 胜利动画音乐(本机胜者)
    lose: function () { playEndMusic('lose'); }, // 失败动画音乐(本机败者)
    void_: function () { sweep('triangle', tick(0), 400, 240, 0.25, 0.1); },
    emoji: function () {   // 表情点击/弹出音
      var t = tick(0);
      osc('sine', t, 700, 0.06, 0.13);
      osc('sine', t + 0.05, 1050, 0.09, 0.11);
      osc('triangle', t + 0.1, 1568, 0.07, 0.06);
    },
    broken: function () { var t = tick(0); osc('square', t, 320, 0.1, 0.1); osc('square', t + 0.12, 200, 0.16, 0.1); }
  };

  /* ================= 整场胜负音乐(纯合成创作) =================
   * 胜者电脑播 "胜利凯旋号角"(明亮大调 + 定音鼓 + 琶音烟花);
   * 败者电脑播 "落幕挽歌"(小调下行 + 柔和长音)。
   * 独立走 endGain 通道: 对局/返回菜单/关声音时立即淡出切断。
   */
  function armEnd() {
    if (!ctx || !endGain) return;
    try {
      var t = ctx.currentTime;
      endGain.gain.cancelScheduledValues(t);
      endGain.gain.setValueAtTime(1, t);
    } catch (e) { /* 忽略 */ }
  }
  function killEnd() {
    if (!ctx || !endGain) return;
    try {
      endGain.gain.cancelScheduledValues(ctx.currentTime);
      endGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.06);
    } catch (e) { /* 忽略 */ }
  }
  function note(type, t, freq, dur, peak) {
    var c = ensureCtx(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    env(g, t, peak, 0.012, dur);
    o.connect(g); g.connect(endGain);
    o.start(t); o.stop(t + dur + 0.12);
  }
  function pad(t, freqs, dur, peak) {
    for (var i = 0; i < freqs.length; i++) note('triangle', t, freqs[i], dur, peak / freqs.length * 2);
  }
  function playEndMusic(kind) {
    var c = ensureCtx(); if (!c || !master) return;
    armEnd();
    var t0 = c.currentTime + 0.06;

    if (kind === 'win') {
      /* —— 胜利凯旋号角(约 6 秒): C 大调, 号角 + 定音鼓 + 终幕琶音 —— */
      // 定音鼓
      var kk = function (tt) { osc('sine', tt, 150, 0.3, 0.34, endGain); osc('sine', tt + 0.02, 76, 0.36, 0.3, endGain); };
      kk(t0); kk(t0 + 1.6); kk(t0 + 2.8); kk(t0 + 4.0);
      // 和弦垫 C → F → G → C
      pad(t0, [261.6, 329.6, 392.0], 1.5, 0.17);
      pad(t0 + 1.6, [349.2, 440.0, 523.3], 1.2, 0.15);
      pad(t0 + 2.8, [392.0, 493.9, 587.3], 1.2, 0.15);
      pad(t0 + 4.0, [523.3, 659.3, 784.0], 2.4, 0.2);
      osc('sine', t0 + 4.0, 130.8, 2.4, 0.22, endGain);
      // 主旋律(号角感: 锯齿+三角同度)
      var horn = function (tt, f, d) { note('sawtooth', tt, f, d, 0.075); note('triangle', tt, f, d, 0.05); };
      horn(t0, 523.3, 0.26); horn(t0 + 0.3, 659.3, 0.26); horn(t0 + 0.6, 784.0, 0.3);
      horn(t0 + 0.95, 659.3, 0.24); horn(t0 + 1.25, 523.3, 0.3);
      horn(t0 + 1.6, 698.5, 0.3); horn(t0 + 2.0, 523.3, 0.24); horn(t0 + 2.3, 659.3, 0.3);
      horn(t0 + 2.8, 587.3, 0.24); horn(t0 + 3.1, 493.9, 0.24); horn(t0 + 3.4, 587.3, 0.22); horn(t0 + 3.7, 784.0, 0.26);
      // 终幕: 上行琶音烟花 + 长音
      note('triangle', t0 + 4.1, 1046.5, 0.3, 0.12);
      note('triangle', t0 + 4.35, 1318.5, 0.3, 0.12);
      note('triangle', t0 + 4.6, 1568.0, 0.3, 0.11);
      horn(t0 + 4.9, 1046.5, 1.0);
      noiseHit(t0 + 4.1, 0.4, 0.04, 'highpass', 7000, 1, endGain);
    } else {
      /* —— 落幕挽歌(约 8.5 秒): A 小调, 下行叹息 + 柔和长音 —— */
      pad(t0, [220.0, 261.6, 329.6], 3.0, 0.1);        // Am
      pad(t0 + 3.0, [174.6, 220.0, 261.6], 2.6, 0.085); // F
      pad(t0 + 5.6, [164.8, 196.0, 246.9], 2.0, 0.08);  // Em/G
      pad(t0 + 7.6, [110.0, 220.0, 329.6], 2.4, 0.12);  // 收尾低音 Am
      // 叹息式下行旋律(钟琴般的三角波 + 泛音)
      var bell = function (tt, f, d) {
        note('triangle', tt, f, d, 0.1);
        note('sine', tt + 0.01, f * 2, Math.min(d, 0.5), 0.022);
      };
      bell(t0 + 0.12, 659.3, 0.55); bell(t0 + 0.9, 523.3, 0.55);
      bell(t0 + 1.7, 440.0, 0.6); bell(t0 + 2.5, 329.6, 0.7);
      bell(t0 + 3.3, 261.6, 0.7); bell(t0 + 4.1, 220.0, 0.9);
      bell(t0 + 4.9, 329.6, 0.5); bell(t0 + 5.6, 293.7, 0.55);
      bell(t0 + 6.4, 246.9, 0.6); bell(t0 + 7.2, 220.0, 1.4);
    }
  }

  /* ================= 对局 BGM(紧张循环) ================= */
  var BGM = {
    running: false, timer: 0,
    tension: false,           // 出招窗口末段 → 提速
    step: 0, nextT: 0,
    BASE_BPM: 150, FAST_BPM: 188,
    secPerStep: 0.2,
    stop: function () { BGM.running = false; if (BGM.timer) clearInterval(BGM.timer); BGM.timer = 0; },
    start: function () {
      var c = ensureCtx(); if (!c || BGM.running) return;
      BGM.running = true;
      BGM.step = 0; BGM.nextT = c.currentTime + 0.06;
      BGM.timer = setInterval(BGM.loop, 80);
    },
    loop: function () {
      var c = ctx; if (!c || !BGM.running) return;
      var bpm = BGM.tension ? BGM.FAST_BPM : BGM.BASE_BPM;
      var spb = 60 / bpm;               // 每拍(四分音符)
      var eighth = spb / 2;             // 八分音符步长
      while (BGM.nextT < c.currentTime + 0.28) {
        BGM.schedule(BGM.step, BGM.nextT, spb);
        BGM.step++;
        BGM.nextT += eighth;
      }
    },
    schedule: function (i, t, spb) {
      var p = i % 16;                   // 每 2 小节一个循环(16 个八分音符)
      var g = musGain;
      /* 底鼓: 每拍(强拍) + 结尾附点 */
      if (p % 4 === 0) kick(t, spb * 1.4, 0.55);
      if (BGM.tension && p % 4 === 2) kick(t, spb * 0.9, 0.4);
      if (p % 4 === 3 && p % 8 !== 7 && !BGM.tension) {} // 留白更稳
      /* 军鼓: 2、4 拍 */
      if (p === 4 || p === 12) snare(t, 0.34);
      /* 踩镲: 常规反拍; 紧张时密八分 */
      var hatOn = (BGM.tension && p % 2 === 1) || (!BGM.tension && p % 4 === 2);
      if (hatOn) hat(t, BGM.tension ? 0.05 : 0.028);
      /* 贝斯: 低音脉冲 */
      if (p % 2 === 0) bass(t, 0.2, 0.12);
      /* 紧张段: 上升杂音(倒数呼吸感) */
      if (BGM.tension && p === 0) noiseHit(t, 0.5, 0.045, 'highpass', 500, 0.7, musGain);
    }
  };
  function kick(t, dur, v) {
    var c = ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(44, t + dur);
    env(g, t, 0.85 * v, 0.004, dur);
    o.connect(g); g.connect(musGain);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function snare(t, v) {
    noiseHit(t, 0.16, 0.3 * v, 'bandpass', 1900, 0.8, musGain);
    osc('triangle', t, 210, 0.06, 0.12 * v, musGain);
  }
  function hat(t, v) { noiseHit(t, 0.03, v, 'highpass', 8500, 1, musGain); }
  function bass(t, dur, v) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(55, t);
    env(g, t, 0.16 * v, 0.01, dur);
    o.connect(g); g.connect(musGain);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /* ================= 对外接口 ================= */
  function play(name) {
    if (!master || !ensureCtx()) return;
    var f = SFX[name] || SFX.ui;
    try { f(); } catch (e) { /* 音频失败不影响游戏 */ }
  }
  function setMaster(on) {
    master = !!on;
    localStorage.setItem(KEY, master ? '1' : '0');
    if (ctx && masterGain) masterGain.gain.value = master ? 0.9 : 0;
    if (!master) { BGM.stop(); killEnd(); if (menuVid) { try { menuVid.pause(); } catch (e) { } } }
    emitLabel();
  }
  function isMaster() { return master; }

  function startMenuMusic() {
    menuVid = document.getElementById('bgmVid');
    if (!menuVid) return;
    try {
      if (master) {
        var p = menuVid.play();
        if (p) p.catch(function () { });
        menuPlaying = true;
      }
    } catch (e) { /* 忽略 */ }
  }
  function stopMenuMusic() {
    if (menuVid) { try { menuVid.pause(); } catch (e) { } }
    menuPlaying = false;
  }
  function syncMenuVid() {
    if (!menuVid) return;
    try { menuVid.muted = !master; if (master && !menuVid.paused && menuVid.readyState > 1) return; } catch (e) { }
  }
  function battleStart() { ensureCtx(); killEnd(); BGM.stop(); BGM.tension = false; BGM.start(); }
  function battleStop() { BGM.stop(); BGM.tension = false; killEnd(); }
  function setTension(on) { BGM.tension = !!on; }

  var labelCbs = [];
  function onLabel(cb) { labelCbs.push(cb); }
  function emitLabel() { for (var i = 0; i < labelCbs.length; i++) labelCbs[i](master); }

  window.MindSfx = {
    play: play,
    ensureCtx: ensureCtx,
    setMaster: setMaster,
    isMaster: isMaster,
    startMenuMusic: startMenuMusic,
    stopMenuMusic: stopMenuMusic,
    battleStart: battleStart,
    battleStop: battleStop,
    setTension: setTension,
    onLabel: onLabel
  };
})();

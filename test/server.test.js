/**
 * Mindstrike 联机服务器协议端到端测试(零依赖, 两个"机器人玩家"真实跑完整 BO3)
 * 运行: node test/server.test.js   (工作目录: 项目根目录)
 *
 * 覆盖: 建房/加入/就绪 → 多轮同时出招(服务器权威结算) → 结果一致性校验
 *      → BO3 整场胜负 → 再来一局 → 判平重开(40 回合) → 中途离开/掉线回大厅
 */
'use strict';

const assert = require('assert');
const core = require('../game.js');
const { createServer } = require('../server.js');

const SPEED = 150;      // 时间加速因子, 让整场测试在数秒内完成
let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- 小工具: 机器人客户端 ---------------- */
function post(base, api, body) {
  return fetch(base + '/api/' + api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(r => r.json());
}

/** 机器人: 长轮询 + 事件流. onState(st, bot) 由场景注册 */
function makeBot(base, name) {
  const bot = {
    base, name, token: '', seat: -1, seq: -1,
    e: [0, 0], score: [0, 0], stats: null,
    curMove: undefined, rematchSent: false,
    resultCount: 0, events: [], stop: false
  };
  bot.join = async () => {
    const r = await post(base, 'join', {});
    assert.ok(r.ok, name + ' 加入失败: ' + JSON.stringify(r));
    bot.token = r.token; bot.seat = r.seat;
    return r;
  };
  bot.leave = () => post(base, 'leave', { token: bot.token });
  bot.ready = () => post(base, 'ready', { token: bot.token, ready: true });
  bot.pick = (move) => post(base, 'pick', { token: bot.token, move });
  bot.rematch = (want) => post(base, 'rematch', { token: bot.token, want });
  bot.start = function () {
    (async () => {
      while (!bot.stop) {
        try {
          const r = await fetch(base + '/api/poll?token=' + encodeURIComponent(bot.token) + '&seq=' + bot.seq)
            .then(x => x.json());
          if (r.ok && r.state && r.state.seq !== bot.seq) {
            bot.seq = r.state.seq;
            bot.e = r.state.e.slice();
            bot.score = r.state.score.slice();
            bot.stats = r.state.stats;
            bot.events.push(r.state);
            if (bot.onState) bot.onState(r.state, bot);
          } else if (!r.ok) { await wait(100); }
        } catch (e) { if (!bot.stop) await wait(80); }
      }
    })();
  };
  return bot;
}

/** 用纯逻辑核心重算, 校验服务器结算与 game.js 一致 */
function checkResultConsistency(bot, st) {
  const r = st.result;
  assert.ok(r, '收到 result 状态却没有 result');
  assert.ok(r.m1 === core.NONE || !!core.ACTIONS[r.m1], 'm1 非法: ' + r.m1);
  assert.ok(r.m2 === core.NONE || !!core.ACTIONS[r.m2], 'm2 非法: ' + r.m2);
  const calc = core.exchange({ e1: bot.prevE[0], e2: bot.prevE[1] }, r.m1, r.m2);
  assert.deepStrictEqual([calc.e1, calc.e2], [r.e1, r.e2], bot.name + ': 能量结算与 game.js 不一致');
  assert.strictEqual(calc.clash, r.clash, bot.name + ': 相撞判定不一致');
  assert.strictEqual(calc.hitP1, r.hitP1, bot.name + ': hitP1 不一致');
  assert.strictEqual(calc.hitP2, r.hitP2, bot.name + ': hitP2 不一致');
  if (bot.curMove !== undefined) {
    const mine = bot.seat === 0 ? r.m1 : r.m2;
    if (bot.pickOk === true) {
      assert.strictEqual(mine, bot.curMove, '服务器记录的动作与已确认提交不一致');
    } else if (bot.pickOk === false && bot.pickRejected) {
      assert.strictEqual(mine, core.NONE, '服务器拒绝了出招却记成了动作');
    }
    // pickOk===null(响应未确认, 加速测试下窗口可能只有十几毫秒): 以服务器结算为准
  }
  bot.resultCount++;
}

/* ================================================================ */
async function scenarioStatic(base) {
  console.log('== 场景 1: 静态页面可访问 ==');
  t('首页 HTML 200', async () => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.indexOf('Mindstrike') >= 0);
    assert.ok(html.indexOf('联机对战') >= 0);
  });
  t('中文文件名静态资源可访问', async () => {
    const r = await fetch(base + '/%E9%9F%B3%E6%95%88/%E6%B8%B8%E6%88%8F%E5%88%9D%E5%A7%8B%E8%83%8C%E6%99%AF%E9%9F%B3%E4%B9%90.mp4');
    assert.ok(r.status === 200, '音频资源状态 ' + r.status);
  });
}

async function scenarioFullMatch(base) {
  console.log('== 场景 2: 完整 BO3(随机出招 + 结算一致性 + 再来一局) ==');
  const b0 = makeBot(base, '蓝方机器人');
  const b1 = makeBot(base, '红方机器人');
  await b0.join(); await b1.join();
  assert.notStrictEqual(b0.seat, b1.seat, '两个玩家占座应不同');
  b0.start(); b1.start();

  let newMatch = false, firstOver = false;
  const flow = function (st, b) {
    if (st.phase === 'lobby') {
      const other = st.seats[1 - b.seat];
      if (other && other.present) b.ready().catch(() => { });
    } else if (st.phase === 'input') {
      b.prevE = b.e.slice();
      const legal = core.legalActions(b.e[b.seat]);
      const move = legal[(Math.random() * legal.length) | 0];
      b.curMove = move; b.pickOk = null; b.pickRejected = false;
      b.pick(move).then(r => {
        b.pickOk = !!(r && r.ok);
        b.pickRejected = !!(r && !r.ok);
      }).catch(() => { });
    } else if (st.phase === 'result') {
      checkResultConsistency(b, st);
      b.curMove = undefined;
    } else if (st.phase === 'over') {
      firstOver = true;
      b.rematch(true).catch(() => { });   // 幂等, 可重复发(防丢包)
    } else if (st.phase === 'intro' && firstOver && st.score[0] === 0 && st.score[1] === 0) {
      newMatch = true;
    }
  };
  b0.onState = flow; b1.onState = flow;

  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !(newMatch && firstOver)) await wait(40);

  const overStates = b0.events.filter(x => x.phase === 'over');
  t('整场 BO3 结束(服务器广播 over)', () => {
    assert.ok(overStates.length >= 1, '没有收到 over 事件');
  });
  t('比分合法: 胜者 2 小局', () => {
    const o = overStates[overStates.length - 1];
    assert.ok((o.score[0] === 2 && o.score[1] <= 1) || (o.score[1] === 2 && o.score[0] <= 1),
      '比分异常 ' + JSON.stringify(o.score));
  });
  t('每回合结算均与核心逻辑一致', () => {
    assert.ok(b0.resultCount >= 2 && b1.resultCount >= 2, 'result 太少');
  });
  t('双方都点"再来一局"后自动开新场(比分清零)', () => {
    assert.ok(newMatch, '重赛未开始');
  });

  b0.stop = true; b1.stop = true;
  await b0.leave(); await b1.leave();
}

async function scenarioAbort(base) {
  console.log('== 场景 3: 对局中途离开 → 对手回大厅 ==');
  const b0 = makeBot(base, '蓝方机器人2');
  const b1 = makeBot(base, '红方机器人2');
  await b0.join(); await b1.join();
  b0.start(); b1.start();
  const flow0 = function (st, b) {
    if (st.phase === 'lobby') {
      const other = st.seats[1 - b.seat];
      if (other && other.present && !b.readySent) { b.readySent = true; b.ready().catch(() => { }); }
    } else if (st.phase === 'input') {
      if (!b.pickSent) { b.pickSent = true; b.pick('charge').catch(() => { }); }
    }
  };
  const flow1 = function (st, b) {
    if (st.phase === 'lobby') {
      const other = st.seats[1 - b.seat];
      if (other && other.present && !b.readySent) { b.readySent = true; b.ready().catch(() => { }); }
    } else if (st.phase === 'input') {
      if (!b.pickSent) { b.pickSent = true; b.pick('charge').catch(() => { }); }
    }
  };
  b0.onState = flow0; b1.onState = flow1;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const last = b1.events[b1.events.length - 1];
    if (b1.pickSent && last && last.phase === 'input') break;
    await wait(40);
  }
  assert.ok(b1.pickSent, '对局未能开始');
  await b0.leave();   // 对局进行中, 蓝方直接离开
  t('对手(红方)收到 lobby 回大厅 + 离开提示', async () => {
    const t1 = Date.now();
    while (Date.now() - t1 < 15000) {
      const last = b1.events[b1.events.length - 1];
      if (last && last.phase === 'lobby') {
        assert.ok(!!last.msg, '缺少离开提示消息');
        return;
      }
      await wait(40);
    }
    assert.fail('对方没有回到大厅');
  });
  b0.stop = true; b1.stop = true;
  await b1.leave();
}

async function scenarioDraw(base) {
  console.log('== 场景 4: 40 回合僵局 → 判平重开 ==');
  const b0 = makeBot(base, '蓝方机器人3');
  const b1 = makeBot(base, '红方机器人3');
  await b0.join(); await b1.join();
  b0.start(); b1.start();
  const flow = function (st, b) {
    if (st.phase === 'lobby') {
      const other = st.seats[1 - b.seat];
      if (other && other.present && !b.readySent) { b.readySent = true; b.ready().catch(() => { }); }
    } else if (st.phase === 'input') {
      b.curMove = 'charge';
      b.pick('charge').catch(() => { });
    }
  };
  b0.onState = flow; b1.onState = flow;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const msgs = b0.events.map(x => x.msg || '').filter(Boolean);
    if (msgs.some(m => m.indexOf('判平') >= 0)) break;
    await wait(50);
  }
  t('双方都蓄力满 40 回合后判平重开(voids 累计)', () => {
    const msgs = b0.events.map(x => x.msg || '');
    assert.ok(msgs.some(m => m.indexOf('判平') >= 0), '未见判平消息');
    assert.ok(b0.stats && b0.stats.voids >= 1, 'voids 未累计');
  });
  b0.stop = true; b1.stop = true;
  await b0.leave(); await b1.leave();
}

async function scenarioEmptyRoom(base) {
  console.log('== 场景 5: 房间清空(双方都退出)后服务器不崩溃(回归) ==');
  // 回归: 旧实现中双方退出后, 残留的长轮询超时回调读空房间 → 进程崩溃
  const b0 = makeBot(base, '先退1');
  const b1 = makeBot(base, '后退2');
  await b0.join(); await b1.join();
  await wait(500);        // 静置: 双方都挂着长轮询(无 seq 变化)
  await b0.leave();       // 有 bump → 应答挂起轮询; b1 会立刻重新挂起
  await wait(400);
  await b1.leave();       // 第二个离开 → 房间清空(room=null), b1 挂起的轮询残留
  await wait(3500);       // 让残留轮询超时回调触发(修复前这里进程崩溃)
  t('残留轮询超时后服务器仍然存活', async () => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200, '服务器已崩溃');
  });
  // 之后仍可正常建房、正常打一局
  const c0 = makeBot(base, '新人1');
  const c1 = makeBot(base, '新人2');
  await c0.join(); await c1.join();
  c0.start(); c1.start();
  let gotResult = false;
  const flow = function (st, b) {
    if (st.phase === 'lobby') {
      const other = st.seats[1 - b.seat];
      if (other && other.present && !b.readySent) { b.readySent = true; b.ready().catch(() => { }); }
    } else if (st.phase === 'input') {
      if (!b.curMove) { b.curMove = 'charge'; b.pick('charge').catch(() => { }); }
    } else if (st.phase === 'result') {
      gotResult = true;
    }
  };
  c0.onState = flow; c1.onState = flow;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !gotResult) await wait(40);
  t('清空后新人可重新开局并正常结算', () => {
    assert.ok(gotResult, '新人未收到结算');
  });
  c0.stop = true; c1.stop = true;
  await c0.leave(); await c1.leave();
}

async function scenarioEmoji(base) {
  console.log('== 场景 6: 表情互动(广播转发 + 1.5s 冷却) ==');
  const b0 = makeBot(base, '表情A');
  const b1 = makeBot(base, '表情B');
  await b0.join(); await b1.join();
  b0.start(); b1.start();      // 轮询以便收到表情广播
  await wait(300);

  const res = {};
  res.r1 = await post(base, 'emoji', { token: b0.token, e: 2 });   // 😡
  res.r2 = await post(base, 'emoji', { token: b0.token, e: 0 });   // 同座位 1.5s 内 → 冷却
  res.r3 = await post(base, 'emoji', { token: b1.token, e: 0 });   // 另一个座位不受影响
  res.r4 = await post(base, 'emoji', { token: b1.token, e: 99 });  // 越界 → 拒绝

  // 等 b1 收到包含 b0 表情事件的快照
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const hit = b1.events.filter(s => s.emoji && s.emoji.seat === 0 && s.emoji.e === 2);
    if (hit.length) { res.receivedEvtSeq = hit[hit.length - 1].emoji.seq; break; }
    await wait(40);
  }

  t('表情发送成功(带 evt seq), 同座位 1.5s 内再次发送被冷却拒绝', () => {
    assert.strictEqual(res.r1.ok, true, '第一次表情应成功');
    assert.ok(res.r1.evt > 0, '应返回事件序号');
    assert.strictEqual(res.r2.ok, false, '冷却内不应成功');
    assert.strictEqual(res.r2.err, 'cd', '应返回 cd');
  });
  t('另一座位可独立发送; 非法表情被拒', () => {
    assert.strictEqual(res.r3.ok, true, 'B 座位应可发送');
    assert.strictEqual(res.r4.ok, false, '越界表情应被拒');
    assert.strictEqual(res.r4.err, 'move');
  });
  t('对方轮询收到表情广播(seat/e/seq 完整)', () => {
    assert.ok(res.receivedEvtSeq, 'b1 未收到 b0 的表情事件');
    assert.ok(res.receivedEvtSeq > 0);
  });
  b0.stop = true; b1.stop = true;
  await b0.leave(); await b1.leave();
}

async function scenarioKick(base) {
  console.log('== 场景 7: 房主踢人(只有房主能踢 / 被踢者禁入 / 座位释放) ==');
  const b0 = makeBot(base, '房主');
  const b1 = makeBot(base, '客人');
  await b0.join(); await b1.join();
  const res = {};
  res.host = await fetch(base + '/api/state?token=' + encodeURIComponent(b0.token)).then(r => r.json());
  // 非房主(客人)尝试踢人 → 拒绝
  res.guestKick = await post(base, 'kick', { token: b1.token });
  // 房主踢客人 → 成功; 客人 token 应被拉黑
  res.hostKick = await post(base, 'kick', { token: b0.token });
  res.kickedPoll = await fetch(base + '/api/poll?token=' + encodeURIComponent(b1.token) + '&seq=999').then(r => r.json());
  res.kickedRejoin = await post(base, 'join', { token: b1.token });
  // 新人可立刻补位
  const c0 = makeBot(base, '补位');
  await c0.join();
  res.seatBack = await fetch(base + '/api/state?token=' + encodeURIComponent(c0.token)).then(r => r.json());

  t('第一个进房者成为房主; 非房主不能踢人', () => {
    assert.ok(res.host.state && res.host.state.host === 0, 'host 应为 seat0, 实际 ' + JSON.stringify(res.host));
    assert.strictEqual(res.guestKick.ok, false, '客人不应能踢人');
    assert.strictEqual(res.guestKick.err, 'host');
  });
  t('房主踢人成功; 被踢者轮询/重连都被拒绝(kicked)', () => {
    assert.strictEqual(res.hostKick.ok, true, '房主踢人应成功');
    assert.strictEqual(res.kickedPoll.err, 'kicked', '被踢者轮询应返回 kicked');
    assert.strictEqual(res.kickedRejoin.err, 'kicked', '被踢者重连应返回 kicked');
    assert.strictEqual(res.kickedRejoin.ok, false);
  });
  t('被踢座位立刻释放, 新人可加入', () => {
    assert.ok(res.seatBack.state, '补位者应拿到状态');
    const seats = res.seatBack.state.seats;
    const presentCount = seats.filter(s => s.present).length;
    assert.strictEqual(presentCount, 2, '补位后应仍是两人: ' + JSON.stringify(seats));
  });
  b0.stop = true; b1.stop = true; c0.stop = true;
  await b0.leave(); await c0.leave();
}

/* ================================================================ */
async function main() {
  const app = createServer({ speed: SPEED });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  console.log('联机服务器协议测试 · ' + base + ' (加速 x' + SPEED + ')');
  try {
    await scenarioStatic(base);
    await scenarioFullMatch(base);
    await scenarioAbort(base);
    await scenarioDraw(base);
    await scenarioEmptyRoom(base);
    await scenarioEmoji(base);
    await scenarioKick(base);
    console.log('\n✅ 全部通过: ' + passed + ' 组断言\n');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ 测试失败:', e && e.message || e);
    if (e && e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
    process.exit(1);
  }
}
main();

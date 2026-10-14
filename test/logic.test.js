/**
 * Mindstrike 核心逻辑单元测试(v3: 无能量上限 / 同级攻击相撞抵消 / 大攻击压过小攻击)
 * 运行: node test/logic.test.js  (工作目录: 项目根目录)
 */
'use strict';
const assert = require('assert');
const core = require('../game.js');

const A = core.ACTIONS;
const NONE = core.NONE;
let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

console.log('== 基础数据 ==');
t('血量 1 / 单小局上限 40 回合', () => {
  assert.strictEqual(core.HP, 1);
  assert.strictEqual(core.SET_MAX_TURNS, 40);
});
t('动作参数正确', () => {
  assert.deepStrictEqual([A.charge.cost, A.charge.gain], [0, 1]);
  assert.strictEqual(A.small.cost, 1);
  assert.strictEqual(A.guard.cost, 0);
  assert.strictEqual(A.heavy.cost, 3);
  assert.strictEqual(A.wall.cost, 1);
});

console.log('== 能量: 无上限 ==');
t('0 能量只能 蓄力/小防御', () => {
  assert.deepStrictEqual(core.legalActions(0), ['charge', 'guard']);
});
t('能量满 3 后仍可继续蓄力(无上限)', () => {
  assert.deepStrictEqual(core.legalActions(3), ['charge', 'small', 'guard', 'heavy', 'wall']);
  assert.strictEqual(core.canUse(99, 'charge'), true);
  assert.strictEqual(core.canUse(2, 'heavy'), false);
  assert.strictEqual(core.canUse(3, 'heavy'), true);
});
t('蓄力可无限累加', () => {
  const r = core.exchange({ e1: 7, e2: 12 }, 'charge', 'charge');
  assert.strictEqual(r.e1, 8);
  assert.strictEqual(r.e2, 13);
});
t('能量不会被扣成负数', () => {
  const r = core.exchange({ e1: 1, e2: 0 }, 'heavy', 'guard'); // 能量不足仍按发呆? 不, 动作照用
  assert.strictEqual(r.e1, 0); // 扣到 0 为止(UI 层已阻止该情况)
});

console.log('== 回合结算: 命中判定(单独攻击) ==');
function X(e1, e2, a1, a2) { return core.exchange({ e1, e2 }, a1, a2); }
t('小攻击 vs 发呆/蓄力 → 命中', () => {
  assert.strictEqual(X(1, 0, 'small', NONE).hitP2, true);
  assert.strictEqual(X(1, 0, 'small', 'charge').hitP2, true);
});
t('小攻击 vs 小防御/大防御 → 挡下', () => {
  assert.strictEqual(X(1, 0, 'small', 'guard').hitP2, false);
  assert.strictEqual(X(1, 0, 'small', 'wall').hitP2, false);
});
t('大攻击 vs 小防御 → 穿透命中(小防御只挡小攻击)', () => {
  assert.strictEqual(X(3, 0, 'heavy', 'guard').hitP2, true);
});
t('大攻击 vs 大防御 → 挡下', () => {
  assert.strictEqual(X(3, 0, 'heavy', 'wall').hitP2, false);
});
t('大攻击 vs 发呆 → 命中', () => {
  assert.strictEqual(X(3, 0, 'heavy', NONE).hitP2, true);
});
t('防守方架盾, 攻击方蓄力 → 无人受伤', () => {
  const r = X(0, 0, 'guard', 'charge');
  assert.strictEqual(r.hitP1, false);
  assert.strictEqual(r.hitP2, false);
});

console.log('== 同时攻击: 同级相撞, 大攻击压过小攻击 ==');
t('小攻击 vs 小攻击: 同级相撞, 无人受伤', () => {
  const r = X(1, 1, 'small', 'small');
  assert.strictEqual(r.clash, true);
  assert.strictEqual(r.hitP1, false);
  assert.strictEqual(r.hitP2, false);
});
t('大攻击 vs 大攻击: 同级相撞抵消', () => {
  const r = X(3, 3, 'heavy', 'heavy');
  assert.strictEqual(r.clash, true);
  assert.strictEqual(r.hitP1, false);
  assert.strictEqual(r.hitP2, false);
});
t('大攻击 vs 小攻击(P1大 P2小): 小攻击方 P2 被斩杀', () => {
  const r = X(3, 1, 'heavy', 'small');
  assert.strictEqual(r.clash, false);
  assert.strictEqual(r.hitP1, false);
  assert.strictEqual(r.hitP2, true);
});
t('小攻击 vs 大攻击(P1小 P2大): 小攻击方 P1 被斩杀', () => {
  const r = X(1, 3, 'small', 'heavy');
  assert.strictEqual(r.clash, false);
  assert.strictEqual(r.hitP1, true);
  assert.strictEqual(r.hitP2, false);
});
t('攻击相撞/压过时双方能量照常消耗', () => {
  const r1 = X(1, 1, 'small', 'small');
  assert.strictEqual(r1.e1, 0); assert.strictEqual(r1.e2, 0);
  const r2 = X(3, 1, 'heavy', 'small');
  assert.strictEqual(r2.e1, 0); assert.strictEqual(r2.e2, 0); // 小攻击方照样耗 1 能量
  const r3 = X(9, 9, 'heavy', 'heavy');
  assert.strictEqual(r3.e1, 6); assert.strictEqual(r3.e2, 6);
});
t('攻击 + 防御不算相撞, 正常结算', () => {
  const r = X(1, 0, 'small', 'guard');
  assert.strictEqual(r.clash, false);
  assert.strictEqual(r.hitP2, false);
});
t('攻击 + 蓄力不算相撞, 攻击者命中', () => {
  const r = X(1, 0, 'small', 'charge');
  assert.strictEqual(r.clash, false);
  assert.strictEqual(r.hitP2, true);
});

console.log('== 发呆 ==');
t('发呆无任何收益也不造成伤害', () => {
  const r = X(0, 0, NONE, 'guard');
  assert.strictEqual(r.hitP1, false);
  assert.strictEqual(r.e1, 0); assert.strictEqual(r.e2, 0);
});
t('非法动作 id 一律按发呆处理', () => {
  const r = core.exchange({ e1: 0, e2: 0 }, 'xxx', 'yyy');
  assert.strictEqual(r.a1, NONE); assert.strictEqual(r.a2, NONE);
  assert.strictEqual(r.hitP1, false); assert.strictEqual(r.hitP2, false);
});

console.log('== 小局流程模拟 ==');
t('P1 蓄力一回合后小攻击, P2 同回合发呆 → P1 命中', () => {
  const r1 = core.exchange(core.newState(), 'charge', NONE);
  const r2 = core.exchange({ e1: r1.e1, e2: r1.e2 }, 'small', 'charge');
  assert.strictEqual(r2.e1, 0); // 小攻击耗掉 1
  assert.strictEqual(r2.hitP2, true);
});
t('能量在小局间重置(新 state 每次从 0 开始)', () => {
  assert.deepStrictEqual(core.newState(), { e1: 0, e2: 0 });
});
t('高能量对局: 连续蓄力到 10 再大攻击, 剩余 7', () => {
  let st = core.newState();
  for (let i = 0; i < 10; i++) st = core.exchange(st, 'charge', 'guard');
  assert.strictEqual(st.e1, 10);
  const r = core.exchange(st, 'heavy', 'guard');
  assert.strictEqual(r.e1, 7);
  assert.strictEqual(r.hitP2, true); // 大攻击穿透小防御
});

console.log('== 随机烟雾测试(5000 局, 每局最多 40 回合) ==');
(function () {
  let exchangeCount = 0;
  for (let g = 0; g < 5000; g++) {
    let st = core.newState();
    for (let k = 0; k < core.SET_MAX_TURNS; k++) {
      const legal1 = core.legalActions(st.e1);
      const legal2 = core.legalActions(st.e2);
      const pick = (arr) => (Math.random() < 0.05 ? NONE : arr[(Math.random() * arr.length) | 0]);
      const a1 = pick(legal1);
      const a2 = pick(legal2);
      const r = core.exchange(st, a1, a2);
      assert.ok(r.e1 >= 0 && Number.isFinite(r.e1), '能量非法');
      assert.ok(r.e2 >= 0 && Number.isFinite(r.e2), '能量非法');
      if (r.clash) { st = { e1: r.e1, e2: r.e2 }; continue; } // 相撞: 继续下一回合
      if (r.hitP1 || r.hitP2) break; // 小局结束
      st = { e1: r.e1, e2: r.e2 };
      exchangeCount++;
    }
  }
  console.log(`  ✓ 5000 局模拟无异常 (有效回合 ${exchangeCount})`);
})();

console.log(`\n全部 ${passed + 1} 组测试通过 ✔`);

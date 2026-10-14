/**
 * Mindstrike(暂定名) — 纯逻辑核心, 浏览器与 Node 共用
 *
 * 规则:
 *  - 双人 PVP, 每回合双方同时秘密出招(不知道对方选择)
 *  - 五个动作: 蓄力 / 小攻击 / 小防御 / 大攻击 / 大防御
 *  - 双方各 1 滴血, 攻击命中即 K.O., 输掉当前小局
 *  - 小局采用多回合制: 每回合结算一次, 直到有人被命中
 *  - 场次 BO3: 先赢下 2 个小局者获胜
 *  - 能量无上限; 每个小局开始时双方能量清零
 *
 * 命中判定:
 *  - 小攻击: 被 小防御 / 大防御 挡下
 *  - 大攻击: 仅被 大防御 挡下(可穿透小防御)
 *  - 对手在蓄力 / 发呆 / 也在攻击: 一律可命中
 *  - 双方同时出攻击 → 同级攻击(小vs小 / 大vs大)相撞抵消, 无人受伤,
 *    能量照常消耗, 进入下一回合;
 *    大攻击 vs 小攻击 → 大攻击直接压过, 出小攻击的一方被斩杀(K.O.), 不会同归于尽。
 *
 * [DEMO 补充设定, 待确认]:
 *   超时未出招(发呆) = 无动作、无收益、无防御; AI 不会发呆;
 *   单小局超过 40 回合判平重开。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MindCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HP = 1;             // 双方血量(1 滴)
  var SET_MAX_TURNS = 40; // 单小局最大回合数, 超出判平重开

  // 五个动作(插入顺序即出招顺序)
  var ACTIONS = {
    charge: { name: '蓄力',   icon: '⚡', cost: 0, gain: 1, kind: 'gain',   tip: '获得 1 点能量(无上限)' },
    small:  { name: '小攻击', icon: '🗡️', cost: 1, gain: 0, kind: 'attack', tip: '消耗 1 能量, 命中即击杀' },
    guard:  { name: '小防御', icon: '🛡️', cost: 0, gain: 0, kind: 'block',  tip: '挡下小攻击' },
    heavy:  { name: '大攻击', icon: '💥', cost: 3, gain: 0, kind: 'attack', tip: '消耗 3 能量, 命中即击杀' },
    wall:   { name: '大防御', icon: '🔰', cost: 1, gain: 0, kind: 'block',  tip: '挡下大攻击与小攻击' }
  };
  var IDS = Object.keys(ACTIONS);
  var NONE = 'none'; // 发呆(未在时限内出招)

  function clampEnergy(e) { return e < 0 ? 0 : e; } // 无上限, 只保底不为负
  function costOf(a) { var x = ACTIONS[a]; return x ? x.cost : 0; }
  function gainOf(a) { var x = ACTIONS[a]; return x ? x.gain : 0; }
  function isAttack(id) { var x = ACTIONS[id]; return !!x && x.kind === 'attack'; }

  /** 当前能量下能否使出某动作(只检查能量是否足够) */
  function canUse(energy, action) {
    var a = ACTIONS[action];
    if (!a) return false;
    return a.cost <= energy;
  }

  /** 当前能量下合法的动作列表 */
  function legalActions(energy) { return IDS.filter(function (id) { return canUse(energy, id); }); }

  /**
   * 攻击 atk 能否命中正在使出 def 的对手:
   *  小防御只挡小攻击; 大防御大小通吃;
   *  对手在蓄力 / 发呆 / 也在攻击时, 一律可命中。
   */
  function attackHits(atk, def) {
    if (!isAttack(atk)) return false;
    if (def === 'guard') return atk === 'heavy';
    if (def === 'wall') return false;
    return true;
  }

  function newState() { return { e1: 0, e2: 0 }; }

  /**
   * 结算一个回合(纯函数)。
   * prev: {e1, e2}; a1/a2: 动作 id 或 'none'(发呆)
   * 返回: {e1, e2, a1, a2, hitP1, hitP2, clash}
   *   hitP1 = P1 被命中; clash = 同级攻击互撞抵消, 无人受伤
   *   大攻击 vs 小攻击 = 不判相撞: 小攻击的一方直接被打中(K.O.)
   */
  function exchange(prev, a1, a2) {
    a1 = ACTIONS[a1] ? a1 : NONE;
    a2 = ACTIONS[a2] ? a2 : NONE;
    var e1 = clampEnergy(prev.e1 - costOf(a1) + gainOf(a1));
    var e2 = clampEnergy(prev.e2 - costOf(a2) + gainOf(a2));
    var hitP1, hitP2, clash;
    if (isAttack(a1) && isAttack(a2)) {
      // 双方都在攻击: 同级相撞抵消; 大攻击压过小攻击 → 小攻击方被斩杀
      if (a1 === a2) { clash = true; hitP1 = false; hitP2 = false; }
      else if (a1 === 'heavy') { clash = false; hitP1 = false; hitP2 = true; }  // P2 小攻击被打
      else { clash = false; hitP1 = true; hitP2 = false; }                      // P1 小攻击被打
    } else {
      clash = false;
      hitP1 = attackHits(a2, a1); // P2 的攻击打没打中 P1
      hitP2 = attackHits(a1, a2); // P1 的攻击打没打中 P2
    }
    return {
      e1: e1, e2: e2,
      a1: a1, a2: a2,
      hitP1: hitP1, hitP2: hitP2,
      clash: clash
    };
  }

  return {
    HP: HP, SET_MAX_TURNS: SET_MAX_TURNS, NONE: NONE,
    ACTIONS: ACTIONS, IDS: IDS,
    canUse: canUse,
    legalActions: legalActions,
    newState: newState,
    exchange: exchange
  };
});

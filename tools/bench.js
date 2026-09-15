/* 常に群れの上に居る前提の卓上シミュレータ。
   航行をまるごと省いて、強化の経済だけを測る。

   使い方（ゲームを開いたページのコンソールで）:
     await import('./tools/bench.js')      // Pages 上。ローカルなら fetch+eval でも可
     benchTable()                          // 主要な方針を横並び
     bench({games:2000, policy:'best'})    // 単発

   ゲーム本体の rollChoices / applyUpgrade / nextUp / stat / 必要本数カーブ / 入れ食いの
   抽選をそのまま呼ぶので、式を直せばここも自動で追従する。

   uptime は「竿が実際に動いている割合」。1.0 のままだと実機の5倍釣れてレベルが26まで
   行き、別のゲームになる。既定の 0.42 は実機の自動操船と中央値・レベル数が揃う値
   （航行の時間と、竿の下に魚が居ない時間をまとめて畳んだもの）。
   burstSec は「一度乗ったら何秒続けて釣るか」。入れ食いの抽選は1本ごとなので、
   同じ釣果でも固まっているか薄く延びているかで挙動がまるで変わる。0 にすると一様。

   supply は「海が1秒に何本まで竿の下へ送り込めるか」の上限。これが無いと、伸びた run が
   青天井に伸びて p90 が実機の50倍になる（実際には竿がいくら速くても魚が足りない）。
   既定の60は実機の自動操船に合わせた値で、上げるほど「魚が無限に湧く海」に近づく。
   ここが実質、機関・魚探・集魚・船体の漁獲範囲をまとめて1つの数字に畳んだものになる。

   向いていないもの:
     支援4種の個別評価 …… どれも supply に畳まれてしまうので区別がつかない
     入れ食いの調整     …… 抽選が1本ごとなので釣果の固まり方に強く依存する。
                            burstSec で寄せてはいるが、実機の発動秒数までは再現できない */

(function(){
'use strict';
const DT = 0.05;                         // 入れ食いのタイマーが10秒なので0.05秒刻みで十分

function snapshot(){ return {...S.up}; }
function restore(u){ Object.assign(S.up, u); layoutCrew(); }

/* 1本ごとの抽選を「この刻みで1回でも当たったか」に畳む。
   k本釣るあいだに1回も当たらない確率が (1-p)^k */
function hit(p, k){ return Math.random() < 1 - Math.pow(1 - p, k); }

const POLICIES = {
  rand : c => c[(Math.random()*c.length)|0],
  best : c => {                                    // その場の漁獲力がいちばん伸びる札
    const now = stat.power(S.up);
    let bu = null, bg = -1;
    for(const u of c){ const g = stat.power(nextUp(u.id))/now; if(g > bg){ bg = g; bu = u; } }
    return bu;
  },
  crew : c => c.find(u=>u.id==='crew') || POLICIES.best(c),        // 漁師でゴリ押し
  rod  : c => c.find(u=>u.id==='rate')                            // 少数精鋭。漁師は取らない
            || c.find(u=>u.id!=='crew') || c[0],
  hull : c => c.find(u=>u.id==='hull') || POLICIES.best(c)
};

function one(policy, opt){
  /* 群れに乗っている時間を「burstSec 秒乗って、そのあと空白」の矩形波にする。
     一様に薄く釣らせると入れ食いの挙動が実機とまるで変わる（抽選は1本ごとなので、
     釣果が固まっているほど当たりが入れ食い中に無駄撃ちされ、空白で時間切れになる）。
     burstSec=0 なら一様。 */
  const onSec  = opt.burstSec;
  const offSec = onSec>0 ? onSec*(1-opt.uptime)/Math.max(.01,opt.uptime) : 0;
  const cycle  = onSec + offSec;
  const need0 = 9, growth = 1.28;
  let level = 1, need = need0, prog = 0, score = 0;
  let fever = false, fvT = 0, lock = 0, rounds = 0, fvTime = 0, fevers = 0;
  const steps = Math.round(GAME_TIME / DT);
  for(let i=0;i<steps;i++){
    const p = fvEntry();
    const on = cycle>0 ? ((i*DT) % cycle) < onSec : true;
    /* 入れ食いは獲れた量にかかるので、海の供給で頭打ちにしたあとに乗せる */
    const rate = Math.min(stat.power(S.up), opt.supply) * (fever ? FV_GAIN : 1);
    const k = on ? rate * DT * (cycle>0?1:opt.uptime) : 0;
    score += k; prog += k;
    if(fever){
      fvTime += DT;
      if(hit(p, k)){ fvT = fvSec(); rounds++; }                // 期間中にもう一度当てた
      else { fvT -= DT; if(fvT <= 0){ fever = false; lock = FV_LOCK; } }
    }else{
      if(lock > 0) lock -= DT;
      else if(opt.fever && hit(p, k)){ fever = true; fvT = fvSec(); fevers++; rounds++; }
    }
    let guard = 0;
    while(prog >= need && guard++ < 40){
      prog -= need; level++; need = Math.round(need0 * Math.pow(growth, level-1));
      applyUpgrade(policy(rollChoices()));
    }
  }
  return {score, level, fevers, rounds, fvTime, power:stat.power(S.up), up:{...S.up}};
}

function bench(o){
  const opt = Object.assign({games:2000, policy:'best', fever:true, uptime:0.42, burstSec:8, supply:60}, o||{});
  const pick = typeof opt.policy === 'function' ? opt.policy : POLICIES[opt.policy];
  if(!pick) throw new Error('policy: ' + Object.keys(POLICIES).join(' / '));
  const keep = snapshot(), rows = [];
  for(let g=0; g<opt.games; g++){
    reset();                                    // S.up と S.crew を初期状態へ
    rows.push(one(pick, opt));
  }
  restore(keep);
  const q = f => { const a = rows.map(r=>r.score).sort((x,y)=>x-y);
                   return Math.round(a[Math.min(a.length-1, (a.length*f)|0)]); };
  const avg = k => +(rows.reduce((s,r)=>s+r[k],0)/rows.length).toFixed(2);
  const build = k => +(rows.reduce((s,r)=>s+r.up[k],0)/rows.length).toFixed(1);
  return {
    policy: typeof opt.policy === 'string' ? opt.policy : 'custom', games: rows.length, uptime: opt.uptime, burstSec: opt.burstSec, supply: opt.supply,
    p10:q(.10), p50:q(.50), p90:q(.90), p99:q(.99), max:Math.round(Math.max(...rows.map(r=>r.score))),
    level:avg('level'), 漁獲力:avg('power'),
    入れ食い:{回数:avg('fevers'), 連:+(avg('rounds')/Math.max(.01,avg('fevers'))).toFixed(2), 秒:avg('fvTime')},
    build:{漁師:build('crew'), 船体:build('hull'), 釣具:build('rate'),
           機関:build('engine'), 魚探:build('sonar'), 集魚:build('lure')}
  };
}

function benchTable(o){
  const opt = Object.assign({games:2000}, o||{});
  const names = o && o.policies || ['rand','best','crew','rod','hull'];
  const out = names.map(n => bench(Object.assign({}, opt, {policy:n})));
  const pad = (s,w) => String(s).padEnd(w);
  const num = (s,w) => String(s).padStart(w);
  let t = pad('方針',7)+num('p10',8)+num('p50',8)+num('p90',8)+num('最大',9)
        + num('Lv',6)+num('漁獲力',9)+'   漁師/船体/釣具\n';
  for(const r of out) t += pad(r.policy,7)+num(r.p10,8)+num(r.p50,8)+num(r.p90,8)+num(r.max,9)
        + num(r.level,6)+num(r.漁獲力,9)+'   '+r.build.漁師+' / '+r.build.船体+' / '+r.build.釣具+'\n';
  console.log(t);
  return out;
}

window.bench = bench;
window.benchTable = benchTable;
window.BENCH_POLICIES = POLICIES;
console.log('bench 読み込み完了。benchTable() で横並び、bench({policy:"rod"}) で単発。');
})();

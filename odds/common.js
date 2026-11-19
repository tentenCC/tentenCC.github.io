// オッズ計算などの共通ロジック
export const UNIT = 100; // 投票単位（pt）

export function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// パリミュチュエル方式：総投票額 × (1 - 控除率) ÷ その出場者への投票額
// 0.1 未満切り捨て・最低 1.0 倍。投票ゼロなら null
export function calcOdds(pool, votes, takeout) {
  if (!votes) return null;
  return Math.max(1.0, Math.floor((pool * (1 - takeout)) / votes * 10 + 1e-9) / 10);
}

// バックエンドの生データ { t, users, bets, uid } から画面表示用データを作る
export function buildView(raw) {
  const t = raw.t;
  const pool = raw.bets.reduce((s, b) => s + b.amount, 0);
  const votes = {}, bettors = {};
  for (const b of raw.bets) {
    votes[b.entrantId] = (votes[b.entrantId] || 0) + b.amount;
    (bettors[b.entrantId] ||= new Set()).add(b.uid);
  }
  const settled = t.status === 'settled' && t.finalOdds;
  const entrants = t.entrants.map(e => ({
    id: e.id, name: e.name,
    votes: votes[e.id] || 0,
    bettors: bettors[e.id] ? bettors[e.id].size : 0,
    share: pool ? (votes[e.id] || 0) / pool : 0,
    odds: settled ? (t.finalOdds[e.id] ?? null) : calcOdds(pool, votes[e.id] || 0, t.takeout),
  }));
  [...entrants].sort((a, b) => b.votes - a.votes)
    .forEach((e, i) => { e.popularity = e.votes ? i + 1 : null; });

  const ranking = raw.users.map(u => {
    const staked = raw.bets.filter(b => b.uid === u.id).reduce((s, b) => s + b.amount, 0);
    return { id: u.id, name: u.name, points: u.points, staked, total: u.points + (t.status === 'settled' ? 0 : staked) };
  }).sort((a, b) => b.total - a.total);

  const meUser = raw.users.find(u => u.id === raw.uid);
  return {
    id: t.id, name: t.name, status: t.status, takeout: t.takeout, initialPoints: t.initialPoints, unit: UNIT,
    winnerId: t.winnerId || null, refunded: !!t.refunded,
    pool, entrants, ranking, betCount: raw.bets.length, userCount: raw.users.length,
    me: meUser ? {
      id: meUser.id, name: meUser.name, points: meUser.points,
      bets: raw.bets.filter(b => b.uid === meUser.id).sort((a, b) => a.at - b.at)
        .map(b => ({ id: b.id, entrantId: b.entrantId, amount: b.amount, at: b.at, payout: b.payout ?? null })),
    } : null,
  };
}

// 結果確定時の払戻計算。的中者がいなければ全額返還
export function computeSettlement(raw, winnerId) {
  const view = buildView({ ...raw, t: { ...raw.t, status: 'closed' } });
  const finalOdds = Object.fromEntries(view.entrants.map(e => [e.id, e.odds]));
  const winOdds = finalOdds[winnerId];
  const refunded = winOdds == null;
  const payouts = {};
  for (const b of raw.bets) {
    payouts[b.id] = refunded ? b.amount : (b.entrantId === winnerId ? Math.floor(b.amount * winOdds) : 0);
  }
  return { winnerId, finalOdds, refunded, payouts };
}

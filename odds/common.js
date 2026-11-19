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

// ---------- チーム・戦績 ----------
// 「チーム名：メンバー1、メンバー2」形式（1 行 1 チーム）を解析
export function parseTeams(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const m = line.match(/^([^:：]+)[:：](.*)$/);
    const name = (m ? m[1] : line).trim().slice(0, 40);
    const members = m ? [...new Set(m[2].split(/[,、，/／]/).map(s => s.trim().slice(0, 40)).filter(Boolean))] : [];
    return { name, members };
  });
}
export const splitNames = text => [...new Set(String(text || '').split(/[,、，/／\n]/).map(s => s.trim().slice(0, 40)).filter(Boolean))];

export const rankLabel = r => r === 1 ? '優勝' : r === 2 ? '準優勝' : r + '位';

// メンバーの戦績集計
export function memberStats(records) {
  const n = records.length;
  const wins = records.filter(r => r.rank === 1).length;
  const best = n ? Math.min(...records.map(r => r.rank)) : null;
  const avg = n ? records.reduce((s, r) => s + r.rank, 0) / n : null;
  return { count: n, wins, best, avg };
}
export const sortRecords = recs => [...recs].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));

// 確定時の戦績レコード（メンバー × 大会で 1 件、ID 固定で再実行しても重複しない）
export function buildRecords(t, ranks) {
  const out = [];
  for (const e of t.entrants) {
    const rank = ranks[e.id];
    if (!rank) continue;
    for (const mid of e.memberIds || []) {
      out.push({
        id: `${t.id}_${mid}`, memberId: mid, tournamentId: t.id, tournamentName: t.name,
        date: t.date || '', teamName: e.name, rank, teamCount: t.entrants.length, createdAt: Date.now(),
      });
    }
  }
  return out;
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

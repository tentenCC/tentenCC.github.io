// デモモード用バックエンド（Firebase 未設定時）
// データはこのブラウザの localStorage に保存。タブごとに別ユーザーになるので、
// 複数タブを開くと複数人の投票を試せます。
import { randomHex } from './common.js';

const KEY = 'oddsDemoDB';

export function createLocalBackend() {
  const safe = (f, d) => { try { return f(); } catch { return d; } };
  let uid = safe(() => sessionStorage.getItem('oddsDemoUid'));
  if (!uid) { uid = 'demo-' + randomHex(4); safe(() => sessionStorage.setItem('oddsDemoUid', uid)); }

  let memory = { tournaments: {} };
  const load = () => safe(() => JSON.parse(localStorage.getItem(KEY)), null) || memory;
  const listeners = new Set();
  const notify = () => listeners.forEach(f => f());
  const save = d => { memory = d; safe(() => localStorage.setItem(KEY, JSON.stringify(d))); notify(); };
  window.addEventListener('storage', e => { if (e.key === KEY) notify(); });
  const subscribe = f => { listeners.add(f); f(); return () => listeners.delete(f); };

  const mutate = async (tid, fn) => {
    const d = load();
    const x = d.tournaments[tid];
    if (!x) throw new Error('大会が見つかりません');
    fn(x, d);
    save(d);
  };
  const requireAdmin = x => { if (!x.admins[uid]) throw new Error('権限がありません'); };

  return {
    mode: 'local',
    ready: Promise.resolve(uid),

    listTournaments(cb) {
      return subscribe(() => cb(Object.entries(load().tournaments)
        .map(([id, x]) => ({ id, ...x.t })).sort((a, b) => b.createdAt - a.createdAt)));
    },

    watchTournament(tid, cb) {
      return subscribe(() => {
        const x = load().tournaments[tid];
        if (!x) return cb({ t: null, users: [], bets: [], uid, isAdmin: false, adminKey: null });
        cb({
          t: { id: tid, ...x.t },
          users: Object.entries(x.users).map(([id, u]) => ({ id, ...u })),
          bets: Object.entries(x.bets).map(([id, b]) => ({ id, ...b })),
          uid, isAdmin: !!x.admins[uid], adminKey: x.admins[uid] ? x.key : null,
        });
      });
    },

    async createTournament({ name, entrants, initialPoints, takeout }) {
      const d = load();
      const id = randomHex(10), key = randomHex(12);
      const ents = entrants.map(n => ({ id: randomHex(4), name: n }));
      d.tournaments[id] = {
        t: { name, status: 'open', takeout, initialPoints, ownerUid: uid, entrants: ents, entrantIds: ents.map(e => e.id),
             winnerId: null, finalOdds: null, refunded: false, createdAt: Date.now() },
        key, admins: { [uid]: true }, users: {}, bets: {},
      };
      save(d);
      return { id, adminKey: key };
    },

    join: (tid, name, initialPoints) => mutate(tid, x => {
      if (x.t.status === 'settled') throw new Error('この大会は確定済みです');
      x.users[uid] = { name, points: initialPoints, lastBet: '', joinedAt: Date.now() };
    }),

    placeBet: (tid, entrantId, amount) => mutate(tid, x => {
      const u = x.users[uid];
      if (!u) throw new Error('先に参加登録してください');
      if (x.t.status !== 'open') throw new Error('投票は締め切られています');
      if (u.points < amount) throw new Error('ポイントが足りません');
      const id = randomHex(8);
      x.bets[id] = { uid, entrantId, amount, at: Date.now() };
      u.points -= amount; u.lastBet = id;
    }),

    cancelBet: (tid, betId) => mutate(tid, x => {
      const b = x.bets[betId];
      if (!b || b.uid !== uid) throw new Error('投票が見つかりません');
      if (x.t.status !== 'open') throw new Error('投票は締め切られています');
      x.users[uid].points += b.amount; x.users[uid].lastBet = betId;
      delete x.bets[betId];
    }),

    adminLogin: (tid, key) => mutate(tid, x => {
      if (key !== x.key) throw new Error('管理者キーが正しくありません');
      x.admins[uid] = true;
    }),
    adminLogout: tid => mutate(tid, x => { delete x.admins[uid]; }),

    setStatus: (tid, status) => mutate(tid, x => { requireAdmin(x); x.t.status = status; }),

    addEntrant: (tid, raw, name) => mutate(tid, x => {
      requireAdmin(x);
      x.t.entrants.push({ id: randomHex(4), name }); x.t.entrantIds = x.t.entrants.map(e => e.id);
    }),

    removeEntrant: (tid, raw, entrantId) => mutate(tid, x => {
      requireAdmin(x);
      for (const [id, b] of Object.entries(x.bets)) {
        if (b.entrantId !== entrantId) continue;
        x.users[b.uid].points += b.amount; delete x.bets[id];
      }
      x.t.entrants = x.t.entrants.filter(e => e.id !== entrantId); x.t.entrantIds = x.t.entrants.map(e => e.id);
    }),

    settle: (tid, raw, plan) => mutate(tid, x => {
      requireAdmin(x);
      for (const [id, b] of Object.entries(x.bets)) { b.payout = plan.payouts[id] ?? 0; x.users[b.uid].points += b.payout; }
      Object.assign(x.t, { status: 'settled', winnerId: plan.winnerId, finalOdds: plan.finalOdds, refunded: plan.refunded });
    }),

    deleteTournament: (tid) => mutate(tid, (x, d) => { requireAdmin(x); delete d.tournaments[tid]; }),
  };
}

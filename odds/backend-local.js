// デモモード用バックエンド（Firebase 未設定時）
// データはこのブラウザの localStorage に保存。タブごとに別ユーザーになるので、
// 複数タブを開くと複数人の投票を試せます。
import { randomHex } from './common.js';

const KEY = 'oddsDemoDB';

export function createLocalBackend() {
  const safe = (f, d) => { try { return f(); } catch { return d; } };
  let uid = safe(() => sessionStorage.getItem('oddsDemoUid'));
  if (!uid) { uid = 'demo-' + randomHex(4); safe(() => sessionStorage.setItem('oddsDemoUid', uid)); }

  const empty = () => ({ tournaments: {}, members: {}, records: {}, site: null, siteAdmins: {} });
  let memory = empty();
  const load = () => ({ ...empty(), ...(safe(() => JSON.parse(localStorage.getItem(KEY)), null) || memory) });
  const listeners = new Set();
  const notify = () => listeners.forEach(f => f());
  const save = d => { memory = d; safe(() => localStorage.setItem(KEY, JSON.stringify(d))); notify(); };
  window.addEventListener('storage', e => { if (e.key === KEY) notify(); });
  const subscribe = f => { listeners.add(f); f(); return () => listeners.delete(f); };

  const isSite = d => !!d.siteAdmins[uid];
  const mutate = async (tid, fn) => {
    const d = load();
    const x = d.tournaments[tid];
    if (!x) throw new Error('大会が見つかりません');
    fn(x, d);
    save(d);
  };
  const mutateRoot = async fn => { const d = load(); fn(d); save(d); };
  const requireAdmin = (x, d) => { if (!x.admins[uid] && !isSite(d)) throw new Error('権限がありません'); };
  const requireSite = d => { if (!isSite(d)) throw new Error('サイト管理者のみ操作できます'); };

  return {
    mode: 'local',
    ready: Promise.resolve(uid),

    listTournaments(cb) {
      return subscribe(() => cb(Object.entries(load().tournaments)
        .map(([id, x]) => ({ id, ...x.t })).sort((a, b) => b.createdAt - a.createdAt)));
    },

    watchTournament(tid, cb) {
      return subscribe(() => {
        const d = load(), x = d.tournaments[tid];
        if (!x) return cb({ t: null, users: [], bets: [], uid, isAdmin: false, adminKey: null });
        const admin = !!x.admins[uid] || isSite(d);
        cb({
          t: { id: tid, ...x.t },
          users: Object.entries(x.users).map(([id, u]) => ({ id, ...u })),
          bets: Object.entries(x.bets).map(([id, b]) => ({ id, ...b })),
          uid, isAdmin: admin, adminKey: admin ? x.key : null,
        });
      });
    },

    createTournament: async ({ name, date, teams, initialPoints, takeout }) => {
      const d = load(); requireSite(d);
      const id = randomHex(10), key = randomHex(12);
      const ents = teams.map(tm => ({ id: randomHex(4), name: tm.name, memberIds: tm.memberIds }));
      d.tournaments[id] = {
        t: { name, date, status: 'open', takeout, initialPoints, ownerUid: uid, entrants: ents, entrantIds: ents.map(e => e.id),
             winnerId: null, finalOdds: null, refunded: false, ranks: null, createdAt: Date.now() },
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

    setStatus: (tid, status) => mutate(tid, (x, d) => { requireAdmin(x, d); x.t.status = status; }),

    addEntrant: (tid, raw, team) => mutate(tid, (x, d) => {
      requireAdmin(x, d);
      x.t.entrants.push({ id: randomHex(4), name: team.name, memberIds: team.memberIds });
      x.t.entrantIds = x.t.entrants.map(e => e.id);
    }),
    updateEntrant: (tid, raw, entrantId, team) => mutate(tid, (x, d) => {
      requireAdmin(x, d);
      x.t.entrants = x.t.entrants.map(e => e.id === entrantId ? { ...e, name: team.name, memberIds: team.memberIds } : e);
    }),

    removeEntrant: (tid, raw, entrantId) => mutate(tid, (x, d) => {
      requireAdmin(x, d);
      for (const [id, b] of Object.entries(x.bets)) {
        if (b.entrantId !== entrantId) continue;
        x.users[b.uid].points += b.amount; delete x.bets[id];
      }
      x.t.entrants = x.t.entrants.filter(e => e.id !== entrantId); x.t.entrantIds = x.t.entrants.map(e => e.id);
    }),

    settle: (tid, raw, plan) => mutate(tid, (x, d) => {
      requireAdmin(x, d);
      for (const [id, b] of Object.entries(x.bets)) { b.payout = plan.payouts[id] ?? 0; x.users[b.uid].points += b.payout; }
      for (const r of plan.records || []) { const { id, ...data } = r; d.records[id] = data; }
      Object.assign(x.t, { status: 'settled', winnerId: plan.winnerId, finalOdds: plan.finalOdds, refunded: plan.refunded, ranks: plan.ranks || null });
    }),

    deleteTournament: (tid) => mutate(tid, (x, d) => { requireAdmin(x, d); delete d.tournaments[tid]; }),

    // ---------- サイト管理者 ----------
    watchSite(cb) {
      return subscribe(() => {
        const d = load();
        cb({ initialized: !!d.site, isSiteAdmin: isSite(d), siteKey: isSite(d) ? d.site.key : null });
      });
    },
    async initSite() {
      const d = load();
      if (d.site) throw new Error('既に初期設定済みです');
      const key = randomHex(12);
      d.site = { key }; d.siteAdmins[uid] = true; save(d);
      return key;
    },
    siteLogin: key => mutateRoot(d => {
      if (!d.site || key !== d.site.key) throw new Error('サイト管理者キーが正しくありません');
      d.siteAdmins[uid] = true;
    }),
    siteLogout: () => mutateRoot(d => { delete d.siteAdmins[uid]; }),
    resetSiteKey: () => mutateRoot(d => {
      requireSite(d);
      d.site.key = randomHex(12);
      d.siteAdmins = { [uid]: true };
    }),

    // ---------- メンバー名簿 ----------
    watchMembers(cb) {
      return subscribe(() => cb(Object.entries(load().members).map(([id, m]) => ({ id, ...m }))));
    },
    async saveMember({ id, name, note, role, createdAt }) {
      const d = load(); requireSite(d);
      const mid = id || randomHex(8);
      d.members[mid] = { name, note: note || '', role: role || '', createdAt: createdAt || Date.now() };
      save(d);
      return mid;
    },
    async saveMembers(members) {
      const d = load(); requireSite(d);
      for (const m of members) d.members[m.id] = { name: m.name, note: m.note || '', role: m.role || '', createdAt: m.createdAt || Date.now() };
      save(d);
    },
    async createMembers(names, role = '') {
      const d = load(); requireSite(d);
      const ids = names.map(n => { const id = randomHex(8); d.members[id] = { name: n, note: '', role, createdAt: Date.now() }; return id; });
      save(d);
      return ids;
    },
    deleteMember: id => mutateRoot(d => {
      requireSite(d);
      for (const [rid, r] of Object.entries(d.records)) if (r.memberId === id) delete d.records[rid];
      delete d.members[id];
    }),

    // ---------- 戦績 ----------
    async getRecords(memberIds) {
      const all = Object.entries(load().records).map(([id, r]) => ({ id, ...r }));
      return memberIds ? all.filter(r => memberIds.includes(r.memberId)) : all;
    },
    saveRecord: rec => mutateRoot(d => {
      requireSite(d);
      const { id, ...data } = rec;
      d.records[id || randomHex(8)] = { ...data, createdAt: data.createdAt || Date.now() };
    }),
    deleteRecord: id => mutateRoot(d => { requireSite(d); delete d.records[id]; }),
  };
}

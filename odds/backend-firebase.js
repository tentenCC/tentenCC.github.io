// Firebase（Firestore + 匿名認証）バックエンド
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot, query, orderBy, limit, writeBatch,
  runTransaction, setDoc, updateDoc, deleteDoc, getDoc, getDocs, increment, where,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { randomHex, UNIT } from './common.js';

export function createFirebaseBackend(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  let uid = null;

  // 匿名ログイン（同じブラウザなら同じユーザーとして復元される）
  const ready = new Promise((resolve, reject) => {
    const off = onAuthStateChanged(auth, u => {
      if (u) { uid = u.uid; off(); resolve(u.uid); }
      else signInAnonymously(auth).catch(e => { off(); reject(e); });
    });
  });

  const tRef = tid => doc(db, 'tournaments', tid);
  const sub = (tid, name) => collection(db, 'tournaments', tid, name);
  const subDoc = (tid, name, id) => doc(db, 'tournaments', tid, name, id);

  // 書き込みを 400 件ずつに分けてコミット（Firestore のバッチ上限 500 件対策）
  // groups: (batch) => void の配列。1 グループは同じバッチに入る
  async function commitGroups(groups, sizes) {
    let batch = writeBatch(db), count = 0;
    for (let i = 0; i < groups.length; i++) {
      if (count && count + sizes[i] > 400) { await batch.commit(); batch = writeBatch(db); count = 0; }
      groups[i](batch); count += sizes[i];
    }
    if (count) await batch.commit();
  }

  return {
    mode: 'firebase',
    ready,

    listTournaments(cb, onErr) {
      let unsub = () => {}, stopped = false;
      ready.then(() => {
        if (stopped) return;
        unsub = onSnapshot(query(collection(db, 'tournaments'), orderBy('createdAt', 'desc'), limit(50)),
          s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onErr);
      }, onErr);
      return () => { stopped = true; unsub(); };
    },

    watchTournament(tid, cb, onErr) {
      const state = { t: undefined, users: [], bets: [], uid: null, isAdmin: false, adminKey: null };
      let tAdmin = false, tKey = null, siteAdmin = false, fetchedKey = null;
      // サイト管理者は全大会の管理者。大会の管理者キーは private/admin から取得
      const updateAdmin = () => {
        state.isAdmin = tAdmin || siteAdmin;
        state.adminKey = tKey || fetchedKey || null;
        if (siteAdmin && !tKey && fetchedKey === null) {
          fetchedKey = '';
          getDoc(subDoc(tid, 'private', 'admin')).then(s => { fetchedKey = s.exists() ? s.data().key : ''; updateAdmin(); emit(); }, () => {});
        }
      };
      const unsubs = [];
      let stopped = false;
      const emit = () => { if (state.t !== undefined) cb({ ...state }); };
      ready.then(u => {
        if (stopped) return;
        state.uid = u;
        unsubs.push(onSnapshot(tRef(tid), s => { state.t = s.exists() ? { id: s.id, ...s.data() } : null; emit(); }, onErr));
        unsubs.push(onSnapshot(sub(tid, 'users'), s => { state.users = s.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, onErr));
        unsubs.push(onSnapshot(sub(tid, 'bets'), s => { state.bets = s.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, onErr));
        unsubs.push(onSnapshot(subDoc(tid, 'admins', u), s => {
          tAdmin = s.exists(); tKey = s.exists() ? s.data().key : null; updateAdmin(); emit();
        }, () => {}));
        unsubs.push(onSnapshot(doc(db, 'siteAdmins', u), s => { siteAdmin = s.exists(); updateAdmin(); emit(); }, () => {}));
      }, onErr);
      return () => { stopped = true; unsubs.forEach(f => f()); };
    },

    async createTournament({ name, date, teams, initialPoints, takeout }) {
      await ready;
      const ref = doc(collection(db, 'tournaments'));
      const key = randomHex(12);
      const ents = teams.map(tm => ({ id: randomHex(4), name: tm.name, memberIds: tm.memberIds }));
      const b = writeBatch(db);
      b.set(ref, {
        name, date, status: 'open', takeout, initialPoints, ownerUid: uid,
        entrants: ents, entrantIds: ents.map(e => e.id),
        winnerId: null, finalOdds: null, refunded: false, ranks: null, createdAt: Date.now(),
      });
      b.set(subDoc(ref.id, 'private', 'admin'), { key });
      b.set(subDoc(ref.id, 'admins', uid), { key });
      await b.commit();
      return { id: ref.id, adminKey: key };
    },

    async join(tid, name, initialPoints) {
      await ready;
      await setDoc(subDoc(tid, 'users', uid), { name, points: initialPoints, lastBet: '', joinedAt: Date.now() });
    },

    async placeBet(tid, entrantId, amount) {
      await ready;
      await runTransaction(db, async tx => {
        const uRef = subDoc(tid, 'users', uid);
        const u = await tx.get(uRef);
        const t = await tx.get(tRef(tid));
        if (!u.exists()) throw new Error('先に参加登録してください');
        if (t.data().status !== 'open') throw new Error('投票は締め切られています');
        if (u.data().points < amount) throw new Error('ポイントが足りません');
        const bRef = doc(sub(tid, 'bets'));
        tx.set(bRef, { uid, entrantId, amount, at: Date.now() });
        tx.update(uRef, { points: u.data().points - amount, lastBet: bRef.id });
      });
    },

    async cancelBet(tid, betId) {
      await ready;
      await runTransaction(db, async tx => {
        const uRef = subDoc(tid, 'users', uid), bRef = subDoc(tid, 'bets', betId);
        const u = await tx.get(uRef);
        const bet = await tx.get(bRef);
        if (!bet.exists()) throw new Error('投票が見つかりません');
        tx.delete(bRef);
        tx.update(uRef, { points: u.data().points + bet.data().amount, lastBet: betId });
      });
    },

    async adminLogin(tid, key) {
      await ready;
      try { await setDoc(subDoc(tid, 'admins', uid), { key }); }
      catch (e) { throw new Error('管理者キーが正しくありません'); }
    },
    async adminLogout(tid) { await ready; await deleteDoc(subDoc(tid, 'admins', uid)); },

    async setStatus(tid, status) { await updateDoc(tRef(tid), { status }); },

    async addEntrant(tid, raw, team) {
      const ents = [...raw.t.entrants, { id: randomHex(4), name: team.name, memberIds: team.memberIds }];
      await updateDoc(tRef(tid), { entrants: ents, entrantIds: ents.map(e => e.id) });
    },
    async updateEntrant(tid, raw, entrantId, team) {
      const ents = raw.t.entrants.map(e => e.id === entrantId ? { ...e, name: team.name, memberIds: team.memberIds } : e);
      await updateDoc(tRef(tid), { entrants: ents });
    },

    // 出場者の取消：その出場者への投票を返還して削除
    async removeEntrant(tid, raw, entrantId) {
      const bets = raw.bets.filter(b => b.entrantId === entrantId);
      const groups = bets.map(b => batch => {
        batch.delete(subDoc(tid, 'bets', b.id));
        batch.update(subDoc(tid, 'users', b.uid), { points: increment(b.amount) });
      });
      const ents = raw.t.entrants.filter(e => e.id !== entrantId);
      groups.push(batch => batch.update(tRef(tid), { entrants: ents, entrantIds: ents.map(e => e.id) }));
      await commitGroups(groups, groups.map((_, i) => i < bets.length ? 2 : 1));
    },

    // 結果確定：plan = { winnerId, finalOdds, refunded, payouts: {betId: pt} }
    async settle(tid, raw, plan) {
      if (raw.t.status === 'open') await updateDoc(tRef(tid), { status: 'closed' });
      const groups = [], sizes = [];
      for (const u of raw.users) {
        if (u.settled) continue; // 途中で失敗した場合の再実行用
        const myBets = raw.bets.filter(b => b.uid === u.id);
        if (!myBets.length) continue;
        const gain = myBets.reduce((s, b) => s + plan.payouts[b.id], 0);
        groups.push(batch => {
          batch.update(subDoc(tid, 'users', u.id), { points: increment(gain), settled: true });
          for (const b of myBets) batch.update(subDoc(tid, 'bets', b.id), { payout: plan.payouts[b.id] });
        });
        sizes.push(1 + myBets.length);
      }
      // 戦績を書き込んでから大会を確定（確定後は大会を変更できないため）
      for (const r of plan.records || []) {
        const { id, ...data } = r;
        groups.push(batch => batch.set(doc(db, 'records', id), data));
        sizes.push(1);
      }
      groups.push(batch => batch.update(tRef(tid), {
        status: 'settled', winnerId: plan.winnerId, finalOdds: plan.finalOdds, refunded: plan.refunded, ranks: plan.ranks || null,
      }));
      sizes.push(1);
      await commitGroups(groups, sizes);
    },

    async deleteTournament(tid, raw) {
      const admins = await getDocs(sub(tid, 'admins'));
      const groups = [
        ...raw.bets.map(b => batch => batch.delete(subDoc(tid, 'bets', b.id))),
        ...raw.users.map(u => batch => batch.delete(subDoc(tid, 'users', u.id))),
      ];
      // 最後のバッチで管理者情報と大会本体を削除（管理者判定が先に消えないように）
      groups.push(batch => {
        admins.docs.forEach(d => batch.delete(d.ref));
        batch.delete(subDoc(tid, 'private', 'admin'));
        batch.delete(tRef(tid));
      });
      await commitGroups(groups, groups.map((_, i) => i < groups.length - 1 ? 1 : admins.size + 2));
    },

    // ---------- サイト管理者 ----------
    watchSite(cb) {
      const state = { initialized: null, isSiteAdmin: false, siteKey: null };
      const unsubs = []; let stopped = false;
      ready.then(u => {
        if (stopped) return;
        unsubs.push(onSnapshot(doc(db, 'site', 'meta'), s => { state.initialized = s.exists(); cb({ ...state }); }, () => {}));
        unsubs.push(onSnapshot(doc(db, 'siteAdmins', u), s => {
          state.isSiteAdmin = s.exists(); state.siteKey = s.exists() ? s.data().key : null; cb({ ...state });
        }, () => {}));
      });
      return () => { stopped = true; unsubs.forEach(f => f()); };
    },
    async initSite() {
      await ready;
      const key = randomHex(12);
      const b = writeBatch(db);
      b.set(doc(db, 'site', 'admin'), { key });
      b.set(doc(db, 'site', 'meta'), { initializedAt: Date.now() });
      b.set(doc(db, 'siteAdmins', uid), { key });
      await b.commit();
      return key;
    },
    async siteLogin(key) {
      await ready;
      try { await setDoc(doc(db, 'siteAdmins', uid), { key }); }
      catch (e) { throw new Error('サイト管理者キーが正しくありません'); }
    },
    async siteLogout() { await ready; await deleteDoc(doc(db, 'siteAdmins', uid)); },

    // ---------- メンバー名簿 ----------
    watchMembers(cb, onErr) {
      let unsub = () => {}, stopped = false;
      ready.then(() => {
        if (stopped) return;
        unsub = onSnapshot(collection(db, 'members'), s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onErr);
      });
      return () => { stopped = true; unsub(); };
    },
    async saveMember({ id, name, note, createdAt }) {
      const ref = id ? doc(db, 'members', id) : doc(collection(db, 'members'));
      await setDoc(ref, { name, note: note || '', createdAt: createdAt || Date.now() });
      return ref.id;
    },
    // 複数メンバーを一括登録して ID を返す
    async createMembers(names) {
      const refs = names.map(() => doc(collection(db, 'members')));
      const groups = names.map((n, i) => batch => batch.set(refs[i], { name: n, note: '', createdAt: Date.now() }));
      await commitGroups(groups, groups.map(() => 1));
      return refs.map(r => r.id);
    },
    // メンバーと、そのメンバーの戦績をまとめて削除
    async deleteMember(id) {
      const recs = await getDocs(query(collection(db, 'records'), where('memberId', '==', id)));
      const groups = recs.docs.map(d => batch => batch.delete(d.ref));
      groups.push(batch => batch.delete(doc(db, 'members', id)));
      await commitGroups(groups, groups.map(() => 1));
    },

    // ---------- 戦績 ----------
    // memberIds を省略すると全件
    async getRecords(memberIds) {
      await ready;
      const col = collection(db, 'records');
      if (!memberIds) return (await getDocs(col)).docs.map(d => ({ id: d.id, ...d.data() }));
      const out = [];
      for (let i = 0; i < memberIds.length; i += 30) {
        const s = await getDocs(query(col, where('memberId', 'in', memberIds.slice(i, i + 30))));
        out.push(...s.docs.map(d => ({ id: d.id, ...d.data() })));
      }
      return out;
    },
    async saveRecord(rec) {
      const { id, ...data } = rec;
      const ref = id ? doc(db, 'records', id) : doc(collection(db, 'records'));
      await setDoc(ref, { ...data, createdAt: data.createdAt || Date.now() });
    },
    async deleteRecord(id) { await deleteDoc(doc(db, 'records', id)); },
  };
}

export { UNIT };

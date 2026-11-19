// Firebase（Firestore + 匿名認証）バックエンド
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot, query, orderBy, limit, writeBatch,
  runTransaction, setDoc, updateDoc, deleteDoc, getDocs, increment,
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
          state.isAdmin = s.exists(); state.adminKey = s.exists() ? s.data().key : null; emit();
        }, () => {}));
      }, onErr);
      return () => { stopped = true; unsubs.forEach(f => f()); };
    },

    async createTournament({ name, entrants, initialPoints, takeout }) {
      await ready;
      const ref = doc(collection(db, 'tournaments'));
      const key = randomHex(12);
      const ents = entrants.map(n => ({ id: randomHex(4), name: n }));
      const b = writeBatch(db);
      b.set(ref, {
        name, status: 'open', takeout, initialPoints, ownerUid: uid,
        entrants: ents, entrantIds: ents.map(e => e.id),
        winnerId: null, finalOdds: null, refunded: false, createdAt: Date.now(),
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

    async addEntrant(tid, raw, name) {
      const ents = [...raw.t.entrants, { id: randomHex(4), name }];
      await updateDoc(tRef(tid), { entrants: ents, entrantIds: ents.map(e => e.id) });
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
      groups.push(batch => batch.update(tRef(tid), {
        status: 'settled', winnerId: plan.winnerId, finalOdds: plan.finalOdds, refunded: plan.refunded,
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
  };
}

export { UNIT };

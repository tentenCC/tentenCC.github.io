// 大会オッズ - 画面
import { firebaseConfig } from './firebase-config.js';
import {
  UNIT, calcOdds, buildView, computeSettlement, parseTeams, splitNames,
  rankLabel, memberStats, sortRecords, buildRecords,
} from './common.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString('ja-JP');
const fmtOdds = o => o == null ? '—' : o.toFixed(1);
const fmtAvg = a => a == null ? '—' : a.toFixed(1) + '位';
const STATUS = { open: '投票受付中', closed: '締切', settled: '確定' };
const cleanName = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// ---------- バックエンド選択 ----------
// URL に ?demo=1 を付けると Firebase 設定があってもデモモードで動く（動作確認用）
const forceDemo = new URLSearchParams(location.search).has('demo');
let backend;
try {
  if (firebaseConfig.projectId && !forceDemo) {
    const m = await import('./backend-firebase.js');
    backend = m.createFirebaseBackend(firebaseConfig);
    await backend.ready;
  } else {
    const m = await import('./backend-local.js');
    backend = m.createLocalBackend();
    $('#demoBar').hidden = false;
  }
} catch (e) {
  console.error(e);
  $('#app').innerHTML = `<div class="card empty">Firebase に接続できませんでした。<br>${esc(e.message)}<br><br>
    firebase-config.js の設定と、Firebase コンソールで「匿名認証」が有効になっているか確認してください。</div>`;
  throw e;
}

function errMsg(e) {
  if (e && e.code === 'permission-denied') return '操作が許可されませんでした（権限がないか、状態が変わった可能性があります）';
  return (e && e.message) || 'エラーが発生しました';
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------- サイト全体の状態（管理者・名簿） ----------
let SITE = { initialized: null, isSiteAdmin: false, siteKey: null };
let MEMBERS = [];
let MEMBER_BY_ID = {};
let pageRefresh = () => {};   // サイト状態・名簿が変わったときに今のページを更新する関数

backend.watchSite(s => {
  SITE = s;
  $('#navAdmin').textContent = s.isSiteAdmin ? '管理 ✓' : '管理';
  pageRefresh();
});
backend.watchMembers(list => {
  MEMBERS = list.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  MEMBER_BY_ID = Object.fromEntries(list.map(m => [m.id, m]));
  pageRefresh();
}, e => console.error(e));

const memberName = id => (MEMBER_BY_ID[id] || { name: '(削除されたメンバー)' }).name;

// 名前の一覧をメンバー ID に変換。名簿にない名前は（サイト管理者なら）確認のうえ新規登録
async function resolveMembers(names) {
  const byName = {};
  for (const m of MEMBERS) if (!(m.name in byName)) byName[m.name] = m.id;
  const unknown = [...new Set(names.filter(n => !(n in byName)))];
  if (unknown.length) {
    if (!SITE.isSiteAdmin) throw new Error(`名簿にないメンバーがいます：${unknown.join('、')}（サイト管理者が名簿に登録してください）`);
    if (!confirm(`名簿にない次の名前を、新しいメンバーとして登録します。\n\n${unknown.join('、')}\n\nよろしいですか？`)) return null;
    const ids = await backend.createMembers(unknown);
    unknown.forEach((n, i) => { byName[n] = ids[i]; });
  }
  return names.map(n => byName[n]);
}

// ---------- モーダル ----------
function openModal(html) {
  $('#modalBox').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

// ---------- ルーティング ----------
let unwatch = () => {};
function route() {
  unwatch(); unwatch = () => {}; pageRefresh = () => {};
  closeModal();
  const h = location.hash;
  let m, nav = 'home';
  if ((m = h.match(/^#\/t\/([A-Za-z0-9]+)/))) showTournament(m[1]);
  else if ((m = h.match(/^#\/m\/([A-Za-z0-9]+)/))) { nav = 'members'; showMember(m[1]); }
  else if (h.startsWith('#/members')) { nav = 'members'; showMembers(); }
  else if (h.startsWith('#/admin')) { nav = 'admin'; showSiteAdmin(); }
  else showHome();
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === nav));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- トップ（大会一覧・作成） ----------
function showHome() {
  $('#app').innerHTML = `
  <div class="grid">
    <div class="col">
      <div class="card"><h2>大会一覧</h2><ul class="list" id="tList"><li class="empty">読み込み中…</li></ul></div>
      <div class="card">
        <h2>しくみ</h2>
        <p class="hint" style="font-size:13px">
          参加者は持ちポイントを使って「優勝すると思うチーム」に投票します（${UNIT}pt 単位）。<br>
          オッズは競馬の単勝と同じ<b>パリミュチュエル方式</b>で、投票が集まるたびにリアルタイムに変動します。<br>
          <b>オッズ ＝ 総投票額 ×（1 − 控除率）÷ そのチームへの投票額</b>（0.1 倍未満切り捨て・最低 1.0 倍）<br>
          大会終了後に管理者が順位を確定すると、的中した投票に「投票額 × 確定オッズ」が払い戻され、メンバーの戦績にも記録されます。的中者がいない場合は全額返還です。
        </p>
      </div>
    </div>
    <div class="col"><div class="card" id="createCard"></div></div>
  </div>`;
  const renderCreate = () => {
    const card = $('#createCard'); if (!card) return;
    if (!SITE.isSiteAdmin) {
      card.dataset.mode = '';
      card.innerHTML = `<h2>大会を作成</h2><p class="hint">大会の作成はサイト管理者のみ行えます。<a href="#/admin">管理</a>からログインしてください。</p>`;
      return;
    }
    if (card.dataset.mode === 'form') return;
    card.dataset.mode = 'form';
    card.innerHTML = `
      <h2>大会を作成</h2>
      <form id="createForm">
        <label for="cName">大会名</label>
        <input type="text" id="cName" maxlength="60" placeholder="例：社内ボウリング大会 2026" required>
        <label for="cDate">開催日</label>
        <input type="date" id="cDate" value="${today()}">
        <label for="cTeams">チームとメンバー（1 行に 1 チーム）</label>
        <textarea id="cTeams" placeholder="チームA：山田、佐藤、鈴木&#10;チームB：田中、高橋&#10;チームC：伊藤、渡辺、中村"></textarea>
        <p class="hint">「チーム名：メンバー、メンバー」の形式で入力します。名簿にない名前は新しいメンバーとして登録されます。</p>
        <div class="row">
          <div><label for="cPoints">初期ポイント</label><input type="number" id="cPoints" value="1000" min="100" step="100"></div>
          <div><label for="cTake">控除率（%）</label><input type="number" id="cTake" value="0" min="0" max="50" step="1"></div>
        </div>
        <p class="hint">控除率 0% なら投票ポイントが全額払い戻しに回ります。競馬（単勝）は約 20%。</p>
        <button class="primary wide" style="margin-top:12px">作成する</button>
        <div class="err" id="cErr"></div>
      </form>`;
    $('#createForm').onsubmit = async ev => {
      ev.preventDefault(); $('#cErr').textContent = '';
      const name = cleanName($('#cName').value, 60);
      const teams = parseTeams($('#cTeams').value);
      const initialPoints = Math.floor(Number($('#cPoints').value));
      const takeout = Math.round(Number($('#cTake').value)) / 100;
      const fail = msg => { $('#cErr').textContent = msg; };
      if (!name) return fail('大会名を入力してください');
      if (teams.length < 2) return fail('チームは 2 つ以上必要です');
      if (teams.length > 200) return fail('チームは 200 までです');
      if (new Set(teams.map(t => t.name)).size !== teams.length) return fail('同じ名前のチームがあります');
      if (!(initialPoints >= UNIT && initialPoints <= 1e7)) return fail(`初期ポイントは ${UNIT}〜10,000,000 で指定してください`);
      if (!(takeout >= 0 && takeout <= 0.5)) return fail('控除率は 0〜50% で指定してください');
      const btn = ev.submitter; if (btn) btn.disabled = true;
      try {
        const allNames = teams.flatMap(t => t.members);
        const ids = await resolveMembers(allNames);
        if (!ids) { if (btn) btn.disabled = false; return; }
        let i = 0;
        const withIds = teams.map(t => ({ name: t.name, memberIds: t.members.map(() => ids[i++]) }));
        const r = await backend.createTournament({ name, date: $('#cDate').value || '', teams: withIds, initialPoints, takeout });
        justCreated = r.id;
        location.hash = '#/t/' + r.id;
      } catch (e) { fail(errMsg(e)); if (btn) btn.disabled = false; }
    };
  };
  renderCreate();
  pageRefresh = renderCreate;
  unwatch = backend.listTournaments(list => {
    const el = $('#tList'); if (!el) return;
    el.innerHTML = list.length ? list.map(t => `
      <li>
        <a href="#/t/${esc(t.id)}">${esc(t.name)}</a>
        <span class="meta">${t.date ? esc(t.date) + ' ／ ' : ''}${t.entrants.length} チーム</span>
        <span class="badge ${esc(t.status)}">${STATUS[t.status] || ''}</span>
      </li>`).join('') : '<li class="empty">まだ大会がありません。</li>';
  }, e => { const el = $('#tList'); if (el) el.innerHTML = `<li class="empty">${esc(errMsg(e))}</li>`; });
}

// ---------- 大会ページ ----------
let RAW = null;        // バックエンドの生データ
let T = null;          // 表示用データ
let selected = null;   // 選択中のチーム ID
let tid = null;
let justCreated = null;
let adminSig = '';     // 管理者メニューの再描画判定用

function showTournament(id) {
  tid = id; RAW = null; T = null; selected = null; adminSig = ''; betFormBuilt = false;
  $('#app').innerHTML = `
  <div class="grid">
    <div class="col">
      <div class="card" id="boardCard"><div class="empty">読み込み中…</div></div>
      <div class="card"><h2>ポイントランキング</h2><div id="ranking"></div></div>
    </div>
    <div class="col">
      <div class="card" id="betCard"></div>
      <div class="card" id="myBetsCard" hidden><h2>あなたの投票</h2><ul class="list mybets" id="myBets"></ul></div>
      <div class="card adminBox" id="adminCard" hidden></div>
      <div class="card" id="adminLogin" hidden></div>
    </div>
  </div>`;
  unwatch = backend.watchTournament(id, raw => {
    if (id !== tid) return;
    if (!raw.t) {
      $('#app').innerHTML = '<div class="card empty">大会が見つかりません<br><br><a href="#/">大会一覧へ戻る</a></div>';
      return;
    }
    RAW = raw; T = buildView(raw);
    renderAll();
    if (justCreated === id) { justCreated = null; toast('大会を作成しました。管理者キーを控えておいてください'); }
  }, e => toast(errMsg(e)));
  pageRefresh = () => { if (T) renderAll(); };
}

function renderAll() {
  if (!$('#boardCard')) return;
  renderBoard(); renderBet(); renderMyBets(); renderRanking(); renderAdmin(); renderAdminLogin();
}

function renderBoard() {
  const t = T;
  if (selected && !t.entrants.some(e => e.id === selected)) selected = null;
  const maxVotes = Math.max(1, ...t.entrants.map(e => e.votes));
  const minOdds = Math.min(...t.entrants.map(e => e.odds ?? Infinity));
  const winner = t.entrants.find(e => e.id === t.winnerId);
  const canPick = t.status === 'open' && !!t.me;
  const ranks = RAW.t.ranks || {};
  const memberIdsOf = id => (RAW.t.entrants.find(e => e.id === id) || {}).memberIds || [];
  $('#boardCard').innerHTML = `
    <div class="tHead">
      <h2>${esc(t.name)}</h2>
      <span class="badge ${t.status}">${STATUS[t.status]}</span>
    </div>
    <div class="stats">
      ${RAW.t.date ? `<span>開催日 <b>${esc(RAW.t.date)}</b></span>` : ''}
      <span>総投票 <b>${fmt(t.pool)}</b> pt</span>
      <span>投票数 <b>${fmt(t.betCount)}</b></span>
      <span>参加者 <b>${fmt(t.userCount)}</b></span>
      <span>控除率 <b>${Math.round(t.takeout * 100)}</b>%</span>
    </div>
    ${winner ? `<div class="result" style="margin-top:12px">🏆 優勝：<b>${esc(winner.name)}</b>
      ${t.refunded ? '（的中者なしのため全額返還）' : `　単勝 <b>${fmtOdds(winner.odds)}</b> 倍`}</div>` : ''}
    <table class="board">
      <thead><tr><th>番</th><th>チーム</th><th style="text-align:right">オッズ</th><th style="text-align:center">${t.status === 'settled' ? '順位' : '人気'}</th>
        <th class="hideSm">支持率</th><th class="hideSm" style="text-align:right">投票額</th></tr></thead>
      <tbody>
      ${t.entrants.map((e, i) => {
        const mids = memberIdsOf(e.id);
        return `
        <tr data-id="${esc(e.id)}" class="${canPick ? 'pick' : 'view'} ${e.id === selected ? 'sel' : ''} ${e.id === t.winnerId ? 'win' : ''}">
          <td><span class="num">${i + 1}</span></td>
          <td class="ename">${e.id === t.winnerId ? '🏆 ' : ''}${esc(e.name)}<span class="info">メンバー・戦績</span>
            ${mids.length ? `<span class="members">${mids.map(m => esc(memberName(m))).join('、')}</span>` : ''}</td>
          <td class="odds ${e.odds == null ? 'none' : e.odds === minOdds ? 'fav' : ''}">${fmtOdds(e.odds)}</td>
          ${t.status === 'settled'
            ? `<td class="pop ${ranks[e.id] === 1 ? 'p1' : ''}">${ranks[e.id] ? rankLabel(ranks[e.id]) : '—'}</td>`
            : `<td class="pop ${e.popularity === 1 ? 'p1' : ''}">${e.popularity ? e.popularity + '番人気' : '—'}</td>`}
          <td class="hideSm"><div class="bar"><span style="width:${(e.votes / maxVotes * 100).toFixed(1)}%"></span></div>
            <div class="votes" style="text-align:left">${(e.share * 100).toFixed(1)}%</div></td>
          <td class="votes hideSm">${fmt(e.votes)}pt<br>${e.bettors}人</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>
    <p class="hint">チームをクリックすると、メンバーと過去の戦績を確認できます${canPick ? '（そこから投票先に選べます）' : ''}。オッズはリアルタイムに更新されます。</p>
    ${t.status === 'open' && !t.me ? '<p class="hint">投票するには参加登録してください。</p>' : ''}`;
  $('#boardCard').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openTeamModal(tr.dataset.id));
}

// チームのメンバー・戦績ポップアップ
async function openTeamModal(eid) {
  const e = T.entrants.find(x => x.id === eid); if (!e) return;
  const mids = (RAW.t.entrants.find(x => x.id === eid) || {}).memberIds || [];
  const canPick = T.status === 'open' && !!T.me;
  const head = `
    <div class="modal-head">
      <h2>${esc(e.name)}</h2>
      <button class="small" data-close>✕</button>
    </div>
    <div class="chips">
      <span class="chip">オッズ ${fmtOdds(e.odds)} 倍</span>
      ${e.popularity ? `<span class="chip">${e.popularity}番人気</span>` : ''}
      <span class="chip">投票 ${fmt(e.votes)}pt</span>
      <span class="chip">メンバー ${mids.length}人</span>
    </div>`;
  const foot = `
    <div class="modal-foot">
      <button data-close>閉じる</button>
      ${canPick ? '<button class="primary" id="pickTeam">このチームに投票する</button>' : ''}
    </div>`;
  const bindFoot = () => {
    const b = $('#pickTeam'); if (!b) return;
    b.onclick = () => {
      selected = eid; closeModal(); renderBoard(); updateSelection();
      $('#betCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const a = $('#amount'); if (a) a.focus();
    };
  };
  if (!mids.length) {
    openModal(head + '<p class="empty">このチームにはメンバーが登録されていません。</p>' + foot);
    return bindFoot();
  }
  openModal(head + '<p class="empty">戦績を読み込み中…</p>' + foot); bindFoot();
  let recs = [];
  try { recs = await backend.getRecords(mids); }
  catch (err) { toast(errMsg(err)); }
  if ($('#modal').hidden) return;
  const cards = mids.map(mid => {
    const m = MEMBER_BY_ID[mid];
    const mine = sortRecords(recs.filter(r => r.memberId === mid));
    const st = memberStats(mine);
    return `
      <div class="mcard">
        <div class="top">
          <span class="nm">${m ? `<a href="#/m/${esc(mid)}">${esc(m.name)}</a>` : '(削除されたメンバー)'}</span>
          ${m && m.note ? `<span class="note">${esc(m.note)}</span>` : ''}
        </div>
        <div class="chips">
          <span class="chip">出場 ${st.count}回</span>
          <span class="chip ${st.wins ? 'gold' : ''}">優勝 ${st.wins}回</span>
          <span class="chip">最高 ${st.best ? rankLabel(st.best) : '—'}</span>
          <span class="chip">平均 ${fmtAvg(st.avg)}</span>
        </div>
        ${mine.length ? `
        <table class="rec">
          <thead><tr><th>日付</th><th>大会</th><th>チーム</th><th>順位</th></tr></thead>
          <tbody>${mine.slice(0, 5).map(recRow).join('')}</tbody>
        </table>
        ${mine.length > 5 ? `<div class="hint" style="text-align:right"><a href="#/m/${esc(mid)}">すべての戦績（${mine.length}件）を見る</a></div>` : ''}`
        : '<div class="hint">戦績はまだありません</div>'}
      </div>`;
  }).join('');
  openModal(head + cards + foot); bindFoot();
}
const recRow = r => `<tr>
  <td>${esc(r.date || '—')}</td>
  <td>${r.tournamentId ? `<a href="#/t/${esc(r.tournamentId)}">${esc(r.tournamentName)}</a>` : esc(r.tournamentName)}</td>
  <td>${esc(r.teamName || '—')}</td>
  <td class="rk ${r.rank === 1 ? 'r1' : ''}">${rankLabel(r.rank)}${r.teamCount ? `<span class="hint"> / ${r.teamCount}</span>` : ''}</td></tr>`;

let betFormBuilt = false;
function renderBet() {
  const t = T, card = $('#betCard');
  if (!t.me) {
    betFormBuilt = false;
    const mode = t.status === 'settled' ? 'joinClosed' : 'join';
    if (card.dataset.mode === mode) return;
    card.dataset.mode = mode;
    if (mode === 'joinClosed') { card.innerHTML = '<h2>参加</h2><p class="hint">この大会は確定済みです。</p>'; return; }
    card.innerHTML = `
      <h2>参加登録</h2>
      <p class="hint">ニックネームを登録すると ${fmt(t.initialPoints)}pt が配られます。登録はこのブラウザに保存されます。</p>
      <form id="joinForm">
        <label for="jName">ニックネーム</label>
        <input type="text" id="jName" maxlength="30" required>
        <button class="primary wide" style="margin-top:10px">参加する</button>
        <div class="err" id="jErr"></div>
      </form>`;
    $('#joinForm').onsubmit = async ev => {
      ev.preventDefault();
      const name = cleanName($('#jName').value, 30);
      if (!name) return ($('#jErr').textContent = 'ニックネームを入力してください');
      if (RAW.users.some(u => u.name === name)) return ($('#jErr').textContent = 'そのニックネームは既に使われています');
      try { await backend.join(tid, name, T.initialPoints); toast('参加登録しました'); }
      catch (e) { $('#jErr').textContent = errMsg(e); }
    };
    return;
  }
  card.dataset.mode = 'bet';
  if (!betFormBuilt) {
    betFormBuilt = true;
    card.innerHTML = `
      <h2>投票</h2>
      <div class="hint" id="meName"></div>
      <div class="balance" id="balance"></div>
      <div id="betBody"></div>`;
  }
  $('#meName').textContent = `${t.me.name} さんの持ちポイント`;
  $('#balance').innerHTML = `${fmt(t.me.points)} <small>pt</small>`;
  const body = $('#betBody');
  if (t.status !== 'open') {
    body.dataset.mode = 'closed';
    body.innerHTML = `<p class="hint">${t.status === 'closed' ? '投票は締め切られました。結果発表をお待ちください。' : '結果が確定しました。'}</p>`;
    return;
  }
  if (body.dataset.mode !== 'open') {
    body.dataset.mode = 'open';
    body.innerHTML = `
      <label>投票先</label>
      <div class="selName" id="selName"></div>
      <label for="amount">投票ポイント（${UNIT}pt 単位）</label>
      <input type="number" id="amount" value="${UNIT}" min="${UNIT}" step="${UNIT}">
      <div class="quick">
        <button type="button" data-add="100">+100</button><button type="button" data-add="500">+500</button>
        <button type="button" data-add="1000">+1000</button><button type="button" data-add="all">全部</button>
        <button type="button" data-add="reset">リセット</button>
      </div>
      <div class="est" id="est"></div>
      <button class="primary wide" id="betBtn" style="margin-top:10px">この内容で投票する</button>
      <div class="err" id="bErr"></div>`;
    body.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      const a = $('#amount'), v = b.dataset.add, cur = Number(a.value) || 0;
      a.value = v === 'all' ? Math.floor(T.me.points / UNIT) * UNIT : v === 'reset' ? UNIT : cur + Number(v);
      updateSelection();
    });
    $('#amount').oninput = updateSelection;
    $('#betBtn').onclick = placeBet;
  }
  updateSelection();
}

let betting = false;
function updateSelection() {
  const t = T; if (!t || !t.me || !$('#selName')) return;
  const e = t.entrants.find(x => x.id === selected);
  $('#selName').innerHTML = e ? esc(e.name) : '<span class="hint">オッズ表のチームをクリックして選んでください</span>';
  const amount = Number($('#amount').value) || 0;
  const valid = e && amount >= UNIT && amount % UNIT === 0 && amount <= t.me.points;
  $('#betBtn').disabled = !valid || betting;
  if (!e || amount <= 0) { $('#est').innerHTML = '投票先と金額を選ぶと、払戻の目安が表示されます。'; return; }
  const after = calcOdds(t.pool + amount, e.votes + amount, t.takeout);
  $('#est').innerHTML = `
    現在のオッズ：<b>${fmtOdds(e.odds)}</b> 倍<br>
    投票後の推定オッズ：<b>${fmtOdds(after)}</b> 倍<br>
    的中時の推定払戻：<b>${fmt(Math.floor(amount * after))}</b> pt
    <div class="hint">※ オッズは締切まで変動します。払戻は確定時のオッズで計算されます。</div>
    ${amount > t.me.points ? '<div class="err">ポイントが足りません</div>' : ''}
    ${amount % UNIT ? `<div class="err">${UNIT}pt 単位で指定してください</div>` : ''}`;
}

async function placeBet() {
  const amount = Number($('#amount').value);
  const e = T.entrants.find(x => x.id === selected);
  $('#bErr').textContent = '';
  betting = true; updateSelection();
  try {
    await backend.placeBet(tid, selected, amount);
    toast(`${e.name} に ${fmt(amount)}pt 投票しました`);
    if ($('#amount')) $('#amount').value = UNIT;
  } catch (err) { if ($('#bErr')) $('#bErr').textContent = errMsg(err); }
  betting = false; updateSelection();
}

function renderMyBets() {
  const t = T, card = $('#myBetsCard');
  if (!t.me || !t.me.bets.length) { card.hidden = true; return; }
  card.hidden = false;
  const ent = id => t.entrants.find(e => e.id === id);
  const total = t.me.bets.reduce((s, b) => s + b.amount, 0);
  $('#myBets').innerHTML = t.me.bets.slice().reverse().map(b => `
    <li>
      <span>${esc((ent(b.entrantId) || { name: '(取消)' }).name)}</span>
      <span class="amt">${fmt(b.amount)}pt
        ${t.status === 'settled'
          ? (b.payout ? ` → <span class="hit">${fmt(b.payout)}pt</span>` : ' → 0pt')
          : ` <span class="hint">(現在 ${fmtOdds((ent(b.entrantId) || {}).odds)}倍)</span>`}
      </span>
      ${t.status === 'open' ? `<button class="small danger" data-cancel="${esc(b.id)}">取消</button>` : ''}
    </li>`).join('') + `<li style="font-weight:700"><span>合計</span><span class="amt">${fmt(total)}pt</span></li>`;
  card.querySelectorAll('[data-cancel]').forEach(btn => btn.onclick = async () => {
    btn.disabled = true;
    try { await backend.cancelBet(tid, btn.dataset.cancel); toast('投票を取り消しました'); }
    catch (e) { toast(errMsg(e)); btn.disabled = false; }
  });
}

function renderRanking() {
  const r = T.ranking, meId = T.me && T.me.id;
  $('#ranking').innerHTML = r.length ? `
    <table class="rank">
      ${r.map((u, i) => `<tr style="${u.id === meId ? 'background:#f0fdf4;font-weight:700' : ''}">
        <td style="width:2em">${i + 1}</td><td>${esc(u.name)}</td>
        <td class="r">${fmt(u.total)}pt</td>
        <td class="r hint">${T.status === 'settled' ? (u.total - T.initialPoints >= 0 ? '+' : '') + fmt(u.total - T.initialPoints) : '投票中 ' + fmt(u.staked)}</td>
      </tr>`).join('')}
    </table>
    ${T.status !== 'settled' ? '<p class="hint">確定前は「持ちポイント＋投票中ポイント」で表示しています。</p>' : ''}`
    : '<div class="empty">まだ参加者がいません</div>';
}

// ---------- 大会の管理者 ----------
function renderAdminLogin() {
  const box = $('#adminLogin');
  if (RAW.isAdmin) { box.hidden = true; box.dataset.built = ''; return; }
  box.hidden = false;
  if (box.dataset.built) return;
  box.dataset.built = '1';
  box.innerHTML = `
    <details><summary style="cursor:pointer;font-size:13px">この大会の管理者としてログイン</summary>
      <label for="akey">大会の管理者キー</label>
      <input type="password" id="akey">
      <button class="wide" id="akeyBtn" style="margin-top:8px">ログイン</button>
      <div class="err" id="akeyErr"></div>
    </details>`;
  $('#akeyBtn').onclick = async () => {
    try { await backend.adminLogin(tid, $('#akey').value.trim()); toast('管理者としてログインしました'); }
    catch (e) { $('#akeyErr').textContent = errMsg(e); }
  };
}

function renderAdmin() {
  const card = $('#adminCard');
  if (!RAW.isAdmin) { card.hidden = true; adminSig = ''; return; }
  card.hidden = false;
  // 入力中の値が消えないよう、状態・チーム構成が変わったときだけ作り直す
  const sig = JSON.stringify([T.status, RAW.adminKey, RAW.t.entrants, SITE.isSiteAdmin]);
  if (sig === adminSig) return;
  adminSig = sig;
  const url = location.origin + location.pathname + '#/t/' + tid;
  const t = T;
  const opts = t.entrants.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  card.innerHTML = `
    <h2>🔧 大会の管理</h2>
    <h3>参加者に共有する URL</h3>
    <div class="keyBox">${esc(url)}</div>
    <h3>大会の管理者キー（この大会だけを他の人・端末で管理する場合に使用）</h3>
    <div class="keyBox">${esc(RAW.adminKey || '（取得中）')}</div>
    ${t.status === 'settled' ? '<p class="hint" style="margin-top:12px">この大会は確定済みです。戦績の修正はメンバーのページから行えます（サイト管理者）。</p>' : `
      <h3>投票の受付</h3>
      ${t.status === 'open'
        ? '<button class="wide" id="admClose">投票を締め切る</button>'
        : '<button class="wide" id="admOpen">投票を再開する</button>'}
      <h3>チームの編集・追加</h3>
      <select id="teamSel"><option value="">＋ 新しいチームを追加</option>${opts}</select>
      <input type="text" id="teamName" maxlength="40" placeholder="チーム名" style="margin-top:6px">
      <input type="text" id="teamMembers" placeholder="メンバー（「、」区切り）" style="margin-top:6px">
      <button class="wide" id="teamSave" style="margin-top:6px">チームを追加</button>
      <button class="wide danger" id="admRemove" style="margin-top:6px" hidden>このチームを取消（投票は返還）</button>
      <h3>結果の確定（順位の入力）</h3>
      <table class="rec" id="rankTable">
        <thead><tr><th>チーム</th><th style="text-align:right">順位</th></tr></thead>
        <tbody>${t.entrants.map(e => `<tr><td>${esc(e.name)}</td>
          <td style="text-align:right"><input type="number" class="rankIn" data-rank="${esc(e.id)}" min="1" max="${t.entrants.length}" step="1" placeholder="—"></td></tr>`).join('')}</tbody>
      </table>
      <label class="row" style="font-weight:400;gap:6px;flex-wrap:nowrap"><input type="checkbox" id="recOn" checked style="flex:0">
        <span>メンバーの戦績に記録する</span></label>
      <button class="primary wide" id="admSettle" style="margin-top:6px">順位を確定して払い戻す</button>
      <p class="hint">1位のチームが優勝として払い戻しの対象になります。順位を空欄にしたチームは戦績に記録しません。確定すると取り消せません（受付中の場合は自動で締め切ります）。</p>`}
    <h3>大会の削除</h3>
    <button class="danger wide" id="admDel">この大会を削除する</button>
    <p class="hint">メンバーの戦績は削除されずに残ります。</p>
    <div class="err" id="admErr"></div>
    ${SITE.isSiteAdmin ? '<p class="hint">サイト管理者としてログイン中のため、この大会を管理できます。</p>'
      : '<button class="small" id="admLogout" style="margin-top:12px">この端末の大会管理者権限を外す</button>'}`;

  const run = async (fn, msg) => {
    $('#admErr').textContent = '';
    try { await fn(); if (msg) toast(msg); } catch (e) { $('#admErr').textContent = errMsg(e); }
  };
  const on = (id, f) => { const el = $('#' + id); if (el) el.onclick = f; };
  on('admClose', () => run(() => backend.setStatus(tid, 'closed'), '投票を締め切りました'));
  on('admOpen', () => run(() => backend.setStatus(tid, 'open'), '投票を再開しました'));

  // チーム編集
  const teamSel = $('#teamSel');
  if (teamSel) {
    teamSel.onchange = () => {
      const e = RAW.t.entrants.find(x => x.id === teamSel.value);
      $('#teamName').value = e ? e.name : '';
      $('#teamMembers').value = e ? (e.memberIds || []).map(memberName).join('、') : '';
      $('#teamSave').textContent = e ? 'チームを更新' : 'チームを追加';
      $('#admRemove').hidden = !e;
    };
  }
  on('teamSave', () => {
    const id = teamSel.value;
    const name = cleanName($('#teamName').value, 40);
    if (!name) return ($('#admErr').textContent = 'チーム名を入力してください');
    if (RAW.t.entrants.some(e => e.name === name && e.id !== id)) return ($('#admErr').textContent = '同名のチームがあります');
    run(async () => {
      const memberIds = await resolveMembers(splitNames($('#teamMembers').value));
      if (!memberIds) return;
      if (id) await backend.updateEntrant(tid, RAW, id, { name, memberIds });
      else await backend.addEntrant(tid, RAW, { name, memberIds });
      toast(id ? 'チームを更新しました' : 'チームを追加しました');
    });
  });
  on('admRemove', () => {
    const e = RAW.t.entrants.find(x => x.id === teamSel.value); if (!e) return;
    if (T.entrants.length <= 2) return ($('#admErr').textContent = 'チームは 2 つ以上必要です');
    if (!confirm(`「${e.name}」を取消します。このチームへの投票は全額返還されます。よろしいですか？`)) return;
    run(() => backend.removeEntrant(tid, RAW, e.id), 'チームを取消しました');
  });

  // 順位確定
  on('admSettle', () => {
    const n = T.entrants.length;
    const ranks = {};
    for (const inp of document.querySelectorAll('[data-rank]')) {
      if (inp.value === '') continue;
      const r = Number(inp.value);
      if (!Number.isInteger(r) || r < 1 || r > n) return ($('#admErr').textContent = `順位は 1〜${n} の整数で入力してください`);
      ranks[inp.dataset.rank] = r;
    }
    const firsts = Object.keys(ranks).filter(id => ranks[id] === 1);
    if (firsts.length !== 1) return ($('#admErr').textContent = '1位（優勝）のチームを 1 つだけ入力してください');
    const winnerId = firsts[0];
    const e = T.entrants.find(x => x.id === winnerId);
    const records = $('#recOn').checked ? buildRecords({ ...RAW.t, id: tid }, ranks) : [];
    const lines = T.entrants.filter(x => ranks[x.id]).sort((a, b) => ranks[a.id] - ranks[b.id])
      .map(x => `${rankLabel(ranks[x.id])}：${x.name}`).join('\n');
    if (!confirm(`次の内容で確定します。取り消せません。\n\n${lines}\n\n優勝「${e.name}」の単勝オッズ：${fmtOdds(e.odds)} 倍\n戦績に記録：${records.length} 件\n\nよろしいですか？`)) return;
    run(() => backend.settle(tid, RAW, { ...computeSettlement(RAW, winnerId), ranks, records }), '結果を確定しました');
  });

  on('admDel', () => {
    if (!confirm(`大会「${T.name}」を削除します。元に戻せません。よろしいですか？`)) return;
    const id = tid, raw = RAW;
    run(async () => {
      unwatch(); unwatch = () => {};
      try { await backend.deleteTournament(id, raw); }
      catch (e) { route(); throw e; }
      location.hash = '#/';
    }, '大会を削除しました');
  });
  on('admLogout', () => {
    if (!confirm('この端末から大会の管理者権限を外します。管理者キーを控えていますか？')) return;
    run(() => backend.adminLogout(tid));
  });
}

// ---------- メンバー一覧 ----------
let RECORDS_ALL = null;
async function showMembers() {
  RECORDS_ALL = null;
  $('#app').innerHTML = `
  <div class="grid">
    <div class="col">
      <div class="card">
        <h2 id="mTitle">メンバー</h2>
        <input type="text" id="mSearch" placeholder="名前・メモで検索">
        <div id="mList" style="margin-top:10px;overflow-x:auto"><div class="empty">読み込み中…</div></div>
      </div>
    </div>
    <div class="col"><div class="card" id="mAdd"></div></div>
  </div>`;
  const render = () => {
    if (!$('#mList')) return;
    $('#mTitle').textContent = `メンバー（${MEMBERS.length}名）`;
    const q = $('#mSearch').value.trim();
    const byMember = {};
    for (const r of RECORDS_ALL || []) (byMember[r.memberId] ||= []).push(r);
    const rows = MEMBERS.filter(m => !q || m.name.includes(q) || (m.note || '').includes(q))
      .map(m => ({ m, st: memberStats(byMember[m.id] || []) }))
      .sort((a, b) => b.st.wins - a.st.wins || b.st.count - a.st.count || a.m.name.localeCompare(b.m.name, 'ja'));
    $('#mList').innerHTML = !MEMBERS.length ? '<div class="empty">まだメンバーが登録されていません</div>' : `
      <table class="tbl">
        <thead><tr><th>名前</th><th>メモ</th><th style="text-align:right">出場</th><th style="text-align:right">優勝</th>
          <th style="text-align:right">最高</th><th style="text-align:right">平均</th></tr></thead>
        <tbody>${rows.map(({ m, st }) => `
          <tr class="link" data-mid="${esc(m.id)}">
            <td><b>${esc(m.name)}</b></td><td class="hint">${esc(m.note || '')}</td>
            <td class="n">${RECORDS_ALL ? st.count : '…'}</td>
            <td class="n" style="${st.wins ? 'color:var(--gold);font-weight:700' : ''}">${RECORDS_ALL ? st.wins : '…'}</td>
            <td class="n">${st.best ? rankLabel(st.best) : '—'}</td>
            <td class="n">${fmtAvg(st.avg)}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    $('#mList').querySelectorAll('tr[data-mid]').forEach(tr => tr.onclick = () => { location.hash = '#/m/' + tr.dataset.mid; });
  };
  const renderAdd = () => {
    const card = $('#mAdd'); if (!card) return;
    if (!SITE.isSiteAdmin) {
      card.dataset.mode = '';
      card.innerHTML = '<h2>メンバーの登録</h2><p class="hint">名簿と戦績の編集はサイト管理者のみ行えます。<a href="#/admin">管理</a>からログインしてください。</p>';
      return;
    }
    if (card.dataset.mode === 'form') return;
    card.dataset.mode = 'form';
    card.innerHTML = `
      <h2>メンバーを追加</h2>
      <label for="nmName">名前</label><input type="text" id="nmName" maxlength="40">
      <label for="nmNote">メモ（所属など・任意）</label><input type="text" id="nmNote" maxlength="200">
      <button class="primary wide" id="nmAdd" style="margin-top:10px">追加</button>
      <h3 style="margin-top:18px">まとめて追加</h3>
      <textarea id="nmBulk" style="height:100px" placeholder="山田&#10;佐藤&#10;鈴木（改行または「、」区切り）"></textarea>
      <button class="wide" id="nmBulkAdd" style="margin-top:6px">まとめて追加</button>
      <div class="err" id="nmErr"></div>
      <p class="hint">過去の戦績は、各メンバーのページから入力できます。</p>`;
    const exists = n => MEMBERS.some(m => m.name === n);
    $('#nmAdd').onclick = async () => {
      $('#nmErr').textContent = '';
      const name = cleanName($('#nmName').value, 40);
      if (!name) return ($('#nmErr').textContent = '名前を入力してください');
      if (exists(name)) return ($('#nmErr').textContent = '同じ名前のメンバーがいます');
      try {
        await backend.saveMember({ name, note: cleanName($('#nmNote').value, 200) });
        $('#nmName').value = ''; $('#nmNote').value = ''; toast(`${name} を追加しました`);
      } catch (e) { $('#nmErr').textContent = errMsg(e); }
    };
    $('#nmBulkAdd').onclick = async () => {
      $('#nmErr').textContent = '';
      const names = splitNames($('#nmBulk').value).filter(n => !exists(n));
      if (!names.length) return ($('#nmErr').textContent = '追加する名前がありません（登録済みの名前は除外されます）');
      try { await backend.createMembers(names); $('#nmBulk').value = ''; toast(`${names.length}名を追加しました`); }
      catch (e) { $('#nmErr').textContent = errMsg(e); }
    };
  };
  $('#mSearch').oninput = render;
  render(); renderAdd();
  pageRefresh = () => { render(); renderAdd(); };
  try { RECORDS_ALL = await backend.getRecords(); } catch (e) { toast(errMsg(e)); RECORDS_ALL = []; }
  render();
}

// ---------- メンバー詳細（戦績） ----------
async function showMember(mid) {
  let recs = null, editing = null;
  $('#app').innerHTML = `
  <a href="#/members" class="back">← メンバー一覧</a>
  <div class="grid" style="margin-top:8px">
    <div class="col">
      <div class="card" id="mHead"></div>
      <div class="card"><h2>戦績</h2><div id="mRecs" style="overflow-x:auto"><div class="empty">読み込み中…</div></div></div>
    </div>
    <div class="col" id="mSide"></div>
  </div>`;
  const load = async () => {
    try { recs = sortRecords(await backend.getRecords([mid])); } catch (e) { toast(errMsg(e)); recs = []; }
    render();
  };
  const render = () => {
    if (!$('#mHead')) return;
    const m = MEMBER_BY_ID[mid];
    if (!m) {
      $('#mHead').innerHTML = MEMBERS.length ? '<div class="empty">メンバーが見つかりません</div>' : '<div class="empty">読み込み中…</div>';
      return;
    }
    const st = memberStats(recs || []);
    $('#mHead').innerHTML = `
      <div class="big">${esc(m.name)}</div>
      ${m.note ? `<div class="hint">${esc(m.note)}</div>` : ''}
      <div class="statGrid">
        <div><b>${recs ? st.count : '…'}</b><span>出場</span></div>
        <div><b style="${st.wins ? 'color:var(--gold)' : ''}">${recs ? st.wins : '…'}</b><span>優勝</span></div>
        <div><b>${st.best ? rankLabel(st.best) : '—'}</b><span>最高順位</span></div>
        <div><b>${fmtAvg(st.avg)}</b><span>平均順位</span></div>
      </div>`;
    const admin = SITE.isSiteAdmin;
    $('#mRecs').innerHTML = !recs ? '<div class="empty">読み込み中…</div>' : !recs.length ? '<div class="empty">戦績はまだありません</div>' : `
      <table class="tbl">
        <thead><tr><th>日付</th><th>大会</th><th>チーム</th><th>順位</th>${admin ? '<th></th>' : ''}</tr></thead>
        <tbody>${recs.map(r => `<tr>
          <td style="white-space:nowrap">${esc(r.date || '—')}</td>
          <td>${r.tournamentId ? `<a href="#/t/${esc(r.tournamentId)}">${esc(r.tournamentName)}</a>` : esc(r.tournamentName)}</td>
          <td>${esc(r.teamName || '—')}</td>
          <td style="white-space:nowrap;font-weight:700;${r.rank === 1 ? 'color:var(--gold)' : ''}">${rankLabel(r.rank)}${r.teamCount ? `<span class="hint"> / ${r.teamCount}チーム</span>` : ''}</td>
          ${admin ? `<td style="white-space:nowrap"><button class="small" data-edit="${esc(r.id)}">編集</button>
            <button class="small danger" data-del="${esc(r.id)}">削除</button></td>` : ''}
        </tr>`).join('')}</tbody>
      </table>`;
    $('#mRecs').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { editing = recs.find(r => r.id === b.dataset.edit); renderSide(true); });
    $('#mRecs').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const r = recs.find(x => x.id === b.dataset.del);
      if (!confirm(`戦績「${r.tournamentName}（${rankLabel(r.rank)}）」を削除します。よろしいですか？`)) return;
      try { await backend.deleteRecord(r.id); toast('戦績を削除しました'); load(); } catch (e) { toast(errMsg(e)); }
    });
    renderSide(false);
  };
  const renderSide = force => {
    const side = $('#mSide'); if (!side) return;
    const m = MEMBER_BY_ID[mid];
    if (!SITE.isSiteAdmin || !m) { side.innerHTML = ''; side.dataset.mode = ''; return; }
    if (!force && side.dataset.mode === 'admin') return;
    side.dataset.mode = 'admin';
    const r = editing || {};
    side.innerHTML = `
      <div class="card">
        <h2>${editing ? '戦績を編集' : '戦績を追加'}</h2>
        <label for="rName">大会名</label><input type="text" id="rName" maxlength="60" value="${esc(r.tournamentName || '')}">
        <label for="rDate">開催日</label><input type="date" id="rDate" value="${esc(r.date || '')}">
        <label for="rTeam">チーム名</label><input type="text" id="rTeam" maxlength="40" value="${esc(r.teamName || '')}">
        <div class="row">
          <div><label for="rRank">順位</label><input type="number" id="rRank" min="1" max="999" value="${r.rank || ''}"></div>
          <div><label for="rCount">参加チーム数（任意）</label><input type="number" id="rCount" min="1" max="999" value="${r.teamCount || ''}"></div>
        </div>
        <button class="primary wide" id="rSave" style="margin-top:10px">${editing ? '更新する' : '追加する'}</button>
        ${editing ? '<button class="wide" id="rCancel" style="margin-top:6px">編集をやめる</button>' : ''}
        <div class="err" id="rErr"></div>
      </div>
      <div class="card">
        <h2>メンバー情報</h2>
        <label for="emName">名前</label><input type="text" id="emName" maxlength="40" value="${esc(m.name)}">
        <label for="emNote">メモ</label><input type="text" id="emNote" maxlength="200" value="${esc(m.note || '')}">
        <button class="wide" id="emSave" style="margin-top:10px">保存</button>
        <button class="wide danger" id="emDel" style="margin-top:6px">このメンバーを削除</button>
        <div class="err" id="emErr"></div>
      </div>`;
    $('#rSave').onclick = async () => {
      $('#rErr').textContent = '';
      const tournamentName = cleanName($('#rName').value, 60);
      const rank = Number($('#rRank').value);
      const teamCount = $('#rCount').value === '' ? null : Number($('#rCount').value);
      if (!tournamentName) return ($('#rErr').textContent = '大会名を入力してください');
      if (!Number.isInteger(rank) || rank < 1 || rank > 999) return ($('#rErr').textContent = '順位は 1 以上の整数で入力してください');
      if (teamCount !== null && (!Number.isInteger(teamCount) || teamCount < rank || teamCount > 999))
        return ($('#rErr').textContent = '参加チーム数は順位以上の整数で入力してください');
      try {
        await backend.saveRecord({
          id: editing ? editing.id : undefined, memberId: mid,
          tournamentId: editing ? (editing.tournamentId ?? null) : null,
          tournamentName, date: $('#rDate').value || '', teamName: cleanName($('#rTeam').value, 40),
          rank, teamCount, createdAt: editing ? editing.createdAt : undefined,
        });
        toast(editing ? '戦績を更新しました' : '戦績を追加しました');
        editing = null; renderSide(true); load();
      } catch (e) { $('#rErr').textContent = errMsg(e); }
    };
    if ($('#rCancel')) $('#rCancel').onclick = () => { editing = null; renderSide(true); };
    $('#emSave').onclick = async () => {
      $('#emErr').textContent = '';
      const name = cleanName($('#emName').value, 40);
      if (!name) return ($('#emErr').textContent = '名前を入力してください');
      if (MEMBERS.some(x => x.name === name && x.id !== mid)) return ($('#emErr').textContent = '同じ名前のメンバーがいます');
      try { await backend.saveMember({ id: mid, name, note: cleanName($('#emNote').value, 200), createdAt: m.createdAt }); toast('保存しました'); }
      catch (e) { $('#emErr').textContent = errMsg(e); }
    };
    $('#emDel').onclick = async () => {
      if (!confirm(`メンバー「${m.name}」と、その戦績 ${recs ? recs.length : 0} 件を削除します。元に戻せません。よろしいですか？`)) return;
      try { await backend.deleteMember(mid); toast('削除しました'); location.hash = '#/members'; }
      catch (e) { $('#emErr').textContent = errMsg(e); }
    };
  };
  pageRefresh = () => { if ($('#mSide')) { $('#mSide').dataset.mode = ''; } render(); };
  render();
  load();
}

// ---------- サイト管理 ----------
function showSiteAdmin() {
  const render = () => {
    const s = SITE;
    let body;
    if (s.initialized === null) body = '<div class="empty">読み込み中…</div>';
    else if (!s.initialized) body = `
      <h2>初期設定：サイト管理者の作成</h2>
      <p class="hint" style="font-size:13px">サイト管理者は、大会の作成・メンバー名簿と戦績の編集・すべての大会の管理ができます。<br>
        ボタンを押すとサイト管理者キーが発行され、この端末がサイト管理者になります。<b>最初に 1 回だけ</b>行えます。</p>
      <button class="primary wide" id="siteInit" style="margin-top:12px">サイト管理者キーを発行する</button>`;
    else if (s.isSiteAdmin) body = `
      <h2>サイト管理者としてログイン中</h2>
      <p class="hint" style="font-size:13px">大会の作成、メンバー名簿・戦績の編集、すべての大会の管理ができます。</p>
      <h3>サイト管理者キー</h3>
      <div class="keyBox">${esc(s.siteKey || '')}</div>
      <p class="hint">別の端末でサイト管理者になるには、その端末でこのキーを入力します。キーは大切に保管し、管理者以外に教えないでください。</p>
      <button class="wide" id="siteLogout" style="margin-top:12px">この端末のサイト管理者権限を外す</button>`;
    else body = `
      <h2>サイト管理者ログイン</h2>
      <label for="siteKey">サイト管理者キー</label>
      <input type="password" id="siteKey">
      <button class="primary wide" id="siteLogin" style="margin-top:10px">ログイン</button>
      <p class="hint">個別の大会だけを管理する場合は、その大会のページで「大会の管理者キー」を入力してください。</p>`;
    $('#app').innerHTML = `<div style="max-width:560px;margin:0 auto"><div class="card">${body}<div class="err" id="sErr"></div></div></div>`;
    const err = e => { $('#sErr').textContent = errMsg(e); };
    if ($('#siteInit')) $('#siteInit').onclick = async () => {
      if (!confirm('この端末をサイト管理者にして、サイト管理者キーを発行します。よろしいですか？')) return;
      try { await backend.initSite(); toast('サイト管理者キーを発行しました。必ず控えてください'); } catch (e) { err(e); }
    };
    if ($('#siteLogin')) $('#siteLogin').onclick = async () => {
      try { await backend.siteLogin($('#siteKey').value.trim()); toast('サイト管理者としてログインしました'); } catch (e) { err(e); }
    };
    if ($('#siteLogout')) $('#siteLogout').onclick = async () => {
      if (!confirm('この端末のサイト管理者権限を外します。サイト管理者キーを控えていますか？')) return;
      try { await backend.siteLogout(); toast('サイト管理者権限を外しました'); } catch (e) { err(e); }
    };
  };
  render();
  pageRefresh = render;
}

route();

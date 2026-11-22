// 大会オッズ - 画面
import { firebaseConfig } from './firebase-config.js';
import {
  UNIT, calcOdds, buildView, computeSettlement, splitNames,
  rankLabel, memberStats, sortRecords, buildRecords, ROLES, validRole, roleFromNote,
  TEAM_TAGS, SERVERS, randomHex,
} from './common.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString('ja-JP');
const fmtOdds = o => o == null ? '—' : o.toFixed(1);
const fmtAvg = a => a == null ? '—' : a.toFixed(1) + '位';
const STATUS = { entry: 'エントリー受付中', open: '投票受付中', closed: '締切', settled: '確定' };
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
let activePickers = [];       // 名簿の更新時に表示を更新するメンバー選択部品
let entryPickers = [];        // エントリーフォームのメンバー選択部品

backend.watchSite(s => {
  SITE = s;
  $('#navAdmin').textContent = s.isSiteAdmin ? '管理 ✓' : '管理';
  pageRefresh();
});
backend.watchMembers(list => {
  MEMBERS = list.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  MEMBER_BY_ID = Object.fromEntries(list.map(m => [m.id, m]));
  [...activePickers, ...entryPickers].forEach(p => p.refresh());
  pageRefresh();
}, e => console.error(e));

const memberName = id => (MEMBER_BY_ID[id] || { name: '(削除されたメンバー)' }).name;
// ロールの表示・選択肢
const ROLE_CLASS = { '初心者': 'r-beg', 'OB': 'r-ob', '保護者': 'r-par', '天上人': 'r-top' };
const roleBadge = r => validRole(r) ? `<span class="role ${ROLE_CLASS[r]}">${esc(r)}</span>` : '';
const roleOptions = (cur, emptyLabel = '未設定') =>
  `<option value="">${emptyLabel}</option>` + ROLES.map(r => `<option value="${esc(r)}"${r === cur ? ' selected' : ''}>${esc(r)}</option>`).join('');

// ---------- メンバー選択部品 ----------
// 名簿から検索して選ぶ。選択は {id}（登録済み）または {name}（新規登録予定）
// opts.takenBy(): { memberId: '登録先チーム名' }（他チームに入っているメンバーは選べない）
// opts.allowNew: 名簿にない名前を新規メンバーとして追加できるか
// opts.max: 選べる人数の上限（1 なら 1 人だけ選ぶ欄になる）
function createPicker(el, { initial = [], takenBy = () => ({}), allowNew = false, onChange = () => {}, max = Infinity, placeholder = '名前で検索してメンバーを追加' } = {}) {
  let items = initial.map(it => typeof it === 'string' ? { id: it } : it);
  el.classList.add('picker');
  el.innerHTML = `
    <div class="pkSel"></div>
    <input type="text" class="pkIn" placeholder="${esc(placeholder)}">
    <div class="pkList" hidden></div>`;
  const sel = $('.pkSel', el), inp = $('.pkIn', el), list = $('.pkList', el);
  const label = it => it.id ? memberName(it.id) : it.name;
  const has = it => items.some(x => (it.id && x.id === it.id) || (it.name && x.name === it.name));
  const renderSel = () => {
    sel.innerHTML = items.length ? items.map((it, i) => `
      <span class="pkChip ${it.id ? '' : 'new'}">${esc(label(it))}${it.id ? '' : '<small>新規</small>'}
        <button type="button" data-rm="${i}" aria-label="${esc(label(it))} を外す">×</button></span>`).join('')
      : '<span class="hint">メンバー未選択</span>';
    sel.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { items.splice(Number(b.dataset.rm), 1); renderSel(); onChange(); });
    inp.hidden = items.length >= max;
  };
  const add = it => {
    if (!has(it)) items.push(it);
    inp.value = ''; renderSel(); onChange();
    if (items.length >= max) { list.hidden = true; inp.blur(); } else { renderList(); inp.focus(); }
  };
  const renderList = () => {
    const q = inp.value.trim();
    const taken = takenBy();
    const cands = MEMBERS.filter(m => !items.some(x => x.id === m.id) && (!q || m.name.includes(q) || (m.note || '').includes(q) || (m.role || '') === q));
    const exact = MEMBERS.some(m => m.name === q) || items.some(x => x.name === q);
    let html = cands.slice(0, 50).map(m => taken[m.id]
      ? `<div class="pkItem off">${esc(m.name)}<small>${esc(taken[m.id])} に登録済み</small></div>`
      : `<button type="button" class="pkItem" data-id="${esc(m.id)}"><span>${esc(m.name)}${roleBadge(m.role)}</span>${m.note ? `<small>${esc(m.note)}</small>` : ''}</button>`).join('');
    if (cands.length > 50) html += `<div class="pkItem off">ほか ${cands.length - 50} 名（名前で絞り込んでください）</div>`;
    if (q && !exact && allowNew) html += `<button type="button" class="pkItem add" data-new="${esc(q)}">＋「${esc(q)}」を新しいメンバーとして追加</button>`;
    if (!html) html = `<div class="pkItem off">${MEMBERS.length ? '該当するメンバーがいません' : 'メンバーが登録されていません'}</div>`;
    list.innerHTML = html;
    list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => add({ id: b.dataset.id }));
    list.querySelectorAll('[data-new]').forEach(b => b.onclick = () => add({ name: cleanName(b.dataset.new, 40) }));
  };
  // リスト内のクリックで入力欄のフォーカスが外れて閉じないようにする
  list.addEventListener('mousedown', e => e.preventDefault());
  inp.addEventListener('focus', () => { renderList(); list.hidden = false; });
  inp.addEventListener('blur', () => { list.hidden = true; });
  inp.addEventListener('input', () => { renderList(); list.hidden = false; });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { inp.blur(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = list.querySelector('[data-id], [data-new]');
    if (first) first.click();
  });
  renderSel();
  return {
    items: () => items.slice(),
    ids: () => items.filter(x => x.id).map(x => x.id),
    set(ids) { items = ids.map(it => typeof it === 'string' ? { id: it } : it); renderSel(); },
    refresh() { renderSel(); if (!list.hidden) renderList(); },
  };
}

// 選択内容（新規メンバー含む）をメンバー ID に確定する。新規分はここで名簿に登録
async function commitPickers(pickers) {
  const newNames = [...new Set(pickers.flatMap(p => p.items().filter(x => !x.id).map(x => x.name)))];
  const byName = {};
  for (const m of MEMBERS) if (!(m.name in byName)) byName[m.name] = m.id;
  const toCreate = newNames.filter(n => !(n in byName));
  if (toCreate.length) {
    const ids = await backend.createMembers(toCreate);
    toCreate.forEach((n, i) => { byName[n] = ids[i]; });
  }
  return pickers.map(p => [...new Set(p.items().map(x => x.id || byName[x.name]))]);
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
  unwatch(); unwatch = () => {}; pageRefresh = () => {}; activePickers = []; entryPickers = [];
  closeModal();
  const h = location.hash;
  let m, nav = 'home';
  if ((m = h.match(/^#\/t\/([A-Za-z0-9]+)/))) showTournament(m[1]);
  else if ((m = h.match(/^#\/m\/([A-Za-z0-9]+)/))) { nav = 'members'; showMember(m[1]); }
  else if (h.startsWith('#/members')) { nav = 'members'; showMembers(); }
  else if (h.startsWith('#/admin')) { nav = 'admin'; showSiteAdmin(); }
  else showHome();
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === nav));
  // 大会ページを開いているときは、その大会を選んだ状態でトーナメントメーカーを開く
  const tm = h.match(/^#\/t\/([A-Za-z0-9]+)/);
  $('#navMaker').href = makerUrl(tm ? tm[1] : null);
  window.scrollTo(0, 0);
}
// トーナメントメーカー（サイトのトップ）の URL。デモモードはそのまま引き継ぐ
function makerUrl(tournamentId) {
  const q = new URLSearchParams();
  if (forceDemo) q.set('demo', '1');
  if (tournamentId) q.set('odds', tournamentId);
  const s = q.toString();
  return '../' + (s ? '?' + s : '');
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
          エントリー形式の大会では、出場する人が大会ページから「自分・相方・チーム名」などを入力してエントリーします。エントリーが締め切られると、各チームが大会に追加されて投票が始まります。<br>
          参加者は持ちポイントを使って「優勝すると思うチーム」に投票します（${UNIT}pt 単位）。<br>
          オッズは競馬の単勝と同じ<b>パリミュチュエル方式</b>で、投票が集まるたびにリアルタイムに変動します。<br>
          <b>オッズ ＝ 総投票額 ×（1 − 控除率）÷ そのチームへの投票額</b>（0.1 倍未満切り捨て・最低 1.0 倍）<br>
          大会終了後に管理者が順位を確定すると、的中した投票に「投票額 × 確定オッズ」が払い戻され、メンバーの戦績にも記録されます。優勝チームに誰も投票していなかった場合は的中者なしとなり、投票ポイントは返還されません。
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
        <label>出場チームの集め方</label>
        <label class="row" style="font-weight:400;gap:6px;flex-wrap:nowrap;margin:4px 0"><input type="radio" name="cMode" value="entry" checked style="flex:0">
          <span>エントリー形式（参加者が大会ページから自分でエントリー）</span></label>
        <label class="row" style="font-weight:400;gap:6px;flex-wrap:nowrap;margin:4px 0"><input type="radio" name="cMode" value="manual" style="flex:0">
          <span>管理者がチームを入力</span></label>
        <p class="hint" id="cEntryHint">大会を作成すると「エントリー受付中」になります。締め切るとエントリーがチームとして大会に追加され、投票が始まります。</p>
        <div id="cTeams" hidden>
          <label>出場チームとメンバー</label>
          <div id="teamRows"></div>
          <button type="button" class="wide" id="addTeamRow" style="margin-top:8px">＋ チームを追加</button>
          <p class="hint">メンバーは名簿から検索して選びます。名簿にない人は、検索欄に名前を入れて「新しいメンバーとして追加」を選ぶと、大会作成時に名簿にも登録されます。</p>
        </div>
        <div class="row">
          <div><label for="cPoints">初期ポイント</label><input type="number" id="cPoints" value="1000" min="100" step="100"></div>
          <div><label for="cTake">控除率（%）</label><input type="number" id="cTake" value="0" min="0" max="50" step="1"></div>
        </div>
        <p class="hint">控除率 0% なら投票ポイントが全額払い戻しに回ります。競馬（単勝）は約 20%。</p>
        <button class="primary wide" style="margin-top:12px">作成する</button>
        <div class="err" id="cErr"></div>
      </form>`;
    // チーム行（チーム名＋メンバー選択）
    const rows = [];
    const takenFor = row => () => {
      const out = {};
      for (const r of rows) {
        if (r === row) continue;
        const label = r.nameEl.value.trim() || `チーム${rows.indexOf(r) + 1}`;
        for (const id of r.picker.ids()) out[id] = label;
      }
      return out;
    };
    const renumber = () => rows.forEach((r, i) => { r.nameEl.placeholder = `チーム名（例：チーム${String.fromCharCode(65 + (i % 26))}）`; });
    const addRow = () => {
      const box = document.createElement('div');
      box.className = 'teamRow';
      box.innerHTML = `
        <div class="row" style="margin-bottom:6px">
          <input type="text" class="trName" maxlength="40">
          <button type="button" class="small danger trDel" style="flex:0">削除</button>
        </div>
        <div class="trPick"></div>`;
      $('#teamRows').appendChild(box);
      const row = { box, nameEl: $('.trName', box) };
      row.picker = createPicker($('.trPick', box), { takenBy: takenFor(row), allowNew: true });
      $('.trDel', box).onclick = () => {
        if (rows.length <= 2) return ($('#cErr').textContent = 'チームは 2 つ以上必要です');
        rows.splice(rows.indexOf(row), 1); box.remove(); renumber();
        activePickers = rows.map(r => r.picker);
      };
      rows.push(row); renumber();
      activePickers = rows.map(r => r.picker);
      return row;
    };
    addRow(); addRow();
    $('#addTeamRow').onclick = () => { addRow().nameEl.focus(); };
    const mode = () => document.querySelector('input[name="cMode"]:checked').value;
    document.querySelectorAll('input[name="cMode"]').forEach(r => r.onchange = () => {
      $('#cTeams').hidden = mode() !== 'manual';
      $('#cEntryHint').hidden = mode() !== 'entry';
    });

    $('#createForm').onsubmit = async ev => {
      ev.preventDefault(); $('#cErr').textContent = '';
      const name = cleanName($('#cName').value, 60);
      const isEntry = mode() === 'entry';
      const teams = isEntry ? [] : rows.map(r => ({ name: cleanName(r.nameEl.value, 40), picker: r.picker }));
      if (teams.some(t => !t.name)) return ($('#cErr').textContent = 'チーム名を入力してください');
      const initialPoints = Math.floor(Number($('#cPoints').value));
      const takeout = Math.round(Number($('#cTake').value)) / 100;
      const fail = msg => { $('#cErr').textContent = msg; };
      if (!name) return fail('大会名を入力してください');
      if (!isEntry && teams.length < 2) return fail('チームは 2 つ以上必要です');
      if (teams.length > 200) return fail('チームは 200 までです');
      if (new Set(teams.map(t => t.name)).size !== teams.length) return fail('同じ名前のチームがあります');
      if (!(initialPoints >= UNIT && initialPoints <= 1e7)) return fail(`初期ポイントは ${UNIT}〜10,000,000 で指定してください`);
      if (!(takeout >= 0 && takeout <= 0.5)) return fail('控除率は 0〜50% で指定してください');
      const btn = ev.submitter; if (btn) btn.disabled = true;
      try {
        const idLists = await commitPickers(teams.map(t => t.picker));
        const withIds = teams.map((t, i) => ({ name: t.name, memberIds: idLists[i] }));
        const r = await backend.createTournament({ name, date: $('#cDate').value || '', teams: withIds, initialPoints, takeout, status: isEntry ? 'entry' : 'open' });
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
        <span class="meta">${t.date ? esc(t.date) : ''}${t.status === 'entry' ? '' : `${t.date ? ' ／ ' : ''}${t.entrants.length} チーム`}</span>
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
// オッズ表の並び順。dir: 1 = 各列の基本の向き（オッズ・人気・順位は小さい順、支持率は高い順）、-1 = 逆
let boardSort = { key: 'num', dir: 1 };

function showTournament(id) {
  tid = id; RAW = null; T = null; selected = null; adminSig = ''; betFormBuilt = false; entrySig = ''; entryEditing = false;
  $('#app').innerHTML = `
  <div class="grid">
    <div class="col">
      <div class="card" id="boardCard"><div class="empty">読み込み中…</div></div>
      <div class="card" id="rankingCard"><h2>ポイントランキング</h2><div id="ranking"></div></div>
    </div>
    <div class="col">
      <div class="card" id="entryCard" hidden></div>
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
  $('#rankingCard').hidden = T.status === 'entry';
  renderBoard(); renderEntry(); renderBet(); renderMyBets(); renderRanking(); renderAdmin(); renderAdminLogin();
}

// ---------- エントリー ----------
let entrySig = '';       // エントリー欄の再描画判定用
let entryEditing = false;
const entryList = () => RAW.t.status === 'entry'
  ? [...(RAW.entries || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)) : [];
const newTag = '<small class="newTag">新規</small>';
const entryMemberHtml = (id, name) => id && MEMBER_BY_ID[id] ? esc(MEMBER_BY_ID[id].name) : esc(name) + (id ? '' : newTag);
const tagChip = tag => tag ? `<span class="tagChip">${esc(tag)}</span>` : '';
// 他チーム（管理者が追加したチーム＋他の人のエントリー）で使われているメンバー・チーム名・タグ
function entryTaken(exceptId) {
  const ids = {}, names = {}, teamNames = new Set(), tags = {};
  for (const e of RAW.t.entrants) {
    for (const id of e.memberIds || []) ids[id] = e.name;
    teamNames.add(e.name);
    if (e.tag) tags[e.tag] = e.name;
  }
  for (const x of RAW.entries || []) {
    if (x.id === exceptId) continue;
    for (const [id, nm] of [[x.selfId, x.selfName], [x.partnerId, x.partnerName]]) {
      if (id) ids[id] = x.teamName; else names[nm] = x.teamName;
    }
    teamNames.add(x.teamName);
    tags[x.teamTag] = x.teamName;
  }
  return { ids, names, teamNames, tags };
}

// この大会のチームでトーナメント表を作るリンク
const makerLink = () => `<a class="makerLink" href="${esc(makerUrl(tid))}">🏆 この大会のチームでトーナメント表を作る ↗</a>`;

// エントリーのメンバーを、名簿にいる人は ID、いない人（新規）は名前に分ける
function entryMembers(x) {
  const pairs = [[x.selfId, x.selfName], [x.partnerId, x.partnerName]];
  return {
    mids: pairs.filter(([id]) => id && MEMBER_BY_ID[id]).map(([id]) => id),
    newNames: pairs.filter(([id]) => !(id && MEMBER_BY_ID[id])).map(([, n]) => n),
  };
}
const showEntryDetail = x => showTeamDetail({ name: x.teamName, tag: x.teamTag, server: x.server, message: x.message, ...entryMembers(x) });

// エントリー受付中のチーム一覧（オッズ表の代わり）
function renderEntryBoard() {
  const t = T, list = entryList();
  const split = pairs => entryMembers({ selfId: pairs[0][0], selfName: pairs[0][1], partnerId: pairs[1][0], partnerName: pairs[1][1] });
  const rows = [
    ...RAW.t.entrants.map(e => ({ name: e.name, tag: e.tag || '', members: (e.memberIds || []).map(id => esc(memberName(id))),
      server: e.server || '', message: e.message || '', mine: false, mids: e.memberIds || [], newNames: [] })),
    ...list.map(x => ({ name: x.teamName, tag: x.teamTag, members: [entryMemberHtml(x.selfId, x.selfName), entryMemberHtml(x.partnerId, x.partnerName)],
      server: x.server, message: x.message || '', mine: x.id === RAW.uid,
      ...split([[x.selfId, x.selfName], [x.partnerId, x.partnerName]]) })),
  ];
  $('#boardCard').innerHTML = `
    <div class="tHead">
      <h2>${esc(t.name)}</h2>
      <span class="badge entry">${STATUS.entry}</span>
    </div>
    <div class="stats">
      ${RAW.t.date ? `<span>開催日 <b>${esc(RAW.t.date)}</b></span>` : ''}
      <span>エントリー <b>${rows.length}</b> チーム</span>
    </div>
    ${rows.length ? `
    <table class="board">
      <thead><tr><th>番</th><th>チーム</th><th>希望サーバー</th><th class="hideSm">意気込み</th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr class="view ${r.mine ? 'sel' : ''}" data-row="${i}">
          <td><span class="num">${i + 1}</span></td>
          <td class="ename">${esc(r.name)}${tagChip(r.tag)}${r.mine ? '<span class="info">あなた</span>' : ''}<span class="info">メンバー・戦績</span>
            ${r.members.length ? `<span class="members">${r.members.join('、')}</span>` : ''}</td>
          <td style="font-size:13px;white-space:nowrap">${esc(r.server || '—')}</td>
          <td class="hideSm"><div class="msg">${esc(r.message)}</div></td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="empty">まだエントリーがありません</div>'}
    <p class="hint">チームをクリックすると、メンバーと過去の戦績を確認できます。エントリーが締め切られると、各チームが大会に追加されて投票（オッズ）が始まります。</p>
    ${makerLink()}`;
  $('#boardCard').querySelectorAll('tr[data-row]').forEach(tr => tr.onclick = () => {
    const r = rows[Number(tr.dataset.row)];
    showTeamDetail({ name: r.name, tag: r.tag, server: r.server, message: r.message, mids: r.mids, newNames: r.newNames });
  });
}

function renderEntry() {
  const card = $('#entryCard');
  if (T.status !== 'entry') { card.hidden = true; card.innerHTML = ''; entrySig = ''; entryEditing = false; entryPickers = []; return; }
  card.hidden = false;
  const mine = (RAW.entries || []).find(x => x.id === RAW.uid) || null;
  const mode = mine && !entryEditing ? 'view' : 'form';
  const sig = JSON.stringify([mode, mine]);
  if (sig === entrySig) { if (mode === 'form') refreshTagOptions(); return; }
  entrySig = sig;
  entryPickers = [];

  if (mode === 'view') {
    card.innerHTML = `
      <h2>✅ エントリー済み</h2>
      <table class="rec" style="font-size:14px">
        <tr><th>チーム名</th><td><b>${esc(mine.teamName)}</b>${tagChip(mine.teamTag)}</td></tr>
        <tr><th>あなた</th><td>${entryMemberHtml(mine.selfId, mine.selfName)}</td></tr>
        <tr><th>相方</th><td>${entryMemberHtml(mine.partnerId, mine.partnerName)}</td></tr>
        <tr><th>希望サーバー</th><td>${esc(mine.server)}</td></tr>
        <tr><th>意気込み</th><td class="msg full">${esc(mine.message || '—')}</td></tr>
      </table>
      <div class="row" style="margin-top:10px">
        <button id="enEdit">内容を変更</button>
        <button class="danger" id="enCancel">エントリーを取り消す</button>
      </div>
      <div class="err" id="enErr"></div>
      <p class="hint">エントリーはこのブラウザに紐づいています。変更・取り消しはエントリーした端末から行ってください。</p>`;
    $('#enEdit').onclick = () => { entryEditing = true; renderEntry(); };
    $('#enCancel').onclick = async () => {
      if (!confirm(`チーム「${mine.teamName}」のエントリーを取り消します。よろしいですか？`)) return;
      try { await backend.deleteEntry(tid); toast('エントリーを取り消しました'); }
      catch (e) { $('#enErr').textContent = errMsg(e); }
    };
    return;
  }

  const m = mine || {};
  card.innerHTML = `
    <h2>📝 ${mine ? 'エントリー内容の変更' : 'エントリー'}</h2>
    <form id="entryForm">
      <label>貴方は誰ですか？</label>
      <div id="enSelf"></div>
      <label>相方は誰ですか？</label>
      <div id="enPartner"></div>
      <p class="hint">メンバー一覧から名前で検索して選びます。見つからない場合は、名前を入力して「新しいメンバーとして追加」を選んでください。</p>
      <label for="enTeam">チーム名を教えてください</label>
      <input type="text" id="enTeam" maxlength="40" value="${esc(m.teamName || '')}">
      <label for="enTag">チームタグを教えてください（サーバー内で付与されている「チーム〇」）</label>
      <select id="enTag"></select>
      <label>希望するサーバーを教えてください</label>
      ${SERVERS.map(s => `<label class="row" style="font-weight:400;gap:6px;flex-wrap:nowrap;margin:4px 0">
        <input type="radio" name="enServer" value="${esc(s)}" style="flex:0"${m.server === s ? ' checked' : ''}><span>${esc(s)}</span></label>`).join('')}
      <label for="enMsg">意気込みをどうぞ</label>
      <textarea id="enMsg" maxlength="500" style="height:100px">${esc(m.message || '')}</textarea>
      <button class="primary wide" style="margin-top:10px">${mine ? '変更を保存する' : 'エントリーする'}</button>
      ${mine ? '<button type="button" class="wide" id="enBack" style="margin-top:6px">変更をやめる</button>' : ''}
      <div class="err" id="enErr"></div>
    </form>`;
  const initial = (id, name) => id ? [{ id }] : name ? [{ name }] : [];
  let selfP, partnerP;
  const takenBy = other => () => {
    const out = { ...entryTaken(RAW.uid).ids };
    const o = other(); const it = o && o.items()[0];
    if (it && it.id) out[it.id] = 'もう一方の欄';
    return out;
  };
  selfP = createPicker($('#enSelf'), { initial: initial(m.selfId, m.selfName), allowNew: true, max: 1,
    placeholder: '自分の名前で検索', takenBy: takenBy(() => partnerP) });
  partnerP = createPicker($('#enPartner'), { initial: initial(m.partnerId, m.partnerName), allowNew: true, max: 1,
    placeholder: '相方の名前で検索', takenBy: takenBy(() => selfP) });
  entryPickers = [selfP, partnerP];
  refreshTagOptions(m.teamTag || '');
  if ($('#enBack')) $('#enBack').onclick = () => { entryEditing = false; renderEntry(); };

  $('#entryForm').onsubmit = async ev => {
    ev.preventDefault();
    const fail = msg => { $('#enErr').textContent = msg; };
    fail('');
    const s = selfP.items()[0], p = partnerP.items()[0];
    const teamName = cleanName($('#enTeam').value, 40);
    const teamTag = $('#enTag').value;
    const server = (document.querySelector('input[name="enServer"]:checked') || {}).value || '';
    const message = String($('#enMsg').value).replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, 500);
    if (!s) return fail('あなたの名前を選んでください');
    if (!p) return fail('相方の名前を選んでください');
    if ((s.id && s.id === p.id) || (!s.id && !p.id && s.name === p.name)) return fail('あなたと相方に同じ人は選べません');
    if (!teamName) return fail('チーム名を入力してください');
    if (!TEAM_TAGS.includes(teamTag)) return fail('チームタグを選んでください');
    if (!SERVERS.includes(server)) return fail('希望するサーバーを選んでください');
    const taken = entryTaken(RAW.uid);
    for (const it of [s, p]) {
      const where = it.id ? taken.ids[it.id] : taken.names[it.name];
      if (where) return fail(`${it.id ? memberName(it.id) : it.name} さんは既に「${where}」でエントリーしています`);
    }
    if (taken.teamNames.has(teamName)) return fail('そのチーム名は既に使われています');
    if (taken.tags[teamTag]) return fail(`${teamTag} は既に「${taken.tags[teamTag]}」が使っています`);
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try {
      await backend.saveEntry(tid, {
        selfId: s.id || '', selfName: s.id ? memberName(s.id) : s.name,
        partnerId: p.id || '', partnerName: p.id ? memberName(p.id) : p.name,
        teamName, teamTag, server, message, createdAt: m.createdAt || 0,
      });
      entryEditing = false;
      toast(mine ? 'エントリー内容を変更しました' : 'エントリーしました');
    } catch (e) { fail(errMsg(e)); if (btn) btn.disabled = false; }
  };
}
// チームタグの選択肢（他チームが使っているタグは選べない）。入力中の選択は保つ
function refreshTagOptions(initial) {
  const sel = $('#enTag'); if (!sel) return;
  const cur = initial ?? sel.value;
  const tags = entryTaken(RAW.uid).tags;
  sel.innerHTML = '<option value="">選択してください</option>' + TEAM_TAGS.map(tg =>
    `<option value="${tg}"${tg === cur ? ' selected' : ''}${tags[tg] && tg !== cur ? ' disabled' : ''}>${tg}${tags[tg] ? `（${esc(tags[tg])}）` : ''}</option>`).join('');
}

function renderBoard() {
  if (T.status === 'entry') return renderEntryBoard();
  const t = T;
  if (selected && !t.entrants.some(e => e.id === selected)) selected = null;
  const maxVotes = Math.max(1, ...t.entrants.map(e => e.votes));
  const minOdds = Math.min(...t.entrants.map(e => e.odds ?? Infinity));
  const winner = t.entrants.find(e => e.id === t.winnerId);
  const canPick = t.status === 'open' && !!t.me;
  const ranks = RAW.t.ranks || {};
  const memberIdsOf = id => (RAW.t.entrants.find(e => e.id === id) || {}).memberIds || [];
  const tagOf = id => (RAW.t.entrants.find(e => e.id === id) || {}).tag || '';
  // 並べ替え（値がないチームは向きに関係なく末尾、同じ値は番号順）
  const settledView = t.status === 'settled';
  if (boardSort.key === 'rank' && !settledView) boardSort = { key: 'pop', dir: 1 };
  if (boardSort.key === 'pop' && settledView) boardSort = { key: 'rank', dir: 1 };
  const sortVal = {
    num: e => 0,
    odds: e => e.odds,
    pop: e => e.popularity,
    rank: e => ranks[e.id] || null,
    share: e => -e.share,
  }[boardSort.key] || (() => 0);
  const rows = t.entrants.map((e, i) => ({ e, i }));
  if (boardSort.key === 'num') { if (boardSort.dir < 0) rows.reverse(); }
  else rows.sort((a, b) => {
    const va = sortVal(a.e), vb = sortVal(b.e);
    if (va == null || vb == null) return (va == null) - (vb == null) || a.i - b.i;
    return (va - vb) * boardSort.dir || a.i - b.i;
  });
  const sortTh = (key, label, cls = '', align = '') => {
    const on = boardSort.key === key;
    const arrow = on ? (key === 'share' ? (boardSort.dir > 0 ? '▼' : '▲') : (boardSort.dir > 0 ? '▲' : '▼')) : '⇅';
    return `<th class="sort ${on ? 'sorted' : ''} ${cls}" data-sort="${key}" title="クリックで並べ替え"${align ? ` style="text-align:${align}"` : ''}>${label}<span class="arrow">${arrow}</span></th>`;
  };
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
      ${t.refunded ? '（的中者なしのため全額返還）'
        : winner.odds == null ? '（的中者なし）' : `　単勝 <b>${fmtOdds(winner.odds)}</b> 倍`}</div>` : ''}
    <table class="board">
      <thead><tr>${sortTh('num', '番')}<th>チーム</th>${sortTh('odds', 'オッズ', '', 'right')}${settledView ? sortTh('rank', '順位', '', 'center') : sortTh('pop', '人気', '', 'center')}
        ${sortTh('share', '支持率', 'hideSm')}<th class="hideSm" style="text-align:right">投票額</th></tr></thead>
      <tbody>
      ${rows.map(({ e, i }) => {
        const mids = memberIdsOf(e.id);
        return `
        <tr data-id="${esc(e.id)}" class="${canPick ? 'pick' : 'view'} ${e.id === selected ? 'sel' : ''} ${e.id === t.winnerId ? 'win' : ''}">
          <td><span class="num">${i + 1}</span></td>
          <td class="ename">${e.id === t.winnerId ? '🏆 ' : ''}${esc(e.name)}${tagChip(tagOf(e.id))}<span class="info">メンバー・戦績</span>
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
    ${t.status === 'open' && !t.me ? '<p class="hint">投票するには参加登録してください。</p>' : ''}
    ${makerLink()}`;
  $('#boardCard').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openTeamModal(tr.dataset.id));
  // 同じ列をもう一度クリックすると逆順
  $('#boardCard').querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    boardSort = boardSort.key === key ? { key, dir: -boardSort.dir } : { key, dir: 1 };
    renderBoard();
  });
}

// チームのメンバー・戦績ポップアップ
function openTeamModal(eid) {
  const e = T.entrants.find(x => x.id === eid); if (!e) return;
  const ent = RAW.t.entrants.find(x => x.id === eid) || {};
  showTeamDetail({
    name: e.name, tag: ent.tag, server: ent.server, message: ent.message, mids: ent.memberIds || [],
    chips: `<span class="chip">オッズ ${fmtOdds(e.odds)} 倍</span>
      ${e.popularity ? `<span class="chip">${e.popularity}番人気</span>` : ''}
      <span class="chip">投票 ${fmt(e.votes)}pt</span>`,
    pickId: T.status === 'open' && T.me ? eid : null,
  });
}

// チームのメンバー・戦績ポップアップ（オッズ表・エントリー一覧の両方から使う）
// team: { name, tag, server, message, mids: 名簿のメンバーID, newNames: 名簿未登録の名前, chips: 追加の表示, pickId: 投票先に選べるチームID }
async function showTeamDetail({ name, tag, server, message, mids = [], newNames = [], chips = '', pickId = null }) {
  const head = `
    <div class="modal-head">
      <h2>${esc(name)}${tagChip(tag)}</h2>
      <button class="small" data-close>✕</button>
    </div>
    <div class="chips">
      ${chips}
      <span class="chip">メンバー ${mids.length + newNames.length}人</span>
      ${server ? `<span class="chip">希望：${esc(server)}</span>` : ''}
    </div>
    ${message ? `<div class="mcard"><div class="note">意気込み</div><div class="msg full">${esc(message)}</div></div>` : ''}`;
  const foot = `
    <div class="modal-foot">
      <button data-close>閉じる</button>
      ${pickId ? '<button class="primary" id="pickTeam">このチームに投票する</button>' : ''}
    </div>`;
  const bindFoot = () => {
    const b = $('#pickTeam'); if (!b) return;
    b.onclick = () => {
      selected = pickId; closeModal(); renderBoard(); updateSelection();
      $('#betCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const a = $('#amount'); if (a) a.focus();
    };
  };
  // 名簿未登録（エントリーで新規追加された人）は戦績なし
  const newCards = newNames.map(n => `
      <div class="mcard">
        <div class="top"><span class="nm">${esc(n)}</span>${newTag}<span class="note">メンバー一覧に未登録（エントリー締切時に登録されます）</span></div>
        <div class="hint">戦績はまだありません</div>
      </div>`).join('');
  if (!mids.length) {
    if (newCards) { openModal(head + newCards + foot); return bindFoot(); }
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
          <span class="nm">${m ? `<a href="#/m/${esc(mid)}">${esc(m.name)}</a>${roleBadge(m.role)}` : '(削除されたメンバー)'}</span>
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
  openModal(head + cards + newCards + foot); bindFoot();
}
const recRow = r => `<tr>
  <td>${esc(r.date || '—')}</td>
  <td>${r.tournamentId ? `<a href="#/t/${esc(r.tournamentId)}">${esc(r.tournamentName)}</a>` : esc(r.tournamentName)}</td>
  <td>${esc(r.teamName || '—')}</td>
  <td class="rk ${r.rank === 1 ? 'r1' : ''}">${rankLabel(r.rank)}${r.teamCount ? `<span class="hint"> / ${r.teamCount}</span>` : ''}</td></tr>`;

let betFormBuilt = false;
function renderBet() {
  const t = T, card = $('#betCard');
  // エントリー受付中は投票欄を出さない（締切後に投票が始まる）
  card.hidden = t.status === 'entry';
  if (card.hidden) { card.dataset.mode = ''; card.innerHTML = ''; betFormBuilt = false; return; }
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
  const sig = JSON.stringify([T.status, RAW.adminKey, RAW.t.entrants, SITE.isSiteAdmin, T.status === 'entry' ? RAW.entries : null]);
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
      ${t.status === 'entry' ? `
      <h3>エントリーの受付（${entryList().length} チーム）</h3>
      ${entryList().length ? `<table class="rec">
        <tbody>${entryList().map(x => `<tr>
          <td><b>${esc(x.teamName)}</b>${tagChip(x.teamTag)}<div class="hint">${entryMemberHtml(x.selfId, x.selfName)}、${entryMemberHtml(x.partnerId, x.partnerName)}</div></td>
          <td style="text-align:right;white-space:nowrap"><button class="small" data-view-entry="${esc(x.id)}">メンバー・戦績</button>
            <button class="small danger" data-del-entry="${esc(x.id)}">削除</button></td></tr>`).join('')}</tbody>
      </table>` : '<p class="hint">まだエントリーがありません。</p>'}
      <button class="primary wide" id="admEntryClose" style="margin-top:8px">エントリーを締め切って投票を開始</button>
      <p class="hint">締め切ると、各エントリーがチームとして大会に追加され、投票（オッズ）が始まります。名簿にない「新規」の人は、このときメンバー一覧に登録されます。締め切った後はエントリー受付に戻せません。</p>`
      : `
      <h3>投票の受付</h3>
      ${t.status === 'open'
        ? '<button class="wide" id="admClose">投票を締め切る</button>'
        : '<button class="wide" id="admOpen">投票を再開する</button>'}`}
      <h3>チームの編集・追加</h3>
      <select id="teamSel"><option value="">＋ 新しいチームを追加</option>${opts}</select>
      <input type="text" id="teamName" maxlength="40" placeholder="チーム名" style="margin-top:6px">
      <div id="teamPick" style="margin-top:6px"></div>
      <button class="wide" id="teamSave" style="margin-top:6px">チームを追加</button>
      <button class="wide" id="admView" style="margin-top:6px" hidden>このチームのメンバー・戦績を見る</button>
      <button class="wide danger" id="admRemove" style="margin-top:6px" hidden>このチームを取消（投票は返還）</button>
      ${t.status === 'entry' ? '' : `
      <h3>結果の確定（順位の入力）</h3>
      <table class="rec" id="rankTable">
        <thead><tr><th>チーム</th><th style="text-align:right">順位</th></tr></thead>
        <tbody>${t.entrants.map(e => `<tr><td>${esc(e.name)}</td>
          <td style="text-align:right"><input type="number" class="rankIn" data-rank="${esc(e.id)}" min="1" max="${t.entrants.length}" step="1" placeholder="—"></td></tr>`).join('')}</tbody>
      </table>
      <label class="row" style="font-weight:400;gap:6px;flex-wrap:nowrap"><input type="checkbox" id="recOn" checked style="flex:0">
        <span>メンバーの戦績に記録する</span></label>
      <button class="primary wide" id="admSettle" style="margin-top:6px">順位を確定して払い戻す</button>
      <p class="hint">1位のチームが優勝として払い戻しの対象になります。初戦敗退などで順位がつかないチームは空欄のままで構いません（戦績には「順位なし」の出場として記録されます）。確定すると取り消せません（受付中の場合は自動で締め切ります）。</p>`}`}
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

  // エントリーの削除・締切
  card.querySelectorAll('[data-view-entry]').forEach(b => b.onclick = () => {
    const x = (RAW.entries || []).find(e => e.id === b.dataset.viewEntry);
    if (x) showEntryDetail(x);
  });
  card.querySelectorAll('[data-del-entry]').forEach(b => b.onclick = () => {
    const x = (RAW.entries || []).find(e => e.id === b.dataset.delEntry); if (!x) return;
    if (!confirm(`チーム「${x.teamName}」のエントリーを削除します。よろしいですか？`)) return;
    run(() => backend.deleteEntry(tid, x.id), 'エントリーを削除しました');
  });
  on('admEntryClose', () => {
    const list = entryList();
    const total = RAW.t.entrants.length + list.length;
    if (total < 2) return ($('#admErr').textContent = 'チームが 2 つ以上必要です（エントリー＋管理者が追加したチーム）');
    const byName = {};
    for (const m of MEMBERS) if (!(m.name in byName)) byName[m.name] = m.id;
    const newNames = [...new Set(list.flatMap(x => [[x.selfId, x.selfName], [x.partnerId, x.partnerName]])
      .filter(([id]) => !id || !MEMBER_BY_ID[id]).map(([, n]) => n))].filter(n => !(n in byName));
    if (newNames.length && !SITE.isSiteAdmin)
      return ($('#admErr').textContent = `名簿にない新規メンバー（${newNames.join('、')}）がいるため、サイト管理者が締め切ってください`);
    if (!confirm(`エントリーを締め切り、投票を開始します。\n\nチーム数：${total}${newNames.length ? `\n名簿に新しく登録するメンバー：${newNames.join('、')}` : ''}\n\nエントリー受付には戻せません。よろしいですか？`)) return;
    run(async () => {
      if (newNames.length) {
        const ids = await backend.createMembers(newNames);
        newNames.forEach((n, i) => { byName[n] = ids[i]; });
      }
      const used = new Set(RAW.t.entrants.map(e => e.name));
      const newEntrants = list.map(x => {
        let name = x.teamName;
        if (used.has(name)) name = `${name}（${x.teamTag}）`; // 念のため同名チームを避ける
        used.add(name);
        const mid = (id, n) => (id && MEMBER_BY_ID[id] ? id : byName[n]);
        return {
          id: randomHex(4), name, memberIds: [...new Set([mid(x.selfId, x.selfName), mid(x.partnerId, x.partnerName)].filter(Boolean))],
          tag: x.teamTag, server: x.server, message: x.message || '', entryUid: x.id,
        };
      });
      await backend.closeEntries(tid, RAW, newEntrants);
    }, 'エントリーを締め切り、投票を開始しました');
  });

  // チーム編集
  const teamSel = $('#teamSel');
  let teamPicker = null;
  if (teamSel) {
    // 他チームに入っているメンバーは選べない
    teamPicker = createPicker($('#teamPick'), {
      allowNew: SITE.isSiteAdmin,
      takenBy: () => Object.fromEntries(RAW.t.entrants.filter(e => e.id !== teamSel.value)
        .flatMap(e => (e.memberIds || []).map(id => [id, e.name]))),
    });
    activePickers = [teamPicker];
    teamSel.onchange = () => {
      const e = RAW.t.entrants.find(x => x.id === teamSel.value);
      $('#teamName').value = e ? e.name : '';
      teamPicker.set(e ? (e.memberIds || []) : []);
      $('#teamSave').textContent = e ? 'チームを更新' : 'チームを追加';
      $('#admRemove').hidden = !e;
      $('#admView').hidden = !e;
    };
  }
  on('admView', () => {
    const e = RAW.t.entrants.find(x => x.id === teamSel.value); if (!e) return;
    if (T.status === 'entry') showTeamDetail({ name: e.name, tag: e.tag, server: e.server, message: e.message, mids: e.memberIds || [] });
    else openTeamModal(e.id);
  });
  on('teamSave', () => {
    const id = teamSel.value;
    const name = cleanName($('#teamName').value, 40);
    if (!name) return ($('#admErr').textContent = 'チーム名を入力してください');
    if (RAW.t.entrants.some(e => e.name === name && e.id !== id)) return ($('#admErr').textContent = '同名のチームがあります');
    run(async () => {
      const [memberIds] = await commitPickers([teamPicker]);
      if (id) await backend.updateEntrant(tid, RAW, id, { name, memberIds });
      else await backend.addEntrant(tid, RAW, { name, memberIds });
      toast(id ? 'チームを更新しました' : 'チームを追加しました');
    });
  });
  on('admRemove', () => {
    const e = RAW.t.entrants.find(x => x.id === teamSel.value); if (!e) return;
    if (T.status !== 'entry' && T.entrants.length <= 2) return ($('#admErr').textContent = 'チームは 2 つ以上必要です');
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
    const lines = [...T.entrants].sort((a, b) => (ranks[a.id] || Infinity) - (ranks[b.id] || Infinity))
      .map(x => `${rankLabel(ranks[x.id])}：${x.name}`).join('\n');
    if (!confirm(`次の内容で確定します。取り消せません。\n\n${lines}\n\n${e.odds == null
      ? `優勝「${e.name}」には誰も投票していないため的中者なしとなり、全員の投票ポイントは返還されません。`
      : `優勝「${e.name}」の単勝オッズ：${fmtOdds(e.odds)} 倍`}\n戦績に記録：${records.length} 件\n\nよろしいですか？`)) return;
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
        <div class="row">
          <input type="text" id="mSearch" placeholder="名前・メモで検索" style="flex:1 1 180px">
          <select id="mRole" style="flex:0 1 150px;min-width:130px" aria-label="ロールで絞り込み">
            <option value="*">すべてのロール</option>${ROLES.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}<option value="">未設定</option>
          </select>
        </div>
        <div id="mList" style="margin-top:10px;overflow-x:auto"><div class="empty">読み込み中…</div></div>
      </div>
    </div>
    <div class="col"><div class="card" id="mAdd"></div></div>
  </div>`;
  const render = () => {
    if (!$('#mList')) return;
    const q = $('#mSearch').value.trim();
    const role = $('#mRole').value;
    const byMember = {};
    for (const r of RECORDS_ALL || []) (byMember[r.memberId] ||= []).push(r);
    const hits = MEMBERS.filter(m => (!q || m.name.includes(q) || (m.note || '').includes(q))
      && (role === '*' || validRole(m.role) === role));
    $('#mTitle').textContent = hits.length === MEMBERS.length ? `メンバー（${MEMBERS.length}名）` : `メンバー（${hits.length} / ${MEMBERS.length}名）`;
    const rows = hits
      .map(m => ({ m, st: memberStats(byMember[m.id] || []) }))
      .sort((a, b) => b.st.wins - a.st.wins || b.st.count - a.st.count || a.m.name.localeCompare(b.m.name, 'ja'));
    $('#mList').innerHTML = !MEMBERS.length ? '<div class="empty">まだメンバーが登録されていません</div>'
      : !rows.length ? '<div class="empty">条件に合うメンバーがいません</div>' : `
      <table class="tbl">
        <thead><tr><th>名前</th><th>ロール</th><th>メモ</th><th style="text-align:right">出場</th><th style="text-align:right">優勝</th>
          <th style="text-align:right">最高</th><th style="text-align:right">平均</th></tr></thead>
        <tbody>${rows.map(({ m, st }) => `
          <tr class="link" data-mid="${esc(m.id)}">
            <td><b>${esc(m.name)}</b></td><td>${roleBadge(m.role) || '<span class="hint">—</span>'}</td><td class="hint">${esc(m.note || '')}</td>
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
      <label for="nmRole">ロール</label><select id="nmRole">${roleOptions('')}</select>
      <label for="nmNote">メモ（所属など・任意）</label><input type="text" id="nmNote" maxlength="200">
      <button class="primary wide" id="nmAdd" style="margin-top:10px">追加</button>
      <h3 style="margin-top:18px">まとめて追加</h3>
      <textarea id="nmBulk" style="height:100px" placeholder="山田&#10;佐藤&#10;鈴木（改行または「、」区切り）"></textarea>
      <label for="nmBulkRole">ロール（まとめて追加する全員に設定）</label><select id="nmBulkRole">${roleOptions('')}</select>
      <button class="wide" id="nmBulkAdd" style="margin-top:6px">まとめて追加</button>
      <div class="err" id="nmErr"></div>
      <p class="hint">過去の戦績は、各メンバーのページから入力できます。</p>
      <h3 style="margin-top:18px">メモからロールを一括設定</h3>
      <p class="hint">ロール未設定のメンバーについて、メモの内容からロールを設定します。メモがロール名だけ（例「OB」）の場合はメモを空にし、ロール名を含む場合（例「OB（2019年卒）」）はメモを残します。設定済みのロールは変更しません。</p>
      <button class="wide" id="nmMigrate" style="margin-top:6px">メモからロールを設定</button>`;
    const exists = n => MEMBERS.some(m => m.name === n);
    $('#nmAdd').onclick = async () => {
      $('#nmErr').textContent = '';
      const name = cleanName($('#nmName').value, 40);
      if (!name) return ($('#nmErr').textContent = '名前を入力してください');
      if (exists(name)) return ($('#nmErr').textContent = '同じ名前のメンバーがいます');
      try {
        await backend.saveMember({ name, note: cleanName($('#nmNote').value, 200), role: validRole($('#nmRole').value) });
        $('#nmName').value = ''; $('#nmNote').value = ''; toast(`${name} を追加しました`);
      } catch (e) { $('#nmErr').textContent = errMsg(e); }
    };
    $('#nmBulkAdd').onclick = async () => {
      $('#nmErr').textContent = '';
      const names = splitNames($('#nmBulk').value).filter(n => !exists(n));
      if (!names.length) return ($('#nmErr').textContent = '追加する名前がありません（登録済みの名前は除外されます）');
      try { await backend.createMembers(names, validRole($('#nmBulkRole').value)); $('#nmBulk').value = ''; toast(`${names.length}名を追加しました`); }
      catch (e) { $('#nmErr').textContent = errMsg(e); }
    };
    $('#nmMigrate').onclick = async () => {
      $('#nmErr').textContent = '';
      const changes = MEMBERS.filter(m => !validRole(m.role))
        .map(m => ({ m, r: roleFromNote(m.note) })).filter(x => x.r);
      if (!changes.length) return ($('#nmErr').textContent = 'メモからロールを設定できるメンバーはいません');
      const count = {};
      for (const { r } of changes) count[r.role] = (count[r.role] || 0) + 1;
      const summary = ROLES.filter(r => count[r]).map(r => `${r}：${count[r]}名`).join('\n');
      const cleared = changes.filter(x => x.r.note === '').length;
      if (!confirm(`${changes.length}名にロールを設定します。\n\n${summary}\n\nうち ${cleared}名はメモがロール名だけのため、メモを空にします。よろしいですか？`)) return;
      const btn = $('#nmMigrate'); btn.disabled = true;
      try {
        await backend.saveMembers(changes.map(({ m, r }) => ({ ...m, role: r.role, note: r.note })));
        toast(`${changes.length}名にロールを設定しました`);
      } catch (e) { $('#nmErr').textContent = errMsg(e); }
      btn.disabled = false;
    };
  };
  $('#mSearch').oninput = render;
  $('#mRole').onchange = render;
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
      <div class="big">${esc(m.name)}${roleBadge(m.role)}</div>
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
          <div><label for="rRank">順位（順位なしは空欄）</label><input type="number" id="rRank" min="1" max="999" placeholder="順位なし" value="${r.rank || ''}"></div>
          <div><label for="rCount">参加チーム数（任意）</label><input type="number" id="rCount" min="1" max="999" value="${r.teamCount || ''}"></div>
        </div>
        <button class="primary wide" id="rSave" style="margin-top:10px">${editing ? '更新する' : '追加する'}</button>
        ${editing ? '<button class="wide" id="rCancel" style="margin-top:6px">編集をやめる</button>' : ''}
        <div class="err" id="rErr"></div>
      </div>
      <div class="card">
        <h2>メンバー情報</h2>
        <label for="emName">名前</label><input type="text" id="emName" maxlength="40" value="${esc(m.name)}">
        <label for="emRole">ロール</label><select id="emRole">${roleOptions(validRole(m.role))}</select>
        <label for="emNote">メモ</label><input type="text" id="emNote" maxlength="200" value="${esc(m.note || '')}">
        <button class="wide" id="emSave" style="margin-top:10px">保存</button>
        <button class="wide danger" id="emDel" style="margin-top:6px">このメンバーを削除</button>
        <div class="err" id="emErr"></div>
      </div>`;
    $('#rSave').onclick = async () => {
      $('#rErr').textContent = '';
      const tournamentName = cleanName($('#rName').value, 60);
      const rank = $('#rRank').value === '' ? null : Number($('#rRank').value);
      const teamCount = $('#rCount').value === '' ? null : Number($('#rCount').value);
      if (!tournamentName) return ($('#rErr').textContent = '大会名を入力してください');
      if (rank !== null && (!Number.isInteger(rank) || rank < 1 || rank > 999)) return ($('#rErr').textContent = '順位は 1 以上の整数で入力してください（順位なしの場合は空欄）');
      if (teamCount !== null && (!Number.isInteger(teamCount) || teamCount < (rank || 1) || teamCount > 999))
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
      try { await backend.saveMember({ id: mid, name, note: cleanName($('#emNote').value, 200), role: validRole($('#emRole').value), createdAt: m.createdAt }); toast('保存しました'); }
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
      <button class="wide danger" id="siteReset" style="margin-top:12px">サイト管理者キーをリセット（再発行）</button>
      <p class="hint">新しいキーを発行し、古いキーを無効にします。この端末以外のサイト管理者はすべてログアウトされます。</p>
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
    if ($('#siteReset')) $('#siteReset').onclick = async () => {
      if (!confirm('サイト管理者キーをリセットします。\n古いキーは使えなくなり、この端末以外のサイト管理者はログアウトされます。よろしいですか？')) return;
      try { await backend.resetSiteKey(); toast('新しいサイト管理者キーを発行しました。必ず控えてください'); } catch (e) { err(e); }
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

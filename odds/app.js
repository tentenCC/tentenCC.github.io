// 大会オッズ - 画面
import { firebaseConfig } from './firebase-config.js';
import { UNIT, calcOdds, buildView, computeSettlement } from './common.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString('ja-JP');
const fmtOdds = o => o == null ? '—' : o.toFixed(1);
const STATUS = { open: '投票受付中', closed: '締切', settled: '確定' };
const cleanName = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

// ---------- バックエンド選択 ----------
let backend;
try {
  if (firebaseConfig.projectId) {
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
  if (e && e.code === 'permission-denied') return '操作が許可されませんでした（状態が変わった可能性があります。再読み込みしてください）';
  return (e && e.message) || 'エラーが発生しました';
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------- ルーティング ----------
let unwatch = () => {};
function route() {
  unwatch(); unwatch = () => {};
  const m = location.hash.match(/^#\/t\/([A-Za-z0-9]+)/);
  if (m) showTournament(m[1]); else showHome();
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
          参加者は持ちポイントを使って「優勝すると思う出場者」に投票します（${UNIT}pt 単位）。<br>
          オッズは競馬の単勝と同じ<b>パリミュチュエル方式</b>で、投票が集まるたびにリアルタイムに変動します。<br>
          <b>オッズ ＝ 総投票額 ×（1 − 控除率）÷ その出場者への投票額</b>（0.1 倍未満切り捨て・最低 1.0 倍）<br>
          大会終了後に管理者が優勝者を確定すると、的中した投票に「投票額 × 確定オッズ」が払い戻されます。的中者がいない場合は全額返還です。
        </p>
      </div>
    </div>
    <div class="col">
      <div class="card">
        <h2>大会を作成</h2>
        <form id="createForm">
          <label for="cName">大会名</label>
          <input type="text" id="cName" maxlength="60" placeholder="例：社内将棋大会 2026" required>
          <label for="cEntrants">出場者（1 行に 1 名）</label>
          <textarea id="cEntrants" placeholder="山田&#10;佐藤&#10;鈴木&#10;田中"></textarea>
          <div class="row">
            <div><label for="cPoints">初期ポイント</label><input type="number" id="cPoints" value="1000" min="100" step="100"></div>
            <div><label for="cTake">控除率（%）</label><input type="number" id="cTake" value="0" min="0" max="50" step="1"></div>
          </div>
          <p class="hint">控除率 0% なら投票ポイントが全額払い戻しに回ります。競馬（単勝）は約 20%。</p>
          <button class="primary wide" style="margin-top:12px">作成する</button>
          <div class="err" id="cErr"></div>
        </form>
      </div>
    </div>
  </div>`;
  $('#createForm').onsubmit = async ev => {
    ev.preventDefault(); $('#cErr').textContent = '';
    const name = cleanName($('#cName').value, 60);
    const entrants = [...new Set($('#cEntrants').value.split(/\r?\n/).map(s => cleanName(s, 40)).filter(Boolean))];
    const initialPoints = Math.floor(Number($('#cPoints').value));
    const takeout = Math.round(Number($('#cTake').value)) / 100;
    if (!name) return ($('#cErr').textContent = '大会名を入力してください');
    if (entrants.length < 2) return ($('#cErr').textContent = '出場者は 2 名以上必要です');
    if (entrants.length > 200) return ($('#cErr').textContent = '出場者は 200 名までです');
    if (!(initialPoints >= UNIT && initialPoints <= 1e7)) return ($('#cErr').textContent = `初期ポイントは ${UNIT}〜10,000,000 で指定してください`);
    if (!(takeout >= 0 && takeout <= 0.5)) return ($('#cErr').textContent = '控除率は 0〜50% で指定してください');
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try {
      const r = await backend.createTournament({ name, entrants, initialPoints, takeout });
      justCreated = r.id;
      location.hash = '#/t/' + r.id;
    } catch (e) { $('#cErr').textContent = errMsg(e); if (btn) btn.disabled = false; }
  };
  unwatch = backend.listTournaments(list => {
    const el = $('#tList'); if (!el) return;
    el.innerHTML = list.length ? list.map(t => `
      <li>
        <a href="#/t/${esc(t.id)}">${esc(t.name)}</a>
        <span class="meta">出場 ${t.entrants.length}</span>
        <span class="badge ${esc(t.status)}">${STATUS[t.status] || ''}</span>
      </li>`).join('') : '<li class="empty">まだ大会がありません。右のフォームから作成してください。</li>';
  }, e => { const el = $('#tList'); if (el) el.innerHTML = `<li class="empty">${esc(errMsg(e))}</li>`; });
}

// ---------- 大会ページ ----------
let RAW = null;        // バックエンドの生データ
let T = null;          // 表示用データ
let selected = null;   // 選択中の出場者 ID
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
  $('#boardCard').innerHTML = `
    <div class="tHead">
      <h2>${esc(t.name)}</h2>
      <span class="badge ${t.status}">${STATUS[t.status]}</span>
    </div>
    <div class="stats">
      <span>総投票 <b>${fmt(t.pool)}</b> pt</span>
      <span>投票数 <b>${fmt(t.betCount)}</b></span>
      <span>参加者 <b>${fmt(t.userCount)}</b></span>
      <span>控除率 <b>${Math.round(t.takeout * 100)}</b>%</span>
    </div>
    ${winner ? `<div class="result" style="margin-top:12px">🏆 優勝：<b>${esc(winner.name)}</b>
      ${t.refunded ? '（的中者なしのため全額返還）' : `　単勝 <b>${fmtOdds(winner.odds)}</b> 倍`}</div>` : ''}
    <table class="board">
      <thead><tr><th>番</th><th>出場者</th><th style="text-align:right">オッズ</th><th style="text-align:center">人気</th>
        <th class="hideSm">支持率</th><th class="hideSm" style="text-align:right">投票額</th></tr></thead>
      <tbody>
      ${t.entrants.map((e, i) => `
        <tr data-id="${esc(e.id)}" class="${canPick ? 'pick' : ''} ${e.id === selected ? 'sel' : ''} ${e.id === t.winnerId ? 'win' : ''}">
          <td><span class="num">${i + 1}</span></td>
          <td class="ename">${e.id === t.winnerId ? '🏆 ' : ''}${esc(e.name)}</td>
          <td class="odds ${e.odds == null ? 'none' : e.odds === minOdds ? 'fav' : ''}">${fmtOdds(e.odds)}</td>
          <td class="pop ${e.popularity === 1 ? 'p1' : ''}">${e.popularity ? e.popularity + '番人気' : '—'}</td>
          <td class="hideSm"><div class="bar"><span style="width:${(e.votes / maxVotes * 100).toFixed(1)}%"></span></div>
            <div class="votes" style="text-align:left">${(e.share * 100).toFixed(1)}%</div></td>
          <td class="votes hideSm">${fmt(e.votes)}pt<br>${e.bettors}人</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${canPick ? '<p class="hint">行をクリックすると投票先に選択できます。オッズはリアルタイムに更新されます。</p>' :
      t.status === 'open' ? '<p class="hint">投票するには参加登録してください。</p>' : ''}`;
  $('#boardCard').querySelectorAll('tr.pick').forEach(tr => tr.onclick = () => {
    selected = tr.dataset.id; renderBoard(); updateSelection();
  });
}

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
  $('#selName').innerHTML = e ? esc(e.name) : '<span class="hint">オッズ表から出場者を選んでください</span>';
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

// ---------- 管理者 ----------
function renderAdminLogin() {
  const box = $('#adminLogin');
  if (RAW.isAdmin) { box.hidden = true; box.dataset.built = ''; return; }
  box.hidden = false;
  if (box.dataset.built) return;
  box.dataset.built = '1';
  box.innerHTML = `
    <details><summary style="cursor:pointer;font-size:13px">管理者としてログイン</summary>
      <label for="akey">管理者キー</label>
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
  // 入力中の値が消えないよう、状態・出場者が変わったときだけ作り直す
  const sig = [T.status, RAW.adminKey, ...T.entrants.map(e => e.id + e.name)].join('|');
  if (sig === adminSig) return;
  adminSig = sig;
  const url = location.origin + location.pathname + '#/t/' + tid;
  const t = T;
  const opts = t.entrants.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  card.innerHTML = `
    <h2>🔧 管理者メニュー</h2>
    <h3>参加者に共有する URL</h3>
    <div class="keyBox">${esc(url)}</div>
    <h3>管理者キー（他の端末で管理する場合に使用）</h3>
    <div class="keyBox">${esc(RAW.adminKey || '')}</div>
    ${t.status === 'settled' ? '' : `
      <h3>投票の受付</h3>
      ${t.status === 'open'
        ? '<button class="wide" id="admClose">投票を締め切る</button>'
        : '<button class="wide" id="admOpen">投票を再開する</button>'}
      <h3>出場者の追加・取消</h3>
      <div class="row"><input type="text" id="admAddName" maxlength="40" placeholder="追加する出場者名"><button id="admAdd" style="flex:0">追加</button></div>
      <select id="admRemoveSel" style="margin-top:6px">${opts}</select>
      <button class="wide danger" id="admRemove" style="margin-top:6px">選択した出場者を取消（投票は返還）</button>
      <h3>結果の確定</h3>
      <select id="admWinner"><option value="">優勝者を選択</option>${opts}</select>
      <button class="primary wide" id="admSettle" style="margin-top:6px">優勝者を確定して払い戻す</button>
      <p class="hint">確定すると取り消せません。受付中の場合は自動で締め切ってから確定します。</p>`}
    <h3>大会の削除</h3>
    <button class="danger wide" id="admDel">この大会を削除する</button>
    <div class="err" id="admErr"></div>
    <button class="small" id="admLogout" style="margin-top:12px">この端末の管理者権限を外す</button>`;

  const run = async (fn, msg) => {
    $('#admErr').textContent = '';
    try { await fn(); if (msg) toast(msg); } catch (e) { $('#admErr').textContent = errMsg(e); }
  };
  const on = (id, f) => { const el = $('#' + id); if (el) el.onclick = f; };
  on('admClose', () => run(() => backend.setStatus(tid, 'closed'), '投票を締め切りました'));
  on('admOpen', () => run(() => backend.setStatus(tid, 'open'), '投票を再開しました'));
  on('admAdd', () => {
    const name = cleanName($('#admAddName').value, 40);
    if (!name) return ($('#admErr').textContent = '名前を入力してください');
    if (T.entrants.some(e => e.name === name)) return ($('#admErr').textContent = '同名の出場者がいます');
    run(() => backend.addEntrant(tid, RAW, name), '出場者を追加しました');
  });
  on('admRemove', () => {
    const sel = $('#admRemoveSel'); const name = sel.options[sel.selectedIndex]?.text;
    if (T.entrants.length <= 2) return ($('#admErr').textContent = '出場者は 2 名以上必要です');
    if (!confirm(`「${name}」を取消します。この出場者への投票は全額返還されます。よろしいですか？`)) return;
    run(() => backend.removeEntrant(tid, RAW, sel.value), '出場者を取消しました');
  });
  on('admSettle', () => {
    const sel = $('#admWinner'); if (!sel.value) return ($('#admErr').textContent = '優勝者を選択してください');
    const e = T.entrants.find(x => x.id === sel.value);
    if (!confirm(`優勝者を「${e.name}」（現在 ${fmtOdds(e.odds)} 倍）で確定します。取り消せません。よろしいですか？`)) return;
    run(() => backend.settle(tid, RAW, computeSettlement(RAW, sel.value)), '結果を確定しました');
  });
  on('admDel', () => {
    if (!confirm(`大会「${T.name}」を削除します。元に戻せません。よろしいですか？`)) return;
    const id = tid;
    const raw = RAW;
    run(async () => {
      unwatch(); unwatch = () => {};
      try { await backend.deleteTournament(id, raw); }
      catch (e) { route(); throw e; }
      location.hash = '#/';
    }, '大会を削除しました');
  });
  on('admLogout', () => {
    if (!confirm('この端末から管理者権限を外します。管理者キーを控えていますか？')) return;
    run(() => backend.adminLogout(tid));
  });
}

route();

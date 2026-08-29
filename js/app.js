/* =========================================================
   CARD WALLET — 모바일 앱
   저장소: localStorage / 서버 없음 (혼자 쓰는 용도)
   ========================================================= */

const KEY = 'card-wallet:v1';
const $ = s => document.querySelector(s);

const store = {
  all(){ try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } },
  save(list){ localStorage.setItem(KEY, JSON.stringify(list)); },
};
let cards = store.all();

/* ---------- 시드 랜덤 ---------- */
function hash(str){
  let h = 2166136261;
  for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- 컬러 팔레트 (명함 1장 = 1컬러) ---------- */
const PALETTE = [
  ['#F7EC36','#111110'], ['#FF5A1F','#111110'], ['#FF3B30','#FBFBF8'],
  ['#FF4FA3','#111110'], ['#C5F23F','#111110'], ['#22E0A1','#111110'],
  ['#2B2BF5','#F4F4F0'], ['#7B4BFF','#F4F4F0'], ['#0F0F0E','#F2F2EC'],
  ['#F2F1EA','#111110'], ['#1B4D3E','#EDE6D2'], ['#F0A500','#111110'],
  ['#00B4D8','#0B1B1F'], ['#E8DCC8','#111110'], ['#5A5A55','#F4F4F0'],
];

function makeDesign(seedStr){
  const seed = hash(seedStr + ':' + Math.floor(Math.random() * 1e9));
  const r = rng(seed);
  return { seed, color: Math.floor(r() * PALETTE.length), variant: Math.floor(r() * 4) };
}

/* ---------- 시드 기반 기하학 마크 ---------- */
function monogram(seed){
  const r = rng(seed ^ 0x9e3779b9);
  const N = 4, cells = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N / 2; x++)
      if (r() > .38) cells.push([x, y], [N - 1 - x, y]);
  const rects = cells.map(([x, y]) => `<rect x="${x * 25}" y="${y * 25}" width="25" height="25"/>`).join('');
  const eye = r() > .5 ? `<circle cx="50" cy="${25 + Math.floor(r() * 2) * 25}" r="9" fill="var(--bg)"/>` : '';
  return `<svg class="b-mark" viewBox="0 0 100 100" aria-hidden="true">${rects}${eye}</svg>`;
}

/* ---------- 유틸 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
));
const fmtDate = d => d ? d.replaceAll('-', '.') : '';
const buzz = ms => { try { navigator.vibrate?.(ms); } catch {} };

function nameSize(name){
  let w = 0;
  for (const ch of name) w += /[\x00-\x7F]/.test(ch) ? .58 : 1;
  w += .34;
  return Math.min(34, Math.max(7, 80 / Math.max(w, 1))).toFixed(2) + 'cqw';
}

/* ---------- 명함 마크업 ---------- */
function frontHTML(c){
  const [bg, fg] = PALETTE[c.color % PALETTE.length];
  const tag = c.company || (c.tags?.[0] ?? 'CARD WALLET');
  return `<div class="card card-front" data-v="${c.variant % 4}" style="--bg:${bg};--fg:${fg};--fs:${nameSize(c.name)}">
    <span class="c-tag">${esc(tag.toUpperCase())}</span>
    <div class="c-name">${esc(c.name)}<span>.</span></div>
    <span class="c-bar"></span>
  </div>`;
}
function backHTML(c){
  const [bg, fg] = PALETTE[c.color % PALETTE.length];
  const lines = [c.title, ...(c.tags || [])].filter(Boolean).slice(0, 4);
  return `<div class="card card-back" style="--bg:${bg};--fg:${fg}">
    <div class="b-col">
      <div class="b-head">RECEIVED ${esc(fmtDate(c.date) || '—')}</div>
      <div class="b-body">
        <div class="b-company">${esc(c.company || c.name)}</div>
        <ul class="b-list">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>
      <div class="b-foot"><span>${esc(c.phone || '—')}</span><span>${esc(c.email || '')}</span></div>
    </div>
    ${monogram(c.seed)}
  </div>`;
}

/* ---------- 렌더 ---------- */
const stack = $('#stack'), grid = $('#grid');
const OFFSET = 40;
let mode = 'wallet';

function filtered(){
  const q = $('#search').value.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter(c =>
    [c.name, c.company, c.title, c.email, c.phone, c.memo, ...(c.tags || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(q)
  );
}

function render(){
  const list = filtered();
  $('#count').textContent = cards.length;

  const isEmpty = list.length === 0;
  $('#empty').hidden = !isEmpty;
  $('#empty .empty-big').innerHTML = (cards.length && isEmpty ? '찾는 명함이 없어요' : '지갑이 비어 있어요') + '<i>.</i>';
  $('#walletView').hidden = isEmpty || mode !== 'wallet';
  $('#gridView').hidden   = isEmpty || mode !== 'grid';

  const ordered = [...list].sort((a, b) => a.createdAt - b.createdAt);
  stack.innerHTML = ordered.map((c, i) =>
    `<div class="slot" data-id="${c.id}" style="--y:${i * OFFSET}px;z-index:${i + 1}">${frontHTML(c)}</div>`
  ).join('');
  grid.innerHTML = [...list].sort((a, b) => b.createdAt - a.createdAt)
    .map(c => `<div class="slot" data-id="${c.id}">${frontHTML(c)}</div>`).join('');

  layoutStack(ordered.length);
  if (openId) { const s = findSlot(openId); if (s) s.style.visibility = 'hidden'; }
}

function layoutStack(n){
  if (!n) { stack.style.height = '0px'; return; }
  const cardH = stack.clientWidth / 1.75;
  stack.style.height = ((n - 1) * OFFSET + cardH + 20) + 'px';
}
addEventListener('resize', () => layoutStack(stack.children.length));

/* ---------- 탭 / 검색 / 메뉴 ---------- */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  mode = t.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('is-on', x === t));
  $('#screen').scrollTop = 0;
  render();
});
$('#searchToggle').onclick = () => {
  const w = $('#searchWrap');
  w.hidden = !w.hidden;
  $('#moreMenu').hidden = true;
  if (!w.hidden) $('#search').focus();
  else { $('#search').value = ''; render(); }
};
$('#search').oninput = render;
$('#moreToggle').onclick = () => {
  const m = $('#moreMenu');
  m.hidden = !m.hidden;
};
document.addEventListener('click', e => {
  if (!e.target.closest('#moreMenu') && !e.target.closest('#moreToggle')) $('#moreMenu').hidden = true;
}, true);

/* =========================================================
   지갑에서 명함을 "뽑는" 인터랙션
   ========================================================= */
const viewer = $('#viewer'), vCard = $('#vCard'), flipper = $('#flipper');
let openId = null, busy = false;

const findSlot = id => (mode === 'wallet' ? stack : grid).querySelector(`.slot[data-id="${CSS.escape(id)}"]`);
const EASE = 'cubic-bezier(.32,.78,.24,1)';

/* 슬롯(from) → 상세 카드(to) 사이의 변환 + '지갑 밖으로 뽑힌' 중간 포즈 */
function pose(from, to){
  const s  = from.width / to.width;
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
  const appTop = $('#app').getBoundingClientRect().top;
  const lift = Math.max(40, Math.min(from.height * 1.3, from.top - appTop - 26));
  const midH = to.height * s * 1.06;
  const minY = (appTop + 54 + midH / 2) - (to.top + to.height / 2);   // 화면 위로 벗어나지 않게
  const midY = Math.max(dy - lift, minY);
  return { s, dx, dy, midY };
}

function pullOut(id, slotEl){
  if (busy) return;
  const c = cards.find(x => x.id === id);
  if (!c) return;
  openId = id;
  buzz(9);

  $('#vName').textContent = c.name;
  $('#vFront').innerHTML = frontHTML(c);
  $('#vBack').innerHTML = backHTML(c);
  flipper.classList.remove('is-flipped');
  vCard.style.transform = '';
  viewer.hidden = false;

  const from = slotEl?.getBoundingClientRect();
  const to = vCard.getBoundingClientRect();
  if (slotEl) slotEl.style.visibility = 'hidden';

  const fade = [{ opacity: 0 }, { opacity: 1 }];
  viewer.animate(fade, { duration: 260, easing: 'ease-out' });
  ['.viewer-bar', '.viewer-actions', '.viewer-tip'].forEach(sel =>
    viewer.querySelector(sel).animate(fade, { duration: 280, delay: 240, easing: 'ease-out', fill: 'backwards' })
  );

  if (!from) return;
  busy = true;
  const { s, dx, dy, midY } = pose(from, to);

  // ① 지갑에서 위로 뽑힌다 → ② 손 앞으로 날아온다 (구간별 이징)
  vCard.animate([
    { transform: `translate(${dx}px,${dy}px) scale(${s}) rotate(0deg)`,
      easing: 'cubic-bezier(.34,.02,.28,1)' },
    { transform: `translate(${dx + 6}px,${midY}px) scale(${s * 1.06}) rotate(-2.8deg)`, offset: .44,
      easing: 'cubic-bezier(.5,0,.2,1)' },
    { transform: `translate(${dx * .16}px,${dy * .1}px) scale(${s + (1 - s) * .9}) rotate(-.7deg)`, offset: .82,
      easing: 'ease-out' },
    { transform: 'translate(0,0) scale(1) rotate(0deg)' },
  ], { duration: 780, easing: 'linear' }).finished.then(() => { busy = false; });
}

function putBack(){
  if (busy || !openId) return;
  const id = openId, slotEl = findSlot(id);
  flipper.classList.remove('is-flipped');

  const finish = () => {
    viewer.hidden = true;
    vCard.style.transform = '';
    if (slotEl) slotEl.style.visibility = '';
    openId = null; busy = false;
  };

  const to = vCard.getBoundingClientRect();
  if (!slotEl){
    busy = true;
    viewer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).finished.then(finish);
    return;
  }
  busy = true;
  const from = slotEl.getBoundingClientRect();
  const { s, dx, dy, midY } = pose(from, to);

  // 뽑을 때의 역순: 지갑 위로 돌아갔다가 슬롯으로 미끄러져 들어간다
  vCard.animate([
    { transform: 'translate(0,0) scale(1) rotate(0deg)', easing: 'cubic-bezier(.4,0,.3,1)' },
    { transform: `translate(${dx + 6}px,${midY}px) scale(${s * 1.06}) rotate(-2.8deg)`, offset: .5,
      easing: 'cubic-bezier(.45,0,.25,1)' },
    { transform: `translate(${dx}px,${dy}px) scale(${s}) rotate(0deg)` },
  ], { duration: 620, easing: 'linear' });
  viewer.animate([{ opacity: 1 }, { opacity: .95, offset: .55 }, { opacity: 0 }], { duration: 620, easing: 'linear' })
    .finished.then(finish);
}

/* 카드 탭 → 뽑기 */
$('#screen').addEventListener('click', e => {
  const slot = e.target.closest('.slot');
  if (slot) pullOut(slot.dataset.id, slot);
  if (e.target.closest('[data-add]')) openSheet();
});
$('#viewerClose').onclick = putBack;
$('#flipBtn').onclick = () => { flipper.classList.toggle('is-flipped'); buzz(6); };

/* 카드 탭으로 뒤집기 + 아래로 밀어 지갑에 넣기 */
(function swipe(){
  let sy = 0, dy = 0, dragging = false, t0 = 0;
  vCard.addEventListener('pointerdown', e => {
    if (busy) return;
    dragging = true; sy = e.clientY; dy = 0; t0 = performance.now();
    vCard.setPointerCapture(e.pointerId);
    vCard.style.transition = 'none';
  });
  vCard.addEventListener('pointermove', e => {
    if (!dragging) return;
    dy = e.clientY - sy;
    const y = dy > 0 ? dy : dy * .18;
    vCard.style.transform = `translateY(${y}px) scale(${Math.max(.86, 1 - Math.max(dy, 0) / 900)})`;
    viewer.style.opacity = String(Math.max(.35, 1 - Math.max(dy, 0) / 420));
  });
  vCard.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    vCard.releasePointerCapture?.(e.pointerId);
    viewer.style.opacity = '';
    if (Math.abs(dy) < 8 && performance.now() - t0 < 400){        // 탭 = 뒤집기
      vCard.style.transform = '';
      flipper.classList.toggle('is-flipped'); buzz(6);
    } else if (dy > 110){                                          // 아래로 밀기 = 다시 넣기
      vCard.style.transform = '';
      putBack();
    } else {
      vCard.style.transition = 'transform .32s cubic-bezier(.2,.9,.25,1)';
      vCard.style.transform = '';
      setTimeout(() => { vCard.style.transition = 'none'; }, 340);
    }
  });
})();

/* ---------- 상세 액션 ---------- */
$('#recolorBtn').onclick = () => {
  const c = cards.find(x => x.id === openId);
  Object.assign(c, makeDesign(c.name + c.id));
  store.save(cards);
  $('#vFront').innerHTML = frontHTML(c);
  $('#vBack').innerHTML = backHTML(c);
  vCard.animate([{ transform:'scale(1)' }, { transform:'scale(1.04) rotate(1.2deg)' }, { transform:'scale(1)' }],
    { duration: 420, easing: EASE });
  render(); buzz(8); toast('디자인을 새로 뽑았어요');
};
$('#deleteBtn').onclick = () => {
  const c = cards.find(x => x.id === openId);
  if (!confirm(`'${c.name}' 명함을 지갑에서 뺄까요?`)) return;
  const id = openId;
  vCard.animate([{ transform:'translateY(0)', opacity:1 }, { transform:'translateY(60px) scale(.9)', opacity:0 }],
    { duration: 300, easing: 'ease-in' }).finished.then(() => {
      cards = cards.filter(x => x.id !== id);
      store.save(cards);
      openId = null; viewer.hidden = true; vCard.style.transform = '';
      render(); toast('명함을 뺐어요');
    });
};
$('#editBtn').onclick = () => { const id = openId; putBack(); setTimeout(() => openSheet(id), 380); };

/* ---------- 입력 시트 ---------- */
const sheetWrap = $('#sheetWrap'), form = $('#form');
let editId = null;

function openSheet(id = null){
  editId = id;
  form.reset();
  if (id){
    const c = cards.find(x => x.id === id);
    $('#sheetTitle').textContent = '명함 수정하기';
    $('#submitBtn').textContent = '저장';
    for (const k of ['name','company','title','date','phone','email','memo']) form.elements[k].value = c[k] || '';
    form.elements.tags.value = (c.tags || []).join(', ');
  } else {
    $('#sheetTitle').textContent = '명함 기록하기';
    $('#submitBtn').textContent = '지갑에 넣기';
    form.elements.date.value = new Date().toISOString().slice(0, 10);
  }
  sheetWrap.hidden = false;
  requestAnimationFrame(() => sheetWrap.classList.add('is-open'));
}
function closeSheet(){
  sheetWrap.classList.remove('is-open');
  setTimeout(() => { sheetWrap.hidden = true; editId = null; }, 320);
}
$('#addBtn').onclick = () => { openSheet(); buzz(9); };
$('#cancelBtn').onclick = closeSheet;
$('#sheetScrim').onclick = closeSheet;

form.addEventListener('submit', e => {
  e.preventDefault();
  const f = form.elements;
  const data = {
    name: f.name.value.trim(), company: f.company.value.trim(), title: f.title.value.trim(),
    date: f.date.value, phone: f.phone.value.trim(), email: f.email.value.trim(),
    memo: f.memo.value.trim(),
    tags: f.tags.value.split(',').map(s => s.trim()).filter(Boolean),
  };
  if (!data.name) return;

  if (editId){
    Object.assign(cards.find(x => x.id === editId), data);   // 디자인은 유지
    toast('수정했어요');
  } else {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    cards.push({ id, ...data, ...makeDesign(data.name + id), createdAt: Date.now() });
    toast('지갑에 넣었어요');
  }
  store.save(cards);
  closeSheet();
  mode = 'wallet';
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('is-on', x.dataset.tab === 'wallet'));
  render();
  buzz(12);
});

/* ---------- 토스트 ---------- */
let toastT;
function toast(msg){
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 1600);
}

/* ---------- 백업 ---------- */
$('#exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(cards, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `card-wallet-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  $('#moreMenu').hidden = true;
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming)) throw 0;
    const seen = new Set(cards.map(c => c.id));
    const add = incoming.filter(c => c && c.id && !seen.has(c.id));
    cards = cards.concat(add);
    store.save(cards); render(); toast(`${add.length}장 불러왔어요`);
  } catch { toast('불러올 수 없는 파일이에요'); }
  e.target.value = ''; $('#moreMenu').hidden = true;
};

/* ---------- 뒤로가기 / ESC ---------- */
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!sheetWrap.hidden) closeSheet();
  else if (!viewer.hidden) putBack();
});

/* ---------- 첫 실행 샘플 ---------- */
if (!localStorage.getItem(KEY)){
  const demo = [
    { name:'김지우', company:'파워하우스 중공업', title:'브랜드 디자이너', phone:'010-2200-8100', email:'jiwoo@powerhouse.co', date:'2026-08-21', tags:['디자인','컨퍼런스'] },
    { name:'BILL',   company:'Bill Heavy Equipment', title:'Sales Lead', phone:'(088)-800-800-700', email:'bill@heavyeqpt.com', date:'2026-07-14', tags:['machinery'] },
    { name:'박서준', company:'스튜디오 노트', title:'크리에이티브 디렉터', phone:'010-4412-9930', email:'sj@studionote.kr', date:'2026-06-02', tags:['협업제안'] },
  ];
  cards = demo.map((d, i) => {
    const id = 'demo' + i;
    return { id, memo:'', ...d, ...makeDesign(d.name + id), createdAt: Date.now() - (3 - i) * 86400000 };
  });
  store.save(cards);
}

render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
  navigator.serviceWorker.register('sw.js').catch(() => {});

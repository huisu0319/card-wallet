/* =========================================================
   photo.js — 명함 사진 → 텍스트 (온디바이스 OCR)
   · 사진 보관: IndexedDB
   · 인식: Tesseract.js (kor+eng), 브라우저 안에서만 동작
   ========================================================= */
window.Photo = (() => {

  /* ---------- IndexedDB (사진 원본 보관) ---------- */
  const DB_NAME = 'card-wallet', STORE = 'photos';
  let dbp = null;
  function db(){
    return dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn){
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode), s = t.objectStore(STORE);
      const req = fn(s);
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  }
  const put = (id, blob) => tx('readwrite', s => s.put(blob, id));
  const get = id => tx('readonly', s => s.get(id));
  const del = id => tx('readwrite', s => s.delete(id));

  /* ---------- 이미지 → 캔버스 (회전 보정 + 축소) ---------- */
  async function toCanvas(file, max = 1500){
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { bmp = await new Promise((res, rej) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
      img.src = url;
    }); }
    const w = bmp.width, h = bmp.height;
    const k = Math.min(1, max / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close?.();
    return cv;
  }

  /* ---------- OCR 전처리 ----------
     실제 폰 사진은 그림자·조명 얼룩 때문에 전역 이진화가 잘 안 먹는다.
     (1) 크게 확대 (2) 흑백 (3) 국소 평균으로 밝기 정규화 (4) 어두운 명함은 반전 */
  function preprocess(src){
    const MIN = 1900;
    const k = Math.min(2.2, src.width < MIN ? MIN / src.width : 1);
    const cv = document.createElement('canvas');
    cv.width = Math.round(src.width * k); cv.height = Math.round(src.height * k);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cv.width, cv.height);

    const W = cv.width, H = cv.height;
    const img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H;
    const gray = new Uint8Array(n);
    let dark = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++){
      const g = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0;
      gray[j] = g;
      if (g < 110) dark++;
    }
    if (dark / n > .6) for (let j = 0; j < n; j++) gray[j] = 255 - gray[j];   // 흰 글씨 명함

    // 적분영상으로 국소 평균 (박스 반경 = 폭의 1/20)
    const sum = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++){
      let row = 0;
      for (let x = 0; x < W; x++){
        row += gray[y * W + x];
        sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row;
      }
    }
    const r = Math.max(12, Math.round(W / 20));
    for (let y = 0; y < H; y++){
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++){
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        const area = (x1 - x0) * (y1 - y0);
        const mean = (sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1]
                    - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0]) / area;
        const v = Math.max(0, Math.min(255, (gray[y * W + x] / (mean + 1)) * 186));
        const i = (y * W + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  /* ---------- 보관용 JPEG ---------- */
  function compress(cv, max = 1200, q = .78){
    const k = Math.min(1, max / Math.max(cv.width, cv.height));
    const out = document.createElement('canvas');
    out.width = Math.round(cv.width * k); out.height = Math.round(cv.height * k);
    out.getContext('2d').drawImage(cv, 0, 0, out.width, out.height);
    return new Promise(res => out.toBlob(res, 'image/jpeg', q));
  }

  /* ---------- Tesseract 로드 (처음 인식할 때 한 번만) ---------- */
  const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let loadP = null;
  function loadEngine(){
    if (window.Tesseract) return Promise.resolve();
    return loadP ??= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = CDN;
      s.onload = () => res();
      s.onerror = () => { loadP = null; rej(new Error('engine')); };
      document.head.appendChild(s);
    });
  }

  const STEP = {
    'loading tesseract core':'인식 엔진 준비 중',
    'initializing tesseract':'인식 엔진 준비 중',
    'loading language traineddata':'한글 인식 데이터 받는 중',
    'initializing api':'준비 마무리 중',
    'recognizing text':'명함 읽는 중',
  };

  let active = null;                                   // 진행 중인 인식 (그만두기용)
  function abort(){ try { active?.terminate(); } catch {} active = null; }

  async function recognize(canvas, onProgress = () => {}){
    await loadEngine();
    const worker = await Tesseract.createWorker(['kor', 'eng'], 1, {
      logger: m => {
        const label = STEP[m.status] || '처리 중';
        const p = m.status === 'recognizing text' ? .55 + (m.progress || 0) * .45
                                                  : Math.min(.5, (m.progress || 0) * .5);
        onProgress(p, label);
      },
    });
    active = worker;
    try {
      await worker.setParameters({ preserve_interword_spaces: '1' });
      const { data } = await worker.recognize(canvas);
      return data;
    } finally { if (active === worker) active = null; try { worker.terminate(); } catch {} }
  }

  /* 큰 디스플레이 글씨는 자동 레이아웃 분석이 통째로 놓칠 때가 있다.
     이름을 못 찾으면 위쪽만 잘라 '한 덩어리(PSM 6)' 모드로 다시 읽는다. */
  async function recognizeTop(canvas, ratio = .55){
    await loadEngine();
    const crop = document.createElement('canvas');
    crop.width = canvas.width; crop.height = Math.round(canvas.height * ratio);
    crop.getContext('2d').drawImage(canvas, 0, 0, canvas.width, crop.height, 0, 0, crop.width, crop.height);
    const worker = await Tesseract.createWorker(['kor', 'eng'], 1);
    active = worker;
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      const { data } = await worker.recognize(crop);
      return data;
    } finally { if (active === worker) active = null; try { worker.terminate(); } catch {} }
  }

  /* 지정한 영역만 크게 키워 '한 줄(PSM 7)' 모드로 읽는다 — 큰 이름 글자에 특히 잘 듣는다 */
  async function recognizeBox(canvas, box, psm = '7'){
    await loadEngine();
    const padX = (box.x1 - box.x0) * .06, padY = (box.y1 - box.y0) * .28;
    const sx = Math.max(0, box.x0 - padX), sy = Math.max(0, box.y0 - padY);
    const sw = Math.min(canvas.width - sx, (box.x1 - box.x0) + padX * 2);
    const sh = Math.min(canvas.height - sy, (box.y1 - box.y0) + padY * 2);
    if (sw < 10 || sh < 10) return null;
    const k = Math.min(4, Math.max(1.5, 220 / sh));
    const crop = document.createElement('canvas');
    crop.width = Math.round(sw * k); crop.height = Math.round(sh * k);
    const c = crop.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    const worker = await Tesseract.createWorker(['kor', 'eng'], 1);
    active = worker;
    try {
      await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
      const { data } = await worker.recognize(crop);
      return data;
    } finally { if (active === worker) active = null; try { worker.terminate(); } catch {} }
  }

  /* 사진 한 장 → 명함 항목
     전체 한 번 + 위쪽 확대 한 번, 두 결과를 대조해서 확실한 것만 채운다. */
  async function read(canvas, onProgress = () => {}){
    const pre = preprocess(canvas);
    const A = parse(await recognize(pre, (p, l) => onProgress(p * .8, l)));

    onProgress(.84, '이름·직함 다시 확인 중');
    let B = null;
    try { B = parse(await recognizeTop(pre)); } catch {}

    const out = {
      name: '', title: '',
      company: A.company || B?.company || '',
      phone: A.phone || B?.phone || '',
      email: A.email || B?.email || '',
      memo: A.memo || '',
    };

    // 이름: 두 번 다 같게 읽혔으면 확정
    const a = A.name, b = B?.name || '';
    if (a && b && a === b) out.name = a;

    // 아니면 명함에서 글자가 가장 큰 줄(대개 이름)만 잘라 한 줄 모드로 정밀 판독
    if (!out.name){
      onProgress(.9, '이름 정밀 판독 중');
      const boxes = A.lines.filter(l => l.box && l.h > 0 && !/[@]/.test(l.text) && (l.box.x1 - l.box.x0) < pre.width * .8)
        .sort((x, y) => y.h - x.h).slice(0, 2);
      for (const l of boxes){
        try {
          const d = await recognizeBox(pre, l.box);
          const t = clean(d?.text || '').replace(/\n/g, ' ').trim();
          const hit = t.split(/\s{2,}/)[0].trim();
          if (validName(hit) && !snapTitle(hit)){ out.name = hit.replace(/\s/g, ''); break; }
        } catch {}
      }
    }
    // 그래도 없으면 확신도 높은 한쪽만 인정
    if (!out.name){
      if (a && A.nameConf >= 85) out.name = a;
      else if (b && (B?.nameConf || 0) >= 85) out.name = b;
    }

    // 직함: 사전에 맞춘 결과라 둘 중 아무거나 있으면 채운다 (서로 다르면 A 우선)
    out.title = A.title || B?.title || '';

    out.found = [out.name, out.company, out.title, out.phone, out.email].filter(Boolean).length;
    out.missName = !out.name;
    return out;
  }

  /* =========================================================
     인식 결과 → 명함 항목 추출
     원칙: 확실하지 않으면 틀리게 채우느니 비워 둔다.
     ========================================================= */

  /* 흔한 한국 성씨 — 이름이 제대로 읽혔는지 거르는 1차 관문 */
  const SURNAME = new Set(('김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구'
    + '나민진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉'
    + '사부함선기라피석온좌시대아자').split(''));
  const SURNAME2 = ['남궁', '황보', '제갈', '선우', '독고', '사공', '서문'];

  /* 직함 사전 — OCR 결과를 여기에 '맞춰' 넣는다 (없으면 비워 둠) */
  const TITLES = ['대표이사','대표','회장','부회장','사장','부사장','전무','상무','이사','감사','본부장','실장','센터장','소장','원장','국장',
    '팀장','파트장','부장','차장','과장','대리','주임','사원','인턴','수석','책임','선임','전임','총괄','매니저','리더',
    '디자이너','그래픽디자이너','브랜드디자이너','편집디자이너','제품디자이너','UX디자이너','UI디자이너','아트디렉터','크리에이티브디렉터','디렉터',
    '개발자','엔지니어','프로그래머','기획자','마케터','컨설턴트','연구원','연구소장','책임연구원','선임연구원',
    '교수','부교수','조교수','강사','조교','학생','대학원생','원생',
    '편집장','에디터','기자','작가','포토그래퍼','일러스트레이터','아티스트','프로듀서','플래너','바리스타','셰프','변호사','세무사','회계사','노무사','약사','간호사','의사','수의사','건축사',
    'CEO','CTO','COO','CFO','CMO','Director','Manager','Designer','Developer','Engineer','Producer','Founder','Lead','Head','Consultant','Researcher','Professor','Editor','Planner','Marketer','Architect','Curator','Partner','Analyst'];

  const ORG_WORDS = ['주식회사','㈜','(주)','유한회사','합자회사','스튜디오','컴퍼니','그룹','홀딩스','파트너스','에이전시','랩','연구소','연구원','센터','재단','협회','진흥원','공사','공단','대학교','대학','고등학교','병원','의원','약국','서점','갤러리','미술관','컴퍼니','Inc','Inc.','Corp','Corp.','Co.','Ltd','Ltd.','LLC','Company','Studio','Labs','Lab','Group','Agency','Institute','University','Gallery'];
  const DOMAINS = ['gmail.com','naver.com','daum.net','hanmail.net','kakao.com','nate.com','outlook.com','hotmail.com','yahoo.com','icloud.com','me.com','korea.com','empas.com'];
  const ADDR_HINT = /(\d+층|[0-9]+F\b|\d+호|로\s?\d+|길\s?\d+|시\s|구\s|동\s|읍\s|면\s|Seoul|Korea)/;

  /* 앞뒤에 붙은 한 글자짜리 부스러기·숫자 제거 */
  const junkTok = t => t.length === 1 || /^[^가-힣]{1,2}$/.test(t) || /^\d{1,2}$/.test(t);
  function tidy(s){
    let t = s.split(/\s+/).filter(Boolean);
    while (t.length > 1 && junkTok(t[0])) t.shift();
    while (t.length > 1 && junkTok(t[t.length - 1])) t.pop();
    return t.join(' ').trim();
  }
  const clean = s => s.replace(/[|_~•·∙●◆■□▪️※★☆]/g, ' ').replace(/\s{2,}/g, ' ').trim();

  /* 편집거리 (오타 교정용) */
  function lev(a, b){
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++){
      const cur = [i];
      for (let j = 1; j <= n; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  /* ---------- 이름: 성씨로 검증 ---------- */
  function validName(t){
    const s = t.replace(/\s/g, '');
    if (/^[가-힣]{2,4}$/.test(s))
      return SURNAME2.some(x => s.startsWith(x)) ? s.length >= 3 : SURNAME.has(s[0]);
    if (t.length <= 24 && /^[A-Z][A-Za-z.'-]{1,}(\s[A-Z][A-Za-z.'-]+){0,1}$/.test(t)
        && !ORG_WORDS.some(w => t.includes(w))) return true;
    return false;
  }

  /* ---------- 직함: 사전에 맞춰 교정 (못 맞추면 null) ---------- */
  function snapTitle(line){
    const toks = line.split(/[\s·\-|/,]+/)
      .filter(t => t.length > 1 || /^[가-힣]$/.test(t));      // 'a' 같은 부스러기 제거

    if (!toks.length) return null;
    let best = null;
    for (const tk of toks){
      const bare = tk.replace(/[^가-힣A-Za-z]/g, '');
      if (!bare) continue;
      for (const c of TITLES){
        if (bare === c || bare.endsWith(c)){ best = { tk, c, d: 0 }; break; }
        const lim = c.length >= 5 ? 2 : c.length >= 3 ? 1 : 0;
        const d = lev(bare, c);
        if (d <= lim && (!best || d < best.d)) best = { tk, c, d };
      }
      if (best && best.d === 0) break;
    }
    if (!best) return null;
    // 나머지 토큰이 깨끗할 때만 함께 살린다 ('브랜드 디자이니' → '브랜드 디자이너')
    const rest = toks.filter(t => t !== best.tk);
    const ok = rest.every(t => /^[가-힣]{1,6}$|^[A-Za-z]{1,12}$/.test(t));
    const fixed = best.d === 0 && ok ? toks.map(t => t === best.tk ? best.tk : t).join(' ')
                : ok ? toks.map(t => t === best.tk ? best.c : t).join(' ')
                : best.c;
    const out = tidy(fixed);
    return out.length <= 24 && out.length >= best.c.length ? out : best.c;
  }

  /* ---------- 연락처: 010 번호만 ---------- */
  function findPhone(all){
    const t = all.replace(/[OoＯ○ｏ]/g, '0').replace(/[lI|ｌ]/g, '1').replace(/[ㄱ-ㅣ]/g, '');
    const re = /(?:\+?82[-.\s]?)?0?1\s?0[-.\s)]{0,3}(\d{3,4})[-.\s]{0,3}(\d{4})/g;
    let m;
    while ((m = re.exec(t))){
      const mid = m[1], last = m[2];
      if (mid.length === 3 || mid.length === 4) return `010-${mid}-${last}`;
    }
    return '';
  }

  /* ---------- 메일: 흔한 오독 복구 ---------- */
  function findEmail(lines){
    const cands = [];
    for (const l of lines){
      for (const tk of l.text.split(/\s+/)) if (tk.includes('@')) cands.push(tk);   // 먼저 토큰 단위
      cands.push(l.text);                                                            // 그다음 줄 전체
    }
    for (const raw of cands){
      let t = raw.replace(/\s+/g, '').toLowerCase()
        .replace(/[＠ⓐ]/g, '@')
        .replace(/\.c0m\b/g, '.com').replace(/\.corn\b/g, '.com')
        .replace(/\.c0\.kr\b/g, '.co.kr').replace(/\.k1\b/g, '.kr');
      if (!t.includes('@')){                                  // @ 가 다른 글자로 읽힌 경우
        const m = t.match(/^[a-z0-9._%+-]{2,}[^a-z0-9._%+\-.]{1}[a-z0-9.-]{2,}\.[a-z]{2,}$/);
        if (m){
          const i = t.search(/[^a-z0-9._%+-]/);
          if (i > 1) t = t.slice(0, i) + '@' + t.slice(i + 1);
        }
      }
      const m2 = t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
      if (!m2) continue;
      let [local, domain] = m2[0].split('@');
      let best = null;
      for (const d of DOMAINS){ const dist = lev(domain, d); if (dist <= 2 && (!best || dist < best.d)) best = { d, dist }; }
      if (best) domain = best.d;
      if (!/^[a-z0-9._%+-]{2,}$/.test(local)) continue;
      return local + '@' + domain;
    }
    return '';
  }

  /* ---------- 본체 ---------- */
  /* 줄에는 부스러기가 섞이기 쉬워서, 이름은 '낱말' 단위로 본다 */
  function toWords(data){
    let ws = data?.words?.length ? data.words
      : (data?.lines || []).flatMap(l => l.words || []);
    if (!ws.length)
      ws = (data?.blocks || []).flatMap(b => (b.paragraphs || [])
        .flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
    return ws.map(w => ({
      text: clean(w.text || ''),
      conf: w.confidence ?? 0,
      h: w.bbox ? (w.bbox.y1 - w.bbox.y0) : 0,
      box: w.bbox || null,
    })).filter(w => w.text);
  }

  function toLines(data){
    const src = data?.lines?.length ? data.lines
      : (data?.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
    if (src?.length)
      return src.map((l, i) => ({
        text: clean(l.text || ''), h: l.bbox ? (l.bbox.y1 - l.bbox.y0) : 0,
        conf: l.confidence ?? 0, box: l.bbox || null, i,
      })).filter(l => l.text.length > 0);
    return (data?.text || '').split('\n').map((t, i) => ({ text: clean(t), h: 0, conf: 0, i })).filter(l => l.text);
  }

  function parse(data){
    const lines = toLines(data);
    const all = lines.map(l => l.text).join('\n');

    const email = findEmail(lines);
    const phone = findPhone(all);
    const site = (all.match(/(?:https?:\/\/)?(?:www\.)[\w-]+\.[\w.\/-]+/) || [''])[0];

    const isContact = t => /@/.test(t) || /\d{3}[\s.\-]\d{4}/.test(t) || /^[\d\s.\-+()]+$/.test(t)
      || /(www\.|https?:)/i.test(t) || ADDR_HINT.test(t);
    const body = lines.filter(l => !isContact(l.text));

    /* 직함 — 사전에 맞춘 것만 (확신도 낮은 줄은 제외) */
    let title = '', titleLine = null;
    for (const l of body){
      if (l.conf && l.conf < 55) continue;
      const snapped = snapTitle(l.text);
      if (snapped){ title = snapped; titleLine = l; break; }
    }

    /* 회사 */
    let company = '';
    const org = body.find(l => l !== titleLine && ORG_WORDS.some(w => l.text.includes(w)));
    if (org) company = tidy(org.text);

    /* 이름 — 줄 텍스트를 토큰으로 쪼개 성씨 검증을 통과한 것 중 글자가 가장 큰 줄에서 고른다
       (한글은 낱말이 음절로 쪼개지고, 줄에는 '、 개 이서연' 처럼 부스러기가 섞이기 때문) */
    const heights = body.map(l => l.h).filter(h => h > 0).sort((a, b) => a - b);
    const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    const inCompany = company.replace(/\s/g, '');
    let nameCand = null;
    for (const l of [...body].sort((a, b) => (b.h - a.h) || (b.conf - a.conf))){
      if (l === titleLine || l.text === company) continue;
      if (l.conf && l.conf < 45) continue;
      if (medH && l.h && l.h < medH * 1.05) continue;              // 큰 글씨 줄만 (이름은 대개 가장 큼)
      if (ORG_WORDS.some(o => l.text.includes(o))) continue;
      for (const tk of l.text.split(/\s+/)){
        const t = tk.replace(/[^가-힣A-Za-z.'-]/g, '');
        if (!t || t.length < 2) continue;
        if (inCompany.includes(t)) continue;
        if (title.includes(t) || snapTitle(t)) continue;
        if (!validName(t)) continue;
        nameCand = { text: t, conf: l.conf, h: l.h };
        break;
      }
      if (nameCand) break;
    }

    if (!company){
      const rest = body.filter(l => l !== titleLine && l.text.length >= 3
        && /[가-힣A-Za-z]{2,}/.test(l.text) && !(l.conf && l.conf < 60));
      rest.sort((a, b) => b.text.length - a.text.length);
      if (rest[0] && rest[0].text.length <= 40) company = tidy(rest[0].text);
    }

    const addr = lines.map(l => l.text).filter(t => ADDR_HINT.test(t) && !/@/.test(t)).slice(0, 2);
    const memo = [site, ...addr].filter(Boolean).join('\n');

    return { name: nameCand?.text || '', nameConf: nameCand?.conf || 0, company, title, phone, email, memo, lines };
  }

  return { put, get, del, toCanvas, preprocess, compress, recognize, recognizeTop, recognizeBox, parse, read, abort };
})();

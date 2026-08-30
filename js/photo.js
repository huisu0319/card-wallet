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
     Tesseract가 자체 이진화를 하므로 손을 많이 대면 오히려 글씨가 뭉갠다.
     여기서는 (1) 작은 사진 확대 (2) 흑백화 (3) 어두운 명함만 반전 — 이 셋만 한다. */
  function preprocess(src){
    const MIN = 1400;                                  // 글씨가 작으면 확대해야 잘 읽힌다
    const k = src.width < MIN ? MIN / src.width : 1;
    const cv = document.createElement('canvas');
    cv.width = Math.round(src.width * k); cv.height = Math.round(src.height * k);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cv.width, cv.height);

    const img = ctx.getImageData(0, 0, cv.width, cv.height), d = img.data;
    const n = d.length / 4, gray = new Uint8Array(n);
    let dark = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++){
      const g = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0;
      gray[j] = g;
      if (g < 110) dark++;
    }
    const invert = dark / n > .6;                      // 흰 글씨 / 어두운 명함
    for (let i = 0, j = 0; j < n; i += 4, j++){
      const v = invert ? 255 - gray[j] : gray[j];
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
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

  /* 사진 한 장 → 명함 항목 (전처리 → 인식 → 필요하면 이름 재시도) */
  async function read(canvas, onProgress = () => {}){
    const pre = preprocess(canvas);
    const data = await recognize(pre, onProgress);
    const r = parse(data);
    if (!r.name){
      onProgress(.9, '이름 다시 읽는 중');
      try {
        const r2 = parse(await recognizeTop(pre));
        if (r2.name){ r.name = r2.name; r.found++; }
        if (!r.title && r2.title) r.title = r2.title;
        if (!r.company && r2.company) r.company = r2.company;
      } catch {}
    }
    return r;
  }

  /* =========================================================
     인식 결과 → 명함 항목 추출
     ========================================================= */
  const TITLE_WORDS = ['대표이사','대표','사장','부사장','회장','전무','상무','이사','본부장','실장','팀장','파트장','부장','차장','과장','대리','주임','사원','매니저','디자이너','개발자','엔지니어','기획자','마케터','연구원','연구소장','교수','강사','조교','학생','원장','편집장','기자','작가','컨설턴트','대표변호사','변호사','세무사','약사','간호사','셰프','바리스타','디렉터','아트디렉터','크리에이티브디렉터','프로듀서','에디터','포토그래퍼','일러스트레이터','아티스트','플래너','총괄','수석','책임','선임','전임','인턴','PD','AD','MD','CEO','CTO','COO','CFO','Director','Manager','Designer','Developer','Engineer','Producer','Founder','Lead','Head','Consultant','Researcher','Professor','Curator','Editor','Planner','Marketer','Architect'];
  const ORG_WORDS = ['주식회사','㈜','(주)','유한회사','합자회사','스튜디오','컴퍼니','그룹','홀딩스','파트너스','에이전시','랩','연구소','연구원','센터','재단','협회','진흥원','공사','공단','대학교','대학','고등학교','병원','의원','약국','서점','갤러리','미술관','Inc','Inc.','Corp','Corp.','Co.','Ltd','Ltd.','LLC','Company','Studio','Labs','Lab','Group','Agency','Partners','Institute','University','Gallery'];
  const ADDR_HINT = /(\d+층|[0-9]+F\b|\d+호|로\s?\d+|길\s?\d+|시\s|구\s|동\s|읍\s|면\s|도로명|우편|Seoul|Korea)/;

  const clean = s => s.replace(/[|_~•·∙●◆■□▪️※★☆]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const hasHangul = s => /[가-힣]/.test(s);

  function fmtPhone(raw){
    let d = raw.replace(/[^\d+]/g, '');
    if (d.startsWith('+82')) d = '0' + d.slice(3);
    if (d.startsWith('82') && d.length > 10) d = '0' + d.slice(2);
    if (/^01\d{8,9}$/.test(d))      return d.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    if (/^02\d{7,8}$/.test(d))      return d.replace(/^(\d{2})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    if (/^0\d{9,10}$/.test(d))      return d.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    return raw.trim();
  }

  function parse(data){
    // 줄 목록 (글자 크기 정보가 있으면 함께)
    let lines = [];
    const src = data?.lines?.length ? data.lines
      : (data?.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
    if (src?.length){
      lines = src.map((l, i) => ({
        text: clean(l.text || ''),
        h: l.bbox ? (l.bbox.y1 - l.bbox.y0) : 0,
        conf: l.confidence ?? 0, i,
      })).filter(l => l.text.length > 0);
    } else {
      lines = (data?.text || '').split('\n').map((t, i) => ({ text: clean(t), h: 0, conf: 0, i })).filter(l => l.text);
    }
    const all = lines.map(l => l.text).join('\n');

    /* 이메일 */
    const email = (all.match(/[\w.+-]+\s?@\s?[\w-]+\.[\w.]{2,}/) || [''])[0].replace(/\s/g, '');

    /* 전화번호 — 휴대폰 우선 */
    const rawPhones = all.match(/(?:\+?82[\s.\-]?)?0?1[016789][\s.\-]?\d{3,4}[\s.\-]?\d{4}|0\d{1,2}[\s.\-)]{0,2}\d{3,4}[\s.\-]\d{4}/g) || [];
    const phones = [...new Set(rawPhones.map(fmtPhone))];
    let phone = phones.find(p => p.startsWith('01')) || phones[0] || '';
    if (!phone){                                        // (088) 800-800-700 같은 형태
      const cand = lines.filter(l => !/@/.test(l.text) && (l.text.match(/\d/g) || []).length >= 7);
      const pick = cand.find(l => /(휴대|모바일|Mobile|M\.|H\.?P|C\.?P)/i.test(l.text)) || cand[0];
      if (pick) phone = pick.text.replace(/^(전화|연락처|휴대폰|휴대|Mobile|Phone|Tel|T|M|HP|C\.?P)[\s.:·|]*/i, '').trim();
    }

    /* 홈페이지 */
    const site = (all.match(/(?:https?:\/\/)?(?:www\.)[\w-]+\.[\w.\/-]+|(?:https?:\/\/)[\w.-]+\.[\w.\/-]+/) || [''])[0];

    /* 연락처·주소 줄은 이름/회사 후보에서 제외 */
    const isContact = t => /@/.test(t) || /\d{3}[\s.\-]\d{4}/.test(t) || /^[\d\s.\-+()]+$/.test(t)
      || /(www\.|https?:)/i.test(t) || ADDR_HINT.test(t);

    const body = lines.filter(l => !isContact(l.text));

    /* 직함 */
    let title = '', titleIdx = -1;
    body.forEach((l, i) => {
      if (title) return;
      const hit = TITLE_WORDS.find(w => l.text.includes(w));
      if (hit){
        titleIdx = i;
        title = l.text.length <= 22 ? l.text.replace(/^[\s\-·]+|[\s\-·]+$/g, '') : hit;
      }
    });

    /* 회사 */
    let company = '';
    const org = body.find(l => ORG_WORDS.some(w => l.text.includes(w)));
    if (org) company = org.text;

    /* 이름 — 글자가 가장 큰 짧은 줄 */
    let nameCand = body.filter(l => {
      const t = l.text;
      if (t === company || (org && t === org.text)) return false;
      if (t === title) return false;
      if (TITLE_WORDS.some(w => t.includes(w))) return false;        // 직함 줄은 이름이 아니다
      if (/\d/.test(t)) return false;
      if (l.conf && l.conf < 60) return false;                        // 흐릿하게 읽은 줄은 이름으로 쓰지 않는다
      const kor = /^[가-힣]{2,5}$/.test(t.replace(/\s/g, ''));
      const korSpaced = /^[가-힣](\s?[가-힣]){1,4}$/.test(t);
      if (ORG_WORDS.some(w => t.includes(w))) return false;
      const eng = t.length <= 28 && /^[A-Z][A-Za-z.'-]+(\s[A-Z][A-Za-z.'-]+){0,1}$/.test(t);  // 최대 두 단어
      return kor || korSpaced || eng;
    });
    // 다른 줄에 통째로 들어있는 조각('아트' ⊂ '아트 디렉터')은 이름이 아니다
    nameCand = nameCand.filter(l =>
      !lines.some(o => o !== l && o.text.length > l.text.length && o.text.includes(l.text)));

    let name = '';
    if (nameCand.length){
      nameCand.sort((a, b) => (b.h - a.h) || (a.i - b.i) || (b.conf - a.conf));   // 큰 글씨 → 위쪽 줄 순
      name = nameCand[0].text;
      if (hasHangul(name)) name = name.replace(/\s/g, '');       // '홍 길 동' → '홍길동'
    }
    // 이름 + 직함이 한 줄에 섞인 경우
    if (!name){
      for (const l of body){
        if (l.text === title) continue;                 // 직함 줄을 쪼개 이름으로 쓰지 않는다
        const m = l.text.match(/^([가-힣]{2,4})\s+(.{2,20})$/);
        if (m && !TITLE_WORDS.some(w => m[1].includes(w)) && TITLE_WORDS.some(w => m[2].includes(w))){
          name = m[1]; title ||= m[2]; break;
        }
      }
    }
    if (name && title === name) title = '';

    /* 회사를 못 찾았으면: 이름·직함이 아닌 가장 긴 줄 */
    if (!company){
      const rest = body.filter(l => l.text !== name && l.text !== title && l.text.length >= 3
        && /[가-힣A-Za-z]{2,}/.test(l.text)                     // 기호 조각은 회사가 아니다
        && !(l.conf && l.conf < 60));
      rest.sort((a, b) => b.text.length - a.text.length);
      if (rest[0] && rest[0].text.length <= 40) company = rest[0].text;
    }

    /* 메모: 주소·홈페이지 */
    const addr = lines.map(l => l.text).filter(t => ADDR_HINT.test(t) && !/@/.test(t)).slice(0, 2);
    const memo = [site, ...addr].filter(Boolean).join('\n');

    const found = [name, company, title, phone, email].filter(Boolean).length;
    return { name, company, title, phone, email, memo, found, text: all };
  }

  return { put, get, del, toCanvas, preprocess, compress, recognize, recognizeTop, parse, read, abort };
})();

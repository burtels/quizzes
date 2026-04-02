// app.js (FULL) — Quiz engine (NO chroma key / NO WebGL)
// Includes:
// - QUESTION type "video" (big slide video + multi-field answers) with optional overlay badge image: q.media.overlayImage
// - "video-text" backwards-compat (video + single text answer) with optional overlay badge
// - "media-grid" (image tiles OR video tiles w/ poster + exclusive video playback + per-tile multi-fields)
// - "multi-text" upgraded with answer.mode="pool" to allow "pick N from pool" (e.g., 2 boxes, 7 accepted answers)
// - Round title shown ABOVE slide (image/video)
// - View-mode "Show Answer" supports multi-line wrapping (feedback box pre-wrap)
// - Injects a small CSS patch for slide overlay positioning/sizing + feedback wrapping + media-grid video sizing

const $ = (s) => document.querySelector(s);
const elMain = $("#main");
const elBgVideo = $("#bgVideo");
const elBgImage = $("#bgImage");

const APP = {
  homeLogo: "assets/logo.png",
  menuBgVideo: "assets/menu-bg.mp4",
  menuBgImage: "assets/menu-bg.jpg",

  // Home buttons
  btnHomePlayImage: "assets/play.png",
  btnHomeSearchImage: "assets/search.png",
  btnHomeRandomImage: "assets/random.png",

  // Quiz list mode buttons
  btnExploreModeImage: "assets/explore-mode.png",
  btnHostModeImage: "assets/host-mode.png",
  btnPlayModeImage: "assets/play-mode.png",

  // In-quiz buttons
  btnBackImage: "assets/back.png",
  btnNextImage: "assets/next.png",
  btnSubmitImage: "assets/submit.png",
  btnQuitImage: "assets/quit.png",

  // View-mode extras
  btnRoundsImage: "assets/rounds.png",
  btnShowAnswerImage: "assets/answer.png",

  // Settings overlay
  btnCloseImage: "assets/close.png",

  // Results
  btnBackToListImage: "assets/back.png",
};

const State = {
  view: "home",       // home | pick | play | results | search
  quizId: null,
  roundIdx: 0,
  qIdx: 0,
  mode: "play",       // "play" | "host" | "explore"
  immediate: false,
  answers: {},
  submitted: {},
  lastFeedback: null,

  settingsOpen: false,
  roundsOpen: false,

  // Results UI state
  resultsOpenRoundId: null,

  revealAnswers: false,
  tempReveal: false,
  confirmQuit: false,
  confirmSubmit: false,
};

const LoadedScripts = new Set();

/* ---------------- Background ---------------- */
function setBackground(videoSrc, imageSrc){
  if(videoSrc){
    if(elBgVideo.getAttribute("src") !== videoSrc) elBgVideo.src = videoSrc;
    elBgVideo.style.display = "";
    elBgVideo.play().catch(()=>{});
  } else {
    elBgVideo.style.display = "none";
    try { elBgVideo.pause(); } catch {}
  }

  if(imageSrc){
    elBgImage.src = imageSrc;
    elBgImage.style.display = "";
  } else {
    elBgImage.style.display = "none";
  }
}

function applyBackground(){
  if(State.view === "play"){
    const quiz = getQuiz();
    const round = getRound();
    setBackground(round?.bgVideo || quiz?.bgVideo || "", round?.bgImage || quiz?.bgImage || "");
  } else {
    setBackground(APP.menuBgVideo, APP.menuBgImage);
  }
}

/* ---------------- Quiz loading ---------------- */
function ensureQuizLoaded(quizId){
  const idx = (window.QUIZ_INDEX || []).find(q => q.id === quizId);
  if(!idx) return Promise.reject(new Error("Quiz not found in QUIZ_INDEX: " + quizId));

  window.QUIZ_STORE = window.QUIZ_STORE || {};
  if(window.QUIZ_STORE[quizId]) return Promise.resolve();

  const file = idx.file;
  if(LoadedScripts.has(file)){
    return window.QUIZ_STORE[quizId]
      ? Promise.resolve()
      : Promise.reject(new Error("Quiz script loaded but did not register: " + quizId));
  }

  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = file;
    s.onload = () => {
      LoadedScripts.add(file);
      if(window.QUIZ_STORE[quizId]) resolve();
      else reject(new Error("Quiz script loaded but did not register: " + quizId));
    };
    s.onerror = () => reject(new Error("Failed to load quiz file: " + file));
    document.body.appendChild(s);
  });
}

/* ---------------- Getters ---------------- */
function getQuiz(){ return (window.QUIZ_STORE || {})[State.quizId] || null; }
function getRound(){
  const q = getQuiz();
  return q ? q.rounds[State.roundIdx] : null;
}
function getQuestion(){
  const r = getRound();
  return r ? r.questions[State.qIdx] : null;
}


function getQuestionRefs(){
  const quiz = getQuiz();
  if(!quiz) return [];
  const refs = [];
  (quiz.rounds || []).forEach((round, roundIdx) => {
    (round.questions || []).forEach((question, qIdx) => {
      refs.push({ roundIdx, qIdx, qid: question.id, roundTitle: round.title || `Round ${roundIdx+1}`, question });
    });
  });
  return refs;
}

function getCurrentLinearPos(){
  const refs = getQuestionRefs();
  return refs.findIndex(ref => ref.roundIdx === State.roundIdx && ref.qIdx === State.qIdx);
}

function goToLinearPos(pos){
  const refs = getQuestionRefs();
  const ref = refs[pos];
  if(!ref) return false;
  State.roundIdx = ref.roundIdx;
  State.qIdx = ref.qIdx;
  State.lastFeedback = null;
  State.tempReveal = false;
  if(State.mode !== 'explore') State.revealAnswers = false;
  renderPlay();
  return true;
}

function markCurrentVisited(){
  const pos = getCurrentLinearPos();
  if(pos >= 0) State.maxVisitedPos = Math.max(State.maxVisitedPos, pos);
}

function canGoPrevQuestion(){
  const pos = getCurrentLinearPos();
  return pos > 0;
}

function hasFutureVisitedQuestion(){
  const refs = getQuestionRefs();
  const pos = getCurrentLinearPos();
  return pos >= 0 && pos < Math.min(State.maxVisitedPos, refs.length - 1);
}

function getRoundTopicRefs(){
  const quiz = getQuiz();
  if(!quiz) return [];
  const out = [];
  (quiz.rounds || []).forEach((round, roundIdx) => {
    const firstQuestion = (round.questions || [])[0];
    if(!firstQuestion) return;
    out.push({ roundIdx, qIdx: 0, qid: firstQuestion.id, roundTitle: round.title || `Round ${roundIdx+1}`, question: firstQuestion });
  });
  return out;
}

function getVisibleTopicRefs(){
  const refs = getRoundTopicRefs();
  if(State.mode !== 'play') return refs;
  return refs.filter(ref => {
    const linearPos = getQuestionRefs().findIndex(x => x.roundIdx === ref.roundIdx && x.qIdx === ref.qIdx);
    return linearPos >= 0 && linearPos <= State.maxVisitedPos;
  });
}

function canJumpToTopicPos(pos){
  if(pos < 0) return false;
  if(State.mode === 'play') return pos <= State.maxVisitedPos;
  return true;
}

function isCountableQuestionForNumbering(q){
  const typeKey = (q?.type || 'text');
  return !['title','round'].includes(typeKey);
}

function getQuestionDisplayNumber(roundIdx, qIdx){
  const quiz = getQuiz();
  const round = quiz?.rounds?.[roundIdx];
  if(!round) return null;
  const current = round.questions?.[qIdx];
  if(!current || !isCountableQuestionForNumbering(current)) return null;
  let count = 0;
  (round.questions || []).forEach((question, idx) => {
    if(idx <= qIdx && isCountableQuestionForNumbering(question)) count++;
  });
  return count || null;
}

function getQuestionMarkerHtml(q, roundIdx, qIdx){
  const typeKey = getQuestionType(q);
  if(typeKey === 'video' || typeKey === 'media-grid') return '';
  const refImage = q?.refImage || q?.media?.refImage || '';
  if(refImage){
    return `<img class="questionMarkerImg" src="${escapeAttr(refImage)}" alt="">`;
  }
  const displayNum = getQuestionDisplayNumber(roundIdx, qIdx);
  if(!displayNum) return '';
  return `<div class="questionMarkerNum" aria-label="Question ${displayNum}">${displayNum}</div>`;
}

function isQuestionSubmitted(q){
  return !!State.submitted[q?.id];
}

function canGoBackCurrent(){
  return canGoPrevQuestion();
}

function canGoNextCurrent(){
  const q = getQuestion();
  if(!q) return false;

  const typeKey = getQuestionType(q);
  if(typeKey === "title" || typeKey === "round") return true;

  // In play / explore / host, always allow Next.
  // The handler will move forward or open final submit when at the end.
  return true;
}

/* ---------------- Helpers ---------------- */
function normalize(t){ return (t||"").toLowerCase().replace(/[^a-z0-9]/g,""); }
function match(user, list){ return (list||[]).some(x => normalize(user) === normalize(x)); }

function isRevealMode(){
  return !!State.revealAnswers || !!State.tempReveal;
}

function shouldRevealQuestion(q){
  if(!q) return isRevealMode();
  if(isExploreMode() && State.submitted[q.id]) return false;
  return isRevealMode();
}

function firstAccepted(list){
  return (Array.isArray(list) && list.length) ? (list[0] || "") : "";
}

function getRevealAnswerValue(q, typeKey){
  if(typeKey === "mcq" || typeKey === "audio-mcq") return q.answer?.correctOptionId ?? "";

  if(typeKey === "music-map") {
    const acceptedMap = q.answer?.acceptedMap || {};
    const out = {};
    Object.keys(acceptedMap).forEach(label => { out[label] = firstAccepted(acceptedMap[label]); });
    return out;
  }

  if(typeKey === "multi-text") {
    const mode = (q.answer?.mode || "").toLowerCase();
    if(mode === "pool") {
      const pool = Array.isArray(q.answer?.acceptedPool) ? q.answer.acceptedPool : [];
      const required = Number.isFinite(q.answer?.requiredCorrect) ? q.answer.requiredCorrect : ((Array.isArray(q.parts) ? q.parts.length : pool.length) || 0);
      return pool.slice(0, required);
    }
    const parts = q.answer?.acceptedParts || [];
    return parts.map(part => firstAccepted(part));
  }

  if(typeKey === "media-grid") {
    const items = Array.isArray(q.media?.items) ? q.media.items : [];
    const accepted = q.answer?.accepted || {};
    const out = {};
    for(const it of items){
      const itemId = String(it.id ?? "");
      if(!itemId) continue;
      const fields = Array.isArray(it.fields) && it.fields.length ? it.fields : ["Answer"];
      out[itemId] = {};
      for(const f of fields){
        out[itemId][f] = firstAccepted((accepted[itemId] || {})[f] || []);
      }
    }
    return out;
  }

  if(typeKey === "video") {
    const fields = (Array.isArray(q.fields) && q.fields.length) ? q.fields : ((Array.isArray(q.media?.fields) && q.media.fields.length) ? q.media.fields : ["Answer"]);
    const accepted = q.answer?.accepted || {};
    const out = {};
    for(const f of fields) out[f] = firstAccepted(accepted[f] || []);
    return out;
  }

  return firstAccepted(q.answer?.accepted || []);
}

function clearAnswerStateClasses(){
  elMain.querySelectorAll('.answerWrong, .answerCorrect, .answerReveal, .answerShown, .mcqWrong, .mcqCorrect').forEach(el => {
    el.classList.remove('answerWrong', 'answerCorrect', 'answerReveal', 'answerShown', 'mcqWrong', 'mcqCorrect');
  });
}

function markTextLikeWrong(){
  elMain.querySelectorAll('#ansText, #ansAudioText, .multiIn, .gridIn, .videoIn, .musicIn').forEach(el => el.classList.add('answerWrong'));
}

function markTextLikeCorrect(){
  elMain.querySelectorAll('#ansText, #ansAudioText, .multiIn, .gridIn, .videoIn, .musicIn').forEach(el => el.classList.add('answerCorrect'));
}

function markMcqState(q, chosenValue){
  const correctId = q.answer?.correctOptionId ?? "";
  elMain.querySelectorAll('.mcqOpt').forEach(opt => {
    const optId = opt.getAttribute('data-optid') || opt.querySelector('input[type="radio"]')?.value || '';
    if(optId === chosenValue && chosenValue && chosenValue !== correctId) opt.classList.add('mcqWrong');
    if(optId === correctId) opt.classList.add('mcqCorrect');
  });
}

function markMcqSubmittedState(q, chosenValue){
  const correctId = q.answer?.correctOptionId ?? '';
  elMain.querySelectorAll('.mcqOpt').forEach(opt => {
    const optId = opt.getAttribute('data-optid') || opt.querySelector('input[type="radio"]')?.value || '';
    opt.classList.remove('mcqCorrect', 'mcqWrong', 'answerShown', 'answerReveal');

    if(optId === chosenValue && chosenValue){
      opt.classList.add(optId === correctId ? 'mcqCorrect' : 'mcqWrong');
    }
  });
}

function markMcqRevealState(q){
  const correctId = q.answer?.correctOptionId ?? '';
  elMain.querySelectorAll('.mcqOpt').forEach(opt => {
    const optId = opt.getAttribute('data-optid') || opt.querySelector('input[type="radio"]')?.value || '';
    if(optId === correctId && correctId) opt.classList.add('answerShown','answerReveal');
  });
}

function autosizeRevealedTextareas(){
  elMain.querySelectorAll('textarea.answerShown, textarea.answerReveal').forEach(el => {
    el.classList.add('revealMultiline');
    el.style.height = 'auto';
    el.style.maxHeight = 'none';
    el.style.minHeight = 'calc(1.5em + 18px)';
    el.style.height = Math.max(el.scrollHeight, 56) + 'px';
  });
}

function markSingleTextField(selector, accepted, value){
  const el = elMain.querySelector(selector);
  if(!el) return false;
  const ok = match(value || '', accepted || []);
  el.classList.add(ok ? 'answerCorrect' : 'answerWrong');
  return ok;
}

function revealSingleTextField(selector, correctValue){
  const el = elMain.querySelector(selector);
  if(!el || !el.classList.contains('answerWrong')) return;
  el.value = correctValue || '';
  el.readOnly = true;
  el.classList.remove('answerWrong', 'answerReveal', 'answerCorrect');
  el.classList.add('answerShown');
}

function markVideoFieldStates(q, value){
  const accepted = q.answer?.accepted || {};
  let allCorrect = true;
  elMain.querySelectorAll('.videoIn').forEach(inp => {
    const field = inp.getAttribute('data-field');
    const ok = match((value?.[field] || ''), accepted[field] || []);
    inp.classList.add(ok ? 'answerCorrect' : 'answerWrong');
    if(!ok) allCorrect = false;
  });
  return allCorrect;
}

function revealWrongVideoFields(q){
  const accepted = q.answer?.accepted || {};
  elMain.querySelectorAll('.videoIn').forEach(inp => {
    if(!inp.classList.contains('answerWrong')) return;
    const field = inp.getAttribute('data-field');
    inp.value = firstAccepted(accepted[field] || []);
    inp.readOnly = true;
    inp.classList.remove('answerWrong', 'answerReveal', 'answerCorrect');
    inp.classList.add('answerShown');
  });
}

function markMusicMapFieldStates(q, value){
  const acceptedMap = q.answer?.acceptedMap || {};
  let allCorrect = true;
  elMain.querySelectorAll('.musicIn').forEach(inp => {
    const label = inp.getAttribute('data-label');
    const ok = match((value?.[label] || ''), acceptedMap[label] || []);
    inp.classList.add(ok ? 'answerCorrect' : 'answerWrong');
    if(!ok) allCorrect = false;
  });
  return allCorrect;
}

function revealWrongMusicMapFields(q){
  const acceptedMap = q.answer?.acceptedMap || {};
  elMain.querySelectorAll('.musicIn').forEach(inp => {
    if(!inp.classList.contains('answerWrong')) return;
    const label = inp.getAttribute('data-label');
    inp.value = firstAccepted(acceptedMap[label] || []);
    inp.readOnly = true;
    inp.classList.remove('answerWrong', 'answerReveal', 'answerCorrect');
    inp.classList.add('answerShown');
  });
}

function markMediaGridPerField(q, value){
  const accepted = q.answer?.accepted || {};
  let allCorrect = true;
  elMain.querySelectorAll('.gridIn').forEach(inp => {
    const itemId = inp.getAttribute('data-item');
    const field = inp.getAttribute('data-field');
    if(!itemId || !field) return;
    const ok = match(((value?.[itemId] || {})[field] || ''), ((accepted[itemId] || {})[field] || []));
    inp.classList.add(ok ? 'answerCorrect' : 'answerWrong');
    if(!ok) allCorrect = false;
  });
  return allCorrect;
}

function revealMediaGridWrongFieldsOnly(q){
  const accepted = q.answer?.accepted || {};
  elMain.querySelectorAll('.gridIn').forEach(inp => {
    if(!inp.classList.contains('answerWrong')) return;
    const itemId = inp.getAttribute('data-item');
    const field = inp.getAttribute('data-field');
    if(!itemId || !field) return;
    inp.value = firstAccepted(((accepted[itemId] || {})[field] || []));
    inp.readOnly = true;
    inp.classList.remove('answerWrong', 'answerReveal', 'answerCorrect');
    inp.classList.add('answerShown');
  });
}

function markMultiTextFieldStates(q, value){
  const user = Array.isArray(value) ? value : [];
  const ans = q.answer || {};
  let allCorrect = true;
  const inputs = Array.from(elMain.querySelectorAll('.multiIn'));

  if((ans.mode || '').toLowerCase() === 'pool'){
    const pool = Array.isArray(ans.acceptedPool) ? ans.acceptedPool : [];
    const poolSet = new Set(pool.map(normalize).filter(Boolean));
    const used = new Set();
    inputs.forEach((inp, i) => {
      const nu = normalize(user[i] || '');
      const ok = !!nu && poolSet.has(nu) && (!used.has(nu) || ans.unique === false);
      if(ok && ans.unique !== false) used.add(nu);
      inp.classList.add(ok ? 'answerCorrect' : 'answerWrong');
      if(!ok) allCorrect = false;
    });
    return allCorrect;
  }

  const parts = ans.acceptedParts || [];
  if(!ans.orderInsensitive){
    inputs.forEach((inp, i) => {
      const ok = (parts[i] || []).some(a => normalize(user[i] || '') === normalize(a));
      inp.classList.add(ok ? 'answerCorrect' : 'answerWrong');
      if(!ok) allCorrect = false;
    });
    return allCorrect;
  }

  const matched = new Array(parts.length).fill(false);
  inputs.forEach((inp, i) => {
    const nu = normalize(user[i] || '');
    let ok = false;
    if(nu){
      for(let p=0; p<parts.length; p++){
        if(matched[p]) continue;
        if((parts[p] || []).some(a => normalize(a) === nu)){
          matched[p] = true;
          ok = true;
          break;
        }
      }
    }
    inp.classList.add(ok ? 'answerCorrect' : 'answerWrong');
    if(!ok) allCorrect = false;
  });
  return allCorrect;
}

function revealWrongMultiTextFields(q){
  const revealVals = getRevealAnswerValue(q, 'multi-text');
  elMain.querySelectorAll('.multiIn').forEach((inp, i) => {
    if(!inp.classList.contains('answerWrong')) return;
    inp.value = Array.isArray(revealVals) ? (revealVals[i] || '') : '';
    inp.readOnly = true;
    inp.classList.remove('answerWrong', 'answerReveal', 'answerCorrect');
    inp.classList.add('answerShown');
  });
}

function applyRevealMediaToCurrentDom(q, typeKey){
  const slideEl = elMain.querySelector('.slide');
  if(slideEl && q?.media?.answerImage){
    if(typeKey === 'video'){
      slideEl.innerHTML = `<img src="${escapeAttr(q.media.answerImage)}" alt="">${q.media?.answerOverlayImage ? `<img class="slideOverlay" src="${escapeAttr(q.media.answerOverlayImage)}" alt="" aria-hidden="true">` : ''}`;
    } else {
      const img = slideEl.querySelector('img:not(.slideOverlay)');
      if(img) img.src = q.media.answerImage;
    }
  }
  if(slideEl && q?.media?.answerOverlayImage){
    let overlay = slideEl.querySelector('.slideOverlay');
    if(!overlay){
      overlay = document.createElement('img');
      overlay.className = 'slideOverlay';
      overlay.alt = '';
      overlay.setAttribute('aria-hidden', 'true');
      slideEl.appendChild(overlay);
    }
    overlay.src = q.media.answerOverlayImage;
  }
  const intro = elMain.querySelector('.gridIntroImg');
  if(intro && q?.media?.answerIntroImage) intro.src = q.media.answerIntroImage;

  if(typeKey === 'media-grid'){
    const items = Array.isArray(q.media?.items) ? q.media.items : [];
    items.forEach(it => {
      const key = `${q.id}::${it.id}`;
      const imgEl = elMain.querySelector(`img[data-img-for="${CSS.escape(key)}"]`);
      if(imgEl && it.answerImage) imgEl.src = it.answerImage;
      const poster = elMain.querySelector(`button[data-qid="${CSS.escape(q.id)}"][data-item="${CSS.escape(String(it.id))}"] .gridPoster`);
      if(poster && it.answerImage) poster.src = it.answerImage;
    });
  }

  if((typeKey === 'audio-text' || typeKey === 'audio-mcq') && q?.media?.answerImage){
    const img = elMain.querySelector('.audioLeftImg');
    if(img) img.src = q.media.answerImage;
  }
}

const WRONG_DELAY_MS = 2500;

function slideSrcForQuestion(q, round){
  const quiz = getQuiz();
  const typeKey = getQuestionType(q);

  if(isRevealMode() && q?.media?.answerImage) return q.media.answerImage;

  if(typeKey === "media-grid"){
    return q?.media?.image || "";
  }

  return (q?.media?.image || round?.bgImage || quiz?.bgImage || "");
}

function escapeHtml(str){
  return (str ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escapeAttr(str){
  return (str ?? "").toString().replaceAll('"',"&quot;");
}

function circleImgButton({ id, imgSrc, fallbackText, size="md", title="", extraClass="" }){
  const safeImg = imgSrc || "";
  const sizeClass = size === "sm" ? "circleBtnSm" : "circleBtn";
  const className = [sizeClass, extraClass].filter(Boolean).join(" ");
  return `
    <button class="${className}" id="${id}" type="button" title="${escapeAttr(title || fallbackText)}">
      ${safeImg ? `<img src="${safeImg}" alt="${escapeAttr(fallbackText)}"
        onerror="this.style.display='none'; this.parentElement.querySelector('.fallback').style.display='block';">` : ``}
      <div class="fallback" style="${safeImg ? "display:none" : "display:block"}">${escapeHtml(fallbackText)}</div>
    </button>
  `;
}

function isPlayMode(){ return State.mode === "play"; }
function isExploreMode(){ return State.mode === "explore"; }
function isHostMode(){ return State.mode === "host"; }
function isImmediateMode(){ return isExploreMode(); }
function isPlayQuestionLocked(q){ return isPlayMode() && !!State.submitted[q?.id]; }

/* =========================================================
   EXCLUSIVE VIDEO CONTROLLER (NO CANVAS / NO WEBGL)
   - Plays exactly one media-grid video at a time
   - Uses normal <video> rendering (supports alpha WebM if you pre-render)
========================================================= */

const VIDEO = (() => {
  let currentKey = null;
  let current = null; // { play(), toggle(), stop() }

  function stop(){
    if(current){
      try { current.stop(); } catch {}
    }
    currentKey = null;
    current = null;
  }

  function toggle(nextKey, controllerFactory){
    // switching item always stops previous
    if(currentKey && currentKey !== nextKey) stop();

    // same key -> toggle pause/play via controller
    if(currentKey === nextKey && current){
      current.toggle();
      return;
    }

    stop();
    currentKey = nextKey;
    current = controllerFactory();
    current.play();
  }

  return { stop, toggle, get currentKey(){ return currentKey; } };
})();

/* ---------------- Fraction helpers ---------------- */
function gcdBig(a, b){
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while(b !== 0n){
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
function reduceFrac(f){
  if(f.d === 0n) return { n: 0n, d: 1n };
  const g = gcdBig(f.n, f.d);
  let n = f.n / g;
  let d = f.d / g;
  if(d < 0n){ n = -n; d = -d; }
  return { n, d };
}
function addFrac(a, b){
  return reduceFrac({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
}

// Map of common vulgar fraction glyphs
const VULGAR = {
  "1/2":"½",
  "1/3":"⅓",
  "2/3":"⅔",
  "1/4":"¼",
  "3/4":"¾",
  "1/5":"⅕",
  "2/5":"⅖",
  "3/5":"⅗",
  "4/5":"⅘",
  "1/6":"⅙",
  "5/6":"⅚",
  "1/8":"⅛",
  "3/8":"⅜",
  "5/8":"⅝",
  "7/8":"⅞",
};

const SUP = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","-":"⁻" };
const SUB = { "0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉","-":"₋" };

function toSuper(str){ return String(str).split("").map(ch => SUP[ch] ?? ch).join(""); }
function toSub(str){ return String(str).split("").map(ch => SUB[ch] ?? ch).join(""); }

function formatFracPretty(f){
  const r = reduceFrac(f);
  if(r.d === 1n) return String(r.n);

  const neg = r.n < 0n;
  const nAbs = neg ? -r.n : r.n;
  const d = r.d;

  const whole = nAbs / d;
  const rem = nAbs % d;

  const sign = neg ? "-" : "";

  if(rem === 0n){
    return sign + String(whole);
  }

  const key = `${rem}/${d}`;
  const glyph = VULGAR[key];

  if(whole > 0n){
    if(glyph) return `${sign}${whole}${glyph}`;
    return `${sign}${whole}${toSuper(rem)}⁄${toSub(d)}`;
  }

  if(glyph) return sign + glyph;
  return `${sign}${toSuper(rem)}⁄${toSub(d)}`;
}

/* ---------------- Global audio controller (exclusive playback) ---------------- */
const AUDIO = (() => {
  const a = new Audio();
  a.preload = "auto";

  let currentKey = null; // `${qId}::${itemId}`
  let onStop = null;     // callback to revert UI for previous item
  let onPlay = null;     // callback to update UI for current item

  function stop(){
    try { a.pause(); } catch {}
    try { a.currentTime = 0; } catch {}
    const prevStop = onStop;
    currentKey = null;
    onStop = null;
    onPlay = null;
    if(typeof prevStop === "function") prevStop();
  }

  function toggle({ key, src, onPlayCb, onStopCb }){
    if(!src){
      stop();
      return;
    }

    // switching to different item always stops previous
    if(currentKey && currentKey !== key){
      stop();
    }

    // if same item and currently playing -> pause
    if(currentKey === key && !a.paused){
      try { a.pause(); } catch {}
      if(typeof onStopCb === "function") onStopCb();
      onStop = onStopCb;
      onPlay = onPlayCb;
      return;
    }

    // set up new current item
    currentKey = key;
    onStop = onStopCb;
    onPlay = onPlayCb;

    if(a.src !== src) a.src = src;

    a.play().then(() => {
      if(typeof onPlayCb === "function") onPlayCb();
    }).catch(() => {
      if(typeof onStopCb === "function") onStopCb();
      currentKey = null;
      onStop = null;
      onPlay = null;
    });
  }

  a.addEventListener("ended", () => stop());

  return { stop, toggle, get currentKey(){ return currentKey; }, get paused(){ return a.paused; } };
})();

/* Overlay root */
function ensureOverlayRoot(){
  let root = document.getElementById("overlayRoot");
  if(!root){
    root = document.createElement("div");
    root.id = "overlayRoot";
    document.body.appendChild(root);
  }
  return root;
}

function closeOverlays(){
  State.settingsOpen = false;
  State.roundsOpen = false;
  State.confirmQuit = false;
  State.confirmSubmit = false;
  State.previewImage = null;
  renderOverlays();
}

function openImagePreview(src, alt = "") {
  if(!src) return;
  State.previewImage = { src, alt };
  renderOverlays();
}

function renderOverlays(){
  const root = ensureOverlayRoot();
  root.innerHTML = "";

  function bindShadeClose(selector, onClose){
    root.querySelectorAll(selector).forEach(shade => {
      shade.addEventListener("click", (e) => {
        if(e.target.classList.contains("overlayShade")){
          onClose();
        }
      });
    });
  }

  if(State.roundsOpen){
    const topics = getVisibleTopicRefs();
    root.innerHTML += `
      <div class="overlayShade" role="dialog" aria-modal="true">
        <div class="overlayCard">
          <div class="overlayHead">
            <div class="overlayTitle">Rounds</div>
            ${circleImgButton({ id:"closeRounds", imgSrc: APP.btnCloseImage, fallbackText:"X", size:"sm" })}
          </div>

          <div class="roundList">
            ${topics.map((r, idx) => {
              const progress = getRoundProgress(r.roundIdx);
              const done = progress.total > 0 && progress.submitted === progress.total;
              const showProgress = !isHostMode() && progress.total > 0 && !/^intro$/i.test((r.roundTitle || '').trim());
              return `
              <button class="roundJumpBtn" type="button" data-round-idx="${r.roundIdx}" data-q-idx="${r.qIdx}">
                <div class="roundJumpRow">
                  <div class="roundJumpTitle">${escapeHtml(r.roundTitle || ("Round " + (idx+1)))}</div>
                  ${showProgress ? `<div class="roundJumpMeta ${done ? 'done' : ''}">${progress.submitted}/${progress.total}</div>` : ``}
                </div>
              </button>
            `;
            }).join("") || `<div class="tiny">No rounds unlocked yet.</div>`}
          </div>
        </div>
      </div>
    `;

    $("#closeRounds")?.addEventListener("click", () => {
      State.roundsOpen = false;
      renderOverlays();
    });

    root.querySelectorAll(".roundJumpBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        const roundIdx = parseInt(btn.getAttribute("data-round-idx"), 10);
        const qIdx = parseInt(btn.getAttribute("data-q-idx"), 10) || 0;
        if(Number.isFinite(roundIdx) && canJumpToTopicPos(getQuestionRefs().findIndex(x => x.roundIdx === roundIdx && x.qIdx === qIdx))){
          State.roundIdx = roundIdx;
          State.qIdx = qIdx;
          State.lastFeedback = null;
          State.roundsOpen = false;
          renderOverlays();
          renderPlay();
        }
      });
    });

    bindShadeClose('.overlayShade', () => { State.roundsOpen = false; renderOverlays(); });
  }

  if(State.confirmQuit){
    root.innerHTML += `
      <div class="overlayShade overlayShadeConfirm" role="dialog" aria-modal="true">
        <div class="overlayCard overlayConfirmCard">
          <div class="overlayHead">
            <div class="overlayTitle">Quit quiz?</div>
            ${circleImgButton({ id:"closeQuitConfirm", imgSrc: APP.btnCloseImage, fallbackText:"X", size:"sm" })}
          </div>
          <div class="overlayBody">${State.mode === "host" ? "Exit host mode?" : "Your current progress will be lost."}</div>
          <div class="overlayActions">
            ${circleImgButton({ id:"acceptQuitConfirm", imgSrc: APP.btnQuitImage, fallbackText:"QUIT" })}
          </div>
        </div>
      </div>
    `;

    const close = () => { State.confirmQuit = false; renderOverlays(); };
    $("#closeQuitConfirm")?.addEventListener("click", close);
    $("#acceptQuitConfirm")?.addEventListener("click", () => {
      State.confirmQuit = false;
      renderOverlays();
      renderPick();
    });
    bindShadeClose('.overlayShadeConfirm', close);
  }

  if(State.confirmSubmit){
    const outstanding = countOutstandingScoredQuestions();
    const outstandingLabel = outstanding === 1 ? "1 question is still unanswered." : `${outstanding} questions are still unanswered.`;
    root.innerHTML += `
      <div class="overlayShade overlayShadeSubmit" role="dialog" aria-modal="true">
        <div class="overlayCard overlayConfirmCard">
          <div class="overlayHead">
            <div class="overlayTitle">Submit whole quiz?</div>
            ${circleImgButton({ id:"closeSubmitConfirm", imgSrc: APP.btnCloseImage, fallbackText:"X", size:"sm" })}
          </div>
          <div class="overlayBody">You can still go back and change answers before you submit.</div>
          <div class="overlayBody overlayBodyEmphasis">${escapeHtml(outstandingLabel)}</div>
          <div class="overlayActions">
            ${circleImgButton({ id:"acceptSubmitConfirm", imgSrc: APP.btnSubmitImage, fallbackText:"SUBMIT" })}
          </div>
        </div>
      </div>
    `;

    const close = () => { State.confirmSubmit = false; renderOverlays(); };
    $("#closeSubmitConfirm")?.addEventListener("click", close);
    $("#acceptSubmitConfirm")?.addEventListener("click", () => {
      State.confirmSubmit = false;
      renderOverlays();
      renderResults();
    });
    bindShadeClose('.overlayShadeSubmit', close);
  }

  if(State.previewImage?.src){
    root.innerHTML += `
      <div class="overlayShade overlayShadePreview" role="dialog" aria-modal="true">
        <div class="overlayCard overlayPreviewCard">
          <div class="overlayHead">
            ${circleImgButton({ id:"closePreview", imgSrc: APP.btnCloseImage, fallbackText:"X", size:"sm" })}
          </div>
          <div class="overlayPreviewBody">
            <img class="overlayPreviewImg" src="${escapeAttr(State.previewImage.src)}" alt="${escapeAttr(State.previewImage.alt || "")}">
          </div>
        </div>
      </div>
    `;

    const closePreview = () => {
      State.previewImage = null;
      renderOverlays();
    };

    $("#closePreview")?.addEventListener("click", closePreview);
    bindShadeClose('.overlayShadePreview', closePreview);
  }
}

/* Correct answer display */
function getCorrectAnswerText(q, typeKey){
  if(typeKey === "mcq"){
    const correctId = q.answer?.correctOptionId ?? "";
    const opt = (q.options||[]).find(o => o.id === correctId);
    return opt ? opt.text : "";
  }
  if(typeKey === "music-map"){
    const acceptedMap = q.answer?.acceptedMap || {};
    const labels = Object.keys(acceptedMap);
    if(!labels.length) return "";
    return labels.map(l => `${l}: ${(acceptedMap[l] || [])[0] || ""}`).join("\n");
  }
  if(typeKey === "multi-text"){
    const mode = (q.answer?.mode || "").toLowerCase();
    if(mode === "pool"){
      const pool = Array.isArray(q.answer?.acceptedPool) ? q.answer.acceptedPool : [];
      const required = Number.isFinite(q.answer?.requiredCorrect) ? q.answer.requiredCorrect : (Array.isArray(q.parts) ? q.parts.length : 0);
      if(!pool.length) return "";
      const head = `Any ${required} of:`;
      const body = pool.join(" · ");
      return head + "\n" + body;
    }
    const parts = q.answer?.acceptedParts || [];
    return parts.map(a => (a && a[0]) ? a[0] : "").filter(Boolean).join(" · ");
  }
  if(typeKey === "media-grid"){
    const items = q.media?.items || [];
    const acc = q.answer?.accepted || {};
    const lines = [];
    for(const it of items){
      const fieldObj = acc[it.id] || {};
      const fields = Array.isArray(it.fields) && it.fields.length ? it.fields : ["Answer"];
      const shown = fields.map(f => (fieldObj[f] && fieldObj[f][0]) ? fieldObj[f][0] : "").filter(Boolean);
      if(shown.length){
        lines.push(`${it.id}: ${shown.join(" / ")}`);
      }
      if(lines.length >= 12) break;
    }
    return lines.join("\n");
  }
  if(typeKey === "video"){
    const fields =
      (Array.isArray(q.fields) && q.fields.length) ? q.fields
      : (Array.isArray(q.media?.fields) && q.media.fields.length) ? q.media.fields
      : ["Answer"];
    const acc = q.answer?.accepted || {};
    const bits = fields.map(f => {
      const first = (acc[f] && acc[f][0]) ? acc[f][0] : "";
      return first ? `${f}: ${first}` : "";
    }).filter(Boolean);
    return bits.join("\n");
  }
  return (q.answer?.accepted || [])[0] || "";
}

function setSubmitButtonToNextIcon(){
  const btn = $("#submitBtn");
  if(!btn) return;
  const img = btn.querySelector("img");
  if(img) img.src = APP.btnNextImage;
  const fb = btn.querySelector(".fallback");
  if(fb) fb.textContent = "NEXT";
}
function setSubmitButtonToSubmitIcon(){
  const btn = $("#submitBtn");
  if(!btn) return;
  const img = btn.querySelector("img");
  if(img) img.src = APP.btnSubmitImage;
  const fb = btn.querySelector(".fallback");
  if(fb) fb.textContent = "SUBMIT";
}
function setSubmitDisabled(disabled){
  const btn = $("#submitBtn");
  if(!btn) return;
  btn.disabled = !!disabled;
  btn.classList.toggle("btnDisabled", !!disabled);
}

function lockInputs(){
  elMain.querySelectorAll("input, textarea, select, button").forEach(el => {
    if(el.id === "quitBtn" || el.id === "submitBtn") return;
    if(el.id === "roundsBtn" || el.id === "showAnsBtn" || el.id === "backBtn" || el.id === "nextBtn") return;
    el.disabled = true;
    el.setAttribute("aria-disabled","true");
    el.classList.add("locked");
  });
  elMain.querySelectorAll(".mcqOpt").forEach(opt => opt.classList.add("locked"));
}

/* =========================================================
   QUESTION TYPES
========================================================= */
const QUESTION_TYPES = {
  "text": {
    render(q){
      const reveal = shouldRevealQuestion(q);
      const hostReveal = isHostMode() && State.revealAnswers;
      const locked = reveal || hostReveal || isPlayQuestionLocked(q) || isHostMode();
      const val = reveal ? (getRevealAnswerValue(q, "text") || "") : (State.answers[q.id] ?? "");
      if(isHostMode()) return hostReveal ? `<div class="hostRevealBlock gridRevealAnswer">${escapeHtml(getRevealAnswerValue(q, "text") || "")}</div>` : "";
      return `<textarea id="ansText" class="answerField" rows="1" placeholder="Type your answer…" ${locked ? "readonly" : ""}>${escapeHtml(val)}</textarea>`;
    },
    read(){ return ($("#ansText")?.value ?? "").trim(); },
    hasAnyAnswer(){ return !!(( $("#ansText")?.value ?? "").trim()); },
    grade(q, value){
      const ok = match(value, q.answer?.accepted || []);
      const correct = (q.answer?.accepted || [])[0] || "";
      return { ok, message: ok ? "✅ Correct!" : ("❌ " + correct) };
    }
  },

  "multi-text": {
    render(q){
      const reveal = shouldRevealQuestion(q);
      const revealSaved = getRevealAnswerValue(q, "multi-text");
      const saved = reveal ? (Array.isArray(revealSaved) ? revealSaved : []) : (Array.isArray(State.answers[q.id]) ? State.answers[q.id] : []);
      const parts = Array.isArray(q.parts) ? q.parts : [{label:"1"},{label:"2"},{label:"3"}];
      const locked = reveal || isPlayQuestionLocked(q) || isHostMode();
      if(isHostMode()) return "";
      return `
        <div class="multiWrap multiUnified">
          ${parts.map((p, i) => `
            <textarea class="multiIn answerField" data-i="${i}" rows="1" placeholder="Answer ${escapeHtml(p.label ?? (i+1))}…" ${locked ? "readonly" : ""}>${escapeHtml(saved[i] || "")}</textarea>
          `).join("")}
        </div>
      `;
    },
    read(){ const out=[]; document.querySelectorAll('.multiIn').forEach(inp => { const i=parseInt(inp.getAttribute('data-i'),10); out[i]=(inp.value||'').trim();}); return out; },
    hasAnyAnswer(){ let any=false; document.querySelectorAll('.multiIn').forEach(inp => { if((inp.value||'').trim()) any=true;}); return any; },
    grade(q, value){
      const user = Array.isArray(value) ? value : [];
      const ans = q.answer || {};
      if((ans.mode || '').toLowerCase() === 'pool'){
        const pool = Array.isArray(ans.acceptedPool) ? ans.acceptedPool : [];
        const required = Number.isFinite(ans.requiredCorrect) ? ans.requiredCorrect : user.length;
        const requireUnique = (ans.unique !== false);
        const poolSet = new Set(pool.map(normalize).filter(Boolean));
        let correct = 0;
        if(requireUnique){ const seen = new Set(); for(const u of user){ const nu=normalize(u); if(!nu) continue; if(poolSet.has(nu) && !seen.has(nu)) seen.add(nu);} correct = seen.size; }
        else { for(const u of user){ const nu=normalize(u); if(!nu) continue; if(poolSet.has(nu)) correct++; } }
        const totalCount = required; const okAll = (totalCount > 0 && correct >= totalCount);
        return { ok: okAll, message: okAll ? `✅ ${Math.min(correct,totalCount)}/${totalCount}` : `❌ ${Math.min(correct,totalCount)}/${totalCount}`, correctCount: Math.min(correct,totalCount), totalCount };
      }
      const parts = ans.acceptedParts || []; const orderInsensitive = !!ans.orderInsensitive; const norm=(s)=>normalize(s); const slotOk=(u,acceptedList)=>(acceptedList||[]).some(a => norm(u)===norm(a));
      if(!orderInsensitive){ let correct=0; for(let i=0;i<parts.length;i++){ if(slotOk(user[i]||'', parts[i]||[])) correct++; } const okAll = parts.length>0 && correct===parts.length; return { ok: okAll, message: okAll ? `✅ ${correct}/${parts.length}` : `❌ ${correct}/${parts.length}`, correctCount: correct, totalCount: parts.length }; }
      const usedSlot = new Array(parts.length).fill(false); let correct=0; for(const u of user){ const nu=norm(u); if(!nu) continue; for(let i=0;i<parts.length;i++){ if(usedSlot[i]) continue; if((parts[i]||[]).some(a => norm(a)===nu)){ usedSlot[i]=true; correct++; break; } } }
      const okAll = parts.length>0 && correct===parts.length; return { ok: okAll, message: okAll ? `✅ ${correct}/${parts.length}` : `❌ ${correct}/${parts.length}`, correctCount: correct, totalCount: parts.length };
    }
  },

  "mcq": {
    render(q){
      const reveal = shouldRevealQuestion(q);
      const saved = reveal ? getRevealAnswerValue(q, "mcq") : (State.answers[q.id] || '');
      const opts = (q.options || []).map(opt => `
        <button class="mcqOpt ${saved === opt.id ? 'selected' : ''} ${(reveal && saved === opt.id) ? 'mcqCorrect' : ''}" type="button" data-optid="${escapeAttr(opt.id)}" ${reveal || (State.mode==='host') || isQuestionSubmitted(q) ? 'disabled' : ''}>
          <span class="mcqText">${escapeHtml(opt.text)}</span>
        </button>
      `).join('');
      return `<div class="mcqWrap" data-mcq-qid="${escapeAttr(q.id)}">${opts}</div>`;
    },
    afterRender(q){
      if(isRevealMode() || State.mode==='host' || isQuestionSubmitted(q)) return;
      elMain.querySelectorAll('.mcqOpt[data-optid]').forEach(btn => {
        btn.addEventListener('click', () => {
          const optId = btn.getAttribute('data-optid') || '';
          State.answers[q.id] = optId;
          elMain.querySelectorAll('.mcqOpt[data-optid]').forEach(x => x.classList.toggle('selected', x === btn));
          setSubmitDisabled(false);
        });
      });
    },
    read(q){ return State.answers[q.id] || elMain.querySelector('.mcqOpt.selected')?.getAttribute('data-optid') || ''; },
    hasAnyAnswer(q){ return !!(State.answers[q.id] || elMain.querySelector('.mcqOpt.selected')); },
    grade(q, value){ const correctId = q.answer?.correctOptionId ?? ''; const ok = value && value === correctId; const correctOpt = (q.options || []).find(o => o.id===correctId); const correctText = correctOpt ? correctOpt.text : ''; return { ok, message: ok ? '✅ Correct!' : ('❌ ' + correctText) }; }
  },

  "music-map": {
    render(q){
      const reveal = shouldRevealQuestion(q);
      const locked = reveal || isPlayQuestionLocked(q) || isHostMode();
      const revealSaved = getRevealAnswerValue(q, 'music-map');
      const clips = q.media?.audioClips || [];
      const saved = reveal ? ((revealSaved && typeof revealSaved==='object') ? revealSaved : {}) : ((State.answers[q.id] && typeof State.answers[q.id]==='object') ? State.answers[q.id] : {});
      const rows = clips.map(c => `
        <div class="musicRow">
          <div class="musicLabel">${escapeHtml(c.label)}</div>
          <button class="musicPlay" type="button" data-src="${escapeAttr(c.src)}" >►</button>
          <input class="musicIn" data-label="${escapeAttr(c.label)}" type="text"
                 placeholder="Answer ${escapeHtml(c.label)}…"
                 value="${escapeAttr(saved[c.label] || '')}" ${locked ? 'readonly' : ''}>
        </div>`).join('');
      if(isHostMode()) return `<div class="musicWrap">${rows.replace(/<input[^>]*>/g,"")}</div>`; return `<div class="musicWrap">${rows}</div>`;
    },
    afterRender(){ if(isRevealMode()) return; document.querySelectorAll('.musicPlay').forEach(btn => { btn.addEventListener('click', ()=>{ const src=btn.getAttribute('data-src'); if(!src) return; const a=new Audio(src); a.play().catch(()=>{}); }); }); },
    read(){ const out={}; document.querySelectorAll('.musicIn').forEach(inp => { const label = inp.getAttribute('data-label'); out[label]=(inp.value||'').trim(); }); return out; },
    hasAnyAnswer(){ let any=false; document.querySelectorAll('.musicIn').forEach(inp => { if((inp.value||'').trim()) any=true; }); return any; },
    grade(q, value){ const acceptedMap=q.answer?.acceptedMap||{}; const labels=Object.keys(acceptedMap); let correct=0; for(const l of labels){ if(match(value?.[l]||'', acceptedMap[l]||[])) correct++; } const okAll = labels.length>0 && correct===labels.length; return { ok: okAll, message: okAll ? `✅ ${correct}/${labels.length}` : `❌ ${correct}/${labels.length}`, correctCount: correct, totalCount: labels.length }; }
  },

  // Backwards-compat (video + single text input inside content area)
  "video-text": {
    render(q){
      const reveal = shouldRevealQuestion(q);
      const locked = reveal || isPlayQuestionLocked(q) || isHostMode();
      const val = reveal ? (getRevealAnswerValue(q, 'video-text') || '') : (State.answers[q.id] ?? '');
      const v = q.media?.video || '';
      const overlay = reveal ? (q.media?.answerOverlayImage || q.media?.overlayImage || '') : (q.media?.overlayImage || '');
      return `
        ${v ? `
          <div class="videoWrap">
            <video class="qVideo" src="${escapeAttr(v)}" controls playsinline></video>
            ${overlay ? `<img class="videoOverlay" src="${escapeAttr(overlay)}" alt="">` : ``}
          </div>` : ''}
        ${isHostMode() ? '' : `<textarea id="ansText" class="answerField" rows="1" placeholder="Type your answer…" ${locked ? 'readonly' : ''}>${escapeHtml(val)}</textarea>`}`;
    },
    read(){ return ($('#ansText')?.value ?? '').trim(); }, hasAnyAnswer(){ return !!((($('#ansText')?.value ?? '').trim())); },
    grade(q, value){ const ok = match(value, q.answer?.accepted || []); const correct=(q.answer?.accepted||[])[0]||''; return { ok, message: ok ? '✅ Correct!' : ('❌ ' + correct) }; }
  },

  // "video" — big slide video + overlay badge + multi-field answers
  "video": {
    render(q){
      const reveal = shouldRevealQuestion(q);
      const hostReveal = isHostMode() && State.revealAnswers;
      const locked = reveal || hostReveal || isPlayQuestionLocked(q) || isHostMode();
      const revealSaved = getRevealAnswerValue(q, 'video');
      const saved = reveal ? ((revealSaved && typeof revealSaved==='object') ? revealSaved : {}) : ((State.answers[q.id] && typeof State.answers[q.id]==='object') ? State.answers[q.id] : {});
      const fields = (Array.isArray(q.fields) && q.fields.length) ? q.fields : ((Array.isArray(q.media?.fields) && q.media.fields.length) ? q.media.fields : ['Answer']);
      if(isHostMode()){
        return hostReveal
          ? `<div class="videoRevealWrap">${fields.map(f => `<div class="gridRevealAnswer hostRevealBlock">${escapeHtml((revealSaved && revealSaved[f]) || '')}</div>`).join('')}</div>`
          : '';
      }
      return `<div class="videoFields">${fields.map(f => `<textarea class="videoIn answerField" rows="1" data-field="${escapeAttr(f)}" placeholder="${escapeAttr(f)}…" ${locked ? 'readonly' : ''}>${escapeHtml(saved[f] || '')}</textarea>`).join('')}</div>`;
    },
    read(){ const out={}; elMain.querySelectorAll('.videoIn').forEach(inp => { const field = inp.getAttribute('data-field'); if(!field) return; out[field]=(inp.value||'').trim(); }); return out; },
    hasAnyAnswer(){ let any=false; elMain.querySelectorAll('.videoIn').forEach(inp => { if((inp.value||'').trim()) any=true; }); return any; },
    grade(q, value){ const fields=(Array.isArray(q.fields)&&q.fields.length)?q.fields:((Array.isArray(q.media?.fields)&&q.media.fields.length)?q.media.fields:['Answer']); const accepted=q.answer?.accepted||{}; const v=(value&&typeof value==='object')?value:{}; let correct=0,total=0; for(const f of fields){ total++; if(match(v[f]||'', accepted[f]||[])) correct++; } const okAll=(total>0 && correct===total); return { ok: okAll, message: okAll ? `✅ ${correct}/${total}` : `❌ ${correct}/${total}`, correctCount: correct, totalCount: total }; }
  },

  "title": {
    render(q){
      const subtitle = q.subtitle || "";
      const note = q.note || "";
      const v = q.media?.video || "";
      return `
        ${v ? `<video class="qVideo" src="${escapeAttr(v)}" autoplay muted loop playsinline></video>` : ""}
        <div style="display:grid; gap:10px; justify-items:center; width:100%;">
          ${subtitle ? `<div class="tiny" style="font-size:20px; font-weight:1100;">${escapeHtml(subtitle)}</div>` : ``}
          ${note ? `<div class="tiny" style="font-size:18px; font-weight:900;">${escapeHtml(note)}</div>` : ``}
        </div>
      `;
    },
    read(){ return "__title__"; },
    hasAnyAnswer(){ return true; },
    grade(){ return { ok:true, message:"" }; },
    isScored: false
  },

  "round": {
    render(q){
      const subtitle = q.subtitle || "";
      const note = q.note || "";
      return `
        <div style="display:grid; gap:10px; justify-items:center; width:100%;">
          ${subtitle ? `<div class="qPrompt" style="font-size:40px;">${escapeHtml(subtitle)}</div>` : ``}
          ${note ? `<div class="tiny" style="font-size:18px; font-weight:900;">${escapeHtml(note)}</div>` : ``}
        </div>
      `;
    },
    read(){ return "__round__"; },
    hasAnyAnswer(){ return true; },
    grade(){ return { ok:true, message:"" }; },
    isScored: false
  },

  "media-grid": {
    render(q){
      const reveal = shouldRevealQuestion(q) || (isHostMode() && State.revealAnswers);
      const locked = reveal || isPlayQuestionLocked(q);
      const host = isHostMode();
      const cols = q.columns || q.media?.columns || q.media?.cols || 5;
      const items = Array.isArray(q.media?.items) ? q.media.items : [];
      const revealSaved = getRevealAnswerValue(q, 'media-grid');
      const saved = reveal ? ((revealSaved && typeof revealSaved==='object') ? revealSaved : {}) : ((State.answers[q.id] && typeof State.answers[q.id]==='object') ? State.answers[q.id] : {});
      const grid = items.map((it, idx) => {
        const itemId = String(it.id ?? String(idx+1));
        const imgPlay = reveal ? (it.answerImage || it.image || '') : (it.image || '');
        const imgPause = reveal ? (it.answerImagePause || it.answerImage || it.imagePause || '') : (it.imagePause || '');
        const refImg = it.refImage || '';
        const clickImage = it.clickImage || '';
                const fields = Array.isArray(it.fields) && it.fields.length ? it.fields : ['Answer'];
        const savedItem = (saved[itemId] && typeof saved[itemId]==='object') ? saved[itemId] : {};
        const revealLines = host && State.revealAnswers
          ? fields.map(f => (savedItem[f] || '')).filter(Boolean).map(v => `<div class="gridRevealAnswer">${escapeHtml(v)}</div>`).join('')
          : '';
        const inputs = host ? '' : fields.map(f => `<textarea class="gridIn answerField" rows="1" data-item="${escapeAttr(itemId)}" data-field="${escapeAttr(f)}" placeholder="${escapeAttr(f)}…" ${locked ? 'readonly' : ''}>${escapeHtml(savedItem[f] || '')}</textarea>`).join('');
        const hasVideo = !!it.video;
        const ar = (it.aspectRatio || it.ar || '16/9').toString().replace(':','/');
        return `<div class="gridTile">
          <div class="gridMediaWrap">
            <button class="gridMediaBtn ${clickImage ? 'hasPreview' : ''}" type="button" data-qid="${escapeAttr(q.id)}" data-item="${escapeAttr(itemId)}" data-audio="${escapeAttr(it.audio || '')}" data-video="${escapeAttr(it.video || '')}" data-imgplay="${escapeAttr(imgPlay)}" data-imgpause="${escapeAttr(imgPause)}" data-clickimage="${escapeAttr(clickImage)}">
              ${hasVideo ? `<div class="gridVidWrap" style="--ar:${escapeAttr(ar)}"><video class="gridVidEl" preload="metadata" playsinline muted loop></video>${imgPlay ? `<img class="gridPoster" src="${escapeAttr(imgPlay)}" alt="">` : ``}</div>` : (imgPlay ? `<img class="gridImg" data-img-for="${escapeAttr(q.id)}::${escapeAttr(itemId)}" src="${escapeAttr(imgPlay)}" alt="">` : ``)}
            </button>
            </div>
          ${refImg ? `<img class="gridRefImg" src="${escapeAttr(refImg)}" alt="">` : ``}
          <div class="gridInputs">${inputs}${revealLines}</div>
        </div>`;
      }).join('');
      return `<div class="mediaGrid" style="--cols:${cols}">${grid}</div>`;
    },
    afterRender(q){
      if(isPlayQuestionLocked(q)) return;

      elMain.querySelectorAll('.gridPreviewBtn[data-preview-src]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const src = btn.getAttribute('data-preview-src') || '';
          const alt = btn.getAttribute('data-preview-alt') || '';
          openImagePreview(src, alt);
        });
      });

      elMain.querySelectorAll('.gridMediaBtn').forEach(btn => {
        btn.addEventListener('click', ()=>{
          const qid=btn.getAttribute('data-qid');
          const itemId=btn.getAttribute('data-item');
          const audio=btn.getAttribute('data-audio')||'';
          const videoSrc=btn.getAttribute('data-video')||'';
          const clickImage=btn.getAttribute('data-clickimage')||'';
          const key=`${qid}::${itemId}`;

          if(clickImage && !audio && !videoSrc){
            openImagePreview(clickImage, q.prompt || `Item ${itemId}`);
            return;
          }

          if(videoSrc){
            const wrap=btn.querySelector('.gridVidWrap');
            const videoEl=btn.querySelector('.gridVidEl');
            const poster=btn.querySelector('.gridPoster');
            if(!wrap || !videoEl) return;
            if(!wrap._vidInit){
              wrap._vidInit=true; videoEl.src=videoSrc; videoEl.loop=true; videoEl.muted=true; videoEl.playsInline=true;
              if(poster) poster.style.opacity='1';
              videoEl.addEventListener('pause', ()=>{ if(poster) poster.style.opacity='1'; btn.classList.remove('isPlaying'); });
              videoEl.addEventListener('play', ()=>{ if(poster) poster.style.opacity='0'; btn.classList.add('isPlaying'); });
            }
            const showPoster=()=>{ if(poster) poster.style.opacity='1'; btn.classList.remove('isPlaying'); };
            const hidePoster=()=>{ if(poster) poster.style.opacity='0'; btn.classList.add('isPlaying'); };
            VIDEO.toggle(key, ()=>({ play(){ hidePoster(); videoEl.play().catch(()=>showPoster()); }, toggle(){ if(videoEl.paused){ hidePoster(); videoEl.play().catch(()=>showPoster()); } else { videoEl.pause(); showPoster(); } }, stop(){ try{videoEl.pause();}catch{} try{videoEl.currentTime=0;}catch{} showPoster(); } }));
            return;
          }

          const imgPlay=btn.getAttribute('data-imgplay')||'';
          const imgPause=btn.getAttribute('data-imgpause')||'';
          if(!audio) return;
          const imgEl = elMain.querySelector(`img[data-img-for="${CSS.escape(key)}"]`);
          const toPause=()=>{ btn.classList.add('isPlaying'); if(imgEl && imgPause) imgEl.src=imgPause;};
          const toPlay=()=>{ btn.classList.remove('isPlaying'); if(imgEl && imgPlay) imgEl.src=imgPlay;};
          AUDIO.toggle({ key, src: audio, onPlayCb: toPause, onStopCb: toPlay });
        });
      });
    },
    read(){ const out={}; elMain.querySelectorAll('.gridIn').forEach(inp => { const itemId=inp.getAttribute('data-item'); const field=inp.getAttribute('data-field'); if(!itemId || !field) return; out[itemId]=out[itemId]||{}; out[itemId][field]=(inp.value||'').trim(); }); return out; },
    hasAnyAnswer(){ let any=false; elMain.querySelectorAll('.gridIn').forEach(inp => { if((inp.value||'').trim()) any=true; }); return any; },
    grade(q, value){ const items=Array.isArray(q.media?.items)?q.media.items:[]; const accepted=q.answer?.accepted||{}; let correct=0,total=0; const v=(value && typeof value==='object')?value:{}; for(const it of items){ const itemId=String(it.id ?? ''); if(!itemId) continue; const fields=Array.isArray(it.fields)&&it.fields.length?it.fields:['Answer']; const accItem=accepted[itemId]||{}; const userItem=(v[itemId]&&typeof v[itemId]==='object')?v[itemId]:{}; for(const f of fields){ total++; if(match(userItem[f]||'', accItem[f]||[])) correct++; } } const okAll=(total>0 && correct===total); return { ok: okAll, message: okAll ? `✅ ${correct}/${total}` : `❌ ${correct}/${total}`, correctCount: correct, totalCount: total }; }
  },

  "audio-text": {
    render(q){
      const reveal = isRevealMode();
      const locked = reveal || isPlayQuestionLocked(q) || isHostMode();
      const val = reveal ? (getRevealAnswerValue(q, 'audio-text') || '') : (State.answers[q.id] ?? '');
      const playImg = reveal ? (q.media?.answerImage || q.media?.imagePlay || '') : (q.media?.imagePlay || '');
      const pauseImg = reveal ? (q.media?.answerImagePause || q.media?.answerImage || q.media?.imagePause || '') : (q.media?.imagePause || '');
      const audioSrc = q.media?.audio || '';
      return `<div class="audioLeftWrap"><button class="audioLeftBtn" type="button" data-key="${escapeAttr(q.id)}" data-src="${escapeAttr(audioSrc)}" data-imgplay="${escapeAttr(playImg)}" data-imgpause="${escapeAttr(pauseImg)}" aria-label="Play/Pause audio">${playImg ? `<img class="audioLeftImg" src="${escapeAttr(playImg)}" alt="">` : `►`}</button><div class="audioLeftAnswer"><textarea id="ansAudioText" class="answerField" rows="1" placeholder="Type your answer…" ${locked ? "readonly" : ""}>${escapeHtml(val)}</textarea></div></div>`;
    },
    afterRender(q){ const btn=elMain.querySelector('.audioLeftBtn'); if(!btn) return; btn.addEventListener('click', ()=>{ const key=btn.getAttribute('data-key')||q.id; const src=btn.getAttribute('data-src')||''; if(!src) return; const img=btn.querySelector('.audioLeftImg'); const imgPlay=btn.getAttribute('data-imgplay')||''; const imgPause=btn.getAttribute('data-imgpause')||''; const toPause=()=>{ if(img && imgPause) img.src=imgPause;}; const toPlay=()=>{ if(img && imgPlay) img.src=imgPlay;}; AUDIO.toggle({ key, src, onPlayCb: () => { btn.classList.add('isPlaying'); toPause(); }, onStopCb: () => { btn.classList.remove('isPlaying'); toPlay(); } }); }); },
    read(){ return ($('#ansAudioText')?.value ?? '').trim(); }, hasAnyAnswer(){ return !!((($('#ansAudioText')?.value ?? '').trim())); }, grade(q, value){ const ok=match(value, q.answer?.accepted||[]); const correct=(q.answer?.accepted||[])[0]||''; return { ok, message: ok ? '✅ Correct!' : ('❌ ' + correct) }; }
  },
  "audio-mcq": {
    render(q){
      const reveal = shouldRevealQuestion(q) || (isHostMode() && State.revealAnswers);
      const locked = reveal || isPlayQuestionLocked(q) || isHostMode();
      const saved = reveal ? getRevealAnswerValue(q, "audio-mcq") : (State.answers[q.id] || '');
      const playImg  = q.media?.imagePlay  || "";
      const pauseImg = q.media?.imagePause || "";
      const audioSrc = q.media?.audio || "";

      const opts = (q.options || []).map(opt => `
        <button class="mcqOpt ${saved === opt.id ? 'selected' : ''} ${(reveal && saved === opt.id) ? 'mcqCorrect' : ''}" type="button" data-optid="${escapeAttr(opt.id)}" ${locked ? 'disabled' : ''}>
          <span class="mcqText">${escapeHtml(opt.text)}</span>
        </button>
      `).join("");

      return `
        <div class="audioLeftWrap">
          <button class="audioLeftBtn" type="button"
                  data-key="${escapeAttr(q.id)}"
                  data-src="${escapeAttr(audioSrc)}"
                  data-imgplay="${escapeAttr(playImg)}"
                  data-imgpause="${escapeAttr(pauseImg)}"
                  aria-label="Play/Pause audio">
            ${playImg ? `<img class="audioLeftImg" src="${escapeAttr(playImg)}" alt="">` : `►`}
          </button>

          <div class="audioLeftAnswer">
            <div class="mcqWrap" data-mcq-qid="${escapeAttr(q.id)}">${opts}</div>
          </div>
        </div>
      `;
    },

    afterRender(q){
      const btn = elMain.querySelector(".audioLeftBtn");
      if(btn){
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-key") || q.id;
          const src = btn.getAttribute("data-src") || "";
          if(!src) return;

          const img = btn.querySelector(".audioLeftImg");
          const imgPlay  = btn.getAttribute("data-imgplay") || "";
          const imgPause = btn.getAttribute("data-imgpause") || "";

          const toPause = () => { if(img && imgPause) img.src = imgPause; };
          const toPlay  = () => { if(img && imgPlay)  img.src = imgPlay;  };

          AUDIO.toggle({ key, src, onPlayCb: () => { btn.classList.add('isPlaying'); toPause(); }, onStopCb: () => { btn.classList.remove('isPlaying'); toPlay(); } });
        });
      }

      if(isRevealMode() || (isHostMode() && State.revealAnswers) || isPlayQuestionLocked(q) || isHostMode()) return;
      elMain.querySelectorAll('.mcqOpt[data-optid]').forEach(opt => {
        opt.addEventListener('click', () => {
          const optId = opt.getAttribute('data-optid') || '';
          State.answers[q.id] = optId;
          elMain.querySelectorAll('.mcqOpt[data-optid]').forEach(x => x.classList.toggle('selected', x === opt));
          setSubmitDisabled(false);
        });
      });
    },
    read(q){ return State.answers[q.id] || elMain.querySelector('.mcqOpt.selected')?.getAttribute('data-optid') || ''; },
    hasAnyAnswer(q){ return !!(State.answers[q.id] || elMain.querySelector('.mcqOpt.selected')); },
    grade(q, value){
      const correctId = q.answer?.correctOptionId ?? "";
      const ok = value && value === correctId;
      const correctOpt = (q.options || []).find(o => o.id === correctId);
      const correctText = correctOpt ? correctOpt.text : "";
      return { ok, message: ok ? "✅ Correct!" : ("❌ " + correctText) };
    }
  }
};

function getQuestionType(q){
  const t = q?.type || "text";
  if(t === "video-text") return "video";
  return QUESTION_TYPES[t] ? t : "text";
}

function isScoredQuestionForProgress(q){
  const type = QUESTION_TYPES[getQuestionType(q)];
  return !!type && type.isScored !== false;
}

function countMediaGridAnsweredParts(q){
  const items = Array.isArray(q?.media?.items) ? q.media.items : [];
  const saved = (State.answers[q?.id] && typeof State.answers[q.id] === 'object') ? State.answers[q.id] : {};
  let answered = 0;
  items.forEach((it, idx) => {
    const itemId = String(it?.id ?? String(idx + 1));
    const itemAns = (saved[itemId] && typeof saved[itemId] === 'object') ? saved[itemId] : {};
    const hasAny = Object.values(itemAns).some(v => String(v || '').trim());
    if(hasAny) answered++;
  });
  return answered;
}

function getRoundProgress(roundIdx){
  const quiz = getQuiz();
  const round = quiz?.rounds?.[roundIdx];
  const questions = round?.questions || [];
  let total = 0;
  let submitted = 0;
  questions.forEach(q => {
    if(!isScoredQuestionForProgress(q)) return;
    const typeKey = getQuestionType(q);
    if(typeKey === 'media-grid'){
      const items = Array.isArray(q?.media?.items) ? q.media.items : [];
      total += items.length;
      submitted += countMediaGridAnsweredParts(q);
      return;
    }
    total++;
    if(State.submitted[q.id]) submitted++;
  });
  return { submitted, total };
}

function countOutstandingScoredQuestions(){
  const quiz = getQuiz();
  if(!quiz) return 0;
  let outstanding = 0;
  (quiz.rounds || []).forEach(round => {
    (round.questions || []).forEach(q => {
      if(!isScoredQuestionForProgress(q)) return;
      const typeKey = getQuestionType(q);
      if(typeKey === 'media-grid'){
        const items = Array.isArray(q?.media?.items) ? q.media.items : [];
        const saved = (State.answers[q.id] && typeof State.answers[q.id] === 'object') ? State.answers[q.id] : {};
        items.forEach((it, idx) => {
          const itemId = String(it?.id ?? String(idx + 1));
          const itemAns = (saved[itemId] && typeof saved[itemId] === 'object') ? saved[itemId] : {};
          const hasAny = Object.values(itemAns).some(v => String(v || '').trim());
          if(!hasAny) outstanding++;
        });
        return;
      }
      if(!State.submitted[q.id]) outstanding++;
    });
  });
  return outstanding;
}

/* ---------- Views ---------- */

function renderHome(){
  AUDIO.stop();
  VIDEO.stop();
  closeOverlays();
  State.view = "home";
  State.quizId = null;
  State.lastFeedback = null;
  applyBackground();

  elMain.innerHTML = `
    <div class="panel col homePanel">
      <img class="homeLogo" src="${APP.homeLogo}" alt="ChrisBe’s Quiz Night" onerror="this.style.display='none'">
      <div class="row homeBtns">
        ${circleImgButton({ id:"playBtn", imgSrc:APP.btnHomePlayImage, fallbackText:"PLAY", title:"Play" })}
        ${circleImgButton({ id:"searchBtn", imgSrc:APP.btnHomeSearchImage, fallbackText:"SEARCH", title:"Search" })}
        ${circleImgButton({ id:"randomBtn", imgSrc:APP.btnHomeRandomImage, fallbackText:"RANDOM", title:"Random quiz" })}
      </div>
    </div>
  `;

  $("#playBtn").addEventListener("click", renderPick);
  $("#searchBtn").addEventListener("click", renderSearch);
  $("#randomBtn").addEventListener("click", async () => {
    const idx = window.QUIZ_INDEX || [];
    if(!idx.length) return;
    const pick = idx[Math.floor(Math.random() * idx.length)];
    await startQuiz(pick.id, "play");
  });
}

function getSortDateValue(meta){
  const q = (window.QUIZ_STORE || {})[meta.id];
  const dateStr = (q?.date || meta.date || "").trim();
  if(!dateStr) return null;
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]) - 1;
  const yyyy = Number(m[3]);
  const d = new Date(yyyy, mm, dd);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function getPickerState(){
  if(!State.picker){
    State.picker = {
      search: "",
      sortBy: "date",
      sortDir: "desc"
    };
  }
  return State.picker;
}

function sortQuizMeta(list){
  const picker = getPickerState();
  const dir = picker.sortDir === "asc" ? 1 : -1;
  const by = picker.sortBy;

  return [...list].sort((a, b) => {
    if(by === "name"){
      const an = (a.title || a.id || "").toLowerCase();
      const bn = (b.title || b.id || "").toLowerCase();
      return an < bn ? -dir : an > bn ? dir : 0;
    }

    const ad = getSortDateValue(a);
    const bd = getSortDateValue(b);

    if(ad == null && bd == null){
      const an = (a.title || a.id || "").toLowerCase();
      const bn = (b.title || b.id || "").toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    }
    if(ad == null) return 1;
    if(bd == null) return -1;
    if(ad < bd) return -dir;
    if(ad > bd) return dir;

    const an = (a.title || a.id || "").toLowerCase();
    const bn = (b.title || b.id || "").toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

async function renderPick(){
  AUDIO.stop();
  VIDEO.stop();
  closeOverlays();
  State.view = "pick";
  State.lastFeedback = null;
  applyBackground();

  const picker = getPickerState();
  const idx = window.QUIZ_INDEX || [];

  const term = normalize(picker.search || "");
  let rows = idx.filter(meta => {
    if(!term) return true;
    return normalize(`${meta.id} ${meta.title || ""}`).includes(term);
  });

  rows = sortQuizMeta(rows);

  elMain.innerHTML = `
    <div class="panel col pickPanel">
      <div class="pickerToolbar">
        <div class="pickerSearchWrap">
          <img class="pickerSearchIcon" src="${APP.btnHomeSearchImage}" alt="" onerror="this.style.display='none'">
          <input class="pickerSearch" id="pickerSearch" type="search" placeholder="Search quizzes…" value="${escapeAttr(picker.search || "")}">
        </div>

        <div class="pickerSortIcons">
          ${circleImgButton({ id:"sortNameBtn", imgSrc:"assets/sort_name.png", fallbackText:"ABC", title:"Sort by name", size:"sm", extraClass:`sortIconBtn ${picker.sortBy === 'name' ? 'isActive' : ''}` })}
          ${circleImgButton({ id:"sortDateBtn", imgSrc:"assets/sort_date.png", fallbackText:"DATE", title:"Sort by date", size:"sm", extraClass:`sortIconBtn ${picker.sortBy === 'date' ? 'isActive' : ''}` })}
          ${circleImgButton({ id:"sortDirBtn", imgSrc:"assets/sort_dir.png", fallbackText:picker.sortDir === 'asc' ? "ASC" : "DESC", title:"Toggle sort direction", size:"sm", extraClass:`sortIconBtn sortDirIcon ${picker.sortDir}` })}
        </div>
      </div>

      <div class="scroll col quizPickerList" style="gap:16px; width:100%;">
        ${rows.map(meta => `
          <div class="card quizPickRow" data-id="${escapeAttr(meta.id)}">
            <img class="quizLogoLarge" src="${meta.logo || 'assets/logo.png'}" alt="" onerror="this.style.visibility='hidden'">
            <div class="quizMeta">
              <div class="cardTitle">${escapeHtml(meta.title || meta.id)}</div>
              <div class="cardSub">${escapeHtml(meta.date || "")}</div>
            </div>
            <div class="quizActions modeActions">
              <button class="modeBtn" type="button" data-mode="play" data-id="${escapeAttr(meta.id)}" title="Play">
                <img src="${APP.btnPlayModeImage}" alt="Play" onerror="this.style.display='none'; this.parentElement.querySelector('span').style.display='block';">
                <span>PLAY</span>
              </button>             
 <button class="modeBtn" type="button" data-mode="explore" data-id="${escapeAttr(meta.id)}" title="Explore">
                <img src="${APP.btnExploreModeImage}" alt="Explore" onerror="this.style.display='none'; this.parentElement.querySelector('span').style.display='block';">
                <span>EXP</span>
              </button>
              <button class="modeBtn" type="button" data-mode="host" data-id="${escapeAttr(meta.id)}" title="Host">
                <img src="${APP.btnHostModeImage}" alt="Host" onerror="this.style.display='none'; this.parentElement.querySelector('span').style.display='block';">
                <span>HOST</span>
              </button>

            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  $("#pickerSearch")?.addEventListener("input", (e) => {
    picker.search = e.target.value || "";
    renderPick();
  });

  $("#sortNameBtn")?.addEventListener("click", () => {
    if(picker.sortBy === "name") picker.sortDir = picker.sortDir === "asc" ? "desc" : "asc";
    else { picker.sortBy = "name"; picker.sortDir = "desc"; }
    renderPick();
  });

  $("#sortDateBtn")?.addEventListener("click", () => {
    if(picker.sortBy === "date") picker.sortDir = picker.sortDir === "asc" ? "desc" : "asc";
    else { picker.sortBy = "date"; picker.sortDir = "desc"; }
    renderPick();
  });

  $("#sortDirBtn")?.addEventListener("click", () => {
    picker.sortDir = picker.sortDir === "asc" ? "desc" : "asc";
    renderPick();
  });

  elMain.querySelectorAll(".modeBtn[data-id][data-mode]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await startQuiz(btn.getAttribute("data-id"), btn.getAttribute("data-mode"));
    });
  });
}

async function startQuiz(quizId, mode){
  await ensureQuizLoaded(quizId);

  State.view = "play";
  State.quizId = quizId;
  State.roundIdx = 0;
  State.qIdx = 0;
  State.mode = mode || "play";
  State.immediate = false;
  State.answers = {};
  State.submitted = {};
  State.lastFeedback = null;
  State.revealAnswers = false;
  State.tempReveal = false;
  State.confirmQuit = false;
  State.confirmSubmit = false;
  State.resultsOpenRoundId = null;
  State.previewImage = null;
  State.maxVisitedPos = 0;

  renderPlay();
}
function renderPlay(){
  AUDIO.stop();
  VIDEO.stop();
  closeOverlays();
  State.view = "play";
  applyBackground();

  const quiz = getQuiz();
  const round = getRound();
  const q = getQuestion();

  if(!quiz || !round || !q){
    renderPick();
    return;
  }

  markCurrentVisited();

  const typeKey = getQuestionType(q);
  const type = QUESTION_TYPES[typeKey] || QUESTION_TYPES.text;
  const isScored = type.isScored !== false;
  const isPlay = isPlayMode();
  const isExplore = isExploreMode();
  const isHost = isHostMode();
  const submitted = !!State.submitted[q.id];

  const slideSrc = slideSrcForQuestion(q, round);
  const slideOverlay = isRevealMode()
    ? (q.media?.answerOverlayImage || q.media?.overlayImage || "")
    : (q.media?.overlayImage || "");

  const introImage = isRevealMode()
    ? (q.media?.answerIntroImage || q.media?.introImage || "")
    : (q.media?.introImage || "");

  const isVideoType = (typeKey === "video" || typeKey === "video-text");
  const roundTitle = round.title || "";
  const questionMarkerHtml = getQuestionMarkerHtml(q, State.roundIdx, State.qIdx);

  let slideHtml = "";
  if(isVideoType && q.media?.video && !isRevealMode()){
    slideHtml = `
      <video class="slideVideo" src="${escapeAttr(q.media.video)}" controls playsinline></video>
      ${slideOverlay ? `<img class="slideOverlay" src="${escapeAttr(slideOverlay)}" alt="">` : ``}
    `;
  } else if(slideSrc){
    slideHtml = `
      <img src="${escapeAttr(slideSrc)}" alt="">
      ${slideOverlay ? `<img class="slideOverlay" src="${escapeAttr(slideOverlay)}" alt="">` : ``}
    `;
  }

  const leftButtons = `
    ${circleImgButton({ id:"quitBtn", imgSrc:APP.btnQuitImage, fallbackText:"QUIT", title:"Quit quiz" })}
    ${(isHost || isExplore || isPlay) ? circleImgButton({ id:"roundsBtn", imgSrc:APP.btnRoundsImage, fallbackText:"ROUNDS", title:"Rounds" }) : ``}
  `;

  const centreButtons = `
    ${circleImgButton({ id:"backBtn", imgSrc:APP.btnBackImage, fallbackText:"BACK", title:"Previous question", extraClass: canGoBackCurrent() ? "" : "btnDisabled" })}
    ${circleImgButton({ id:"nextBtn", imgSrc:APP.btnNextImage, fallbackText:"NEXT", title:"Next question", extraClass: canGoNextCurrent() ? "" : "btnDisabled" })}
  `;

  const rightButtons = `${(isPlay || isExplore) && isScored ? circleImgButton({ id:"submitBtn", imgSrc:APP.btnSubmitImage, fallbackText:"SUBMIT", title:(isPlay || isExplore) && submitted ? "Unsubmit answer" : "Submit answer", extraClass: submitted ? "isSubmitted" : "" }) : ""}${(isHost || isExplore) && isScored ? circleImgButton({ id:"showAnsBtn", imgSrc:APP.btnShowAnswerImage, fallbackText:"ANS", title:"Reveal answer", extraClass: State.revealAnswers ? "isActive" : "" }) : ""}`;

  const questionPromptHtml = (isVideoType || typeKey === 'media-grid')
    ? (typeKey === 'media-grid' ? '' : `<div class="qPrompt">${(q.prompt || "")}</div>`)
    : (questionMarkerHtml
        ? `<div class="questionPromptRow"><div class="questionPromptMarker">${questionMarkerHtml}</div><div class="questionPromptMain"><div class="qPrompt">${(q.prompt || "")}</div></div></div>`
        : `<div class="qPrompt">${(q.prompt || "")}</div>`);

  elMain.innerHTML = `
    <div class="panel col">
      <div class="qCountWrap"><div class="qCount">${roundTitle}</div></div>
      <div class="slide slideRel">${slideHtml}</div>
      ${questionPromptHtml}
      ${introImage ? `<div class="gridIntroWrap"><img class="gridIntroImg" src="${escapeAttr(introImage)}" alt=""></div>` : ``}
      <div class="col" style="gap:14px; width:100%; justify-items:center;">
        ${type.render(q)}
      </div>
      ${typeKey === 'media-grid' ? `<div class="qPrompt qPromptBelow">${(q.prompt || "")}</div>` : ''}
      <div class="actionBar">
        <div class="actionGroup actionLeft">${leftButtons}</div>
        <div class="actionGroup actionCentre">${centreButtons}</div>
        <div class="actionGroup actionRight">${rightButtons}</div>
      </div>
      <div class="feedback" id="fb"></div>
    </div>
  `;

  if(typeof type.afterRender === "function") type.afterRender(q);

  if((isPlay || isExplore) && submitted){
    lockInputs();
    clearAnswerStateClasses();
    const value = State.answers[q.id];

    if(isPlay){
      if(typeKey === "mcq" || typeKey === "audio-mcq"){
        elMain.querySelectorAll('.mcqOpt').forEach(opt => {
          const optId = opt.getAttribute('data-optid') || opt.querySelector('input[type="radio"]')?.value || '';
          if(optId === value && value) opt.classList.add('answerShown');
        });
      }
      else if(typeKey === "media-grid") markMediaGridPerField(q, value);
      else if(typeKey === "video") markVideoFieldStates(q, value);
      else if(typeKey === "music-map") markMusicMapFieldStates(q, value);
      else if(typeKey === "multi-text") markMultiTextFieldStates(q, value);
      else if(typeKey === "audio-text") markSingleTextField('#ansAudioText', q.answer?.accepted || [], value || "__submitted__");
      else if(typeKey === "text" || typeKey === "video-text") markSingleTextField('#ansText', q.answer?.accepted || [], value || "__submitted__");

      elMain.querySelectorAll('.answerCorrect,.answerWrong').forEach(el => {
        el.classList.remove('answerCorrect','answerWrong');
        el.classList.add('answerShown');
      });
      elMain.querySelectorAll('.mcqCorrect,.mcqWrong').forEach(el => {
        el.classList.remove('mcqCorrect','mcqWrong');
        el.classList.add('answerShown');
      });

    } else if(isExplore){
      if(typeKey === "mcq" || typeKey === "audio-mcq") markMcqSubmittedState(q, value);
      else if(typeKey === "media-grid") markMediaGridPerField(q, value);
      else if(typeKey === "video") markVideoFieldStates(q, value);
      else if(typeKey === "music-map") markMusicMapFieldStates(q, value);
      else if(typeKey === "multi-text") markMultiTextFieldStates(q, value);
      else if(typeKey === "audio-text") markSingleTextField('#ansAudioText', q.answer?.accepted || [], value);
      else if(typeKey === "text" || typeKey === "video-text") markSingleTextField('#ansText', q.answer?.accepted || [], value);
    }
  }

  if((isExplore || isHost) && State.revealAnswers && isScored && (typeKey === 'mcq' || typeKey === 'audio-mcq') && !submitted){
    markMcqRevealState(q);
  }

  if((isExplore || isHost) && State.revealAnswers && isScored){
    elMain.querySelectorAll('#ansText, #ansAudioText, .multiIn, .gridIn, .videoIn, .musicIn').forEach(el => {
      el.classList.add('answerShown','answerReveal');
    });

    if(typeKey === 'media-grid'){
      const revealVals = getRevealAnswerValue(q, 'media-grid') || {};
      elMain.querySelectorAll('.gridIn').forEach(inp => {
        const itemId = inp.getAttribute('data-item');
        const field = inp.getAttribute('data-field');
        if(!itemId || !field) return;
        inp.value = ((revealVals[itemId] || {})[field] || '');
        inp.readOnly = true;
        inp.classList.remove('answerCorrect', 'answerWrong');
        inp.classList.add('answerShown', 'answerReveal');
      });
    }

    autosizeRevealedTextareas();
  }

  if((isExplore || isHost) && State.revealAnswers && isScored){
    applyRevealMediaToCurrentDom(q, typeKey);
  }

$("#quitBtn")?.addEventListener("click", () => {
  if(State.mode === "host"){
    renderPick();
    return;
  }
  State.confirmQuit = true;
  renderOverlays();
});

  $("#roundsBtn")?.addEventListener("click", () => { State.roundsOpen = true; renderOverlays(); });

  $("#backBtn")?.addEventListener("click", () => {
    if(!canGoBackCurrent()) return;
    goPrevQuestion();
  });

  $("#nextBtn")?.addEventListener("click", () => {
    if(!canGoNextCurrent()) return;
    goNextQuestionNoResults();
  });

  $("#showAnsBtn")?.addEventListener("click", () => {
    State.revealAnswers = !State.revealAnswers;
    State.lastFeedback = null;
    renderPlay();
  });

  $("#submitBtn")?.addEventListener("click", () => {
    if(!isScored) return;

    if(isPlay){
      if(State.submitted[q.id]){
        State.submitted[q.id] = false;
        renderPlay();
        return;
      }
      State.answers[q.id] = type.read(q);
      State.submitted[q.id] = true;
      renderPlay();
      return;
    }

    if(isExplore){
      if(State.submitted[q.id]){
        State.submitted[q.id] = false;
        renderPlay();
        return;
      }
      const value = type.read(q);
      State.answers[q.id] = value;
      State.submitted[q.id] = true;
      const res = type.grade(q, value);
      State.lastFeedback = !!res.ok;
      renderPlay();
      return;
    }
  });
}

function nextQuestion(){
  State.tempReveal = false;
  State.revealAnswers = false;
  const quiz = getQuiz();
  const round = getRound();

  AUDIO.stop();
  VIDEO.stop();

  if(State.qIdx < round.questions.length - 1){
    State.qIdx++;
    State.lastFeedback = null;
    renderPlay();
    return;
  }

  if(State.roundIdx < quiz.rounds.length - 1){
    State.roundIdx++;
    State.qIdx = 0;
    State.lastFeedback = null;
    renderPlay();
    return;
  }

  if(State.mode === 'host'){
    State.lastFeedback = null;
    renderPlay();
    return;
  }

  State.confirmSubmit = true;
  renderOverlays();
}

function goNextQuestionNoResults(){
  State.tempReveal = false;
  const quiz = getQuiz();
  const round = getRound();

  AUDIO.stop();
  VIDEO.stop();

  if(State.qIdx < round.questions.length - 1){
    State.qIdx++;
    State.lastFeedback = null;
    renderPlay();
    return;
  }

  if(State.roundIdx < quiz.rounds.length - 1){
    State.roundIdx++;
    State.qIdx = 0;
    State.lastFeedback = null;
    renderPlay();
    return;
  }

  if(State.mode === 'host'){
    State.lastFeedback = null;
    renderPlay();
    return;
  }

  State.confirmSubmit = true;
  renderOverlays();
}

function goPrevQuestion(){
  const quiz = getQuiz();
  AUDIO.stop();
  VIDEO.stop();
  if(State.qIdx > 0){ State.qIdx--; State.lastFeedback = null; renderPlay(); return; }
  if(State.roundIdx > 0){ State.roundIdx--; const prevRound = quiz.rounds[State.roundIdx]; State.qIdx = Math.max(0, prevRound.questions.length - 1); State.lastFeedback = null; renderPlay(); return; }
}

/* ---------------- Results computation ---------------- */

function computeResults(){
  const quiz = getQuiz();
  if(!quiz) return null;

  let overallGot = 0;
  let overallTotal = 0;
  let overallGotFrac = { n: 0n, d: 1n };

  const computed = quiz.rounds.map((r, ridx) => {
    let got = 0;
    let total = 0;
    let gotFrac = { n: 0n, d: 1n };
    const qs = [];

    (r.questions || []).forEach((q) => {
      const typeKey = getQuestionType(q);
      const type = QUESTION_TYPES[typeKey];
      if(type.isScored === false) return;

      const val = State.answers[q.id];

      const ptsRaw = Number.isFinite(q.points) ? q.points : parseInt(q.points, 10);
      const maxPts = (ptsRaw && ptsRaw > 0) ? ptsRaw : 1;

      total += maxPts;

      const res = type.grade(q, val);

      let earnedNumeric = res.ok ? maxPts : 0;

      let earnedFrac = res.ok
        ? { n: BigInt(maxPts), d: 1n }
        : { n: 0n, d: 1n };

      let earnedDisplay = String(res.ok ? maxPts : 0);

      if(!res.ok && typeof res.correctCount === "number" && typeof res.totalCount === "number" && res.totalCount > 0){
        earnedNumeric = maxPts * (res.correctCount / res.totalCount);
        earnedFrac = reduceFrac({
          n: BigInt(maxPts) * BigInt(res.correctCount),
          d: BigInt(res.totalCount)
        });
        earnedDisplay = formatFracPretty(earnedFrac);
      }

      got += earnedNumeric;
      gotFrac = addFrac(gotFrac, earnedFrac);

      const correctText = getCorrectAnswerText(q, typeKey) || "";
      const yourText = (() => {
        if(typeKey === "music-map"){
          const obj = (val && typeof val === "object") ? val : {};
          const parts = Object.keys(obj).map(k => `${k}:${obj[k]}`).slice(0,8).join(" · ");
          return parts || "—";
        }
        if(typeKey === "mcq"){
          const opt = (q.options||[]).find(o => o.id === val);
          return opt ? opt.text : "—";
        }
        if(typeKey === "multi-text"){
          const arr = Array.isArray(val) ? val : [];
          return arr.map(x => (x||"").trim()).filter(Boolean).join(" · ") || "—";
        }
        if(typeKey === "media-grid"){
          const obj = (val && typeof val === "object") ? val : {};
          const keys = Object.keys(obj);
          if(!keys.length) return "—";
          const bits = [];
          for(const k of keys.slice(0,4)){
            const fieldObj = obj[k] || {};
            const fields = Object.keys(fieldObj);
            const joined = fields.map(f => fieldObj[f]).filter(Boolean).join(" / ");
            if(joined) bits.push(`${k}:${joined}`);
          }
          return bits.join(" · ") || "—";
        }
        if(typeKey === "video"){
          const obj = (val && typeof val === "object") ? val : {};
          const keys = Object.keys(obj);
          if(!keys.length) return "—";
          return keys.map(k => `${k}:${obj[k]}`).filter(x => !x.endsWith(":")).join(" · ") || "—";
        }
        return (val || "").toString().trim() || "—";
      })();

      qs.push({
        id: q.id,
        prompt: q.prompt || "",
        ok: !!res.ok,

        earnedNumeric,
        earnedDisplay,
        maxPts,

        yourText,
        correctText,
        afterNote: (q.afterNote || "").trim()
      });
    });

    return {
      id: r.id || ("round_" + ridx),
      title: r.title || ("Round " + (ridx+1)),
      got,
      gotFrac,
      total,
      questions: qs
    };
  });

  const rounds = computed.filter(r => r.total > 0);

  rounds.forEach(r => {
    overallGot += r.got;
    overallTotal += r.total;
    overallGotFrac = addFrac(overallGotFrac, r.gotFrac);
  });

  return {
    quizId: quiz.id,
    quizTitle: quiz.title || "Quiz",
    overallGot,
    overallGotFrac,
    overallTotal,
    rounds
  };
}

function renderResults(){
  AUDIO.stop();
  VIDEO.stop();
  closeOverlays();
  State.view = "results";
  State.lastFeedback = null;
  applyBackground();

  const quiz = getQuiz();
  if(!quiz) return renderHome();

  const data = computeResults();
  if(!data){
    renderPick();
    return;
  }

  const overall = `${formatFracPretty(data.overallGotFrac)} / ${data.overallTotal}`;

  const pct = (data.overallTotal > 0)
    ? Math.round((data.overallGot / data.overallTotal) * 100)
    : 0;

  const roundBlocks = (data.rounds || []).map(r => {
    const open = (State.resultsOpenRoundId === r.id);
    return `
      <div class="card resultsRound ${open ? "open" : ""}" data-round="${escapeAttr(r.id)}">
        <div class="resultsRoundHead">
          <div class="resultsRoundTitle">${escapeHtml(r.title)}</div>
          <div class="resultsRoundScore">${escapeHtml(formatFracPretty(r.gotFrac) + " / " + r.total)}</div>
        </div>

        ${open ? `
          <div class="resultsQuestions">
            ${r.questions.length ? r.questions.map(q => `
              <div class="resultsQ ${q.ok ? "ok" : "bad"}">
                <div class="resultsQPrompt">${escapeHtml(q.prompt)}</div>
                <div class="resultsQMeta tiny" style="white-space:pre-wrap;">
                  You: ${escapeHtml(q.yourText)} · Answer: ${escapeHtml(q.correctText)} ${q.ok ? "✅" : "❌"}
                  ${escapeHtml(q.earnedDisplay)} pts
                </div>
                ${q.afterNote ? `<div class="tiny" style="margin-top:8px;">${escapeHtml(q.afterNote)}</div>` : ""}
              </div>
            `).join("") : `<div class="tiny">No scoring questions in this round.</div>`}
          </div>
        ` : ``}
      </div>
    `;
  }).join("");

  elMain.innerHTML = `
    <div class="panel col">
      <div class="resultsTop">
        <div class="resultsBig">${escapeHtml(overall)}</div>
        <div class="resultsPct tiny">${escapeHtml(pct + "%")}</div>
      </div>

      <div class="row circleRow" style="margin-top:6px;">
        ${circleImgButton({ id:"resultsBackBtn", imgSrc:APP.btnQuitImage, fallbackText:"EXIT" })}
      </div>

      <div class="scroll col resultsScroll" style="gap:16px; width:100%;">
        ${roundBlocks || `<div class="tiny">No scoring rounds in this quiz.</div>`}
      </div>
    </div>
  `;

  $("#resultsBackBtn")?.addEventListener("click", () => renderPick());

  elMain.querySelectorAll(".resultsRound").forEach(card => {
    card.addEventListener("click", () => {
      const rid = card.getAttribute("data-round");
      if(!rid) return;
      State.resultsOpenRoundId = (State.resultsOpenRoundId === rid) ? null : rid;
      renderResults();
    });
  });
}

function renderFinishQuiz(){
  AUDIO.stop();
  VIDEO.stop();
  closeOverlays();
  State.view = "finish";
  applyBackground();
  elMain.innerHTML = `
    <div class="panel col">
      <div class="qPrompt">Submit quiz?</div>
      <div class="tiny">You can still go back and review or change any answers before finalising.</div>
      <div class="row homeBtns">
        ${circleImgButton({ id:"finishBackBtn", imgSrc:APP.btnBackImage, fallbackText:"BACK", title:"Go back" })}
        ${circleImgButton({ id:"finishSubmitBtn", imgSrc:APP.btnSubmitImage, fallbackText:"SUBMIT", title:"Submit quiz" })}
      </div>
    </div>
  `;
  $("#finishBackBtn")?.addEventListener("click", () => renderPlay());
  $("#finishSubmitBtn")?.addEventListener("click", () => renderResults());
}

function renderSearch(){
  AUDIO.stop();
  VIDEO.stop();
  closeOverlays();
  State.view = "search";
  State.lastFeedback = null;
  applyBackground();

  elMain.innerHTML = `
    <div class="panel col">
      <input type="search" id="s" placeholder="Search… (loads quiz files)">
      <div id="results" class="scroll col" style="gap:16px;"></div>
      <div class="tiny" id="hint"></div>
    </div>
  `;

  const elS = $("#s");
  const elR = $("#results");
  const elH = $("#hint");

  let loadingAll = false;

  async function ensureAllLoaded(){
    if(loadingAll) return;
    loadingAll = true;
    elH.textContent = "Loading quizzes…";
    const idx = window.QUIZ_INDEX || [];
    for(const q of idx){
      if(!(window.QUIZ_STORE||{})[q.id]) await ensureQuizLoaded(q.id);
    }
    elH.textContent = "";
    loadingAll = false;
  }

  elS.addEventListener("input", async () => {
    const term = normalize(elS.value);
    elR.innerHTML = "";
    if(!term){
      elH.textContent = "Type to search.";
      return;
    }

    await ensureAllLoaded();

    const store = window.QUIZ_STORE || {};
    const idx = window.QUIZ_INDEX || [];
    const res = [];

    for(const meta of idx){
      const quiz = store[meta.id];
      if(!quiz) continue;
      quiz.rounds.forEach(r => {
        r.questions.forEach(q => {
          const hay = normalize(
            (q.prompt || "") + " " +
            (q.subtitle || "") + " " +
            (q.note || "") + " " +
            (q.afterNote || "") + " " +
            (q.type || "") + " " +
            ((q.answer?.accepted||[]).join(" "))
          );
          if(hay.includes(term)){
            res.push(`
              <div class="card" style="cursor:default;">
                <div class="cardTitle">${escapeHtml(q.prompt || q.subtitle || "(divider)")}</div>
                <div class="cardSub">${escapeHtml(quiz.title)} · ${escapeHtml(r.title)} · <b>${escapeHtml(q.type||"text")}</b></div>
              </div>
            `);
          }
        });
      });
    }

    elH.textContent = res.length ? "" : "No results.";
    elR.innerHTML = res.join("");
  });
}

document.addEventListener("keydown", (e) => {
  if(e.key === "Escape"){
    if(State.roundsOpen || State.confirmQuit || State.confirmSubmit || State.previewImage){ closeOverlays(); return; }
  }
  const active = document.activeElement;
  const isTyping = active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName);
  if(State.view === 'play' && !State.roundsOpen && !isTyping){
    if(e.key === 'ArrowLeft'){ e.preventDefault(); const b = $("#backBtn"); if(b) b.click(); return; }
    if(e.key === 'ArrowRight'){ e.preventDefault(); const n = $("#nextBtn"); if(n) n.click(); return; }
    if(e.key === 'ArrowUp' || e.key === 'ArrowDown'){
      const panel = elMain.querySelector(".panel");
      if(panel){ panel.scrollBy({ top: e.key === 'ArrowDown' ? 120 : -120, behavior: 'smooth' }); e.preventDefault(); }
      return;
    }
  }
  if((State.view === 'play' || State.view === 'finish') && e.key === 'Enter' && !State.roundsOpen){
    if(State.view === 'play' && State.mode === 'explore'){
      const submit = $("#submitBtn");
      if(submit && !submit.disabled){ e.preventDefault(); submit.click(); }
      return;
    }
    const submit = $("#submitBtn") || $("#finishSubmitBtn");
    if(submit && !submit.disabled){ e.preventDefault(); submit.click(); }
  }
});

/* ---------- Top buttons ---------- */
$("#btnHome")?.addEventListener("click", () => {
  if(State.view === "play" || State.view === "finish" || State.view === "results"){
    if(State.mode === "host"){
      renderHome();
      return;
    }
    State.confirmQuit = true;
    renderOverlays();
    return;
  }
  renderHome();
});

function fixIconFallbacks(){
  document.querySelectorAll(".iconBtn").forEach(btn => {
    const img = btn.querySelector("img");
    const fb = btn.querySelector(".iconFallback");
    if(!img || !fb) return;
    img.addEventListener("error", () => {
      img.style.display = "none";
      fb.style.display = "inline-block";
    });
  });
}

/* Small CSS patch */
(function injectPatchStyles(){
  if(document.getElementById("appJsPatchStyles")) return;
  const css = `
    .slideRel{ position: relative; }
    .slideVideo{ width:100%; max-height:46vh; display:block; object-fit:contain; }
    .slideOverlay{
      position:absolute;
      top:14px;
      right:14px;
      width:84px;
      max-width:18%;
      height:auto;
      opacity:0.96;
      pointer-events:none;
      filter: drop-shadow(0 10px 18px rgba(0,0,0,.65));
    }
    .videoWrap{ position:relative; width:min(860px, 94%); }
    .videoOverlay{
      position:absolute;
      top:12px;
      right:12px;
      width:72px;
      max-width:22%;
      height:auto;
      pointer-events:none;
      filter: drop-shadow(0 10px 18px rgba(0,0,0,.65));
    }
    .feedback{ white-space: pre-wrap; word-break: break-word; }

    /* media-grid: video tiles (plain video + poster overlay) */
    .gridVidWrap{
      position:relative;
      width:100%;
      aspect-ratio: var(--ar, 16/9);
      overflow:hidden;
    }
    .gridVidEl{
      position:absolute;
      inset:0;
      width:100%;
      height:100%;
      display:block;
      object-fit:contain;
      background:transparent;
    }
    .gridPoster{
      position:absolute;
      inset:0;
      width:100%;
      height:100%;
      object-fit:contain;
      object-position:center;
      opacity:1;
      transition: opacity .12s linear;
      pointer-events:none;
      background:transparent;
    }
  `;
  const style = document.createElement("style");
  style.id = "appJsPatchStyles";
  style.textContent = css;
  document.head.appendChild(style);
})();

fixIconFallbacks();
renderOverlays();
renderHome();
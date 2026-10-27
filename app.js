/* ==========================================================================
   Fovea — lecteur RSVP (JavaScript vanilla)

   1. Cœur pur : tokenisation, poids de pause, calcul de l'ORP, mise à l'échelle.
      Ces fonctions n'utilisent pas le DOM (elles sont testées sous Node).
   2. Interface : lecture, contrôles, progression, clavier, molette.
   3. Voix : dictée optionnelle par Piper (VITS en WebAssembly, exécutée dans le
      navigateur via la librairie @mintplex-labs/piper-tts-web, chargée à la
      demande). Quand la voix est active, c'est l'horloge audio qui commande
      l'affichage : le texte est découpé en segments d'environ une phrase,
      chaque segment est synthétisé séparément, et sa durée réelle sert
      d'échelle de temps. Les mots du segment sont répartis sur cette durée
      proportionnellement à leurs poids de pause : la synchro est exacte à
      chaque frontière de phrase. La vitesse agit sur la voix par un facteur
      ×0,5 à ×2 (300 mots/min = ×1) ; le curseur WPM garde son sens exact
      en mode muet.
   ========================================================================== */
(() => {
  'use strict';

  /* ======================================================================
     1. CŒUR PUR
     ====================================================================== */

  const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
  const INVISIBLE = /[­​-‍⁠﻿]/g;
  const CLOSERS = /[\p{Pe}\p{Pf}"'*_]+$/u;           // ) ] » ” ’ " ' en fin de mot
  const SENTENCE_END = /(\.{2,}|…|[.!?])$/u;
  const OPENERS_ONLY = /^[«“„(\[{¿¡"'‘]+$/u;         // « seul, ( seul…
  const CLOSERS_ONLY = /^[»”’)\]}"']+$/u;

  const MAX_TOKEN = 14;       // au-delà, on coupe aux traits d'union
  const CHUNK_AFTER = 24;     // mot sans coupe possible : découpé en morceaux
  const CHUNK_SIZE = 12;

  const ABBREVIATIONS = new Set([
    'm', 'mm', 'mme', 'mmes', 'mlle', 'mr', 'mrs', 'ms', 'dr', 'pr', 'prof',
    'st', 'ste', 'vs', 'cf', 'no', 'fig', 'env', 'approx', 'éd', 'vol',
    'p', 'pp', 'av', 'bd', 'jr', 'sr', 'ex'
  ]);

  /* Position de la lettre d'ancrage (index dans la partie lettres/chiffres du
     mot). Environ 30–35 % de la longueur, avec un palier par taille. */
  function orpIndex(len) {
    if (len <= 1) return 0;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    if (len <= 13) return 3;
    return 4;
  }

  /* Découpe un mot en [avant | pivot | après]. La ponctuation de tête
     (« ( " …) n'entre pas dans le calcul : on ancre sur les lettres. */
  function splitWord(token) {
    const chars = Array.from(token.normalize('NFC'));
    let lead = 0;
    while (lead < chars.length && !LETTER_OR_DIGIT.test(chars[lead])) lead++;
    let trail = 0;
    while (trail < chars.length - lead && !LETTER_OR_DIGIT.test(chars[chars.length - 1 - trail])) trail++;
    const coreLen = chars.length - lead - trail;
    const pivot = coreLen > 0
      ? lead + orpIndex(coreLen)
      : Math.floor((chars.length - 1) / 2);
    return {
      before: chars.slice(0, pivot).join(''),
      pivot: chars[pivot] || '',
      after: chars.slice(pivot + 1).join('')
    };
  }

  function isAbbreviation(s) {
    if (!s.endsWith('.') || s.endsWith('..')) return false;
    if (/^(\p{L}\.){2,}$/u.test(s)) return true;           // U.S.A.
    const bare = s.slice(0, -1);
    if (/^\p{Lu}$/u.test(bare)) return true;                // initiale : J.
    return ABBREVIATIONS.has(bare.toLowerCase());
  }

  /* Poids d'un mot : 1 = durée de base (60 000 / WPM ms). Les mots longs et la
     ponctuation allongent l'affichage. */
  function weightOf(token) {
    const stripped = token.replace(CLOSERS, '');
    const letters = Array.from(stripped.replace(/[^\p{L}\p{N}]/gu, '')).length;
    let weight = letters >= 14 ? 1.6 : letters >= 10 ? 1.4 : letters >= 7 ? 1.15 : 1;
    if (SENTENCE_END.test(stripped)) weight += isAbbreviation(stripped) ? 0.15 : 1.1;
    else if (/[;:]$/.test(stripped)) weight += 0.7;
    else if (/[,–—]$/.test(stripped)) weight += 0.5;
    return weight;
  }

  /* Coupe un mot très long aux traits d'union / barres, puis en morceaux. */
  function expandToken(token) {
    if (Array.from(token).length <= MAX_TOKEN) return [token];
    const pieces = token.match(/[^-–—\/_]+[-–—\/_]*|[-–—\/_]+/gu) || [token];
    const merged = [];
    let current = '';
    for (const piece of pieces) {
      if (current && Array.from(current + piece).length > MAX_TOKEN) {
        merged.push(current);
        current = piece;
      } else {
        current += piece;
      }
    }
    if (current) merged.push(current);
    const out = [];
    for (const part of merged) {
      const chars = Array.from(part);
      if (chars.length > CHUNK_AFTER) {
        const chunks = [];
        for (let i = 0; i < chars.length; i += CHUNK_SIZE) chunks.push(chars.slice(i, i + CHUNK_SIZE).join(''));
        // Un reste trop court (ex. « . » seul) est recollé au morceau précédent.
        if (chunks.length > 1 && Array.from(chunks[chunks.length - 1]).length < 4) {
          chunks[chunks.length - 2] += chunks.pop();
        }
        out.push(...chunks);
      } else {
        out.push(part);
      }
    }
    return out;
  }

  const PARAGRAPH_PAUSE = 1.2;
  const DROPPED_ONLY = /^[-•*·◦▪■□>#]+$/u;          // puces et marques Markdown isolées
  const DASH_ONLY = /^[–—]+$/u;

  /* Texte → { words: [{ t, w, p, j }], total }.
     t = texte affiché, w = poids, p = fin de paragraphe,
     j = suite d'un mot coupé (affichée collée au morceau précédent dans le contexte). */
  function tokenize(text) {
    const words = [];
    const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);
    for (const paragraph of paragraphs) {
      const start = words.length;
      let prefix = '';
      for (const rawToken of paragraph.split(/\s+/)) {
        const raw = rawToken.replace(INVISIBLE, '');
        if (!raw) continue;
        if (!LETTER_OR_DIGIT.test(raw)) {
          // Ponctuation isolée (« ? », « ! », « — » après une espace) : jamais affichée
          // seule. Elle se recolle au mot voisin, ce qui garde aussi sa pause.
          if (OPENERS_ONLY.test(raw)) { prefix += raw; continue; }
          if (DROPPED_ONLY.test(raw)) continue;
          if (words.length > start) {
            const prev = words[words.length - 1];
            // Tiret de dialogue après une fin de phrase : on le laisse tomber.
            if (DASH_ONLY.test(raw) && SENTENCE_END.test(prev.t.replace(CLOSERS, ''))) continue;
            prev.t += raw;
          }
          continue;
        }
        expandToken(prefix + raw).forEach((piece, k) => {
          words.push({ t: piece, w: 1, p: false, j: k > 0 });
        });
        prefix = '';
      }
      if (words.length > start) {
        for (let i = start; i < words.length; i++) words[i].w = weightOf(words[i].t);
        const last = words[words.length - 1];
        last.p = true;
        last.w += PARAGRAPH_PAUSE;
      }
    }
    let total = 0;
    for (const word of words) total += word.w;
    return { words, total };
  }

  /* Taille de police maximale pour que le côté le plus long tienne dans la
     moitié de la scène (le pivot est au centre, donc chaque côté dispose de
     la moitié de la largeur). */
  function fitFontSize(beforeLen, afterLen, halfWidth, charEm, baseFs) {
    const longest = Math.max(beforeLen, afterLen) + 0.5;
    const maxFs = halfWidth / (longest * charEm);
    return Math.round(Math.max(12, Math.min(baseFs, maxFs)) * 10) / 10;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function formatClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
  }

  function formatHuman(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h} h ${pad2(m)} min`;
    return sec ? `${m} min ${pad2(sec)} s` : `${m} min`;
  }

  const Core = { orpIndex, splitWord, weightOf, isAbbreviation, expandToken, tokenize, fitFontSize, formatClock, formatHuman };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof document === 'undefined') return;
  window.FoveaCore = Core;

  /* ======================================================================
     2. INTERFACE
     ====================================================================== */

  const WPM_MIN = 100;
  const WPM_MAX = 1200;
  const WPM_STEP = 25;
  const SKIP_MS = 5000;
  const RAMP = [1.9, 1.5, 1.2];         // les premiers mots après un départ sont plus lents
  const STORE = {
    text: 'fovea.text', wpm: 'fovea.wpm', pauses: 'fovea.pauses',
    voice: 'fovea.voice', voiceId: 'fovea.voiceid'
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    editor: $('editor'), reader: $('reader'),
    source: $('source'), error: $('editor-error'),
    statWords: $('stat-words'), statTime: $('stat-time'),
    btnSample: $('btn-sample'), btnClear: $('btn-clear'), btnStart: $('btn-start'),
    btnEdit: $('btn-edit'), status: $('status'),
    stage: $('stage'), word: $('word'),
    before: $('w-before'), pivot: $('w-pivot'), after: $('w-after'), probe: $('probe'),
    context: $('context'),
    bar: $('bar'), barFill: $('bar-fill'), barThumb: $('bar-thumb'), barMarks: $('bar-marks'),
    pct: $('pct'), pos: $('pos'), remaining: $('remaining'),
    btnPlay: $('btn-play'), iconPlay: $('icon-play'), iconPause: $('icon-pause'),
    btnBack: $('btn-back'), btnFwd: $('btn-fwd'), btnRestart: $('btn-restart'),
    range: $('wpm-range'), big: $('wpm-big'), wpmUnit: $('wpm-unit'), pauses: $('opt-pauses'),
    optVoice: $('opt-voice'), voiceSelect: $('voice-select'), voiceStatus: $('voice-status')
  };

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* stockage indisponible */ } }
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const state = {
    words: [],
    cum: [0],            // cum[i] = somme des poids des i premiers mots
    index: 0,
    wpm: 300,
    pauses: true,
    playing: false,
    finished: false,
    timer: 0,
    target: 0,           // instant visé pour l'affichage du mot suivant
    rampIdx: RAMP.length,
    loadedText: null,
    baseFs: 64,
    charEm: 0.6,
    curFs: 0,
    stageW: 0
  };

  /* ======================================================================
     3. VOIX — Piper en WebAssembly, synchro exacte sur l'audio
     ====================================================================== */

  const PIPER_CDN = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js';
  const VOICES = [
    { id: 'fr_FR-upmc-medium', label: 'UPMC · médium — femme (77 Mo)' },
    { id: 'fr_FR-siwis-medium', label: 'SIWIS · médium — homme (63 Mo)' },
    { id: 'fr_FR-siwis-low', label: 'SIWIS · low — homme (28 Mo)' },
    { id: 'fr_FR-tom-medium', label: 'Tom · médium — homme (64 Mo)' },
    { id: 'fr_FR-gilles-low', label: 'Gilles · low — homme (63 Mo)' },
    { id: 'fr_FR-mls-medium', label: 'MLS · médium — collectif (77 Mo)' }
  ];
  const SEG_MAX_WORDS = 60;      // coupe d'un segment au-delà (limite la latence de synthèse)
  const SEG_MAX_CHARS = 280;
  const VOICE_LOOKAHEAD = 12;    // segments synthétisés en avance sur la lecture
  const VOICE_WPM_REF = 300;     // 300 mots/min = voix ×1
  const VOICE_MIN_WPM = 150;     // ×0,5
  const VOICE_MAX_WPM = 600;     // ×2

  const voice = {
    on: false,
    id: VOICES[0].id,
    segs: [],           // [{ first, count, cum, text, buf, dur, start, job, times }]
    mods: {},           // modules Piper chargés (un par voix)
    ctx: null,          // AudioContext
    src: null,          // AudioBufferSourceNode courant
    clock: null,        // { k, segStart, anchorPos, t0, rate } tant qu'un son joue
    pos: 0,             // position sur la ligne de temps audio (secondes à ×1)
    playing: false,
    waiting: false,     // lecture suspendue le temps de synthétiser le segment suivant
    waitSeg: null,
    gen: 0,             // jeton d'invalidation des synthèses en cours
    pointer: 0,         // index du segment en lecture
    raf: 0,
    estWordDur: 0.33,   // secondes audio par unité de poids (estimation)
    knownDur: 0,
    knownWeight: 0
  };

  const voiceRate = () => clamp(state.wpm / VOICE_WPM_REF, 0.5, 2);

  function audioCtx() {
    if (!voice.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('AudioContext indisponible dans ce navigateur');
      voice.ctx = new AC();
    }
    if (voice.ctx.state === 'suspended') voice.ctx.resume();
    return voice.ctx;
  }

  /* La librairie Piper garde une session unique par module : on charge un
     module distinct par voix (le suffixe change la clé de cache du module
     sans changer le fichier servi). */
  async function piper(id) {
    if (!voice.mods[id]) {
      voice.mods[id] = import(PIPER_CDN + '?voice=' + encodeURIComponent(id));
    }
    return voice.mods[id];
  }

  function setVoiceStatus(text) { el.voiceStatus.textContent = text || ''; }

  function updateRateDisplay() {
    el.wpmUnit.textContent = voice.on
      ? 'mots / min · voix ×' + voiceRate().toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : 'mots / min';
  }

  function endsSentence(token) {
    const stripped = token.replace(CLOSERS, '');
    return SENTENCE_END.test(stripped) && !isAbbreviation(stripped);
  }

  /* Découpe le texte en segments d'environ une phrase. Chaque segment est
     synthétisé séparément : la durée réelle de son audio donne l'échelle de
     temps sur laquelle ses mots sont répartis (synchro exacte aux bornes). */
  function buildSegments() {
    const segs = [];
    const words = state.words;
    let i = 0;
    while (i < words.length) {
      let text = '';
      let count = 0;
      const first = i;
      while (i < words.length) {
        const w = words[i];
        i++;
        text += (count === 0 || w.j) ? w.t : ' ' + w.t;   // morceaux de mots coupés : collés
        count++;
        if (w.p || endsSentence(w.t) || count >= SEG_MAX_WORDS || text.length >= SEG_MAX_CHARS) break;
      }
      const cum = new Array(count + 1);
      cum[0] = 0;
      for (let k = 0; k < count; k++) cum[k + 1] = cum[k] + words[first + k].w;
      segs.push({ first, count, cum, text: text.trim(), buf: null, dur: 0, start: 0, job: null, times: null });
    }
    return segs;
  }

  function prepareVoiceText(resetPos) {
    voice.gen++;
    voice.segs = buildSegments();
    voice.knownDur = 0;
    voice.knownWeight = 0;
    voice.estWordDur = 0.33;
    voice.waiting = false;
    voice.waitSeg = null;
    voice.pointer = 0;
    recomputeLayout();
    if (resetPos) {
      stopSource();
      voice.pos = 0;
    }
  }

  const estDur = (s) => voice.estWordDur * s.cum[s.count];

  /* Début de chaque segment sur la ligne de temps : durée réelle quand elle
     est connue, estimation sinon (les segments non synthétisés sont
     repositionnés au fur et à mesure). */
  function recomputeLayout() {
    let t = 0;
    for (const s of voice.segs) {
      s.start = t;
      t += s.buf ? s.dur : estDur(s);
      s.times = null;
    }
  }

  function voiceTotal() {
    let t = 0;
    for (const s of voice.segs) t += s.buf ? s.dur : estDur(s);
    return t;
  }

  /* Instants d'affichage des mots d'un segment (une fois son audio connu). */
  function segSchedule(s) {
    if (!s.buf) return null;
    if (!s.times) {
      const total = s.cum[s.count] || 1;
      const times = new Array(s.count + 1);
      for (let k = 0; k <= s.count; k++) times[k] = s.start + (s.dur * s.cum[k]) / total;
      s.times = times;
    }
    return s.times;
  }

  function segOfPos(pos) {
    const segs = voice.segs;
    let lo = 0, hi = segs.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  function segOfWord(i) {
    const segs = voice.segs;
    let lo = 0, hi = segs.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].first <= i) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  function wordAtTime(seg, local) {
    const times = segSchedule(seg);
    let j = 0;
    if (times) {
      while (j < seg.count - 1 && local >= times[j + 1]) j++;
      while (j > 0 && local < times[j]) j--;
    }
    return j;
  }

  function timeOfWord(i) {
    const segs = voice.segs;
    if (!segs.length) return 0;
    const s = segs[segOfWord(i)];
    const times = segSchedule(s);
    return times ? times[clamp(i - s.first, 0, s.count - 1)] : s.start;
  }

  function handleVoiceError(err) {
    console.error(err);
    setVoiceStatus('⚠ Synthèse vocale impossible — vérifiez la connexion, puis relancez ou désactivez la dictée.');
    voice.waiting = false;
    voice.waitSeg = null;
    if (voice.playing) voicePause();
  }

  /* Synthèse d'un segment (avec cache : buf / job sur le segment). */
  function synthesize(seg, k) {
    if (seg.buf) return Promise.resolve(seg.buf);
    if (seg.job) return seg.job;
    const gen = voice.gen;
    seg.job = (async () => {
      const mod = await piper(voice.id);
      const blob = await mod.predict({ text: seg.text, voiceId: voice.id }, (p) => {
        if (gen !== voice.gen) return;
        setVoiceStatus(p.total
          ? 'Téléchargement de la voix… ' + Math.min(100, Math.round((p.loaded / p.total) * 100)) + ' %'
          : 'Téléchargement de la voix…');
      });
      if (gen !== voice.gen) return null;
      const ctx = audioCtx();
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      if (gen !== voice.gen) return null;
      seg.buf = buf;
      seg.dur = buf.duration;
      onSegmentReady(k);
      return buf;
    })();
    seg.job.catch((err) => {
      if (gen !== voice.gen) return;
      seg.job = null;
      handleVoiceError(err);
    });
    return seg.job;
  }

  /* File de production : d'abord le segment attendu par la lecture, puis une
     fenêtre d'avance à partir du segment courant. Une seule synthèse à la
     fois (l'inférence est déjà lourde). */
  function pump() {
    if (!voice.on || !voice.segs.length) return;
    const segs = voice.segs;
    if (voice.waitSeg != null) {
      const s = segs[voice.waitSeg];
      if (s && !s.buf && !s.job) { synthesize(s, voice.waitSeg); return; }
    }
    const to = Math.min(segs.length, voice.pointer + VOICE_LOOKAHEAD);
    for (let k = voice.pointer; k < to; k++) {
      if (!segs[k].buf && !segs[k].job) { synthesize(segs[k], k); return; }
    }
  }

  function waitForSegment(k) {
    voice.waiting = true;
    voice.waitSeg = k;
    setVoiceStatus('Synthèse de la voix en cours…');
    pump();
  }

  function onSegmentReady(k) {
    const seg = voice.segs[k];
    if (!seg) return;
    voice.knownDur += seg.dur;
    voice.knownWeight += seg.cum[seg.count];
    voice.estWordDur = voice.knownWeight > 0 ? voice.knownDur / voice.knownWeight : 0.33;
    recomputeLayout();
    if (voice.waitSeg === k) {
      voice.waiting = false;
      voice.waitSeg = null;
      if (voice.playing) {
        setVoiceStatus('');
        if (!startSourceAt(voice.pos)) waitForSegment(segOfPos(voice.pos));
      } else {
        // posé en pause sur un segment fraîchement synthétisé
        const j = wordAtTime(seg, voice.pos - seg.start);
        state.index = seg.first + j;
        state.finished = false;
        showWord(state.index);
        setVoiceStatus('');
      }
      renderContext();
      updateProgress();
      setUiPlaying();
    }
    pump();
  }

  /* Position courante sur la ligne de temps audio (secondes à ×1). */
  function voiceNow() {
    if (!voice.clock) return voice.pos;
    return voice.clock.anchorPos + (voice.ctx.currentTime - voice.clock.t0) * voice.clock.rate;
  }

  function stopSource() {
    if (voice.src) {
      voice.src.onended = null;
      try { voice.src.stop(); } catch (e) { /* déjà arrêté */ }
      voice.src = null;
    }
    voice.clock = null;
  }

  function startSourceAt(pos) {
    const segs = voice.segs;
    if (!segs.length) return false;
    let k = segOfPos(pos);
    let seg = segs[k];
    if (!seg || !seg.buf) return false;
    let offset = pos - seg.start;
    while (offset >= seg.dur && k + 1 < segs.length && segs[k + 1].buf) {
      offset -= seg.dur;
      k++;
      seg = segs[k];
    }
    if (offset >= seg.dur) offset = Math.max(0, seg.dur - 0.02);
    offset = Math.max(0, offset);
    const ctx = audioCtx();
    const src = ctx.createBufferSource();
    src.buffer = seg.buf;
    src.playbackRate.value = voiceRate();
    src.connect(ctx.destination);
    src.onended = () => {
      if (voice.src !== src) return;
      voice.src = null;
      voice.clock = null;
      onSegmentEnded(k);
    };
    src.start(0, offset);
    voice.src = src;
    voice.pointer = k;
    voice.clock = { k, segStart: seg.start, anchorPos: seg.start + offset, t0: ctx.currentTime, rate: voiceRate() };
    return true;
  }

  function onSegmentEnded(k) {
    const seg = voice.segs[k];
    if (seg) voice.pos = seg.start + seg.dur;
    const next = k + 1;
    if (next >= voice.segs.length) { voiceFinish(); return; }
    voice.pointer = next;
    if (!startSourceAt(voice.pos)) waitForSegment(next);
  }

  /* Boucle d'affichage : le mot montré est une fonction pure de l'horloge
     audio — c'est ce qui garantit la synchro avec la dictée. */
  function updateVoiceWord(pos) {
    const segs = voice.segs;
    let k = voice.pointer;
    const cur = segs[k];
    if (!cur || !cur.buf || pos < cur.start - 0.05 || (pos >= cur.start + cur.dur && k + 1 < segs.length)) {
      k = segOfPos(pos);
      const seg = segs[k];
      if (!seg || !seg.buf) return;          // segment pas encore prêt : l'affichage attend
      voice.pointer = k;
    }
    const seg = segs[k];
    const j = wordAtTime(seg, pos - seg.start);
    const idx = seg.first + j;
    if (idx !== state.index) {
      state.index = idx;
      state.finished = false;
      showWord(idx);
    }
  }

  function voiceFrame() {
    voice.raf = 0;
    if (!voice.on || !voice.playing) return;
    // Recalage de l'ancre si le début du segment courant a été réestimé.
    if (voice.clock) {
      const seg = voice.segs[voice.clock.k];
      if (seg && seg.start !== voice.clock.segStart) {
        const shift = seg.start - voice.clock.segStart;
        voice.clock.segStart = seg.start;
        voice.clock.anchorPos += shift;
      }
    }
    voice.pos = voiceNow();
    updateVoiceWord(voice.pos);
    updateProgress();
    voice.raf = requestAnimationFrame(voiceFrame);
  }

  function voicePlay() {
    if (voice.playing || !voice.segs.length) return;
    if (state.finished) {
      state.finished = false;
      state.index = 0;
      voice.pos = 0;
    }
    if (!voice.clock && voiceTotal() - voice.pos < 0.02) voice.pos = 0;
    audioCtx();
    voice.playing = true;
    state.playing = true;
    voice.pointer = segOfPos(voice.pos);
    setUiPlaying();
    renderContext();
    if (!voice.raf) voice.raf = requestAnimationFrame(voiceFrame);
    if (!startSourceAt(voice.pos)) waitForSegment(segOfPos(voice.pos));
    else setVoiceStatus('');
    pump();
  }

  function voicePause() {
    if (!voice.playing) return;
    voice.pos = voiceNow();
    stopSource();
    voice.playing = false;
    voice.waiting = false;
    voice.waitSeg = null;
    if (voice.raf) { cancelAnimationFrame(voice.raf); voice.raf = 0; }
    state.playing = false;
    setUiPlaying();
    renderContext();
    updateProgress();
  }

  function voiceFinish() {
    stopSource();
    voice.playing = false;
    voice.waiting = false;
    voice.waitSeg = null;
    if (voice.raf) { cancelAnimationFrame(voice.raf); voice.raf = 0; }
    state.playing = false;
    state.finished = true;
    voice.pos = voiceTotal();
    if (state.words.length) {
      state.index = state.words.length - 1;
      showWord(state.index);
    }
    setVoiceStatus('');
    setUiPlaying();
    updateProgress();
    renderContext();
  }

  function voiceSeekTime(t) {
    const total = voiceTotal();
    t = clamp(t, 0, Math.max(0, total - 0.02));
    const wasPlaying = voice.playing;
    if (wasPlaying) {
      voice.pos = voiceNow();
      stopSource();
      voice.waiting = false;
    }
    voice.pos = t;
    voice.pointer = segOfPos(t);
    state.finished = false;
    if (wasPlaying) {
      if (!startSourceAt(t)) waitForSegment(voice.pointer);
      else setVoiceStatus('');
    } else {
      voice.waitSeg = voice.pointer;
      pump();
    }
    const seg = voice.segs[voice.pointer];
    if (seg && seg.buf) {
      state.index = seg.first + wordAtTime(seg, t - seg.start);
      showWord(state.index);
    } else {
      state.index = seg ? seg.first : 0;
    }
    if (!voice.playing) {
      updateProgress();
      setUiPlaying();
      renderContext();
    }
  }

  function voiceSeekWord(i) {
    const n = state.words.length;
    if (!n || !voice.segs.length) return;
    i = clamp(Math.round(i), 0, n - 1);
    const seg = voice.segs[segOfWord(i)];
    const times = segSchedule(seg);
    voiceSeekTime(times ? times[clamp(i - seg.first, 0, seg.count - 1)] : seg.start);
    state.index = i;        // mot visé, affiché même si l'audio doit suivre
    showWord(i);
    if (!voice.playing) { updateProgress(); renderContext(); }
  }

  /* ---------- Jetons (avec cache sur le texte) ---------- */

  let cache = { text: null, tok: null };
  function getTokens(text) {
    if (cache.text !== text) cache = { text, tok: tokenize(text) };
    return cache.tok;
  }

  const weightAt = (i) => (state.pauses ? state.words[i].w : 1);
  const baseMs = () => 60000 / state.wpm;

  function rebuildCum() {
    const n = state.words.length;
    const cum = new Array(n + 1);
    cum[0] = 0;
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + weightAt(i);
    state.cum = cum;
  }

  /* ---------- Affichage du mot ---------- */

  function measure() {
    const w = el.stage.clientWidth;
    if (!w) return;
    state.stageW = w;
    state.baseFs = clamp(w * 0.085, 30, 92);
    el.stage.style.setProperty('--fs-base', state.baseFs.toFixed(1) + 'px');
    const probeW = el.probe.getBoundingClientRect().width;
    if (probeW > 0) state.charEm = probeW / 10 / 100;
    state.curFs = 0;
  }

  function showWord(i) {
    const word = state.words[i];
    if (!word) return;
    const parts = splitWord(word.t);
    el.before.textContent = parts.before;
    el.pivot.textContent = parts.pivot;
    el.after.textContent = parts.after;
    const half = Math.max(40, state.stageW / 2 - 20);
    const fs = fitFontSize(Array.from(parts.before).length, Array.from(parts.after).length, half, state.charEm, state.baseFs);
    if (fs !== state.curFs) {
      el.word.style.setProperty('--fs', fs + 'px');
      state.curFs = fs;
    }
  }

  function renderContext() {
    el.context.textContent = '';
    if (state.playing) return;
    const n = state.words.length;
    if (!n) return;
    const from = Math.max(0, state.index - 20);
    const to = Math.min(n, state.index + 40);
    const frag = document.createDocumentFragment();
    if (from > 0) frag.append('… ');
    for (let i = from; i < to; i++) {
      const span = document.createElement('span');
      span.textContent = state.words[i].t;
      span.dataset.i = String(i);
      if (i === state.index) span.className = 'cur';
      frag.append(span);
      if (state.words[i].p && i < to - 1) frag.append(document.createElement('br'));
      else if (!(i + 1 < n && state.words[i + 1].j)) frag.append(' ');   // mot coupé : pas d'espace
    }
    if (to < n) frag.append('…');
    el.context.append(frag);
  }

  function buildMarks() {
    el.barMarks.textContent = '';
    const n = state.words.length;
    if (n < 2) return;
    const frag = document.createDocumentFragment();
    let count = 0;
    for (let i = 1; i < n && count < 400; i++) {
      if (state.words[i - 1].p) {
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.style.left = (i / (n - 1)) * 100 + '%';
        frag.append(mark);
        count++;
      }
    }
    el.barMarks.append(frag);
  }

  function updateProgress() {
    const n = state.words.length;
    if (!n) {
      el.barFill.style.width = '0%';
      el.barThumb.style.left = '0%';
      el.pct.textContent = '0 %';
      el.pos.textContent = 'mot 0 / 0';
      el.remaining.textContent = 'reste 0:00';
      return;
    }
    const ratio = n > 1 ? state.index / (n - 1) : (state.finished ? 1 : 0);
    const pct = ratio * 100;
    el.barFill.style.width = pct + '%';
    el.barThumb.style.left = pct + '%';
    el.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    el.pct.textContent = Math.round(pct) + ' %';
    el.pos.textContent = `mot ${(state.index + 1).toLocaleString('fr-FR')} / ${n.toLocaleString('fr-FR')}`;
    if (voice.on) {
      // Temps restant dicté, ramené au mur par le facteur de vitesse de la voix.
      const left = Math.max(0, voiceTotal() - voice.pos) / voiceRate();
      el.remaining.textContent = 'reste ' + formatClock(left * 1000);
    } else {
      const left = state.finished ? 0 : (state.cum[n] - state.cum[state.index]) * baseMs();
      el.remaining.textContent = 'reste ' + formatClock(left);
    }
  }

  function setUiPlaying() {
    const label = state.playing ? 'Pause' : 'Lecture';
    el.reader.classList.toggle('is-playing', state.playing);
    el.iconPlay.toggleAttribute('hidden', state.playing);
    el.iconPause.toggleAttribute('hidden', !state.playing);
    el.btnPlay.setAttribute('aria-label', label);
    el.status.textContent = state.playing ? 'Lecture' : state.finished ? 'Terminé' : 'Pause';
  }

  /* ---------- Lecture (mode muet) ---------- */

  function duration(i) {
    return baseMs() * weightAt(i);
  }

  function step() {
    if (!state.playing) return;
    showWord(state.index);
    updateProgress();
    let d = duration(state.index);
    if (state.rampIdx < RAMP.length) d *= RAMP[state.rampIdx++];
    const now = performance.now();
    state.target += d;
    // Très en retard (onglet gelé, machine chargée) : on se recale au lieu de rafaler.
    if (now - state.target > 120) state.target = now;
    state.timer = setTimeout(next, Math.max(0, state.target - now));
  }

  function next() {
    if (!state.playing) return;
    if (state.index >= state.words.length - 1) { finish(); return; }
    state.index++;
    step();
  }

  function play() {
    if (voice.on) { voicePlay(); return; }
    if (state.playing || !state.words.length) return;
    if (state.finished) { state.index = 0; state.finished = false; }
    state.playing = true;
    state.rampIdx = 0;
    state.target = performance.now();
    setUiPlaying();
    renderContext();
    step();
  }

  function pause() {
    if (voice.on) { voicePause(); return; }
    if (!state.playing) return;
    state.playing = false;
    clearTimeout(state.timer);
    setUiPlaying();
    renderContext();
  }

  function finish() {
    state.playing = false;
    state.finished = true;
    clearTimeout(state.timer);
    setUiPlaying();
    updateProgress();
    renderContext();
  }

  function toggle() { if (state.playing) pause(); else play(); }

  function seek(i) {
    const n = state.words.length;
    if (!n) return;
    if (voice.on) { voiceSeekWord(i); return; }
    state.index = clamp(Math.round(i), 0, n - 1);
    state.finished = false;
    if (state.playing) {
      clearTimeout(state.timer);
      state.target = performance.now();
      state.rampIdx = 1;
      step();
    } else {
      showWord(state.index);
      updateProgress();
      setUiPlaying();
      renderContext();
    }
  }

  function skip(ms) {
    if (voice.on) { voiceSeekTime(voiceNow() + ms / 1000); return; }
    let i = state.index;
    let acc = 0;
    const last = state.words.length - 1;
    if (ms < 0) {
      while (i > 0 && acc < -ms) { i--; acc += duration(i); }
    } else {
      while (i < last && acc < ms) { acc += duration(i); i++; }
    }
    seek(i);
  }

  function restart() {
    if (voice.on) {
      voiceSeekWord(0);
      if (!voice.playing) voicePlay();
      return;
    }
    clearTimeout(state.timer);
    state.playing = false;
    state.index = 0;
    state.finished = false;
    play();
  }

  /* ---------- Vitesse ---------- */

  function setWpm(value, persist = true) {
    // En mode voix, la vitesse est un facteur appliqué à la dictée (×0,5–×2).
    const lo = voice.on ? VOICE_MIN_WPM : WPM_MIN;
    const hi = voice.on ? VOICE_MAX_WPM : WPM_MAX;
    const v = clamp(Math.round(Number(value) / 5) * 5, lo, hi);
    state.wpm = v;
    el.range.value = String(v);
    el.big.textContent = String(v);
    document.querySelectorAll('[data-wpm]').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.wpm) === v));
    });
    if (persist) store.set(STORE.wpm, String(v));
    updateRateDisplay();
    if (voice.on && voice.clock) {
      // Changement de vitesse à chaud : réancrage de l'horloge audio.
      voice.pos = voiceNow();
      voice.clock.t0 = voice.ctx.currentTime;
      voice.clock.anchorPos = voice.pos;
      voice.clock.rate = voiceRate();
      if (voice.src) voice.src.playbackRate.value = voice.clock.rate;
    }
    updateProgress();
    updateStats();
  }

  /* ---------- Saisie ---------- */

  const SAMPLE_TEXT = [
    'Longtemps, je me suis couché de bonne heure. Parfois, à peine ma bougie éteinte, mes yeux se fermaient si vite que je n\u2019avais pas le temps de me dire : \u00ab Je m\u2019endors. \u00bb',
    '',
    'Et, une demi-heure après, la pensée qu\u2019il était temps de chercher le sommeil m\u2019éveillait ; je voulais poser le volume que je croyais avoir encore entre les mains et souffler ma lumière.',
    '',
    'Je n\u2019avais pas cessé en dormant de faire des réflexions sur ce que je venais de lire ; mais ces réflexions avaient pris un tour un peu particulier.'
  ].join('\n\n');

  function updateStats() {
    const tok = getTokens(el.source.value);
    const n = tok.words.length;
    if (!n) {
      el.statWords.textContent = '0 mot';
      el.statTime.textContent = '—';
      return;
    }
    const weight = state.pauses ? tok.total : n;
    el.statWords.textContent = `${n.toLocaleString('fr-FR')} ${n > 1 ? 'mots' : 'mot'}`;
    el.statTime.textContent = `lecture ≈ ${formatHuman(weight * baseMs())}`;
  }

  let statsTimer = 0;
  function scheduleStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(updateStats, 160);
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function hideError() { el.error.hidden = true; }

  function showView(name) {
    el.editor.hidden = name !== 'editor';
    el.reader.hidden = name !== 'reader';
    window.scrollTo(0, 0);
  }

  function startReading() {
    const text = el.source.value;
    const tok = getTokens(text);
    if (!tok.words.length) {
      showError('Collez ou saisissez un texte avant de lancer la lecture.');
      el.source.focus();
      return;
    }
    hideError();
    if (state.loadedText !== text) {
      state.words = tok.words;
      state.loadedText = text;
      state.index = 0;
      state.finished = false;
      if (voice.on) prepareVoiceText(true);
    } else if (voice.on && !voice.segs.length) {
      prepareVoiceText(false);
    }
    rebuildCum();
    buildMarks();
    showView('reader');
    measure();
    if (voice.on) voice.pos = state.finished ? 0 : timeOfWord(state.index);
    showWord(state.index);
    updateProgress();
    setUiPlaying();
    el.reader.focus({ preventScroll: true });
    play();
  }

  function backToEditor() {
    pause();
    setVoiceStatus('');
    showView('editor');
    el.source.focus({ preventScroll: true });
  }

  /* ---------- Évènements ---------- */

  el.source.addEventListener('input', () => {
    hideError();
    store.set(STORE.text, el.source.value);
    scheduleStats();
  });

  el.source.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startReading(); }
  });

  el.btnSample.addEventListener('click', () => {
    if (el.source.value.trim() && el.source.value !== SAMPLE_TEXT
        && !window.confirm('Remplacer le texte actuel par l\u2019extrait d\u2019exemple ?')) return;
    el.source.value = SAMPLE_TEXT;
    store.set(STORE.text, SAMPLE_TEXT);
    hideError();
    updateStats();
    el.source.focus();
  });

  el.btnClear.addEventListener('click', () => {
    el.source.value = '';
    store.set(STORE.text, '');
    updateStats();
    el.source.focus();
  });

  el.btnStart.addEventListener('click', startReading);
  el.btnEdit.addEventListener('click', backToEditor);
  el.btnPlay.addEventListener('click', toggle);
  el.btnBack.addEventListener('click', () => skip(-SKIP_MS));
  el.btnFwd.addEventListener('click', () => skip(SKIP_MS));
  el.btnRestart.addEventListener('click', restart);

  // Après un clic souris, un bouton ne garde pas le focus : Espace reste « lecture / pause ».
  el.reader.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button && e.detail > 0) button.blur();
  });

  document.querySelectorAll('[data-wpm]').forEach((b) => {
    b.addEventListener('click', () => setWpm(b.dataset.wpm));
  });

  el.range.addEventListener('input', () => setWpm(el.range.value));
  el.range.addEventListener('pointerup', () => el.range.blur());

  el.pauses.addEventListener('change', () => {
    state.pauses = el.pauses.checked;
    store.set(STORE.pauses, state.pauses ? '1' : '0');
    rebuildCum();
    updateProgress();
    updateStats();
  });

  /* Dictée vocale : activation / désactivation, à chaud ou non. */
  el.optVoice.addEventListener('change', () => {
    const on = el.optVoice.checked;
    if (on === voice.on) return;
    store.set(STORE.voice, on ? '1' : '0');
    el.voiceSelect.disabled = !on;
    voice.on = on;
    setWpm(state.wpm);                      // recadre les bornes (150–600 en voix, 100–1200 sinon)
    if (on) {
      if (!el.reader.hidden && state.words.length && !voice.segs.length) prepareVoiceText(false);
      if (state.playing) {
        // Bascule à chaud depuis la lecture silencieuse : l'affichage attend
        // la voix au mot courant, puis la dictée prend la main.
        clearTimeout(state.timer);
        state.timer = 0;
        voice.pos = voice.segs.length ? timeOfWord(state.index) : 0;
        voice.playing = true;
        voice.pointer = segOfPos(voice.pos);
        setUiPlaying();
        if (!voice.raf) voice.raf = requestAnimationFrame(voiceFrame);
        if (!startSourceAt(voice.pos)) waitForSegment(voice.pointer);
      } else if (!el.reader.hidden && voice.segs.length) {
        voice.pos = timeOfWord(state.index);
        pump();
      } else {
        setVoiceStatus('');
      }
    } else {
      const wasPlaying = voice.playing;
      stopSource();
      voice.playing = false;
      voice.waiting = false;
      voice.waitSeg = null;
      if (voice.raf) { cancelAnimationFrame(voice.raf); voice.raf = 0; }
      setVoiceStatus('');
      setWpm(state.wpm);                    // rétablit l'affichage « mots / min » simple
      updateProgress();
      if (wasPlaying) {
        // Reprise silencieuse au mot courant.
        state.rampIdx = 1;
        state.target = performance.now();
        step();
      }
    }
  });

  /* Changement de voix : les audio déjà synthétisés correspondent à l'ancienne
     voix, on repart du mot courant avec la nouvelle. */
  el.voiceSelect.addEventListener('change', () => {
    const id = el.voiceSelect.value;
    if (!id || id === voice.id) return;
    voice.id = id;
    store.set(STORE.voiceId, id);
    const wasPlaying = voice.playing;
    stopSource();
    voice.playing = false;
    if (voice.raf) { cancelAnimationFrame(voice.raf); voice.raf = 0; }
    if (voice.segs.length) {
      prepareVoiceText(false);
      voice.pos = timeOfWord(state.index);
    }
    if (wasPlaying) voicePlay();
    else { pump(); updateProgress(); }
  });

  // Molette sur la scène : ±25 WPM par cran (cumul pour les pavés tactiles).
  let wheelAcc = 0;
  el.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY * (e.deltaMode === 1 ? 33 : 1);
    if (Math.abs(wheelAcc) >= 50) {
      const steps = Math.trunc(wheelAcc / 50);
      setWpm(state.wpm - steps * WPM_STEP);
      wheelAcc -= steps * 50;
    }
  }, { passive: false });

  // Clic sur un mot du contexte : on s'y replace.
  el.context.addEventListener('click', (e) => {
    const span = e.target.closest('span[data-i]');
    if (span) seek(Number(span.dataset.i));
  });

  // Barre de progression : clic et glissé.
  let dragging = false;
  const indexFromPointer = (e) => {
    const rect = el.bar.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    return ratio * (state.words.length - 1);
  };
  el.bar.addEventListener('pointerdown', (e) => {
    if (!state.words.length) return;
    dragging = true;
    el.bar.setPointerCapture(e.pointerId);
    seek(indexFromPointer(e));
  });
  el.bar.addEventListener('pointermove', (e) => { if (dragging) seek(indexFromPointer(e)); });
  const endDrag = () => { dragging = false; };
  el.bar.addEventListener('pointerup', endDrag);
  el.bar.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (el.reader.hidden) return;
    const target = e.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' && target.type === 'range' && e.key.startsWith('Arrow')) return;
    if (tag === 'INPUT' && target.type === 'checkbox' && e.key === ' ') return;
    if ((tag === 'BUTTON' || tag === 'A') && e.key === ' ') return;   // activation native
    if (tag === 'SELECT') return;                                    // la voix se règle au clavier
    switch (e.key) {
      case ' ': case 'Spacebar':
        e.preventDefault();
        if (!e.repeat) toggle();
        break;
      case 'ArrowLeft': e.preventDefault(); skip(-SKIP_MS); break;
      case 'ArrowRight': e.preventDefault(); skip(SKIP_MS); break;
      case 'ArrowUp': e.preventDefault(); setWpm(state.wpm + WPM_STEP); break;
      case 'ArrowDown': e.preventDefault(); setWpm(state.wpm - WPM_STEP); break;
      case 'Home': e.preventDefault(); seek(0); break;
      case 'End': e.preventDefault(); seek(state.words.length - 1); break;
      case 'r': case 'R': restart(); break;
      case 'Escape': backToEditor(); break;
      default: break;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (!el.reader.hidden && e.key === ' ') {
      const tag = e.target && e.target.tagName;
      if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT') e.preventDefault();
    }
  });

  // Onglet masqué : les minuteurs sont ralentis, on met en pause.
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  const onResize = () => {
    if (el.reader.hidden || el.stage.clientWidth === state.stageW) return;
    measure();
    if (state.words.length) showWord(state.index);
  };
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(el.stage);
  else window.addEventListener('resize', onResize);

  // La police monospace est chargée à la demande : on re-mesure quand elle arrive.
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load('500 64px "JetBrains Mono"'),
      document.fonts.load('700 64px "JetBrains Mono"')
    ]).then(() => {
      if (el.reader.hidden) return;
      measure();
      if (state.words.length) showWord(state.index);
    }).catch(() => {});
  }

  /* ---------- Démarrage ---------- */

  const savedText = store.get(STORE.text);
  if (savedText && savedText.trim()) el.source.value = savedText;
  state.pauses = store.get(STORE.pauses) !== '0';
  el.pauses.checked = state.pauses;

  // Voix : options peuplées, choix persisté.
  for (const v of VOICES) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    el.voiceSelect.append(opt);
  }
  const savedVoiceId = store.get(STORE.voiceId);
  if (savedVoiceId && VOICES.some((v) => v.id === savedVoiceId)) voice.id = savedVoiceId;
  el.voiceSelect.value = voice.id;
  voice.on = store.get(STORE.voice) === '1';
  el.optVoice.checked = voice.on;
  el.voiceSelect.disabled = !voice.on;

  const savedWpm = Number(store.get(STORE.wpm));
  setWpm(savedWpm >= WPM_MIN && savedWpm <= WPM_MAX ? savedWpm : 300, false);
  updateStats();
  setUiPlaying();
})();

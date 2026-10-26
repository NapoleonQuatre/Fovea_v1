/* ==========================================================================
   Fovea — lecteur RSVP (JavaScript vanilla, aucune dépendance)

   1. Cœur pur : tokenisation, poids de pause, calcul de l'ORP, mise à l'échelle.
      Ces fonctions n'utilisent pas le DOM (elles sont testées sous Node).
   2. Interface : lecture, contrôles, progression, clavier, molette.
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

  /* ---- Voix : découpage du texte en phrases à dicter ----
     Chaque morceau est dicté d'un seul souffle (intonation naturelle). On garde,
     pour chaque mot affiché, sa position (offset) dans le texte dicté : c'est
     ce qui relie ce que la voix prononce à ce que l'écran affiche. */
  const VOICE_MIN_WORDS = 6;      // phrases plus longues : l'intonation d'une voix neuronale y est meilleure
  const VOICE_COMMA_WORDS = 14;
  const VOICE_MAX_WORDS = 26;

  const VOICE_LIMITS = { min: VOICE_MIN_WORDS, comma: VOICE_COMMA_WORDS, max: VOICE_MAX_WORDS };

  function voiceChunk(words, start, limits = VOICE_LIMITS) {
    let text = '';
    const offsets = [];
    let end = start;
    for (let i = start; i < words.length; i++) {
      const w = words[i];
      if (i > start && !w.j) text += ' ';
      offsets.push(text.length);
      text += w.t;
      end = i;
      const next = words[i + 1];
      if (next && next.j) continue;                    // jamais au milieu d'un mot coupé
      const count = i - start + 1;
      const bare = w.t.replace(CLOSERS, '');
      if (w.p) break;
      if (count >= limits.min && /[.!?…;:]$/.test(bare)) break;
      if (count >= limits.comma && /[,–—]$/.test(bare)) break;
      if (count >= limits.max) break;
    }
    return { start, end, text, offsets };
  }

  /* Heure de début (en secondes) de chaque mot, d'après l'alignement par
     caractère renvoyé par ElevenLabs. Si le nombre de caractères alignés
     diffère du texte envoyé (normalisation), on se rabat sur une position
     proportionnelle. Le résultat est toujours croissant. */
  function wordTimes(offsets, textLen, starts) {
    const n = starts ? starts.length : 0;
    if (!n) return offsets.map(() => 0);
    const out = [];
    let prev = 0;
    for (const o of offsets) {
      const idx = n === textLen ? o : Math.min(n - 1, Math.round((o / Math.max(1, textLen)) * n));
      const t = Math.max(prev, Number(starts[idx]) || 0);
      out.push(t);
      prev = t;
    }
    return out;
  }

  /* Indice du mot qui contient la position `pos` (plus grand offset <= pos). */
  function locateOffset(offsets, pos) {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /* ---- Voix neuronales : placer chaque mot dans l'enregistrement ----
     Les moteurs Piper et MeloTTS renvoient un enregistrement, pas des évènements
     « mot ». On retrouve donc la position de chaque mot dans l'audio :
       1. on mesure l'énergie du signal pour trouver le début et la fin de la parole
          et les silences intérieurs (virgules, respirations) ;
       2. on pèse chaque mot (syllabes, lettres) et on estime où il tombe ;
       3. chaque silence réel est rattaché à la frontière de mots la plus proche
          (de préférence une ponctuation) : ces silences servent d'ancres exactes ;
       4. entre deux ancres, les mots sont répartis selon leur poids.
     L'écran suit ensuite l'horloge audio : aucune dérive ne s'accumule. */

  const VOWELS = 'aeiouyàâäéèêëîïôöùûüÿœæ';
  const ALIGN_HOP = 0.01;             // pas d'analyse : 10 ms
  const ALIGN_WIN = 0.025;            // fenêtre : 25 ms
  const ALIGN_MIN_PAUSE = 0.09;       // silence minimal retenu comme pause : 90 ms

  function syllableCount(word) {
    const w = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!w) return 1;
    if (/^\p{N}+$/u.test(w)) return Math.max(1, w.length * 0.9);       // nombres : lus chiffre à chiffre ou en groupes
    let count = 0;
    let inVowel = false;
    for (const ch of w) {
      const v = VOWELS.includes(ch);
      if (v && !inVowel) count++;
      inVowel = v;
    }
    // « e » muet final (table, tables, parlent) : pas de syllabe en plus
    if (count > 1 && /[^aeiouyàâäéèêëîïôöùûüÿœæ](e|es|ent)$/.test(w)) count--;
    return Math.max(1, count);
  }

  function wordWeight(word) {
    const letters = Array.from(word.replace(/[^\p{L}\p{N}]/gu, '')).length;
    return 0.9 * syllableCount(word) + 0.1 * letters + 0.25;
  }

  /* Poids d'une pause attendue après ce mot, d'après sa ponctuation finale. */
  function pauseWeight(word) {
    const bare = word.replace(CLOSERS, '');
    if (SENTENCE_END.test(bare)) return 1.6;
    if (/[;:]$/.test(bare)) return 1.1;
    if (/[,–—]$/.test(bare)) return 0.9;
    return 0;
  }

  function frameRms(samples, sr) {
    const hop = Math.max(1, Math.round(sr * ALIGN_HOP));
    const win = Math.max(hop, Math.round(sr * ALIGN_WIN));
    const frames = Math.max(0, Math.floor((samples.length - win) / hop) + 1);
    const rms = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const from = f * hop;
      for (let i = from; i < from + win; i++) sum += samples[i] * samples[i];
      rms[f] = Math.sqrt(sum / win);
    }
    return { rms, hop, win };
  }

  /* Début/fin de la parole et silences intérieurs d'un enregistrement. Temps en secondes. */
  function analyzeSpeech(samples, sr) {
    const { rms, hop, win } = frameRms(samples, sr);
    const total = samples.length / sr;
    if (!rms.length) return { start: 0, end: total, pauses: [], total };
    let peak = 0;
    for (const v of rms) if (v > peak) peak = v;
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)];
    const thr = Math.max(peak * 0.04, floor * 2.5, 1e-4);
    const at = (f) => (f * hop + win / 2) / sr;                 // centre de la trame
    let first = 0;
    while (first < rms.length && rms[first] <= thr) first++;
    let last = rms.length - 1;
    while (last > first && rms[last] <= thr) last--;
    if (first >= rms.length) return { start: 0, end: total, pauses: [], total };
    const pauses = [];
    let f = first;
    while (f <= last) {
      if (rms[f] > thr) { f++; continue; }
      let g = f;
      while (g <= last && rms[g] <= thr) g++;
      const s = at(f - 1) + hop / sr / 2;
      const e = at(g) - hop / sr / 2;
      if (e - s >= ALIGN_MIN_PAUSE) pauses.push({ s, e, c: (s + e) / 2 });
      f = g;
    }
    return {
      start: Math.max(0, at(first) - 0.03),
      end: Math.min(total, at(last) + 0.03),
      pauses,
      total
    };
  }

  /* Instant de début de chaque mot, en secondes depuis le début de l'enregistrement.
     `words` : textes affichés ; `info` : résultat de analyzeSpeech. */
  function alignWords(words, info) {
    const n = words.length;
    const starts = new Array(n).fill(info.start);
    if (n < 2) return starts;
    const dur = Math.max(0.05, info.end - info.start);
    const w = words.map(wordWeight);
    const p = words.map((t, i) => (i < n - 1 ? pauseWeight(t) : 0));

    // 1. position estimée du milieu de chaque frontière (après le mot i)
    let total = 0;
    for (let i = 0; i < n; i++) total += w[i] + p[i];
    const mid = new Array(n - 1);
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      acc += w[i];
      mid[i] = info.start + ((acc + p[i] / 2) / total) * dur;
      acc += p[i];
    }

    // 2. rattacher chaque silence réel à une frontière, dans l'ordre
    const matched = [];                                   // { b: frontière, pause }
    let lastB = -1;
    const tol = 0.22 * dur + 0.15;
    for (const pause of info.pauses) {
      let best = -1;
      let bestCost = Infinity;
      for (let b = lastB + 1; b < n - 1; b++) {
        const d = Math.abs(mid[b] - pause.c);
        if (d > tol) { if (mid[b] > pause.c) break; continue; }
        const cost = d / dur + (p[b] > 0 ? 0 : 0.06);
        if (cost < bestCost) { bestCost = cost; best = b; }
      }
      if (best >= 0) { matched.push({ b: best, pause }); lastB = best; }
    }

    // 3. répartir les mots entre ancres selon leur poids
    let segFirst = 0;
    let segStart = info.start;
    for (let m = 0; m <= matched.length; m++) {
      const lastWord = m < matched.length ? matched[m].b : n - 1;
      const segEnd = m < matched.length ? matched[m].pause.s : info.end;
      let sum = 0;
      for (let i = segFirst; i <= lastWord; i++) sum += w[i] + (i < lastWord ? p[i] : 0);
      const span = Math.max(0.02, segEnd - segStart);
      let cum = 0;
      for (let i = segFirst; i <= lastWord; i++) {
        starts[i] = segStart + (cum / sum) * span;
        cum += w[i] + (i < lastWord ? p[i] : 0);
      }
      if (m < matched.length) { segFirst = lastWord + 1; segStart = matched[m].pause.e; }
    }
    for (let i = 1; i < n; i++) if (starts[i] < starts[i - 1]) starts[i] = starts[i - 1];
    return starts;
  }

  /* Indice du dernier mot dont l'instant de début est <= t. */
  function wordAtTime(starts, t) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /* ---- Audio : lecture et écriture de fichiers WAV, préparation d'un clip ---- */

  /* WAV (PCM 8/16/24/32 bits ou flottant 32 bits, mono ou stéréo) -> { samples (mono, -1..1), sr }. */
  function parseWav(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 44 || dv.getUint32(0) !== 0x52494646 || dv.getUint32(8) !== 0x57415645) return null;
    let pos = 12;
    let fmt = null;
    let data = null;
    while (pos + 8 <= dv.byteLength) {
      const id = dv.getUint32(pos);
      const size = dv.getUint32(pos + 4, true);
      if (id === 0x666d7420) {
        fmt = { tag: dv.getUint16(pos + 8, true), ch: dv.getUint16(pos + 10, true), sr: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
        if (fmt.tag === 0xfffe && size >= 40) fmt.tag = dv.getUint16(pos + 32, true);   // format étendu : le vrai code est dans le sous-format
      } else if (id === 0x64617461) {
        data = { off: pos + 8, size: Math.min(size, dv.byteLength - pos - 8) };
        break;
      }
      pos += 8 + size + (size & 1);
    }
    if (!fmt || !data || !fmt.ch || !fmt.bits) return null;
    const bytes = fmt.bits / 8;
    const frames = Math.floor(data.size / (bytes * fmt.ch));
    const samples = new Float32Array(frames);
    const isFloat = fmt.tag === 3;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < fmt.ch; c++) {
        const o = data.off + (i * fmt.ch + c) * bytes;
        let v;
        if (isFloat && fmt.bits === 32) v = dv.getFloat32(o, true);
        else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
        else if (fmt.bits === 24) v = ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608);
        else if (fmt.bits === 32) v = dv.getInt32(o, true) / 2147483648;
        else if (fmt.bits === 8) v = (dv.getUint8(o) - 128) / 128;
        else return null;
        sum += v;
      }
      samples[i] = sum / fmt.ch;
    }
    return { samples, sr: fmt.sr };
  }

  /* Échantillons (-1..1) -> fichier WAV PCM 16 bits mono. */
  function encodeWav(samples, sr) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    return buf;
  }

  /* Même niveau sonore d'une phrase à l'autre : le pic est ramené à `target`. */
  function normalizePeak(samples, target) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    const gain = target / Math.max(peak, 0.05);
    if (gain !== 1) for (let i = 0; i < samples.length; i++) samples[i] *= gain;
    return samples;
  }

  const CLIP_PAD = { stop: 0.32, clause: 0.16, none: 0.04, paragraph: 0.28 };

  /* Un enregistrement + le texte de la phrase -> clip prêt à jouer :
     silences de début et de fin retirés, pause finale choisie d'après la ponctuation
     (elle est la même quelle que soit la voix), et début de chaque mot dans le clip. */
  function prepareClip(wordTexts, lastIsParagraphEnd, samples, sr) {
    const info = analyzeSpeech(samples, sr);
    const starts = alignWords(wordTexts, info);
    const from = Math.max(0, info.start - 0.04);
    const to = Math.min(info.total, info.end + 0.04);
    const last = wordTexts[wordTexts.length - 1] || '';
    const bare = last.replace(CLOSERS, '');
    let pad = SENTENCE_END.test(bare) ? CLIP_PAD.stop : /[;:,–—]$/.test(bare) ? CLIP_PAD.clause : CLIP_PAD.none;
    if (lastIsParagraphEnd) pad += CLIP_PAD.paragraph;
    const a = Math.round(from * sr);
    const b = Math.max(a + 1, Math.round(to * sr));
    const out = new Float32Array(b - a + Math.round(pad * sr));
    out.set(samples.subarray(a, Math.min(b, samples.length)), 0);
    const fade = Math.min(Math.round(0.006 * sr), Math.floor((b - a) / 4));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      out[i] *= g;
      out[b - a - 1 - i] *= g;
    }
    return {
      wav: encodeWav(out, sr),
      wordT: starts.map((t) => Math.max(0, t - from)),
      dur: out.length / sr
    };
  }

  /* ---- Voix neuronales : calage des mots sur l'audio ----
     Un moteur comme Piper ou MeloTTS rend un fichier audio par phrase, sans dire
     quand chaque mot est prononcé. On le retrouve en deux temps :
       1. on mesure l'audio : début et fin réels de la parole, et les silences
          à l'intérieur (virgules, points) ;
       2. on répartit les mots entre ces repères au prorata de leur durée
          probable (nombre de phonèmes), puis on recale sur chaque silence
          détecté qui correspond à une ponctuation du texte.
     La précision vient donc de l'audio lui-même, pas d'une estimation de débit. */

  const PAUSE_UNITS = { strong: 5, medium: 3.5, weak: 2.5 };
  const MIN_PAUSE_S = 0.11;       // en dessous, c'est une occlusive (p, t, k), pas une pause
  const SPEECH_PAD_S = 0.012;

  /* Type de pause après un mot, d'après sa ponctuation. */
  function boundaryKind(token) {
    const t = String(token).replace(CLOSERS, '');
    if (/(\.{2,}|…|[.!?])$/.test(t)) return 'strong';
    if (/[;:]$/.test(t)) return 'medium';
    if (/[,–—]$/.test(t)) return 'weak';
    return null;
  }

  /* Début et fin de la parole, et silences internes (en secondes). */
  function analyzeAudio(pcm, sampleRate) {
    const hop = Math.max(1, Math.round(sampleRate * 0.01));
    const nFrames = Math.floor(pcm.length / hop);
    const duration = pcm.length / sampleRate;
    if (nFrames < 3) return { duration, start: 0, end: duration, pauses: [], threshold: 0 };
    const rms = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let sum = 0;
      for (let i = f * hop, e = i + hop; i < e; i++) sum += pcm[i] * pcm[i];
      rms[f] = Math.sqrt(sum / hop);
    }
    const sorted = Float32Array.from(rms).sort();
    const peak = sorted[Math.floor(0.97 * (nFrames - 1))];
    const floor = sorted[Math.floor(0.1 * (nFrames - 1))];
    const threshold = Math.max(peak * 0.05, floor * 3, 1e-4);
    const frameS = hop / sampleRate;
    let first = 0;
    while (first < nFrames && rms[first] < threshold) first++;
    let last = nFrames - 1;
    while (last > first && rms[last] < threshold) last--;
    if (first >= nFrames) return { duration, start: 0, end: duration, pauses: [], threshold };
    const pauses = [];
    const minFrames = Math.ceil(MIN_PAUSE_S / frameS);
    let run = -1;
    for (let f = first; f <= last + 1; f++) {
      const quiet = f <= last && rms[f] < threshold;
      if (quiet && run < 0) run = f;
      if (!quiet && run >= 0) {
        if (f - run >= minFrames) pauses.push({ t0: run * frameS, t1: f * frameS });
        run = -1;
      }
    }
    return {
      duration,
      start: Math.max(0, first * frameS - SPEECH_PAD_S),
      end: Math.min(duration, (last + 1) * frameS + SPEECH_PAD_S),
      pauses,
      threshold
    };
  }

  /* Instant de début de chaque mot dans l'audio (secondes).
     tokens : mots tels qu'affichés ; weights : durée relative de chaque mot. */
  function alignWords(tokens, weights, an) {
    const n = tokens.length;
    const start = an.start;
    const end = Math.max(an.end, start + 0.05);
    if (!n) return [];
    if (n === 1) return [start];
    const kinds = tokens.map(boundaryKind);
    const uStart = new Array(n);
    const uEnd = new Array(n);
    let u = 0;
    for (let i = 0; i < n; i++) {
      uStart[i] = u;
      u += Math.max(0.5, weights[i] || 1);
      uEnd[i] = u;
      if (i < n - 1 && kinds[i]) u += PAUSE_UNITS[kinds[i]];
    }
    const U = uEnd[n - 1];
    const dur = end - start;
    const est = (x) => start + (x / U) * dur;
    const centre = (i) => est(uEnd[i] + PAUSE_UNITS[kinds[i]] / 2);

    // Frontières où une pause est attendue (ponctuation) ; on les apparie, dans l'ordre,
    // aux silences réellement mesurés.
    const cand = [];
    for (let i = 0; i < n - 1; i++) if (kinds[i]) cand.push(i);
    const tol = Math.max(0.3, dur * 0.18);
    const matches = [];
    let ci = 0;
    for (const p of an.pauses || []) {
      if (p.t1 > end || p.t0 < start) continue;
      const pc = (p.t0 + p.t1) / 2;
      while (ci < cand.length && centre(cand[ci]) < pc - tol) ci++;
      let best = -1;
      let bestD = Infinity;
      for (let j = ci; j < cand.length && centre(cand[j]) <= pc + tol; j++) {
        const d = Math.abs(centre(cand[j]) - pc);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) {
        matches.push({ i: cand[best], t0: p.t0, t1: p.t1 });
        ci = best + 1;
      }
    }

    // Segments entre silences appariés : répartition proportionnelle dans chacun.
    const starts = new Array(n);
    let a = 0;
    for (let m = 0; m <= matches.length; m++) {
      const b = m < matches.length ? matches[m].i : n - 1;
      const T0 = m === 0 ? start : matches[m - 1].t1;
      const T1 = m < matches.length ? matches[m].t0 : end;
      const span = uEnd[b] - uStart[a];
      for (let k = a; k <= b; k++) {
        starts[k] = T1 > T0 && span > 0 ? T0 + ((uStart[k] - uStart[a]) / span) * (T1 - T0) : est(uStart[k]);
      }
      a = b + 1;
    }
    for (let i = 1; i < n; i++) if (starts[i] < starts[i - 1]) starts[i] = starts[i - 1];
    return starts;
  }

  /* Poids d'un mot quand on n'a pas de phonétique : ses lettres, à peu près un son chacune. */
  function letterWeight(token) {
    const letters = Array.from(String(token).replace(/[^\p{L}\p{N}]/gu, '')).length;
    return Math.max(1, letters * 0.8);
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

  const Core = { orpIndex, splitWord, weightOf, isAbbreviation, expandToken, tokenize, fitFontSize, voiceChunk, wordTimes, locateOffset, syllableCount, wordWeight, pauseWeight, analyzeSpeech, alignWords, wordAtTime, parseWav, encodeWav, normalizePeak, prepareClip, formatClock, formatHuman };
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
    voice: 'fovea.voice', voiceUri: 'fovea.voiceUri',
    engine: 'fovea.engine', elKey: 'fovea.elKey', elVoice: 'fovea.elVoice', elCustom: 'fovea.elCustom',
    piperVoice: 'fovea.piperVoice', piperSpeaker: 'fovea.piperSpeaker', meloUrl: 'fovea.meloUrl'
  };
  const VOICE_WPM_AT_RATE_1 = 170;      // débit moyen d'une voix à vitesse 1
  const VOICE_RATE_MIN = 0.5;
  const VOICE_RATE_MAX = 3;
  const VOICE_ESTIMATE_AFTER_MS = 350;  // sans évènement « mot » au bout de ce délai : mode estimé
  const NATURAL_SCORE = 90;             // à partir de cette note, une voix est classée « naturelle »
  const STORE_NO_EVENTS = 'fovea.voiceNoEvents';

  const $ = (id) => document.getElementById(id);
  const el = {
    editor: $('editor'), reader: $('reader'),
    source: $('source'), error: $('editor-error'),
    statWords: $('stat-words'), statTime: $('stat-time'),
    btnClear: $('btn-clear'), btnStart: $('btn-start'),
    btnEdit: $('btn-edit'), status: $('status'),
    stage: $('stage'), word: $('word'),
    before: $('w-before'), pivot: $('w-pivot'), after: $('w-after'), probe: $('probe'),
    context: $('context'),
    bar: $('bar'), barFill: $('bar-fill'), barThumb: $('bar-thumb'), barMarks: $('bar-marks'),
    pct: $('pct'), pos: $('pos'), remaining: $('remaining'),
    btnPlay: $('btn-play'), iconPlay: $('icon-play'), iconPause: $('icon-pause'),
    btnBack: $('btn-back'), btnFwd: $('btn-fwd'), btnRestart: $('btn-restart'),
    range: $('wpm-range'), big: $('wpm-big'), pauses: $('opt-pauses'),
    voiceOn: $('opt-voice'), voiceBox: $('voice-box'), voiceSelect: $('voice-select'), voiceNote: $('voice-note'),
    engine: $('engine-select'), panelBrowser: $('panel-browser'), panelEleven: $('panel-eleven'),
    elKey: $('el-key'), elVoice: $('el-voice'), elCustom: $('el-custom'), elRefresh: $('el-refresh'),
    panelPiper: $('panel-piper'), piperVoice: $('piper-voice'), piperSpeakerBox: $('piper-speaker-box'), piperSpeaker: $('piper-speaker'),
    piperProgress: $('piper-progress'), panelMelo: $('panel-melo'), meloUrl: $('melo-url'), meloTest: $('melo-test')
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

  /* ---------- Jetons (avec cache sur le texte) ---------- */

  let cache = { text: null, tok: null };
  function getTokens(text) {
    if (cache.text !== text) cache = { text, tok: tokenize(text) };
    return cache.tok;
  }

  const weightAt = (i) => (state.pauses ? state.words[i].w : 1);
  const voice = {
    supported: typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    on: false,
    engine: 'piper',     // 'piper', 'melo', 'eleven' (ElevenLabs) ou 'browser' (voix du navigateur)
    list: [],
    uri: '',
    gen: 0,              // change à chaque arrêt : les évènements d'une ancienne dictée sont ignorés
    cur: null,           // morceau en cours de dictée
    nextStart: -1,       // premier mot du prochain morceau à mettre en file
    keep: [],            // références aux utterances (sinon certains navigateurs les perdent)
    tick: 0,
    restart: 0,
    cps1: 15,            // caractères dictés par seconde à vitesse 1 (affiné à chaque phrase)
    rate: 1,
    effWpm: 0,           // débit réel mesuré de la voix
    noEvents: false,     // la voix ne signale pas les mots
    lastRate: 0,
    watch: 0,
    problem: '',
    best: 0,             // note de la meilleure voix française détectée
    noEventsIds: new Set()   // voix déjà observées sans évènements « mot »
  };
  try {
    JSON.parse(localStorage.getItem('fovea.voiceNoEvents') || '[]').forEach((id) => voice.noEventsIds.add(id));
  } catch (e) { /* stockage indisponible */ }

  const speechWpm = () => voice.effWpm || Math.min(state.wpm, VOICE_WPM_AT_RATE_1 * VOICE_RATE_MAX);
  const baseMs = () => 60000 / (voice.on ? speechWpm() : state.wpm);

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
    const left = state.finished ? 0 : (state.cum[n] - state.cum[state.index]) * baseMs();
    el.remaining.textContent = 'reste ' + formatClock(left);
  }

  function setUiPlaying() {
    const label = state.playing ? 'Pause' : 'Lecture';
    el.reader.classList.toggle('is-playing', state.playing);
    el.iconPlay.toggleAttribute('hidden', state.playing);
    el.iconPause.toggleAttribute('hidden', !state.playing);
    el.btnPlay.setAttribute('aria-label', label);
    el.status.textContent = state.playing ? 'Lecture' : state.finished ? 'Terminé' : 'Pause';
  }

  /* ---------- Lecture ---------- */

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
    if (state.playing || !state.words.length) return;
    if (state.finished) { state.index = 0; state.finished = false; }
    state.playing = true;
    voice.problem = '';
    setUiPlaying();
    renderContext();
    if (voice.on) {
      if (!elevenResume()) voiceStart(state.index);   // ElevenLabs : reprise sans redemander l'audio
    } else {
      state.rampIdx = 0;
      state.target = performance.now();
      step();
    }
    updateVoiceNote();
  }

  function pause() {
    if (!state.playing) return;
    state.playing = false;
    clearTimeout(state.timer);
    if (!elevenPause()) voiceCancel();
    setUiPlaying();
    renderContext();
  }

  function finish() {
    state.playing = false;
    state.finished = true;
    clearTimeout(state.timer);
    voiceCancel();
    setUiPlaying();
    updateProgress();
    renderContext();
  }

  function toggle() { if (state.playing) pause(); else play(); }

  function seek(i) {
    const n = state.words.length;
    if (!n) return;
    state.index = clamp(Math.round(i), 0, n - 1);
    state.finished = false;
    if (state.playing) {
      clearTimeout(state.timer);
      if (voice.on) {
        voiceStart(state.index);
      } else {
        state.target = performance.now();
        state.rampIdx = 1;
        step();
      }
    } else {
      showWord(state.index);
      updateProgress();
      setUiPlaying();
      renderContext();
    }
  }

  function skip(ms) {
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
    clearTimeout(state.timer);
    voiceCancel();
    state.playing = false;
    state.index = 0;
    state.finished = false;
    play();
  }

  /* ---------- Voix ----------
     Principe : quand la voix est active, c'est elle qui fait avancer l'affichage.
     Le texte est dicté par phrases. Chaque évènement « mot » du moteur vocal
     (onboundary) affiche le mot prononcé à cet instant. Les voix qui n'émettent
     pas ces évènements (certaines voix en ligne) passent en mode estimé : la
     position est calculée à partir du débit mesuré, et recalée au début et à
     la fin de chaque phrase. */

  // Voix enregistrées (Piper, MeloTTS, ElevenLabs) : la lecture est accélérée ou ralentie à partir du débit mesuré.
  const isClip = () => voice.engine !== 'browser';
  const rateBase = () => (isClip() ? clamp(eleven.wpm1, 90, 260) : VOICE_WPM_AT_RATE_1);
  const voiceRate = () => clamp(state.wpm / rateBase(), VOICE_RATE_MIN, VOICE_RATE_MAX);
  const voiceId = (v) => v.voiceURI || v.name;
  const pickVoice = () => voice.list.find((v) => voiceId(v) === voice.uri) || null;

  function setIndex(i) {
    if (i === state.index) return;
    state.index = i;
    showWord(i);
    updateProgress();
  }

  function voiceCancel() {
    elevenKill();
    voice.gen++;
    clearTimeout(voice.restart);
    clearTimeout(voice.watch);
    clearInterval(voice.tick);
    voice.tick = 0;
    voice.cur = null;
    voice.keep = [];
    voice.nextStart = -1;
    if (voice.supported) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignoré */ }
    }
  }

  // Si la voix ne démarre pas (son bloqué, moteur absent), on le dit au lieu de rester figé.
  function voiceWatch() {
    clearTimeout(voice.watch);
    const gen = voice.gen;
    voice.watch = setTimeout(() => {
      if (gen !== voice.gen || !state.playing) return;
      voice.problem = 'La voix ne répond pas. Choisissez une autre voix ou vérifiez le son.';
      pause();
      updateVoiceNote();
    }, 5000);
  }

  function voiceQueue(start) {
    const n = state.words.length;
    if (start >= n) return;
    const gen = voice.gen;
    const chunk = voiceChunk(state.words, start);
    const u = new window.SpeechSynthesisUtterance(chunk.text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = document.documentElement.lang || 'fr-FR'; }
    u.rate = voice.rate;
    const info = { chunk, u, rate: voice.rate, startT: 0, mode: 'wait', anchorT: 0, anchorChar: 0 };

    u.onstart = () => {
      if (gen !== voice.gen) return;
      clearTimeout(voice.watch);
      info.startT = performance.now();
      info.anchorT = info.startT;
      voice.cur = info;
      setIndex(chunk.start);
      if (voice.nextStart === chunk.end + 1) voiceQueue(voice.nextStart);   // phrase suivante en avance : pas de trou
    };

    u.onboundary = (e) => {
      if (gen !== voice.gen || voice.cur !== info) return;
      if (e.name && e.name !== 'word') return;
      const k = locateOffset(chunk.offsets, e.charIndex || 0);
      info.mode = 'boundary';
      info.anchorT = performance.now();
      info.anchorChar = chunk.offsets[k];
      if (voice.noEvents) { voice.noEvents = false; updateVoiceNote(); }
      setIndex(chunk.start + k);
    };

    u.onend = () => {
      if (gen !== voice.gen) return;
      const secs = (performance.now() - info.startT) / 1000;
      if (voice.cur === info && secs > 0.4 && chunk.text.length > 8) {
        const cps1 = chunk.text.length / secs / info.rate;
        voice.cps1 = voice.cps1 * 0.5 + cps1 * 0.5;
        const wpm = ((chunk.end - chunk.start + 1) / secs) * 60;
        voice.effWpm = voice.effWpm ? voice.effWpm * 0.6 + wpm * 0.4 : wpm;
      }
      // Recalage : le dernier mot de la phrase est affiché à la fin. Si la phrase suivante
      // a déjà démarré (certains moteurs inversent l'ordre des évènements), on ne revient pas en arrière.
      if (voice.cur === info || !voice.cur) {
        voice.cur = null;
        setIndex(chunk.end);
      }
      if (chunk.end >= n - 1) { finish(); return; }
      voiceWatch();
      updateVoiceNote();
    };

    u.onerror = (e) => {
      if (gen !== voice.gen) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      voice.problem = `La voix a rencontré une erreur (${e.error || 'inconnue'}).`;
      pause();
      updateVoiceNote();
    };

    voice.keep.push(u);
    if (voice.keep.length > 4) voice.keep.shift();
    voice.nextStart = chunk.end + 1;
    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      voice.problem = 'La voix n’a pas pu démarrer sur ce navigateur.';
      pause();
      updateVoiceNote();
    }
  }

  function voiceTick() {
    const info = voice.cur;
    if (!info || !state.playing) return;
    const now = performance.now();
    if (info.mode === 'wait' && now - info.startT > VOICE_ESTIMATE_AFTER_MS) {
      info.mode = 'estimate';
      info.anchorT = info.startT;
      info.anchorChar = 0;
      if (!voice.noEvents) {
        voice.noEvents = true;
        if (!voice.noEventsIds.has(voice.uri)) {
          voice.noEventsIds.add(voice.uri);
          store.set(STORE_NO_EVENTS, JSON.stringify([...voice.noEventsIds]));
          loadVoices();                       // met à jour l'étiquette « synchro estimée » de la liste
        }
        updateVoiceNote();
      }
    }
    if (info.mode === 'wait') return;
    const { chunk } = info;
    const last = chunk.offsets.length - 1;
    const pos = info.anchorChar + ((now - info.anchorT) / 1000) * voice.cps1 * info.rate;
    const cur = clamp(state.index - chunk.start, 0, last);
    let k = locateOffset(chunk.offsets, pos);
    if (info.mode === 'boundary') {
      // Le moteur donne le début de chaque mot ; on n'avance seul que dans un mot coupé en morceaux.
      let g = cur;
      while (g < last && state.words[chunk.start + g + 1].j) g++;
      k = Math.min(k, g);
    } else {
      k = Math.min(k, Math.max(0, last - 1));   // le dernier mot n'apparaît qu'à la fin réelle de la phrase
    }
    setIndex(chunk.start + Math.max(k, cur));
  }

  function voiceStart(from) {
    if (isClip()) elevenStart(from);        // session de clips audio : Piper, MeloTTS ou ElevenLabs
    else browserStart(from);
  }

  function browserStart(from) {
    voiceCancel();
    voice.rate = voiceRate();
    if (voice.lastRate && voice.lastRate !== voice.rate && voice.effWpm) voice.effWpm *= voice.rate / voice.lastRate;
    voice.lastRate = voice.rate;
    state.index = clamp(from, 0, state.words.length - 1);
    showWord(state.index);
    updateProgress();
    const gen = voice.gen;
    try { window.speechSynthesis.resume(); } catch (e) { /* ignoré */ }
    // Petit délai après cancel() : certains navigateurs ignorent un speak() immédiat.
    setTimeout(() => { if (gen === voice.gen) voiceQueue(state.index); }, 60);
    voice.tick = setInterval(voiceTick, 40);
    voiceWatch();
  }

  function scheduleVoiceRestart() {
    clearTimeout(voice.restart);
    voice.restart = setTimeout(() => {
      if (state.playing && voice.on) voiceStart(state.index);
    }, 300);
  }

  function updateVoiceNote() {
    const parts = [];
    if (voice.problem) parts.push(voice.problem);
    if (voice.on && voice.engine === 'eleven') {
      if (!eleven.key) parts.push('Saisissez votre clé API ElevenLabs pour utiliser ces voix.');
      else if (eleven.listError && eleven.listError !== voice.problem) parts.push(eleven.listError);
      else if (eleven.loading) parts.push('Recherche des voix de votre compte…');
      const s = eleven.session;
      if (s && state.playing && !s.paused && !s.active) parts.push('Génération de la voix…');
    } else if (voice.on) {
      if (!voice.supported) {
        parts.push('La voix du navigateur n’est pas disponible ici.');
      } else {
        if (!voice.list.length) parts.push('Aucune voix détectée sur cet appareil.');
        if (voice.noEvents) parts.push('Cette voix ne signale pas chaque mot : l’affichage se recale à chaque phrase. Pour une synchro exacte, choisissez une voix locale ou « Natural ».');
        if (voice.list.length && voice.best < NATURAL_SCORE) {
          parts.push('Aucune voix naturelle détectée. Sous Edge, les voix « Online (Natural) » sont très naturelles ; sous macOS et iOS, ajoutez une voix Premium (Réglages › Accessibilité › Contenu énoncé) ; sous Android, installez la voix Google française.');
        }
      }
    }
    if (voice.on) {
      const cap = Math.round((rateBase() * VOICE_RATE_MAX) / 10) * 10;
      if (state.wpm > cap) parts.push(`La voix plafonne autour de ${cap} mots/min.`);
      if (voice.effWpm) parts.push(`Débit réel de la voix : environ ${Math.round(voice.effWpm / 5) * 5} mots/min.`);
    }
    el.voiceNote.textContent = parts.join(' ');
    el.voiceNote.hidden = parts.length === 0;
  }

  function applyVoiceUi() {
    el.voiceBox.hidden = !voice.on;
    el.panelEleven.hidden = voice.engine !== 'eleven';
    el.panelBrowser.hidden = voice.engine !== 'browser';
    el.engine.value = voice.engine;
    el.pauses.disabled = voice.on;
    el.pauses.closest('.check').classList.toggle('is-off', voice.on);
    updateVoiceNote();
  }

  /* ---------- Voix ElevenLabs ----------
     Modèle eleven_multilingual_v2, route « with-timestamps » : ElevenLabs renvoie
     l'audio ET l'instant exact où chaque caractère est prononcé. L'affichage
     lit l'horloge de l'audio (currentTime) à chaque image : le mot affiché est le
     mot entendu, y compris quand on change la vitesse (la lecture est accélérée
     sans changer la hauteur de la voix). Les phrases déjà générées restent en
     mémoire : revenir en arrière ne consomme pas de crédits. */

  const EL_API = 'https://api.elevenlabs.io';
  const EL_MODEL = 'eleven_multilingual_v2';
  const EL_NAMES = ['Nicolas', 'Jeanne', 'Adrien', 'Aurore'];
  const EL_WPM_AT_RATE_1 = 160;
  const EL_CACHE_MAX = 80;
  const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAIARKwAABCxAgAEABAAZGF0YQQAAAAAAAAA';

  const eleven = {
    key: '',
    sel: 'Nicolas',          // nom de la voix choisie, ou 'custom'
    custom: '',              // ID saisi à la main
    found: null,             // { Nicolas: { id, owner? } } une fois les voix du compte lues
    loading: false,
    listError: '',
    session: null,
    cache: new Map(),
    wpm1: EL_WPM_AT_RATE_1   // débit de la voix à vitesse 1, mesuré sur les phrases reçues
  };

  const nameKey = (s) => String(s || '').split(/[\s\-–—·|,(:]/)[0].toLowerCase();

  async function elHttp(path, opts) {
    let res;
    try {
      res = await fetch(EL_API + path, opts);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('Impossible de joindre ElevenLabs (réseau coupé ou accès externe bloqué). Dans la version publiée en ligne, cet accès est bloqué : ouvrez index.html sur votre ordinateur.');
    }
    if (res.ok) return res;
    let detail = '';
    try {
      const d = (await res.json()).detail;
      detail = typeof d === 'string' ? d : (d && d.message) || (Array.isArray(d) && d[0] && d[0].msg) || '';
    } catch (e) { /* corps non JSON */ }
    const base = {
      401: 'Clé API refusée par ElevenLabs.',
      402: 'Offre ElevenLabs insuffisante pour cette voix ou cette action.',
      403: 'Accès refusé par ElevenLabs.',
      404: 'Voix introuvable sur votre compte ElevenLabs.',
      429: 'Trop de requêtes en même temps chez ElevenLabs. Réessayez dans un instant.'
    }[res.status] || `ElevenLabs a répondu avec l’erreur ${res.status}.`;
    throw new Error(detail && !base.includes(detail) ? `${base} (${detail})` : base);
  }

  function renderElevenVoices() {
    const known = eleven.found;
    el.elVoice.textContent = '';
    for (const name of EL_NAMES) {
      const opt = document.createElement('option');
      opt.value = name;
      let label = name;
      if (known && !known[name]) label += ' (introuvable)';
      else if (known && known[name].owner) label += ' (bibliothèque)';
      opt.textContent = label;
      el.elVoice.append(opt);
    }
    const other = document.createElement('option');
    other.value = 'custom';
    other.textContent = 'Autre voix (ID)…';
    el.elVoice.append(other);
    if (eleven.sel !== 'custom' && !EL_NAMES.includes(eleven.sel)) eleven.sel = EL_NAMES[0];
    el.elVoice.value = eleven.sel;
    el.elCustom.hidden = eleven.sel !== 'custom';
  }

  async function elevenLoadVoices() {
    if (!eleven.key) {
      eleven.found = null;
      eleven.listError = '';
      renderElevenVoices();
      updateVoiceNote();
      return;
    }
    const key = eleven.key;
    const headers = { 'xi-api-key': key };
    eleven.loading = true;
    eleven.listError = '';
    updateVoiceNote();
    try {
      const mine = (await (await elHttp('/v1/voices', { headers })).json()).voices || [];
      const found = {};
      for (const name of EL_NAMES) {
        const same = mine.filter((v) => nameKey(v.name) === name.toLowerCase());
        const v = same.find((x) => /^fr/i.test((x.labels && x.labels.language) || '')) || same[0];
        if (v) found[name] = { id: v.voice_id };
      }
      // Voix absentes du compte : on les cherche dans la bibliothèque (ajout automatique au premier usage).
      for (const name of EL_NAMES) {
        if (found[name]) continue;
        try {
          const r = await elHttp(`/v1/shared-voices?search=${encodeURIComponent(name)}&language=fr&page_size=30`, { headers });
          const hit = ((await r.json()).voices || []).find((v) => nameKey(v.name) === name.toLowerCase());
          if (hit) found[name] = { id: hit.voice_id, owner: hit.public_owner_id };
        } catch (e) { /* la bibliothèque est facultative */ }
      }
      if (key !== eleven.key) return;
      eleven.found = found;
    } catch (e) {
      if (key === eleven.key) { eleven.found = null; eleven.listError = e.message; }
    } finally {
      if (key === eleven.key) eleven.loading = false;
    }
    renderElevenVoices();
    updateVoiceNote();
  }

  async function elevenEnsureVoice() {
    if (eleven.sel === 'custom') {
      const id = eleven.custom.trim();
      if (!id) throw new Error('Collez l’ID de la voix ElevenLabs à utiliser.');
      return id;
    }
    if (!eleven.found) await elevenLoadVoices();
    if (!eleven.found) throw new Error(eleven.listError || 'Impossible de lire les voix de votre compte ElevenLabs.');
    const v = eleven.found[eleven.sel];
    if (!v) {
      throw new Error(`La voix ${eleven.sel} est introuvable. Ajoutez-la à votre compte depuis la bibliothèque de voix ElevenLabs, ou choisissez « Autre voix (ID) ».`);
    }
    if (v.owner) {
      const res = await elHttp(`/v1/voices/add/${encodeURIComponent(v.owner)}/${encodeURIComponent(v.id)}`, {
        method: 'POST',
        headers: { 'xi-api-key': eleven.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: eleven.sel })
      });
      const added = await res.json();
      if (added && added.voice_id) v.id = added.voice_id;
      delete v.owner;
      renderElevenVoices();
    }
    return v.id;
  }

  async function elevenFetchChunk(s, chunk, prevText, nextText) {
    const cacheKey = `${s.voiceId}|${chunk.text}`;
    const hit = eleven.cache.get(cacheKey);
    if (hit) return hit;
    const body = {
      text: chunk.text,
      model_id: EL_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }
    };
    if (prevText) body.previous_text = prevText;
    if (nextText) body.next_text = nextText;
    const res = await elHttp(`/v1/text-to-speech/${encodeURIComponent(s.voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': eleven.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: s.abort.signal
    });
    const j = await res.json();
    if (!j || !j.audio_base64) throw new Error('ElevenLabs n’a renvoyé aucun audio.');
    const bin = atob(j.audio_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const al = j.alignment || j.normalized_alignment || {};
    const starts = al.character_start_times_seconds || [];
    const ends = al.character_end_times_seconds || [];
    const dur = ends.length ? ends[ends.length - 1] : 0;
    const exact = starts.length === chunk.text.length;
    // Instant de début de chaque mot (sinon, repli proportionnel à la position dans la phrase).
    const wordT = chunk.offsets.map((o) => (exact ? starts[o] : dur ? (o / chunk.text.length) * dur : 0));
    for (let i = 1; i < wordT.length; i++) if (wordT[i] < wordT[i - 1]) wordT[i] = wordT[i - 1];
    const data = { url, wordT, dur };
    eleven.cache.set(cacheKey, data);
    if (eleven.cache.size > EL_CACHE_MAX) {
      const oldest = eleven.cache.keys().next().value;
      URL.revokeObjectURL(eleven.cache.get(oldest).url);
      eleven.cache.delete(oldest);
    }
    if (dur > 0.5) {
      const wpm = ((chunk.end - chunk.start + 1) / dur) * 60;
      eleven.wpm1 = eleven.wpm1 * 0.7 + wpm * 0.3;
      elevenRefreshWpm();
    }
    return data;
  }

  function elevenRefreshWpm() {
    voice.effWpm = eleven.wpm1 * voiceRate();
  }

  function elevenFail(message) {
    voice.problem = message;
    pause();
    updateVoiceNote();
  }

  function elevenStart(from) {
    voiceCancel();
    voice.problem = '';
    if (voice.engine === 'eleven' && !eleven.key) { elevenFail('Saisissez votre clé API ElevenLabs pour utiliser ces voix.'); return; }
    state.index = clamp(from, 0, state.words.length - 1);
    showWord(state.index);
    updateProgress();
    const s = {
      dead: false, paused: false, items: [], nextIdx: state.index, active: null,
      pumping: false, n: 0, voiceId: '', prevText: '', raf: 0, engine: voice.engine, seeded: false,
      abort: new AbortController(), els: [new Audio(), new Audio()]
    };
    eleven.session = s;
    // Le clic de l'utilisateur est encore actif : on « débloque » les deux lecteurs audio (Safari, mobiles).
    for (const a of s.els) { a.src = SILENT_WAV; const p = a.play(); if (p && p.catch) p.catch(() => {}); }
    elevenRefreshWpm();
    elevenPump(s);
    s.raf = requestAnimationFrame(() => elevenLoop(s));
    updateVoiceNote();
  }

  async function elevenPump(s) {
    if (s.pumping || s.dead) return;
    s.pumping = true;
    const n = state.words.length;
    try {
      if (!s.voiceId) s.voiceId = await clipEnsureVoice(s);
      // Toujours deux phrases d'avance au plus : l'audio est prêt sans gaspiller de crédits.
      while (!s.dead && s.nextIdx < n && s.items.filter((it) => !it.started).length < 2) {
        const chunk = voiceChunk(state.words, s.nextIdx);
        s.nextIdx = chunk.end + 1;
        const following = chunk.end + 1 < n ? voiceChunk(state.words, chunk.end + 1) : null;
        const item = { chunk, data: null, started: false, el: null };
        s.items.push(item);
        item.data = await clipFetchChunk(s, chunk, s.prevText, following && following.text);
        s.prevText = chunk.text;
        if (s.dead) return;
        elevenAdvance(s);
        updateVoiceNote();
      }
    } catch (e) {
      if (!s.dead && !(e && e.name === 'AbortError')) {
        elevenKill();
        elevenFail((e && e.message) || 'La voix ElevenLabs a rencontré une erreur.');
      }
    } finally {
      s.pumping = false;
    }
  }

  // Lance la phrase suivante si rien ne joue et qu'elle est prête.
  function elevenAdvance(s) {
    if (s.dead || s.paused || s.active) return;
    const item = s.items.find((it) => !it.started);
    if (item && item.data) elevenPlayItem(s, item);
  }

  function elevenPlayItem(s, item) {
    const a = s.els[s.n++ % 2];
    item.started = true;
    item.el = a;
    s.active = item;
    a.onended = () => elevenEnded(s, item);
    a.onerror = () => {
      if (s.dead) return;
      elevenKill();
      elevenFail('Lecture audio impossible sur ce navigateur.');
    };
    a.src = item.data.url;
    const rate = voiceRate();
    a.defaultPlaybackRate = rate;
    a.playbackRate = rate;
    a.preservesPitch = true;
    a.webkitPreservesPitch = true;
    setIndex(item.chunk.start);
    const p = a.play();
    if (p && p.catch) {
      p.catch(() => {
        if (s.dead || s.paused) return;
        elevenKill();
        elevenFail('Le navigateur a bloqué la lecture audio. Appuyez sur lecture.');
      });
    }
    elevenPump(s);
    updateVoiceNote();
  }

  function elevenEnded(s, item) {
    if (s.dead) return;
    setIndex(item.chunk.end);                // recalage : dernier mot de la phrase
    if (s.active === item) s.active = null;
    if (item.chunk.end >= state.words.length - 1) { finish(); return; }
    elevenAdvance(s);
    elevenPump(s);
    updateVoiceNote();
  }

  // À chaque image : le mot affiché est celui que l'horloge de l'audio désigne.
  function elevenLoop(s) {
    if (s.dead) return;
    s.raf = requestAnimationFrame(() => elevenLoop(s));
    const item = s.active;
    if (!item || s.paused) return;
    const k = locateOffset(item.data.wordT, item.el.currentTime);
    const idx = item.chunk.start + k;
    if (idx > state.index) setIndex(idx);
  }

  function elevenPause() {
    const s = eleven.session;
    if (!s || s.dead || !(voice.on && isClip())) return false;
    s.paused = true;
    if (s.active) s.active.el.pause();
    return true;
  }

  function elevenResume() {
    const s = eleven.session;
    if (!s || s.dead || !s.paused || !(voice.on && isClip())) return false;
    s.paused = false;
    if (s.active) {
      const p = s.active.el.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      elevenAdvance(s);
    }
    elevenPump(s);
    return true;
  }

  function elevenKill() {
    const s = eleven.session;
    if (!s) return;
    s.dead = true;
    eleven.session = null;
    cancelAnimationFrame(s.raf);
    try { s.abort.abort(); } catch (e) { /* ignoré */ }
    for (const a of s.els) {
      a.onended = null;
      a.onerror = null;
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* ignoré */ }
    }
  }

  // Changement de vitesse : appliqué tout de suite, sans relancer la phrase.
  function elevenApplyRate() {
    elevenRefreshWpm();
    const s = eleven.session;
    if (!s) return;
    const rate = voiceRate();
    for (const a of s.els) { a.defaultPlaybackRate = rate; a.playbackRate = rate; }
  }

  function loadVoices() {
    if (!voice.supported) return;
    let all = [];
    try { all = window.speechSynthesis.getVoices() || []; } catch (e) { /* ignoré */ }
    if (!all.length) return;
    const isFr = (v) => /^fr([-_]|$)/i.test(v.lang || '');
    const scored = all.map((v) => ({ v, score: voiceScore(v), fr: isFr(v) }));
    scored.sort((a, b) =>
      (Number(b.fr) - Number(a.fr)) ||
      (b.score - a.score) ||
      a.v.name.localeCompare(b.v.name));
    voice.list = scored.map((s) => s.v);
    voice.best = scored.length && scored[0].fr ? scored[0].score : 0;
    if (!voice.list.some((v) => voiceId(v) === voice.uri)) {
      voice.uri = voiceId(scored[0].v);       // meilleure voix française disponible
    }
    el.voiceSelect.textContent = '';
    const groups = [
      ['Voix naturelles (recommandées)', scored.filter((s) => s.fr && s.score >= NATURAL_SCORE)],
      ['Autres voix françaises', scored.filter((s) => s.fr && s.score < NATURAL_SCORE)],
      ['Voix dans d’autres langues', scored.filter((s) => !s.fr)]
    ];
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const { v, score } of items) {
        const opt = document.createElement('option');
        opt.value = voiceId(v);
        const flags = [];
        if (!v.localService) flags.push('en ligne');
        if (voice.noEventsIds.has(voiceId(v)) || (score < NATURAL_SCORE && /google/i.test(v.name))) flags.push('synchro estimée');
        opt.textContent = `${v.name} · ${v.lang}${flags.length ? ' · ' + flags.join(', ') : ''}`;
        group.append(opt);
      }
      el.voiceSelect.append(group);
    }
    el.voiceSelect.value = voice.uri;
    updateVoiceNote();
  }

  /* Note de naturel d'une voix, d'après son nom : les voix neuronales portent
     presque toujours « Natural », « Neural », « Premium » ou « Enhanced ». */
  function voiceScore(v) {
    const name = `${v.name || ''} ${v.voiceURI || ''}`;
    let s = 0;
    if (/online \(natural\)|\bnatural\b|\bneural\b/i.test(name)) s += 100;
    if (/premium|enhanced|améliorée|haute qualité/i.test(name)) s += 90;
    if (/siri/i.test(name)) s += 60;
    if (/microsoft/i.test(name) && /online/i.test(name)) s += 10;
    if (/google/i.test(name)) s += 40;
    if (/espeak|compact|festival|mbrola/i.test(name)) s -= 60;
    if (/^fr[-_]fr$/i.test(v.lang || '')) s += 8;
    else if (/^fr/i.test(v.lang || '')) s += 3;
    if (v.localService) s += 2;
    return s;
  }

  /* ---------- Vitesse ---------- */

  function setWpm(value, persist = true) {
    const v = clamp(Math.round(Number(value) / 5) * 5, WPM_MIN, WPM_MAX);
    state.wpm = v;
    el.range.value = String(v);
    el.big.textContent = String(v);
    document.querySelectorAll('[data-wpm]').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.wpm) === v));
    });
    if (persist) store.set(STORE.wpm, String(v));
    if (voice.on) {
      if (isClip()) elevenApplyRate();
      else if (state.playing) scheduleVoiceRestart();   // la vitesse d'une voix du navigateur ne change pas en cours de phrase
    }
    updateProgress();
    updateStats();
    updateVoiceNote();
  }

  /* ---------- Saisie ---------- */

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
    }
    rebuildCum();
    buildMarks();
    showView('reader');
    measure();
    showWord(state.index);
    updateProgress();
    setUiPlaying();
    el.reader.focus({ preventScroll: true });
    play();
  }

  function backToEditor() {
    pause();
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

  el.voiceOn.addEventListener('change', () => {
    voice.on = el.voiceOn.checked;
    voice.problem = '';
    voice.noEvents = false;
    store.set(STORE.voice, voice.on ? '1' : '0');
    applyVoiceUi();
    if (!voice.on) voiceCancel();
    if (voice.on && voice.engine === 'eleven' && eleven.key && !eleven.found && !eleven.loading) elevenLoadVoices();
    if (state.playing) {
      clearTimeout(state.timer);
      if (voice.on) {
        voiceStart(state.index);
      } else {
        voiceCancel();
        state.target = performance.now();
        state.rampIdx = 1;
        step();
      }
    }
    updateProgress();
    updateStats();
  });

  el.voiceSelect.addEventListener('change', () => {
    voice.uri = el.voiceSelect.value;
    voice.noEvents = false;
    voice.effWpm = 0;
    store.set(STORE.voiceUri, voice.uri);
    el.voiceSelect.blur();
    if (voice.on && state.playing) voiceStart(state.index);
    updateVoiceNote();
  });

  el.engine.addEventListener('change', () => {
    voice.engine = el.engine.value === 'browser' ? 'browser' : 'eleven';
    voice.problem = '';
    voice.noEvents = false;
    voice.effWpm = 0;
    store.set(STORE.engine, voice.engine);
    voiceCancel();
    applyVoiceUi();
    if (voice.engine === 'eleven' && eleven.key && !eleven.found && !eleven.loading) elevenLoadVoices();
    if (voice.on && state.playing) voiceStart(state.index);
    el.engine.blur();
    updateProgress();
    updateStats();
  });

  el.elKey.addEventListener('change', () => {
    eleven.key = el.elKey.value.trim();
    if (eleven.key) store.set(STORE.elKey, eleven.key);
    else { try { localStorage.removeItem(STORE.elKey); } catch (e) { /* ignoré */ } }
    eleven.found = null;
    voice.problem = '';
    elevenLoadVoices();
  });

  const restartIfElevenPlaying = () => {
    voiceCancel();
    if (voice.on && voice.engine === 'eleven' && state.playing) voiceStart(state.index);
  };

  el.elVoice.addEventListener('change', () => {
    eleven.sel = el.elVoice.value;
    el.elCustom.hidden = eleven.sel !== 'custom';
    store.set(STORE.elVoice, eleven.sel);
    voice.problem = '';
    el.elVoice.blur();
    restartIfElevenPlaying();
    updateVoiceNote();
  });

  el.elCustom.addEventListener('change', () => {
    eleven.custom = el.elCustom.value.trim();
    store.set(STORE.elCustom, eleven.custom);
    voice.problem = '';
    restartIfElevenPlaying();
  });

  el.elRefresh.addEventListener('click', () => {
    eleven.found = null;
    voice.problem = '';
    elevenLoadVoices();
  });

  // Après un clic souris, une case à cocher ne garde pas le focus : Espace reste « lecture / pause ».
  el.reader.addEventListener('pointerup', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (a === el.voiceOn || a === el.pauses) a.blur();
    }, 0);
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
    if (tag === 'SELECT') return;
    if (tag === 'INPUT' && (target.type === 'text' || target.type === 'password')) return;   // saisie de la clé API
    if (tag === 'INPUT' && target.type === 'range' && e.key.startsWith('Arrow')) return;
    if (tag === 'INPUT' && target.type === 'checkbox' && e.key === ' ') return;
    if ((tag === 'BUTTON' || tag === 'A') && e.key === ' ') return;   // activation native
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
  voice.on = store.get(STORE.voice) === '1';
  voice.engine = store.get(STORE.engine) === 'browser' ? 'browser' : 'eleven';
  voice.uri = store.get(STORE.voiceUri) || '';
  el.voiceOn.checked = voice.on;
  eleven.key = store.get(STORE.elKey) || '';
  eleven.sel = store.get(STORE.elVoice) || EL_NAMES[0];
  eleven.custom = store.get(STORE.elCustom) || '';
  el.elKey.value = eleven.key;
  el.elCustom.value = eleven.custom;
  renderElevenVoices();
  if (eleven.key && voice.on && voice.engine === 'eleven') elevenLoadVoices();
  if (voice.supported) {
    loadVoices();
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    } else {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    setTimeout(loadVoices, 600);       // certains navigateurs n'émettent pas voiceschanged
  }
  applyVoiceUi();
  const savedWpm = Number(store.get(STORE.wpm));
  setWpm(savedWpm >= WPM_MIN && savedWpm <= WPM_MAX ? savedWpm : 300, false);
  updateStats();
  setUiPlaying();
})();

// Fonctions de synthèse vocale
function initVoice() {
  // Détection du support Web Speech API
  // Chargement des voix disponibles
}

function scheduleSpeech(startIndex) {
  // Génère des phrases de 3 mots pour une lecture fluide
  // Synchronisation avec la vitesse RSVP
}

function speakWordImmediately(wordText) {
  // Lecture immédiate d'un mot
}

// Intégration dans la fonction step() pour la lecture synchronisée
function step() {
  if (!state.playing) return;
  showWord(state.index);
  updateProgress();

  // Lecture vocale synchronisée
  if (state.voiceEnabled && state.voiceModel && 'speechSynthesis' in window) {
    if (state.index % 3 === 0) {
      scheduleSpeech(state.index);
    }
  }

  // ... reste du code
}

/* ============================================================================
   LEONI Sertissage — Preload (v2)
   Bridge sécurisé — lit data.json depuis le chemin choisi par l'utilisateur
   et écoute les modifications faites par d'autres PC.
   ============================================================================ */

const { contextBridge, ipcRenderer } = require('electron');
const fs   = require('fs');

// Récupère le chemin du fichier (passé par main.js via additionalArguments)
const dataFileArg = process.argv.find(a => a.startsWith('--data-file='));
const dataFile    = dataFileArg ? dataFileArg.split('=')[1] : null;

// Lecture SYNCHRONE au démarrage → app.js trouve les données immédiatement
let initialData = null;
try {
  if (dataFile && fs.existsSync(dataFile)) {
    const raw = fs.readFileSync(dataFile, 'utf-8');
    initialData = JSON.parse(raw);
    console.log(`[preload] ✅ Base chargée (${raw.length} octets) depuis ${dataFile}`);
  } else {
    console.log('[preload] 🆕 Nouvelle base — sera créée au premier enregistrement');
  }
} catch (err) {
  console.error('[preload] ❌ Erreur lecture :', err);
}

/* ---------------------------------------------------------------------------
   API exposée au renderer
   --------------------------------------------------------------------------- */
const externalChangeCallbacks = [];

ipcRenderer.on('db:externalChange', () => {
  console.log('[preload] 🔄 Modification externe détectée');
  externalChangeCallbacks.forEach(cb => { try { cb(); } catch (e) {} });
});

contextBridge.exposeInMainWorld('leoniAPI', {
  // Données au démarrage (synchrone)
  initialData,

  // Opérations base
  writeDB:        (data) => ipcRenderer.invoke('db:write', data),
  readDB:         ()     => ipcRenderer.invoke('db:read'),
  backupDB:       ()     => ipcRenderer.invoke('db:backup'),
  resetDB:        ()     => ipcRenderer.invoke('db:reset'),
  getInfo:        ()     => ipcRenderer.invoke('db:info'),
  changeLocation: ()     => ipcRenderer.invoke('db:changeLocation'),

  // Écouter les modifications externes (autre PC)
  onExternalChange: (callback) => {
    externalChangeCallbacks.push(callback);
    return () => {
      const i = externalChangeCallbacks.indexOf(callback);
      if (i >= 0) externalChangeCallbacks.splice(i, 1);
    };
  },

  // Environnement
  isElectron: true,
  platform:   process.platform,
  versions:   {
    node:     process.versions.node,
    electron: process.versions.electron,
    chrome:   process.versions.chrome
  }
});

console.log('[preload] 🔒 leoniAPI exposé');

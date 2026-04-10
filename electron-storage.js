/* ============================================================================
   LEONI Sertissage — Electron Storage Layer (v2)
   - Persistance fichier via leoniAPI
   - Sync multi-PC : recharge auto quand un autre PC modifie le fichier
   - Zéro modification requise dans app.js
   ============================================================================ */

(function () {
  'use strict';

  if (!window.leoniAPI) {
    alert('Cette application doit être lancée via Electron.\nDouble-clique sur LEONI Sertissage.exe.');
    return;
  }

  const api = window.leoniAPI;
  console.log('⚡ Electron Storage v2 — plateforme :', api.platform);

  /* --------------------------------------------------------------------------
     DONNÉES EN MÉMOIRE
     -------------------------------------------------------------------------- */
  let data = api.initialData || seedData();
  const listeners = new Map();
  let currentUser = null;
  let authCallbacks = [];

  /* --------------------------------------------------------------------------
     PERSISTANCE — écriture debounced 400ms
     -------------------------------------------------------------------------- */
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const r = await api.writeDB(data);
        if (r.ok) console.log(`💾 Sauvegardé (${r.bytes} octets)`);
        else      console.error('❌ Sauvegarde :', r.error);
      } catch (err) { console.error('❌ IPC :', err); }
    }, 400);
  }
  window.addEventListener('beforeunload', () => {
    if (saveTimer) { clearTimeout(saveTimer); api.writeDB(data); }
  });

  /* --------------------------------------------------------------------------
     SYNC MULTI-PC — quand un autre PC modifie le fichier, on recharge
     -------------------------------------------------------------------------- */
  api.onExternalChange(async () => {
    console.log('🔄 Autre PC a modifié la base — rechargement…');
    try {
      const fresh = await api.readDB();
      if (fresh) {
        data = fresh;
        // Re-déclenche TOUS les listeners pour que l'UI se rafraîchisse
        for (const [listenPath, cbs] of listeners.entries()) {
          const snap = makeSnapshot(getAtPath(listenPath), listenPath);
          cbs.forEach(cb => setTimeout(() => cb(snap), 0));
        }
        showSyncNotification();
      }
    } catch (err) {
      console.error('❌ Rechargement :', err);
    }
  });

  function showSyncNotification() {
    const toast = document.createElement('div');
    toast.textContent = '🔄 Données synchronisées depuis un autre poste';
    Object.assign(toast.style, {
      position: 'fixed', top: '60px', right: '20px',
      padding: '10px 16px', borderRadius: '8px',
      background: 'rgba(6, 182, 212, 0.95)', color: '#0a0f1c',
      fontSize: '13px', fontWeight: '600',
      boxShadow: '0 4px 16px rgba(0,0,0,.4)',
      zIndex: '9999', animation: 'toastIn 300ms'
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  /* --------------------------------------------------------------------------
     HELPERS PATH
     -------------------------------------------------------------------------- */
  function getAtPath(path) {
    if (!path) return data;
    const parts = path.split('/').filter(Boolean);
    let cur = data;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[p];
    }
    return cur == null ? null : cur;
  }

  function setAtPath(path, value) {
    if (!path) { data = value || {}; save(); return; }
    const parts = path.split('/').filter(Boolean);
    let cur = data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (value === null || value === undefined) delete cur[last];
    else cur[last] = value;
    save();
  }

  function fireListeners(changedPath) {
    for (const [listenPath, cbs] of listeners.entries()) {
      const match = listenPath === '' || changedPath === listenPath ||
        changedPath.startsWith(listenPath + '/') || listenPath.startsWith(changedPath + '/');
      if (match) {
        const snap = makeSnapshot(getAtPath(listenPath), listenPath);
        cbs.forEach(cb => setTimeout(() => cb(snap), 0));
      }
    }
  }

  function makeSnapshot(value, path) {
    return {
      val: () => value,
      key: path ? path.split('/').pop() : null,
      exists: () => value !== null && value !== undefined,
      forEach: (cb) => {
        if (value && typeof value === 'object') {
          Object.entries(value).forEach(([k, v]) => {
            cb({ key: k, val: () => v, exists: () => true });
          });
        }
      }
    };
  }

  /* --------------------------------------------------------------------------
     REF (mock Firebase Realtime DB)
     -------------------------------------------------------------------------- */
  function ref(path) {
    path = (path || '').replace(/^\//, '').replace(/\/$/, '');
    return {
      _path: path,
      on(event, callback) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(callback);
        setTimeout(() => callback(makeSnapshot(getAtPath(path), path)), 0);
        return callback;
      },
      off(event, callback) {
        if (listeners.has(path) && callback) listeners.get(path).delete(callback);
      },
      once()  { return Promise.resolve(makeSnapshot(getAtPath(path), path)); },
      set(value) { setAtPath(path, value); fireListeners(path); return Promise.resolve(); },
      update(updates) {
        const current = getAtPath(path) || {};
        Object.entries(updates).forEach(([k, v]) => {
          if (k.includes('/')) setAtPath(path + '/' + k, v);
          else {
            if (v === null) delete current[k];
            else current[k] = v;
            setAtPath(path, current);
          }
        });
        fireListeners(path);
        return Promise.resolve();
      },
      push(value) {
        const id = 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const current = getAtPath(path) || {};
        current[id] = value;
        setAtPath(path, current);
        fireListeners(path);
        return { key: id };
      },
      remove() { setAtPath(path, null); fireListeners(path); return Promise.resolve(); },
      transaction(fn) {
        const current = getAtPath(path);
        const next = fn(current);
        setAtPath(path, next);
        fireListeners(path);
        return Promise.resolve({ snapshot: makeSnapshot(next, path) });
      },
      orderByChild() { return this; },
      orderByKey()   { return this; },
      equalTo()      { return this; },
      limitToLast()  { return this; },
      limitToFirst() { return this; }
    };
  }

  /* --------------------------------------------------------------------------
     AUTH — valide contre _credentials dans le fichier
     -------------------------------------------------------------------------- */
  const authMock = {
    currentUser: null,

    signInWithEmailAndPassword(email, password) {
      const creds = getAtPath('_credentials') || {};
      const found = Object.values(creds).find(u => u.email === email && u.password === password);
      if (!found) return Promise.reject({ code: 'auth/invalid-credential' });
      currentUser = { uid: found.uid, email: found.email };
      this.currentUser = currentUser;
      setAtPath('_session', currentUser);
      authCallbacks.forEach(cb => setTimeout(() => cb(currentUser), 0));
      return Promise.resolve({ user: currentUser });
    },

    signOut() {
      currentUser = null;
      this.currentUser = null;
      setAtPath('_session', null);
      authCallbacks.forEach(cb => setTimeout(() => cb(null), 0));
      return Promise.resolve();
    },

    onAuthStateChanged(cb) {
      authCallbacks.push(cb);
      const stored = getAtPath('_session');
      if (stored) { currentUser = stored; this.currentUser = stored; }
      setTimeout(() => cb(currentUser), 0);
      return () => { authCallbacks = authCallbacks.filter(c => c !== cb); };
    },

    createUserWithEmailAndPassword(email, password) {
      const uid = 'uid_' + Date.now();
      const creds = getAtPath('_credentials') || {};
      creds[uid] = { uid, email, password };
      setAtPath('_credentials', creds);
      return Promise.resolve({ user: { uid, email } });
    }
  };

  /* --------------------------------------------------------------------------
     STORAGE — fichiers en base64 dans le JSON
     -------------------------------------------------------------------------- */
  const storageMock = {
    ref(path) {
      return {
        put(file) {
          return new Promise((resolve) => {
            if (file instanceof Blob || file instanceof File) {
              const reader = new FileReader();
              reader.onload = () => {
                setAtPath(`_files/${path.replace(/\//g, '__')}`, reader.result);
                resolve({ ref: { getDownloadURL: () => Promise.resolve(reader.result) } });
              };
              reader.onerror = () => resolve({ ref: { getDownloadURL: () => Promise.resolve('') } });
              reader.readAsDataURL(file);
            } else {
              resolve({ ref: { getDownloadURL: () => Promise.resolve('') } });
            }
          });
        }
      };
    }
  };

  /* --------------------------------------------------------------------------
     SEED — uniquement au tout premier lancement (dossier vide)
     -------------------------------------------------------------------------- */
  function seedData() {
    const now = Date.now();
    return {
      _credentials: {
        uid_admin: { uid: 'uid_admin', email: 'admin@leoni.com', password: 'admin' }
      },
      _session: null,
      users: {
        uid_admin: {
          uid: 'uid_admin', email: 'admin@leoni.com',
          displayName: 'Admin', matricule: 'LEO-0001',
          role: 'super_admin', active: true, createdAt: now
        }
      },
      counters: { registre: 1000 },
      tools: {},
      interventions: {},
      notifications: {}
    };
  }

  /* --------------------------------------------------------------------------
     EXPOSE window.firebase (API identique)
     -------------------------------------------------------------------------- */
  window.firebase = {
    initializeApp: () => ({ name: 'leoni-desktop' }),
    auth:     () => authMock,
    database: () => ({ ref }),
    storage:  () => storageMock
  };

  /* --------------------------------------------------------------------------
     COMMANDES DEBUG
     -------------------------------------------------------------------------- */
  window.leoniDesktop = {
    info:           () => api.getInfo().then(console.log),
    backup:         () => api.backupDB().then(console.log),
    changeLocation: () => api.changeLocation(),
    reset: async () => {
      if (!confirm('Supprimer toute la base ?')) return;
      await api.resetDB();
      location.reload();
    },
    data: () => data
  };

  /* --------------------------------------------------------------------------
     BANNIÈRE "Mode Desktop" + emplacement
     -------------------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    const info = await api.getInfo();
    const pill = document.createElement('div');
    pill.innerHTML = `💻 Desktop · 📁 ${info.dataDir.length > 40 ? '…' + info.dataDir.slice(-37) : info.dataDir}`;
    pill.title = `Stockage : ${info.dataDir}\nClic pour changer`;
    Object.assign(pill.style, {
      position: 'fixed', bottom: '10px', left: '10px',
      padding: '6px 12px', fontSize: '11px', fontWeight: '600',
      color: '#93c5fd', background: 'rgba(59,130,246,0.12)',
      border: '1px solid rgba(59,130,246,0.35)', borderRadius: '999px',
      zIndex: '9998', cursor: 'pointer', letterSpacing: '0.03em',
      fontFamily: 'monospace', maxWidth: '380px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    });
    pill.addEventListener('click', () => api.changeLocation());
    document.body.appendChild(pill);
  });

  console.log('%c💻 LEONI DESKTOP v2', 'background:#3b82f6;color:#fff;padding:4px 8px;border-radius:4px;font-weight:bold');
  console.log('💡 leoniDesktop.info() / .backup() / .changeLocation() / .reset()');
})();

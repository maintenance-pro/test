/* ============================================================================
   LEONI · DEMO MODE
   Mock complet de Firebase (Auth + Realtime DB + Storage) avec localStorage.
   Permet de tester l'app SANS aucune configuration Firebase.

   ┌─────────────────────────────────────────────────────────┐
   │  COMPTES DÉMO PRÉ-CRÉÉS :                               │
   │                                                          │
   │  👑 Admin      → admin@leoni.com  / admin               │
   │  🔧 Crimping   → crimp@leoni.com  / crimp               │
   │  🧪 Labo       → labo@leoni.com   / labo                │
   │                                                          │
   └─────────────────────────────────────────────────────────┘

   Réinitialiser les données : ouvre la console (F12) et tape :
     demoDB.reset()
   ============================================================================ */

(function () {
  'use strict';

  const STORAGE_KEY = 'leoni_demo_db_v1';
  const AUTH_KEY    = 'leoni_demo_auth_v1';

  /* --------------------------------------------------------------------------
     STORE + PERSISTENCE
     -------------------------------------------------------------------------- */
  let data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || seedData();
  const listeners = new Map();      // path -> Set<callback>
  let currentUser = null;
  let authCallbacks = [];

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
    catch (e) { console.warn('Demo: localStorage plein', e); }
  }

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
      const match =
        listenPath === '' ||
        changedPath === listenPath ||
        changedPath.startsWith(listenPath + '/') ||
        listenPath.startsWith(changedPath + '/');
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
     REF (Realtime DB mock)
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
      once() {
        return Promise.resolve(makeSnapshot(getAtPath(path), path));
      },
      set(value) {
        setAtPath(path, value);
        fireListeners(path);
        return Promise.resolve();
      },
      update(updates) {
        const current = getAtPath(path) || {};
        Object.entries(updates).forEach(([k, v]) => {
          if (k.includes('/')) {
            setAtPath(path + '/' + k, v);
          } else {
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
      remove() {
        setAtPath(path, null);
        fireListeners(path);
        return Promise.resolve();
      },
      transaction(updateFn) {
        const current = getAtPath(path);
        const next = updateFn(current);
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
     AUTH MOCK
     -------------------------------------------------------------------------- */
  const authMock = {
    currentUser: null,

    signInWithEmailAndPassword(email, password) {
      const creds = getAtPath('_demo_credentials') || {};
      const found = Object.values(creds).find(u => u.email === email && u.password === password);
      if (!found) {
        return Promise.reject({ code: 'auth/invalid-credential', message: 'Identifiants invalides' });
      }
      currentUser = { uid: found.uid, email: found.email };
      this.currentUser = currentUser;
      localStorage.setItem(AUTH_KEY, JSON.stringify(currentUser));
      authCallbacks.forEach(cb => setTimeout(() => cb(currentUser), 0));
      return Promise.resolve({ user: currentUser });
    },

    signOut() {
      currentUser = null;
      this.currentUser = null;
      localStorage.removeItem(AUTH_KEY);
      authCallbacks.forEach(cb => setTimeout(() => cb(null), 0));
      return Promise.resolve();
    },

    onAuthStateChanged(cb) {
      authCallbacks.push(cb);
      const stored = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      if (stored) { currentUser = stored; this.currentUser = stored; }
      setTimeout(() => cb(currentUser), 0);
      return () => { authCallbacks = authCallbacks.filter(c => c !== cb); };
    },

    createUserWithEmailAndPassword(email, password) {
      const uid = 'uid_' + Date.now();
      const creds = getAtPath('_demo_credentials') || {};
      creds[uid] = { uid, email, password };
      setAtPath('_demo_credentials', creds);
      return Promise.resolve({ user: { uid, email } });
    }
  };

  /* --------------------------------------------------------------------------
     STORAGE MOCK
     -------------------------------------------------------------------------- */
  const storageMock = {
    ref(path) {
      return {
        put(file) {
          return new Promise((resolve) => {
            if (file instanceof Blob || file instanceof File) {
              const reader = new FileReader();
              reader.onload = () => {
                resolve({
                  ref: { getDownloadURL: () => Promise.resolve(reader.result) }
                });
              };
              reader.onerror = () => {
                resolve({ ref: { getDownloadURL: () => Promise.resolve('data:,demo-file') } });
              };
              reader.readAsDataURL(file);
            } else {
              resolve({ ref: { getDownloadURL: () => Promise.resolve('data:,demo-file') } });
            }
          });
        }
      };
    }
  };

  /* --------------------------------------------------------------------------
     SEED DATA (comptes + outils + interventions exemples)
     -------------------------------------------------------------------------- */
  function seedData() {
    const now = Date.now();
    const DAY = 86400000;
    const HOUR = 3600000;

    return {
      _demo_credentials: {
        uid_admin: { uid: 'uid_admin', email: 'admin@leoni.com', password: 'admin' },
        uid_crimp: { uid: 'uid_crimp', email: 'crimp@leoni.com', password: 'crimp' },
        uid_labo:  { uid: 'uid_labo',  email: 'labo@leoni.com',  password: 'labo'  }
      },

      users: {
        uid_admin: {
          uid: 'uid_admin', email: 'admin@leoni.com',
          displayName: 'Bilal', matricule: 'LEO-0001',
          role: 'super_admin', active: true, createdAt: now, lastLoginAt: now
        },
        uid_crimp: {
          uid: 'uid_crimp', email: 'crimp@leoni.com',
          displayName: 'KOUDRI', matricule: 'LEO-0123',
          role: 'crimping', active: true, createdAt: now, lastLoginAt: now - DAY
        },
        uid_labo: {
          uid: 'uid_labo', email: 'labo@leoni.com',
          displayName: 'SAGHROU', matricule: 'LEO-0234',
          role: 'labo', active: true, createdAt: now, lastLoginAt: now - HOUR
        }
      },

      counters: { registre: 2633 },

      tools: {
        'wz2158s-04': {
          id: 'wz2158s-04', outilId: 'WZ2158*-4s', refOutil: '2158S',
          fabricant: 'SIROCO', refFabricant: '37-0-268-00-2 A',
          frequenceCycle: 200000,
          pieces: { pAr: '37-2-268-03-0 E', pAv: '37-2-268-05-0 A', eAr: '37-2-268-20-0', eAv: '37-2-268-21-0' },
          active: true, createdAt: now
        },
        'wz2153s-15': {
          id: 'wz2153s-15', outilId: 'WZ2153S-15', refOutil: '2153S',
          fabricant: 'SIROCO', refFabricant: '37-0-263-00-1 B',
          frequenceCycle: 200000,
          pieces: { pAr: '37-2-263-03-0', pAv: '37-2-263-05-0', eAr: '37-2-263-20-0', eAv: '37-2-263-21-0' },
          active: true, createdAt: now
        },
        'wz2089-03': {
          id: 'wz2089-03', outilId: 'WZ2089-3', refOutil: '2089',
          fabricant: 'SIROCO', refFabricant: '35-0-208-00-9',
          frequenceCycle: 150000,
          pieces: { pAr: '35-2-089-03-0', pAv: '35-2-089-05-0', eAr: '35-2-089-20-0', eAv: '35-2-089-21-0' },
          active: true, createdAt: now
        },
        'wz2154s-35': {
          id: 'wz2154s-35', outilId: 'WZ2154S-35', refOutil: '2154S',
          fabricant: 'SIROCO', refFabricant: '37-0-254-00-3',
          frequenceCycle: 180000,
          pieces: { pAr: '37-2-254-03-0', pAv: '37-2-254-05-0', eAr: '37-2-254-20-0', eAv: '37-2-254-21-0' },
          active: true, createdAt: now
        },
        'wz2200c-07': {
          id: 'wz2200c-07', outilId: 'WZ2200C-07', refOutil: '2200C',
          fabricant: 'KOMAX', refFabricant: 'KX-2200-07-A',
          frequenceCycle: 220000,
          pieces: { pAr: 'KX-2200-03', pAv: 'KX-2200-05', eAr: 'KX-2200-20', eAv: 'KX-2200-21' },
          active: true, createdAt: now
        }
      },

      interventions: {
        /* ====== Bon validé (historique complet) ====== */
        '2631': {
          numBon: 2631,
          qrCode: 'LEONI-INT-2631',
          status: 'validated',
          statusHistory: [
            { status: 'draft',     at: now - 3 * DAY,          by: 'uid_crimp', byName: 'KOUDRI' },
            { status: 'submitted', at: now - 3 * DAY + HOUR,   by: 'uid_crimp', byName: 'KOUDRI' },
            { status: 'validated', at: now - 2 * DAY,          by: 'uid_labo',  byName: 'SAGHROU' }
          ],
          tool: {
            toolId: 'wz2158s-04', outilId: 'WZ2158*-4s', refOutil: '2158S',
            fabricant: 'SIROCO', refFabricant: '37-0-268-00-2 A'
          },
          crimping: {
            filledAt: now - 3 * DAY,
            filledBy: { uid: 'uid_crimp', name: 'KOUDRI', matricule: 'LEO-0123' },
            date: now - 3 * DAY, cycles: 800898,
            type: 'preventive',
            piecesChanged: { pAr: false, pAv: true, eAr: false, eAv: true, ejector: false, couteauBanda: false },
            observation: 'Requalif + bon N° 410034'
          },
          lab: {
            filledAt: now - 2 * DAY,
            filledBy: { uid: 'uid_labo', name: 'SAGHROU', matricule: 'LEO-0234' },
            connexion: { refConnexion: 'P00169871', sectionCable: '0,35 IR', indiceParametrique: '' },
            mesures: {
              largeurAme: 1.451, largeurIsolant: 1.753,
              hauteurIsolant: [1.547, 1.549, 1.541, 1.543, 1.545],
              effort: [54.2, 54.5, 54.1, 54.3, 54.0]
            },
            capabilite: { hauteurAmeMoyenne: 1.545, cmAme: 1.67, cmkAme: 1.42, cmEffort: 1.85, chuteTension: 0.85 },
            conformites: { chanfrein: true, temoinCoupe: true, flexion: true },
            decision: 'validated'
          },
          sla: { submittedAt: now - 3 * DAY + HOUR, decidedAt: now - 2 * DAY, durationMs: DAY - HOUR },
          locked: true,
          createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY,
          _indexes: { yearMonth: new Date(now).toISOString().slice(0, 7), toolId: 'wz2158s-04', status: 'validated' }
        },

        /* ====== Bon en attente labo ====== */
        '2632': {
          numBon: 2632,
          qrCode: 'LEONI-INT-2632',
          status: 'submitted',
          statusHistory: [
            { status: 'draft',     at: now - 5 * HOUR, by: 'uid_crimp', byName: 'KOUDRI' },
            { status: 'submitted', at: now - 2 * HOUR, by: 'uid_crimp', byName: 'KOUDRI' }
          ],
          tool: {
            toolId: 'wz2153s-15', outilId: 'WZ2153S-15', refOutil: '2153S',
            fabricant: 'SIROCO', refFabricant: '37-0-263-00-1 B'
          },
          crimping: {
            filledAt: now - 5 * HOUR,
            filledBy: { uid: 'uid_crimp', name: 'KOUDRI', matricule: 'LEO-0123' },
            date: now - 5 * HOUR, cycles: 6252993,
            type: 'curative',
            piecesChanged: { pAr: true, pAv: false, eAr: true, eAv: false, ejector: false, couteauBanda: false },
            observation: 'Changement Ear + Presseur + Requalif bon N° 512372'
          },
          lab: null,
          sla: { submittedAt: now - 2 * HOUR, decidedAt: null, durationMs: null },
          locked: false,
          createdAt: now - 5 * HOUR, updatedAt: now - 2 * HOUR,
          _indexes: { yearMonth: new Date(now).toISOString().slice(0, 7), toolId: 'wz2153s-15', status: 'submitted' }
        },

        /* ====== Bon refusé (à corriger) ====== */
        '2633': {
          numBon: 2633,
          qrCode: 'LEONI-INT-2633',
          status: 'rejected',
          statusHistory: [
            { status: 'draft',     at: now - DAY,                  by: 'uid_crimp', byName: 'KOUDRI' },
            { status: 'submitted', at: now - DAY + 30 * 60000,     by: 'uid_crimp', byName: 'KOUDRI' },
            { status: 'rejected',  at: now - 6 * HOUR,             by: 'uid_labo',  byName: 'SAGHROU',
              reason: 'Cm âme insuffisant (<1.33). Vérifier le réglage de l\'outil et resoumettre.' }
          ],
          tool: {
            toolId: 'wz2089-03', outilId: 'WZ2089-3', refOutil: '2089',
            fabricant: 'SIROCO', refFabricant: '35-0-208-00-9'
          },
          crimping: {
            filledAt: now - DAY,
            filledBy: { uid: 'uid_crimp', name: 'KOUDRI', matricule: 'LEO-0123' },
            date: now - DAY, cycles: 4125000,
            type: 'preventive',
            piecesChanged: { pAr: false, pAv: false, eAr: false, eAv: true, ejector: false, couteauBanda: false },
            observation: 'Maintenance préventive programmée — dépassement fréquence cycle'
          },
          lab: {
            filledAt: now - 6 * HOUR,
            filledBy: { uid: 'uid_labo', name: 'SAGHROU' },
            decision: 'rejected',
            rejectReason: 'Cm âme insuffisant (<1.33). Vérifier le réglage de l\'outil et resoumettre.'
          },
          sla: { submittedAt: now - DAY + 30 * 60000, decidedAt: now - 6 * HOUR, durationMs: DAY - 30 * 60000 - 6 * HOUR },
          locked: false,
          createdAt: now - DAY, updatedAt: now - 6 * HOUR,
          _indexes: { yearMonth: new Date(now).toISOString().slice(0, 7), toolId: 'wz2089-03', status: 'rejected' }
        }
      },

      notifications: {
        uid_labo: {
          notif_demo_1: {
            type: 'intervention_submitted',
            message: 'Nouveau bon N°2632 à valider — WZ2153S-15',
            interventionId: 2632,
            createdAt: now - 2 * HOUR,
            read: false
          }
        },
        uid_crimp: {
          notif_demo_2: {
            type: 'intervention_rejected',
            message: 'Ton bon N°2633 a été refusé ❌',
            interventionId: 2633,
            createdAt: now - 6 * HOUR,
            read: false
          },
          notif_demo_3: {
            type: 'intervention_validated',
            message: 'Ton bon N°2631 a été validé ✅',
            interventionId: 2631,
            createdAt: now - 2 * DAY,
            read: true
          }
        }
      }
    };
  }

  /* --------------------------------------------------------------------------
     EXPOSE window.firebase (remplace le vrai SDK)
     -------------------------------------------------------------------------- */
  window.firebase = {
    initializeApp: () => ({ name: 'leoni-demo' }),
    auth:     () => authMock,
    database: () => ({ ref }),
    storage:  () => storageMock
  };

  /* --------------------------------------------------------------------------
     OUTILS DE DEBUG (accessible dans la console)
     -------------------------------------------------------------------------- */
  window.demoDB = {
    reset: () => {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(AUTH_KEY);
      location.reload();
    },
    dump: () => console.log(JSON.parse(JSON.stringify(data))),
    data: () => data,
    seed: () => { data = seedData(); save(); location.reload(); }
  };

  /* --------------------------------------------------------------------------
     BANNIÈRE DÉMO + HINT LOGIN
     -------------------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => {
    // Bannière "DEMO MODE"
    const banner = document.createElement('div');
    banner.textContent = '🎭 MODE DÉMO — Données locales (localStorage). Aucune connexion Firebase.';
    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', right: '0',
      padding: '6px 16px', textAlign: 'center',
      background: 'linear-gradient(90deg, #f59e0b, #f97316)',
      color: '#0a0f1c', fontSize: '12px', fontWeight: '700',
      letterSpacing: '0.05em', textTransform: 'uppercase',
      zIndex: '9999', boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
    });
    document.body.appendChild(banner);
    document.body.style.paddingTop = '28px';

    // Hint sous le login
    const loginCard = document.querySelector('.login__card');
    if (loginCard) {
      const hint = document.createElement('div');
      hint.innerHTML = `
        <div style="margin-top:20px;padding:14px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:10px;font-size:12px;line-height:1.6;color:#a8b1c8">
          <strong style="color:#fbbf24;display:block;margin-bottom:6px">🎭 Comptes démo</strong>
          <div><strong>Admin :</strong> admin@leoni.com / admin</div>
          <div><strong>Crimping :</strong> crimp@leoni.com / crimp</div>
          <div><strong>Labo :</strong> labo@leoni.com / labo</div>
        </div>
      `;
      loginCard.appendChild(hint);
    }
  });

  console.log('%c🎭 LEONI DEMO MODE loaded', 'background:#f59e0b;color:#0a0f1c;padding:4px 8px;border-radius:4px;font-weight:bold');
  console.log('📧 admin@leoni.com / admin');
  console.log('📧 crimp@leoni.com / crimp');
  console.log('📧 labo@leoni.com  / labo');
  console.log('💡 Réinitialiser : demoDB.reset()');
})();

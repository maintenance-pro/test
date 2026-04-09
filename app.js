/* ============================================================================
   LEONI · BON D'INTERVENTION SERTISSAGE
   app.js — Logique principale (Firebase Auth + Realtime DB + Storage)
   ============================================================================ */

(function () {
  'use strict';

  /* ==========================================================================
     1. CONFIGURATION FIREBASE
     ⚠️ Remplace les valeurs par celles de TON projet Firebase :
        Console Firebase → Paramètres du projet → Tes applications → SDK
     ========================================================================== */
  const FIREBASE_CONFIG = {
    apiKey:            "REPLACE_WITH_YOUR_API_KEY",
    authDomain:        "leoni-sertissage-lab.firebaseapp.com",
    databaseURL:       "https://leoni-sertissage-lab-default-rtdb.firebaseio.com",
    projectId:         "leoni-sertissage-lab",
    storageBucket:     "leoni-sertissage-lab.appspot.com",
    messagingSenderId: "REPLACE_WITH_SENDER_ID",
    appId:             "REPLACE_WITH_APP_ID"
  };

  // Tolérances par défaut pour le calcul Cm/Cmk (à ajuster par outil/produit)
  const DEFAULT_TOLERANCES = {
    hauteurIsolant: { min: 1.40, max: 1.70 },
    effort:         { min: 40,   max: 70   }
  };

  /* ==========================================================================
     2. ÉTAT GLOBAL
     ========================================================================== */
  const state = {
    user: null,           // Firebase user
    profile: null,        // /users/{uid}
    role: 'viewer',
    tools: {},            // catalogue outils {id: {...}}
    interventions: {},    // tous les bons en cache
    currentInterventionId: null,
    currentView: 'login',
    filters: {
      tool: '', from: '', to: '', type: '', status: '', tech: ''
    },
    pagination: { page: 1, pageSize: 50 },
    sort: { field: 'numBon', dir: 'desc' },
    listeners: []         // unsubscribe functions
  };

  /* ==========================================================================
     3. UTILS
     ========================================================================== */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmt = {
    date: (ts) => {
      if (!ts) return '—';
      const d = new Date(ts);
      return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    },
    dateTime: (ts) => {
      if (!ts) return '—';
      const d = new Date(ts);
      return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    },
    number: (n, decimals = 0) => {
      if (n == null || isNaN(n)) return '—';
      return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    },
    duration: (ms) => {
      if (!ms) return '—';
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return h > 0 ? `${h}h ${m}min` : `${m}min`;
    },
    statusLabel: (s) => ({
      draft:     'Brouillon',
      submitted: 'En attente labo',
      validated: 'Validé',
      rejected:  'Refusé',
      cancelled: 'Annulé'
    }[s] || s)
  };

  const debounce = (fn, wait = 300) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  };

  /* ==========================================================================
     4. FIREBASE INIT
     ========================================================================== */
  let fbApp, fbAuth, fbDb, fbStorage;

  function initFirebase() {
    if (typeof firebase === 'undefined') {
      console.error('Firebase SDK manquant. Vérifie les <script> dans index.html.');
      ui.toast('Erreur : Firebase non chargé', 'danger');
      return;
    }
    fbApp     = firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth    = firebase.auth();
    fbDb      = firebase.database();
    fbStorage = firebase.storage();
    console.log('🔥 Firebase initialisé');
  }

  /* ==========================================================================
     5. UI HELPERS (toast, modal, loader)
     ========================================================================== */
  const ui = {
    toast(message, type = 'info', duration = 4000) {
      const container = $('#toast-container');
      if (!container) return;
      const t = document.createElement('div');
      t.className = `toast toast--${type}`;
      t.innerHTML = `<span>${this.escape(message)}</span>`;
      container.appendChild(t);
      setTimeout(() => {
        t.style.animation = 'toastIn 200ms reverse';
        setTimeout(() => t.remove(), 200);
      }, duration);
    },

    confirm(title, message) {
      return new Promise((resolve) => {
        const modal = $('#modal-confirm');
        $('#confirm-title').textContent = title;
        $('#confirm-message').textContent = message;
        modal.hidden = false;
        const ok = $('#confirm-ok');
        const close = (val) => {
          modal.hidden = true;
          ok.removeEventListener('click', onOk);
          modal.querySelectorAll('[data-close]').forEach(el => el.removeEventListener('click', onCancel));
          resolve(val);
        };
        const onOk = () => close(true);
        const onCancel = () => close(false);
        ok.addEventListener('click', onOk);
        modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', onCancel));
      });
    },

    showLoader(text = 'Chargement…') {
      $('#loader-text').textContent = text;
      $('#loader').hidden = false;
    },
    hideLoader() { $('#loader').hidden = true; },

    escape(str) {
      const div = document.createElement('div');
      div.textContent = String(str ?? '');
      return div.innerHTML;
    },

    showView(viewName) {
      $$('[data-view]').forEach(el => { el.hidden = (el.dataset.view !== viewName); });
      $$('.sidebar__link').forEach(el => {
        el.classList.toggle('sidebar__link--active', el.dataset.nav === viewName);
      });
      state.currentView = viewName;
      window.location.hash = viewName;
    },

    applyRoleVisibility() {
      $$('[data-requires-role]').forEach(el => {
        const allowed = el.dataset.requiresRole.split(',').map(s => s.trim());
        el.hidden = !allowed.includes(state.role);
      });
    }
  };

  /* ==========================================================================
     6. AUTH MODULE
     ========================================================================== */
  const auth = {
    init() {
      $('#form-login').addEventListener('submit', this.handleLogin.bind(this));
      $('#btn-toggle-pass').addEventListener('click', () => {
        const inp = $('#login-password');
        inp.type = inp.type === 'password' ? 'text' : 'password';
      });
      fbAuth.onAuthStateChanged(this.handleAuthChange.bind(this));
    },

    async handleLogin(e) {
      e.preventDefault();
      const email = $('#login-email').value.trim();
      const password = $('#login-password').value;
      const errEl = $('#login-error');
      errEl.hidden = true;
      ui.showLoader('Connexion…');
      try {
        await fbAuth.signInWithEmailAndPassword(email, password);
      } catch (err) {
        errEl.textContent = this.translateError(err.code);
        errEl.hidden = false;
        ui.hideLoader();
      }
    },

    async handleAuthChange(user) {
      if (user) {
        state.user = user;
        // Charger profil
        const snap = await fbDb.ref(`users/${user.uid}`).once('value');
        let profile = snap.val();
        // Si profil inexistant, créer un profil minimal (premier login)
        if (!profile) {
          profile = {
            uid: user.uid,
            email: user.email,
            displayName: user.email.split('@')[0],
            role: 'viewer',
            active: true,
            createdAt: Date.now()
          };
          await fbDb.ref(`users/${user.uid}`).set(profile);
        }
        if (!profile.active) {
          ui.toast('Compte désactivé. Contacte l\'administrateur.', 'danger');
          await fbAuth.signOut();
          return;
        }
        state.profile = profile;
        state.role = profile.role || 'viewer';

        // Maj dernière connexion
        fbDb.ref(`users/${user.uid}/lastLoginAt`).set(Date.now());

        // UI
        $('#view-login').hidden = true;
        $('#shell').hidden = false;
        this.updateUserBadge();
        ui.applyRoleVisibility();
        await app.loadInitialData();
        router.handleHash();
        ui.hideLoader();
        ui.toast(`Bienvenue ${profile.displayName}`, 'success');
      } else {
        state.user = null;
        state.profile = null;
        state.role = 'viewer';
        app.detachListeners();
        $('#view-login').hidden = false;
        $('#shell').hidden = true;
      }
    },

    updateUserBadge() {
      const p = state.profile;
      $('#user-name').textContent = p.displayName || '—';
      $('#user-role').textContent = p.role || '—';
      $('#user-avatar').textContent = (p.displayName || '?').charAt(0).toUpperCase();
      $('#hub-greeting').textContent = `Bienvenue ${p.displayName} — ${this.roleLabel(p.role)}`;
    },

    roleLabel(role) {
      return ({
        super_admin:      'Super Admin',
        responsable:      'Responsable Maintenance',
        crimping:         'Technicien Crimping',
        labo:             'Technicien Labo',
        viewer:           'Visiteur'
      }[role] || role);
    },

    translateError(code) {
      return ({
        'auth/invalid-email':       'Email invalide',
        'auth/user-disabled':       'Compte désactivé',
        'auth/user-not-found':      'Utilisateur introuvable',
        'auth/wrong-password':      'Mot de passe incorrect',
        'auth/invalid-credential':  'Identifiants invalides',
        'auth/too-many-requests':   'Trop de tentatives. Réessaie plus tard.',
        'auth/network-request-failed': 'Erreur réseau'
      }[code] || `Erreur : ${code}`);
    },

    async logout() {
      const ok = await ui.confirm('Déconnexion', 'Veux-tu vraiment te déconnecter ?');
      if (ok) {
        await fbAuth.signOut();
        ui.toast('Déconnecté', 'info');
      }
    },

    can(action) {
      const perms = {
        super_admin: ['*'],
        responsable: ['intervention.create','intervention.edit','intervention.delete','intervention.validate','intervention.reject','catalog.edit','user.read'],
        crimping:    ['intervention.create','intervention.edit'],
        labo:        ['intervention.validate','intervention.reject','intervention.editLab'],
        viewer:      []
      };
      const userPerms = perms[state.role] || [];
      return userPerms.includes('*') || userPerms.includes(action);
    }
  };

  /* ==========================================================================
     7. DATABASE MODULE (CRUD)
     ========================================================================== */
  const db = {
    /* --- counters --- */
    async getNextReg() {
      const ref = fbDb.ref('counters/registre');
      const result = await ref.transaction(current => (current || 0) + 1);
      return result.snapshot.val();
    },

    /* --- tools --- */
    listenTools() {
      const ref = fbDb.ref('tools');
      const handler = (snap) => {
        state.tools = snap.val() || {};
        views.intervention.refreshToolDatalist();
        if (state.currentView === 'catalog') views.catalog.render();
      };
      ref.on('value', handler);
      state.listeners.push(() => ref.off('value', handler));
    },

    async saveTool(tool) {
      const id = tool.id || (tool.outilId || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
      tool.id = id;
      tool.updatedAt = Date.now();
      tool.createdAt = tool.createdAt || Date.now();
      await fbDb.ref(`tools/${id}`).set(tool);
      return id;
    },

    async deleteTool(id) {
      await fbDb.ref(`tools/${id}`).remove();
    },

    /* --- interventions --- */
    listenInterventions() {
      const ref = fbDb.ref('interventions').orderByChild('numBon');
      const handler = (snap) => {
        state.interventions = snap.val() || {};
        views.hub.render();
        if (state.currentView === 'history') views.history.render();
        if (state.currentView === 'queue')   views.queue.render();
      };
      ref.on('value', handler);
      state.listeners.push(() => ref.off('value', handler));
    },

    async createIntervention(data) {
      const reg = await this.getNextReg();
      const now = Date.now();
      const intervention = {
        numBon: reg,
        qrCode: `LEONI-INT-${reg}`,
        status: 'draft',
        statusHistory: [{
          status: 'draft', at: now,
          by: state.user.uid, byName: state.profile.displayName
        }],
        tool: data.tool || {},
        crimping: {
          filledAt: now,
          filledBy: { uid: state.user.uid, name: state.profile.displayName, matricule: state.profile.matricule || '' },
          date: data.date || now,
          cycles: data.cycles || 0,
          type: data.type || 'preventive',
          piecesChanged: data.piecesChanged || {},
          observation: data.observation || '',
          cyclesPhotoUrl: data.cyclesPhotoUrl || null,
          signatureUrl: data.signatureUrl || null
        },
        lab: null,
        sla: { submittedAt: null, decidedAt: null, durationMs: null },
        locked: false,
        createdAt: now,
        updatedAt: now,
        _indexes: {
          yearMonth: new Date(now).toISOString().slice(0, 7),
          toolId: (data.tool && data.tool.toolId) || '',
          status: 'draft'
        }
      };
      await fbDb.ref(`interventions/${reg}`).set(intervention);
      this.audit('intervention.create', reg);
      return reg;
    },

    async updateIntervention(reg, partial) {
      partial.updatedAt = Date.now();
      await fbDb.ref(`interventions/${reg}`).update(partial);
      this.audit('intervention.update', reg);
    },

    async submitToLab(reg) {
      const now = Date.now();
      const ref = fbDb.ref(`interventions/${reg}`);
      const snap = await ref.once('value');
      const data = snap.val();
      if (!data) throw new Error('Bon introuvable');
      const history = data.statusHistory || [];
      history.push({ status: 'submitted', at: now, by: state.user.uid, byName: state.profile.displayName });
      await ref.update({
        status: 'submitted',
        statusHistory: history,
        'sla/submittedAt': now,
        '_indexes/status': 'submitted',
        updatedAt: now
      });
      this.audit('intervention.submit', reg);
      this.notifyLab(reg);
    },

    async validateIntervention(reg, labData) {
      const now = Date.now();
      const ref = fbDb.ref(`interventions/${reg}`);
      const snap = await ref.once('value');
      const data = snap.val();
      const submittedAt = (data.sla && data.sla.submittedAt) || now;
      const history = data.statusHistory || [];
      history.push({ status: 'validated', at: now, by: state.user.uid, byName: state.profile.displayName });
      await ref.update({
        status: 'validated',
        statusHistory: history,
        lab: {
          ...labData,
          filledAt: now,
          filledBy: { uid: state.user.uid, name: state.profile.displayName, matricule: state.profile.matricule || '' },
          decision: 'validated'
        },
        'sla/decidedAt': now,
        'sla/durationMs': now - submittedAt,
        '_indexes/status': 'validated',
        locked: true,
        updatedAt: now
      });
      this.audit('intervention.validate', reg);
      this.notifyCrimping(reg, 'validated');
    },

    async rejectIntervention(reg, reason) {
      const now = Date.now();
      const ref = fbDb.ref(`interventions/${reg}`);
      const snap = await ref.once('value');
      const data = snap.val();
      const submittedAt = (data.sla && data.sla.submittedAt) || now;
      const history = data.statusHistory || [];
      history.push({ status: 'rejected', at: now, by: state.user.uid, byName: state.profile.displayName, reason });
      await ref.update({
        status: 'rejected',
        statusHistory: history,
        'lab/decision': 'rejected',
        'lab/rejectReason': reason,
        'lab/filledBy': { uid: state.user.uid, name: state.profile.displayName },
        'sla/decidedAt': now,
        'sla/durationMs': now - submittedAt,
        '_indexes/status': 'rejected',
        updatedAt: now
      });
      this.audit('intervention.reject', reg);
      this.notifyCrimping(reg, 'rejected', reason);
    },

    async deleteIntervention(reg) {
      await fbDb.ref(`interventions/${reg}`).remove();
      this.audit('intervention.delete', reg);
    },

    /* --- audit & notifications --- */
    audit(action, entityId, extra = {}) {
      const log = {
        timestamp: Date.now(),
        uid: state.user.uid,
        userName: state.profile.displayName,
        action,
        entity: `interventions/${entityId}`,
        ...extra
      };
      fbDb.ref('auditLog').push(log);
    },

    async notifyLab(reg) {
      const usersSnap = await fbDb.ref('users').orderByChild('role').equalTo('labo').once('value');
      const labUsers = usersSnap.val() || {};
      Object.keys(labUsers).forEach(uid => {
        fbDb.ref(`notifications/${uid}`).push({
          type: 'intervention_submitted',
          message: `Nouveau bon N°${reg} à valider`,
          interventionId: reg,
          createdAt: Date.now(),
          read: false
        });
      });
    },

    async notifyCrimping(reg, decision, reason = null) {
      const intSnap = await fbDb.ref(`interventions/${reg}/crimping/filledBy/uid`).once('value');
      const uid = intSnap.val();
      if (!uid) return;
      fbDb.ref(`notifications/${uid}`).push({
        type: `intervention_${decision}`,
        message: decision === 'validated'
          ? `Ton bon N°${reg} a été validé ✅`
          : `Ton bon N°${reg} a été refusé : ${reason}`,
        interventionId: reg,
        createdAt: Date.now(),
        read: false
      });
    },

    listenNotifications() {
      if (!state.user) return;
      const ref = fbDb.ref(`notifications/${state.user.uid}`).orderByChild('createdAt').limitToLast(20);
      const handler = (snap) => {
        const notifs = [];
        snap.forEach(child => notifs.push({ id: child.key, ...child.val() }));
        notifs.reverse();
        const unread = notifs.filter(n => !n.read).length;
        const badge = $('#notif-badge');
        badge.textContent = unread;
        badge.hidden = unread === 0;
        views.notifications.render(notifs);
      };
      ref.on('value', handler);
      state.listeners.push(() => ref.off('value', handler));
    }
  };

  /* ==========================================================================
     8. STORAGE MODULE
     ========================================================================== */
  const storage = {
    async upload(path, file) {
      const ref = fbStorage.ref(path);
      const snap = await ref.put(file);
      const url = await snap.ref.getDownloadURL();
      return { path, url };
    },
    async uploadCoupe(reg, file) {
      const year = new Date().getFullYear();
      const ext = file.name.split('.').pop();
      return this.upload(`coupes/${year}/${reg}.${ext}`, file);
    },
    async uploadCyclesPhoto(reg, file) {
      return this.upload(`cycles/${reg}.jpg`, file);
    },
    async uploadSignature(reg, kind, dataUrl) {
      const blob = await (await fetch(dataUrl)).blob();
      return this.upload(`signatures/${kind}_${reg}.png`, blob);
    }
  };

  /* ==========================================================================
     9. ROUTER
     ========================================================================== */
  const router = {
    init() {
      window.addEventListener('hashchange', () => this.handleHash());
      $$('[data-nav]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          this.go(el.dataset.nav);
        });
      });
    },
    go(view) {
      window.location.hash = view;
    },
    handleHash() {
      const hash = window.location.hash.replace('#', '') || 'hub';
      const valid = ['hub','intervention','history','queue','catalog','users','stats'];
      const view = valid.includes(hash) ? hash : 'hub';
      ui.showView(view);
      if (views[view] && views[view].render) views[view].render();
    }
  };

  /* ==========================================================================
     10. CAPABILITY CALCULATIONS (Cm/Cmk)
     ========================================================================== */
  const capa = {
    mean(arr) {
      const valid = arr.filter(x => !isNaN(x) && x !== null);
      if (!valid.length) return null;
      return valid.reduce((a, b) => a + b, 0) / valid.length;
    },
    stdDev(arr) {
      const m = this.mean(arr);
      if (m == null) return null;
      const valid = arr.filter(x => !isNaN(x) && x !== null);
      if (valid.length < 2) return null;
      const variance = valid.reduce((sum, x) => sum + Math.pow(x - m, 2), 0) / (valid.length - 1);
      return Math.sqrt(variance);
    },
    cm(arr, tol) {
      const sigma = this.stdDev(arr);
      if (!sigma || sigma === 0) return null;
      return (tol.max - tol.min) / (6 * sigma);
    },
    cmk(arr, tol) {
      const m = this.mean(arr);
      const sigma = this.stdDev(arr);
      if (!sigma || sigma === 0 || m == null) return null;
      return Math.min((m - tol.min), (tol.max - m)) / (3 * sigma);
    },
    compute(measures, tolerances = DEFAULT_TOLERANCES) {
      const hi = (measures.hauteurIsolant || []).map(Number);
      const ef = (measures.effort || []).map(Number);
      return {
        hauteurAmeMoyenne: this.mean(hi),
        cmAme:    this.cm(hi, tolerances.hauteurIsolant),
        cmkAme:   this.cmk(hi, tolerances.hauteurIsolant),
        cmEffort: this.cm(ef, tolerances.effort)
      };
    }
  };

  /* ==========================================================================
     11. SIGNATURE PAD
     ========================================================================== */
  function initSignaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let last = null;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#0a0f1c';
    };
    resize();
    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    };
    const start = (e) => { drawing = true; last = pos(e); e.preventDefault(); };
    const move = (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      e.preventDefault();
    };
    const end = () => { drawing = false; };
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    return {
      clear: () => ctx.clearRect(0, 0, canvas.width, canvas.height),
      isEmpty: () => {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        return !data.some(v => v !== 0);
      },
      toDataURL: () => canvas.toDataURL('image/png')
    };
  }

  /* ==========================================================================
     12. QR CODE (minimal — texte centré sur canvas)
     ========================================================================== */
  function drawQrPlaceholder(canvas, text) {
    const ctx = canvas.getContext('2d');
    canvas.width = 80; canvas.height = 80;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 80, 80);
    ctx.fillStyle = '#0a0f1c';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 40, 40);
    // Pour un vrai QR : intégrer la lib qrcode-generator depuis CDN
  }

  /* ==========================================================================
     13. VIEWS
     ========================================================================== */
  const views = {

    /* ========== HUB ========== */
    hub: {
      render() {
        const list = Object.values(state.interventions);
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const monthList = list.filter(i => (i.createdAt || 0) >= monthStart);
        const pending = list.filter(i => i.status === 'submitted');
        const validated = monthList.filter(i => i.status === 'validated');
        const rejected = monthList.filter(i => i.status === 'rejected');
        const slas = list.filter(i => i.sla && i.sla.durationMs).map(i => i.sla.durationMs);
        const avgSla = slas.length ? slas.reduce((a, b) => a + b, 0) / slas.length : 0;

        $('#kpi-month').textContent = monthList.length;
        $('#kpi-pending').textContent = pending.length;
        $('#kpi-validated').textContent = validated.length;
        $('#kpi-rejected').textContent = rejected.length;
        $('#kpi-sla').textContent = fmt.duration(avgSla);

        const validRate = monthList.length ? Math.round(validated.length / monthList.length * 100) : 0;
        $('#kpi-validated-rate').textContent = `${validRate}% du mois`;

        // Sidebar pills
        $('#nav-history-count').textContent = list.length;
        $('#nav-queue-count').textContent = pending.length;

        // Queue urgente
        const queueList = $('#queue-list');
        queueList.innerHTML = pending.slice(0, 5).map(i => `
          <li data-reg="${i.numBon}">
            <span class="status-pill status-pill--submitted"></span>
            <strong>N°${i.numBon}</strong>
            <span>${ui.escape(i.tool && i.tool.outilId || '—')}</span>
            <span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-xs)">${fmt.dateTime(i.createdAt)}</span>
          </li>
        `).join('') || '<li style="color:var(--text-muted)">Aucun bon en attente 🎉</li>';

        queueList.querySelectorAll('li[data-reg]').forEach(li => {
          li.addEventListener('click', () => views.intervention.open(li.dataset.reg));
        });

        // Top outils
        const toolStats = {};
        list.forEach(i => {
          const k = (i.tool && i.tool.outilId) || 'Inconnu';
          toolStats[k] = (toolStats[k] || 0) + 1;
        });
        const top = Object.entries(toolStats).sort((a, b) => b[1] - a[1]).slice(0, 5);
        $('#top-tools-list').innerHTML = top.map(([k, v]) => `
          <li><strong>${ui.escape(k)}</strong><span style="margin-left:auto">${v} interventions</span></li>
        `).join('') || '<li style="color:var(--text-muted)">Pas de données</li>';

        // Activity feed (5 dernières)
        const recent = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5);
        $('#activity-feed').innerHTML = recent.map(i => `
          <li>
            <span class="status-pill status-pill--${i.status}"></span>
            <span>N°${i.numBon} · ${ui.escape(i.tool && i.tool.outilId || '—')}</span>
            <span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-xs)">${fmt.dateTime(i.updatedAt)}</span>
          </li>
        `).join('') || '<li style="color:var(--text-muted)">Aucune activité</li>';
      }
    },

    /* ========== INTERVENTION ========== */
    intervention: {
      crimpPad: null,
      labPad: null,
      currentToolKey: null,

      init() {
        // Init signature pads
        this.crimpPad = initSignaturePad($('#sign-crimp-pad'));
        this.labPad = initSignaturePad($('#sign-lab-pad'));
        $('#btn-sign-crimp-clear').addEventListener('click', () => this.crimpPad.clear());
        $('#btn-sign-lab-clear').addEventListener('click', () => this.labPad.clear());

        // Tool autocomplete
        $('#int-tool-search').addEventListener('input', debounce(() => this.onToolSelected(), 200));

        // Auto-calc capabilité
        const measureInputs = $$('.measure-table__input');
        measureInputs.forEach(inp => inp.addEventListener('input', debounce(() => this.recalcCapa(), 200)));

        // Counter observation
        const obs = $('#int-observation');
        obs.addEventListener('input', () => {
          $('#obs-counter').textContent = `${obs.value.length} / 1000`;
        });

        // Boutons d'action
        $('#btn-int-save').addEventListener('click', () => this.save('draft'));
        $('#form-intervention').addEventListener('submit', (e) => { e.preventDefault(); this.save('submit'); });
        $('#btn-validate').addEventListener('click', () => this.validate());
        $('#btn-reject').addEventListener('click', () => this.reject());
        $('#btn-int-delete').addEventListener('click', () => this.delete());
        $('#btn-int-back').addEventListener('click', () => router.go('history'));
        $('#btn-int-print').addEventListener('click', () => window.print());

        // Photo cycles
        $('#upload-cycles .upload__btn').addEventListener('click', () => $('#file-cycles').click());
        $('#upload-coupe .upload__btn').addEventListener('click', () => $('#file-coupe').click());

        // Quick new
        $('#btn-quick-new').addEventListener('click', () => this.newBlank());
      },

      newBlank() {
        state.currentInterventionId = null;
        $('#form-intervention').reset();
        $('#int-num').textContent = '— (nouveau)';
        $('#int-created').textContent = fmt.dateTime(Date.now());
        $('#int-date').valueAsDate = new Date();
        this.setStatus('draft');
        this.crimpPad.clear();
        this.labPad.clear();
        this.clearToolCard();
        $('#int-timeline').innerHTML = '';
        router.go('intervention');
        ui.applyRoleVisibility();
        // Active la section labo selon le rôle (visible mais disabled tant que pas submitted)
        $('#section-lab').disabled = true;
      },

      open(reg) {
        const data = state.interventions[reg];
        if (!data) { ui.toast('Bon introuvable', 'danger'); return; }
        state.currentInterventionId = reg;

        $('#int-num').textContent = data.numBon;
        $('#int-created').textContent = fmt.dateTime(data.createdAt);
        this.setStatus(data.status);
        drawQrPlaceholder($('#int-qrcode'), `#${data.numBon}`);

        // Outil
        if (data.tool) {
          $('#int-tool-search').value = data.tool.refOutil || '';
          $('#int-outil-id').value = data.tool.outilId || '';
          $('#int-fabricant').value = data.tool.fabricant || '';
          this.fillToolCard(data.tool);
        }

        // Crimping
        if (data.crimping) {
          $('#int-date').value = data.crimping.date ? new Date(data.crimping.date).toISOString().slice(0, 10) : '';
          $('#int-cycles').value = data.crimping.cycles || '';
          $('#int-type').value = data.crimping.type || '';
          $('#int-observation').value = data.crimping.observation || '';
          $('#obs-counter').textContent = `${(data.crimping.observation || '').length} / 1000`;
          $$('input[name="piece"]').forEach(cb => {
            cb.checked = !!(data.crimping.piecesChanged && data.crimping.piecesChanged[cb.value]);
          });
        }

        // Lab
        const lab = data.lab || {};
        const labSection = $('#section-lab');
        // Débloquer la section labo si on est au moins submitted ET utilisateur labo/admin
        const canEditLab = ['submitted'].includes(data.status) && auth.can('intervention.editLab');
        labSection.disabled = !canEditLab && data.status !== 'validated' && data.status !== 'rejected';

        if (lab.connexion) {
          $('#lab-ref-connexion').value = lab.connexion.refConnexion || '';
          $('#lab-section-cable').value = lab.connexion.sectionCable || '';
          $('#lab-indice').value = lab.connexion.indiceParametrique || '';
        }
        if (lab.mesures) {
          $('#lab-largeur-ame').value = lab.mesures.largeurAme || '';
          $('#lab-largeur-isolant').value = lab.mesures.largeurIsolant || '';
          (lab.mesures.hauteurIsolant || []).forEach((v, i) => {
            const inp = $(`[name="hi${i+1}"]`); if (inp) inp.value = v;
          });
          (lab.mesures.effort || []).forEach((v, i) => {
            const inp = $(`[name="ef${i+1}"]`); if (inp) inp.value = v;
          });
        }
        if (lab.conformites) {
          $$('input[name="conf"]').forEach(cb => { cb.checked = !!lab.conformites[cb.value]; });
        }
        $('#lab-chute-tension').value = (lab.capabilite && lab.capabilite.chuteTension) || '';
        this.recalcCapa();

        // Coupe metallo link
        if (lab.coupeMetallo && lab.coupeMetallo.downloadUrl) {
          const link = $('#link-coupe');
          link.href = lab.coupeMetallo.downloadUrl;
          link.hidden = false;
          $('#preview-coupe').textContent = lab.coupeMetallo.fileName || 'Fichier joint';
        }

        // Timeline
        this.renderTimeline(data.statusHistory || []);

        router.go('intervention');
      },

      fillToolCard(tool) {
        $('#tc-ref-fab').textContent = tool.refFabricant || '—';
        $('#tc-par').textContent = (tool.pieces && tool.pieces.pAr) || '—';
        $('#tc-pav').textContent = (tool.pieces && tool.pieces.pAv) || '—';
        $('#tc-ear').textContent = (tool.pieces && tool.pieces.eAr) || '—';
        $('#tc-eav').textContent = (tool.pieces && tool.pieces.eAv) || '—';
        $('#tool-cycle').textContent = `${fmt.number(tool.frequenceCycle || 0)} cycles`;
      },
      clearToolCard() {
        ['tc-ref-fab','tc-par','tc-pav','tc-ear','tc-eav'].forEach(id => $('#'+id).textContent = '—');
        $('#tool-cycle').textContent = '— cycles';
      },

      onToolSelected() {
        const val = $('#int-tool-search').value.trim().toLowerCase();
        if (!val) return this.clearToolCard();
        const found = Object.values(state.tools).find(t =>
          (t.refOutil || '').toLowerCase() === val ||
          (t.outilId || '').toLowerCase() === val
        );
        if (found) {
          $('#int-outil-id').value = found.outilId || '';
          $('#int-fabricant').value = found.fabricant || '';
          this.fillToolCard(found);
          this.currentToolKey = found.id;
        }
      },

      refreshToolDatalist() {
        const dl = $('#datalist-tools');
        if (!dl) return;
        dl.innerHTML = Object.values(state.tools).map(t =>
          `<option value="${ui.escape(t.refOutil || '')}">${ui.escape(t.outilId || '')}</option>`
        ).join('');
      },

      recalcCapa() {
        const hi = [1,2,3,4,5].map(i => parseFloat($(`[name="hi${i}"]`).value));
        const ef = [1,2,3,4,5].map(i => parseFloat($(`[name="ef${i}"]`).value));
        const result = capa.compute({ hauteurIsolant: hi, effort: ef });
        $('#capa-ame-moy').textContent = result.hauteurAmeMoyenne != null ? result.hauteurAmeMoyenne.toFixed(3) : '—';
        $('#capa-cm').textContent      = result.cmAme    != null ? result.cmAme.toFixed(2) : '—';
        $('#capa-cmk').textContent     = result.cmkAme   != null ? result.cmkAme.toFixed(2) : '—';
        $('#capa-cm-effort').textContent = result.cmEffort != null ? result.cmEffort.toFixed(2) : '—';
      },

      setStatus(status) {
        $$('#int-status .status-pill').forEach(p => { p.hidden = (p.dataset.status !== status); });
        // Stepper
        const order = { draft: 1, submitted: 2, validated: 4, rejected: 4, cancelled: 4 };
        const step = order[status] || 1;
        $$('.stepper__step').forEach((el, idx) => {
          el.classList.toggle('stepper__step--active', (idx + 1) <= step);
        });
      },

      renderTimeline(history) {
        $('#int-timeline').innerHTML = history.map(h => `
          <li>
            <strong>${fmt.statusLabel(h.status)}</strong>
            par ${ui.escape(h.byName || '—')} —
            <span style="color:var(--text-muted)">${fmt.dateTime(h.at)}</span>
            ${h.reason ? `<br><em style="color:var(--danger-500)">Motif: ${ui.escape(h.reason)}</em>` : ''}
          </li>
        `).join('');
      },

      collectCrimpingData() {
        const pieces = {};
        $$('input[name="piece"]').forEach(cb => { pieces[cb.value] = cb.checked; });
        return {
          tool: {
            toolId: this.currentToolKey || '',
            refOutil: $('#int-tool-search').value,
            outilId: $('#int-outil-id').value,
            fabricant: $('#int-fabricant').value,
            refFabricant: $('#tc-ref-fab').textContent
          },
          date: $('#int-date').value ? new Date($('#int-date').value).getTime() : Date.now(),
          cycles: parseInt($('#int-cycles').value) || 0,
          type: $('#int-type').value,
          piecesChanged: pieces,
          observation: $('#int-observation').value
        };
      },

      collectLabData() {
        const conf = {};
        $$('input[name="conf"]').forEach(cb => { conf[cb.value] = cb.checked; });
        const hi = [1,2,3,4,5].map(i => parseFloat($(`[name="hi${i}"]`).value) || null);
        const ef = [1,2,3,4,5].map(i => parseFloat($(`[name="ef${i}"]`).value) || null);
        const computed = capa.compute({ hauteurIsolant: hi, effort: ef });
        return {
          connexion: {
            refConnexion: $('#lab-ref-connexion').value,
            sectionCable: $('#lab-section-cable').value,
            indiceParametrique: $('#lab-indice').value
          },
          mesures: {
            largeurAme: parseFloat($('#lab-largeur-ame').value) || null,
            largeurIsolant: parseFloat($('#lab-largeur-isolant').value) || null,
            hauteurIsolant: hi,
            effort: ef
          },
          capabilite: {
            ...computed,
            chuteTension: parseFloat($('#lab-chute-tension').value) || null
          },
          conformites: conf
        };
      },

      async save(mode) {
        if (!auth.can('intervention.create') && !auth.can('intervention.edit')) {
          return ui.toast('Accès refusé', 'danger');
        }
        ui.showLoader('Enregistrement…');
        try {
          const data = this.collectCrimpingData();
          if (!data.tool.refOutil || !data.tool.outilId) {
            ui.hideLoader();
            return ui.toast('Référence outil obligatoire', 'warn');
          }
          let reg = state.currentInterventionId;
          if (!reg) {
            reg = await db.createIntervention(data);
            state.currentInterventionId = reg;
          } else {
            await db.updateIntervention(reg, {
              tool: data.tool,
              'crimping/date': data.date,
              'crimping/cycles': data.cycles,
              'crimping/type': data.type,
              'crimping/piecesChanged': data.piecesChanged,
              'crimping/observation': data.observation
            });
          }
          // Upload signature crimping si présente
          if (!this.crimpPad.isEmpty()) {
            const sig = await storage.uploadSignature(reg, 'crimp', this.crimpPad.toDataURL());
            await db.updateIntervention(reg, { 'crimping/signatureUrl': sig.url });
          }
          // Upload photo cycles si présente
          const cycleFile = $('#file-cycles').files[0];
          if (cycleFile) {
            const ph = await storage.uploadCyclesPhoto(reg, cycleFile);
            await db.updateIntervention(reg, { 'crimping/cyclesPhotoUrl': ph.url });
          }
          if (mode === 'submit') {
            await db.submitToLab(reg);
            ui.toast(`Bon N°${reg} soumis au labo ✅`, 'success');
            this.setStatus('submitted');
          } else {
            ui.toast(`Brouillon N°${reg} enregistré`, 'success');
          }
          $('#int-num').textContent = reg;
        } catch (err) {
          console.error(err);
          ui.toast('Erreur : ' + err.message, 'danger');
        } finally {
          ui.hideLoader();
        }
      },

      async validate() {
        if (!auth.can('intervention.validate')) return ui.toast('Accès refusé', 'danger');
        const reg = state.currentInterventionId;
        if (!reg) return ui.toast('Aucun bon ouvert', 'warn');
        ui.showLoader('Validation…');
        try {
          const labData = this.collectLabData();
          // Upload coupe metallo si fichier
          const coupeFile = $('#file-coupe').files[0];
          if (coupeFile) {
            const up = await storage.uploadCoupe(reg, coupeFile);
            labData.coupeMetallo = {
              fileName: coupeFile.name,
              storagePath: up.path,
              downloadUrl: up.url,
              uploadedAt: Date.now()
            };
          }
          // Upload signature labo
          if (!this.labPad.isEmpty()) {
            const sig = await storage.uploadSignature(reg, 'lab', this.labPad.toDataURL());
            labData.signatureUrl = sig.url;
          }
          await db.validateIntervention(reg, labData);
          ui.toast(`Bon N°${reg} validé ✅`, 'success');
          this.setStatus('validated');
        } catch (err) {
          console.error(err);
          ui.toast('Erreur : ' + err.message, 'danger');
        } finally {
          ui.hideLoader();
        }
      },

      async reject() {
        if (!auth.can('intervention.reject')) return ui.toast('Accès refusé', 'danger');
        const reg = state.currentInterventionId;
        if (!reg) return;
        // Ouvre modal refus
        const modal = $('#modal-reject');
        modal.hidden = false;
        const onConfirm = async () => {
          const reason = $('#reject-reason').value.trim();
          if (!reason) return ui.toast('Le motif est obligatoire', 'warn');
          modal.hidden = true;
          $('#reject-reason').value = '';
          ui.showLoader('Refus en cours…');
          try {
            await db.rejectIntervention(reg, reason);
            ui.toast(`Bon N°${reg} refusé`, 'warn');
            this.setStatus('rejected');
          } catch (err) {
            ui.toast('Erreur : ' + err.message, 'danger');
          } finally {
            ui.hideLoader();
          }
          $('#btn-confirm-reject').removeEventListener('click', onConfirm);
        };
        $('#btn-confirm-reject').addEventListener('click', onConfirm);
        modal.querySelectorAll('[data-close]').forEach(el => {
          el.addEventListener('click', () => { modal.hidden = true; }, { once: true });
        });
      },

      async delete() {
        if (!auth.can('intervention.delete')) return ui.toast('Accès refusé', 'danger');
        const reg = state.currentInterventionId;
        if (!reg) return;
        const ok = await ui.confirm('Supprimer le bon', `Le bon N°${reg} sera supprimé définitivement. Continuer ?`);
        if (!ok) return;
        ui.showLoader('Suppression…');
        try {
          await db.deleteIntervention(reg);
          ui.toast('Bon supprimé', 'info');
          state.currentInterventionId = null;
          router.go('history');
        } catch (err) {
          ui.toast('Erreur : ' + err.message, 'danger');
        } finally {
          ui.hideLoader();
        }
      }
    },

    /* ========== HISTORY ========== */
    history: {
      init() {
        const filterIds = ['filter-tool','filter-from','filter-to','filter-type','filter-status','filter-tech'];
        filterIds.forEach(id => {
          $('#'+id).addEventListener('input', debounce(() => this.applyFilters(), 300));
        });
        $('#btn-filter-reset').addEventListener('click', () => this.resetFilters());
        $('#btn-filter-export').addEventListener('click', () => this.exportExcel());
        $('#btn-filter-print').addEventListener('click', () => window.print());
        $('#page-prev').addEventListener('click', () => this.changePage(-1));
        $('#page-next').addEventListener('click', () => this.changePage(1));
        $('#page-size').addEventListener('change', (e) => {
          state.pagination.pageSize = parseInt(e.target.value);
          state.pagination.page = 1;
          this.render();
        });
        $$('#history-table thead th[data-sort]').forEach(th => {
          th.addEventListener('click', () => {
            const f = th.dataset.sort;
            state.sort = { field: f, dir: state.sort.field === f && state.sort.dir === 'asc' ? 'desc' : 'asc' };
            this.render();
          });
        });
      },

      applyFilters() {
        state.filters = {
          tool:   $('#filter-tool').value.trim().toLowerCase(),
          from:   $('#filter-from').value,
          to:     $('#filter-to').value,
          type:   $('#filter-type').value,
          status: $('#filter-status').value,
          tech:   $('#filter-tech').value.trim().toLowerCase()
        };
        state.pagination.page = 1;
        this.render();
      },

      resetFilters() {
        ['filter-tool','filter-from','filter-to','filter-type','filter-status','filter-tech'].forEach(id => {
          $('#'+id).value = '';
        });
        this.applyFilters();
      },

      changePage(delta) {
        state.pagination.page += delta;
        this.render();
      },

      getFiltered() {
        let list = Object.values(state.interventions);
        const f = state.filters;
        if (f.tool)   list = list.filter(i => ((i.tool && i.tool.outilId) || '').toLowerCase().includes(f.tool));
        if (f.from)   { const ts = new Date(f.from).getTime(); list = list.filter(i => (i.crimping && i.crimping.date) >= ts); }
        if (f.to)     { const ts = new Date(f.to).getTime() + 86400000; list = list.filter(i => (i.crimping && i.crimping.date) <= ts); }
        if (f.type)   list = list.filter(i => i.crimping && i.crimping.type === f.type);
        if (f.status) list = list.filter(i => i.status === f.status);
        if (f.tech)   list = list.filter(i => ((i.crimping && i.crimping.filledBy && i.crimping.filledBy.name) || '').toLowerCase().includes(f.tech));

        // Sort
        const { field, dir } = state.sort;
        list.sort((a, b) => {
          let va, vb;
          if (field === 'numBon') { va = a.numBon; vb = b.numBon; }
          else if (field === 'outilId') { va = (a.tool && a.tool.outilId) || ''; vb = (b.tool && b.tool.outilId) || ''; }
          else if (field === 'date')    { va = (a.crimping && a.crimping.date) || 0; vb = (b.crimping && b.crimping.date) || 0; }
          else if (field === 'cycles')  { va = (a.crimping && a.crimping.cycles) || 0; vb = (b.crimping && b.crimping.cycles) || 0; }
          else if (field === 'type')    { va = (a.crimping && a.crimping.type) || ''; vb = (b.crimping && b.crimping.type) || ''; }
          else if (field === 'status')  { va = a.status; vb = b.status; }
          else { va = 0; vb = 0; }
          if (va < vb) return dir === 'asc' ? -1 : 1;
          if (va > vb) return dir === 'asc' ? 1 : -1;
          return 0;
        });
        return list;
      },

      render() {
        const list = this.getFiltered();
        const { page, pageSize } = state.pagination;
        const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
        if (state.pagination.page > totalPages) state.pagination.page = totalPages;
        const start = (state.pagination.page - 1) * pageSize;
        const slice = list.slice(start, start + pageSize);

        const tbody = $('#history-body');
        tbody.innerHTML = slice.map(i => {
          const c = i.crimping || {};
          const lab = i.lab || {};
          const coupe = lab.coupeMetallo;
          return `
            <tr data-reg="${i.numBon}">
              <td><input type="checkbox" data-reg="${i.numBon}" /></td>
              <td><strong>${i.numBon}</strong></td>
              <td>${ui.escape((i.tool && i.tool.outilId) || '—')}</td>
              <td>${fmt.date(c.date)}</td>
              <td>${fmt.number(c.cycles)}</td>
              <td>${ui.escape(c.type || '—')}</td>
              <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${ui.escape(c.observation || '')}">${ui.escape(c.observation || '—')}</td>
              <td>${coupe && coupe.downloadUrl ? `<a href="${coupe.downloadUrl}" target="_blank" rel="noopener">📎 ${ui.escape(coupe.fileName || 'Fichier')}</a>` : '—'}</td>
              <td><span class="status-pill status-pill--${i.status}">${fmt.statusLabel(i.status)}</span></td>
              <td>
                <button class="btn btn--ghost" data-action="open" data-reg="${i.numBon}">Ouvrir</button>
              </td>
            </tr>
          `;
        }).join('');

        tbody.querySelectorAll('[data-action="open"]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            views.intervention.open(btn.dataset.reg);
          });
        });
        tbody.querySelectorAll('tr[data-reg]').forEach(tr => {
          tr.addEventListener('click', () => views.intervention.open(tr.dataset.reg));
        });

        $('#history-total').textContent = `${list.length} résultat${list.length > 1 ? 's' : ''}`;
        $('#page-info').textContent = `${state.pagination.page} / ${totalPages}`;
      },

      exportExcel() {
        const list = this.getFiltered();
        const headers = ['N°Bon','OUTIL','Date','Cycles','Type','Observation','Statut','Technicien Crimping','Technicien Labo','Cm','Cmk'];
        const rows = list.map(i => {
          const c = i.crimping || {};
          const lab = i.lab || {};
          const cap = lab.capabilite || {};
          return [
            i.numBon,
            (i.tool && i.tool.outilId) || '',
            fmt.date(c.date),
            c.cycles || '',
            c.type || '',
            (c.observation || '').replace(/[\n\r;]/g, ' '),
            fmt.statusLabel(i.status),
            (c.filledBy && c.filledBy.name) || '',
            (lab.filledBy && lab.filledBy.name) || '',
            cap.cmAme != null ? cap.cmAme.toFixed(2) : '',
            cap.cmkAme != null ? cap.cmkAme.toFixed(2) : ''
          ];
        });
        const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(';')).join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `leoni_sertissage_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        ui.toast('Export CSV téléchargé', 'success');
      }
    },

    /* ========== QUEUE ========== */
    queue: {
      currentTab: 'all',
      init() {
        $$('.queue-view__tabs .tab').forEach(t => {
          t.addEventListener('click', () => {
            $$('.queue-view__tabs .tab').forEach(x => x.classList.remove('tab--active'));
            t.classList.add('tab--active');
            this.currentTab = t.dataset.tab;
            this.render();
          });
        });
      },
      render() {
        let list = Object.values(state.interventions);
        if (this.currentTab === 'mine') {
          list = list.filter(i => (i.crimping && i.crimping.filledBy && i.crimping.filledBy.uid) === state.user.uid);
        } else if (this.currentTab === 'todo') {
          list = list.filter(i => i.status === 'submitted');
        } else if (this.currentTab === 'rejected') {
          list = list.filter(i => i.status === 'rejected');
        }
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const grid = $('#queue-cards');
        grid.innerHTML = list.map(i => `
          <article class="card" style="padding:var(--sp-5);cursor:pointer" data-reg="${i.numBon}">
            <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-3)">
              <strong style="font-size:var(--fs-lg)">N°${i.numBon}</strong>
              <span class="status-pill status-pill--${i.status}">${fmt.statusLabel(i.status)}</span>
            </header>
            <div style="color:var(--text-secondary);font-size:var(--fs-sm)">
              <div>🛠 ${ui.escape((i.tool && i.tool.outilId) || '—')}</div>
              <div>📅 ${fmt.date(i.crimping && i.crimping.date)}</div>
              <div>👤 ${ui.escape((i.crimping && i.crimping.filledBy && i.crimping.filledBy.name) || '—')}</div>
            </div>
          </article>
        `).join('') || '<p style="color:var(--text-muted)">Aucun bon dans cette catégorie</p>';
        grid.querySelectorAll('[data-reg]').forEach(el => {
          el.addEventListener('click', () => views.intervention.open(el.dataset.reg));
        });
      }
    },

    /* ========== CATALOG ========== */
    catalog: {
      init() {
        $('#catalog-search').addEventListener('input', debounce(() => this.render(), 200));
        $('#btn-catalog-add').addEventListener('click', () => this.openModal());
      },
      render() {
        const q = $('#catalog-search').value.trim().toLowerCase();
        let list = Object.values(state.tools);
        if (q) list = list.filter(t =>
          (t.refOutil || '').toLowerCase().includes(q) ||
          (t.outilId || '').toLowerCase().includes(q) ||
          (t.fabricant || '').toLowerCase().includes(q)
        );
        const grid = $('#catalog-grid');
        grid.innerHTML = list.slice(0, 100).map(t => `
          <article class="card" style="padding:var(--sp-5)">
            <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-3)">
              <strong>${ui.escape(t.outilId || t.id)}</strong>
              <span class="badge badge--auto">${ui.escape(t.fabricant || '')}</span>
            </header>
            <div style="color:var(--text-secondary);font-size:var(--fs-sm);font-family:var(--font-mono)">
              <div>Réf: ${ui.escape(t.refOutil || '—')}</div>
              <div>Fab: ${ui.escape(t.refFabricant || '—')}</div>
              <div>Cycles: ${fmt.number(t.frequenceCycle || 0)}</div>
            </div>
          </article>
        `).join('') || '<p style="color:var(--text-muted)">Aucun outil</p>';
      },
      openModal(tool = null) {
        const modal = $('#modal-tool');
        modal.hidden = false;
        $('#tool-modal-title').textContent = tool ? 'Modifier outil' : 'Nouvel outil';
        const form = $('#form-tool');
        form.reset();
        if (tool) {
          Object.entries(tool).forEach(([k, v]) => {
            const inp = form.querySelector(`[name="${k}"]`);
            if (inp) inp.value = v;
          });
        }
        modal.querySelectorAll('[data-close]').forEach(el => {
          el.addEventListener('click', () => { modal.hidden = true; }, { once: true });
        });
        $('#btn-tool-save').onclick = async () => {
          const data = {};
          new FormData(form).forEach((v, k) => { data[k] = v; });
          data.pieces = { pAr: data.pAr, pAv: data.pAv, eAr: data.eAr, eAv: data.eAv };
          await db.saveTool(data);
          modal.hidden = true;
          ui.toast('Outil enregistré', 'success');
        };
      }
    },

    /* ========== USERS (admin) ========== */
    users: {
      init() {
        $('#btn-user-add').addEventListener('click', () => this.openModal());
      },
      async render() {
        if (!auth.can('user.read') && state.role !== 'super_admin') return;
        const snap = await fbDb.ref('users').once('value');
        const users = snap.val() || {};
        $('#users-body').innerHTML = Object.values(users).map(u => `
          <tr>
            <td><strong>${ui.escape(u.displayName || '—')}</strong></td>
            <td>${ui.escape(u.matricule || '—')}</td>
            <td>${ui.escape(u.email || '—')}</td>
            <td><span class="badge badge--auto">${auth.roleLabel(u.role)}</span></td>
            <td>${u.active ? '✅' : '⛔'}</td>
            <td>${fmt.dateTime(u.lastLoginAt)}</td>
            <td><button class="btn btn--ghost" data-action="edit" data-uid="${u.uid}">Modifier</button></td>
          </tr>
        `).join('');
      },
      openModal() {
        const modal = $('#modal-user');
        modal.hidden = false;
        modal.querySelectorAll('[data-close]').forEach(el => {
          el.addEventListener('click', () => { modal.hidden = true; }, { once: true });
        });
        $('#btn-user-save').onclick = async () => {
          const form = $('#form-user');
          const data = {};
          new FormData(form).forEach((v, k) => { data[k] = v; });
          try {
            const cred = await fbAuth.createUserWithEmailAndPassword(data.email, data.password);
            await fbDb.ref(`users/${cred.user.uid}`).set({
              uid: cred.user.uid,
              displayName: data.displayName,
              matricule: data.matricule,
              email: data.email,
              role: data.role,
              active: true,
              createdAt: Date.now()
            });
            ui.toast('Utilisateur créé', 'success');
            modal.hidden = true;
            this.render();
          } catch (err) {
            ui.toast('Erreur : ' + err.message, 'danger');
          }
        };
      }
    },

    /* ========== STATS ========== */
    stats: {
      render() {
        // Placeholder — à étendre avec Chart.js si tu veux des graphiques détaillés
        console.log('Stats view rendered');
      }
    },

    /* ========== NOTIFICATIONS PANEL ========== */
    notifications: {
      init() {
        $('#btn-notifications').addEventListener('click', () => {
          $('#notif-panel').hidden = false;
        });
        $('#btn-notif-close').addEventListener('click', () => {
          $('#notif-panel').hidden = true;
        });
        $('#btn-notif-clear').addEventListener('click', async () => {
          if (!state.user) return;
          const ref = fbDb.ref(`notifications/${state.user.uid}`);
          const snap = await ref.once('value');
          const updates = {};
          snap.forEach(c => { updates[`${c.key}/read`] = true; });
          await ref.update(updates);
        });
      },
      render(notifs) {
        $('#notif-list').innerHTML = notifs.map(n => `
          <li style="padding:var(--sp-3);border-bottom:1px solid var(--border-soft);${n.read ? 'opacity:.6' : ''}">
            <div style="font-size:var(--fs-sm)">${ui.escape(n.message)}</div>
            <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:var(--sp-1)">${fmt.dateTime(n.createdAt)}</div>
          </li>
        `).join('') || '<li style="padding:var(--sp-4);color:var(--text-muted);text-align:center">Aucune notification</li>';
      }
    }
  };

  /* ==========================================================================
     14. APP CORE
     ========================================================================== */
  const app = {
    async loadInitialData() {
      ui.showLoader('Chargement des données…');
      db.listenTools();
      db.listenInterventions();
      db.listenNotifications();
      ui.hideLoader();
    },

    detachListeners() {
      state.listeners.forEach(off => { try { off(); } catch (e) {} });
      state.listeners = [];
    },

    initUI() {
      // User menu dropdown
      $('#btn-user').addEventListener('click', (e) => {
        e.stopPropagation();
        $('#user-dropdown').hidden = !$('#user-dropdown').hidden;
      });
      document.addEventListener('click', () => { $('#user-dropdown').hidden = true; });
      $('#user-dropdown').addEventListener('click', (e) => e.stopPropagation());
      $$('#user-dropdown button').forEach(b => {
        b.addEventListener('click', () => {
          const action = b.dataset.action;
          if (action === 'logout') auth.logout();
        });
      });

      // Mobile menu
      $('#btn-menu').addEventListener('click', () => {
        $('#sidebar').classList.toggle('is-open');
      });

      // Theme toggle (placeholder — déjà en dark)
      $('#btn-theme').addEventListener('click', () => {
        document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
      });
    }
  };

  /* ==========================================================================
     15. BOOTSTRAP
     ========================================================================== */
  document.addEventListener('DOMContentLoaded', () => {
    initFirebase();
    auth.init();
    app.initUI();
    router.init();
    views.intervention.init();
    views.history.init();
    views.queue.init();
    views.catalog.init();
    views.users.init();
    views.notifications.init();
    console.log('✅ LEONI Sertissage Lab — App ready');
  });

})();

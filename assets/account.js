/* ===========================================================
   Alloy Account — one sign-in for every game on the site.

   Include this BEFORE shell.js on every page. It defines
   window.AlloyAccount synchronously, so a game running in the page's
   iframe can always find it at window.parent.AlloyAccount.

   Cost discipline: guests never download Firebase and never touch
   reCAPTCHA. The SDK loads only when someone opens the sign-in window,
   or when a returning player's session needs restoring.

   Games talk to the API at the bottom — see firebase/GAMES.md.
   =========================================================== */
(function () {
  "use strict";

  var SDK = "https://www.gstatic.com/firebasejs/11.6.1/";
  // Public web config — these identify the project, they are not secrets.
  // Security comes from the server functions and Firestore rules.
  var CONFIG = {
    apiKey: "AIzaSyDUZ9EUrVHzAJ0-owcGtCdVgGbwDPqIT1M",
    authDomain: "speed-simulator-dfac6.firebaseapp.com",
    projectId: "speed-simulator-dfac6",
    appId: "1:537160879945:web:1a592b441a478551ff1498"
  };
  var RECAPTCHA_KEY = "6LfxnCUtAAAAAP_Ym97pM8jK0p2LDBobNy5APcoa";
  var HINT = "alloy.session";          // set while signed in: "load Firebase on next visit"
  var SAVE_EVERY_MS = 20000;           // routine saves coalesce to one call per 20s per game
  var SAVE_MIN_GAP_MS = 4500;          // the server refuses anything closer than 4s
  var PROGRESS_EVERY_MS = 10000;
  var NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

  var fb = null, loading = null, user = null, pendingName = null, nameErr = "";
  var slot = null, modal = null;
  var listeners = [];
  var readyResolve, settled = false;
  var ready = new Promise(function (r) { readyResolve = r; });

  function settle() { if (!settled) { settled = true; readyResolve(pub()); } }
  function pub() { return user ? { uid: user.uid, name: user.name } : null; }
  function hinted() { try { return localStorage.getItem(HINT) === "1"; } catch (_) { return false; } }
  function setHint(on) { try { on ? localStorage.setItem(HINT, "1") : localStorage.removeItem(HINT); } catch (_) {} }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  // ------------------------------------------------------------ Firebase ---

  function load() {
    if (fb) return Promise.resolve(fb);
    if (loading) return loading;
    loading = Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-auth.js"),
      import(SDK + "firebase-functions.js"),
      import(SDK + "firebase-app-check.js")
    ]).then(function (m) {
      var appM = m[0], authM = m[1], fnM = m[2], acM = m[3];
      var app = appM.initializeApp(CONFIG);
      try {
        acM.initializeAppCheck(app, {
          provider: new acM.ReCaptchaV3Provider(RECAPTCHA_KEY),
          isTokenAutoRefreshEnabled: true
        });
      } catch (e) { console.warn("[alloy] App Check unavailable:", e && e.message); }
      var auth = authM.getAuth(app);
      var fns = fnM.getFunctions(app, "us-central1");
      fb = {
        auth: auth,
        a: authM,
        call: function (name, data) {
          return fnM.httpsCallable(fns, name)(data || {}).then(function (r) { return r.data; });
        }
      };
      authM.onAuthStateChanged(auth, onAuth);
      return fb;
    }).catch(function (e) {
      console.warn("[alloy] could not load accounts:", e && e.message);
      loading = null;
      settle();
      throw e;
    });
    return loading;
  }

  function onAuth(u) {
    if (!u) {
      user = null;
      setHint(false);
      emit(); settle();
      return;
    }
    setHint(true);
    var me = user = { uid: u.uid, name: null, email: u.email || null, offline: false };
    fb.call("alloySession").then(function (s) {
      me.name = s.name || null;
    }, function (e) {
      // Signed in, but the account server is unreachable: games keep saving
      // locally and simply don't sync this session.
      console.warn("[alloy] session unavailable:", e && (e.code || e.message));
      me.offline = true;
    }).then(function () {
      // A name chosen on the sign-up form. If it was taken, fall through to the
      // name window with the reason — that must not mark the account offline.
      if (!me.offline && !me.name && pendingName) {
        return claimName(pendingName).catch(function (e) { nameErr = msg(e); });
      }
    }).then(function () {
      pendingName = null;
      if (user !== me) return;               // signed out while this was in flight
      emit(); settle();
      if (!me.name && !me.offline) openModal("name");
    });
  }

  function claimName(name) {
    return fb.call("alloySetName", { name: name }).then(function (r) {
      user.name = r.name; emit(); return r;
    });
  }

  function emit() {
    renderButton();
    var u = pub();
    listeners.slice().forEach(function (fn) { try { fn(u); } catch (_) {} });
  }

  // --------------------------------------------------------------- saves ---

  var saveQ = {};
  function save(gameId, data, opts) {
    return new Promise(function (resolve) {
      if (!user) return resolve({ ok: false, error: "signed-out" });
      if (user.offline) return resolve({ ok: false, error: "offline" });
      var q = saveQ[gameId] || (saveQ[gameId] = { data: null, waiters: [], timer: 0, last: 0 });
      q.data = data;
      q.waiters.push(resolve);
      var due = q.last + ((opts && opts.now) ? SAVE_MIN_GAP_MS : SAVE_EVERY_MS);
      clearTimeout(q.timer);
      q.timer = setTimeout(function () { flushSave(gameId); }, Math.max(0, due - Date.now()));
    });
  }

  function flushSave(gameId) {
    var q = saveQ[gameId];
    if (!q || !q.waiters.length) return;
    var waiters = q.waiters.splice(0), data = q.data;
    q.last = Date.now();
    load().then(function () {
      return fb.call("alloySave", { gameId: gameId, data: data });
    }).catch(function (e) {
      return { ok: false, error: (e && (e.code || e.message)) || "failed" };
    }).then(function (res) {
      waiters.forEach(function (w) { w(res); });
    });
  }

  function loadSave(gameId) {
    if (!user || user.offline) return Promise.resolve(null);
    return load().then(function () {
      return fb.call("alloyLoad", { gameId: gameId });
    }).catch(function (e) {
      console.warn("[alloy] load failed:", e && (e.code || e.message));
      return null;
    });
  }

  // -------------------------------------------------------------- events ---

  var defs = null;
  function eventDefs() {
    if (defs) return Promise.resolve(defs);
    return fetch("/data/events.json", { cache: "no-cache" })
      .then(function (r) { return r.json(); })
      .then(function (j) { defs = Array.isArray(j.events) ? j.events : []; return defs; })
      .catch(function () { defs = []; return defs; });
  }

  function events(gameId) {
    return eventDefs().then(function (all) {
      var now = Date.now();   // display only — the server enforces windows on its own clock
      var list = all.filter(function (e) { return !gameId || e.gameId === gameId; }).map(function (e) {
        var s = Date.parse(e.startsAt), en = Date.parse(e.endsAt);
        return Object.assign({}, e, { live: now >= s && now < en, upcoming: now < s });
      });
      if (!user || user.offline || !list.length) return list;
      return load().then(function () { return fb.call("alloyEvents", { gameId: gameId }); })
        .then(function (r) {
          var byId = {};
          (r.events || []).forEach(function (x) { byId[x.id] = x; });
          return list.map(function (e) { return Object.assign(e, byId[e.id] ? { state: byId[e.id] } : {}); });
        })
        .catch(function () { return list; });
    });
  }

  var evQ = {};
  function queueEvent(eventId, kind, value) {
    return new Promise(function (resolve) {
      if (!user) return resolve({ error: "signed-out" });
      if (user.offline) return resolve({ error: "offline" });
      var v = Number(value);
      if (!(v > 0)) return resolve({ error: "bad-amount" });
      var q = evQ[eventId] || (evQ[eventId] = { add: 0, best: 0, kind: kind, waiters: [], timer: 0, last: 0 });
      q.kind = kind;
      if (kind === "score") q.best = Math.max(q.best, v); else q.add += v;
      q.waiters.push(resolve);
      clearTimeout(q.timer);
      q.timer = setTimeout(function () { flushEvent(eventId); },
        Math.max(0, q.last + PROGRESS_EVERY_MS - Date.now()));
    });
  }

  function flushEvent(eventId) {
    var q = evQ[eventId];
    if (!q || !q.waiters.length) return;
    var amount = q.kind === "score" ? q.best : q.add;
    var waiters = q.waiters.splice(0);
    q.add = 0; q.best = 0; q.last = Date.now();
    load().then(function () {
      return fb.call("alloyProgress", { eventId: eventId, amount: amount });
    }).catch(function (e) {
      return { error: (e && (e.code || e.message)) || "failed" };
    }).then(function (res) {
      waiters.forEach(function (w) { w(res); });
    });
  }

  function claim(eventId, tier) {
    if (!user || user.offline) return Promise.resolve({ error: "signed-out" });
    return load().then(function () {
      return fb.call("alloyClaim", { eventId: eventId, tier: tier });
    }).catch(function (e) { return { error: (e && (e.message || e.code)) || "failed" }; });
  }

  // ------------------------------------------------------------------ UI ---

  function mount(el) { slot = el; renderButton(); }

  function renderButton() {
    if (!slot) return;
    if (!settled && hinted()) {
      slot.innerHTML = '<span class="acct-btn acct-wait" aria-hidden="true"></span>';
      return;
    }
    if (!user) {
      slot.innerHTML = '<button type="button" class="acct-btn" data-a="open">Sign in</button>';
    } else {
      slot.innerHTML =
        '<button type="button" class="acct-btn acct-me" data-a="menu">' +
          '<span class="acct-dot"></span>' + esc(user.name || "Account") + "</button>" +
        '<div class="acct-menu" hidden>' +
          '<div class="acct-who"><b>' + esc(user.name || "No player name yet") + "</b>" +
            (user.email ? "<span>" + esc(user.email) + "</span>" : "") +
            (user.offline ? '<span class="acct-warn">Cloud saves unavailable right now</span>' : "") +
          "</div>" +
          '<button type="button" data-a="name">' + (user.name ? "Change player name" : "Choose player name") + "</button>" +
          '<button type="button" data-a="out">Sign out</button>' +
        "</div>";
    }
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-a]");
    var menu = slot && slot.querySelector(".acct-menu");
    if (menu && !menu.hidden && !(slot.contains(e.target))) menu.hidden = true;
    if (!b || !slot || !slot.contains(b)) return;
    var a = b.getAttribute("data-a");
    if (a === "open") openModal("signin");
    else if (a === "menu") { if (menu) menu.hidden = !menu.hidden; }
    else if (a === "name") { if (menu) menu.hidden = true; openModal("name"); }
    else if (a === "out") {
      if (menu) menu.hidden = true;
      load().then(function () { return fb.a.signOut(fb.auth); });
    }
  });

  var AUTH_ERRORS = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/invalid-login-credentials": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/invalid-email": "That doesn't look like an email address.",
    "auth/email-already-in-use": "That email already has an account — sign in instead.",
    "auth/weak-password": "Use at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "Couldn't reach the server. Check your connection.",
    "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups and try again."
  };
  function msg(e) {
    if (!e) return "Something went wrong.";
    if (e.code && AUTH_ERRORS[e.code]) return AUTH_ERRORS[e.code];
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return "";
    return e.message || "Something went wrong.";
  }

  function openModal(mode) {
    load().catch(function () {});           // warm the SDK so the Google pop-up isn't blocked
    if (!modal) {
      modal = document.createElement("div");
      modal.className = "sheet acct-sheet";
      modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && modal.classList.contains("on") && modal.getAttribute("data-mode") !== "name") closeModal();
      });
      document.body.appendChild(modal);
    }
    modal.setAttribute("data-mode", mode);
    modal.innerHTML = '<div class="sheet-card acct-card" role="dialog" aria-modal="true">' + body(mode) + "</div>";
    nameErr = "";
    modal.classList.add("on");
    wire(mode);
    var first = modal.querySelector("input");
    if (first) setTimeout(function () { first.focus(); }, 30);
  }
  function closeModal() { if (modal) modal.classList.remove("on"); }

  function body(mode) {
    var head = function (t) {
      return '<header><h2>' + t + '</h2><button class="icon-btn" data-x aria-label="Close">' +
        '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>';
    };
    var legal = '<p class="acct-legal">One Alloy account works in every game. Protected by reCAPTCHA — the Google ' +
      '<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Privacy Policy</a> and ' +
      '<a href="https://policies.google.com/terms" target="_blank" rel="noopener">Terms of Service</a> apply.</p>';
    if (mode === "name") {
      return '<header><h2>Choose a player name</h2></header><form class="acct-body" data-f="name">' +
        '<p class="acct-note">This is what other players see on leaderboards. Don’t use your real name.</p>' +
        '<label>Player name<input name="name" maxlength="16" autocomplete="nickname" value="' + esc(user && user.name || "") + '" required></label>' +
        '<p class="acct-hint">3–16 letters, numbers or _</p>' +
        '<p class="acct-err" data-err>' + esc(nameErr) + '</p>' +
        '<button class="btn acct-go" type="submit">Save name</button>' +
        (user && user.name ? '<button type="button" class="acct-link" data-x>Cancel</button>' : "") +
        "</form>";
    }
    if (mode === "reset") {
      return head("Reset your password") + '<form class="acct-body" data-f="reset">' +
        '<label>Email<input name="email" type="email" autocomplete="email" required></label>' +
        '<p class="acct-err" data-err></p>' +
        '<button class="btn acct-go" type="submit">Send reset link</button>' +
        '<button type="button" class="acct-link" data-m="signin">Back to sign in</button></form>';
    }
    var create = mode === "create";
    return head(create ? "Create your Alloy account" : "Sign in") +
      '<div class="acct-body">' +
      '<button type="button" class="acct-google" data-g>' +
        '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41.4 35.4 44 30.1 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>' +
        "Continue with Google</button>" +
      '<div class="acct-or"><span>or</span></div>' +
      '<form data-f="' + (create ? "create" : "signin") + '">' +
        (create ? '<label>Player name<input name="name" maxlength="16" autocomplete="nickname" required></label>' +
                  '<p class="acct-hint">Shown on leaderboards. 3–16 letters, numbers or _. Not your real name.</p>' : "") +
        '<label>Email<input name="email" type="email" autocomplete="email" required></label>' +
        '<label>Password<input name="password" type="password" minlength="6" autocomplete="' + (create ? "new-password" : "current-password") + '" required></label>' +
        '<p class="acct-err" data-err></p>' +
        '<button class="btn acct-go" type="submit">' + (create ? "Create account" : "Sign in") + "</button>" +
      "</form>" +
      (create
        ? '<button type="button" class="acct-link" data-m="signin">Already have an account? Sign in</button>'
        : '<button type="button" class="acct-link" data-m="create">New here? Create an account</button>' +
          '<button type="button" class="acct-link" data-m="reset">Forgot password?</button>') +
      legal + "</div>";
  }

  function wire(mode) {
    var err = modal.querySelector("[data-err]");
    var say = function (t, ok) { if (err) { err.textContent = t || ""; err.classList.toggle("ok", !!ok); } };
    var busy = function (on) { modal.querySelectorAll("button, input").forEach(function (x) { x.disabled = on; }); };

    modal.querySelectorAll("[data-x]").forEach(function (x) { x.addEventListener("click", closeModal); });
    modal.querySelectorAll("[data-m]").forEach(function (x) {
      x.addEventListener("click", function () { openModal(x.getAttribute("data-m")); });
    });

    var g = modal.querySelector("[data-g]");
    if (g) g.addEventListener("click", function () {
      say("");
      load().then(function () {
        return fb.a.signInWithPopup(fb.auth, new fb.a.GoogleAuthProvider());
      }).then(closeModal, function (e) { say(msg(e)); });
    });

    var f = modal.querySelector("form");
    if (!f) return;
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = function (n) { var i = f.elements[n]; return i ? i.value.trim() : ""; };
      say("");
      if ((mode === "create" || mode === "name") && !NAME_RE.test(v("name"))) {
        say("Player names are 3–16 letters, numbers or _.");
        return;
      }
      busy(true);
      load().then(function () {
        if (mode === "signin") return fb.a.signInWithEmailAndPassword(fb.auth, v("email"), f.elements.password.value).then(closeModal);
        if (mode === "create") {
          pendingName = v("name");
          return fb.a.createUserWithEmailAndPassword(fb.auth, v("email"), f.elements.password.value).then(closeModal);
        }
        if (mode === "reset") {
          return fb.a.sendPasswordResetEmail(fb.auth, v("email")).then(function () {
            say("If that email has an account, a reset link is on its way.", true);
          });
        }
        if (mode === "name") return claimName(v("name")).then(closeModal);
      }).catch(function (e2) {
        pendingName = null;
        say(msg(e2));
      }).then(function () { busy(false); });
    });
  }

  // ----------------------------------------------------------------- API ---

  window.AlloyAccount = {
    version: 1,
    /** Resolves once the sign-in state is known: {uid, name} or null. */
    ready: ready,
    user: pub,
    /** fn(user|null) on every sign-in, sign-out or name change. Returns an unsubscribe. */
    onChange: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },
    signIn: function () { openModal("signin"); },
    /** {data, rewards, verified} for this game, or null for guests / no cloud save yet. */
    load: loadSave,
    /** Throttled to one call per 20s per game; pass {now:true} at checkpoints. Resolves {ok, data} with server-corrected data. */
    save: save,
    /** Event definitions for a game, with live state and your progress when signed in. */
    events: events,
    /** Add to a personal or community event's counter. Batched every 10s. */
    progress: function (eventId, amount) { return queueEvent(eventId, "add", amount); },
    /** Submit a run's score to a leaderboard event (best-of). Batched every 10s. */
    score: function (eventId, value) { return queueEvent(eventId, "score", value); },
    claim: claim,
    _mount: mount
  };

  // Guests never load Firebase; returning players do, to restore their session.
  if (hinted()) {
    var go = function () { load().catch(function () {}); };
    if (document.readyState === "complete") go(); else addEventListener("load", go);
  } else {
    settle();
  }
})();

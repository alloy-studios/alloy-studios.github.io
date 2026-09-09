/* ===========================================================
   Alloy Studios - shared shell script
   Loaded by every page. Two responsibilities:
     1. Build the header (logo + search) that every page shares.
     2. Render whichever page it is on, from data/games.json.
   =========================================================== */

const Alloy = (() => {
  const DATA_URL = '/data/games.json';

  let state = { site: {}, games: [] };

  /* ---------- helpers ---------- */

  // Deterministic colour per game so games without a thumbnail still look
  // distinct and never change between page loads.
  function hueOf(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return h;
  }

  function artStyle(game) {
    if (game.accent) {
      return `background:linear-gradient(135deg, ${game.accent}, ${shade(game.accent, -55)})`;
    }
    const h = hueOf(game.id);
    return `background:linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 45) % 360} 72% 32%))`;
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255]
      .map(v => Math.max(0, Math.min(255, v + amt)));
    return `rgb(${c.join(',')})`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
    ));
  }

  function initials(title) {
    const w = title.trim().split(/\s+/);
    return (w.length > 1 ? w[0][0] + w[1][0] : title.slice(0, 2)).toUpperCase();
  }

  function artHTML(game, cls) {
    if (game.thumb) {
      return `<div class="art"><img src="${esc(game.thumb)}" alt="" loading="lazy"></div>`;
    }
    return `<div class="art" style="${artStyle(game)}">
      <div class="mono">${esc(initials(game.title))}</div>
    </div>`;
  }

  function cardHTML(game) {
    return `<a class="card" href="/${esc(game.id)}/">
      ${artHTML(game)}
      <div class="meta">
        <h3>${esc(game.title)}</h3>
        <p>${esc(game.tagline || (game.tags || []).join(', '))}</p>
      </div>
    </a>`;
  }

  // Ignore spaces, hyphens and case, so "orbitdash", "orbit-dash" and
  // "Orbit Dash" all find the same game.
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function score(game, q) {
    const t = norm(game.title);
    const hay = norm([game.title, game.id, game.tagline, (game.tags || []).join(' ')].join(' '));
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (t.includes(q)) return 60;
    if (hay.includes(q)) return 30;
    return 0;
  }

  function search(q) {
    q = norm(q);
    if (!q) return [];
    return state.games
      .map(g => ({ g, s: score(g, q) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || a.g.title.localeCompare(b.g.title))
      .map(x => x.g);
  }

  /* ---------- shared header ---------- */

  const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/>
    </linearGradient></defs>
    <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#lg)"/>
    <path d="M10 22 L16 9 L22 22" stroke="#0b0d14" stroke-width="3"
          fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12.5 18 h7" stroke="#0b0d14" stroke-width="3" stroke-linecap="round"/>
  </svg>`;

  function renderHeader() {
    const el = document.createElement('header');
    el.className = 'site-header';
    el.innerHTML = `
      <a class="brand" href="/">
        ${LOGO}<span>Alloy<b>Studios</b></span>
      </a>
      <div class="search-wrap">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input class="search" type="search" placeholder="Search games..."
               autocomplete="off" spellcheck="false" aria-label="Search games">
        <kbd class="kbd-hint">/</kbd>
        <div class="suggest" role="listbox"></div>
      </div>
      <div class="header-spacer"></div>
      <nav class="header-nav">
        <a class="header-link" href="/">Home</a>
        <a class="header-link" href="/all/">All games</a>
      </nav>`;

    // Mark the tab you are on. Every game page counts as neither.
    const path = location.pathname.replace(/index\.html$/, '');
    for (const link of el.querySelectorAll('.header-nav a')) {
      if (link.getAttribute('href') === path) link.classList.add('on');
    }

    document.body.prepend(el);
    wireSearch(el);
  }

  function wireSearch(header) {
    const input = header.querySelector('.search');
    const box = header.querySelector('.suggest');
    let results = [], active = -1;

    const paint = () => {
      box.innerHTML = results.slice(0, 7).map((g, i) => `
        <a href="/${esc(g.id)}/" class="${i === active ? 'active' : ''}">
          <span class="sq" style="${artStyle(g)}">${esc(initials(g.title))}</span>
          <span>${esc(g.title)}</span>
          <span class="st">${esc((g.tags || [])[0] || 'game')}</span>
        </a>`).join('');
    };

    input.addEventListener('input', () => {
      results = search(input.value);
      active = -1;
      paint();
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        paint();
      } else if (e.key === 'Enter') {
        const pick = results[active >= 0 ? active : 0];
        if (pick) location.href = '/' + pick.id + '/';
      } else if (e.key === 'Escape') {
        input.value = ''; results = []; paint(); input.blur();
      }
    });

    document.addEventListener('click', e => {
      if (!header.contains(e.target)) { results = []; paint(); }
    });

    // "/" focuses search from anywhere on the page
    document.addEventListener('keydown', e => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); input.focus();
      }
    });
  }

  function renderFooter() {
    const f = document.createElement('footer');
    f.className = 'site-footer';
    f.innerHTML = `<span>&copy; ${new Date().getFullYear()} ${esc(state.site.name || 'Alloy Studios')}</span>
      <span>&middot;</span><a href="/">Home</a>
      <span>&middot;</span><a href="/all/">All games</a>`;
    document.body.appendChild(f);
  }

  /* ---------- boot ---------- */

  async function boot(render) {
    renderHeader();
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      state = await res.json();
    } catch (err) {
      console.error('Could not load games.json', err);
      state = { site: {}, games: [] };
    }
    state.games = state.games || [];
    await render(state);
    renderFooter();
  }

  return { boot, cardHTML, artHTML, artStyle, esc, initials, search, get state() { return state; } };
})();

/* Game page. This file is identical for every game - the game it should
   load is derived from the URL, so /snake/ loads games/snake/index.html.
   That is why every game folder can use the exact same wrapper HTML. */

const ICONS = {
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  reload: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'
};

function gameIdFromUrl() {
  const q = new URLSearchParams(location.search).get('g');
  if (q) return q;
  const seg = location.pathname.split('/').filter(Boolean);
  return seg[seg.length - 1] === 'index.html' ? seg[seg.length - 2] : seg[seg.length - 1];
}

Alloy.boot(({ games, site }) => {
  const main = document.querySelector('main');
  const id = gameIdFromUrl();
  const game = games.find(g => g.id === id);

  if (!game) {
    document.title = 'Game not found - ' + (site.name || 'Alloy Studios');
    main.innerHTML = `<div class="wrap"><div class="empty">
      <h2>That game is not here</h2>
      <p>No game with the id <code>${Alloy.esc(id)}</code>. Try the search box above.</p>
      <p style="margin-top:22px"><a class="btn" href="/all/">Browse all games</a></p>
    </div></div>`;
    return;
  }

  /* --- page metadata, so links and tabs look right per game --- */
  document.title = `${game.title} - Play free on ${site.name || 'Alloy Studios'}`;
  const meta = (name, content, prop) => {
    const m = document.createElement('meta');
    m.setAttribute(prop ? 'property' : 'name', name);
    m.content = content;
    document.head.appendChild(m);
  };
  meta('description', game.description || game.tagline || game.title);
  meta('og:title', game.title, true);
  meta('og:description', game.description || game.tagline || '', true);
  meta('og:type', 'website', true);
  if (game.thumb) meta('og:image', new URL(game.thumb, location.origin).href, true);

  const others = games.filter(g => g.id !== game.id).slice(0, 12);

  main.innerHTML = `
    <div class="toolbar">
      <span class="title">${Alloy.esc(game.title)}</span>
      ${game.controls ? `<span class="ctrl">${Alloy.esc(game.controls)}</span>` : ''}
      <span class="sp"></span>
      <button class="icon-btn" id="reload" title="Restart game" aria-label="Restart game">
        <svg viewBox="0 0 24 24">${ICONS.reload}</svg></button>
      <button class="icon-btn" id="fs" title="Fullscreen" aria-label="Fullscreen">
        <svg viewBox="0 0 24 24">${ICONS.full}</svg></button>
    </div>

    <div class="stage${game.aspect ? ' ratio' : ''}" id="stage"
         ${game.aspect ? `style="--ratio:${Alloy.esc(game.aspect)}"` : ''}>
      <div class="loader" id="loader"><div class="spinner"></div></div>
      <iframe id="frame" src="/games/${Alloy.esc(game.id)}/"
              title="${Alloy.esc(game.title)}"
              allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope; xr-spatial-tracking"></iframe>
    </div>

    <div class="wrap">
      <div class="about">
        <div>
          <h2>About ${Alloy.esc(game.title)}</h2>
          <p>${Alloy.esc(game.description || game.tagline || '')}</p>
        </div>
        <dl>
          ${game.controls ? `<dt>Controls</dt><dd>${Alloy.esc(game.controls)}</dd>` : ''}
          ${(game.tags || []).length ? `<dt>Tags</dt><dd>${Alloy.esc(game.tags.join(', '))}</dd>` : ''}
          ${game.added ? `<dt>Added</dt><dd>${Alloy.esc(game.added)}</dd>` : ''}
        </dl>
      </div>

      ${others.length ? `
        <div class="section-head"><h2>More games</h2></div>
        <div class="grid">${others.map(Alloy.cardHTML).join('')}</div>` : ''}
    </div>`;

  const stage = document.getElementById('stage');
  const frame = document.getElementById('frame');
  const loader = document.getElementById('loader');

  frame.addEventListener('load', () => {
    loader.classList.add('gone');
    // Keyboard games need the iframe focused or arrow keys go to the page.
    try { frame.contentWindow.focus(); } catch (_) {}
  });

  // Clicking anywhere on the stage hands keyboard focus back to the game.
  stage.addEventListener('mousedown', () => {
    try { frame.contentWindow.focus(); } catch (_) {}
  });

  document.getElementById('reload').addEventListener('click', () => {
    loader.classList.remove('gone');
    frame.src = frame.src;
  });

  document.getElementById('fs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage);
  });
});

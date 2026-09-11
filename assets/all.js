/* /all/ - the whole library, with tag filtering.
   Accepts ?tag=<name> so the front page rows can deep-link into a filter. */

Alloy.boot(({ games }) => {
  const main = document.querySelector('main');

  if (!games.length) {
    main.innerHTML = `<div class="wrap"><div class="empty">
      <h2>No games yet</h2>
      <p>Add a folder under <code>games/</code> and an entry in <code>data/games.json</code>.</p>
    </div></div>`;
    return;
  }

  // Only tags that group something. A chip per one-off tag is a wall of
  // chips that pushes the games below the fold - search still finds those.
  const counts = {};
  for (const g of games) for (const t of g.tags || []) counts[t] = (counts[t] || 0) + 1;
  const tags = Object.keys(counts)
    .filter(t => counts[t] > 1)
    .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    .slice(0, 12);

  const wanted = new URLSearchParams(location.search).get('tag') || '';
  const start = tags.includes(wanted) ? wanted : '';

  main.innerHTML = `
    <div class="wrap">
      <div class="page-head">
        <h1>All games</h1>
        <p>${games.length} games, all free, all playable in the browser.</p>
      </div>

      <div class="chips" id="chips">
        <button class="chip${start ? '' : ' on'}" data-tag="">All</button>
        ${tags.map(t => `<button class="chip${t === start ? ' on' : ''}" data-tag="${Alloy.esc(t)}">${Alloy.esc(t)}</button>`).join('')}
      </div>

      <div class="section-head">
        <h2 id="heading"></h2><span class="count" id="count"></span>
      </div>
      <div class="grid" id="grid"></div>
    </div>`;

  const grid = document.getElementById('grid');
  const count = document.getElementById('count');
  const heading = document.getElementById('heading');

  function paint(tag) {
    const list = tag ? games.filter(g => (g.tags || []).includes(tag)) : games;
    grid.innerHTML = list.map(Alloy.cardHTML).join('');
    heading.textContent = tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : 'Everything';
    count.textContent = list.length + (list.length === 1 ? ' game' : ' games');

    // Keep the URL shareable without adding a history entry per click.
    const url = tag ? '/all/?tag=' + encodeURIComponent(tag) : '/all/';
    history.replaceState(null, '', url);
  }

  document.getElementById('chips').addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === btn));
    paint(btn.dataset.tag);
  });

  paint(start);
});

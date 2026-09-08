/* Homepage: featured hero, tag filter chips, full game grid. */

Alloy.boot(({ games }) => {
  const main = document.querySelector('main');
  if (!games.length) {
    main.innerHTML = `<div class="wrap"><div class="empty">
      <h2>No games yet</h2>
      <p>Add a folder under <code>games/</code> and an entry in <code>data/games.json</code>.</p>
    </div></div>`;
    return;
  }

  const featured = games.find(g => g.featured) || games[0];
  const tags = [...new Set(games.flatMap(g => g.tags || []))].sort();

  main.innerHTML = `
    <div class="wrap">
      <a class="hero" href="/${Alloy.esc(featured.id)}/">
        ${Alloy.artHTML(featured)}
        <div class="body">
          <div class="eyebrow">Featured</div>
          <h1>${Alloy.esc(featured.title)}</h1>
          <p>${Alloy.esc(featured.description || featured.tagline || '')}</p>
          <span class="btn">Play now</span>
        </div>
      </a>

      <div class="chips" id="chips">
        <button class="chip on" data-tag="">All</button>
        ${tags.map(t => `<button class="chip" data-tag="${Alloy.esc(t)}">${Alloy.esc(t)}</button>`).join('')}
      </div>

      <div class="section-head">
        <h2>All games</h2><span class="count" id="count"></span>
      </div>
      <div class="grid" id="grid"></div>
    </div>`;

  const grid = document.getElementById('grid');
  const count = document.getElementById('count');

  function paint(tag) {
    const list = tag ? games.filter(g => (g.tags || []).includes(tag)) : games;
    grid.innerHTML = list.map(Alloy.cardHTML).join('');
    count.textContent = list.length + (list.length === 1 ? ' game' : ' games');
  }

  document.getElementById('chips').addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === btn));
    paint(btn.dataset.tag);
  });

  paint('');
});

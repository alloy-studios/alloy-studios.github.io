/* The main page: featured game, a few short rows, then news at the bottom.
   The full A-Z grid lives on /all/ - this page is the front door. */

const NEWS_URL = '/data/news.json';

function row(title, games, moreHref) {
  if (!games.length) return '';
  return `
    <div class="section-head">
      <h2>${Alloy.esc(title)}</h2>
      ${moreHref ? `<a class="see-all" href="${moreHref}">See all &rarr;</a>` : ''}
    </div>
    <div class="grid">${games.map(Alloy.cardHTML).join('')}</div>`;
}

function newsHTML(posts, games) {
  if (!posts.length) return '';
  const byId = Object.fromEntries(games.map(g => [g.id, g]));

  return `
    <section class="news">
      <div class="section-head"><h2>News</h2></div>
      ${posts.map(p => {
        const g = p.game ? byId[p.game] : null;
        const when = new Date(p.date + 'T00:00:00');
        const stamp = isNaN(when) ? p.date : when.toLocaleDateString(undefined,
          { year: 'numeric', month: 'short', day: 'numeric' });
        return `
          <article class="post">
            <time datetime="${Alloy.esc(p.date)}">${Alloy.esc(stamp)}</time>
            <div>
              <h3>${Alloy.esc(p.title)}</h3>
              <p>${Alloy.esc(p.body)}</p>
              ${g ? `<a class="post-link" href="/${Alloy.esc(g.id)}/">Play ${Alloy.esc(g.title)} &rarr;</a>` : ''}
            </div>
          </article>`;
      }).join('')}
    </section>`;
}

Alloy.boot(async ({ games }) => {
  const main = document.querySelector('main');

  if (!games.length) {
    main.innerHTML = `<div class="wrap"><div class="empty">
      <h2>No games yet</h2>
      <p>Add a folder under <code>games/</code> and an entry in <code>data/games.json</code>.</p>
    </div></div>`;
    return;
  }

  const featured = games.find(g => g.featured) || games[0];

  // Newest first, by the date in the manifest. Ties keep manifest order.
  const newest = [...games]
    .sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')))
    .slice(0, 6);

  // The two biggest categories, so the front page shows range rather than a
  // single wall of everything.
  const counts = {};
  for (const g of games) for (const t of g.tags || []) counts[t] = (counts[t] || 0) + 1;
  const topTags = Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    .slice(0, 2);

  // News is optional - the page must still render if the file is missing.
  let posts = [];
  try {
    const res = await fetch(NEWS_URL, { cache: 'no-cache' });
    if (res.ok) posts = (await res.json()).posts || [];
  } catch (_) {}

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

      ${row('Newest', newest, '/all/')}
      ${topTags.map(t => row(
        t.charAt(0).toUpperCase() + t.slice(1),
        games.filter(g => (g.tags || []).includes(t)).slice(0, 6),
        '/all/?tag=' + encodeURIComponent(t)
      )).join('')}

      ${newsHTML(posts, games)}
    </div>`;
});

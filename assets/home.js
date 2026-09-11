/* The front page is about the studio, not the catalogue.
   Masthead -> what Alloy Studios is -> one spotlight game -> contact -> news.
   The full library lives on /all/. All copy comes from site.* in games.json. */

const NEWS_URL = '/data/news.json';

const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true" class="mark">
  <defs><linearGradient id="mk" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/>
  </linearGradient></defs>
  <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#mk)"/>
  <path d="M10 22 L16 9 L22 22" stroke="#0b0d14" stroke-width="3"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M12.5 18 h7" stroke="#0b0d14" stroke-width="3" stroke-linecap="round"/>
</svg>`;

function newsHTML(posts, games) {
  if (!posts.length) return '';
  const byId = Object.fromEntries(games.map(g => [g.id, g]));

  return `
    <section class="news" id="news">
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

Alloy.boot(async ({ games, site }) => {
  const main = document.querySelector('main');

  // The spotlight is the game marked "featured", else the most recently added.
  const spotlight = games.find(g => g.featured) ||
    [...games].sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')))[0];

  const about = site.about || [];

  let posts = [];
  try {
    const res = await fetch(NEWS_URL, { cache: 'no-cache' });
    if (res.ok) posts = (await res.json()).posts || [];
  } catch (_) {}

  // Assembled at runtime rather than sitting in the HTML as plain text - it
  // will not stop a determined scraper, but it skips the lazy ones.
  const mail = site.contact ? site.contact.split('@') : null;

  main.innerHTML = `
    <section class="masthead">
      <div class="wrap masthead-inner">
        ${MARK}
        <h1>${Alloy.esc(site.name || 'Alloy Studios')}</h1>
        <p class="lede">${Alloy.esc(site.tagline || '')}</p>
        <p class="intro">${Alloy.esc(site.intro || '')}</p>
        <div class="cta">
          <a class="btn" href="/all/">Browse all ${games.length} games</a>
          ${spotlight ? `<a class="btn ghost" href="/${Alloy.esc(spotlight.id)}/">Play ${Alloy.esc(spotlight.title)}</a>` : ''}
        </div>
      </div>
    </section>

    <div class="wrap">
      ${about.length ? `
        <section class="studio">
          <div class="section-head"><h2>About the studio</h2></div>
          <div class="studio-body">
            <div class="prose">${about.map(p => `<p>${Alloy.esc(p)}</p>`).join('')}</div>
            <dl class="facts">
              <dt>Games</dt><dd>${games.length}</dd>
              <dt>Price</dt><dd>Free</dd>
              <dt>Install</dt><dd>None</dd>
              <dt>Source</dt><dd><a href="https://github.com/${Alloy.esc(site.github || 'alloy-studios')}">GitHub</a></dd>
            </dl>
          </div>
        </section>` : ''}

      ${spotlight ? `
        <section class="spotlight">
          <div class="section-head"><h2>Latest release</h2>
            <a class="see-all" href="/all/">All games &rarr;</a></div>
          <a class="hero" href="/${Alloy.esc(spotlight.id)}/">
            ${Alloy.artHTML(spotlight)}
            <div class="body">
              <div class="eyebrow">${Alloy.esc((spotlight.tags || [])[0] || 'New')}</div>
              <h2>${Alloy.esc(spotlight.title)}</h2>
              <p>${Alloy.esc(spotlight.description || spotlight.tagline || '')}</p>
              <span class="btn">Play now</span>
            </div>
          </a>
        </section>` : ''}

      ${(site.roadmap || []).length ? `
        <section class="roadmap">
          <div class="section-head"><h2>What's next</h2></div>
          <ol class="timeline">
            ${site.roadmap.map(step => `
              <li>
                <span class="status">${Alloy.esc(step.status || '')}</span>
                <h3>${Alloy.esc(step.title || '')}</h3>
                <p>${Alloy.esc(step.detail || '')}</p>
              </li>`).join('')}
          </ol>
        </section>` : ''}

      ${mail ? `
        <section class="contact" id="contact">
          <div class="section-head"><h2>Contact</h2></div>
          <div class="contact-body">
            <p>Bug reports, ideas, or just want to say a game broke in an
               interesting way? Send an email and it will get read.</p>
            <a class="btn" id="mail" href="#">Email Alloy Studios</a>
            <p class="addr"><span id="addr"></span></p>
          </div>
        </section>` : ''}

      ${newsHTML(posts, games)}
    </div>`;

  if (mail) {
    const address = mail[0] + '@' + mail[1];
    const link = document.getElementById('mail');
    link.href = 'mailto:' + address;
    document.getElementById('addr').textContent = address;
  }
});

/**
 * Music Explorer — Mac Miller
 * ---------------------------
 * Flow: FETCH the artist's songs from the iTunes Search API -> TRANSFORM the
 * flat song list into albums and a set of derived statistics -> DISPLAY those
 * as headline numbers, fact cards, a per-year bar chart and album cards.
 */

'use strict';

// Lets the guard at the bottom of index.html confirm this file actually ran.
window.MUSIC_EXPLORER_LOADED = true;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const API_URL = 'https://itunes.apple.com/search';

// Fixed artist: the whole page is about this one catalogue.
const ARTIST = 'Mac Miller';

// One artist is already a small, bounded dataset, so we take the API's full
// slice (200 is its maximum) — the statistics are only as good as the sample.
const RESULT_LIMIT = 200;

// Albums rendered before the "show all" button appears.
const ALBUM_DISPLAY_LIMIT = 6;

// Words ignored when looking for the most-used word in song titles.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'as', 'is', 'it', 'its', 'be', 'am', 'are', 'was',
  'my', 'me', 'i', 'im', 'you', 'your', 'youre', 'we', 'us', 'he', 'she',
  'they', 'them', 'this', 'that', 'so', 'if', 'up', 'out', 'do', 'dont',
  'feat', 'featuring', 'remix', 'version', 'edit', 'intro', 'outro', 'skit',
  'live', 'bonus', 'deluxe', 'ft',
]);

// DOM references, looked up once.
const statusEl = document.getElementById('status');
const contentEl = document.getElementById('content');
const heroEl = document.getElementById('hero');
const factsEl = document.getElementById('facts');
const chartEl = document.getElementById('chart');
const chartTableEl = document.getElementById('chart-table');
const chartNoteEl = document.getElementById('chart-note');
const albumsEl = document.getElementById('albums');
const albumsSummaryEl = document.getElementById('albums-summary');
const showMoreButton = document.getElementById('show-more-button');
const retryButton = document.getElementById('retry-button');

// Current result set, kept so the "show all" toggle can re-render without refetching.
let currentAlbums = [];
let showingAllAlbums = false;

/* ------------------------------------------------------------------ */
/* 1. FETCH                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the query. URLSearchParams encodes the term safely (spaces, accents,
 * &, etc.). attribute=artistTerm matches the artist field rather than any
 * text, so we get songs *by* the artist instead of every track mentioning him.
 * @returns {URLSearchParams}
 */
function buildParams() {
  return new URLSearchParams({
    term: ARTIST,
    attribute: 'artistTerm',
    media: 'music',
    entity: 'song',
    limit: String(RESULT_LIMIT),
  });
}

/**
 * Pull the results array out of a parsed API payload, or throw if the payload
 * is an error rather than a result set.
 * @param {object} data
 * @returns {Array<object>}
 */
function readResults(data) {
  // iTunes can answer with an error payload instead of results.
  if (data && data.errorMessage) {
    throw new Error(`The iTunes API rejected the request: ${data.errorMessage}`);
  }
  return data && Array.isArray(data.results) ? data.results : [];
}

/**
 * Normal path: a plain CORS request.
 * @param {URLSearchParams} params
 * @returns {Promise<Array<object>>}
 */
async function fetchViaCors(params) {
  let response;
  try {
    response = await fetch(`${API_URL}?${params}`);
  } catch (cause) {
    // fetch() rejects for offline, DNS, timeout, a blocked request *and* a
    // failed CORS preflight — the browser deliberately hides which. Flag it so
    // the caller knows the JSONP fallback is worth trying.
    const error = new Error('Direct request failed.');
    error.isNetworkError = true;
    error.cause = cause;
    throw error;
  }

  // The request completed, but the server answered with an error status.
  // The network clearly works, so there is no point falling back.
  if (!response.ok) {
    throw new Error(`The iTunes API responded with an error (HTTP ${response.status}). Please try again in a moment.`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    // A 200 response whose body is not valid JSON (rare, but it happens).
    throw new Error('The iTunes API returned an unreadable response. Please try again.');
  }

  return readResults(data);
}

/**
 * Fallback path: JSONP.
 *
 * The iTunes API accepts a `callback` parameter and will wrap its JSON in a
 * call to that function. Loading that through a <script> tag sidesteps CORS
 * entirely, which matters when the page is opened from a file:// URL — the
 * browser then sends `Origin: null`, and that is rejected often enough to make
 * a fallback worthwhile.
 *
 * The trade-off is real: JSONP runs whatever the server sends as code. That is
 * acceptable for a first-party Apple endpoint over HTTPS; it would not be for
 * an untrusted API.
 *
 * @param {URLSearchParams} params
 * @returns {Promise<Array<object>>}
 */
function fetchViaJsonp(params) {
  return new Promise((resolve, reject) => {
    // Unique name so overlapping calls cannot clobber each other.
    const callbackName = `itunesJsonp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement('script');
    // A <script> that never loads would otherwise hang the page forever.
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The fallback request timed out.'));
    }, 12000);

    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (data) => {
      cleanup();
      try {
        resolve(readResults(data));
      } catch (error) {
        reject(error);
      }
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('The fallback request failed.'));
    };

    script.src = `${API_URL}?${params}&callback=${callbackName}`;
    document.head.append(script);
  });
}

/**
 * Fetch the artist's songs, trying the direct request first and falling back
 * to JSONP only when the direct one fails at the network/CORS level.
 * Throws an Error carrying a user-friendly message when both routes fail.
 * @returns {Promise<Array<object>>} raw iTunes song objects
 */
async function fetchSongs() {
  const params = buildParams();

  try {
    return await fetchViaCors(params);
  } catch (error) {
    // An HTTP status or a bad payload means the network is fine — surface it.
    if (!error.isNetworkError) throw error;

    try {
      return await fetchViaJsonp(params);
    } catch {
      // Both routes are down. At this point it is the network, not the page.
      const failure = new Error(
        'Could not reach the iTunes API — the direct request and the CORS-free fallback both failed. '
        + 'A corporate firewall, VPN or ad-blocker blocking itunes.apple.com is the usual cause.',
      );
      failure.showApiLink = true;
      throw failure;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. TRANSFORM                                                        */
/* ------------------------------------------------------------------ */

/**
 * Convert milliseconds to mm:ss. Minutes are not wrapped into hours, so a
 * 74-minute album reads "74:05" rather than "1:14:05".
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Convert milliseconds to a long, human form like "13h 42m" — used for totals
 * where mm:ss would be unreadable.
 * @param {number} ms
 * @returns {string}
 */
function formatLongDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Turn the flat song list into album objects: grouped by album, tracks sorted
 * by track number, durations computed, albums ordered newest release first.
 * @param {Array<object>} songs raw iTunes results
 * @returns {Array<object>} album view-models
 */
function groupSongsByAlbum(songs) {
  const albums = new Map();

  for (const song of songs) {
    // Defensive: the API occasionally mixes in entries without a collection.
    const albumName = song.collectionName || 'Unknown Album';
    // Key on collectionId when available: two releases can share a title,
    // and the id keeps them apart.
    const key = song.collectionId != null ? String(song.collectionId) : albumName;

    if (!albums.has(key)) {
      albums.set(key, {
        id: key,
        name: albumName,
        artist: song.artistName || 'Unknown Artist',
        // artworkUrl100 is a 100x100 thumbnail; the CDN serves other sizes at
        // the same path, so we ask for a sharper one.
        artwork: song.artworkUrl100 ? song.artworkUrl100.replace('100x100', '300x300') : '',
        releaseDate: song.releaseDate || '',
        genre: song.primaryGenreName || '',
        // How many songs the album really has, per the API. We may have fetched
        // fewer of them, and the card is explicit about that.
        totalTrackCount: Number.isFinite(song.trackCount) ? song.trackCount : null,
        tracks: [],
      });
    }

    albums.get(key).tracks.push({
      number: Number.isFinite(song.trackNumber) ? song.trackNumber : null,
      name: song.trackName || 'Untitled',
      millis: Number.isFinite(song.trackTimeMillis) ? song.trackTimeMillis : null,
    });
  }

  const result = [];

  for (const album of albums.values()) {
    // Sort tracks by track number; entries without one go last, alphabetically.
    album.tracks.sort((a, b) => {
      if (a.number == null && b.number == null) return a.name.localeCompare(b.name);
      if (a.number == null) return 1;
      if (b.number == null) return -1;
      return a.number - b.number;
    });

    // Duration stats ignore tracks with no reported length, so one missing
    // value does not drag the average down to zero.
    const timedTracks = album.tracks.filter((track) => track.millis != null);
    const totalMillis = timedTracks.reduce((sum, track) => sum + track.millis, 0);

    album.trackCount = album.tracks.length;
    album.totalMillis = totalMillis;
    // True when the fetch limit gave us only part of this album.
    album.isPartial =
      album.totalTrackCount != null && album.totalTrackCount > album.trackCount;
    album.totalDuration = timedTracks.length ? formatDuration(totalMillis) : '--:--';
    album.averageDuration = timedTracks.length
      ? formatDuration(totalMillis / timedTracks.length)
      : '--:--';
    album.year = album.releaseDate ? album.releaseDate.slice(0, 4) : 'Unknown year';

    result.push(album);
  }

  // Newest album first. releaseDate is an ISO 8601 string, so a plain string
  // comparison already orders correctly; albums without a date sink to the end.
  result.sort((a, b) => {
    if (!a.releaseDate && !b.releaseDate) return a.name.localeCompare(b.name);
    if (!a.releaseDate) return 1;
    if (!b.releaseDate) return -1;
    return b.releaseDate.localeCompare(a.releaseDate);
  });

  return result;
}

/**
 * Find the most frequent meaningful word across song titles.
 * Punctuation and bracketed suffixes like "(feat. X)" are stripped first, then
 * stop words are dropped so the winner is not "the".
 * @param {Array<object>} songs
 * @returns {{word: string, count: number}|null}
 */
function findMostUsedWord(songs) {
  const counts = new Map();

  for (const song of songs) {
    if (!song.trackName) continue;
    const words = song.trackName
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, ' ') // drop "(feat. ...)", "[Bonus Track]"
      .replace(/[^a-z0-9'\s]/g, ' ')    // keep letters, digits, apostrophes
      .split(/\s+/);

    for (const raw of words) {
      const word = raw.replace(/'/g, '');
      // Single letters are noise, and stop words would win every time.
      if (word.length < 2 || STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }

  let best = null;
  for (const [word, count] of counts) {
    if (!best || count > best.count) best = { word, count };
  }
  // A word used once is a coincidence, not a pattern.
  return best && best.count > 1 ? best : null;
}

/**
 * Derive the statistics the page is built around.
 * @param {Array<object>} songs raw iTunes results
 * @param {Array<object>} albums output of groupSongsByAlbum
 * @returns {object} stats view-model
 */
function computeStats(songs, albums) {
  // Only tracks with a reported length can take part in duration maths.
  const timed = songs.filter((song) => Number.isFinite(song.trackTimeMillis));
  const totalMillis = timed.reduce((sum, song) => sum + song.trackTimeMillis, 0);

  // Longest / shortest single track.
  let longest = null;
  let shortest = null;
  for (const song of timed) {
    if (!longest || song.trackTimeMillis > longest.trackTimeMillis) longest = song;
    if (!shortest || song.trackTimeMillis < shortest.trackTimeMillis) shortest = song;
  }

  // Explicit rate. iTunes reports "explicit", "cleaned" or "notExplicit".
  const explicitCount = songs.filter((song) => song.trackExplicitness === 'explicit').length;

  // Songs per release year, ascending — this feeds the bar chart.
  const perYear = new Map();
  for (const song of songs) {
    if (!song.releaseDate) continue;
    const year = song.releaseDate.slice(0, 4);
    perYear.set(year, (perYear.get(year) || 0) + 1);
  }
  // Fill the gaps: a year with no releases must appear on the axis as an empty
  // slot, otherwise the chart silently compresses time and a three-year pause
  // looks like a one-year one.
  const yearCounts = [];
  const knownYears = [...perYear.keys()].map(Number).sort((a, b) => a - b);
  if (knownYears.length) {
    for (let year = knownYears[0]; year <= knownYears[knownYears.length - 1]; year++) {
      yearCounts.push({ year: String(year), count: perYear.get(String(year)) || 0 });
    }
  }

  const busiestYear = yearCounts.reduce(
    (best, entry) => (!best || entry.count > best.count ? entry : best),
    null,
  );

  // Guest spots: the search matched the artist field, so a different artistName
  // means this is someone else's track that he appears on.
  const guestSpots = songs.filter(
    (song) => (song.artistName || '').toLowerCase() !== ARTIST.toLowerCase(),
  ).length;

  // Tracks where he hosts someone else, spotted by the title's "(feat. ...)".
  // Restricted to his own releases, so a track where *he* is the guest is not
  // counted twice (it already shows up as a guest spot above).
  const featuresHosted = songs.filter(
    (song) =>
      (song.artistName || '').toLowerCase() === ARTIST.toLowerCase() &&
      /\b(feat\.?|featuring|ft\.?)\b/i.test(song.trackName || ''),
  ).length;

  // Longest album by total runtime, among the albums we actually built.
  const longestAlbum = albums.reduce(
    (best, album) => (!best || album.totalMillis > best.totalMillis ? album : best),
    null,
  );

  const years = yearCounts.map((entry) => entry.year);

  return {
    songCount: songs.length,
    albumCount: albums.length,
    totalListening: formatLongDuration(totalMillis),
    firstYear: years.length ? years[0] : null,
    lastYear: years.length ? years[years.length - 1] : null,
    averageDuration: timed.length ? formatDuration(totalMillis / timed.length) : '--:--',
    longest,
    shortest,
    explicitCount,
    explicitRate: songs.length ? Math.round((explicitCount / songs.length) * 100) : 0,
    yearCounts,
    busiestYear,
    guestSpots,
    featuresHosted,
    longestAlbum,
    mostUsedWord: findMostUsedWord(songs),
  };
}

/* ------------------------------------------------------------------ */
/* 3. DISPLAY                                                          */
/* ------------------------------------------------------------------ */

/**
 * Show a message in the status area.
 * @param {string} message
 * @param {boolean} [isError]
 * @param {boolean} [withApiLink] append a link that opens the raw API URL, so
 *   the user can tell a blocked network apart from a bug in this page
 */
function showStatus(message, isError = false, withApiLink = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('status--error', isError);

  if (!withApiLink) return;

  const hint = el('p', 'status__hint');
  hint.append(document.createTextNode('Open '));
  const link = document.createElement('a');
  link.href = `${API_URL}?${buildParams()}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'the API URL directly';
  hint.append(link);
  hint.append(document.createTextNode(
    ' — if that page does not load either, the block is on your network, not in this page.',
  ));
  statusEl.append(hint);
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.classList.remove('status--error');
}

/**
 * Small helper: build an element with a class and text in one call.
 * Text always goes through textContent, never innerHTML, so values coming from
 * the API can never be interpreted as markup.
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Render the four headline numbers.
 * @param {object} stats
 */
function renderHero(stats) {
  const span = stats.firstYear
    ? (stats.firstYear === stats.lastYear ? stats.firstYear : `${stats.firstYear}–${stats.lastYear}`)
    : '--';

  const tiles = [
    { value: String(stats.songCount), label: 'songs catalogued' },
    { value: String(stats.albumCount), label: 'albums & releases' },
    { value: stats.totalListening, label: 'to play it all' },
    { value: span, label: 'years covered' },
  ];

  const fragment = document.createDocumentFragment();
  for (const tile of tiles) {
    const card = el('div', 'stat');
    card.append(el('p', 'stat__value', tile.value), el('p', 'stat__label', tile.label));
    fragment.append(card);
  }
  heroEl.replaceChildren(fragment);
}

/**
 * Render the fact cards. Each fact is {title, value, detail}; anything that
 * could not be computed is left out rather than shown as a blank card.
 * @param {object} stats
 */
function renderFacts(stats) {
  const facts = [];

  if (stats.longest) {
    facts.push({
      title: 'Longest track',
      value: formatDuration(stats.longest.trackTimeMillis),
      detail: `“${stats.longest.trackName}” — ${stats.longest.collectionName || 'unknown album'}`,
    });
  }

  if (stats.shortest) {
    facts.push({
      title: 'Shortest track',
      value: formatDuration(stats.shortest.trackTimeMillis),
      detail: `“${stats.shortest.trackName}” — ${stats.shortest.collectionName || 'unknown album'}`,
    });
  }

  facts.push({
    title: 'Average song length',
    value: stats.averageDuration,
    detail: 'Across every track with a reported duration.',
  });

  facts.push({
    title: 'Marked explicit',
    value: `${stats.explicitRate}%`,
    detail: `${stats.explicitCount} of ${stats.songCount} tracks carry the explicit tag.`,
  });

  if (stats.busiestYear) {
    facts.push({
      title: 'Busiest year',
      value: stats.busiestYear.year,
      detail: `${stats.busiestYear.count} songs released or re-released that year.`,
    });
  }

  if (stats.mostUsedWord) {
    facts.push({
      title: 'Most used word in titles',
      value: `“${stats.mostUsedWord.word}”`,
      detail: `Appears in ${stats.mostUsedWord.count} song titles, ignoring common words.`,
    });
  }

  if (stats.featuresHosted) {
    facts.push({
      title: 'Tracks with a guest',
      value: String(stats.featuresHosted),
      detail: 'Titles that credit another artist with “feat.”.',
    });
  }

  if (stats.guestSpots) {
    facts.push({
      title: 'Appearances for others',
      value: String(stats.guestSpots),
      detail: 'Tracks released under another artist’s name.',
    });
  }

  if (stats.longestAlbum) {
    facts.push({
      title: 'Longest release',
      value: stats.longestAlbum.totalDuration,
      detail: `“${stats.longestAlbum.name}” — ${stats.longestAlbum.trackCount} tracks here.`,
    });
  }

  const fragment = document.createDocumentFragment();
  for (const fact of facts) {
    const card = el('article', 'fact');
    card.append(
      el('p', 'fact__title', fact.title),
      el('p', 'fact__value', fact.value),
      el('p', 'fact__detail', fact.detail),
    );
    fragment.append(card);
  }
  factsEl.replaceChildren(fragment);
}

/**
 * Render the songs-per-year bar chart.
 * One series, so no legend is needed — the heading names it. Only the tallest
 * bar is labelled directly; the rest are available on hover and in the table
 * below, which is visually hidden but read by screen readers.
 * @param {object} stats
 */
function renderChart(stats) {
  const data = stats.yearCounts;

  if (data.length === 0) {
    chartEl.replaceChildren(el('p', 'section__note', 'No release dates available to chart.'));
    chartTableEl.replaceChildren();
    chartNoteEl.textContent = '';
    return;
  }

  const max = Math.max(...data.map((entry) => entry.count));
  chartNoteEl.textContent =
    `Counts re-releases and deluxe editions too, which is why a year can spike.`;

  const plot = el('div', 'chart__plot');
  plot.setAttribute('role', 'img');
  plot.setAttribute(
    'aria-label',
    `Bar chart of songs per release year, from ${data[0].year} to ${data[data.length - 1].year}.`,
  );

  for (const entry of data) {
    const column = el('div', 'chart__column');

    const barWrap = el('div', 'chart__bar-wrap');
    // Heights are a percentage of the tallest bar, capped below 100% so the
    // peak's label has room above it inside the plot.
    const heightPercent = (entry.count / max) * 88;

    const bar = el('div', 'chart__bar');
    // A year with no releases draws nothing — a minimum-height nub would read
    // as "a little" rather than "none".
    bar.style.height = entry.count ? `${heightPercent}%` : '0';
    if (!entry.count) bar.classList.add('chart__bar--zero');
    // Native tooltip: no extra JS, works on hover and on focus.
    bar.title = entry.count
      ? `${entry.year}: ${entry.count} song${entry.count === 1 ? '' : 's'}`
      : `${entry.year}: no releases`;
    barWrap.append(bar);

    // Direct-label the peak only, rather than every bar. The label sits just
    // above the bar, on the surface, so it never fights the fill for contrast.
    if (entry.count === max) {
      const label = el('span', 'chart__peak-label', String(entry.count));
      label.style.bottom = `calc(${heightPercent}% + 4px)`;
      barWrap.append(label);
    }

    column.append(barWrap, el('span', 'chart__year', entry.year));
    plot.append(column);
  }

  chartEl.replaceChildren(plot);

  // Same numbers as a real table, for assistive tech and for anyone who wants
  // the values rather than the shape.
  const caption = el('caption', '', 'Songs per release year');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.append(el('th', '', 'Year'), el('th', '', 'Songs'));
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const entry of data) {
    const row = document.createElement('tr');
    row.append(el('td', '', entry.year), el('td', '', String(entry.count)));
    body.append(row);
  }
  chartTableEl.replaceChildren(caption, head, body);
}

/**
 * Build the DOM for one album card.
 * @param {object} album
 * @returns {HTMLElement}
 */
function renderAlbumCard(album) {
  const card = el('article', 'album');
  const header = el('div', 'album__header');

  const art = document.createElement('img');
  art.className = 'album__art';
  art.src = album.artwork;
  art.alt = `Cover of ${album.name}`;
  art.loading = 'lazy';
  // A broken artwork URL should leave an empty box, not a broken-image icon.
  art.addEventListener('error', () => { art.style.visibility = 'hidden'; });

  const meta = el('div', 'album__meta');
  const name = el('h3', 'album__name', album.name);
  const artist = el('p', 'album__artist', album.genre
    ? `${album.artist} · ${album.year} · ${album.genre}`
    : `${album.artist} · ${album.year}`);

  // Be explicit when the fetch limit means we only have part of the album:
  // the totals are for the songs shown, not the whole record.
  const trackLabel = album.trackCount === 1 ? 'track' : 'tracks';
  const countText = album.isPartial
    ? `${album.trackCount} of ${album.totalTrackCount} tracks`
    : `${album.trackCount} ${trackLabel}`;
  const facts = el('p', 'album__facts',
    `${countText} · total ${album.totalDuration} · avg ${album.averageDuration}`);
  if (album.isPartial) {
    facts.classList.add('album__facts--partial');
    facts.title = 'Only part of this album was returned by the search; totals cover the songs shown.';
  }

  meta.append(name, artist, facts);
  header.append(art, meta);

  const list = el('ol', 'tracks');
  album.tracks.forEach((track, index) => {
    const item = el('li', 'track');
    // Fall back to the position in the list when the API has no track number.
    const number = el('span', 'track__number', `${track.number ?? index + 1}.`);
    const trackName = el('span', 'track__name', track.name);
    trackName.title = track.name; // full name on hover when truncated
    const time = el('span', 'track__time',
      track.millis != null ? formatDuration(track.millis) : '--:--');
    item.append(number, trackName, time);
    list.append(item);
  });

  card.append(header, list);
  return card;
}

/**
 * Paint the album grid, its summary line and the "show all" button.
 * Toggling only re-renders — it never refetches.
 */
function paintAlbums() {
  const total = currentAlbums.length;
  const capped = !showingAllAlbums && total > ALBUM_DISPLAY_LIMIT;
  const visible = capped ? currentAlbums.slice(0, ALBUM_DISPLAY_LIMIT) : currentAlbums;

  const shownTracks = visible.reduce((sum, album) => sum + album.trackCount, 0);
  albumsSummaryEl.textContent = capped
    ? `Showing the ${visible.length} most recent of ${total} releases.`
    : `${total} release${total === 1 ? '' : 's'} · ${shownTracks} song${shownTracks === 1 ? '' : 's'}.`;

  // Build off-screen and attach once, so the browser lays out a single time.
  const fragment = document.createDocumentFragment();
  visible.forEach((album) => fragment.append(renderAlbumCard(album)));
  albumsEl.replaceChildren(fragment);

  // The button only exists when there is something left to reveal.
  if (total > ALBUM_DISPLAY_LIMIT) {
    showMoreButton.hidden = false;
    showMoreButton.textContent = showingAllAlbums
      ? 'Show fewer releases'
      : `Show all ${total} releases`;
  } else {
    showMoreButton.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run the whole flow: fetch -> transform -> display, handling every failure.
 */
async function load() {
  retryButton.hidden = true;
  contentEl.hidden = true;
  showStatus(`Loading ${ARTIST}’s catalogue…`);

  try {
    const songs = await fetchSongs();

    if (songs.length === 0) {
      showStatus(`The iTunes API returned no songs for ${ARTIST}. Try again later.`);
      retryButton.hidden = false;
      return;
    }

    const albums = groupSongsByAlbum(songs);
    const stats = computeStats(songs, albums);

    currentAlbums = albums;
    showingAllAlbums = false;

    renderHero(stats);
    renderFacts(stats);
    renderChart(stats);
    paintAlbums();

    clearStatus();
    contentEl.hidden = false;
  } catch (error) {
    // Everything surfaces as a readable message; the page stays usable and the
    // retry button lets the user recover without reloading.
    showStatus(
      error.message || 'Something went wrong. Please try again.',
      true,
      error.showApiLink === true,
    );
    retryButton.hidden = false;
    console.error('Load failed:', error);
  }
}

showMoreButton.addEventListener('click', () => {
  showingAllAlbums = !showingAllAlbums;
  paintAlbums();
});

retryButton.addEventListener('click', load);

// The page has one job, so it starts working as soon as it opens.
load();

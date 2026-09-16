/**
 * Music Explorer
 * --------------
 * Search for an artist, then: FETCH their songs from the iTunes Search API ->
 * TRANSFORM the flat song list into albums and a set of derived statistics ->
 * DISPLAY those as headline numbers, a cover-flow timeline, fact cards, a
 * per-year bar chart and album cards.
 */

'use strict';

// Lets the guard at the bottom of index.html confirm this file actually ran.
window.MUSIC_EXPLORER_LOADED = true;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const SEARCH_URL = 'https://itunes.apple.com/search';
const LOOKUP_URL = 'https://itunes.apple.com/lookup';

// One artist at a time is a small, bounded dataset, so we take the API's full
// slice (200 is its maximum) — the statistics are only as good as the sample.
const RESULT_LIMIT = 200;

// Albums rendered before the "show all" button appears.
const ALBUM_DISPLAY_LIMIT = 6;

// Autocomplete tuning.
const SUGGEST_LIMIT = 8;      // rows in the dropdown
const SUGGEST_MIN_CHARS = 2;  // below this, one letter matches half the store
const SUGGEST_DEBOUNCE = 250; // ms of quiet typing before a request goes out

// Offered on the empty first-run screen so the page is usable without ideas.
const EXAMPLE_ARTISTS = ['Mac Miller', 'Radiohead', 'Shakira', 'Kendrick Lamar'];

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
const timelineSectionEl = document.getElementById('timeline-section');
const flowStageEl = document.getElementById('flow-stage');
const flowCaptionEl = document.getElementById('flow-caption');
const flowTitleEl = document.getElementById('flow-title');
const flowDateEl = document.getElementById('flow-date');
const flowSliderEl = document.getElementById('flow-slider');
const flowStartEl = document.getElementById('flow-start');
const flowEndEl = document.getElementById('flow-end');
const searchFormEl = document.getElementById('search-form');
const searchInputEl = document.getElementById('search-input');
const suggestionsEl = document.getElementById('suggestions');
const emptyStateEl = document.getElementById('empty-state');
const emptyExamplesEl = document.getElementById('empty-examples');
const artistNameEl = document.getElementById('artist-name');
const artistMetaEl = document.getElementById('artist-meta');

// Current result set, kept so the "show all" toggle can re-render without refetching.
let currentAlbums = [];
let showingAllAlbums = false;
let currentArtist = null;   // the {artistId, artistName} currently displayed

/* Autocomplete state ------------------------------------------------ */

let suggestItems = [];      // the artists currently listed
let suggestActive = -1;     // highlighted row, -1 for none
let suggestTimer = null;    // debounce handle
let suggestToken = 0;       // ignores responses that arrive out of order
let loadToken = 0;          // same idea for the main load

// Two small caches. Re-typing a query or revisiting an artist then costs
// nothing, which matters because iTunes rate-limits at around 20 calls/minute
// and an autocomplete can burn through that quickly.
const suggestCache = new Map();
const artistSongsCache = new Map();

/* Cover-flow state -------------------------------------------------- */

const FLOW_MAX_ANGLE = 45;    // degrees a side cover is turned toward the centre
const FLOW_DEPTH = 150;       // px a side cover is pushed back
const FLOW_SCALE_DROP = 0.26; // how much smaller a side cover gets
const FLOW_VISIBLE = 4;       // covers shown either side before fading out

let flowAlbums = [];      // oldest first — a timeline runs left to right
let flowCovers = [];      // the DOM nodes, same order
let flowPosition = 0;     // fractional: 2.4 means "between covers 2 and 3"
let flowCaptioned = -1;   // index the caption currently describes
let flowCoverWidth = 0;   // measured, so offsets scale with the CSS size
let captionToken = 0;     // guards against overlapping caption swaps

// Respect the OS "reduce motion" setting: no stagger, no long transitions.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ------------------------------------------------------------------ */
/* 1. FETCH                                                            */
/* ------------------------------------------------------------------ */

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
 * @param {string} url
 * @param {URLSearchParams} params
 * @returns {Promise<Array<object>>}
 */
async function fetchViaCors(url, params) {
  let response;
  try {
    response = await fetch(`${url}?${params}`);
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
 * @param {string} url
 * @param {URLSearchParams} params
 * @returns {Promise<Array<object>>}
 */
function fetchViaJsonp(url, params) {
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

    script.src = `${url}?${params}&callback=${callbackName}`;
    document.head.append(script);
  });
}

/**
 * Every call to the API goes through here: try the direct request, fall back to
 * JSONP only when it failed at the network/CORS level.
 * @param {string} url
 * @param {object} query plain object of query parameters
 * @returns {Promise<Array<object>>}
 */
async function requestApi(url, query) {
  // URLSearchParams encodes values safely (spaces, accents, &, etc.).
  const params = new URLSearchParams(query);

  try {
    return await fetchViaCors(url, params);
  } catch (error) {
    // An HTTP status or a bad payload means the network is fine — surface it.
    if (!error.isNetworkError) throw error;

    try {
      return await fetchViaJsonp(url, params);
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

/**
 * Find artists matching what has been typed so far.
 * entity=musicArtist asks for artists rather than songs, which is what makes
 * this a name lookup instead of a full catalogue search.
 * @param {string} term
 * @returns {Promise<Array<object>>} artist records
 */
async function searchArtists(term) {
  const key = term.toLowerCase();
  if (suggestCache.has(key)) return suggestCache.get(key);

  const results = await requestApi(SEARCH_URL, {
    term,
    entity: 'musicArtist',
    limit: String(SUGGEST_LIMIT),
  });

  // The API can repeat an artist across storefront entries; keep the first of each.
  const seen = new Set();
  const artists = results.filter((artist) => {
    if (!artist.artistName || artist.artistId == null) return false;
    if (seen.has(artist.artistId)) return false;
    seen.add(artist.artistId);
    return true;
  });

  // Keep the cache from growing without bound over a long session.
  if (suggestCache.size > 50) suggestCache.clear();
  suggestCache.set(key, artists);
  return artists;
}

/**
 * Fetch one artist's songs by id.
 *
 * The lookup endpoint takes the artistId the suggestion already gave us, so
 * there is no name matching left to get wrong — no risk of a different artist
 * with a similar name, and no tracks that merely mention them.
 *
 * @param {number|string} artistId
 * @returns {Promise<Array<object>>} raw iTunes song objects
 */
async function fetchArtistSongs(artistId) {
  const key = String(artistId);
  if (artistSongsCache.has(key)) return artistSongsCache.get(key);

  const results = await requestApi(LOOKUP_URL, {
    id: key,
    entity: 'song',
    limit: String(RESULT_LIMIT),
  });

  // A lookup answers with the artist record first, then the tracks.
  const songs = results.filter((item) => item.wrapperType === 'track' || item.trackName);
  artistSongsCache.set(key, songs);
  return songs;
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
 * @param {string} artistName who the page is about — decides which tracks count
 *   as their own releases and which are guest appearances
 * @returns {object} stats view-model
 */
function computeStats(songs, albums, artistName) {
  const ownName = (artistName || '').toLowerCase();
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
    (song) => (song.artistName || '').toLowerCase() !== ownName,
  ).length;

  // Tracks where he hosts someone else, spotted by the title's "(feat. ...)".
  // Restricted to his own releases, so a track where *he* is the guest is not
  // counted twice (it already shows up as a guest spot above).
  const featuresHosted = songs.filter(
    (song) =>
      (song.artistName || '').toLowerCase() === ownName &&
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
  // Point at whatever the user was actually after, so the test is meaningful.
  const probeTerm = currentArtist?.artistName || searchInputEl.value.trim() || 'radiohead';
  link.href = `${SEARCH_URL}?${new URLSearchParams({
    term: probeTerm,
    entity: 'musicArtist',
    limit: '5',
  })}`;
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

/* ---------- Cover-flow timeline ---------- */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Format an ISO release date as "3 August 2018".
 * Parsed by slicing rather than with `new Date`, which would shift the day
 * across time zones and could show the wrong date.
 * @param {string} iso
 * @returns {string}
 */
function formatReleaseDate(iso) {
  if (!iso || iso.length < 10) return '';
  const year = iso.slice(0, 4);
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (!Number.isFinite(month) || !MONTH_NAMES[month - 1]) return year;
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * The 3D transform for a cover sitting `distance` slots from the centre.
 * Fractional distances are expected — that is what makes scrubbing continuous
 * rather than stepping from cover to cover.
 * @param {number} distance signed: negative is left of centre
 * @returns {string} a CSS transform
 */
function coverTransform(distance) {
  const magnitude = Math.abs(distance);
  const direction = Math.sign(distance);
  // The first neighbour sits well clear of the centre cover; the ones behind it
  // are packed much tighter, which is what gives cover flow its receding stack.
  const nearGap = flowCoverWidth * 0.78;
  const farGap = flowCoverWidth * 0.17;
  const x = direction * (magnitude <= 1
    ? magnitude * nearGap
    : nearGap + (magnitude - 1) * farGap);

  // Rotation and scale only ramp over the first slot, then hold — so the whole
  // side stack shares one angle, exactly like the original.
  const ramp = Math.min(magnitude, 1);
  const rotation = -direction * ramp * FLOW_MAX_ANGLE;
  const depth = -ramp * FLOW_DEPTH - Math.max(0, magnitude - 1) * 22;
  const scale = 1 - ramp * FLOW_SCALE_DROP;

  return `translateX(${x}px) translateZ(${depth}px) rotateY(${rotation}deg) scale(${scale})`;
}

/**
 * Position every cover for the current scrub position.
 */
function applyFlowTransforms() {
  flowCovers.forEach((cover, index) => {
    const distance = index - flowPosition;
    const magnitude = Math.abs(distance);

    cover.style.transform = coverTransform(distance);
    // Nearer covers must paint on top of the ones stacked behind them.
    cover.style.zIndex = String(Math.round(100 - magnitude * 10));

    // Fade the far ends out instead of cutting them off abruptly.
    let opacity = 1;
    if (magnitude > FLOW_VISIBLE + 0.5) opacity = 0;
    else if (magnitude > FLOW_VISIBLE - 0.5) opacity = FLOW_VISIBLE + 0.5 - magnitude;
    cover.style.opacity = String(opacity);
    cover.style.pointerEvents = opacity < 0.1 ? 'none' : 'auto';
  });
}

/**
 * Write the caption for an album, one letter at a time.
 * @param {object} album
 */
function fillCaption(album) {
  flowTitleEl.replaceChildren();

  // Each character is its own span so it can carry its own delay. textContent
  // keeps album names from being read as markup, same rule as everywhere else.
  [...album.name].forEach((character, index) => {
    const span = el('span', 'flow__letter', character === ' ' ? ' ' : character);
    if (!reduceMotion.matches) span.style.animationDelay = `${index * 14}ms`;
    flowTitleEl.append(span);
  });

  flowDateEl.textContent = formatReleaseDate(album.releaseDate);
}

/**
 * Swap the caption to a new album.
 *
 * Two modes, because one does not fit both gestures. Mid-drag the swap is
 * instant: the animated version fades out first, and during a fast scrub each
 * new index cancels the previous fade, so the caption would sit invisible until
 * the hand stopped. On landing it plays in full — fade the old one out, then
 * bring the new one in letter by letter.
 *
 * @param {number} index
 * @param {object} [options]
 * @param {boolean} [options.animate] false for an instant swap
 * @param {boolean} [options.force] replay even if the album has not changed
 */
function updateCaption(index, { animate = true, force = false } = {}) {
  if (index === flowCaptioned && !force) return;
  const album = flowAlbums[index];
  if (!album) return;

  flowCaptioned = index;
  // Keep assistive tech in step with what the slider is pointing at.
  flowSliderEl.setAttribute('aria-valuetext', `${album.name}, ${album.year}`);

  if (!animate || reduceMotion.matches) {
    // Abandon any fade still in flight, so it cannot overwrite this.
    captionToken += 1;
    flowCaptionEl.classList.remove('is-leaving');
    fillCaption(album);
    return;
  }

  const token = ++captionToken;
  flowCaptionEl.classList.add('is-leaving');

  setTimeout(() => {
    // A newer swap started while this one was fading; it owns the caption now.
    if (token !== captionToken) return;
    fillCaption(album);
    flowCaptionEl.classList.remove('is-leaving');
  }, 150);
}

/**
 * Move the carousel.
 * @param {number} position fractional index
 * @param {boolean} [glide] true to animate there, false while dragging
 */
function setFlowPosition(position, glide = false) {
  const last = flowAlbums.length - 1;
  flowPosition = Math.max(0, Math.min(last, position));

  // Transitions are switched off mid-drag: the pointer is already supplying
  // every frame, and easing on top of it would feel like lag.
  flowStageEl.classList.toggle('is-gliding', glide && !reduceMotion.matches);

  applyFlowTransforms();
  // Gliding means the carousel is settling on a cover, which is the moment the
  // caption gets its full entrance; dragging just keeps it in sync.
  updateCaption(Math.round(flowPosition), { animate: glide, force: glide });
}

/**
 * Jump to a whole album — used by cover clicks and the arrow keys.
 * @param {number} index
 */
function goToAlbum(index) {
  const last = flowAlbums.length - 1;
  const target = Math.max(0, Math.min(last, Math.round(index)));
  flowSliderEl.value = String(target);
  setFlowPosition(target, true);
}

/**
 * Build the cover-flow timeline.
 * @param {Array<object>} albums newest-first, as produced by groupSongsByAlbum
 */
function renderTimeline(albums) {
  // A timeline needs dates and runs forwards, so drop the undated releases and
  // reverse the newest-first order the rest of the page uses.
  flowAlbums = albums.filter((album) => album.releaseDate).slice().reverse();

  if (flowAlbums.length === 0) {
    timelineSectionEl.hidden = true;
    return;
  }
  timelineSectionEl.hidden = false;

  const fragment = document.createDocumentFragment();
  flowCovers = flowAlbums.map((album, index) => {
    const cover = el('figure', 'flow__cover');

    if (album.artwork) {
      const art = document.createElement('img');
      art.className = 'flow__art';
      art.src = album.artwork;
      art.alt = `Cover of ${album.name}`;
      art.loading = 'lazy';
      art.draggable = false;
      art.addEventListener('error', () => { art.style.visibility = 'hidden'; });
      cover.append(art);
    } else {
      // No artwork: a plain tile with the album name beats a broken image.
      cover.append(el('div', 'flow__art flow__art--empty', album.name));
    }

    // Clicking a cover is the shortcut for dragging the slider to it.
    cover.addEventListener('click', () => goToAlbum(index));
    fragment.append(cover);
    return cover;
  });

  flowStageEl.replaceChildren(fragment);

  flowSliderEl.max = String(flowAlbums.length - 1);
  flowSliderEl.value = '0';
  flowStartEl.textContent = flowAlbums[0].year;
  flowEndEl.textContent = flowAlbums[flowAlbums.length - 1].year;

  // Offsets are multiples of the rendered cover width, so measure it rather
  // than hard-coding a number the CSS could change underneath us.
  flowCoverWidth = flowCovers[0].offsetWidth || 180;

  flowCaptioned = -1;
  setFlowPosition(0);
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
/* Autocomplete                                                        */
/* ------------------------------------------------------------------ */

/**
 * Close the dropdown and reset its state.
 */
function closeSuggestions() {
  suggestionsEl.hidden = true;
  suggestionsEl.replaceChildren();
  suggestItems = [];
  suggestActive = -1;
  searchInputEl.setAttribute('aria-expanded', 'false');
  searchInputEl.removeAttribute('aria-activedescendant');
}

/**
 * Mark one row as highlighted and tell assistive tech which it is.
 * @param {number} index -1 clears the highlight
 */
function setSuggestActive(index) {
  const rows = [...suggestionsEl.querySelectorAll('.suggestion')];
  rows.forEach((row, i) => row.classList.toggle('is-active', i === index));
  suggestActive = index;

  if (index < 0 || !rows[index]) {
    searchInputEl.removeAttribute('aria-activedescendant');
    return;
  }
  searchInputEl.setAttribute('aria-activedescendant', rows[index].id);
  // Keep the highlighted row in view when arrowing past the visible rows.
  rows[index].scrollIntoView({ block: 'nearest' });
}

/**
 * Draw the dropdown.
 * @param {Array<object>} artists
 * @param {string} term what was typed, for the empty message
 */
function renderSuggestions(artists, term) {
  suggestItems = artists;
  suggestActive = -1;
  const list = document.createDocumentFragment();

  if (artists.length === 0) {
    // The "not found" case the brief asks for: say so in place, rather than
    // letting the user press Enter into a dead end.
    const empty = el('li', 'suggestion suggestion--empty', `No artists found for “${term}”.`);
    empty.setAttribute('role', 'presentation');
    list.append(empty);
  } else {
    artists.forEach((artist, index) => {
      const row = el('li', 'suggestion');
      row.id = `suggestion-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');

      row.append(el('span', 'suggestion__name', artist.artistName));
      if (artist.primaryGenreName) {
        row.append(el('span', 'suggestion__genre', artist.primaryGenreName));
      }

      // mousedown, not click: the input's blur would close the list first.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        selectArtist(artist);
      });
      row.addEventListener('mouseenter', () => setSuggestActive(index));
      list.append(row);
    });
  }

  suggestionsEl.replaceChildren(list);
  suggestionsEl.hidden = false;
  searchInputEl.setAttribute('aria-expanded', 'true');
}

/**
 * Ask for suggestions for what has been typed, debounced.
 * @param {string} term
 */
function requestSuggestions(term) {
  const token = ++suggestToken;

  searchArtists(term)
    .then((artists) => {
      // A newer keystroke already went out; this answer is stale.
      if (token !== suggestToken) return;
      // The user cleared or shrank the box while we waited.
      if (searchInputEl.value.trim().length < SUGGEST_MIN_CHARS) return;
      renderSuggestions(artists, term);
    })
    .catch(() => {
      // Suggestions are a convenience. If they fail, stay quiet and let the
      // user submit anyway — the main search reports errors properly.
      if (token === suggestToken) closeSuggestions();
    });
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Clear everything belonging to the previously displayed artist, so a new one
 * never inherits stale covers, albums or carousel position.
 */
function resetResults() {
  contentEl.hidden = true;
  currentAlbums = [];
  showingAllAlbums = false;
  flowAlbums = [];
  flowCovers = [];
  flowPosition = 0;
  flowCaptioned = -1;
  flowStageEl.replaceChildren();
  albumsEl.replaceChildren();
  showMoreButton.hidden = true;
}

/**
 * Load and display one artist.
 * @param {object} artist an iTunes artist record
 */
async function loadArtist(artist) {
  const token = ++loadToken;

  currentArtist = artist;
  closeSuggestions();
  resetResults();
  emptyStateEl.hidden = true;
  retryButton.hidden = true;
  showStatus(`Loading ${artist.artistName}’s catalogue…`);

  try {
    const songs = await fetchArtistSongs(artist.artistId);
    // A newer search started while this one was in flight.
    if (token !== loadToken) return;

    if (songs.length === 0) {
      // The artist exists in the store but has no songs we can read.
      showStatus(`We found ${artist.artistName}, but the API returned no songs for them.`);
      retryButton.hidden = false;
      return;
    }

    const albums = groupSongsByAlbum(songs);
    const stats = computeStats(songs, albums, artist.artistName);

    currentAlbums = albums;

    artistNameEl.textContent = artist.artistName;
    artistMetaEl.textContent = artist.primaryGenreName
      ? `${artist.primaryGenreName} · ${stats.songCount} songs catalogued`
      : `${stats.songCount} songs catalogued`;
    document.title = `${artist.artistName} — Music Explorer`;

    renderHero(stats);
    renderTimeline(albums);
    renderFacts(stats);
    renderChart(stats);
    paintAlbums();

    clearStatus();
    contentEl.hidden = false;
  } catch (error) {
    if (token !== loadToken) return;
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

/**
 * Pick an artist from the dropdown.
 * @param {object} artist
 */
function selectArtist(artist) {
  searchInputEl.value = artist.artistName;
  loadArtist(artist);
}

/**
 * Handle a submitted search — Enter, or the Search button.
 *
 * If a suggestion is highlighted, that wins. Otherwise we look the typed text
 * up and take the best match, so the user never has to open the dropdown.
 * @param {string} term
 */
async function submitSearch(term) {
  if (suggestActive >= 0 && suggestItems[suggestActive]) {
    selectArtist(suggestItems[suggestActive]);
    return;
  }

  const trimmed = term.trim();
  if (!trimmed) {
    showStatus('Type an artist name to search.');
    return;
  }

  const token = ++loadToken;
  closeSuggestions();
  resetResults();
  emptyStateEl.hidden = true;
  retryButton.hidden = true;
  showStatus(`Searching for “${trimmed}”…`);

  let artists;
  try {
    artists = await searchArtists(trimmed);
  } catch (error) {
    if (token !== loadToken) return;
    showStatus(
      error.message || 'Something went wrong. Please try again.',
      true,
      error.showApiLink === true,
    );
    retryButton.hidden = false;
    return;
  }

  if (token !== loadToken) return;

  if (artists.length === 0) {
    // Nothing matched. Say so plainly and leave the page usable — this is the
    // case that would otherwise look like a crash.
    showStatus(`No artist found for “${trimmed}”. Check the spelling, or try another name.`);
    emptyStateEl.hidden = false;
    return;
  }

  loadArtist(artists[0]);
}

/**
 * Fill the first-run screen with a few artists to click.
 */
function renderExamples() {
  const fragment = document.createDocumentFragment();
  for (const name of EXAMPLE_ARTISTS) {
    const chip = el('button', 'chip', name);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      searchInputEl.value = name;
      submitSearch(name);
    });
    fragment.append(chip);
  }
  emptyExamplesEl.replaceChildren(fragment);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

searchInputEl.addEventListener('input', () => {
  const term = searchInputEl.value.trim();
  clearTimeout(suggestTimer);

  // One or two letters match half the store, and every keystroke is a request.
  if (term.length < SUGGEST_MIN_CHARS) {
    closeSuggestions();
    return;
  }

  // Wait for a pause in typing before spending a request.
  suggestTimer = setTimeout(() => requestSuggestions(term), SUGGEST_DEBOUNCE);
});

searchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSuggestions();
    return;
  }
  if (suggestionsEl.hidden || suggestItems.length === 0) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setSuggestActive((suggestActive + 1) % suggestItems.length);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    setSuggestActive((suggestActive - 1 + suggestItems.length) % suggestItems.length);
  }
});

// Re-open the list when returning to a box that already has a query in it.
searchInputEl.addEventListener('focus', () => {
  const term = searchInputEl.value.trim();
  if (term.length >= SUGGEST_MIN_CHARS && suggestItems.length > 0) {
    suggestionsEl.hidden = false;
    searchInputEl.setAttribute('aria-expanded', 'true');
  }
});

searchInputEl.addEventListener('blur', () => closeSuggestions());

searchFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(suggestTimer);
  submitSearch(searchInputEl.value);
});

retryButton.addEventListener('click', () => {
  if (currentArtist) {
    // Do not serve the failure from cache on a retry.
    artistSongsCache.delete(String(currentArtist.artistId));
    loadArtist(currentArtist);
  } else {
    submitSearch(searchInputEl.value);
  }
});

showMoreButton.addEventListener('click', () => {
  showingAllAlbums = !showingAllAlbums;
  paintAlbums();
});

// Dragging: follow the pointer exactly, with no easing in the way.
flowSliderEl.addEventListener('input', () => {
  setFlowPosition(Number(flowSliderEl.value), false);
});

// Letting go: settle onto the nearest cover instead of stopping half-turned.
flowSliderEl.addEventListener('change', () => {
  goToAlbum(Number(flowSliderEl.value));
});

// The range input's own arrow keys would nudge by 0.01 — a step the eye cannot
// see. Override them to move a whole album at a time.
flowSliderEl.addEventListener('keydown', (event) => {
  const steps = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
  if (event.key in steps) {
    event.preventDefault();
    goToAlbum(Math.round(flowPosition) + steps[event.key]);
  } else if (event.key === 'Home') {
    event.preventDefault();
    goToAlbum(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    goToAlbum(flowAlbums.length - 1);
  }
});

// The cover size is set in CSS with clamp(), so it changes with the viewport.
window.addEventListener('resize', () => {
  if (flowCovers.length === 0) return;
  flowCoverWidth = flowCovers[0].offsetWidth || flowCoverWidth;
  applyFlowTransforms();
});

renderExamples();
searchInputEl.focus();

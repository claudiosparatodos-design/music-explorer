/**
 * Music Explorer
 * ---------------
 * Flow: FETCH songs from the iTunes Search API -> TRANSFORM the flat list into
 * albums (grouped, sorted, with computed durations) -> DISPLAY them as cards.
 */

'use strict';

const API_URL = 'https://itunes.apple.com/search';

// Deliberately small working set. The API allows up to 200 songs per request,
// but a smaller slice keeps the payload predictable and the page readable.
// The cost is that long discographies come back partially — the cards say so.
const RESULT_LIMIT = 50;

// Albums rendered before the "show all" button appears.
const ALBUM_DISPLAY_LIMIT = 6;

// DOM references, looked up once.
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const button = document.getElementById('search-button');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('results-summary');
const albumsEl = document.getElementById('albums');
const showMoreButton = document.getElementById('show-more-button');

// Tracks the in-flight request so a newer search can cancel an older one.
let activeController = null;

// Current result set, kept so the "show all" toggle can re-render without refetching.
let currentAlbums = [];
let currentTerm = '';
let showingAllAlbums = false;

/* ------------------------------------------------------------------ */
/* 1. FETCH                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch songs for an artist term.
 * Throws an Error with a user-friendly message on failure.
 * @param {string} term
 * @param {AbortSignal} signal
 * @returns {Promise<Array<object>>} raw iTunes song objects
 */
async function fetchSongs(term, signal) {
  // URLSearchParams encodes the term safely (spaces, accents, &, etc.).
  const params = new URLSearchParams({
    term,
    media: 'music',
    entity: 'song',
    limit: String(RESULT_LIMIT),
  });

  let response;
  try {
    response = await fetch(`${API_URL}?${params}`, { signal });
  } catch (error) {
    // AbortError means we cancelled on purpose — let the caller ignore it.
    if (error.name === 'AbortError') throw error;
    // Anything else here is a network-level failure (offline, DNS, CORS, timeout).
    throw new Error('Could not reach the iTunes API. Check your internet connection and try again.');
  }

  // The request completed, but the server answered with an error status.
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

  // iTunes can return HTTP 200 with an error payload instead of results.
  if (data && data.errorMessage) {
    throw new Error(`The iTunes API rejected the search: ${data.errorMessage}`);
  }

  return Array.isArray(data.results) ? data.results : [];
}

/* ------------------------------------------------------------------ */
/* 2. TRANSFORM                                                        */
/* ------------------------------------------------------------------ */

/**
 * Convert milliseconds to mm:ss. Minutes are not wrapped into hours, so a
 * 74-minute album reads as "74:05" rather than "1:14:05".
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
 * Turn the flat song list into album objects:
 * grouped by collectionName, tracks sorted by trackNumber, durations computed,
 * and albums ordered newest release first.
 * @param {Array<object>} songs raw iTunes results
 * @returns {Array<object>} album view-models
 */
function groupSongsByAlbum(songs) {
  const albums = new Map();

  for (const song of songs) {
    // Defensive: the API occasionally mixes in entries without a collection.
    const albumName = song.collectionName || 'Unknown Album';
    // Key on collectionId when available: two different artists can share an
    // album title, and the id keeps those apart.
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

/* ------------------------------------------------------------------ */
/* 3. DISPLAY                                                          */
/* ------------------------------------------------------------------ */

/**
 * Show a message in the status area. Clears the results when shown.
 * @param {string} message
 * @param {boolean} [isError]
 */
function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('status--error', isError);
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.classList.remove('status--error');
}

function clearResults() {
  albumsEl.replaceChildren();
  summaryEl.hidden = true;
  summaryEl.textContent = '';
  showMoreButton.hidden = true;
  currentAlbums = [];
}

/**
 * Build the DOM for one album card.
 * Nodes are created with textContent (never innerHTML), so song and artist
 * names coming from the API can never be interpreted as markup.
 * @param {object} album
 * @returns {HTMLElement}
 */
function renderAlbumCard(album) {
  const card = document.createElement('article');
  card.className = 'album';

  const header = document.createElement('div');
  header.className = 'album__header';

  const art = document.createElement('img');
  art.className = 'album__art';
  art.src = album.artwork;
  art.alt = `Cover of ${album.name}`;
  art.loading = 'lazy';
  // A broken artwork URL should leave an empty box, not a broken-image icon.
  art.addEventListener('error', () => { art.style.visibility = 'hidden'; });

  const meta = document.createElement('div');
  meta.className = 'album__meta';

  const name = document.createElement('h2');
  name.className = 'album__name';
  name.textContent = album.name;

  const artist = document.createElement('p');
  artist.className = 'album__artist';
  artist.textContent = album.genre
    ? `${album.artist} · ${album.year} · ${album.genre}`
    : `${album.artist} · ${album.year}`;

  const facts = document.createElement('p');
  facts.className = 'album__facts';
  const trackLabel = album.trackCount === 1 ? 'track' : 'tracks';
  // Be explicit when the fetch limit means we only have part of the album:
  // the totals below are for the songs shown, not the whole record.
  const countText = album.isPartial
    ? `${album.trackCount} of ${album.totalTrackCount} tracks`
    : `${album.trackCount} ${trackLabel}`;
  facts.textContent = `${countText} · total ${album.totalDuration} · avg ${album.averageDuration}`;
  if (album.isPartial) {
    facts.classList.add('album__facts--partial');
    facts.title = 'Only part of this album was returned by the search; totals cover the songs shown.';
  }

  meta.append(name, artist, facts);
  header.append(art, meta);

  const list = document.createElement('ol');
  list.className = 'tracks';

  album.tracks.forEach((track, index) => {
    const item = document.createElement('li');
    item.className = 'track';

    const number = document.createElement('span');
    number.className = 'track__number';
    // Fall back to the position in the list when the API has no track number.
    number.textContent = `${track.number ?? index + 1}.`;

    const trackName = document.createElement('span');
    trackName.className = 'track__name';
    trackName.textContent = track.name;
    trackName.title = track.name; // full name on hover when truncated

    const time = document.createElement('span');
    time.className = 'track__time';
    time.textContent = track.millis != null ? formatDuration(track.millis) : '--:--';

    item.append(number, trackName, time);
    list.append(item);
  });

  card.append(header, list);
  return card;
}

/**
 * Store a result set and paint it. Called once per successful search.
 * @param {Array<object>} albums
 * @param {string} term
 */
function renderAlbums(albums, term) {
  currentAlbums = albums;
  currentTerm = term;
  showingAllAlbums = false; // every new search starts collapsed
  paintAlbums();
}

/**
 * Paint the album grid, the summary line and the "show all" button from the
 * stored result set. Toggling only re-renders — it never refetches.
 */
function paintAlbums() {
  const total = currentAlbums.length;
  const capped = !showingAllAlbums && total > ALBUM_DISPLAY_LIMIT;
  const visible = capped ? currentAlbums.slice(0, ALBUM_DISPLAY_LIMIT) : currentAlbums;

  const shownTracks = visible.reduce((sum, album) => sum + album.trackCount, 0);
  summaryEl.textContent = capped
    ? `Showing the ${visible.length} most recent of ${total} albums for "${currentTerm}"`
    : `${total} album${total === 1 ? '' : 's'} · ` +
      `${shownTracks} song${shownTracks === 1 ? '' : 's'} for "${currentTerm}"`;
  summaryEl.hidden = false;

  // Build off-screen and attach once, so the browser lays out a single time.
  const fragment = document.createDocumentFragment();
  visible.forEach((album) => fragment.append(renderAlbumCard(album)));
  albumsEl.replaceChildren(fragment);

  // The button only exists when there is something left to reveal.
  if (total > ALBUM_DISPLAY_LIMIT) {
    showMoreButton.hidden = false;
    showMoreButton.textContent = showingAllAlbums
      ? `Show fewer albums`
      : `Show all ${total} albums`;
  } else {
    showMoreButton.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run a full search: fetch -> transform -> display, handling every failure.
 * @param {string} term
 */
async function search(term) {
  // Cancel any request still in flight so a slow older search cannot overwrite
  // the results of a newer one.
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const { signal } = activeController;

  button.disabled = true;
  clearResults();
  showStatus(`Searching for "${term}"…`);

  try {
    const songs = await fetchSongs(term, signal);
    const albums = groupSongsByAlbum(songs);

    if (albums.length === 0) {
      showStatus(`No songs found for "${term}". Try a different spelling or another artist.`);
      return;
    }

    clearStatus();
    renderAlbums(albums, term);
  } catch (error) {
    // A cancelled request is not a failure: the newer search owns the UI now.
    if (error.name === 'AbortError') return;
    // Everything else surfaces as a readable message; the page stays usable.
    showStatus(error.message || 'Something went wrong. Please try again.', true);
    console.error('Search failed:', error);
  } finally {
    // Only the newest search re-enables the button.
    if (!signal.aborted) {
      button.disabled = false;
      activeController = null;
    }
  }
}

showMoreButton.addEventListener('click', () => {
  showingAllAlbums = !showingAllAlbums;
  paintAlbums();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const term = input.value.trim();
  if (!term) {
    showStatus('Please type an artist name to search.');
    return;
  }
  search(term);
});

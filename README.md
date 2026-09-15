# Music Explorer

A small vanilla-JavaScript app that searches an artist on the public iTunes Search API, reorganises the flat list of songs it returns into albums, and displays them as cards with per-album duration stats.

## What this does

1. You type an artist name and hit **Search**.
2. The app fetches that artist's songs from the iTunes Search API.
3. It transforms the flat song list into albums: grouped, sorted, with total and average duration computed.
4. It renders one card per album — cover art, album name, artist, year, genre, the numbered track list with each song's duration, and the album's total/average length.

Albums are shown newest first, six at a time, with a button to reveal the rest. Every failure mode (no results, API error, no network) produces a readable message instead of a blank screen.

**A deliberately small working set.** The app asks for 50 songs per search rather than the 200 the API allows, and renders 6 albums before the "show all" button. A whole discography — every album, every track — is more data than this exercise needs, and it buries the transform logic under a wall of cards. The trade-off is that a prolific artist comes back partially; the app is explicit about that instead of hiding it (see [Working set and its limits](#working-set-and-its-limits)).

## How to run it

No build step, no dependencies, no server.

```bash
git clone https://github.com/claudiosparatodos-design/music-explorer.git
cd music-explorer
```

Then open `index.html` directly in any modern browser (double-click it, or `open index.html` / `xdg-open index.html`). That's it — the iTunes API sends permissive CORS headers, so a `file://` page can call it directly.

Tested in current Chromium-based browsers, Firefox and Safari. The only modern APIs used are `fetch`, `AbortController` and `Element.replaceChildren`.

## Data source & why

[iTunes Search API](https://performance-partners.apple.com/search-api) — `https://itunes.apple.com/search?term=...&media=music&entity=song`

Chosen because it fits the constraints of a ~4-hour exercise:

- **Free and no API key** — nothing to register, nothing to keep out of the repo, and the reviewer can run it immediately.
- **CORS enabled** — callable straight from the browser, so no proxy or backend is needed and `index.html` can be opened from disk.
- **The data actually needs transforming.** The API returns a *flat* list of songs; the album structure the UI shows does not exist in the response. Grouping, per-album aggregation and sorting are real work, not decoration — which is the point of the exercise.
- **Rich enough fields** for meaningful output: `collectionName`, `trackNumber`, `trackTimeMillis`, `releaseDate`, `artworkUrl100`, `primaryGenreName`.

Request parameters: `media=music`, `entity=song`, `limit=50`.

## Working set and its limits

Two constants at the top of `script.js` bound how much data the app handles:

| Constant | Value | Effect |
| --- | --- | --- |
| `RESULT_LIMIT` | `50` | Songs requested per search. The API allows 200. |
| `ALBUM_DISPLAY_LIMIT` | `6` | Albums rendered before the "show all" button. |

Both are single-line changes if a reviewer wants to see the app under a heavier load.

The honest cost of `RESULT_LIMIT = 50`: for an artist with a deep catalogue, an album can come back with only a few of its songs, so its total and average duration describe the songs shown rather than the whole record. Rather than let that pass silently, each song carries the album's real length in `trackCount`, and the card compares it against what we actually received — a partial album reads **"3 of 14 tracks"** with a dotted underline and a tooltip explaining the totals. An album we have in full just reads "12 tracks".

`ALBUM_DISPLAY_LIMIT` is presentation only. All albums from the response stay in memory, so the toggle re-renders instantly and never refetches.

## How the data is transformed

All of this lives in `groupSongsByAlbum()` and `formatDuration()` in `script.js`.

**1. Group by album.** Songs are collected into a `Map` keyed by `collectionId` when present, falling back to `collectionName`. The id is preferred because two different artists can release albums with the same title, and the id keeps them apart. Songs with no album name are collected under "Unknown Album" rather than dropped.

**2. Sort tracks within each album** by `trackNumber` ascending. Tracks whose number is missing sort to the end, alphabetically, instead of corrupting the order.

**3. Compute durations.** `trackTimeMillis` values are summed for the album total and divided by the track count for the average. Tracks with no reported length are excluded from both, so a single missing value does not drag the average toward zero.

**4. Format milliseconds as `mm:ss`** — round to whole seconds, integer-divide by 60, zero-pad the remainder. Minutes are deliberately *not* wrapped into hours, so a 74-minute album reads `74:05`, which is the convention listening apps use for run times. Missing values render as `--:--`.

**5. Sort albums newest first** by `releaseDate`. Those are ISO 8601 strings, so a plain string comparison already orders them chronologically — no `Date` parsing needed. Albums without a release date sink to the bottom.

**6. Flag incomplete albums.** Each album's `trackCount` from the API is compared against how many of its songs we actually fetched. When they differ, the album is marked `isPartial` and the card says so.

**7. Small display touches.** The year is sliced off the ISO date. `artworkUrl100` is a 100×100 thumbnail, but the CDN serves other sizes at the same path, so the URL's `100x100` is swapped for `300x300` to get a sharper cover.

## Error handling

The goal is that nothing leaves the user staring at a blank page, and the app is always usable again afterwards.

| Case | Behaviour |
| --- | --- |
| Empty / whitespace-only input | "Please type an artist name to search." No request is sent. |
| Search returns zero songs | "No songs found for *X*. Try a different spelling or another artist." |
| Non-OK HTTP status | The status code is surfaced: "The iTunes API responded with an error (HTTP 500)." |
| Network failure (offline, DNS, timeout) | `fetch` rejects, caught in `try/catch`: "Could not reach the iTunes API. Check your internet connection and try again." |
| HTTP 200 with a non-JSON body | Caught when parsing: "The iTunes API returned an unreadable response." |
| HTTP 200 carrying an `errorMessage` field | The API's own message is shown (iTunes does not always use HTTP status codes for errors). |
| Broken artwork URL | The `<img>` hides itself on `error` instead of showing a broken-image icon. |
| Malformed individual songs | Missing `collectionName`, `trackNumber` or `trackTimeMillis` are handled per field with fallbacks; one bad record never throws away the rest of the results. |

Two further details:

- **Out-of-order responses.** Each search aborts the previous in-flight request with an `AbortController`, so a slow earlier search can't land after a newer one and overwrite the results. `AbortError` is filtered out of the error path — a deliberate cancellation isn't a failure.
- **No `innerHTML`.** Every node is created with `createElement` and filled with `textContent`, so song and album names coming from a third-party API can never be interpreted as markup.

## Trade-offs / what I'd add with more time

- **No pagination.** One request with `limit=50`. The cut-off is arbitrary — the API sorts by relevance, not by date — so a prolific artist's catalogue is truncated and some albums arrive incomplete. The app labels those rather than hiding them, but the real fix is paging through with an `offset` and loading more on demand. That was the first thing I cut to stay inside the time-box.
- **Artist matching is fuzzy.** `term` is a free-text search, so results for a common name can mix several artists, and a search for an album title also returns songs. A more precise version would resolve the artist first (`entity=musicArtist`), then look up that `artistId`'s albums.
- **No caching.** Every search hits the network, including a repeat of the same term. A `Map` of term → results, or `sessionStorage`, would make going back to a previous search instant. iTunes also rate-limits at roughly 20 calls/minute, which a cache plus a debounce on the input would help stay under.
- **No automated tests.** `formatDuration` and `groupSongsByAlbum` are pure functions and the obvious first unit-test targets — rounding, missing fields, albums sharing a title, empty input. I verified those cases manually plus the four error paths in-browser, but in a real project they'd be Vitest cases in CI. The code is plain script tags with no module system, which is what made that quick to skip; adding tests would mean moving to ES modules first.
- **Accessibility is basic.** There's a live region for status messages, labelled controls and visible focus rings, but no keyboard-navigable results or screen-reader pass.
- **Single flat grid.** With more time: filter by year or genre, sort controls, a compilation/single vs. album distinction, and audio previews via the `previewUrl` field the API already returns.
- **No framework, deliberately.** At this size a build step and a dependency tree would cost more than they return; three static files that open straight from disk are easier to review and can't rot. Past a few more views, state would start to want a framework.

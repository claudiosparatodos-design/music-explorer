# Music Explorer — Mac Miller

A small vanilla-JavaScript page that pulls Mac Miller's catalogue from the public iTunes Search API, derives a set of statistics from it, and presents them as headline numbers, fact cards, a per-year bar chart and album cards.

No build step, no dependencies, no server — three static files you open in a browser.

## What this does

The page has one job and starts doing it the moment it opens:

1. **Fetch** — requests Mac Miller's songs from the iTunes Search API.
2. **Transform** — reshapes the flat song list two ways: grouped into albums (tracks ordered, durations computed), and reduced into derived statistics.
3. **Display** — renders four headline numbers, nine fact cards, a songs-per-year bar chart, and the album cards behind it all.

What you get:

| Section | Content |
| --- | --- |
| Headline numbers | Songs catalogued, albums & releases, total runtime ("7h 39m to play it all"), years covered |
| Curious facts | Longest and shortest track, average song length, share marked explicit, busiest year, most-used word in song titles, tracks with a guest, appearances on other artists' records, longest release |
| Chart | Songs per release year, with years that had no releases left visibly empty |
| Albums | One card per release — cover, year, genre, track list with durations, total and average length |

**Every figure is computed live in the browser from the API response.** Nothing is hardcoded. Change `ARTIST` at the top of `script.js` and the whole page re-derives itself for someone else.

## How to run it

You need the three files on your own machine. Pick whichever route is easiest:

### Option A — Download the ZIP (no tools required)

1. Open the repository: <https://github.com/claudiosparatodos-design/music-explorer>
2. Switch to the branch `claude/clever-hopper-oociku` using the branch dropdown (top-left, it says `main` by default).
3. Click the green **Code** button → **Download ZIP**.
4. Unzip the downloaded file.
5. Open the unzipped folder and **double-click `index.html`**.

It opens in your default browser and immediately starts loading. That's the whole process — there is nothing to install and no server to start.

### Option B — Clone it

```bash
git clone -b claude/clever-hopper-oociku https://github.com/claudiosparatodos-design/music-explorer.git
cd music-explorer
open index.html      # macOS
# xdg-open index.html  (Linux)   |   start index.html  (Windows)
```

### Why this works from a `file://` URL

The iTunes API sends permissive CORS headers, so a page opened straight from disk is allowed to call it. That is the main reason this API was chosen — no proxy, no backend, no local server.

Tested in current Chromium-based browsers, Firefox and Safari. The only modern APIs used are `fetch` and `Element.replaceChildren`.

**If the page shows an error instead of data**, your network is blocking `itunes.apple.com` — a corporate proxy, a VPN or an ad-blocker will do it. The **Try again** button re-runs the request without a reload.

## Data source & why

[iTunes Search API](https://performance-partners.apple.com/search-api) — `https://itunes.apple.com/search`

Request: `term=Mac Miller`, `attribute=artistTerm`, `media=music`, `entity=song`, `limit=200`.

`attribute=artistTerm` matches against the *artist* field rather than free text, so the response is songs **by** Mac Miller instead of every track that happens to mention him. That single parameter removes most of the noise a plain search returns.

Chosen because it fits the constraints of a ~4-hour exercise:

- **Free and no API key** — nothing to register, nothing to keep out of the repo, and a reviewer can run it immediately.
- **CORS enabled** — callable straight from the browser, so `index.html` opens from disk with no server.
- **The data actually needs transforming.** The API returns a *flat list of songs*. Neither the album structure nor a single statistic on this page exists in the response — all of it is derived client-side. That work is the point of the exercise.
- **Bounded by design.** One artist is a small, predictable dataset: a couple of hundred songs at most, one request, no pagination logic needed.

## How the data is transformed

Two passes over the same flat list, in `script.js`.

### Pass 1 — Group into albums (`groupSongsByAlbum`)

1. **Group.** Songs are collected into a `Map` keyed by `collectionId`, falling back to `collectionName`. The id is preferred because two releases can share a title, and it keeps them apart. Songs with no album are collected under "Unknown Album" rather than dropped.
2. **Sort tracks** by `trackNumber` ascending. Tracks with no number sort to the end alphabetically instead of corrupting the order.
3. **Compute durations.** `trackTimeMillis` values are summed for the total and divided by the count for the average. Tracks with no reported length are excluded from both, so one missing value does not drag the average toward zero.
4. **Flag incomplete albums.** The API's own `trackCount` is compared against how many of that album's songs we actually received. When they differ the card reads **"3 of 14 tracks"**, with a dotted underline and a tooltip noting that the totals cover only the songs shown.
5. **Sort albums newest first** by `releaseDate`. Those are ISO 8601 strings, so a plain string comparison already orders them chronologically — no `Date` parsing needed. Releases without a date sink to the bottom.

### Pass 2 — Derive the statistics (`computeStats`)

- **Total runtime** — every duration summed, then formatted as `13h 42m`. Durations render two ways: `mm:ss` for tracks and albums (minutes deliberately not wrapped into hours, so a 74-minute album reads `74:05`), and `Xh Ym` for totals where `mm:ss` would be unreadable.
- **Longest / shortest track** — a single pass tracking both extremes.
- **Explicit share** — `trackExplicitness` is counted where it equals `explicit` (iTunes also uses `cleaned` and `notExplicit`), then expressed as a percentage.
- **Songs per year** — release years counted into a `Map`. **Years with no releases are filled in with zero**, so the axis stays a real timeline; without that, a three-year silence would render as a one-year gap and misrepresent the career.
- **Busiest year** — the peak of that distribution.
- **Most-used word in titles** — titles are lowercased, bracketed suffixes like `(feat. …)` are stripped, punctuation is dropped, and a stop-word list removes "the", "a", "feat", "remix" and friends so the winner is a real word. A word appearing only once is discarded as coincidence.
- **Guest counts** — two distinct figures, kept from double-counting each other: *tracks with a guest* are his own releases whose title credits someone with "feat."; *appearances for others* are tracks returned under a different `artistName`.
- **Longest release** — the album with the largest summed runtime.

### About the chart

One series, so there is no legend — the heading names it, and a legend box would be noise. Only the peak bar carries a direct label; every other value is available on hover and in a visually hidden `<table>` that duplicates the data for screen readers. Bars are anchored to the baseline with rounded tops and a 2px surface gap, and a year with no releases draws no mark at all rather than a minimum-height nub that would read as "a little". The single bar colour is taken from a validated palette and passes contrast against both the light and dark surfaces.

## Error handling

The goal is that nothing leaves the user staring at a blank page, and the page is always recoverable.

| Case | Behaviour |
| --- | --- |
| Network failure (offline, DNS, blocked, timeout) | `fetch` rejects, caught in `try/catch`: "Could not reach the iTunes API…" plus a **Try again** button |
| Non-OK HTTP status | The code is surfaced: "The iTunes API responded with an error (HTTP 500)." |
| HTTP 200 with a non-JSON body | Caught when parsing: "The iTunes API returned an unreadable response." |
| HTTP 200 carrying an `errorMessage` field | The API's own message is shown — iTunes does not always signal errors with status codes |
| Zero results | A clear message rather than an empty scaffold of zeroes |
| Broken artwork URL | The `<img>` hides itself on `error` instead of showing a broken-image icon |
| Malformed individual songs | Missing `collectionName`, `trackNumber`, `trackTimeMillis` or `releaseDate` are each handled with fallbacks; one bad record never discards the rest |
| A statistic that cannot be computed | Its card is omitted entirely rather than rendered blank or as `NaN` |

Two further details:

- **The results area stays hidden until the data is in.** A failure never reveals a half-built page of empty cards.
- **No `innerHTML`.** Every node is created with `createElement` and filled with `textContent`, so song and album names from a third-party API can never be interpreted as markup.

## Trade-offs / what I'd add with more time

- **These are catalogue statistics, not popularity statistics.** The iTunes Search API exposes no play counts, chart positions or sales, so "busiest year" means *most songs released or re-released*, inflated by deluxe editions and reissues — not his most successful year. The page says so under the section heading rather than letting the number imply more than it is.
- **No pagination.** One request at the API's 200-song maximum. For a catalogue with many reissues that still truncates, and because the API sorts by relevance rather than date, the cut-off is arbitrary. Incomplete albums are labelled, but the real fix is paging with an `offset`.
- **No caching.** Every page load hits the network. A `sessionStorage` cache keyed by artist would make a reload instant; iTunes also rate-limits at roughly 20 calls/minute, which a cache would help stay under.
- **Single fixed artist.** `ARTIST` is a constant, so comparing two artists side by side means editing the file. Putting the search box back and keeping several catalogues in memory would make it a comparison tool — a natural next step, and the version this one grew out of is in the git history.
- **No automated tests.** `formatDuration`, `groupSongsByAlbum`, `findMostUsedWord` and `computeStats` are pure functions and the obvious first unit-test targets — rounding, missing fields, albums sharing a title, empty input, the guest-count double-count this version fixes. I verified those manually, plus every error path in-browser, but in a real project they would be Vitest cases in CI. The code is plain `<script>` tags with no module system, which is what made tests quick to skip; adding them would mean moving to ES modules first.
- **Accessibility is decent, not audited.** Live region for status, a real table behind the chart, visible focus rings, `role="img"` with a summary label on the plot. Not done: a full keyboard pass over the results, or reduced-motion handling.
- **The word-frequency stat is naive.** It counts word forms, not meanings — "good" and "goods" are separate, and it has no stemming. A proper version would lemmatise, but a stop-word list gets most of the value for a fraction of the effort.
- **No framework, deliberately.** At this size a build step and a dependency tree would cost more than they return; three static files that open from disk are easy to review and cannot rot. Past a few more views, state would start to want a framework.

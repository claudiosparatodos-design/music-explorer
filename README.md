# Music Explorer

A small vanilla-JavaScript page that searches any artist on the public iTunes Search API, pulls their catalogue, derives a set of statistics from it, and presents them as headline numbers, a cover-flow timeline, fact cards, a per-year bar chart and album cards.

No build step, no dependencies, no server — three static files you open in a browser.

## What this does

Type an artist's name, pick one of the suggestions that appear as you type, and the page does the rest:

1. **Fetch** — requests that artist's songs from the iTunes Search API.
2. **Transform** — reshapes the flat song list two ways: grouped into albums (tracks ordered, durations computed), and reduced into derived statistics.
3. **Display** — renders four headline numbers, a cover-flow timeline, nine fact cards, a songs-per-year bar chart, and the album cards behind it all.

What you get:

| Section | Content |
| --- | --- |
| Headline numbers | Songs catalogued, albums & releases, total runtime ("7h 39m to play it all"), years covered |
| Timeline | A cover-flow carousel of every dated release, scrubbed with a slider; the selected album's name and release date animate in letter by letter |
| Curious facts | Longest and shortest track, average song length, share marked explicit, busiest year, most-used word in song titles, tracks with a guest, appearances on other artists' records, longest release |
| Chart | Songs per release year, with years that had no releases left visibly empty |
| Albums | One card per release — cover, year, genre, track list with durations, total and average length |

**Every figure is computed live in the browser from the API response.** Nothing is hardcoded — searching a different artist re-derives the whole page.

### Finding the artist

The search box is an autocomplete. From the second character, and after 250 ms of quiet typing, it asks the API for matching **artists** (`entity=musicArtist`) and lists them with their genre. Arrow keys move through the list, Enter or a click picks one, Escape closes it.

Picking a suggestion hands over an **`artistId`**, and the songs are then fetched from the `lookup` endpoint by that id rather than by name. That removes the ambiguity a name search carries: no chance of a different artist with a similar name, and no tracks that merely mention them. Submitting without picking a suggestion still works — the best match is taken.

Two caches sit behind it, keyed by query and by artist id. Re-typing a query or revisiting an artist then costs no request at all, which matters because iTunes rate-limits at roughly 20 calls a minute and an autocomplete can burn through that quickly. Combined with the debounce, typing "radiohead" one letter at a time costs **one** request, not nine.

## How to run it

You need the three files on your own machine. Pick whichever route is easiest:

### Option A — Download the ZIP (no tools required)

1. Open the repository: <https://github.com/claudiosparatodos-design/music-explorer>
2. Switch to the branch `claude/clever-hopper-oociku` using the branch dropdown (top-left, it says `main` by default).
3. Click the green **Code** button → **Download ZIP**.
4. **Extract the ZIP to a real folder** — right-click it → *Extract All* on Windows, double-click it on macOS.
5. Open the **extracted folder** and double-click `index.html`.

It opens in your default browser and immediately starts loading. That's the whole process — there is nothing to install and no server to start.

> ⚠️ **Step 4 is not optional.** Double-clicking `index.html` while still browsing *inside* the ZIP hands the browser that one file on its own: Windows copies it alone to a temp folder, leaving `style.css` and `script.js` behind in the archive. The page then renders as bare unstyled text with no data. The page detects this and says so, but the fix is always the same — extract first, then open.

### Option B — Clone it

```bash
git clone -b claude/clever-hopper-oociku https://github.com/claudiosparatodos-design/music-explorer.git
cd music-explorer
open index.html      # macOS
# xdg-open index.html  (Linux)   |   start index.html  (Windows)
```

### Why this works from a `file://` URL

The iTunes API is callable from the browser, so there is no proxy, no backend and no local server — the main reason this API was chosen.

One wrinkle is worth knowing about. A page opened from disk has no real origin, so the browser sends `Origin: null`, and that is rejected often enough that a plain `fetch` cannot be relied on from `file://`. The app therefore tries the direct request first and **falls back to JSONP** when it fails at the network level — see [Two ways in](#two-ways-in). If you would rather avoid the fallback entirely, serve the folder over HTTP instead, which gives the page a normal origin:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

Tested in current Chromium-based browsers, Firefox and Safari. The only modern APIs used are `fetch` and `Element.replaceChildren`.

**If the page shows an error instead of data**, both routes were blocked — usually a corporate proxy, a VPN or an ad-blocker stopping `itunes.apple.com`. The error carries a link to the raw API URL: if that page does not load in a new tab either, the block is on the network rather than in this code. The **Try again** button re-runs the request without a reload.

## Data source & why

[iTunes Search API](https://performance-partners.apple.com/search-api) — `https://itunes.apple.com/search`

Two endpoints are used:

| Call | Endpoint | Why |
| --- | --- | --- |
| Suggestions | `search?term=…&entity=musicArtist&limit=8` | Asks for *artists*, not songs, so the dropdown lists people rather than tracks |
| Catalogue | `lookup?id=<artistId>&entity=song&limit=200` | Fetches by id, so there is no name matching left to get wrong |

The lookup answers with the artist record first and the tracks after it, so the response is filtered to `wrapperType === 'track'`.

Chosen because it fits the constraints of a ~4-hour exercise:

- **Free and no API key** — nothing to register, nothing to keep out of the repo, and a reviewer can run it immediately.
- **Browser-callable** — no proxy or backend needed, and it offers both CORS and JSONP, which is what lets the page survive being opened from a `file://` URL.
- **The data actually needs transforming.** The API returns a *flat list of songs*. Neither the album structure nor a single statistic on this page exists in the response — all of it is derived client-side. That work is the point of the exercise.
- **Bounded by design.** One artist is a small, predictable dataset: a couple of hundred songs at most, one request, no pagination logic needed.

### Two ways in

`fetchSongs` tries two routes, in order:

1. **A plain `fetch`.** The normal path, used whenever it works.
2. **JSONP**, only if the first fails at the network level. The API accepts a `callback` parameter and wraps its JSON in a call to that function; loading it through a `<script>` tag sidesteps CORS entirely, since script tags were never subject to it.

The distinction matters for *when* the fallback fires. `fetch` rejects identically for offline, DNS failure, a blocked request and a refused CORS check — the browser deliberately hides which — so a rejection is worth a second attempt. An HTTP error status is not: it proves the network works, so it surfaces immediately instead of wasting a retry. The JSONP call carries a 12-second timeout, because a `<script>` tag that never loads would otherwise hang the page forever.

The trade-off is real and worth stating: **JSONP executes whatever the server returns as code.** That is acceptable for a first-party Apple endpoint over HTTPS. It would not be for an untrusted API, and it is not a pattern to reach for by default — here it buys the "just open index.html" promise that the exercise's brief asked for.

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

### About the timeline

The carousel is plain CSS 3D — no library. Each cover gets a `transform` computed from its **fractional** distance to the scrub position, which is what makes dragging continuous rather than stepping from cover to cover: at position 4.5 the two neighbouring covers sit symmetrically at 22.5° each. Rotation and scale ramp over the first slot and then hold, so the whole side stack shares one angle; spacing is wide for the first neighbour and tight after it, which produces the receding stack.

Three details are worth calling out:

- **The slider is a real `<input type="range">`.** It comes with dragging, keyboard support and screen-reader semantics already correct. Its arrow keys are overridden to move a whole album instead of the 0.01 step that makes dragging smooth, and `aria-valuetext` is updated so assistive tech announces the album rather than a number.
- **Transitions are off mid-drag.** The pointer already supplies every frame; easing on top of it reads as lag. The transition is switched back on to glide onto a cover when you let go, click a cover, or use the keyboard.
- **The caption swaps two different ways.** Mid-drag it changes instantly so it tracks the covers. On landing it plays the full animation: the old caption lifts and blurs away, then the new one arrives letter by letter, each character 14 ms behind the last. Doing the animated version mid-drag meant each new index cancelled the previous fade, leaving the caption invisible until the hand stopped.

All of it is skipped under `prefers-reduced-motion`, where the carousel still works — it just stops animating.

### About the chart

One series, so there is no legend — the heading names it, and a legend box would be noise. Only the peak bar carries a direct label; every other value is available on hover and in a visually hidden `<table>` that duplicates the data for screen readers. Bars are anchored to the baseline with rounded tops and a 2px surface gap, and a year with no releases draws no mark at all rather than a minimum-height nub that would read as "a little". The single bar colour is taken from a validated palette and passes contrast against both the light and dark surfaces.

## Error handling

The goal is that nothing leaves the user staring at a blank page, and the page is always recoverable.

| Case | Behaviour |
| --- | --- |
| Network or CORS failure | `fetch` rejects, caught in `try/catch`; the JSONP fallback is tried before giving up |
| Both routes blocked | One message naming the likely cause (firewall, VPN, ad-blocker), a link to the raw API URL so the user can tell a blocked network from a bug in this page, and a **Try again** button |
| JSONP script that never loads | A 12-second timeout rejects it, rather than leaving the page loading forever |
| Non-OK HTTP status | The code is surfaced: "The iTunes API responded with an error (HTTP 500)." |
| HTTP 200 with a non-JSON body | Caught when parsing: "The iTunes API returned an unreadable response." |
| HTTP 200 carrying an `errorMessage` field | The API's own message is shown — iTunes does not always signal errors with status codes |
| Zero results | A clear message rather than an empty scaffold of zeroes |
| No artist matches what was typed | The dropdown says so in place; submitting anyway gives "No artist found for X" and returns to the first-run screen, rather than looking like a crash |
| Artist exists but has no songs | Named explicitly — "We found X, but the API returned no songs for them" |
| Suggestion request fails | Fails silently and closes the dropdown; suggestions are a convenience, and the user can still submit, where errors *are* reported |
| Two searches overlapping | Each carries a token; a response from a search the user has moved on from is discarded instead of overwriting the newer one |
| Broken artwork URL | The `<img>` hides itself on `error` instead of showing a broken-image icon |
| Malformed individual songs | Missing `collectionName`, `trackNumber`, `trackTimeMillis` or `releaseDate` are each handled with fallbacks; one bad record never discards the rest |
| A statistic that cannot be computed | Its card is omitted entirely rather than rendered blank or as `NaN` |
| `style.css` or `script.js` missing | An inline guard at the bottom of `index.html` detects it and explains the cause — almost always `index.html` opened from inside the ZIP — instead of leaving a bare unstyled page |

Two further details:

- **The results area stays hidden until the data is in.** A failure never reveals a half-built page of empty cards.
- **No `innerHTML`.** Every node is created with `createElement` and filled with `textContent`, so song and album names from a third-party API can never be interpreted as markup.

## Trade-offs / what I'd add with more time

- **These are catalogue statistics, not popularity statistics.** The iTunes Search API exposes no play counts, chart positions or sales, so "busiest year" means *most songs released or re-released*, inflated by deluxe editions and reissues — not his most successful year. The page says so under the section heading rather than letting the number imply more than it is.
- **No pagination.** One request at the API's 200-song maximum. For a catalogue with many reissues that still truncates, and because the API sorts by relevance rather than date, the cut-off is arbitrary. Incomplete albums are labelled, but the real fix is paging with an `offset`.
- **Caching is in-memory only.** It survives a search but not a page reload; `sessionStorage` would fix that in a few lines.
- **One artist at a time.** The caches hold several catalogues, but only one renders. Showing two side by side would make it a comparison tool — the natural next step.
- **Suggestions are not ranked by popularity.** They arrive in the API's own relevance order, so a well-known artist is not guaranteed the top row. The API exposes nothing to rank on.
- **No automated tests.** `formatDuration`, `groupSongsByAlbum`, `findMostUsedWord` and `computeStats` are pure functions and the obvious first unit-test targets — rounding, missing fields, albums sharing a title, empty input, the guest-count double-count this version fixes. I verified those manually, plus every error path in-browser, but in a real project they would be Vitest cases in CI. The code is plain `<script>` tags with no module system, which is what made tests quick to skip; adding them would mean moving to ES modules first.
- **Covers deep in the stack can't be clicked.** They are packed tightly enough that a nearer cover sits over their centre, so only the front cover and its immediate neighbours respond. That is how the original Cover Flow behaved too — you can click what you can see — and the slider reaches every release regardless, so I left it. Spreading the stack far enough to make every cover a target would lose the look entirely.
- **Accessibility is decent, not audited.** Live region for status, a real table behind the chart, visible focus rings, `role="img"` with a summary label on the plot. Not done: a full keyboard pass over the results, or reduced-motion handling.
- **The word-frequency stat is naive.** It counts word forms, not meanings — "good" and "goods" are separate, and it has no stemming. A proper version would lemmatise, but a stop-word list gets most of the value for a fraction of the effort.
- **No framework, deliberately.** At this size a build step and a dependency tree would cost more than they return; three static files that open from disk are easy to review and cannot rot. Past a few more views, state would start to want a framework.

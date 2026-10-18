# Google Maps Route Planner

Build a custom driving route for a new driver, save it under a name, and open it in Google Maps with one tap. A **Reverse** button flips the same route for the trip home.

Google Maps can't save a fixed, named route that avoids specific roads or intersections. This app fills that gap: it stores your ordered points and generates Google Maps navigation links from them, so the student still navigates in the Google Maps app (including the one built into a Volvo).

## How it works

- **Editor** (you): click the map, search for a place, click the blue line to insert a bend, drag markers to adjust, then save. The blue preview line comes from the Google Routes API with "avoid highways/tolls/ferries" applied.
- **Viewer** (the student): open the share link (`/?r=<id>&view=1`) and tap **Open in Google Maps**. No login needed, no editing possible.
- **Reverse**: flips the order of the points, so the return trip uses the same roads.
- **Long routes**: Google Maps links hold at most 9 stops, so longer routes are split into parts that share an endpoint.

### Know the limits

- The Google Maps link carries only your **points**, not the exact path between them, and it can't carry avoid-highways settings. If a point is far from the next one, Maps may choose its own road between them. Put points at the turns and intersections you care about, and check the blue preview line against what Maps does.
- If the student misses a turn, Maps will reroute them on its own.
- Anyone with a share link can see the route, including its start and end points. Don't share links publicly if one ends at your home.

## Setup

### 1. Google Cloud

1. Create a project and enable billing (usage at family scale stays within the free monthly tiers).
2. Enable **Maps JavaScript API**, **Routes API**, and **Places API (New)**.
3. Create an API key and restrict it:
   - **Application restrictions:** HTTP referrers. Add your deployed domain (for example `https://your-app.workers.dev/*`) and `http://localhost:8787/*` for local work.
   - **API restrictions:** only the three APIs above.
4. Optional: create a **Map ID** (Map Management) and set `MAP_ID` in `wrangler.toml`. The default `DEMO_MAP_ID` is fine for trying things out.

Place search uses the Places API (New) Text Search. If search or the route preview fails, Google's error message (for example "API has not been used in project" or a referrer restriction) appears in the status line at the top of the side panel.

This key is used in the browser, so it is visible to anyone who loads the page. The referrer and API restrictions are what protect it.

### 2. Cloudflare

```sh
npm install
npx wrangler kv namespace create ROUTES      # paste the returned id into wrangler.toml
npx wrangler secret put GOOGLE_MAPS_API_KEY  # your restricted browser key
npx wrangler secret put EDIT_TOKEN           # a long random string; this unlocks editing
npm run deploy
```

Open the deployed URL, expand **Editor access**, paste your edit token, and click **Unlock**. The token is kept in that browser's local storage. If `EDIT_TOKEN` is not set, editing is disabled entirely.

For extra protection you can also put the site behind Cloudflare Access.

### 3. Local development

```sh
cp .dev.vars.example .dev.vars   # fill in your key and a token
npm run dev                      # http://localhost:8787
```

## Tests

```sh
npm test
```

Covers the Maps link builder (waypoint splitting, reversing), polyline decoding, input validation, and the Worker API (auth, CRUD, error handling). The map UI itself needs a real API key to try out.

## Layout

```
public/        static front end (index.html, app.js, style.css)
public/lib.js  pure logic shared by the browser, the Worker, and the tests
src/worker.js  Worker: /api/* routes backed by KV
test/          node:test suites
```

## API

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/config` | none |
| GET | `/api/routes/:id` | none (the id is the share secret) |
| GET | `/api/routes` | `X-Edit-Token` |
| POST | `/api/routes` | `X-Edit-Token` |
| PUT / DELETE | `/api/routes/:id` | `X-Edit-Token` |

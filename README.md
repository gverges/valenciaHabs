# Habitaciones en Valencia

Static, filterable map + list of flats, reading live from a published
Google Sheet. No backend, no build step — just HTML/CSS/JS, so it can
be hosted straight from GitHub Pages.

## 1. Publish your sheet as CSV

In Google Sheets: **File → Share → Publish to web** → choose your tab →
format **CSV** → **Publish**. Copy the resulting link
(`.../pub?gid=...&single=true&output=csv`).

This is already wired up to your sheet in `assets/app.js` (the
`CSV_URL` constant at the top). If you ever change the sheet or start
a new one, update that one line.

**Important:** any edit in the sheet is live on the site the next time
someone loads the page — no re-export needed. If a row looks wrong,
check the sheet first.

## 2. Host on GitHub Pages

```bash
git init
git add .
git commit -m "Habitaciones en Valencia"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source → Deploy from branch →
main → / (root)**. Your site will be live at
`https://<you>.github.io/<repo>/` within a minute or two.

## 3. How it works

- **Data**: `assets/app.js` fetches the CSV on every page load and
  parses it with PapaParse.
- **Location**: for each flat, the app first tries to pull
  coordinates directly out of the *Google Maps* column (works for
  links containing `lat,lng`, e.g. from long-press → coordinates on
  Google Maps). If that's not present, it geocodes the **Barrio**
  name once via OpenStreetMap Nominatim (free, no key) and caches
  the result in the browser's `localStorage`, so repeat visits don't
  re-geocode. Multiple flats in the same barrio get a small,
  deterministic offset so their pins don't sit exactly on top of each
  other — treat those pins as "somewhere in this barrio," not an
  exact address.
- **Filters**: built automatically from whatever values actually
  appear in your sheet (Barrio, Status, Interesse, Zimmer, Belegung,
  Küche, Wohnzimmer as multi-select chips; Preis and Grösse as
  min/max ranges; Verfügbar ab as a date cutoff). Add a new Status
  value in the sheet and a matching filter chip appears automatically
  — no code changes needed.
- **Colors**: Status and Interesse values are colored consistently
  (same word → same color) using a small hash function, so you don't
  need to hardcode a color per status.

## 4. If you rename columns

The column names are matched literally in `normalizeRow()` in
`assets/app.js` (e.g. `get("Preis (EUR)")`). If you rename a column
in the sheet, update the matching string in that function.

## 5. Known limits

- Nominatim (free geocoder) allows roughly 1 request/second, so the
  very first load after adding a **new barrio** takes a moment while
  it resolves; subsequent loads use the cache.
- Pins for barrio-only locations are approximate, not exact addresses.
- The published CSV link is technically public (anyone with the URL
  can view it, read-only). Fine for a friend's flat search; don't put
  anything sensitive in the sheet.

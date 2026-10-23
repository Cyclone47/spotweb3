# UI redesign plan

Goal: one modern, responsive, mobile-friendly UI that looks and feels good, without
rewriting the backend or the working JavaScript in one go.

## Approach
A redesign *layer* (`templates/modern/css/redesign.css`, `js/shell.js`) restyles the
existing markup. Templates only change where markup is genuinely missing. This keeps
every feature working while the look is rebuilt view by view, and each step can be
reviewed on its own.

## Done (this branch)
- Retired the separate jQuery Mobile `mobile` theme: phones now get the responsive
  modern theme (existing users on the old preference are mapped over automatically).
- `viewport` meta tag (phones used to be laid out at 980px wide).
- Design tokens for light/dark, system font stack, rounded surfaces, soft shadows.
- App bar: logo, pill search field, ghost buttons.
- Spot list: poster-first cards (2:3 covers), badge on the cover, 2-column grid on phones.
- Sidebar: flat category tree; becomes an off-canvas drawer on tablet/phone.
- Bottom navigation bar on tablet/phone (Spots / Search / Filters / Account).
- Spot detail: sticky action bar, cover + metadata grid, description and comments cards.
- Dev tooling: `docker-compose.dev.yml` (live-edit mounts) and `utils/dev-seed.php`
  (sample spots with generated covers).

- Spots without a cover get a neutral generated placeholder instead of the red "ERROR" image.
- Login page redesigned (card, light/dark, redirects after login); access-denied page and
  form error messages no longer use `alert()` popups (errors are escaped inline instead).
- Settings, user preferences, user management and the admin center share one look
  (tab bar, form rows, tables, buttons); dialogs (change user, add user, ...) restyled.

- SVG icons (`css/icons.css`) replace the sprite glyphs for download client, watchlist,
  search, spam report, whitelist/blacklist/filter actions, toolbar and dialog close.
- Filter manager (preferences > Filters) restyled as a sortable list; dialogs share one look.

- Desktop skin (>= 901px, `css/desktop.css` + `js/desktop.js`): menu bar (File/Edit/View/Help)
  with last-update status and refresh, sidebar panels (Search, Filters, Add a filter,
  Maintenance), Overview/Downloads tabs and a details list as the default view on desktops
  (phones/tablets default to cards), in light and dark.

- Spotnet Classic as a visual reference (layout and filter set only; no assets or code were
  copied, the repository has no licence file): default filters are now Movies (with formats),
  Series, Books, Music, Games, Applications, Erotica; quick links Watchlist, New, Last 24
  hours, ...; spot detail has cover left with the description beside it, an Information block
  and comments, plus copy title/description/link and open-website actions.
- Search box no longer pops the advanced panel open on focus ("Extended" checkbox does that).

- Menus modelled on Spotnet Classic: File (update, add spot, account), Edit (download button,
  preferences, newsservers, settings, users, database > server info/maintenance, admin center),
  View (columns, font size, table/cards, theme) with checkmarks and submenus; Help.
- Settings, preferences and user management look like desktop option dialogs in the desktop skin
  (square tabs, compact label/value rows). `?tab=N` opens a given tab.
- Dutch translations for the new labels (`utils/compile-mo.py` compiles .po to .mo without GNU
  gettext); the Docker image now ships the nl/de/fr/tr system locales so native gettext works.

## Next
1. Add-spot dialog: tidy the legacy form chrome and smiley picker.
3. Table view and infinite-scroll polish; skeleton loading states.
4. Remaining sprites: spot-list table view, SABnzbd queue panel, rating stars.
5. Keyboard shortcuts overlay, focus states and an accessibility pass (contrast, labels).
6. Remove the dead `mobile` theme and unused legacy CSS once nothing references it.
7. Optional: PWA manifest and service worker (installable, offline shell).

## Testing
Run with `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`, then
`docker compose exec -u www-data spotweb php utils/dev-seed.php`. Check 375px, 768px and
1360px widths, light and dark.

# Changelog

## 1.0.3 — 2026-10-27

- The mod writes `<profile>/zen-glance-plus.log` as it works: one line when it loads, one when it starts with its hook state and site count, and one per tab it is asked to open, saying whether it decided to make a Glance. A browser whose console cannot be reached from a page can now be asked what it did without one.

## 1.0.2 — 2026-10-27

- The site table lays out correctly inside the settings page. The site name and the remove control are no longer buttons, so the page's own control styling cannot centre the name in the middle of the row or refuse to let it shrink; the name starts at the left edge and ellipsises when the panel is narrow.
- The remove control is a square, borderless glyph with its own hover, and the row keeps clear space at the panel's right edge instead of pressing the glyph against it.
- Header cells and switches share the same grid and the same padding, so each switch sits under its heading.

## 1.0.1 — 2026-10-27

- The script announces itself in the Browser Console and exposes `window.__zenGlancePlus.status()`, which reports whether it started, whether `gBrowser.addTab` is wrapped, whether the Glance manager is present, how many sites are configured and what each switch is set to. A script that never loads and a script that loads and declines to act now look different from the outside.

## 1.0.0 — 2026-10-27

First public release. Glance Plus opens a new tab as a Glance, and decides which pages deserve one.

- A **Sites** table in the mod's own settings panel, one row per domain, with a switch for that site's new tabs and a switch for links that would replace the current tab. Rows answer for their domain and every subdomain, and override the tab-kind switches in both directions.
- Six rows ship already narrowed: reddit.com, x.com, facebook.com, youtube.com, instagram.com and github.com. Each glances that site's content pages — a post, a status, a video, an issue, a comment thread — while its listings, front page and settings open normally. The rows are written once, on the first start after install, so a stored list is kept and a deleted row stays deleted.
- **Link patterns** per site. A row with none answers for every link on its domain; with patterns, only the paths that match one glance. Patterns gate both switches and match the address path and query, with `*` spanning slashes.
- Five switches by **kind of tab** for sites without a row: essentials and pinned tabs on, ordinary tabs off, New Tab pages as a kind of their own, and an optional page-initiated replace of the current tab.
- The opened tab is reused through Zen's own `openGlance()`, so a rule never creates a second tab or a second load.
- A second matching page promotes the open Glance into a real tab first, because Zen holds one at a time.
- Zen's own Glance switch and its animation state are respected; essential and pinned tab creation, "open all in tabs", session restore and unloaded opens are left alone.
- Settings save as they are edited and take effect on the next page opened.
- Test harnesses covering the tab-kind policy, the site list, the pattern matcher and the rendered table.

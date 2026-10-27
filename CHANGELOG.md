# Changelog

## 1.1.0 — 2026-10-27

- The mod ships with sites already configured: Reddit, X, Facebook, YouTube, Instagram, GitHub and Hacker News, each row narrowed to the site's content pages so a post glances while a listing, front page or settings page opens normally. The list is written once, on the first start after install, so a profile that already has its own rows keeps them and a row you delete stays deleted.

## 1.0.0 — 2026-10-27

First public release. Glance Plus opens a new tab as a Glance, and decides which pages deserve one.

- A **Sites** table in the mod's own settings panel, one row per domain, with a switch for that site's new tabs and a switch for links that would replace the current tab. Rows answer for their domain and every subdomain, and override the tab-kind switches in both directions.
- **Link patterns** per site. A row with none answers for every link on its domain; with patterns, only the paths that match one glance — a subreddit's posts open in Glance while its listings, front page and settings stay ordinary tabs. Patterns gate both switches and match the address path and query with `*` spanning slashes.
- Five switches by **kind of tab** for sites without a row: essentials and pinned tabs on, ordinary tabs off, New Tab pages as a kind of their own, and an optional page-initiated replace of the current tab.
- The opened tab is reused through Zen's own `openGlance()`, so a rule never creates a second tab or a second load.
- A second matching page promotes the open Glance into a real tab first, because Zen holds one at a time.
- Zen's own Glance switch and its animation state are respected; essential and pinned tab creation, "open all in tabs", session restore and unloaded opens are left alone.
- Settings are saved as they are edited and take effect on the next page opened.
- Test harnesses covering the tab-kind policy, the site list, the pattern matcher and the rendered table.

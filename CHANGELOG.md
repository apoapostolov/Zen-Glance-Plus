# Changelog

## 0.1.0 — 2026-10-27

First version.

- A table of sites where each row decides its domain's new tabs and same-tab links, saved as you edit.
- Link patterns per site: a row can be narrowed to the pages that should glance, such as a subreddit's posts and not its listings, while the rest of the site opens normally.
- The table is drawn under **Sites** in the mod's own panel, so the settings page and the switches live together.
- A new tab becomes a Glance, decided by the kind of tab it was opened from: essentials and pinned tabs on, ordinary tabs off.
- A New Tab page counts as its own kind and is on by default.
- A page-initiated open that would replace the ordinary tab you are on can be turned into a Glance, off by default.
- The opened tab is reused through `gZenGlanceManager.openGlance()`, so no second tab and no second load.
- A second matching page promotes the open Glance to a tab first, because Zen holds one at a time.
- Zen's own Glance switch and its animation state are respected; essential, pinned, bulk, lazy and session-restore opens are left alone.
- Test harness covering every switch, the conversion, the conflict, the redirect seam, the preference defaults and the restore path.

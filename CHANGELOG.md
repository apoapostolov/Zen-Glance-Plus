# Changelog

## 1.0.10 — 2026-10-27

- Feedly joins the shipped sites. Its row glances an article opened in Feedly's own reader (`/i/entry/*`) and leaves the feed list, discovery and saved views as ordinary tabs, so reading one item from a feed no longer costs you the list behind it.

## 1.0.9 — 2026-10-27

- The README now describes the settings panel as it is — a **Link** switch before **New tabs**, a square glyph that adds a pattern, pills the height of their field — and the settings screenshot is regenerated from the current markup.
- The limits paragraph was wrong in the direction that matters least until you hit it: a link that opens a tab from inside a page is covered now, and the README says so, alongside the one case that remains out of reach, a plain click that navigates the tab you are already on.
- `How it works` names both seams, and a short section explains the log file the mod writes, so a report can distinguish a script that never ran from one that declined.

## 1.0.8 — 2026-10-27

- The second column is called **Link** and comes before **New tabs**, so both columns read as what they govern: a click that would replace the page, and a link that opens a tab.
- The control that adds a pattern is a square borderless glyph beside the field instead of a wide button, and a pattern pill is as tall as the field and only as wide as its text. The pill's remove glyph is no longer a button either, so the settings page cannot give it a minimum width.

## 1.0.7 — 2026-10-27

- The Sites table finds its place again. It was mounted when the settings page loaded, but a mod's settings rows are built only when its Configure dialog opens, so the mount ran before the anchor existed and correctly reported that it had nothing to hang from. The mount now also runs after a click in the settings page, looks in frames as well as the top document, and falls back from the element id to the Sites heading and then to the dialog that holds the rows, recording in the log which of the three it used.
- Log writes are serialised. Two lines written in the same tick read the same file, so the second write dropped the first.

## 1.0.6 — 2026-10-27

- The page-holding behaviour from 1.0.5 is gone. Keeping a Glance invisible until it painted traded a blank panel for a late panel, which is worse than watching the page arrive. A Glance shows its page as it loads, as it did in 1.0.4, and the open is still timed in the log.
- The log now reports the settings table: whether the Sites anchor was found and how many site rows it drew, or that there was no anchor to draw under.

## 1.0.5 — 2026-10-27

- A Glance no longer shows an empty panel while its page loads. The page stays invisible until it has painted, so the tab behind it stays readable, and the log now records how long the open took, from the decision to `DOMContentLoaded` and `load`.

## 1.0.4 — 2026-10-27

- Links that open a tab from inside a page are covered too. Those tabs are created empty and load themselves, so `addTab` only ever saw `about:blank` for them and nothing could be judged. The mod now answers Zen's own check, which is the one place the intended address is known, and it decides with the same switches and site patterns as every other open.
- A page opened this way from an essential or a pinned tab now glances on the strength of its site row, which is what makes a post clicked inside a site's own essential open as a Glance.

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

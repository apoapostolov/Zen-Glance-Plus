# Zen Glance Plus

A Zen Browser mod that opens a new tab as a Glance instead of a new page. It decides by the kind of tab the page was opened from: an essential, a pinned tab, an ordinary tab, or a New Tab page.

Stock Zen creates a Glance for a gesture (a modifier click), for a bookmark or search result with the modifier held, and automatically only for links that leave an essential tab and cross a domain boundary. There is no way to say "anything opened from here should be a Glance". This mod adds that.

It uses Zen's own Glance: the overlay, the animation, the three buttons and Escape are the browser's.

## Requirements

- Zen Browser with the Sine mod loader.
- `sine.allow-unsafe-js` set to `true`. The mod is JavaScript installed from a repository rather than reviewed in the Sine store, and Sine refuses to run a non-store script without that preference. With it off the mod shows as enabled and does nothing.

## Install

1. Open Sine's mods page in Zen settings.
2. Add a mod from the repository `apoapostolov/Zen-Glance-Plus`.
3. Confirm `sine.allow-unsafe-js` is `true` in `about:config`.
4. Restart Zen. Chrome scripts load at startup, so a running window keeps the old state.

To remove it, remove the mod in Sine and restart. Its preferences stay in `prefs.js` until you reset them in `about:config`.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Apply to Essentials | On | A new tab opened from an essential becomes a Glance |
| Apply to Pinned Tabs | On | A new tab opened from a pinned tab becomes a Glance |
| Apply to Normal Tabs | Off | A new tab opened from an ordinary tab becomes a Glance |
| Apply to New Tab Pages | On | A new tab opened from a New Tab page becomes a Glance |
| Apply to Normal Tab Redirection | Off | A page that would replace the ordinary tab you are on opens as a Glance instead |

A tab is classified once, in this order: essentials first, because they are pinned as well; then pinned tabs; then New Tab pages, which are ordinary tabs carrying Zen's own marker; then ordinary tabs. A Glance opened from another Glance is treated as belonging to the tab underneath it.

`Apply to Normal Tab Redirection` covers a page-initiated open that would replace the tab you are on, such as a context-menu "open in this tab". Nothing typed in the address bar is affected: those opens carry the system principal and always navigate the tab. A plain left click on a link inside a page never reaches the browser window at all — the content process performs that navigation itself — so that click is out of reach for any mod of this shape.

## Behaviour worth knowing

- Zen holds one Glance at a time. When a second page matches while a Glance is open, the open one is turned into a real tab and the new page is shown as a Glance.
- A page that would have opened in a background tab opens as a Glance instead, which brings it on screen. That is what the rule asks for.
- Opens that are not a single page are left alone: essential and pinned tab creation, "open all in tabs", session restore, and tabs created without loading.
- Zen's own Glance switch wins. With Glance turned off in `Settings > Look and Feel`, this mod does nothing.
- Nothing is converted while Zen is running a Glance animation.

## How it works

The script wraps `gBrowser.addTab`, the one function every tab-opening path in the browser window reaches, and which carries the address. The wrapped call decides from the tab the page was opened from and records a plan. On the `TabOpen` event that `addTab` dispatches, the new tab is converted with `gZenGlanceManager.openGlance()`, passing it as an existing tab so no second tab is created and no second load starts.

The seam is `addTab` rather than `TabOpen` on its own because `TabOpen` fires before the browser begins loading, when the tab still holds `about:blank` and there is no address to test.

`docs/glance-internals.md` documents the browser code this is built on, with file and line references.

## Testing

```
node tests/zen-glance-plus.test.mjs scripts/zen-glance-plus.uc.js
```

The harness runs the shipped script in a Node VM against stubbed browser globals. It covers each tab kind and its switch, the conversion, the single-Glance conflict, the redirect seam, the preference defaults against `preferences.json`, and the restore path. `ONLY="New Tab" node tests/zen-glance-plus.test.mjs` runs a subset.

## Licence

MIT. See `LICENSE`. `CREDITS.md` records what the idea owes to other work.

# Glance Plus

A Zen Browser mod that opens a new tab as a Glance instead of a new page. Two layers decide:

- a **Sites** table, where one row turns Glance on for that domain's new tabs and, separately, for links that would replace the tab you are on;
- five switches by **kind of tab**, for every site without a row: opened from an essential, a pinned tab, an ordinary tab or a New Tab page.

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

## Sites

Under **Sites** in the same panel, a table decides per domain. Type a site and press Add or Enter; a pasted address is reduced to its host, a leading `www.` comes off, and duplicates and anything that is not a host are refused.

Each row has two switches, a remove button, and — under the site name — a list of link patterns:

| Column | Effect |
| --- | --- |
| Site | The domain, and every subdomain of it. `reddit.com` covers `old.reddit.com`. Click it to open the row's link patterns |
| New tabs | A new tab for this site opens as a Glance, whatever kind of tab it was opened from |
| Same tab | A link that would replace the tab you are on opens as a Glance instead, even with the global redirection switch off |

A row answers for its domain in both directions: with **New tabs** off, that site never glances a new tab, even from an essential. Sites without a row fall back to the five switches above. Changes are saved as you make them and apply to the next page you open.

### Link patterns

A row without patterns glances every link on its site. Click the site name and add patterns to narrow it — for example, on `reddit.com`, glance the posts and nothing else:

```
/r/*/comments/*      a post from a subreddit listing
*/comments/*         a post opened from a profile or the front page
```

A pattern is matched against the address path and its query, never the domain, because the row already supplies the domain:

- `*` stands for anything, including `/`.
- A pattern starting with `/` is anchored at the start of the path. One that starts with `*` may match anywhere.
- A pattern typed without a leading slash is treated as `*pattern`, so `comments/*` is the same as `*/comments/*`.
- A pasted address keeps only its path, so `https://www.reddit.com/r/*/comments/*` becomes `/r/*/comments/*`.
- Matching is case-sensitive, and the query string counts: `/watch?*` matches `?v=…`, `/watch` does not.

Once a row has patterns, only the links that match one of them glance. Everything else on that site opens the ordinary way, whatever the switches say. Remove every pattern to put the row back to "any link on this site".

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
node tests/sites.test.mjs scripts/zen-glance-plus.uc.js
```

Both harnesses run the shipped script in a Node VM. The first drives stubbed browser globals and covers each tab kind and its switch, the conversion, the single-Glance conflict, the redirect seam, a site row overriding a switch, the preference defaults against `preferences.json`, and the restore path. The second supplies a small DOM and covers the site list from storage to the rendered table and back: normalising what you type, parsing a damaged pref, adding, flipping a switch, removing, and placing the table under its heading once. `ONLY="New Tab" node tests/zen-glance-plus.test.mjs` runs a subset of either suite.

## Licence

MIT. See `LICENSE`. `CREDITS.md` records what the idea owes to other work.

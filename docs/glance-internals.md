# How Zen's Glance works

Read from the installed browser, not from documentation: Zen Twilight 1.24t, BuildID 20261025020453, `C:\Program Files\Zen Twilight`.

| Code | Archive and path |
| --- | --- |
| Glance manager, 2133 lines | `browser/omni.ja` → `chrome/browser/content/browser/zen-components/ZenGlanceManager.mjs` |
| Glance stylesheet | `browser/omni.ja` → `chrome/browser/content/browser/zen-styles/zen-glance.css` |
| Content gesture and parent message bridge | `browser/omni.ja` → `actors/ZenGlanceChild.sys.mjs`, `actors/ZenGlanceParent.sys.mjs` |
| Tab creation and the tab events | root `omni.ja` → `moz-src/browser/components/tabbrowser/Tabbrowser.sys.mjs` |

The manager is loaded as a preloaded script (`ZenPreloadedScripts.js`) and assigned to `window.gZenGlanceManager`.

## A Glance is a tab, not a panel

The overlay is not a separate document, iframe or window. `openGlance()` creates a real tab with `gBrowser.addTab()` and then moves that tab element inside the tab it was opened from:

```js
// #configureNewTab
currentTab.querySelector(".tab-content").appendChild(newTab);
newTab.setAttribute("zen-glance-tab", true);
newTab.setAttribute("glance-id", glanceId);
currentTab.setAttribute("glance-id", glanceId);
```

So the DOM ends up as `tab.tabbrowser-tab[glance-id] > .tab-stack > .tab-content > tab.tabbrowser-tab[zen-glance-tab]`, and `tab.glanceTab` (`tabbrowser/tab.mjs`) is just `this.querySelector("tab[zen-glance-tab]")`. `tabs.mjs` splices those nested tabs into `allTabs` directly after their parent so tab order and cycling stay coherent.

The visual overlay is CSS applied to the *parent* tab's own browser container:

```js
// fillOverlay()
this.overlay = browser.closest(".browserSidebarContainer");
this.browserWrapper = browser.closest(".browserContainer");
this.contentWrapper = browser.closest(".browserStack");
```

`#configureGlanceElements()` adds `zen-glance-background` to the parent's `.browserSidebarContainer`, `deck-selected` to both containers and `zen-glance-overlay` to the parent's overlay node, and `#setGlanceStates()` sets `zenModeActive` and `docShellIsActive` on both browsers so the parent keeps rendering behind the scaled-back page (`GLANCE_BACKGROUND_SCALE = 0.97`, opacity 0.3). `zen-glance.css` does the rest.

## Opening

```js
gZenGlanceManager.openGlance(data, existingTab = null, ownerTab = null)
```

`data` is `{ url, triggeringPrincipal, clientX, clientY, width, height }` where the four position fields are the rect the animation starts from, in window coordinates.

Sequence:

1. Refuses if a Glance is already open, and returns the open one instead. **One Glance at a time.**
2. Re-selects the open Glance if the user has moved to its parent tab.
3. Without `existingTab`, checks `data.url` against `checkLoadURIStrWithPrincipal` with the triggering principal. With `existingTab` there is no load, so no check.
4. If `width` or `height` is falsy, merges `lastLinkClickData` — the rect of the last `mousedown` in page content, sent by `ZenGlanceChild`. Passing `0` therefore does not mean "no rect", it means "use the recorded one".
5. Creates the tab with `userContextId` from the parent tab, `ownerTab`, `triggeringPrincipal`, `skipAnimation: true` and `skipRoute: true`.
6. Wraps it, marks it, selects it.
7. Animates: the parent container scales down and fades, a snapshot of the clicked element (`drawSnapshot` on the window global) is placed over the box, and `#createGlanceArcSequence` interpolates roughly 90 keyframes along an arc from the click rect to the final centred rect.

`zen.glance.animation-duration` sets the duration; `gZenUIManager.testingEnabled` forces it to zero.

## Closing, promoting, splitting

- `closeGlance({ noAnimation, onTabClose, setNewID, hasFocused, skipPermitUnload })` — animates out, then `#cleanupGlanceElements` removes the glance tab with `gBrowser.removeTab`, clears `zen-glance-tab`, dispatches a `GlanceClose` event on the tab and re-selects the parent. It refuses while opening or animating unless called for a tab close. The `noAnimation` branch only clears container styles and does **not** remove the tab, so it is not a standalone close.
- `fullyOpenGlance()` — promotes the Glance into an ordinary tab: removes `zen-glance-tab` and `glance-id`, moves the tab after the parent, restores the parent container, animates a short scale.
- `splitGlance()` — `fullyOpenGlance({ forSplit: true })`, then `gZenViewSplitter.splitTabs(...)`.
- `openDetachedGlance(data)` — a second presentation that creates `#zen-glance-detached` inside `#zen-main-app-wrapper` with its own `<browser>`, used instead of a nested tab. It is not a tab and is not what the entry points below use.

Commands `cmd_zenGlanceClose`, `cmd_zenGlanceExpand` and `cmd_zenGlanceSplit` map to close, promote and split through `handleMainCommandSet`.

## Every way a Glance starts today

| Trigger | Where | Notes |
| --- | --- | --- |
| Modifier-click a link | `ZenGlanceChild.on_click` → `ZenGlance:OpenGlance` → parent actor → `openGlance()` | Modifier from `zen.glance.activation-method`, default `alt`; drag beyond 4px cancels; `javascript:` links blocked |
| Escape closes it | `ZenGlanceChild.on_keydown` → `ZenGlance:CloseGlance` | |
| Link context menu | `#insertIntoContextMenu()` creates `#context-zenOpenLinkInGlance` before `#context-sep-open` | This is the item the URL-context stylesheet mod restyles; its `command` calls `openGlance` with `gContextMenu.linkURL` |
| Bookmark or library item | `openGlanceForBookmark()` from `browserPlacesViews.js` | Requires the activation modifier |
| Search or context-menu search result | `onSearchSelectCommand("tab")` → `#openGlanceForSearch()` | Gated by `zen.glance.enabled` and `zen.glance.enable-contextmenu-search` |
| **Automatically**, external link from an essential tab | `shouldOpenTabInGlance()` ← `onTabOpen(browser, uri)` ← patched `BrowserDOMWindow.openURI` | Requires the owner to be pinned and an app tab, a different domain, `zen.glance.open-essential-external-links`, and `zen.glance.enabled` |

The last row is the only automatic rule, and it is hardcoded to essentials with a cross-domain check. Nothing in the browser lets a kind of tab opt itself in. That gap is what Glance Plus fills.

## Tab kinds, as the browser marks them

| Kind | Test | Where it is set |
| --- | --- | --- |
| Essential | `tab.hasAttribute("zen-essential")` | Zen's pinned tab manager; essentials are also `pinned` |
| Pinned | `tab.pinned`, without the essential marker | `MozTabbrowserTab.pinned` |
| New Tab page | `tab.hasAttribute("zen-empty-tab")`, or the tab's `currentURI` is `about:newtab`, `about:home` or `about:blank` | Zen sets the marker on its empty tab |
| Ordinary | everything else | |

A Glance tab carries `zen-glance-tab` plus a `glance-id` shared with its parent, so `getTabOrGlanceParent()` resolves a link opened from inside a Glance to the tab underneath it.

## Seams a mod can use

| Seam | What it sees | Cost |
| --- | --- | --- |
| Wrap `gBrowser.addTab(uri, params)` | The address, the params, the opener browser, and the current selection — before anything is created | The tab must still be converted on TabOpen; a glance tab cannot be handed back to the caller |
| `TabOpen` on `gBrowser.tabContainer` | The tab element; fired inside `addTab` at `#fireTabOpen`, **before** `#kickOffBrowserLoad` | `linkedBrowser.currentURI` is still `about:blank`, so the address is unavailable |
| `TabBrowserInserted` | The tab with an inserted browser | Fires earlier still, and also during session restore; still no address |
| `window.openLinkIn` / `openTrustedLinkIn` with `where === "current"` | A chrome-side open that would replace the current tab | A plain left click in a page never comes through here, because the content process performs that navigation itself |
| `BrowserDOMWindow.openURI` (patched by Zen) | A content-initiated `window.open` or `target=_blank`, with the URI | Already owned by Zen; a mod cannot add to it without patching the same file |
| A `JSWindowActor` child | Clicks in content, before any tab exists | Needs actor registration and a URI loadable in the content process; heavy for a mod |

This mod uses the first two together: wrap `addTab` to learn the address and the source tab, then convert on the `TabOpen` that `addTab` dispatches synchronously, one microtask later so `addTab` finishes its own bookkeeping first. It adds the fourth for the optional redirect switch, taking only page-initiated opens so the address bar is never diverted.

## Constraints worth designing against

- One Glance at a time. `openGlance` returns the open Glance rather than stacking a second one, so a policy that wants to show another page must promote or close first.
- `width: 0` and `height: 0` mean "use `lastLinkClickData`", not "no animation rect". Pass a non-zero rect to avoid a stale one.
- Only `http`, `https` and `file` addresses are treated as glanceable by the browser's own helper, and content loads are checked against the triggering principal. `existingTab` conversions skip that check because no load happens.
- With `supportsUnload` absent from the record, disabling the mod needs a restart; the script restores `gBrowser.addTab` and removes its listeners on unload or on `window.__glanceRules.stop()`.
- Zen's internals move. Re-read the manager after a Zen update before trusting line numbers or private state; only `openGlance`, `closeGlance`, `fullyOpenGlance`, `splitGlance`, `getTabOrGlanceParent`, `lastLinkClickData` and `_animating` are relied on here, and the last two are read defensively.

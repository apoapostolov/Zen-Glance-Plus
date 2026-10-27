# Credits

## What this builds on

Glance itself is Zen Browser's feature, read from the shipped 1.24t build:

- `chrome/browser/content/browser/zen-components/ZenGlanceManager.mjs` in `browser/omni.ja` — the manager this mod calls.
- `actors/ZenGlanceParent.sys.mjs` and `actors/ZenGlanceChild.sys.mjs` — the gesture path into it.
- `moz-src/browser/components/tabbrowser/Tabbrowser.sys.mjs` in the root `omni.ja` — `addTab`, `#fireTabOpen` and `#kickOffBrowserLoad`, which decide where a tab exists before its address is known.

No source from Zen Browser or from any other mod is copied here. The manager's public methods are called, and the browser's own overlay, animation and buttons are used unchanged. Zen is licensed under the Mozilla Public License 2.0; this is an independent work that calls into it.

## What the idea owes

- The URL context menu mod (`splendid-bear/zen-mod-url-context`) shows that `#context-zenOpenLinkInGlance` is a real browser command. That pointed at the manager; nothing else about it is used.
- `BibekBhusal0/zen-custom-js` and `octaviusz/zen-drop-link` each call `openGlance()` for their own purposes and made clear that it is a public entry point with a stable shape.
- `z1n-k/zia` treats Glance tabs as ordinary tabs that happen to be nested, which is how this mod treats them too.

## New here

The tab-kind policy — one switch per kind of tab a page can be opened from, with New Tab pages as a kind of their own — is not borrowed. Neither is the `gBrowser.addTab` seam: it exists here because the address has to be known before the tab starts loading, and that is the only place where both the address and the tab it came from are available.

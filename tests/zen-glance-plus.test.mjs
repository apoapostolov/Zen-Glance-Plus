/**
 * Glance Plus — test harness
 *
 * Runs the real `scripts/zen-glance-plus.uc.js` inside a Node VM against
 * stubbed browser globals that mirror the shapes the script reads and writes.
 * Covers the tab-kind policy, the conversion and the redirect seam without a
 * browser restart.
 *
 *   node tests/zen-glance-plus.test.mjs scripts/zen-glance-plus.uc.js
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const repoRoot = path.dirname(here);
const scriptPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "scripts", "zen-glance-plus.uc.js");

const source = fs.readFileSync(scriptPath, "utf8");

/* --------------------------------------------------------------- fixtures */

function makeTab(id, { attrs = {}, pinned = false, url = "https://example.com/" } = {}) {
  const map = new Map(Object.entries(attrs));
  const tab = {
    id,
    pinned,
    isConnected: true,
    closing: false,
    linkedBrowser: { currentURI: url ? { spec: url } : null },
    hasAttribute: name => map.has(name),
    setAttribute: (name, value) => map.set(name, value),
    getAttribute: name => (map.has(name) ? map.get(name) : null),
    removeAttribute: name => map.delete(name),
  };
  tab.glanceTab = null;
  return tab;
}

/**
 * A tab that some page or link asked for. Firefox reports the opener as a
 * browser element while Zen's own seams pass the tab, and both are a real
 * opener; a tab with neither is the browser's own new tab.
 */
const openedFrom = (tab, params = {}) => ({ ownerTab: tab, ...params });

function createWorld({ prefs = {}, conflict = "promote" } = {}) {
  const listeners = new Map();
  const timers = [];
  const openGlanceCalls = [];
  const fullyOpenCalls = [];
  const openLinkInCalls = [];
  const openTrustedLinkInCalls = [];

  const tabContainer = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(fn);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
    dispatch: (type, target) => {
      for (const fn of [...(listeners.get(type) ?? [])]) {
        fn({ type, target });
      }
    },
    listenerCount: type => (listeners.get(type) ?? []).length,
  };

  const normalTab = makeTab("normal");
  const dialogWindowCalls = [];
  let openDialogResult = null;
  const world = {
    normalTab,
    tabs: [normalTab],
    browsers: new Map(),
    openGlanceCalls,
    fullyOpenCalls,
    openLinkInCalls,
    openTrustedLinkInCalls,
    timers,
  };

  const bookmarkCalls = [];
  const bookmarkWidgets = new Map();
  const dialogHeader = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const dialogStyle = { props: {}, setProperty(name, value, priority) { this.props[name] = { value, priority }; } };
  const dialogIconStyle = { props: {}, setProperty(name, value, priority) { this.props[name] = { value, priority }; } };
  const dialogIcon = { className: "titleIcon", style: dialogIconStyle };
  const cellStyle = () => ({ props: {}, setProperty(name, value, priority) { this.props[name] = { value, priority }; } });
  const dialogDropdownStyle = cellStyle();
  const dialogTriggerStyle = cellStyle();
  const dialogContent = {
    children: [],
    insertBefore(element, reference) {
      const index = this.children.indexOf(reference);
      if (index < 0) {
        this.children.push(element);
      } else {
        this.children.splice(index, 0, element);
      }
      element.parentElement = this;
      return element;
    },
  };
  const menuStyle = cellStyle();
  const menuExpanderStyle = cellStyle();
  const menuList = {
    tagName: "menulist",
    style: menuStyle,
    parentElement: null,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const locationLabelStyle = cellStyle();
  const menuRow = {
    tagName: "hbox",
    style: cellStyle(),
    children: [menuList, { tagName: "button", style: menuExpanderStyle }],
    parentElement: null,
  };
  menuList.parentElement = menuRow;
  menuList.closest = selector =>
    selector === ".zenEditBMPanel_fieldContainer" ? locationCell : null;
  const locationCell = {
    className: "zenEditBMPanel_fieldContainer",
    style: cellStyle(),
    parentElement: dialogContent,
    children: [
      { tagName: "label", style: locationLabelStyle, textContent: "Location" },
      menuRow,
    ],
  };
  menuRow.parentElement = locationCell;
  const spacesCell = {
    className: "zenEditBMPanel_fieldContainer",
    style: cellStyle(),
    parentElement: dialogContent,
    children: [{ tagName: "label", style: cellStyle() }, { tagName: "div", style: cellStyle() }],
  };
  dialogContent.children.push(locationCell, spacesCell);
  const dialogRow = {
    id: "",
    className: "",
    style: cellStyle(),
    children: [],
    appendChild(element) {
      element.parentElement = this;
      this.children.push(element);
      return element;
    },
  };
  const closestTo = element => selector =>
    selector === ".zenEditBMPanel_fieldContainer" ? element : null;
  const dialogDocument = {
    documentElement: { id: "bookmarkproperties", style: dialogStyle },
    location: { href: "chrome://browser/content/places/bookmarkProperties.xhtml" },
    getElementById: id => {
      if (id === "titleContainer") {
        return dialogHeader;
      }
      if (id === "editBMPanel_folderMenuList") {
        return menuList;
      }
      if (id === "editBMPanel_workspaceDropdown") {
        return { closest: closestTo(spacesCell), style: dialogDropdownStyle };
      }
      if (id === "editBMPanel_workspaceSummary") {
        return { style: dialogTriggerStyle };
      }
      return null;
    },
    createElementNS: () => dialogRow,
    querySelector: selector => (selector === ".titleIcon" ? dialogIcon : null),
  };
  const windowOpenCalls = [];
  let windowOpenResult = { closed: false };
  let openFailure = null;
  let installedAddons = [];

  const browserOf = tab => {
    let browser = world.browsers.get(tab);
    if (!browser) {
      browser = { id: `browser-${tab.id}` };
      world.browsers.set(tab, browser);
    }
    return browser;
  };
  browserOf(normalTab);

  const prefMap = new Map([
    ["zen-glance-plus.essential", true],
    ["zen-glance-plus.pinned", true],
    ["zen-glance-plus.normal", false],
    ["zen-glance-plus.newtab", true],
    ["zen-glance-plus.redirect", false],
    ...Object.entries(prefs),
  ]);

  let overlayOpen = false;

  const gBrowser = {
    selectedTab: normalTab,
    selectedBrowser: null,
    tabContainer,
    tabbox: { getBoundingClientRect: () => ({ width: 1200, height: 800 }) },
    tabs: world.tabs,
    getTabForBrowser: browser => {
      for (const [tab, b] of world.browsers) {
        if (b === browser) {
          return tab;
        }
      }
      return null;
    },
    addTab(uriString, params = {}) {
      const tab = makeTab(`tab-${world.tabs.length}`, {
        url: typeof uriString === "string" ? uriString : uriString?.spec,
      });
      world.tabs.push(tab);
      world.browsers.set(tab, { id: `browser-${tab.id}` });
      if (!params.inBackground) {
        gBrowser.selectedTab = tab;
      }
      // Real Tabbrowser fires TabOpen inside addTab, before the load starts.
      tabContainer.dispatch("TabOpen", tab);
      return tab;
    },
  };
  world.gBrowser = gBrowser;
  world.addTabOriginal = gBrowser.addTab;

  const manager = {
    _animating: false,
    lastLinkClickData: { clientX: 40, clientY: 60, width: 200, height: 20 },
    // Zen's own rule, false unless a case turns it on.
    shouldOpenTabInGlance: () => false,
    openGlance(data, existingTab, ownerTab) {
      openGlanceCalls.push({ data, existingTab, ownerTab });
      overlayOpen = true;
      if (existingTab) {
        existingTab.setAttribute("zen-glance-tab", true);
        existingTab.setAttribute("glance-id", "g1");
      }
      return Promise.resolve(existingTab ?? null);
    },
    fullyOpenGlance() {
      fullyOpenCalls.push(true);
      overlayOpen = false;
      for (const tab of world.tabs) {
        tab.removeAttribute("glance-id");
        tab.removeAttribute("zen-glance-tab");
      }
      return Promise.resolve();
    },
    getTabOrGlanceParent(tab) {
      return tab;
    },
  };

  let overlayBrowser = null;
  const overlayHost = {
    querySelector: selector => (selector === "browser" ? overlayBrowser : null),
  };
  const document = {
    querySelector: selector =>
      selector.includes("zen-glance-overlay") && overlayOpen ? overlayHost : null,
  };

  const windowListeners = new Map();

  const sandbox = {
    console,
    URL,
    Promise,
    RegExp,
    Map,
    Set,
    Object,
    Array,
    String,
    Math,
    JSON,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    Services: {
      // Bound to the sandbox's own window further down, since that is the
      // window being described.
      wm: {
        getMostRecentWindow: () => null,
        getEnumerator: () => ({ hasMoreElements: () => false }),
        getXULWindowEnumerator: () => ({ hasMoreElements: () => false }),
      },
      prefs: {
        getBoolPref: (name, fallback = false) =>
          prefMap.has(name) ? Boolean(prefMap.get(name)) : fallback,
        getStringPref: (name, fallback = "") =>
          prefMap.has(name) ? String(prefMap.get(name)) : fallback,
        setStringPref: (name, value) => prefMap.set(name, String(value)),
        getPrefType: name => (prefMap.has(name) ? 32 : 0),
        PREF_INVALID: 0,
      },
      scriptSecurityManager: {
        getSystemPrincipal: () => ({ isSystemPrincipal: true }),
      },
      ww: {
        openWindow: (parent, url, name, features, args) => {
          windowOpenCalls.push({ parent, url, name, features, args });
          if (openFailure === "watcher") {
            throw Object.assign(new Error("no"), { name: "NS_ERROR_FAILURE" });
          }
          return windowOpenResult;
        },
      },
    },
    gBrowser,
    document,
    window: null,
  };

  sandbox.window = {
    gBrowser,
    gZenGlanceManager: manager,
    PlacesCommandHook: {
      bookmarkLink: (url, title) => {
        bookmarkCalls.push({ url, title });
        return Promise.resolve("guid");
      },
    },
    CustomizableUI: {
      getWidget: id => ({
        forWindow: () => ({ node: bookmarkWidgets.get(id) ?? null }),
      }),
    },
    AddonManager: {
      getAddonsByTypes: async () => installedAddons,
    },
    gDialogBox: {
      dialog: { frameContentWindow: { document: dialogDocument } },
    },
    screenX: 0,
    screenY: 0,
    outerWidth: 1000,
    outerHeight: 800,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, fn) => {
      windowListeners.set(type, fn);
    },
    removeEventListener: (type, fn) => {
      if (windowListeners.get(type) === fn) {
        windowListeners.delete(type);
      }
    },
    openDialog(url, name, features, ...rest) {
      dialogWindowCalls.push({ url, name, features, rest });
      return openDialogResult;
    },
    openLinkIn(url, where, params) {
      openLinkInCalls.push({ url, where, params });
      return "opened";
    },
    openTrustedLinkIn(url, where, params) {
      openTrustedLinkInCalls.push({ url, where, params });
      return "trusted-opened";
    },
  };
  world.openLinkInOriginal = sandbox.window.openLinkIn;
  // Bound after the sandbox exists, since it is the window being described.
  sandbox.Services.wm.getMostRecentWindow = () => sandbox.window;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: scriptPath });

  world.api = sandbox.window.__zenGlancePlus;
  world.window = sandbox.window;
  world.manager = manager;
  world.setPref = (name, value) => prefMap.set(name, value);
  world.bookmarkCalls = bookmarkCalls;
  world.dialogHeader = dialogHeader;
  world.dialogStyle = dialogStyle;
  world.dialogIconStyle = dialogIconStyle;
  world.dialogDropdownStyle = dialogDropdownStyle;
  world.menuStyle = menuStyle;
  world.menuList = menuList;
  world.locationLabelStyle = locationLabelStyle;
  world.menuExpanderStyle = menuExpanderStyle;
  world.dialogTriggerStyle = dialogTriggerStyle;
  world.dialogRow = dialogRow;
  world.dialogContent = dialogContent;
  world.windowOpenCalls = windowOpenCalls;
  world.dialogWindowCalls = dialogWindowCalls;
  world.setOpenDialogResult = value => {
    openDialogResult = value;
  };
  world.setWindowOpenResult = value => {
    windowOpenResult = value;
  };
  world.setOpenFailure = value => {
    openFailure = value;
  };
  world.setAddons = list => {
    installedAddons = list;
  };
  world.setRaindropWidget = (id, node) => {
    bookmarkWidgets.set(id, node);
  };
  world.setGlanceBrowser = browser => {
    overlayBrowser = browser;
  };
  world.setOverlay = value => {
    overlayOpen = value;
    if (!value) {
      // Zen unmarks the tab when the Glance is closed or promoted, so a closed
      // overlay never leaves a tab that still looks like one.
      for (const tab of world.tabs) {
        tab.removeAttribute("glance-id");
        tab.removeAttribute("zen-glance-tab");
      }
    }
  };
  world.setAnimating = value => {
    manager._animating = value;
  };
  world.runTimers = () => {
    while (timers.length) {
      timers.shift().fn();
    }
  };
  world.select = tab => {
    gBrowser.selectedTab = tab;
  };
  return world;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

const contentPrincipal = { isSystemPrincipal: false, spec: "https://example.com" };

/* ------------------------------------------------------------------ tests */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("a new tab from an essential becomes a Glance", async () => {
  const world = createWorld();
  const essential = makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true });
  world.select(essential);
  const tab = world.gBrowser.addTab("https://example.org/a", openedFrom(essential, { inBackground: false }));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);
  assert.equal(world.openGlanceCalls[0].existingTab, tab);
  assert.equal(world.openGlanceCalls[0].ownerTab, essential);
  assert.equal(world.openGlanceCalls[0].data.url, undefined);
});

test("a new tab from a pinned tab becomes a Glance", async () => {
  const world = createWorld();
  const pinned = makeTab("pinned", { pinned: true });
  world.select(pinned);
  world.gBrowser.addTab("https://example.org/b", openedFrom(pinned));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);
  assert.equal(world.openGlanceCalls[0].ownerTab, pinned);
});

test("a new tab from a normal tab is left alone by default", async () => {
  const world = createWorld();
  world.gBrowser.addTab("https://example.org/c", openedFrom(world.gBrowser.selectedTab));
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("Apply to Normal Tabs turns the normal-tab case on", async () => {
  const world = createWorld({ prefs: { "zen-glance-plus.normal": true } });
  world.gBrowser.addTab("https://example.org/c", openedFrom(world.gBrowser.selectedTab));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);
});

test("a New Tab page counts as its own kind, by marker and by address", async () => {
  const world = createWorld();
  const empty = makeTab("empty", { attrs: { "zen-empty-tab": "" }, url: "about:newtab" });
  world.select(empty);
  world.gBrowser.addTab("https://example.org/d", openedFrom(empty));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);

  // The first conversion left a Glance open, and Zen holds one at a time.
  world.setOverlay(false);
  const byUrl = makeTab("by-url", { url: "about:newtab" });
  world.select(byUrl);
  world.gBrowser.addTab("https://example.org/e", openedFrom(byUrl));
  await tick();
  assert.equal(world.openGlanceCalls.length, 2);
});

test("Apply to New Tab Pages off leaves the New Tab page alone", async () => {
  const world = createWorld({ prefs: { "zen-glance-plus.newtab": false } });
  world.select(makeTab("empty", { attrs: { "zen-empty-tab": "" } }));
  world.gBrowser.addTab("https://example.org/f", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("essentials and pinned tabs can each be switched off", async () => {
  const world = createWorld({
    prefs: { "zen-glance-plus.essential": false, "zen-glance-plus.pinned": false },
  });
  world.select(makeTab("e", { attrs: { "zen-essential": "" }, pinned: true }));
  world.gBrowser.addTab("https://example.org/g", {});
  world.select(makeTab("p", { pinned: true }));
  world.gBrowser.addTab("https://example.org/h", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("addresses the browser cannot Glance are left alone", async () => {
  const world = createWorld();
  world.select(makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true }));
  for (const url of ["about:config", "chrome://browser/content/browser.xhtml", "data:text/html,x"]) {
    world.gBrowser.addTab(url, {});
  }
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("pinned, essential, bulk and lazy opens are never converted", async () => {
  const world = createWorld({ prefs: { "zen-glance-plus.normal": true } });
  world.gBrowser.addTab("https://example.org/i", { pinned: true });
  world.gBrowser.addTab("https://example.org/j", { essential: true });
  world.gBrowser.addTab("https://example.org/k", { bulkOrderedOpen: true });
  world.gBrowser.addTab("https://example.org/l", { createLazyBrowser: true });
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("Zen's own Glance switch overrides the mod", async () => {
  const world = createWorld({ prefs: { "zen.glance.enabled": false } });
  world.select(makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true }));
  world.gBrowser.addTab("https://example.org/m", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("a site row decides for its domain before the kind switches", async () => {
  const world = createWorld({
    prefs: {
      "zen-glance-plus.domains": JSON.stringify([
        { host: "quiet.example", tabs: false },
        { host: "peek.example", tabs: true },
      ]),
    },
  });
  const essential = makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true });
  world.select(essential);
  world.gBrowser.addTab("https://quiet.example/page", openedFrom(essential));
  await tick();
  assert.equal(world.openGlanceCalls.length, 0, "quiet.example is switched off for the site");

  const plain = makeTab("plain");
  world.select(plain);
  world.gBrowser.addTab("https://sub.peek.example/page", openedFrom(plain));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "peek.example glances from a normal tab");
  assert.equal(world.openGlanceCalls[0].data.url, undefined);
});

test("a site row can send a same-tab open to a Glance with the global switch off", () => {
  const world = createWorld({
    prefs: {
      "zen-glance-plus.domains": JSON.stringify([
        { host: "peek.example", tabs: true, links: true },
      ]),
    },
  });
  world.window.openLinkIn("https://peek.example/a", "current", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(world.openLinkInCalls.length, 0);
  assert.equal(world.openGlanceCalls.length, 1);
});

test("a site row with same tab off keeps that site in the tab", () => {
  const world = createWorld({
    prefs: {
      "zen-glance-plus.redirect": true,
      "zen-glance-plus.domains": JSON.stringify([
        { host: "quiet.example", tabs: true, links: false },
      ]),
    },
  });
  world.window.openLinkIn("https://quiet.example/a", "current", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(world.openGlanceCalls.length, 0);
  assert.equal(world.openLinkInCalls.length, 1);

  world.window.openLinkIn("https://other.example/a", "current", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(world.openGlanceCalls.length, 1, "a site without a row still follows the switch");
});

test("a site row narrows itself to the links its patterns match", async () => {
  const world = createWorld({
    prefs: {
      "zen-glance-plus.domains": JSON.stringify([
        { host: "reddit.com", tabs: true, links: false, paths: ["/r/*/comments/*"] },
      ]),
    },
  });
  const essential = makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true });
  world.select(essential);

  world.gBrowser.addTab("https://www.reddit.com/r/zen/comments/1abc/some_title/", openedFrom(essential));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "a post opens as a Glance");

  world.setOverlay(false);
  world.gBrowser.addTab("https://www.reddit.com/r/zen/", openedFrom(essential));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "a subreddit listing stays a tab");

  world.gBrowser.addTab("https://www.reddit.com/", openedFrom(essential));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "the front page stays a tab");

  world.gBrowser.addTab("https://www.reddit.com/settings/profile", openedFrom(essential));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "settings stay a tab");
});

test("patterns gate a same-tab redirect the same way", () => {
  const world = createWorld({
    prefs: {
      "zen-glance-plus.domains": JSON.stringify([
        { host: "reddit.com", tabs: true, links: true, paths: ["/r/*/comments/*"] },
      ]),
    },
  });
  world.window.openLinkIn("https://www.reddit.com/r/zen/comments/9/title/", "current", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(world.openGlanceCalls.length, 1);

  world.window.openLinkIn("https://www.reddit.com/r/zen/", "current", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(world.openGlanceCalls.length, 1, "a listing still replaces the tab");
  assert.equal(world.openLinkInCalls.length, 1);
});

test("the shipped sites glance a post from an ordinary tab", async () => {
  const world = createWorld();
  const normal = makeTab("normal", { url: "https://example.org/search" });
  world.select(normal);

  world.gBrowser.addTab("https://www.reddit.com/r/zen/comments/1abc/title/", openedFrom(normal));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "a reddit post glances with ordinary tabs off");

  world.setOverlay(false);
  world.gBrowser.addTab("https://www.reddit.com/r/zen/", openedFrom(normal));
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "a subreddit listing still opens as a tab");
});

test("a site row can still switch a shipped site off", async () => {
  const world = createWorld({
    prefs: { "zen-glance-plus.domains": JSON.stringify([{ host: "reddit.com", tabs: false, links: false, paths: [] }]) },
  });
  world.select(makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true }));

  world.gBrowser.addTab("https://www.reddit.com/r/zen/comments/1abc/title/", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("status reports what the mod is doing", () => {
  const world = createWorld();
  const s = world.api.status();
  assert.equal(s.started, true);
  assert.equal(s.addTabWrapped, true, "addTab should be wrapped after start");
  assert.equal(s.glanceManager, true);
  assert.equal(s.glanceEnabled, true);
  assert.equal(typeof s.sites, "number");
  assert.ok(s.sites >= 1, "shipped sites should be counted");
  assert.equal(s.switches.essential, true);
  assert.equal(s.switches.normal, false);
  assert.equal(world.api.LOG, "[zen-glance-plus]");
});

test("a row's Domain switch keeps its site's own links inside the site", async () => {
  const world = createWorld({
    prefs: {
      "zen-glance-plus.domains": JSON.stringify([
        { host: "reddit.com", tabs: true, links: true, domain: true, paths: [] },
      ]),
    },
  });
  const essential = makeTab("essential", {
    attrs: { "zen-essential": "" },
    pinned: true,
    url: "https://www.reddit.com/",
  });
  world.select(essential);

  const stays = world.gBrowser.addTab("https://old.reddit.com/r/zen/", openedFrom(essential));
  await tick();
  assert.equal(stays.getAttribute("zen-glance-tab"), true, "a subdomain is still the site");

  world.setOverlay(false);
  const leaves = world.gBrowser.addTab("https://example.org/a", openedFrom(essential));
  await tick();
  assert.equal(leaves.getAttribute("zen-glance-tab"), null, "leaving the site is refused");
});

test("a row's Domain switch is off unless the row turns it on", async () => {
  const world = createWorld({
    prefs: {
      "zen-glance-plus.domains": JSON.stringify([
        { host: "reddit.com", tabs: true, links: true, paths: [] },
      ]),
    },
  });
  const essential = makeTab("essential", {
    attrs: { "zen-essential": "" },
    pinned: true,
    url: "https://www.reddit.com/",
  });
  world.select(essential);

  const leaves = world.gBrowser.addTab("https://example.org/a", openedFrom(essential));
  await tick();
  assert.equal(leaves.getAttribute("zen-glance-tab"), true, "the row alone does not bound it");
});

test("Same Domain Only keeps a page in the domain it was opened from", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.samedomain", true);
  const essential = makeTab("essential", {
    attrs: { "zen-essential": "" },
    pinned: true,
    url: "https://www.reddit.com/",
  });
  world.select(essential);

  const same = world.gBrowser.addTab("https://old.reddit.com/r/zen/comments/1abc/t/", openedFrom(essential));
  await tick();
  assert.equal(same.getAttribute("zen-glance-tab"), true, "a subdomain is the same domain");

  world.setOverlay(false);
  const other = world.gBrowser.addTab("https://example.org/a", openedFrom(essential));
  await tick();
  assert.equal(other.getAttribute("zen-glance-tab"), null, "another domain is refused");
});

test("Same Domain Only leaves a New Tab page free to open anywhere", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.samedomain", true);
  const newTab = makeTab("newtab", { attrs: { "zen-newtab-page": "" }, url: "about:newtab" });
  world.select(newTab);

  const tab = world.gBrowser.addTab("https://example.org/a", openedFrom(newTab));
  await tick();
  assert.equal(tab.getAttribute("zen-glance-tab"), true, "a New Tab page has no domain to stay in");
});

test("the domain a host belongs to survives a registry label", () => {
  const world = createWorld();
  const domain = world.api.registrableDomain;
  assert.equal(domain("old.reddit.com"), "reddit.com");
  assert.equal(domain("www.reddit.com"), "reddit.com");
  assert.equal(domain("reddit.com"), "reddit.com");
  assert.equal(domain("news.example.co.uk"), "example.co.uk");
  assert.equal(domain("foo.co.uk"), "foo.co.uk");
  assert.equal(domain("a.b.example.com"), "example.com");
});

test("a link opened from a page is answered with the address Zen kept", () => {
  const world = createWorld();
  const essential = makeTab("essential", {
    attrs: { "zen-essential": "" },
    pinned: true,
    url: "https://www.reddit.com/",
  });
  world.select(essential);

  // The tab Zen created for the click, owned by the essential.
  const opened = makeTab("opened", { url: "about:blank" });
  opened.owner = essential;

  const post = { spec: "https://www.reddit.com/r/zen/comments/1abc/t/" };
  assert.equal(
    world.manager.shouldOpenTabInGlance(opened, post),
    true,
    "a reddit post opened from the reddit essential should glance"
  );

  const listing = { spec: "https://www.reddit.com/r/zen/" };
  assert.equal(world.manager.shouldOpenTabInGlance(opened, listing), false);
});

test("a Glance never opens inside a Glance", () => {
  const world = createWorld();
  const glanceTab = makeTab("glance", { url: "https://example.org/inside" });
  glanceTab.setAttribute("glance-id", "g1");
  glanceTab.setAttribute("zen-glance-tab", true);

  assert.equal(
    world.api.planFor("https://www.reddit.com/r/zen/comments/1abc/t/", { ownerTab: glanceTab }),
    null,
    "no second Glance, whoever asks for it"
  );
});

/** A Glance as Zen builds it: the Glance's tab nested in the tab it sits over. */
function makeOpenGlance(world, { baseAttrs = { "zen-essential": "" }, basePinned = true } = {}) {
  const base = makeTab("base", { attrs: baseAttrs, pinned: basePinned, url: "https://example.org/start" });
  // Zen marks both tabs: the one it shows and the one it sits over. That is
  // what made a tab a bad handle for "the page the Glance is showing".
  base.setAttribute("glance-id", "g1");
  const glanceTab = makeTab("glance", { url: "https://example.org/in-glance" });
  glanceTab.setAttribute("glance-id", "g1");
  glanceTab.setAttribute("zen-glance-tab", true);
  glanceTab.parentElement = { closest: selector => (selector === "tab" ? base : null) };
  world.tabs.push(base, glanceTab);
  world.select(glanceTab);
  world.setOverlay(true);

  const loaded = [];
  const baseLoaded = [];
  world.setGlanceBrowser({
    fixupAndLoadURIString: (url, params) => loaded.push({ url, params }),
  });
  // The tab underneath can be navigated too, which is exactly the mistake to
  // catch: it is the handle that looked right and was not.
  base.linkedBrowser.fixupAndLoadURIString = url => baseLoaded.push(url);
  return { base, glanceTab, loaded, baseLoaded };
}

test("a link that would glance inside a Glance stays in that Glance", () => {
  const world = createWorld();
  const { base, glanceTab, loaded, baseLoaded } = makeOpenGlance(world);
  const before = world.tabs.length;

  const returned = world.gBrowser.addTab("https://example.org/next", {
    openerBrowser: "whatever",
    ownerTab: base,
  });

  assert.equal(world.tabs.length, before, "no tab is created for it");
  assert.equal(returned, glanceTab, "the Glance's own tab is handed back");
  assert.deepEqual(
    loaded.map(entry => entry.url),
    ["https://example.org/next"],
    "the address loads in the overlay, not in the tab underneath"
  );
  assert.equal(
    base.linkedBrowser.currentURI.spec,
    "https://example.org/start",
    "the tab underneath is untouched"
  );
  assert.deepEqual(baseLoaded, [], "and it is never navigated");
  assert.ok(loaded[0].params?.triggeringPrincipal, "with a principal to load by");
});

test("a new tab asked for inside a Glance is a new tab", () => {
  const world = createWorld();
  // A Glance over an ordinary tab, which glances nothing by itself.
  const { base, loaded, baseLoaded } = makeOpenGlance(world, { baseAttrs: {}, basePinned: false });

  const before = world.tabs.length;
  const tab = world.gBrowser.addTab("https://example.org/other", { ownerTab: base });

  assert.equal(world.tabs.length, before + 1, "the tab is created");
  assert.notEqual(tab, base, "and it is not the tab underneath");
  assert.deepEqual(loaded, [], "the Glance is left where it is");
  assert.deepEqual(baseLoaded, [], "and the tab underneath is not loaded either");
  assert.equal(base.linkedBrowser.currentURI.spec, "https://example.org/start");
});

test("a page that opens its own tab from inside a Glance lands there too", () => {
  const world = createWorld();
  const { glanceTab, loaded } = makeOpenGlance(world);

  const opened = makeTab("opened", { url: "about:blank" });
  opened.owner = glanceTab;
  world.tabs.push(opened);

  const answer = world.manager.shouldOpenTabInGlance(opened, {
    spec: "https://example.org/from-glance",
  });

  assert.equal(answer, false, "it does not become a Glance");
  assert.deepEqual(loaded.map(entry => entry.url), ["https://example.org/from-glance"], "it loads in the open Glance");
});

test("a Glance is still seen when its tab is not the selected one", () => {
  const world = createWorld();
  const glanceTab = makeTab("glance", { url: "https://example.org/start" });
  glanceTab.setAttribute("glance-id", "g1");
  world.tabs.push(glanceTab);
  // Peeking leaves another tab selected; the marker is what matters.
  world.select(makeTab("plain"));

  const opened = world.gBrowser.addTab("https://example.org/x", {
    ownerTab: world.tabs[0],
  });
  assert.equal(world.openGlanceCalls.length, 0, "no second Glance while one is open");
  assert.ok(opened, "the tab exists");
});

test("the glance button strip gets one copy button, once", () => {
  const world = createWorld();
  const made = [];
  const element = name => {
    const styles = new Map();
    const node = {
      kind: name,
      attrs: {},
      children: [],
      style: {
        setProperty: (key, value, priority) => styles.set(key, { value, priority }),
        getPropertyValue: key => styles.get(key)?.value ?? "",
        getPropertyPriority: key => styles.get(key)?.priority ?? "",
      },
      set className(value) {
        this.attrs.class = value;
      },
      get className() {
        return this.attrs.class ?? "";
      },
      setAttribute: (key, value) => {
        node.attrs[key] = String(value);
      },
      getAttribute: key => node.attrs[key] ?? null,
      appendChild: child => {
        node.children.push(child);
        return child;
      },
    };
    made.push(node);
    return node;
  };
  const documentDouble = { createXULElement: element };
  const container = {
    children: [],
    ownerDocument: documentDouble,
    querySelector: selector =>
      selector === ".zgp-glance-copy"
        ? container.children.find(child => child.className.includes("zgp-glance-copy")) ?? null
        : null,
    appendChild: child => {
      container.children.push(child);
      return child;
    },
  };

  const first = world.api.addGlanceCopyButton(container);
  assert.ok(first, "a button is added");
  assert.match(first.className, /zgp-glance-copy/);
  assert.equal(first.getAttribute("data-act"), "glancecopy");
  assert.equal(first.getAttribute("aria-label"), "Copy link");
  assert.equal(
    first.style.getPropertyValue("list-style-image"),
    'url("' + world.api.COPY_ICON + '")',
    "the icon is Zen's own, drawn the way Zen draws its strip icons"
  );
  assert.equal(world.api.COPY_ICON, "chrome://browser/skin/zen-icons/link.svg");
  assert.equal(
    first.style.getPropertyValue("-moz-context-properties"),
    "fill, fill-opacity",
    "so the skin colours it the way it colours close and split"
  );
  assert.equal(first.children.length, 0, "no embedded image with a fill of its own");
  assert.equal(
    first.style.getPropertyPriority("list-style-image"),
    "important",
    "a theme's user chrome must not be able to strip it"
  );

  assert.equal(world.api.addGlanceCopyButton(container), null, "adding it twice changes nothing");
  assert.equal(container.children.length, 1);
});

test("the glance copy button asks Zen's own copy action", () => {
  const world = createWorld();
  const browser = { currentURI: { spec: "https://example.org/a" } };
  world.gBrowser.selectedBrowser = browser;
  let calls = 0;
  world.window.gZenCommonActions = {
    copyCurrentURLToClipboard: () => {
      calls += 1;
    },
  };

  assert.equal(world.api.copyGlanceUrl(browser), true);
  assert.equal(calls, 1, "the toolbar action is reused, not re-implemented");
});

test("a click on the glance copy button copies the glance's own page", () => {
  const world = createWorld();
  const browser = { currentURI: { spec: "https://example.org/glance" } };
  world.gBrowser.selectedBrowser = browser;
  world.window.gZenCommonActions = { copyCurrentURLToClipboard: () => {} };

  const button = {
    closest: selector => (selector === ".zgp-glance-copy" ? button : null),
    parentElement: null,
  };
  const host = {
    querySelector: selector => (selector === "browser" ? browser : null),
  };
  button.parentElement = {
    closest: selector => (selector === ".browserSidebarContainer" ? host : null),
  };
  let prevented = 0;
  world.api.onGlanceCopyClick({
    target: button,
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {},
  });

  assert.equal(prevented, 1, "the click is claimed");
});

test("a tab the browser opens for itself is not a Glance", async () => {
  // The sidebar's plus button, with only a pinned tab left open: the tab has no
  // opener, and the selected tab used to be borrowed as one.
  const world = createWorld();
  const essential = makeTab("essential", {
    attrs: { "zen-essential": "" },
    pinned: true,
    url: "https://www.google.com/",
  });
  world.select(essential);

  const tab = world.gBrowser.addTab("https://www.google.com/", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0, "nothing to convert");
  assert.equal(tab.getAttribute("zen-glance-tab"), null, "the tab stays a tab");
});

test("with no tabs open at all, the first tab opens as a tab", async () => {
  const world = createWorld();
  const essential = makeTab("essential", {
    attrs: { "zen-essential": "" },
    pinned: true,
    url: "https://www.google.com/",
  });
  world.select(essential);
  world.gBrowser.selectedTab = null;

  const tab = world.gBrowser.addTab("https://www.google.com/", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0, "an empty workspace opens tabs, not Glances");
  assert.equal(tab.getAttribute("zen-glance-tab"), null);
});

test("the browser's own new tab is never turned into a Glance", () => {
  const world = createWorld();
  world.api.stop();
  // Zen's rule says yes for anything opened from a pinned app tab, which is
  // what the sidebar's + button looks like from here.
  world.manager.shouldOpenTabInGlance = () => true;
  world.api.start();

  const opened = makeTab("opened", { url: "about:newtab" });
  for (const spec of ["about:newtab", "about:blank", "about:home", "about:preferences"]) {
    assert.equal(
      world.manager.shouldOpenTabInGlance(opened, { spec }),
      false,
      spec + " is not a page to glance"
    );
  }

  assert.equal(
    world.manager.shouldOpenTabInGlance(opened, { spec: "https://example.org/a" }),
    true,
    "a real page still follows Zen's own rule"
  );
});

test("Zen's own decision is kept when its rule already says glance", () => {
  const world = createWorld();
  world.api.stop();
  world.manager.shouldOpenTabInGlance = () => true;
  world.api.start();

  const opened = makeTab("opened", { url: "about:blank" });
  assert.equal(
    world.manager.shouldOpenTabInGlance(opened, { spec: "https://example.org/anything" }),
    true,
    "a site with no row still glances when Zen's rule says so"
  );
});

test("stop puts Zen's own rule back", () => {
  const world = createWorld();
  const wrapped = world.manager.shouldOpenTabInGlance;
  world.api.stop();

  const restored = world.manager.shouldOpenTabInGlance;
  assert.notEqual(restored, wrapped, "the wrapper should be gone");
  assert.equal(
    restored({}, { spec: "https://www.reddit.com/r/x/comments/1/t/" }),
    false,
    "the original rule knows nothing about reddit rows"
  );
});

test("nothing is converted while Zen is animating a Glance", async () => {
  const world = createWorld();
  world.select(makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true }));
  world.setAnimating(true);
  world.gBrowser.addTab("https://example.org/n", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("a second matching page promotes the open Glance to a tab first", async () => {
  const world = createWorld();
  const essential = makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true });
  world.select(essential);
  world.setOverlay(true);
  const tab = world.gBrowser.addTab("https://example.org/o", openedFrom(essential));
  await tick();
  await tick();
  assert.equal(world.fullyOpenCalls.length, 1);
  world.runTimers();
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);
  assert.equal(world.openGlanceCalls[0].existingTab, tab);
});

test("the redirect switch is off by default and leaves openLinkIn alone", () => {
  const world = createWorld();
  const result = world.window.openLinkIn("https://example.org/p", "current", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(result, "opened");
  assert.equal(world.openGlanceCalls.length, 0);
  assert.equal(world.openLinkInCalls.length, 1);
});

test("with redirection on, a page-initiated same-tab open becomes a Glance", () => {
  const world = createWorld({ prefs: { "zen-glance-plus.redirect": true } });
  world.window.openLinkIn("https://example.org/q", "current", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(world.openLinkInCalls.length, 0);
  assert.equal(world.openGlanceCalls.length, 1);
  assert.equal(world.openGlanceCalls[0].data.url, "https://example.org/q");
  assert.equal(world.openGlanceCalls[0].existingTab, undefined);
});

test("redirection never takes the address bar: system-principal opens navigate", () => {
  const world = createWorld({ prefs: { "zen-glance-plus.redirect": true } });
  world.window.openLinkIn("https://example.org/r", "current", {
    triggeringPrincipal: { isSystemPrincipal: true },
  });
  assert.equal(world.openLinkInCalls.length, 1);
  assert.equal(world.openGlanceCalls.length, 0);
});

test("redirection leaves new-tab and new-window destinations to the tab policy", () => {
  const world = createWorld({ prefs: { "zen-glance-plus.redirect": true } });
  world.window.openLinkIn("https://example.org/s", "tab", {
    triggeringPrincipal: contentPrincipal,
  });
  assert.equal(world.openGlanceCalls.length, 0);
  assert.equal(world.openLinkInCalls.length, 1);
});

test("stopping the mod restores addTab, both link openers and the listeners", () => {
  const world = createWorld();
  assert.notEqual(world.gBrowser.addTab, world.addTabOriginal);
  assert.notEqual(world.window.openLinkIn, world.openLinkInOriginal);
  world.api.stop();
  assert.equal(world.gBrowser.addTab, world.addTabOriginal);
  assert.equal(world.window.openLinkIn, world.openLinkInOriginal);
  assert.equal(world.gBrowser.tabContainer.listenerCount("TabOpen"), 0);
  assert.equal(world.gBrowser.tabContainer.listenerCount("TabSelect"), 0);
});

test("the shipped preferences match the documented defaults", () => {
  const prefs = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "preferences.json"), "utf8")
  );
  const world = createWorld();
  const checks = prefs.filter(entry => entry.type === "checkbox");
  assert.equal(checks.length, 6);
  for (const entry of checks) {
    const key = entry.property.replace("zen-glance-plus.", "");
    assert.equal(
      world.api.DEFAULTS[key],
      entry.defaultValue,
      `${entry.label} default disagrees with the script`
    );
    assert.equal(entry.label, labelFor(key));
  }
  const first = prefs.find(entry => entry.type === "separator");
  assert.equal(first.id, "zen-glance-plus-apply-to", "the first heading needs the id the sheet hides");

  const headings = prefs.filter(entry => entry.type === "separator").map(entry => entry.label);
  assert.deepEqual(headings, ["**Apply to**", "**Glance applies to**", "**Glance bar**", "**Sites**"]);

  const dropdowns = prefs.filter(entry => entry.type === "dropdown");
  assert.equal(dropdowns.length, 1, "the bookmark button has one setting");
  const bookmark = dropdowns[0];
  assert.equal(bookmark.property, "zen-glance-plus.bookmark");
  assert.equal(bookmark.label, "Bookmark in Glance Bar (experimental)");
  assert.equal(bookmark.defaultValue, "off", "Disabled is the default");
  assert.deepEqual(
    bookmark.options.map(option => [option.label, option.value]),
    [["Disabled", "off"], ["Bookmarks", "bookmarks"], ["Raindrop", "raindrop"]]
  );
  // Sine adds a "None" item above a dropdown unless the mod refuses one.
  assert.equal(bookmark.placeholder, false, "the three positions are the whole list");

  function labelFor(key) {
    return {
      essential: "Essentials",
      pinned: "Pinned Tabs",
      normal: "Normal Tabs",
      newtab: "New Tab Pages",
      redirect: "Same Tab Pages",
      samedomain: "Same Domain Only",
    }[key];
  }
});

test("the script ships no inline stylesheet", () => {
  assert.equal(/createElement\(\s*["']style["']\s*\)/.test(source), false);
  assert.equal(source.includes("<style"), false);
});

/* ------------------------------------------------- bookmark in the bar */

function fakeEl(tag, className = "") {
  const el = {
    tagName: tag,
    className,
    children: [],
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    remove() {
      const parent = el.parentElement;
      if (parent) {
        const index = parent.children.indexOf(el);
        if (index >= 0) {
          parent.children.splice(index, 1);
        }
        el.parentElement = null;
      }
    },
    querySelectorAll(selector) {
      const matches = [];
      const walk = node => {
        for (const child of node.children ?? []) {
          const wanted = selector.replace(/^[#.]/, "");
          const isId = selector.startsWith("#");
          const hit = isId
            ? child.id === wanted
            : String(child.className ?? "").split(" ").includes(wanted);
          if (hit) {
            matches.push(child);
          }
          walk(child);
        }
      };
      walk(el);
      return matches;
    },
    querySelector(selector) {
      const wanted = selector.replace(/^[#.]/, "");
      const wantedIsId = selector.startsWith("#");
      const match = node => (wantedIsId ? node.id === wanted : String(node.className ?? "").split(" ").includes(wanted));
      for (const child of el.children) {
        if (match(child)) {
          return child;
        }
        const deeper = child.querySelector?.(selector);
        if (deeper) {
          return deeper;
        }
      }
      return null;
    },
    style: {
      props: {},
      setProperty(name, value) {
        this.props[name] = value;
      },
    },
    attributes: {},
    parentElement: null,
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return el.attributes[name];
    },
    remove() {
      const parent = el.parentElement;
      if (!parent) {
        return;
      }
      const index = parent.children.indexOf(el);
      if (index >= 0) {
        parent.children.splice(index, 1);
      }
      el.parentElement = null;
    },
    closest(selector) {
      const wanted = selector.replace(/^\./, "");
      let node = el;
      while (node) {
        if (String(node.className ?? "").split(" ").includes(wanted)) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    },
  };
  return el;
}

function fakeStrip(browser) {
  const children = [];
  const container = {
    children,
    ownerDocument: {
      createXULElement: tag => fakeEl(tag),
      createElement: tag => fakeEl(tag),
      createElementNS: (namespace, tag) => fakeEl(tag),
      getElementById: id => {
        for (const child of children) {
          if (child.id === id) {
            return child;
          }
          const deeper = child.querySelector?.(`#${id}`);
          if (deeper) {
            return deeper;
          }
        }
        return null;
      },
    },
    querySelector(selector) {
      const wanted = selector.replace(/^\./, "");
      return children.find(el => String(el.className).split(" ").includes(wanted)) ?? null;
    },
    querySelectorAll(selector) {
      const wanted = selector.replace(/^\./, "");
      const matches = [];
      const walk = node => {
        for (const child of node.children ?? []) {
          if (String(child.className).split(" ").includes(wanted)) {
            matches.push(child);
          }
          walk(child);
        }
      };
      walk(container);
      return matches;
    },
    appendChild(el) {
      el.parentElement = container;
      children.push(el);
      return el;
    },
    insertBefore(el, reference) {
      el.parentElement = container;
      const index = reference ? children.indexOf(reference) : -1;
      if (index < 0) {
        children.push(el);
      } else {
        children.splice(index, 0, el);
      }
      return el;
    },
  };
  // The page the Glance is showing sits in a container above the strip, which
  // is how the copy button finds it too.
  const host = {
    className: "browserSidebarContainer",
    parentElement: null,
    querySelector: selector => (selector === "browser" ? browser : null),
  };
  container.parentElement = host;
  return container;
}

const makeBrowser = (url, title = "A page") => ({
  currentURI: { spec: url },
  contentTitle: title,
});

const clickOn = element => ({
  target: element,
  prevented: false,
  stopped: false,
  preventDefault() {
    this.prevented = true;
  },
  stopPropagation() {
    this.stopped = true;
  },
});

test("no save button is drawn unless the setting asks for one", () => {
  const world = createWorld();
  const strip = fakeStrip(makeBrowser("https://example.org/page"));

  assert.equal(world.api.addGlanceBookmarkButton(strip), null, "Disabled is the default");
  assert.equal(strip.children.length, 0);

  world.setPref("zen-glance-plus.bookmark", "bookmarks");
  const button = world.api.addGlanceBookmarkButton(strip);
  assert.ok(button, "Bookmarks draws one");
  assert.equal(button.getAttribute("aria-label"), "Bookmark this page");
  assert.ok(
    button.style.props["list-style-image"].includes("zen-icons/bookmark-hollow.svg"),
    "with Zen's own bookmark icon"
  );
  assert.equal(
    button.style.props["-moz-context-properties"],
    "fill, fill-opacity",
    "and the properties that let a skin colour it"
  );

  world.setPref("zen-glance-plus.bookmark", "off");
  assert.equal(world.api.addGlanceBookmarkButton(strip), null, "switching it off takes it away");
  assert.equal(strip.children.length, 0);
});

test("the save button sits to the left of copy", () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "bookmarks");
  const strip = fakeStrip(makeBrowser("https://example.org/page"));
  const copy = fakeEl("toolbarbutton", "zgp-glance-copy");
  strip.appendChild(copy);

  const button = world.api.addGlanceBookmarkButton(strip);
  assert.ok(button);
  assert.equal(strip.children[0], button, "it is first");
  assert.equal(strip.children[1], copy, "and the copy button follows it");
});

test("clicking it opens the add bookmark dialog for the Glance's page", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "bookmarks");
  const strip = fakeStrip(makeBrowser("https://example.org/read", "Read this"));
  const button = world.api.addGlanceBookmarkButton(strip);

  const event = clickOn(button);
  world.api.onGlanceBookmarkClick(event);
  await tick();

  assert.equal(event.prevented, true, "the strip's own handling is stopped");
  assert.deepEqual(
    world.bookmarkCalls.map(call => [call.url, call.title]),
    [["https://example.org/read", "Read this"]],
    "the dialog is asked for this address, not for the selected tab"
  );
});

test("the bookmark dialog's header icon is cleared", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "bookmarks");
  const strip = fakeStrip(makeBrowser("https://example.org/read", "Read this"));
  const button = world.api.addGlanceBookmarkButton(strip);

  world.api.onGlanceBookmarkClick(clickOn(button));
  world.runTimers();
  await tick();

  assert.equal(
    world.dialogStyle.props["--icon-url"]?.value,
    "none",
    "the title slot stops painting the icon"
  );
  assert.equal(
    world.dialogStyle.props["--icon-url"]?.priority,
    "important",
    "over the value the dialog sets for itself"
  );
  assert.equal(world.dialogHeader.attributes.noicon, "true", "and the container hides it outright");
  assert.equal(
    world.dialogIconStyle.props.display?.value,
    "none",
    "the icon element itself is hidden, whatever the dialog thinks it reads"
  );
  assert.equal(world.dialogIconStyle.props.display?.priority, "important");
});

test("Location and Spaces are put on one row", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "bookmarks");
  const strip = fakeStrip(makeBrowser("https://example.org/read", "Read this"));

  world.api.onGlanceBookmarkClick(clickOn(world.api.addGlanceBookmarkButton(strip)));
  world.runTimers();
  await tick();

  const row = world.dialogRow;
  assert.ok(row, "a row is made for the pair");
  assert.equal(row.children.length, 2, "with both fields inside it");
  assert.equal(
    row.style.props.display?.value,
    "flex",
    "laid out as a row, because the dialog's grid gives each field its own line"
  );
  assert.equal(row.style.props.gap?.value, "0", "with no space between them");
  assert.equal(row.style.props["flex-wrap"]?.value, "nowrap", "on one line, never two");
  assert.equal(world.dialogContent.children.includes(row), true, "and it takes their place");
  assert.equal(
    world.dialogDropdownStyle.props.width?.value,
    "auto",
    "the Spaces dropdown stops asking for the whole cell"
  );
  assert.equal(
    world.dialogTriggerStyle.props["text-overflow"]?.value,
    "ellipsis",
    "and its name shortens instead of pushing the line wider"
  );
  assert.equal(
    world.dialogTriggerStyle.props["margin-inline-end"]?.value,
    "0",
    "and nothing holds space on its right"
  );
  assert.equal(world.menuStyle.props.width?.value, "auto");
  assert.equal(
    world.menuStyle.props["padding-inline-start"]?.value,
    "0",
    "and starts exactly where the word it replaced started"
  );
  assert.equal(world.menuStyle.props["margin-inline-start"]?.value, "0");
  assert.equal(
    world.menuStyle.props["margin-inline-end"]?.value,
    "0",
    "with no space held on its right either"
  );
  assert.equal(
    world.menuStyle.props.flex?.value,
    "0 1 auto",
    "the folder menu hugs its own text instead of stretching and sitting empty"
  );
  assert.equal(
    world.locationLabelStyle.props.display?.value,
    "none",
    "the word Location gives its place to the folder chip"
  );
  assert.equal(
    world.menuList.attributes["aria-label"],
    "Location",
    "and the menu keeps the name the label gave it"
  );
  assert.equal(
    world.menuExpanderStyle.props.flex?.value,
    "0 0 auto",
    "while the expander beside it keeps its own size"
  );
  const [location, spaces] = row.children;
  assert.equal(location.style.props.flex?.value, "0 1 auto", "Location is only as wide as it needs");
  assert.equal(spaces.style.props.flex?.value, "1 1 40%", "and Spaces takes the rest of the line");
  for (const cell of row.children) {
    assert.equal(cell.style.props["min-width"]?.value, "0", "either may shrink");
    assert.equal(cell.style.props["flex-wrap"]?.value, "nowrap", "and neither wraps inside");
  }
});

test("Raindrop mode shows the cloud from beside the address bar", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "raindrop");
  world.setAddons([
    {
      id: "raindrop@example",
      name: "Raindrop.io",
      isActive: true,
      iconURL: "moz-extension://uuid-1/assets/icon_32.png",
    },
  ]);
  await world.api.findRaindrop();

  const strip = fakeStrip(makeBrowser("https://example.org/read"));
  const button = world.api.addGlanceBookmarkButton(strip);
  assert.ok(button, "the button appears");
  assert.equal(button.style.props["list-style-image"], "none", "no picture is loaded");
  const glyph = button.children[0];
  assert.ok(glyph, "the cloud is drawn as a child of the button");
  assert.ok(
    glyph.style.props["mask-image"].includes("data:image/svg+xml"),
    "the shape is the baked cloud"
  );
  assert.equal(
    glyph.style.props["background-color"],
    "currentColor",
    "and the ink is the button's own colour"
  );
  assert.equal(
    button.style.props["background-color"],
    undefined,
    "the button keeps Zen's chip, which an earlier mask painted over"
  );
  assert.equal(button.getAttribute("aria-label"), "Save to Raindrop.io");

  const event = clickOn(button);
  world.api.onGlanceBookmarkClick(event);
  await tick();

  assert.equal(event.prevented, true, "the strip's own handling is stopped");
  assert.equal(world.windowOpenCalls.length, 1, "Raindrop's dialog window is asked for");
  const opened = world.windowOpenCalls[0];
  assert.equal(
    opened.url,
    "moz-extension://uuid-1/index.html#/add?link=https%3A%2F%2Fexample.org%2Fread",
    "at the address Raindrop itself opens for a page"
  );
  assert.ok(opened.features.includes("popup"), "as a popup");
  assert.ok(opened.features.includes("width=420") && opened.features.includes("height=600"),
    "at Raindrop's own size");
  assert.ok(opened.features.includes("left=290") && opened.features.includes("top=100"),
    "centred on the window it came from");
});

test("the dialog is a popup window centred on the window that drew the page", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "raindrop");
  world.setPref("extensions.webextensions.uuids", JSON.stringify({ "raindrop@example": "uuid-9" }));
  world.setAddons([{ id: "raindrop@example", name: "Raindrop.io", isActive: true }]);
  await world.api.findRaindrop();

  // The element's own window, which is the only real one a sandbox can reach.
  const drawnIn = { screenX: 500, screenY: 300, outerWidth: 800, outerHeight: 700 };
  const browser = makeBrowser("https://example.org/read");
  browser.ownerDocument = { defaultView: drawnIn };
  const strip = fakeStrip(browser);

  world.api.onGlanceBookmarkClick(clickOn(world.api.addGlanceBookmarkButton(strip)));

  const call = world.windowOpenCalls[0];
  assert.equal(call.parent, drawnIn, "the window watcher is given the real window");
  assert.ok(call.features.startsWith("popup,"), "Raindrop's own shape: a browser popup window");
  assert.ok(call.features.includes("width=420") && call.features.includes("height=600"));
  assert.ok(
    call.features.includes("left=690") && call.features.includes("top=350"),
    "centred on that window"
  );
});

test("Raindrop's address comes from the browser, not from its icon", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "raindrop");
  world.setPref("extensions.webextensions.uuids", JSON.stringify({ "raindrop@example": "uuid-9" }));
  // No iconURL, which is what the real add-on gave: an empty base and a silent
  // "no Raindrop to save it with".
  world.setAddons([{ id: "raindrop@example", name: "Raindrop.io", isActive: true }]);
  await world.api.findRaindrop();

  const strip = fakeStrip(makeBrowser("https://example.org/read"));
  const button = world.api.addGlanceBookmarkButton(strip);
  world.api.onGlanceBookmarkClick(clickOn(button));

  assert.equal(world.windowOpenCalls.length, 1, "a window is asked for");
  assert.equal(
    world.windowOpenCalls[0].url,
    "moz-extension://uuid-9/index.html#/add?link=https%3A%2F%2Fexample.org%2Fread",
    "at the address the browser keeps for that extension"
  );
});

test("Raindrop's page opens as a centred dialog window, not a tab", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "raindrop");
  world.setPref("extensions.webextensions.uuids", JSON.stringify({ "raindrop@example": "uuid-9" }));
  world.setAddons([{ id: "raindrop@example", name: "Raindrop.io", isActive: true }]);
  await world.api.findRaindrop();
  const dialogWindow = { focus() {} };
  world.setOpenDialogResult(dialogWindow);

  const strip = fakeStrip(makeBrowser("https://example.org/read"));
  const before = world.tabs.length;
  world.api.onGlanceBookmarkClick(clickOn(world.api.addGlanceBookmarkButton(strip)));

  assert.equal(world.dialogWindowCalls.length, 1, "a dialog window is asked for");
  const call = world.dialogWindowCalls[0];
  assert.ok(call.features.includes("centerscreen"), "in the middle of the screen");
  assert.ok(call.features.includes("chrome=no"), "with no toolbar of its own");
  assert.ok(call.features.includes("width=420") && call.features.includes("height=600"));
  assert.equal(world.windowOpenCalls.length, 0, "and nothing else is tried");
  assert.equal(world.tabs.length, before, "no tab is made");
});

test("a second pass never leaves two save buttons", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "raindrop");
  world.setPref("extensions.webextensions.uuids", JSON.stringify({ "raindrop@example": "uuid-9" }));
  world.setAddons([{ id: "raindrop@example", name: "Raindrop.io", isActive: true }]);
  await world.api.findRaindrop();

  const strip = fakeStrip(makeBrowser("https://example.org/read"));
  const first = world.api.addGlanceBookmarkButton(strip);
  // A copy left behind by an earlier pass, with the same classes.
  const stale = fakeEl("toolbarbutton", "no-squircles zgp-glance-bookmark toolbarbutton-1");
  strip.appendChild(stale);

  const second = world.api.addGlanceBookmarkButton(strip);

  assert.equal(second, first, "the button already there is reused");
  const buttons = strip.children.filter(el => String(el.className).includes("zgp-glance-bookmark"));
  assert.equal(buttons.length, 1, "one button, one cloud");
});

test("a tab is the last way in when no window can be made", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "raindrop");
  world.setAddons([
    {
      id: "raindrop@example",
      name: "Raindrop.io",
      isActive: true,
      iconURL: "moz-extension://uuid-1/assets/icon_32.png",
    },
  ]);
  await world.api.findRaindrop();
  world.setWindowOpenResult(null);
  world.setOpenFailure("watcher");

  const strip = fakeStrip(makeBrowser("https://example.org/read"));
  const button = world.api.addGlanceBookmarkButton(strip);
  const before = world.tabs.length;

  world.api.onGlanceBookmarkClick(clickOn(button));

  assert.equal(world.tabs.length, before + 1, "the page is opened somewhere");
  assert.ok(
    world.tabs
      .at(-1)
      .linkedBrowser.currentURI.spec.startsWith("moz-extension://uuid-1/index.html#/add?link="),
    "at Raindrop's add address"
  );
});

test("Raindrop mode shows nothing when Raindrop is not installed", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.bookmark", "raindrop");
  world.setAddons([]);
  await world.api.findRaindrop();

  const strip = fakeStrip(makeBrowser("https://example.org/page"));
  assert.equal(world.api.addGlanceBookmarkButton(strip), null);
  assert.equal(strip.children.length, 0);

  const event = clickOn({ closest: () => null });
  world.api.onGlanceBookmarkClick(event);
  assert.equal(event.prevented, false, "and a click elsewhere is not swallowed");
});

/* ---------------------------------------------------------------- runner */

let failed = 0;
const only = process.env.ONLY;
const selected = only ? tests.filter(entry => entry.name.includes(only)) : tests;
for (const { name, fn } of selected) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

console.log(`\n${selected.length - failed}/${selected.length} passed (${path.basename(scriptPath)})`);
process.exit(failed ? 1 : 0);

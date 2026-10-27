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
      return Promise.resolve();
    },
    getTabOrGlanceParent(tab) {
      return tab;
    },
  };

  const document = {
    querySelector: selector =>
      selector.includes("zen-glance-overlay") && overlayOpen ? { fake: true } : null,
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
    },
    gBrowser,
    document,
    window: null,
  };

  sandbox.window = {
    gBrowser,
    gZenGlanceManager: manager,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, fn) => {
      windowListeners.set(type, fn);
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

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: scriptPath });

  world.api = sandbox.window.__zenGlancePlus;
  world.window = sandbox.window;
  world.manager = manager;
  world.setPref = (name, value) => prefMap.set(name, value);
  world.setOverlay = value => {
    overlayOpen = value;
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
  const tab = world.gBrowser.addTab("https://example.org/a", { inBackground: false });
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
  world.gBrowser.addTab("https://example.org/b", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);
  assert.equal(world.openGlanceCalls[0].ownerTab, pinned);
});

test("a new tab from a normal tab is left alone by default", async () => {
  const world = createWorld();
  world.gBrowser.addTab("https://example.org/c", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0);
});

test("Apply to Normal Tabs turns the normal-tab case on", async () => {
  const world = createWorld({ prefs: { "zen-glance-plus.normal": true } });
  world.gBrowser.addTab("https://example.org/c", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);
});

test("a New Tab page counts as its own kind, by marker and by address", async () => {
  const world = createWorld();
  const empty = makeTab("empty", { attrs: { "zen-empty-tab": "" }, url: "about:newtab" });
  world.select(empty);
  world.gBrowser.addTab("https://example.org/d", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 1);

  // The first conversion left a Glance open, and Zen holds one at a time.
  world.setOverlay(false);
  const byUrl = makeTab("by-url", { url: "about:newtab" });
  world.select(byUrl);
  world.gBrowser.addTab("https://example.org/e", {});
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
  world.select(makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true }));
  world.gBrowser.addTab("https://quiet.example/page", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 0, "quiet.example is switched off for the site");

  world.select(makeTab("plain"));
  world.gBrowser.addTab("https://sub.peek.example/page", {});
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
  world.select(makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true }));

  world.gBrowser.addTab("https://www.reddit.com/r/zen/comments/1abc/some_title/", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "a post opens as a Glance");

  world.setOverlay(false);
  world.gBrowser.addTab("https://www.reddit.com/r/zen/", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "a subreddit listing stays a tab");

  world.gBrowser.addTab("https://www.reddit.com/", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "the front page stays a tab");

  world.gBrowser.addTab("https://www.reddit.com/settings/profile", {});
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
  world.select(makeTab("normal", { url: "https://example.org/search" }));

  world.gBrowser.addTab("https://www.reddit.com/r/zen/comments/1abc/title/", {});
  await tick();
  assert.equal(world.openGlanceCalls.length, 1, "a reddit post glances with ordinary tabs off");

  world.setOverlay(false);
  world.gBrowser.addTab("https://www.reddit.com/r/zen/", {});
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

test("Same Domain Only keeps a page in the domain it was opened from", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.samedomain", true);
  const essential = makeTab("essential", {
    attrs: { "zen-essential": "" },
    pinned: true,
    url: "https://www.reddit.com/",
  });
  world.select(essential);

  const same = world.gBrowser.addTab("https://old.reddit.com/r/zen/comments/1abc/t/", {});
  await tick();
  assert.equal(same.getAttribute("zen-glance-tab"), true, "a subdomain is the same domain");

  world.setOverlay(false);
  const other = world.gBrowser.addTab("https://example.org/a", {});
  await tick();
  assert.equal(other.getAttribute("zen-glance-tab"), null, "another domain is refused");
});

test("Same Domain Only leaves a New Tab page free to open anywhere", async () => {
  const world = createWorld();
  world.setPref("zen-glance-plus.samedomain", true);
  const newTab = makeTab("newtab", { attrs: { "zen-newtab-page": "" }, url: "about:newtab" });
  world.select(newTab);

  const tab = world.gBrowser.addTab("https://example.org/a", {});
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
  world.select(makeTab("essential", { attrs: { "zen-essential": "" }, pinned: true }));
  world.setOverlay(true);
  const tab = world.gBrowser.addTab("https://example.org/o", {});
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
  const headings = prefs.filter(entry => entry.type === "separator").map(entry => entry.label);
  assert.deepEqual(headings, ["**Apply to**", "**Glance applies to**", "**Sites**"]);

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

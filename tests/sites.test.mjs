/**
 * Glance Plus — sites, link patterns and the settings table
 *
 * Runs the real `scripts/zen-glance-plus.uc.js` in a Node VM with a small DOM
 * of the same shape the settings page gives it, and checks the site list from
 * storage to the rendered table and back.
 *
 *   node tests/sites.test.mjs scripts/zen-glance-plus.uc.js
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

/* ------------------------------------------------------------- a small DOM */

const matches = (node, selector) => {
  if (selector.startsWith("#")) {
    return node.id === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    const wanted = selector.slice(1);
    return (node.getAttribute("class") ?? "").split(/\s+/).includes(wanted);
  }
  const attribute = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/i);
  if (attribute) {
    if (!node.hasAttribute(attribute[1])) {
      return false;
    }
    return attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2];
  }
  return node.tagName === selector.toUpperCase();
};

const walk = (node, predicate, found = []) => {
  for (const child of node.children) {
    if (predicate(child)) {
      found.push(child);
    }
    walk(child, predicate, found);
  }
  return found;
};

function makeElement(tag) {
  const element = {
    tagName: tag.toUpperCase(),
    attributes: new Map(),
    children: [],
    parentNode: null,
    textContent: "",
    checked: false,
    value: "",
    id: "",
    focused: false,
    listeners: new Map(),
    get firstChild() {
      return element.children[0] ?? null;
    },
    setAttribute(name, value) {
      element.attributes.set(name, String(value));
      if (name === "checked") {
        element.checked = true;
      }
    },
    getAttribute(name) {
      return element.attributes.has(name) ? element.attributes.get(name) : null;
    },
    hasAttribute(name) {
      return element.attributes.has(name);
    },
    removeAttribute(name) {
      element.attributes.delete(name);
    },
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index >= 0) {
        element.children.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    },
    insertBefore(newNode, reference) {
      const index = element.children.indexOf(reference);
      newNode.parentNode = element;
      if (index < 0) {
        element.children.push(newNode);
      } else {
        element.children.splice(index, 0, newNode);
      }
      return newNode;
    },
    after(node) {
      const parent = element.parentNode;
      if (!parent) {
        return;
      }
      const index = parent.children.indexOf(element);
      node.parentNode = parent;
      parent.children.splice(index + 1, 0, node);
    },
    addEventListener(type, handler) {
      if (!element.listeners.has(type)) {
        element.listeners.set(type, []);
      }
      element.listeners.get(type).push(handler);
    },
    closest(selector) {
      let node = element;
      while (node) {
        if (matches(node, selector)) {
          return node;
        }
        node = node.parentNode;
      }
      return null;
    },
    querySelector(selector) {
      return walk(element, node => matches(node, selector))[0] ?? null;
    },
    querySelectorAll(selector) {
      return walk(element, node => matches(node, selector));
    },
    append(...nodes) {
      nodes.forEach(node => element.appendChild(node));
    },
    focus() {
      element.focused = true;
    },
  };
  return element;
}

function createDocument() {
  const root = makeElement("html");
  const doc = {
    documentElement: root,
    readyState: "complete",
    createElementNS: (namespace, tag) => makeElement(tag),
    getElementById(id) {
      return walk(root, node => node.id === id)[0] ?? null;
    },
    querySelector(selector) {
      return walk(root, node => matches(node, selector))[0] ?? null;
    },
    querySelectorAll(selector) {
      return walk(root, node => matches(node, selector));
    },
  };
  return doc;
}

/* ---------------------------------------------------------------- the world */

function createWorld({ domains = [], prefs = {}, fresh = false } = {}) {
  const prefMap = new Map([
    ["zen-glance-plus.essential", true],
    ["zen-glance-plus.pinned", true],
    ["zen-glance-plus.normal", false],
    ["zen-glance-plus.newtab", true],
    ["zen-glance-plus.redirect", false],
    ["zen-glance-plus.domains", JSON.stringify(domains)],
    ...Object.entries(prefs),
  ]);
  if (fresh) {
    // A profile where the domains pref was never written.
    prefMap.delete("zen-glance-plus.domains");
  }

  const document = createDocument();
  const windowListeners = new Map();
  const sheetCalls = [];

  const windowObject = {
    innerWidth: 1200,
    innerHeight: 800,
    document,
    windowUtils: {
      AUTHOR_SHEET: 2,
      loadSheetUsingURIString: (url, type) => sheetCalls.push({ url, type }),
    },
    addEventListener: (type, handler) => windowListeners.set(type, handler),
    setTimeout: handler => {
      handler();
      return 1;
    },
  };

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
    Number,
    Math,
    JSON,
    setTimeout: handler => {
      handler();
      return 1;
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
      scriptSecurityManager: { getSystemPrincipal: () => ({ isSystemPrincipal: true }) },
    },
    document,
    window: windowObject,
  };

  vm.runInContext(source, vm.createContext(sandbox), { filename: scriptPath });

  const stored = () => JSON.parse(prefMap.get("zen-glance-plus.domains") ?? "[]");
  const withAnchor = () => {
    const anchor = document.createElementNS("http://www.w3.org/1999/xhtml", "vbox");
    anchor.id = "zen-glance-plus-domains";
    document.documentElement.appendChild(anchor);
    windowObject.__zenGlancePlus.injectTable(windowObject);
    return document.getElementById("zen-glance-plus-domains-table");
  };

  return {
    api: windowObject.__zenGlancePlus,
    window: windowObject,
    document,
    stored,
    withAnchor,
    sheetCalls,
    setPref: (name, value) => prefMap.set(name, value),
  };
}

/* ------------------------------------------------------------------ tests */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("a pasted address is reduced to its site", () => {
  const { api } = createWorld();
  assert.equal(api.normaliseDomain("https://old.reddit.com/r/zen/comments/1"), "old.reddit.com");
  assert.equal(api.normaliseDomain("WWW.Example.COM"), "example.com");
  assert.equal(api.normaliseDomain("*.example.com"), "example.com");
  assert.equal(api.normaliseDomain("  example.com:8443  "), "example.com");
  assert.equal(api.normaliseDomain("user@example.com/path"), "example.com");
  assert.equal(api.normaliseDomain("localhost"), "localhost");
  assert.equal(api.normaliseDomain(""), null);
  assert.equal(api.normaliseDomain("not a domain"), null);
  assert.equal(api.normaliseDomain("<script>"), null);
});

/* ------------------------------------------------------- shipped defaults */

test("a fresh profile ships the popular sites, configured", () => {
  const world = createWorld({ fresh: true });
  const rules = world.api.readDomains();
  const hosts = rules.map(rule => rule.host);

  assert.equal(rules.length, 6);
  for (const host of ["reddit.com", "x.com", "facebook.com", "youtube.com", "instagram.com", "github.com"]) {
    assert.ok(hosts.includes(host), "missing " + host);
  }
  for (const rule of rules) {
    assert.equal(rule.tabs, true, rule.host + " should glance new tabs");
    assert.equal(rule.links, true, rule.host + " should glance same-tab links");
    assert.ok(rule.paths.length > 0, rule.host + " should be narrowed, not whole-domain");
  }

  // Seeded once into the pref, so the table shows them on first open.
  assert.equal(world.stored().length, 6);

  const reddit = rules.find(rule => rule.host === "reddit.com");
  assert.equal(world.api.linkMatchesRule(reddit, new URL("https://www.reddit.com/r/zen/comments/1abc/title/")), true);
  assert.equal(world.api.linkMatchesRule(reddit, new URL("https://www.reddit.com/r/zen/")), false);
  assert.equal(world.api.linkMatchesRule(reddit, new URL("https://www.reddit.com/")), false);

  const x = rules.find(rule => rule.host === "x.com");
  assert.equal(world.api.linkMatchesRule(x, new URL("https://x.com/someone/status/1234567890")), true);
  assert.equal(world.api.linkMatchesRule(x, new URL("https://x.com/explore")), false);

  const yt = rules.find(rule => rule.host === "youtube.com");
  assert.equal(world.api.linkMatchesRule(yt, new URL("https://www.youtube.com/watch?v=abc")), true);
  assert.equal(world.api.linkMatchesRule(yt, new URL("https://www.youtube.com/shorts/abc")), true);
  assert.equal(world.api.linkMatchesRule(yt, new URL("https://www.youtube.com/feed/subscriptions")), false);
});

test("an emptied list is not refilled", () => {
  const world = createWorld({ domains: [] });
  assert.equal(world.api.readDomains().length, 0);
});

test("a stored list is never replaced by the defaults", () => {
  const world = createWorld({ domains: [{ host: "example.com", tabs: false, links: true, paths: [] }] });
  const rules = world.api.readDomains();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].host, "example.com");
  assert.equal(rules[0].tabs, false);
});

test("the site and remove controls are spans the settings page cannot restyle", () => {
  const world = createWorld({ domains: [{ host: "example.com", tabs: true, links: false, paths: [] }] });
  const table = world.withAnchor();
  const site = table.querySelector(".zgp-site");
  const remove = table.querySelector(".zgp-remove");

  assert.equal(site.tagName.toLowerCase(), "span");
  assert.equal(remove.tagName.toLowerCase(), "span");
  assert.equal(site.getAttribute("role"), "button");
  assert.equal(site.getAttribute("tabindex"), "0");
  assert.equal(remove.getAttribute("role"), "button");
  assert.equal(remove.getAttribute("tabindex"), "0");
});

test("Space opens a row, as a button would", () => {
  const world = createWorld({ domains: [{ host: "example.com", tabs: true, links: false, paths: [] }] });
  const table = world.withAnchor();
  const site = table.querySelector(".zgp-site");
  assert.equal(site.getAttribute("aria-expanded"), "false");

  world.api.onTableKeydown(world.window, { key: " ", target: site, preventDefault() {} });
  const again = table.querySelector(".zgp-site");
  assert.equal(again.getAttribute("aria-expanded"), "true");
});

test("Space removes the row it belongs to", () => {
  const world = createWorld({
    domains: [
      { host: "example.com", tabs: true, links: false, paths: [] },
      { host: "other.test", tabs: true, links: false, paths: [] },
    ],
  });
  const table = world.withAnchor();
  const remove = table.querySelector(".zgp-remove");
  world.api.onTableKeydown(world.window, { key: " ", target: remove, preventDefault() {} });

  assert.equal(world.stored().length, 1);
  assert.equal(world.stored()[0].host, "other.test");
});

test("the table finds its place from the Sites heading when the id is gone", () => {
  const world = createWorld({ domains: [{ host: "example.com", tabs: true, links: false, paths: [] }] });
  const ns = "http://www.w3.org/1999/xhtml";
  const row = world.document.createElementNS(ns, "vbox");
  const label = world.document.createElementNS(ns, "label");
  label.setAttribute("class", "separator-label");
  label.textContent = "Sites";
  row.appendChild(label);
  world.document.documentElement.appendChild(row);

  assert.equal(world.api.injectTable(world.window), true);

  const table = world.document.getElementById("zen-glance-plus-domains-table");
  assert.ok(table, "the table should be drawn without the id anchor");
  const siblings = row.parentNode.children;
  assert.equal(siblings[siblings.indexOf(row) + 1], table, "it belongs right after the Sites row");
});

test("the table falls back to the dialog that holds the rows", () => {
  const world = createWorld({ domains: [{ host: "example.com", tabs: true, links: false, paths: [] }] });
  const ns = "http://www.w3.org/1999/xhtml";
  const container = world.document.createElementNS(ns, "div");
  container.id = "sineItemPreferenceDialogContent";
  world.document.documentElement.appendChild(container);

  assert.equal(world.api.injectTable(world.window), true);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].id, "zen-glance-plus-domains-table");
});

/* --------------------------------------------------------- link patterns */

test("a link pattern keeps only the path, and matches from the root", () => {
  const { api } = createWorld();
  assert.equal(api.normalisePathPattern("/r/*/comments/*"), "/r/*/comments/*");
  assert.equal(
    api.normalisePathPattern("https://www.reddit.com/r/zen/comments/*"),
    "/r/zen/comments/*"
  );
  assert.equal(api.normalisePathPattern("comments/*"), "*comments/*");
  assert.equal(api.normalisePathPattern("  /watch  "), "/watch");
  assert.equal(api.normalisePathPattern(""), null);
  assert.equal(api.normalisePathPattern("*"), null);
});

test("a wildcard spans slashes and a pattern is anchored", () => {
  const { api } = createWorld();
  assert.equal(api.pathMatches("/r/*/comments/*", "/r/zen/comments/abc/title/"), true);
  assert.equal(api.pathMatches("*/comments/*", "/comments/abc"), true);
  assert.equal(api.pathMatches("/r/*/comments/*", "/r/zen/"), false);
  assert.equal(api.pathMatches("/watch", "/watch?v=1"), false);
  assert.equal(api.pathMatches("/watch?*", "/watch?v=1"), true);
  assert.equal(api.pathMatches("/a.b", "/axb"), false);
});

test("a row without patterns answers for every link", () => {
  const { api } = createWorld();
  assert.equal(api.linkMatchesRule({ paths: [] }, "https://reddit.com/r/zen/"), true);
  assert.equal(api.linkMatchesRule({}, "https://reddit.com/"), true);
});

test("a row with patterns answers only for the links that match one", () => {
  const { api } = createWorld();
  const rule = { paths: ["/r/*/comments/*", "*/comments/*"] };
  assert.equal(api.linkMatchesRule(rule, "https://www.reddit.com/r/zen/comments/1abc/x/"), true);
  assert.equal(api.linkMatchesRule(rule, "https://www.reddit.com/comments/1abc"), true);
  assert.equal(api.linkMatchesRule(rule, "https://www.reddit.com/r/zen/"), false);
  assert.equal(api.linkMatchesRule(rule, "https://www.reddit.com/"), false);
  assert.equal(api.linkMatchesRule(rule, "https://www.reddit.com/user/someone"), false);
});

test("patterns survive storage and junk is dropped", () => {
  const { api } = createWorld({
    domains: [
      {
        host: "reddit.com",
        tabs: true,
        links: true,
        paths: ["/r/*/comments/*", "  ", 7, "comments/*", "/r/*/comments/*"],
      },
      { host: "plain.example" },
    ],
  });
  const rules = api.readDomains();
  assert.equal(JSON.stringify(rules[0].paths), JSON.stringify(["/r/*/comments/*", "*comments/*"]));
  assert.equal(rules[1].paths.length, 0);
});

test("the stored pref survives junk and keeps its flags", () => {
  const { api } = createWorld({
    domains: [
      { host: "reddit.com", tabs: true, links: true },
      { host: "news.ycombinator.com", tabs: false },
      { host: "REDDIT.com" },
      { host: "" },
      "nonsense",
    ],
  });
  const rules = api.readDomains();
  assert.equal(rules.length, 2);
  assert.equal(rules[0].host, "reddit.com");
  assert.equal(rules[0].links, true);
  assert.equal(rules[1].host, "news.ycombinator.com");
  assert.equal(rules[1].tabs, false);
  assert.equal(rules[1].links, false);

  assert.equal(api.parseDomains("{ not json").length, 0);
  assert.equal(api.parseDomains("null").length, 0);
});

test("a row claims its domain and everything under it", () => {
  const { api } = createWorld({ domains: [{ host: "reddit.com", tabs: true, links: false }] });
  assert.equal(api.domainRuleFor("https://reddit.com/r/x").host, "reddit.com");
  assert.equal(api.domainRuleFor("https://old.reddit.com/comments/1").host, "reddit.com");
  assert.equal(api.domainRuleFor("https://notreddit.com/"), null);
  assert.equal(api.domainRuleFor("https://reddit.com.evil.test/"), null);
});

test("adding a site writes it with new tabs on, same tab off, no patterns", () => {
  const world = createWorld();
  const next = world.api.addDomain("https://www.example.com/some/page");
  assert.equal(next.length, 1);
  assert.deepEqual(world.stored(), [
    { host: "example.com", tabs: true, links: false, paths: [] },
  ]);
});

test("a duplicate, a blank and a nonsense site are refused", () => {
  const world = createWorld({ domains: [{ host: "example.com" }] });
  assert.equal(world.api.addDomain("example.com"), null);
  assert.equal(world.api.addDomain("   "), null);
  assert.equal(world.api.addDomain("<b>x</b>"), null);
  assert.equal(world.stored().length, 1);
});

test("a flag is flipped on one row and leaves the others alone", () => {
  const world = createWorld({
    domains: [
      { host: "a.example", tabs: true, links: false },
      { host: "b.example", tabs: true, links: false },
    ],
  });
  world.api.setDomainFlag(1, "links", true);
  assert.deepEqual(world.stored(), [
    { host: "a.example", tabs: true, links: false, paths: [] },
    { host: "b.example", tabs: true, links: true, paths: [] },
  ]);
  assert.equal(world.api.setDomainFlag(5, "links", true), null);
  assert.equal(world.api.setDomainFlag(0, "other", true), null);
});

test("adding and removing a pattern touches one row only", () => {
  const world = createWorld({
    domains: [
      { host: "a.example", tabs: true, links: false, paths: [] },
      { host: "b.example", tabs: true, links: false, paths: [] },
    ],
  });
  world.api.addPath(1, "https://b.example/thing/*");
  assert.deepEqual(world.stored()[1].paths, ["/thing/*"]);
  assert.deepEqual(world.stored()[0].paths, []);

  world.api.addPath(1, "other/*");
  assert.deepEqual(world.stored()[1].paths, ["/thing/*", "*other/*"]);
  assert.equal(world.api.addPath(1, "other/*"), null, "a duplicate pattern is refused");
  assert.equal(world.api.addPath(9, "/x/*"), null);

  world.api.removePath(1, 0);
  assert.deepEqual(world.stored()[1].paths, ["*other/*"]);
  assert.equal(world.api.removePath(1, 5), null);
});

test("removing a row drops exactly that row", () => {
  const world = createWorld({
    domains: [
      { host: "a.example" },
      { host: "b.example" },
      { host: "c.example" },
    ],
  });
  world.api.removeDomain(1);
  assert.deepEqual(
    world.stored().map(rule => rule.host),
    ["a.example", "c.example"]
  );
  assert.equal(world.api.removeDomain(9), null);
});

/* ----------------------------------------------------------- the table */

test("the table renders a row per site with its two switches", () => {
  const world = createWorld({
    domains: [
      { host: "reddit.com", tabs: true, links: false },
      { host: "news.ycombinator.com", tabs: false, links: true },
    ],
  });
  const table = world.api.buildTable(world.document, world.api.readDomains());
  assert.equal(table.id, "zen-glance-plus-domains-table");

  const rows = table.querySelectorAll(".zgp-row");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector(".zgp-site-name").textContent, "reddit.com");

  const boxes = rows[0].querySelectorAll("input");
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].getAttribute("data-act"), "links");
  assert.equal(boxes[0].checked, false);
  assert.equal(boxes[0].getAttribute("aria-label"), "Links on reddit.com");
  assert.equal(boxes[1].getAttribute("data-act"), "tabs");
  assert.equal(boxes[1].checked, true);
  assert.equal(boxes[1].getAttribute("aria-label"), "New tabs on reddit.com");

  const second = rows[1].querySelectorAll("input");
  assert.equal(second[0].getAttribute("data-act"), "links");
  assert.equal(second[0].checked, true);
  assert.equal(second[1].getAttribute("data-act"), "tabs");
  assert.equal(second[1].checked, false);

  const heads = table.querySelector(".zgp-head").querySelectorAll(".zgp-headcell");
  assert.deepEqual(
    heads.map(cell => cell.textContent),
    ["Site", "Link", "New tabs", ""]
  );
  assert.equal(table.querySelector(".zgp-empty").hasAttribute("hidden"), true);
});

test("an empty table says so and offers the field", () => {
  const world = createWorld();
  const table = world.api.buildTable(world.document, []);
  assert.equal(table.querySelectorAll(".zgp-row").length, 0);
  assert.equal(table.querySelector(".zgp-empty").hasAttribute("hidden"), false);
  assert.equal(table.querySelector(".zgp-siteinput").getAttribute("placeholder"), "example.com");
});

test("a stored site cannot become markup", () => {
  const world = createWorld();
  const table = world.api.buildTable(world.document, [
    { host: '<img src=x onerror="alert(1)">', tabs: true, links: false, paths: [] },
  ]);
  const site = table.querySelector(".zgp-site-name");
  assert.equal(site.textContent, '<img src=x onerror="alert(1)">');
  assert.equal(site.children.length, 0);
});

test("a row with patterns shows a count and keeps its editor shut", () => {
  const world = createWorld({
    domains: [
      { host: "reddit.com", tabs: true, links: false, paths: ["/r/*/comments/*"] },
      { host: "example.com", tabs: true, links: false, paths: ["/a", "/b"] },
    ],
  });
  const table = world.api.buildTable(world.document, world.api.readDomains());
  const entries = table.querySelectorAll(".zgp-entry");
  assert.equal(entries.length, 2);

  assert.equal(entries[0].querySelector(".zgp-badge").textContent, "1 link");
  assert.equal(entries[1].querySelector(".zgp-badge").textContent, "2 links");
  assert.equal(entries[0].querySelector(".zgp-paths").hasAttribute("hidden"), true);
  assert.equal(entries[0].querySelector(".zgp-site").getAttribute("aria-expanded"), "false");
  assert.equal(
    entries[0].querySelector(".zgp-site").getAttribute("title"),
    "/r/*/comments/*"
  );
});

test("a row without patterns offers the editor with an any-link note", () => {
  const world = createWorld({ domains: [{ host: "example.com" }] });
  const table = world.api.buildTable(world.document, world.api.readDomains());
  const entry = table.querySelector(".zgp-entry");
  assert.equal(entry.querySelector(".zgp-badge"), null);
  assert.equal(entry.querySelector(".zgp-anylink").hasAttribute("hidden"), false);
  assert.equal(entry.querySelector(".zgp-anylink").textContent, "Any link on this site");
  assert.equal(entry.querySelector(".zgp-pathinput").getAttribute("placeholder"), "/r/*/comments/*");
});

test("clicking the site name opens and closes its patterns", () => {
  const world = createWorld({ domains: [{ host: "reddit.com" }] });
  const table = world.withAnchor();

  world.api.onTableClick(world.window, { target: table.querySelector(".zgp-site") });
  let entry = world.document.querySelector(".zgp-entry");
  assert.equal(entry.querySelector(".zgp-paths").hasAttribute("hidden"), false);
  assert.equal(entry.querySelector(".zgp-site").getAttribute("aria-expanded"), "true");

  world.api.onTableClick(world.window, { target: entry.querySelector(".zgp-site") });
  entry = world.document.querySelector(".zgp-entry");
  assert.equal(entry.querySelector(".zgp-paths").hasAttribute("hidden"), true);
});

test("a pattern typed under a row is saved and shown as a chip", () => {
  const world = createWorld({ domains: [{ host: "reddit.com" }] });
  const table = world.withAnchor();
  world.api.onTableClick(world.window, { target: table.querySelector(".zgp-site") });

  let entry = world.document.querySelector(".zgp-entry");
  const input = entry.querySelector(".zgp-pathinput");
  input.value = "https://www.reddit.com/r/*/comments/*";
  world.api.onTableClick(world.window, { target: entry.querySelector('[data-act="addpath"]') });

  assert.deepEqual(world.stored()[0].paths, ["/r/*/comments/*"]);
  entry = world.document.querySelector(".zgp-entry");
  assert.equal(entry.querySelector(".zgp-chip-text").textContent, "/r/*/comments/*");
  assert.equal(entry.querySelector(".zgp-badge").textContent, "1 link");
  assert.equal(entry.querySelector(".zgp-anylink").hasAttribute("hidden"), true);
  assert.equal(entry.querySelector(".zgp-paths").hasAttribute("hidden"), false);
});

test("Enter in a pattern field adds the pattern", () => {
  const world = createWorld({ domains: [{ host: "reddit.com" }] });
  const table = world.withAnchor();
  world.api.onTableClick(world.window, { target: table.querySelector(".zgp-site") });

  const entry = world.document.querySelector(".zgp-entry");
  const input = entry.querySelector(".zgp-pathinput");
  input.value = "comments/*";
  let prevented = false;

  world.api.onTableKeydown(world.window, {
    key: "Enter",
    target: input,
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(world.stored()[0].paths, ["*comments/*"]);
});

test("a chip's × drops only that pattern", () => {
  const world = createWorld({
    domains: [{ host: "reddit.com", paths: ["/a/*", "/b/*"] }],
  });
  const table = world.withAnchor();
  world.api.onTableClick(world.window, { target: table.querySelector(".zgp-site") });

  const firstChip = world.document.querySelectorAll(".zgp-chip")[0];
  world.api.onTableClick(world.window, { target: firstChip.querySelector(".zgp-chip-remove") });

  assert.deepEqual(world.stored()[0].paths, ["/b/*"]);
  assert.equal(world.document.querySelectorAll(".zgp-chip").length, 1);
});

test("the table is placed under its heading and styled once", () => {
  const world = createWorld();
  const table = world.withAnchor();
  assert.ok(table);
  assert.equal(table.parentNode, world.document.documentElement);
  assert.equal(world.sheetCalls.length, 1);
  assert.match(world.sheetCalls[0].url, /domains\.css$/);

  // A second call must not add a second table or a second sheet.
  assert.equal(world.api.injectTable(world.window), false);
  assert.equal(world.document.querySelectorAll(".zgp-table").length, 1);
  assert.equal(world.sheetCalls.length, 1);
});

test("nothing is injected when the heading is not there", () => {
  const world = createWorld();
  assert.equal(world.api.injectTable(world.window), false);
  assert.equal(world.document.getElementById("zen-glance-plus-domains-table"), null);
});

test("the Add button stores the typed site and clears the field", () => {
  const world = createWorld();
  const table = world.withAnchor();
  const input = table.querySelector(".zgp-siteinput");
  input.value = "https://www.youtube.com/watch?v=abc";
  const add = table.querySelector('[data-act="add"]');
  world.api.onTableClick(world.window, { target: add });

  assert.deepEqual(world.stored(), [
    { host: "youtube.com", tabs: true, links: false, paths: [] },
  ]);
  assert.equal(table.querySelectorAll(".zgp-row").length, 1);
  assert.equal(input.value, "");
  assert.equal(input.focused, true);
});

test("Enter in the site field adds the site too", () => {
  const world = createWorld();
  const table = world.withAnchor();
  const input = table.querySelector(".zgp-siteinput");
  input.value = "example.com";
  let prevented = false;

  world.api.onTableKeydown(world.window, {
    key: "Enter",
    target: input,
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(world.stored()[0].host, "example.com");
});

test("a switch in the table saves immediately", () => {
  const world = createWorld({ domains: [{ host: "example.com", tabs: true, links: false }] });
  const table = world.withAnchor();
  const linksBox = table
    .querySelectorAll(".zgp-row")[0]
    .querySelectorAll("input")
    .find(box => box.getAttribute("data-act") === "links");
  linksBox.checked = true;
  world.api.onTableChange(world.window, { target: linksBox });

  assert.deepEqual(world.stored(), [
    { host: "example.com", tabs: true, links: true, paths: [] },
  ]);
});

test("the remove button drops its row", () => {
  const world = createWorld({
    domains: [{ host: "a.example" }, { host: "b.example" }],
  });
  const table = world.withAnchor();
  world.api.onTableClick(world.window, { target: table.querySelectorAll(".zgp-remove")[0] });

  assert.deepEqual(
    world.stored().map(rule => rule.host),
    ["b.example"]
  );
  assert.equal(table.querySelectorAll(".zgp-row").length, 1);
});

test("the shipped preferences carry the heading the table hangs under", () => {
  const prefs = JSON.parse(fs.readFileSync(path.join(repoRoot, "preferences.json"), "utf8"));
  const heading = prefs.find(entry => entry.id === "zen-glance-plus-domains");
  assert.ok(heading, "the Sites heading is declared");
  assert.equal(heading.type, "separator");
  assert.equal(heading.label, "**Sites**");

  const { api } = createWorld();
  assert.equal(api.UI_ANCHOR, heading.id);
});

test("the shipped stylesheet styles the table and its pattern editor", () => {
  const css = fs.readFileSync(path.join(repoRoot, "styles", "domains.css"), "utf8");
  for (const selector of [".zgp-row", ".zgp-site", ".zgp-badge", ".zgp-paths", ".zgp-chip"]) {
    assert.ok(css.includes(selector), `${selector} is styled`);
  }
  assert.ok(css.includes("#zen-glance-plus-domains-table"));
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

console.log(`\n${selected.length - failed}/${selected.length} passed (sites)`);
process.exit(failed ? 1 : 0);

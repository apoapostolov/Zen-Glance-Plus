/**
 * Zen Glance Plus — sites and settings table
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

function createWorld({ domains = [], prefs = {} } = {}) {
  const prefMap = new Map([
    ["zen-glance-plus.essential", true],
    ["zen-glance-plus.pinned", true],
    ["zen-glance-plus.normal", false],
    ["zen-glance-plus.newtab", true],
    ["zen-glance-plus.redirect", false],
    ["zen-glance-plus.domains", JSON.stringify(domains)],
    ...Object.entries(prefs),
  ]);

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
      },
      scriptSecurityManager: { getSystemPrincipal: () => ({ isSystemPrincipal: true }) },
    },
    document,
    window: windowObject,
  };

  vm.runInContext(source, vm.createContext(sandbox), { filename: scriptPath });

  const stored = () => JSON.parse(prefMap.get("zen-glance-plus.domains") ?? "[]");

  return {
    api: windowObject.__zenGlancePlus,
    window: windowObject,
    document,
    stored,
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

test("adding a site writes it with new tabs on and same tab off", () => {
  const world = createWorld();
  const next = world.api.addDomain("https://www.example.com/some/page");
  assert.equal(next.length, 1);
  assert.deepEqual(world.stored(), [{ host: "example.com", tabs: true, links: false }]);
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
    { host: "a.example", tabs: true, links: false },
    { host: "b.example", tabs: true, links: true },
  ]);
  assert.equal(world.api.setDomainFlag(5, "links", true), null);
  assert.equal(world.api.setDomainFlag(0, "other", true), null);
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
  assert.equal(rows[0].querySelector(".zgp-site").textContent, "reddit.com");

  const boxes = rows[0].querySelectorAll("input");
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].getAttribute("data-act"), "tabs");
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].getAttribute("data-act"), "links");
  assert.equal(boxes[1].checked, false);
  assert.equal(boxes[1].getAttribute("aria-label"), "Same tab links on reddit.com");

  assert.equal(rows[1].querySelectorAll("input")[0].checked, false);
  assert.equal(rows[1].querySelectorAll("input")[1].checked, true);

  const heads = table.querySelector(".zgp-head").querySelectorAll(".zgp-headcell");
  assert.deepEqual(
    heads.map(cell => cell.textContent),
    ["Site", "New tabs", "Same tab", ""]
  );
  assert.equal(table.querySelector(".zgp-empty").hasAttribute("hidden"), true);
});

test("an empty table says so and offers the field", () => {
  const world = createWorld();
  const table = world.api.buildTable(world.document, []);
  assert.equal(table.querySelectorAll(".zgp-row").length, 0);
  assert.equal(table.querySelector(".zgp-empty").hasAttribute("hidden"), false);
  assert.equal(table.querySelector(".zgp-input").getAttribute("placeholder"), "example.com");
});

test("a stored site cannot become markup", () => {
  const world = createWorld();
  const table = world.api.buildTable(world.document, [
    { host: '<img src=x onerror="alert(1)">', tabs: true, links: false },
  ]);
  const site = table.querySelector(".zgp-site");
  assert.equal(site.textContent, '<img src=x onerror="alert(1)">');
  assert.equal(site.children.length, 0);
});

test("the table is placed under its heading and styled once", () => {
  const world = createWorld();
  const anchor = world.document.createElementNS("http://www.w3.org/1999/xhtml", "vbox");
  anchor.id = "zen-glance-plus-domains";
  world.document.documentElement.appendChild(anchor);

  assert.equal(world.api.injectTable(world.window), true);
  const table = world.document.getElementById("zen-glance-plus-domains-table");
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
  const anchor = world.document.createElementNS("http://www.w3.org/1999/xhtml", "vbox");
  anchor.id = "zen-glance-plus-domains";
  world.document.documentElement.appendChild(anchor);
  world.api.injectTable(world.window);

  const table = world.document.getElementById("zen-glance-plus-domains-table");
  const input = table.querySelector(".zgp-input");
  input.value = "https://www.youtube.com/watch?v=abc";
  const add = table.querySelector(".zgp-addbutton");

  world.api.onTableClick(world.window, { target: add });

  assert.deepEqual(world.stored(), [{ host: "youtube.com", tabs: true, links: false }]);
  assert.equal(table.querySelectorAll(".zgp-row").length, 1);
  assert.equal(input.value, "");
  assert.equal(input.focused, true);
});

test("Enter in the field adds the site too", () => {
  const world = createWorld();
  const anchor = world.document.createElementNS("http://www.w3.org/1999/xhtml", "vbox");
  anchor.id = "zen-glance-plus-domains";
  world.document.documentElement.appendChild(anchor);
  world.api.injectTable(world.window);

  const table = world.document.getElementById("zen-glance-plus-domains-table");
  const input = table.querySelector(".zgp-input");
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
  const anchor = world.document.createElementNS("http://www.w3.org/1999/xhtml", "vbox");
  anchor.id = "zen-glance-plus-domains";
  world.document.documentElement.appendChild(anchor);
  world.api.injectTable(world.window);

  const table = world.document.getElementById("zen-glance-plus-domains-table");
  const row = table.querySelector(".zgp-row");
  const linksBox = row.querySelectorAll("input")[1];
  linksBox.checked = true;

  world.api.onTableChange(world.window, { target: linksBox });

  assert.deepEqual(world.stored(), [{ host: "example.com", tabs: true, links: true }]);
});

test("the remove button drops its row", () => {
  const world = createWorld({
    domains: [
      { host: "a.example" },
      { host: "b.example" },
    ],
  });
  const anchor = world.document.createElementNS("http://www.w3.org/1999/xhtml", "vbox");
  anchor.id = "zen-glance-plus-domains";
  world.document.documentElement.appendChild(anchor);
  world.api.injectTable(world.window);

  const table = world.document.getElementById("zen-glance-plus-domains-table");
  const remove = table.querySelectorAll(".zgp-remove")[0];
  world.api.onTableClick(world.window, { target: remove });

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

test("the shipped stylesheet exists and styles the table it is loaded for", () => {
  const css = fs.readFileSync(path.join(repoRoot, "styles", "domains.css"), "utf8");
  assert.ok(css.includes("#zen-glance-plus-domains-table"));
  assert.ok(css.includes(".zgp-row"));
  assert.ok(css.includes(".zgp-input"));
  assert.ok(css.includes(".zgp-remove"));
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

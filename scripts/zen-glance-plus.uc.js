/**
 * Glance Plus — Zen Browser mod
 * https://github.com/apoapostolov/Zen-Glance-Plus
 * License: MIT
 *
 * Every new tab a site asks for becomes a Glance. Two layers decide:
 *
 *   1. A table of sites, where one row turns Glance on for that domain's new
 *      tabs and, separately, for links that would replace the tab you are on.
 *   2. Five switches by kind of tab, for every site without a row: opened from
 *      an essential, a pinned tab, an ordinary tab or a New Tab page.
 *
 * Stock Zen opens a Glance only for a gesture (a modifier click), for a
 * bookmark or search result with the modifier held, and automatically only for
 * links that leave an essential tab and cross a domain boundary.
 *
 * The tab seam is `gBrowser.addTab`: it is the one function every tab-opening
 * path in the browser window reaches, and it carries the address. The `TabOpen`
 * event does not, because it fires before the browser begins loading, when the
 * tab still holds about:blank.
 */

(() => {
  "use strict";

  const PREF_ROOT = "zen-glance-plus.";
  const LOG = "[zen-glance-plus]";

  /**
   * A line in <profile>/zen-glance-plus.log, so a browser that will not talk to
   * a console can still be asked what it did. Best effort: no PathUtils or
   * IOUtils (the test harness) and the call is a no-op.
   */
  let traceBudget = 80;
  let traceApis = null;
  let traceQueue = Promise.resolve();
  function traceModules() {
    if (traceApis) {
      return traceApis;
    }
    let paths = typeof PathUtils !== "undefined" ? PathUtils : null;
    let io = typeof IOUtils !== "undefined" ? IOUtils : null;
    if (!paths || !io) {
      try {
        paths = ChromeUtils.importESModule("resource://gre/modules/PathUtils.sys.mjs").PathUtils;
        io = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils;
      } catch (e) {
        return null;
      }
    }
    traceApis = paths && io ? { paths, io } : null;
    return traceApis;
  }

  function trace(message) {
    try {
      if (traceBudget-- <= 0) {
        return;
      }
      const apis = traceModules();
      if (!apis) {
        return;
      }
      const file = apis.paths.join(apis.paths.profileDir, "zen-glance-plus.log");
      const line = `${new Date().toISOString()} ${message}`;
      // One write at a time: two traces in the same tick used to read the same
      // file and the second write dropped the first line.
      traceQueue = traceQueue
        .then(() => apis.io.readUTF8(file).catch(() => ""))
        .then(existing => {
          const kept = existing.length > 48000 ? existing.slice(-24000) : existing;
          return apis.io.writeUTF8(file, `${kept}${line}\n`);
        })
        .catch(() => {});
    } catch (e) {
      // A log is never worth breaking the browser over.
    }
  }

  // Printed before anything else so a probe can tell a script that never
  // loaded from one that loaded and then declined to start.
  console.info(LOG, "script loaded in", String(window.location?.href || "?"));
  trace(`load in ${String(window.location?.href || "?")}`);
  /**
   * Sites that ship configured. Only used when the domains pref has never
   * been written, so a list emptied by hand stays empty.
   */
  const DEFAULT_SITES = [
    { host: "reddit.com", tabs: true, links: true, paths: ["*/comments/*"] },
    { host: "x.com", tabs: true, links: true, paths: ["*/status/*"] },
    { host: "facebook.com", tabs: true, links: true, paths: ["*/posts/*", "/permalink.php*", "/photo.php*"] },
    { host: "youtube.com", tabs: true, links: true, paths: ["/watch*", "/shorts/*"] },
    { host: "instagram.com", tabs: true, links: true, paths: ["/p/*", "/reel/*"] },
    { host: "github.com", tabs: true, links: true, paths: ["*/issues/*", "*/pull/*", "*/discussions/*"] },
  ];

  const PREF = {
    essential: PREF_ROOT + "essential",
    pinned: PREF_ROOT + "pinned",
    normal: PREF_ROOT + "normal",
    newtab: PREF_ROOT + "newtab",
    redirect: PREF_ROOT + "redirect",
    domains: PREF_ROOT + "domains",
  };

  const DEFAULTS = {
    essential: true,
    pinned: true,
    normal: false,
    newtab: true,
    redirect: false,
  };

  const GLANCEABLE_SCHEMES = ["http", "https", "file"];
  const NEW_TAB_URLS = ["about:newtab", "about:home", "about:blank"];

  const XHTML = "http://www.w3.org/1999/xhtml";
  // The separator in preferences.json that the site table is built under.
  const UI_ANCHOR = "zen-glance-plus-domains";
  const UI_TABLE = "zen-glance-plus-domains-table";

  /* ----------------------------------------------------------- preferences */

  function readPrefBool(name, fallback) {
    try {
      return Services.prefs.getBoolPref(name, fallback);
    } catch (e) {
      return fallback;
    }
  }

  function readPrefString(name, fallback) {
    try {
      return Services.prefs.getStringPref(name, fallback);
    } catch (e) {
      return fallback;
    }
  }

  function setting(name) {
    return readPrefBool(PREF[name], DEFAULTS[name]);
  }

  /* ------------------------------------------------------------- the sites */

  /**
   * A row's site, reduced to a host. A pasted address keeps only its host, a
   * leading `*.` or `www.` comes off, and anything that is not a host is
   * refused rather than stored.
   */
  function normaliseDomain(value) {
    let text = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!text) {
      return null;
    }
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    text = text.split("/")[0].split("?")[0].split("#")[0];
    text = text.split("@").pop();
    text = text.replace(/:\d+$/, "");
    text = text.replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
    if (!text || !/^[a-z0-9.-]+$/.test(text)) {
      return null;
    }
    return text;
  }

  /**
   * A link pattern, reduced to a path glob. A pasted address loses its scheme
   * and host, and a pattern that does not start at the root is anchored
   * anywhere in the path instead.
   */
  function normalisePathPattern(value) {
    let text = String(value ?? "").trim();
    if (!text) {
      return null;
    }
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
    text = text.replace(/\s+/g, "");
    if (!text) {
      return null;
    }
    if (!text.startsWith("/") && !text.startsWith("*")) {
      text = `*${text}`;
    }
    // A lone wildcard means every link, which is what an empty list means.
    return text.length > 1 ? text : null;
  }

  function parsePaths(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const paths = [];
    for (const entry of value) {
      // Only strings: a pref edited by hand can hold anything, and a number
      // must not turn into a pattern nobody typed.
      if (typeof entry !== "string") {
        continue;
      }
      const pattern = normalisePathPattern(entry);
      if (pattern && !paths.includes(pattern)) {
        paths.push(pattern);
      }
    }
    return paths;
  }

  /** The stored pref, in the one shape the rest of the mod reads. */
  function parseDomains(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw ?? "") || "[]");
    } catch (e) {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const rules = [];
    const seen = new Set();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const host = normaliseDomain(entry.host);
      if (!host || seen.has(host)) {
        continue;
      }
      seen.add(host);
      rules.push({
        host,
        tabs: entry.tabs !== false,
        links: entry.links === true,
        paths: parsePaths(entry.paths),
      });
    }
    return rules;
  }

  /** True only while the domains pref has never been written. */
  function domainsPrefIsUnset() {
    try {
      const prefs = Services.prefs;
      if (typeof prefs.getPrefType !== "function") {
        return false;
      }
      return prefs.getPrefType(PREF.domains) === (prefs.PREF_INVALID ?? 0);
    } catch (e) {
      return false;
    }
  }

  function readDomains() {
    if (domainsPrefIsUnset()) {
      const seeded = parseDomains(JSON.stringify(DEFAULT_SITES));
      writeDomains(seeded);
      return seeded;
    }
    return parseDomains(readPrefString(PREF.domains, "[]"));
  }

  function writeDomains(rules) {
    try {
      Services.prefs.setStringPref(PREF.domains, JSON.stringify(rules));
      return true;
    } catch (e) {
      console.error("[zen-glance-plus] could not save the site list", e);
      return false;
    }
  }

  function hostOf(urlString) {
    try {
      return new URL(String(urlString)).hostname.toLowerCase();
    } catch (e) {
      return null;
    }
  }

  /** The first row whose site is this host or a parent of it. */
  function domainRuleFor(urlString, rules) {
    const host = hostOf(urlString);
    if (!host) {
      return null;
    }
    for (const rule of rules ?? readDomains()) {
      if (host === rule.host || host.endsWith(`.${rule.host}`)) {
        return rule;
      }
    }
    return null;
  }

  /** The path and query of an address, which is what a link pattern matches. */
  function pathOf(urlString) {
    try {
      const url = new URL(String(urlString));
      return `${url.pathname}${url.search}`;
    } catch (e) {
      return "";
    }
  }

  function pathMatches(pattern, target) {
    const source = String(pattern)
      .replace(/([.+^${}()|[\]\\?])/g, "\\$1")
      .replace(/\*/g, ".*");
    try {
      return new RegExp(`^${source}$`).test(target);
    } catch (e) {
      return false;
    }
  }

  /**
   * A row with no patterns answers for every link on its site; a row with
   * patterns answers only for the links that match one of them.
   */
  function linkMatchesRule(rule, urlString) {
    if (!rule || !Array.isArray(rule.paths) || rule.paths.length === 0) {
      return true;
    }
    const path = pathOf(urlString);
    if (!path) {
      return false;
    }
    return rule.paths.some(pattern => pathMatches(pattern, path));
  }

  /* --------------------------------------------------------- tab kinds */

  /**
   * Which kind of tab a page was opened from.
   * Essentials are pinned as well, so they are tested first; a New Tab page is
   * an ordinary tab with its own marker, so it is tested before `normal`.
   */
  function sourceKind(tab) {
    if (!tab) {
      return "normal";
    }
    if (tab.hasAttribute?.("zen-essential")) {
      return "essential";
    }
    if (tab.pinned) {
      return "pinned";
    }
    if (tab.hasAttribute?.("zen-empty-tab")) {
      return "newtab";
    }
    const spec = tab.linkedBrowser?.currentURI?.spec;
    if (
      spec &&
      NEW_TAB_URLS.some(
        url => spec === url || spec.startsWith(`${url}#`) || spec.startsWith(`${url}?`)
      )
    ) {
      return "newtab";
    }
    return "normal";
  }

  function shouldGlanceFrom(kind) {
    return Object.prototype.hasOwnProperty.call(DEFAULTS, kind) && setting(kind);
  }

  /* ---------------------------------------------------------------- the tab */

  const state = {
    originalAddTab: null,
    originalOpenLinkIn: null,
    originalOpenTrustedLinkIn: null,
    plan: null,
    lastParent: null,
    started: false,
    progressListener: null,
  };

  function glanceManager() {
    return window.gZenGlanceManager ?? null;
  }

  function isGlanceOpen() {
    if (typeof document.querySelector !== "function") {
      return false;
    }
    return !!(
      gBrowser.selectedTab?.hasAttribute?.("glance-id") ||
      document.querySelector("#tabbrowser-tabpanels .zen-glance-overlay")
    );
  }

  function glanceableUrl(urlString) {
    try {
      const url = new URL(String(urlString));
      return GLANCEABLE_SCHEMES.includes(url.protocol.replace(":", ""))
        ? url.href
        : null;
    } catch (e) {
      return null;
    }
  }

  /** Where the Glance appears to grow out of. */
  function animationRect() {
    const last = glanceManager()?.lastLinkClickData;
    if (last && last.width > 0 && last.height > 0) {
      return {
        clientX: last.clientX,
        clientY: last.clientY,
        width: last.width,
        height: last.height,
      };
    }
    const box =
      gBrowser.tabbox?.getBoundingClientRect?.() ?? {
        width: window.innerWidth || 1,
        height: window.innerHeight || 1,
      };
    // A real height and width keep Zen from substituting its record of the
    // last click, which by now may belong to a different page.
    return {
      clientX: (box.width || 1) / 2,
      clientY: (box.height || 1) / 2,
      width: 1,
      height: 1,
    };
  }

  /**
   * The tab the new one was opened from. `addTab` runs before the new tab is
   * selected, so the current selection is still the page the user was on;
   * `lastParent` only covers a call made after the selection already moved.
   */
  function parentFor(params) {
    if (params?.ownerTab) {
      return params.ownerTab;
    }
    if (params?.openerBrowser) {
      const opened = gBrowser.getTabForBrowser?.(params.openerBrowser);
      if (opened) {
        return opened;
      }
    }
    return gBrowser.selectedTab ?? state.lastParent;
  }

  /**
   * Decide whether this addTab call should end up as a Glance.
   * Returns null when stock behaviour must stand.
   */
  function planFor(uriString, params) {
    if (!readPrefBool("zen.glance.enabled", true)) {
      return null;
    }
    if (!params || params.createLazyBrowser || params.skipLoad) {
      return null;
    }
    if (params.essential || params.pinned) {
      return null;
    }
    // "Open all in tabs" would otherwise turn a folder into a pile of Glances.
    if (params.bulkOrderedOpen) {
      return null;
    }
    const url = glanceableUrl(
      typeof uriString === "string" ? uriString : uriString?.spec
    );
    if (!url) {
      return null;
    }
    const parent = parentFor(params);
    if (!parent) {
      return null;
    }
    const kind = sourceKind(parent);
    // A row for this site answers for its domain, in both directions.
    const rule = domainRuleFor(url);
    if (rule) {
      if (!rule.tabs || !linkMatchesRule(rule, url)) {
        return null;
      }
      return { url, parent, kind, site: rule.host };
    }
    if (!shouldGlanceFrom(kind)) {
      return null;
    }
    return { url, parent, kind };
  }

  const nowMs = () =>
    typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now();

  /**
   * Times a Glance from the decision to paint, and records whether its browser
   * element survived being moved into the parent tab: a replaced browser means
   * the page was loaded twice, which is a fault to fix, not a slow page.
   */
  function watchPaint(tab, url, startedAt = nowMs()) {
    const browser = tab?.linkedBrowser;
    if (!browser || typeof browser.addEventListener !== "function") {
      return;
    }
    let dcl = null;
    let load = null;
    let reported = false;
    const report = reason => {
      if (reported) {
        return;
      }
      reported = true;
      trace(
        `paint ${reason} url=${String(url ?? "").slice(0, 90)} ` +
          `dcl=${dcl ?? "-"} load=${load ?? "-"} ` +
          `swapped=${tab.linkedBrowser !== browser ? "yes" : "no"}`
      );
    };
    const stamp = () => Math.round(nowMs() - startedAt);
    browser.addEventListener("DOMContentLoaded", () => (dcl = stamp()), { once: true, capture: true });
    browser.addEventListener(
      "load",
      () => {
        load = stamp();
        report("load");
      },
      { once: true, capture: true }
    );
    setTimeout(() => report("timeout"), 15000);
  }

  /**
   * A link that opens a new tab from inside a page arrives at addTab as
   * about:blank: the tab is created first and the content loads it itself, so
   * the address never passes through addTab. Zen's own patch of the window's
   * openURI is the only thing that knows the address, and it hands it to
   * shouldOpenTabInGlance along with the tab it created — which is where the
   * rules can answer for those opens as well.
   */
  function contentOpenShouldGlance(tab, uri) {
    const spec = String(uri?.spec ?? uri ?? "");
    if (!spec || tab?.hasAttribute?.("glance-id") || tab?.hasAttribute?.("zen-glance-tab")) {
      return false;
    }
    const parent = tab?.owner ?? null;
    if (!parent) {
      return false;
    }
    const plan = planFor(spec, { ownerTab: parent });
    trace(`content open ${plan ? "glance" : "pass"} ${spec.slice(0, 120)}`);
    if (plan) {
      const startedAt = nowMs();
      // Zen converts the tab itself right after this answer; watch it once it
      // is in place so the timings describe the real open.
      Promise.resolve().then(() => watchPaint(tab, spec, startedAt));
    }
    return Boolean(plan);
  }

  function wrapGlanceManager() {
    const manager = window.gZenGlanceManager;
    if (!manager || typeof manager.shouldOpenTabInGlance !== "function") {
      trace("content opens unavailable: no shouldOpenTabInGlance");
      return;
    }
    if (state.originalShouldGlance) {
      return;
    }
    const original = manager.shouldOpenTabInGlance;
    state.originalShouldGlance = original;
    manager.shouldOpenTabInGlance = function (tab, uri) {
      try {
        if (original.call(this, tab, uri)) {
          return true;
        }
      } catch (e) {
        trace(`native glance check failed ${e?.message ?? e}`);
      }
      try {
        return contentOpenShouldGlance(tab, uri);
      } catch (e) {
        trace(`content open failed ${e?.message ?? e}`);
        return false;
      }
    };
  }

  function openGlanceOver(tab, plan) {
    const manager = glanceManager();
    if (!manager?.openGlance) {
      return;
    }
    if (!tab || tab.closing || tab.hasAttribute?.("zen-glance-tab")) {
      return;
    }
    if (manager._animating) {
      return;
    }
    if (isGlanceOpen()) {
      if (typeof manager.fullyOpenGlance !== "function") {
        return;
      }
      Promise.resolve(manager.fullyOpenGlance())
        .catch(() => {})
        .then(() => new Promise(resolve => setTimeout(resolve, 80)))
        .then(() => {
          if (!isGlanceOpen()) {
            adopt(tab, plan);
          }
        });
      return;
    }
    adopt(tab, plan);
  }

  /**
   * `url: undefined` with an existing tab reuses the tab that was opened, so
   * there is no second tab and no second load. This is the path Zen itself
   * takes for external links opened from an essential.
   */
  function adopt(tab, plan) {
    const manager = glanceManager();
    if (!manager?.openGlance || !tab?.isConnected || tab.closing) {
      return;
    }
    try {
      manager.openGlance(
        { url: undefined, ...animationRect() },
        tab,
        manager.getTabOrGlanceParent?.(plan.parent) ?? plan.parent
      );
      watchPaint(tab, plan.url);
    } catch (e) {
      console.error("[zen-glance-plus] could not open the Glance", e);
    }
  }

  function onTabOpen(event) {
    const tab = event.target;
    const plan = state.plan;
    if (!plan) {
      return;
    }
    // One plan settles one tab. TabOpen is dispatched inside addTab, so the
    // plan on the stack belongs to this tab and to no other.
    state.plan = null;
    if (tab.hasAttribute?.("pending") || tab.hasAttribute?.("zen-glance-tab")) {
      return;
    }
    // Let addTab finish its own work first: a tab moved into another tab's DOM
    // halfway through creation leaves the tab strip inconsistent.
    Promise.resolve().then(() => openGlanceOver(tab, plan));
  }

  function onTabSelect(event) {
    const tab = event.target;
    if (!tab?.hasAttribute?.("glance-id")) {
      state.lastParent = tab;
    }
    const spec = tab?.linkedBrowser?.currentURI?.spec;
    if (spec && isPreferencesUri(spec)) {
      hookPreferences(tab.linkedBrowser);
    }
  }

  /* ---------------------------------------------------- normal tab redirect */

  /**
   * A link that would replace the tab you are on. Only page-initiated opens
   * are taken, so typing in the address bar still navigates the tab.
   */
  function redirectPlan(urlString, where, params) {
    if (where !== "current") {
      return null;
    }
    const principal = params?.triggeringPrincipal;
    if (!principal || principal.isSystemPrincipal) {
      return null;
    }
    const parent = gBrowser.selectedTab;
    if (!parent) {
      return null;
    }
    const url = glanceableUrl(urlString);
    if (!url) {
      return null;
    }
    // A row for this site answers on its own, whatever the global switch says.
    const rule = domainRuleFor(url);
    if (rule) {
      if (!rule.links || !linkMatchesRule(rule, url)) {
        return null;
      }
      return { url, parent, kind: "normal", site: rule.host };
    }
    if (!setting("redirect") || sourceKind(parent) !== "normal") {
      return null;
    }
    return { url, parent, kind: "normal" };
  }

  function openGlanceInstead(plan) {
    const manager = glanceManager();
    if (!manager?.openGlance) {
      return false;
    }
    if (manager._animating || isGlanceOpen()) {
      return false;
    }
    try {
      manager.openGlance({
        url: plan.url,
        ...animationRect(),
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return true;
    } catch (e) {
      console.error("[zen-glance-plus] could not open the Glance", e);
      return false;
    }
  }

  /* ---------------------------------------------------------- sites table */

  function addDomain(value, rules) {
    const host = normaliseDomain(value);
    if (!host) {
      return null;
    }
    const current = rules ?? readDomains();
    if (current.some(rule => rule.host === host)) {
      return null;
    }
    const next = [...current, { host, tabs: true, links: false, paths: [] }];
    writeDomains(next);
    return next;
  }

  function removeDomain(index, rules) {
    const current = rules ?? readDomains();
    if (!Number.isInteger(index) || index < 0 || index >= current.length) {
      return null;
    }
    const next = current.filter((_, position) => position !== index);
    writeDomains(next);
    return next;
  }

  function setDomainFlag(index, flag, value, rules) {
    const current = rules ?? readDomains();
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= current.length ||
      !["tabs", "links"].includes(flag)
    ) {
      return null;
    }
    const next = current.map((rule, position) =>
      position === index ? { ...rule, [flag]: Boolean(value) } : rule
    );
    writeDomains(next);
    return next;
  }

  function addPath(index, value, rules) {
    const pattern = normalisePathPattern(value);
    const current = rules ?? readDomains();
    if (!pattern || !Number.isInteger(index) || !current[index]) {
      return null;
    }
    const paths = current[index].paths ?? [];
    if (paths.includes(pattern)) {
      return null;
    }
    const next = current.map((rule, position) =>
      position === index ? { ...rule, paths: [...paths, pattern] } : rule
    );
    writeDomains(next);
    return next;
  }

  function removePath(index, position, rules) {
    const current = rules ?? readDomains();
    if (!Number.isInteger(index) || !current[index] || !Number.isInteger(position)) {
      return null;
    }
    const paths = current[index].paths ?? [];
    if (position < 0 || position >= paths.length) {
      return null;
    }
    const next = current.map((rule, rowIndex) =>
      rowIndex === index
        ? { ...rule, paths: paths.filter((_, at) => at !== position) }
        : rule
    );
    writeDomains(next);
    return next;
  }

  /* ------------------------------------------------- the table, as elements */

  function el(doc, tag, className) {
    const node = doc.createElementNS(XHTML, tag);
    if (className) {
      node.setAttribute("class", className);
    }
    return node;
  }

  /** Rows whose link patterns are open, kept across re-renders. */
  const expandedHosts = new Set();

  /**
   * One row. Text goes in through `textContent` and every attribute through
   * `setAttribute`, so a stored site can never become markup.
   */
  function buildRow(doc, rule, index) {
    const entry = el(doc, "div", "zgp-entry");
    entry.setAttribute("data-index", String(index));

    const row = el(doc, "div", "zgp-row");

    // A span, not a button: the settings page's own button styles centre their
    // content and refuse to shrink, which squashed the name into the middle of
    // the row and pushed the remove control past the panel edge.
    const site = el(doc, "span", "zgp-site");
    site.setAttribute("role", "button");
    site.setAttribute("tabindex", "0");
    site.setAttribute("data-act", "toggle");
    site.setAttribute("aria-expanded", String(expandedHosts.has(rule.host)));
    site.setAttribute(
      "title",
      rule.paths.length ? rule.paths.join("\n") : "Any link on this site"
    );
    const name = el(doc, "span", "zgp-site-name");
    name.textContent = rule.host;
    site.appendChild(name);
    if (rule.paths.length) {
      const badge = el(doc, "span", "zgp-badge");
      badge.textContent = rule.paths.length === 1 ? "1 link" : `${rule.paths.length} links`;
      site.appendChild(badge);
    }

    const makeBox = (flag, checked, label) => {
      const wrapper = el(doc, "label", "zgp-box");
      const input = doc.createElementNS(XHTML, "input");
      input.setAttribute("type", "checkbox");
      input.setAttribute("data-act", flag);
      input.setAttribute("aria-label", label);
      input.checked = Boolean(checked);
      if (checked) {
        input.setAttribute("checked", "");
      }
      wrapper.appendChild(input);
      return wrapper;
    };

    const remove = el(doc, "span", "zgp-remove");
    remove.setAttribute("role", "button");
    remove.setAttribute("tabindex", "0");
    remove.setAttribute("data-act", "remove");
    remove.setAttribute("aria-label", `Remove ${rule.host}`);
    remove.setAttribute("title", `Remove ${rule.host}`);
    remove.textContent = "×";

    row.appendChild(site);
    row.appendChild(makeBox("tabs", rule.tabs, `New tabs on ${rule.host}`));
    row.appendChild(makeBox("links", rule.links, `Same tab links on ${rule.host}`));
    row.appendChild(remove);

    const paths = el(doc, "div", "zgp-paths");
    if (!expandedHosts.has(rule.host)) {
      paths.setAttribute("hidden", "");
    }

    const add = el(doc, "div", "zgp-add");
    const input = doc.createElementNS(XHTML, "input");
    input.setAttribute("type", "text");
    input.setAttribute("class", "zgp-input zgp-pathinput");
    input.setAttribute("placeholder", "/r/*/comments/*");
    input.setAttribute("aria-label", `Links that glance on ${rule.host}`);
    input.setAttribute("spellcheck", "false");
    const addButton = el(doc, "button", "zgp-addbutton");
    addButton.setAttribute("type", "button");
    addButton.setAttribute("data-act", "addpath");
    addButton.textContent = "Add";
    add.appendChild(input);
    add.appendChild(addButton);
    paths.appendChild(add);

    const chips = el(doc, "div", "zgp-chips");
    rule.paths.forEach((pattern, position) => {
      const chip = el(doc, "span", "zgp-chip");
      chip.setAttribute("data-index", String(position));
      const text = el(doc, "span", "zgp-chip-text");
      text.textContent = pattern;
      const kill = el(doc, "button", "zgp-chip-remove");
      kill.setAttribute("type", "button");
      kill.setAttribute("data-act", "removepath");
      kill.setAttribute("aria-label", `Remove ${pattern} from ${rule.host}`);
      kill.textContent = "×";
      chip.appendChild(text);
      chip.appendChild(kill);
      chips.appendChild(chip);
    });
    paths.appendChild(chips);

    const any = el(doc, "p", "zgp-anylink");
    any.textContent = "Any link on this site";
    if (rule.paths.length) {
      any.setAttribute("hidden", "");
    }
    paths.appendChild(any);

    entry.appendChild(row);
    entry.appendChild(paths);
    return entry;
  }

  function fillRows(doc, root, rules) {
    const rows = root.querySelector(".zgp-rows");
    if (!rows) {
      return;
    }
    while (rows.firstChild) {
      rows.removeChild(rows.firstChild);
    }
    rules.forEach((rule, index) => rows.appendChild(buildRow(doc, rule, index)));
    const empty = root.querySelector(".zgp-empty");
    if (empty) {
      if (rules.length) {
        empty.setAttribute("hidden", "");
      } else {
        empty.removeAttribute("hidden");
      }
    }
  }

  function buildTable(doc, rules) {
    const root = el(doc, "div", "zgp-table");
    root.id = UI_TABLE;

    const add = el(doc, "div", "zgp-add");
    const input = doc.createElementNS(XHTML, "input");
    input.setAttribute("type", "text");
    input.setAttribute("class", "zgp-input zgp-siteinput");
    input.setAttribute("placeholder", "example.com");
    input.setAttribute("aria-label", "Site to add");
    input.setAttribute("spellcheck", "false");
    const addButton = el(doc, "button", "zgp-addbutton");
    addButton.setAttribute("type", "button");
    addButton.setAttribute("data-act", "add");
    addButton.textContent = "Add";
    add.appendChild(input);
    add.appendChild(addButton);
    root.appendChild(add);

    const head = el(doc, "div", "zgp-head");
    for (const title of ["Site", "New tabs", "Same tab", ""]) {
      const cell = el(doc, "span", "zgp-headcell");
      cell.textContent = title;
      head.appendChild(cell);
    }
    root.appendChild(head);

    root.appendChild(el(doc, "div", "zgp-rows"));

    const empty = el(doc, "p", "zgp-empty");
    empty.textContent = "No sites yet.";
    root.appendChild(empty);

    fillRows(doc, root, rules ?? []);
    return root;
  }

  /* ------------------------------------------------------ settings injection */

  const styledWindows = new WeakSet();
  const hookedWindows = new WeakSet();
  const missingAnchorLogged = new WeakSet();

  /** This script's own folder, so the sheet travels with the mod wherever it sits. */
  function scriptFolderUrl() {
    try {
      const stack = String(Components.stack?.filename ?? "");
      const file = stack.split(" -> ").pop().replace(/[?#].*$/, "");
      return file ? new URL(".", file).href : null;
    } catch (e) {
      return null;
    }
  }

  function loadTableStyles(win) {
    if (styledWindows.has(win)) {
      return;
    }
    styledWindows.add(win);
    const folder = scriptFolderUrl();
    const url = folder
      ? new URL("../styles/domains.css", folder).href
      : "chrome://sine/content/zen-glance-plus/styles/domains.css";
    try {
      win.windowUtils.loadSheetUsingURIString(url, win.windowUtils.AUTHOR_SHEET);
      return;
    } catch (e) {
      // A document that refuses an author sheet still takes a link.
    }
    try {
      const link = win.document.createElementNS(XHTML, "link");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute("href", url);
      win.document.head?.appendChild(link);
    } catch (e) {
      /* styling is not worth breaking the table over */
    }
  }

  function rerender(win, rules) {
    const doc = win?.document;
    const table = doc?.getElementById(UI_TABLE);
    if (table) {
      fillRows(doc, table, rules ?? readDomains());
    }
  }

  function onTableClick(win, event) {
    const button = event.target?.closest?.("[data-act]");
    const table = win.document.getElementById(UI_TABLE);
    if (!button || !table) {
      return;
    }
    const action = button.getAttribute("data-act");
    const entry = button.closest(".zgp-entry");
    const index = entry ? Number(entry.getAttribute("data-index")) : -1;

    if (action === "add") {
      const input = table.querySelector(".zgp-siteinput");
      const next = addDomain(input?.value ?? "");
      if (next) {
        if (input) {
          input.value = "";
        }
        rerender(win, next);
      }
      if (input) {
        input.focus();
      }
      return;
    }
    if (action === "remove") {
      const next = removeDomain(index);
      if (next) {
        rerender(win, next);
      }
      return;
    }
    if (action === "toggle") {
      const rules = readDomains();
      const rule = rules[index];
      if (!rule) {
        return;
      }
      if (expandedHosts.has(rule.host)) {
        expandedHosts.delete(rule.host);
      } else {
        expandedHosts.add(rule.host);
      }
      rerender(win, rules);
      return;
    }
    if (action === "addpath") {
      const input = entry?.querySelector(".zgp-pathinput");
      const next = addPath(index, input?.value ?? "");
      if (next) {
        if (input) {
          input.value = "";
        }
        rerender(win, next);
      }
      input?.focus?.();
      return;
    }
    if (action === "removepath") {
      const chip = button.closest(".zgp-chip");
      const position = chip ? Number(chip.getAttribute("data-index")) : -1;
      const next = removePath(index, position);
      if (next) {
        rerender(win, next);
      }
    }
  }

  function onTableChange(win, event) {
    const box = event.target;
    const action = box?.getAttribute?.("data-act");
    if (action !== "tabs" && action !== "links") {
      return;
    }
    const row = box.closest?.(".zgp-row");
    const index = row ? Number(row.getAttribute("data-index")) : -1;
    const next = setDomainFlag(index, action, box.checked);
    if (next) {
      rerender(win, next);
    }
  }

  function onTableKeydown(win, event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const table = win.document.getElementById(UI_TABLE);
    if (!table) {
      return;
    }
    const target = event.target;
    const action = target?.getAttribute?.("data-act");
    if (action === "toggle" || action === "remove") {
      event.preventDefault();
      onTableClick(win, { target });
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    const entry = target?.closest?.(".zgp-entry");
    const pathInput = entry?.querySelector?.(".zgp-pathinput");
    if (pathInput && target === pathInput) {
      event.preventDefault();
      onTableClick(win, { target: entry.querySelector('[data-act="addpath"]') });
      return;
    }
    const input = table.querySelector(".zgp-siteinput");
    if (!input || target !== input) {
      return;
    }
    event.preventDefault();
    onTableClick(win, { target: table.querySelector('[data-act="add"]') });
  }

  function insertAfter(node, el) {
    if (typeof node.after === "function") {
      node.after(el);
    } else {
      node.parentNode?.insertBefore(el, node.nextSibling);
    }
  }

  /** Every document the settings page might keep its preference rows in. */
  function settingsDocuments(win) {
    const docs = [];
    const push = doc => {
      try {
        if (doc?.documentElement && !docs.includes(doc)) {
          docs.push(doc);
        }
      } catch (e) {
        /* a document that cannot be read is not a candidate */
      }
    };
    push(win?.document);
    let frames = [];
    try {
      frames = Array.from(win?.frames ?? []);
    } catch (e) {
      frames = [];
    }
    frames.forEach(frame => push(frame?.document));
    try {
      for (const el of win?.document?.querySelectorAll("browser, iframe") ?? []) {
        push(el.contentDocument);
      }
    } catch (e) {
      /* nothing to add */
    }
    return docs;
  }

  /** The row carrying the Sites heading, whatever Sine gave it as an id. */
  function separatorHost(doc) {
    let labels = [];
    try {
      labels = Array.from(doc.querySelectorAll(".separator-label"));
    } catch (e) {
      return null;
    }
    const match = labels.find(el =>
      /^\s*\*{0,2}\s*Sites\s*\*{0,2}\s*$/.test(String(el.textContent ?? ""))
    );
    return match?.parentElement ?? match?.parentNode ?? null;
  }

  /**
   * Where the table goes, in order of how much the page tells us: the id the
   * separator should carry, then the heading itself, then the dialog holding
   * the rows. Returns how it was placed so the log says which.
   */
  function placeTable(doc, table) {
    const anchor = doc.getElementById?.(UI_ANCHOR);
    if (anchor) {
      insertAfter(anchor, table);
      return "id";
    }
    const host = separatorHost(doc);
    if (host) {
      insertAfter(host, table);
      return "separator";
    }
    for (const selector of [
      "#sineItemPreferenceDialogContent",
      ".sineItemPreferenceDialogContent",
    ]) {
      const container = doc.querySelector?.(selector);
      if (container && typeof container.append === "function") {
        container.append(table);
        return "container";
      }
    }
    return null;
  }

  function injectTable(win) {
    try {
      return injectTableInto(win);
    } catch (e) {
      trace(`table: failed ${e?.message ?? e}`);
      return false;
    }
  }

  function injectTableInto(win) {
    for (const doc of settingsDocuments(win)) {
      if (!doc?.documentElement || doc.getElementById?.(UI_TABLE)) {
        continue;
      }
      const domains = readDomains();
      const table = buildTable(doc, domains);
      const placement = placeTable(doc, table);
      if (!placement) {
        continue;
      }
      trace(`table: ${domains.length} site rows, placed by ${placement}`);
      if (typeof table.addEventListener !== "function") {
        return true;
      }
      table.addEventListener("click", event => onTableClick(win, event));
      table.addEventListener("change", event => onTableChange(win, event));
      table.addEventListener("keydown", event => onTableKeydown(win, event));
      loadTableStyles(win);
      return true;
    }
    if (!missingAnchorLogged.has(win)) {
      missingAnchorLogged.add(win);
      trace(`table: no place for it in ${settingsDocuments(win).length} documents`);
    }
    return false;
  }

  function isPreferencesUri(uri) {
    return /^about:(preferences|settings)/.test(String(uri ?? ""));
  }

  /**
   * The settings page renders its sections lazily, so the anchor appears later
   * than the window does. Watch for it instead of guessing a delay.
   */
  function watchPreferencesWindow(win) {
    if (!win || hookedWindows.has(win)) {
      return;
    }
    hookedWindows.add(win);
    const Observer = win.MutationObserver ?? window.MutationObserver;
    let queued = false;
    const check = () => {
      if (queued) {
        return;
      }
      queued = true;
      win.setTimeout(() => {
        queued = false;
        injectTable(win);
      }, 150);
    };
    try {
      new Observer(check).observe(win.document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {
      /* the table still appears the next time the page is opened */
    }
    // A mod's settings rows are built when its Configure dialog opens, which
    // is not always a mutation the observer sees first. A click is.
    win.addEventListener("click", check, true);
  }

  function hookPreferences(browser) {
    let win;
    try {
      win = browser?.contentWindow ?? null;
    } catch (e) {
      return;
    }
    if (!win || hookedWindows.has(win) || !isPreferencesUri(win.location?.href)) {
      return;
    }
    const ready = () => {
      trace("prefs window ready");
      injectTable(win);
      watchPreferencesWindow(win);
    };
    if (win.document?.readyState === "complete") {
      ready();
    } else {
      win.addEventListener("load", ready, { once: true });
    }
  }

  function scanPreferencesTabs() {
    for (const tab of gBrowser.tabs ?? []) {
      const spec = tab.linkedBrowser?.currentURI?.spec;
      if (spec && isPreferencesUri(spec)) {
        hookPreferences(tab.linkedBrowser);
      }
    }
  }

  /* -------------------------------------------------------------- install */

  function wrapAddTab() {
    const original = gBrowser.addTab;
    state.originalAddTab = original;
    gBrowser.addTab = function (uriString, params, ...rest) {
      let plan = null;
      try {
        plan = planFor(uriString, params);
      } catch (e) {
        plan = null;
        trace(`addTab error ${e?.message ?? e}`);
      }
      if (plan) {
        trace(`addTab glance ${String(uriString).slice(0, 120)}`);
      } else {
        trace(`addTab pass ${String(uriString).slice(0, 120)}`);
      }
      const previous = state.plan;
      state.plan = plan;
      try {
        return original.call(gBrowser, uriString, params, ...rest);
      } finally {
        state.plan = previous;
      }
    };
  }

  function wrapOpenLinkIn(name) {
    const original = window[name];
    if (typeof original !== "function") {
      return;
    }
    state[name === "openLinkIn" ? "originalOpenLinkIn" : "originalOpenTrustedLinkIn"] =
      original;
    window[name] = function (url, where, params) {
      let plan = null;
      try {
        plan = redirectPlan(url, where, params);
      } catch (e) {
        plan = null;
      }
      if (plan && openGlanceInstead(plan)) {
        return undefined;
      }
      return original.apply(window, arguments);
    };
  }

  function watchPreferencesTabs() {
    state.progressListener = {
      onLocationChange(browser, webProgress, request, location) {
        if (webProgress?.isTopLevel && isPreferencesUri(location?.spec)) {
          hookPreferences(browser);
        }
      },
    };
    gBrowser.addTabsProgressListener?.(state.progressListener);
  }

  function start() {
    if (state.started) {
      return true;
    }
    if (!window.gBrowser || typeof window.gBrowser.addTab !== "function") {
      console.warn(LOG, "gBrowser.addTab is not available yet; retrying on load");
      return false;
    }
    state.started = true;
    state.lastParent = gBrowser.selectedTab?.hasAttribute?.("glance-id")
      ? null
      : gBrowser.selectedTab;
    wrapAddTab();
    wrapOpenLinkIn("openLinkIn");
    wrapOpenLinkIn("openTrustedLinkIn");
    wrapGlanceManager();
    gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen, true);
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect, true);
    watchPreferencesTabs();
    scanPreferencesTabs();
    window.addEventListener(
      "unload",
      () => {
        stop();
      },
      { once: true }
    );
    console.info(LOG, "started with", readDomains().length, "sites configured");
    trace(
      `start ok hooked=${Boolean(state.originalAddTab)} sites=${readDomains().length} ` +
        `manager=${Boolean(window.gZenGlanceManager)} glance=${readPrefBool("zen.glance.enabled", true)}`
    );
    return true;
  }

  /** What the mod thinks it is doing, for the Browser Toolbox. */
  function status() {
    let sites = 0;
    try {
      sites = readDomains().length;
    } catch (e) {
      sites = -1;
    }
    return {
      started: Boolean(state.started),
      addTabWrapped: Boolean(state.originalAddTab),
      glanceManager: Boolean(window.gZenGlanceManager),
      glanceEnabled: readPrefBool("zen.glance.enabled", true),
      sites,
      switches: {
        essential: setting("essential"),
        pinned: setting("pinned"),
        normal: setting("normal"),
        newtab: setting("newtab"),
        redirect: setting("redirect"),
      },
    };
  }

  function stop() {
    if (!state.started) {
      return;
    }
    state.started = false;
    const glance = window.gZenGlanceManager;
    if (state.originalShouldGlance && glance) {
      glance.shouldOpenTabInGlance = state.originalShouldGlance;
      state.originalShouldGlance = null;
    }
    if (state.originalAddTab) {
      gBrowser.addTab = state.originalAddTab;
      state.originalAddTab = null;
    }
    if (state.originalOpenLinkIn) {
      window.openLinkIn = state.originalOpenLinkIn;
      state.originalOpenLinkIn = null;
    }
    if (state.originalOpenTrustedLinkIn) {
      window.openTrustedLinkIn = state.originalOpenTrustedLinkIn;
      state.originalOpenTrustedLinkIn = null;
    }
    if (state.progressListener) {
      gBrowser.removeTabsProgressListener?.(state.progressListener);
      state.progressListener = null;
    }
    gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen, true);
    gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect, true);
  }

  const api = {
    LOG,
    start,
    stop,
    status,
    sourceKind,
    planFor,
    redirectPlan,
    setting,
    state,
    PREF,
    DEFAULTS,
    // Sites
    normaliseDomain,
    normalisePathPattern,
    parseDomains,
    parsePaths,
    readDomains,
    writeDomains,
    domainRuleFor,
    pathMatches,
    linkMatchesRule,
    addDomain,
    removeDomain,
    setDomainFlag,
    addPath,
    removePath,
    buildTable,
    fillRows,
    injectTable,
    rerender,
    onTableClick,
    onTableChange,
    onTableKeydown,
    UI_ANCHOR,
    UI_TABLE,
  };

  // Reachable from the Browser Toolbox, and from the test harness.
  window.__zenGlancePlus = api;
  console.info(LOG, "script loaded; __zenGlancePlus is set");
  try {
    if (!start()) {
      // The window is still building its tab browser; try again on load.
      window.addEventListener("load", () => start(), { once: true });
    }
  } catch (e) {
    console.error(LOG, "could not start", e);
  }
})();

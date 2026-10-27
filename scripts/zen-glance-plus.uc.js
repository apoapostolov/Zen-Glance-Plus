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
    // Feedly's own reader view for an article: https://feedly.com/i/entry/<entryId>
    { host: "feedly.com", tabs: true, links: true, paths: ["/i/entry/*"] },
  ];

  const PREF = {
    essential: PREF_ROOT + "essential",
    pinned: PREF_ROOT + "pinned",
    normal: PREF_ROOT + "normal",
    newtab: PREF_ROOT + "newtab",
    redirect: PREF_ROOT + "redirect",
    samedomain: PREF_ROOT + "samedomain",
    seeded: PREF_ROOT + "seeded",
    domains: PREF_ROOT + "domains",
  };

  const DEFAULTS = {
    essential: true,
    pinned: true,
    normal: false,
    newtab: true,
    redirect: false,
    samedomain: false,
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
   * The domain a host belongs to, so `old.reddit.com` and `reddit.com` are one
   * site. Two labels normally; three where the second is a known registry
   * label, which is what keeps `bar.co.uk` apart from `foo.co.uk`.
   */
  const REGISTRY_LABELS = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

  function registrableDomain(host) {
    const parts = String(host ?? "")
      .toLowerCase()
      .split(".")
      .filter(Boolean);
    if (!parts.length) {
      return null;
    }
    if (parts.length <= 2) {
      return parts.join(".");
    }
    const [second, last] = parts.slice(-2);
    if (REGISTRY_LABELS.has(second) && last.length === 2) {
      return parts.slice(-3).join(".");
    }
    return `${second}.${last}`;
  }

  function hostOfUrl(value) {
    const text = String(value?.href ?? value ?? "");
    if (!text) {
      return null;
    }
    return normaliseDomain(hostOf(text));
  }

  function sourceHost(parent) {
    try {
      return hostOfUrl(parent?.linkedBrowser?.currentURI?.spec);
    } catch (e) {
      return null;
    }
  }

  /**
   * A row's `Domain` switch answers for pages opened from that row's site: with
   * it on, a page that leaves the site is not glanced. A row for the target
   * already answers only for its own domain, so the switch has to be read from
   * the tab that started the open, not from the address being opened.
   */
  function sourceRowBlocks(parent, url) {
    const source = hostOfUrl(parent?.linkedBrowser?.currentURI?.spec);
    if (!source) {
      return false;
    }
    const row = ruleForHost(source);
    if (!row?.domain) {
      return false;
    }
    const target = hostOfUrl(url);
    if (!target) {
      return false;
    }
    return registrableDomain(target) !== registrableDomain(row.host);
  }

  /**
   * `Same Domain Only`: a page is glanced only when it belongs to the domain
   * the link was opened from. A source with no domain — a New Tab page — puts
   * no constraint on where it opens.
   */
  function blockedByDomain(parent, url) {
    if (!setting("samedomain")) {
      return false;
    }
    const source = sourceHost(parent);
    if (!source) {
      return false;
    }
    const target = hostOfUrl(url);
    if (!target) {
      return false;
    }
    return registrableDomain(source) !== registrableDomain(target);
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
        domain: entry.domain === true,
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

  function readSeeded() {
    try {
      const list = JSON.parse(readPrefString(PREF.seeded, "[]"));
      return Array.isArray(list) ? list.filter(host => typeof host === "string") : [];
    } catch (e) {
      return [];
    }
  }

  function writeSeeded(hosts) {
    try {
      Services.prefs.setStringPref(PREF.seeded, JSON.stringify(hosts));
    } catch (e) {
      console.error("[zen-glance-plus] could not save the seeded sites", e);
    }
  }

  /**
   * A preset added in a later version reaches a list that already exists: each
   * shipped site is offered once, ever. Recording them all as offered is what
   * stops a site you deleted from coming back on the next start.
   */
  function offerNewPresets() {
    const offered = new Set(readSeeded());
    const rules = readDomains();
    const present = new Set(rules.map(rule => rule.host));
    const added = DEFAULT_SITES.filter(
      site => !offered.has(site.host) && !present.has(site.host)
    );
    if (added.length) {
      const rows = added.map(site => ({ ...site, paths: [...site.paths] }));
      writeDomains([...rules, ...rows]);
      trace(`presets: added ${rows.map(site => site.host).join(", ")}`);
    }
    const next = [...new Set([...offered, ...DEFAULT_SITES.map(site => site.host)])];
    if (next.length !== offered.size) {
      writeSeeded(next);
    }
    return added.map(site => site.host);
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
  function ruleForHost(host, rules) {
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

  function domainRuleFor(urlString, rules) {
    return ruleForHost(hostOf(urlString), rules);
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
    raindrop: null,
    started: false,
    progressListener: null,
  };

  function glanceManager() {
    return window.gZenGlanceManager ?? null;
  }

  /** True when this tab is part of a Glance: the overlay's own tab or its base. */
  function isGlanceTab(tab) {
    return Boolean(tab?.hasAttribute?.("glance-id") || tab?.hasAttribute?.("zen-glance-tab"));
  }

  /**
   * The tab the Glance is showing. Zen marks only that one with
   * `zen-glance-tab`; the tab underneath carries `glance-id` as well, which is
   * why a link followed here must never be loaded through a tab.
   */
  function theGlanceTab() {
    try {
      for (const tab of Array.from(gBrowser.tabs ?? [])) {
        if (tab.hasAttribute?.("zen-glance-tab")) {
          return tab;
        }
      }
    } catch (e) {
      /* a tab strip that cannot be read has no Glance in it */
    }
    return null;
  }

  /** The tab the Glance is shown over: Zen nests the Glance's tab inside it. */
  function glanceBaseTab(glanceTab) {
    try {
      return glanceTab?.parentElement?.closest?.("tab") ?? null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The page the Glance is showing, taken from the overlay itself. A tab is the
   * wrong handle for this: both the Glance's tab and the tab beneath it answer
   * to `glance-id`, and the one beneath is what a click would end up loading.
   */
  function openGlanceBrowser() {
    try {
      const host =
        document.querySelector(".browserSidebarContainer.zen-glance-overlay") ??
        document.querySelector("#zen-glance-detached");
      return host?.querySelector?.("browser") ?? null;
    } catch (e) {
      return null;
    }
  }

  /**
   * A link followed inside a Glance is judged by the tab the Glance sits over,
   * so it keeps the Glance it would have opened. Returns true when the address
   * was loaded in the open Glance.
   */
  function loadInOpenGlance(url) {
    const target = String(url ?? "");
    const browser = openGlanceBrowser();
    if (!target || !browser?.fixupAndLoadURIString) {
      return false;
    }
    try {
      browser.fixupAndLoadURIString(target, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      trace(`same glance ${target.slice(0, 120)}`);
      return true;
    } catch (e) {
      trace(`same glance failed ${e?.message ?? e}`);
      return false;
    }
  }

  /** Would this address have opened in a Glance from the tab the Glance sits over? */
  function wouldGlanceFromBase(uriString) {
    const glanceTab = theGlanceTab();
    const base = glanceBaseTab(glanceTab);
    if (!base) {
      return false;
    }
    const url = glanceableUrl(
      typeof uriString === "string" ? uriString : uriString?.spec
    );
    if (!url) {
      return false;
    }
    try {
      return Boolean(planFrom(base, url));
    } catch (e) {
      return false;
    }
  }

  function isGlanceOpen() {
    // The peek state does not select the Glance's tab and the overlay is not
    // always a child of the tab panels, so look for Zen's own markers anywhere.
    try {
      for (const tab of Array.from(gBrowser.tabs ?? [])) {
        if (isGlanceTab(tab)) {
          return true;
        }
      }
    } catch (e) {
      /* a tab strip that cannot be read is not a reason to refuse */
    }
    if (typeof document.querySelector !== "function") {
      return false;
    }
    return Boolean(
      document.querySelector(".browserSidebarContainer.zen-glance-overlay") ||
        document.querySelector("#zen-glance-detached") ||
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
  /**
   * The tab that asked for this one, and only that tab. A tab the browser opens
   * for itself — Ctrl+T, the sidebar's plus, a restored session — carries no
   * opener, and guessing the selected tab for it made the browser's own new tab
   * look like it had been opened from an essential.
   */
  function parentFor(params) {
    if (params?.ownerTab) {
      return params.ownerTab;
    }
    if (params?.openerBrowser) {
      return gBrowser.getTabForBrowser?.(params.openerBrowser) ?? null;
    }
    return null;
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
    // Zen refuses this in its own rule for the same reason: a Glance opened
    // from inside a Glance breaks its one-at-a-time bookkeeping. Those opens
    // are loaded in the open Glance instead, in wrapAddTab, and that path asks
    // planFrom because the tab a Glance sits over carries glance-id too.
    if (isGlanceTab(parent)) {
      return null;
    }
    return planFrom(parent, url);
  }

  /**
   * The policy itself, for a page opened from this tab. Callers that are asking
   * on the tab's behalf rather than opening from it — "would this have glanced?"
   * — use this directly.
   */
  function planFrom(parent, url) {
    const kind = sourceKind(parent);
    if (blockedByDomain(parent, url) || sourceRowBlocks(parent, url)) {
      return null;
    }
    // A row for this site answers for its domain, in both directions.
    const rule = domainRuleFor(url);
    if (rule) {
      if (!rule.tabs || !linkMatchesRule(rule, url)) {
        return null;
      }
      return { url, parent, kind, site: rule.host, via: "addTab" };
    }
    if (!shouldGlanceFrom(kind)) {
      return null;
    }
    return { url, parent, kind, via: "addTab" };
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
    // A page opened from inside a Glance belongs to that Glance: load it there
    // and take the tab Zen made for it away again.
    if (isGlanceTab(parent)) {
      if (glanceableUrl(spec) && wouldGlanceFromBase(spec) && loadInOpenGlance(spec)) {
        trace(`content open in open glance ${spec.slice(0, 120)}`);
        const dropped = tab;
        Promise.resolve().then(() => {
          try {
            gBrowser.removeTab(dropped);
          } catch (e) {
            trace(`in glance: could not drop the spare tab ${e?.message ?? e}`);
          }
        });
      }
      return false;
    }
    const plan = planFor(spec, { ownerTab: parent });
    if (plan) {
      plan.via = "content";
    }
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
      // A Glance shows a page, so anything that is not one is answered here
      // before Zen's rule is consulted. The browser's own new tab is the case
      // that matters: opened from a pinned tab it looks like a different
      // domain to Zen, which would otherwise convert a blank tab into a Glance.
      const spec = String(uri?.spec ?? uri ?? "");
      if (!glanceableUrl(spec)) {
        trace(`glance check ignored ${spec.slice(0, 120)}`);
        return false;
      }
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
    // The last door: never hand Zen a second Glance to manage at once.
    if (isGlanceOpen()) {
      trace("open glance refused: a Glance is already open");
      return;
    }
    trace(
      `adopt via=${plan.via ?? "?"} asked=${String(plan.url ?? "").slice(0, 120)} ` +
        `tab=${String(tab.linkedBrowser?.currentURI?.spec ?? "").slice(0, 120)}`
    );
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

  /* ------------------------------------------------------- glance copy link */

  const GLANCE_COPY = "zgp-glance-copy";
  /**
   * Zen's own link icon, drawn the way its own strip buttons draw theirs: as a
   * list style image on the toolbarbutton, so the skin decides the colour
   * through the same context-fill path as close, expand and split. Embedding
   * an image with its own fill is what made it black under a skin.
   */
  const COPY_ICON = "chrome://browser/skin/zen-icons/link.svg";

  /**
   * Add the copy button to a glance's button strip. Zen clones this strip from
   * a template for every Glance, so adding it to the container leaves it in
   * both the peek and the expanded state.
   */
  function addGlanceCopyButton(container) {
    const doc = container?.ownerDocument ?? document;
    if (!container?.querySelector || container.querySelector(`.${GLANCE_COPY}`)) {
      return null;
    }
    const button = doc.createXULElement("toolbarbutton");
    button.className = `no-squircles ${GLANCE_COPY} toolbarbutton-1`;
    button.setAttribute("data-act", "glancecopy");
    button.setAttribute("aria-label", "Copy link");
    button.setAttribute("title", "Copy link");
    if (button.style?.setProperty) {
      // Important, because a theme's user chrome is free to style toolbarbuttons
      // and does, with !important of its own.
      button.style.setProperty("list-style-image", `url("${COPY_ICON}")`, "important");
      button.style.setProperty("-moz-context-properties", "fill, fill-opacity", "important");
      button.style.setProperty("fill", "currentColor", "important");
    }
    container.appendChild(button);
    return button;
  }

  /* ---------------------------------------------- bookmark in the Glance bar */

  const GLANCE_BOOKMARK = "zgp-glance-bookmark";
  const BOOKMARK_ICON = "chrome://browser/skin/zen-icons/bookmark-hollow.svg";
  const BOOKMARK_PREF = "zen-glance-plus.bookmark";
  const GLANCE_BOOKMARK_GLYPH = "zgp-glance-bookmark-glyph";
  /**
   * Raindrop's cloud, taken from the add-on's own assets/action.svg and baked
   * here as a shape. The add-on's copy decides its own colour with a media query
   * and an opacity, which a dark skin swallows whole, and a picture cannot be
   * recoloured from outside; used as a mask, the shape is the ink and the
   * button's own colour paints it.
   */
  const RAINDROP_CLOUD =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
        '<path fill="#000" d="M8 2a5 5 0 0 1 5 5v.1a4 4 0 0 1-1 7.9H4a4 4 0 0 1-1-7.9V7a5 5 0 0 1 5-5Zm0 1.5C6 3.5 4.5 5.1 4.5 7v1.3l-1.1.3a2.5 2.5 0 0 0 .6 4.9h8a2.5 2.5 0 0 0 .6-5l-1.1-.2V7c0-2-1.6-3.5-3.5-3.5Z"/>' +
        "</svg>"
    );

  /** Which save button, if any, the Glance's strip carries. */
  function bookmarkMode() {
    let value = "off";
    try {
      value = Services.prefs.getStringPref(BOOKMARK_PREF, "off");
    } catch (e) {
      value = "off";
    }
    return value === "bookmarks" || value === "raindrop" ? value : "off";
  }

  function addonManager() {
    try {
      if (window.AddonManager) {
        return window.AddonManager;
      }
      return (
        ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs")
          .AddonManager ?? null
      );
    } catch (e) {
      return null;
    }
  }

  /** The add-on's own root, which its pages hang under. */
  function raindropBase(addon) {
    // The browser keeps every extension's moz-extension host under this
    // preference, which is the address an extension page is reached by.
    try {
      const map = JSON.parse(
        Services.prefs.getStringPref("extensions.webextensions.uuids", "{}")
      );
      const uuid = map?.[addon?.id];
      if (uuid) {
        return `moz-extension://${uuid}`;
      }
    } catch (e) {
      /* no preference to read falls through to the add-on's own address */
    }
    try {
      const url = new URL(String(addon?.iconURL ?? ""));
      if (url.host) {
        return `${url.protocol}//${url.host}`;
      }
    } catch (e) {
      /* an add-on without a usable address cannot be opened */
    }
    return "";
  }

  /** The Raindrop add-on, when it is installed and enabled. */
  function raindropAddon() {
    return state.raindrop ?? null;
  }

  /**
   * Raindrop is looked up once and cached: the strip is built for every Glance,
   * and asking the add-on manager each time would be work for nothing.
   */
  async function findRaindrop() {
    const manager = addonManager();
    if (!manager?.getAddonsByTypes) {
      state.raindrop = null;
      refreshGlanceBookmarkButtons();
      return null;
    }
    try {
      const addons = await manager.getAddonsByTypes(["extension"]);
      const found = Array.from(addons ?? []).find(candidate =>
        /raindrop/i.test(`${candidate?.name ?? ""} ${candidate?.id ?? ""}`)
      );
      state.raindrop =
        found && found.isActive !== false
          ? {
              id: found.id,
              name: found.name,
              base: raindropBase(found),
            }
          : null;
      if (state.raindrop) {
        trace(`glance bookmark: ${state.raindrop.name} at ${state.raindrop.base || "no address"}`);
      }
      if (bookmarkMode() === "raindrop" && !state.raindrop) {
        trace("glance bookmark: Raindrop is not installed or is disabled");
      }
    } catch (e) {
      state.raindrop = null;
      trace(`glance bookmark: no add-on list ${e?.message ?? e}`);
    }
    refreshGlanceBookmarkButtons();
    return state.raindrop;
  }

  /**
   * The save button, to the left of the copy button. It is rebuilt from the
   * preference each time, so switching the setting takes effect on the strip
   * that is already there.
   */
  function addGlanceBookmarkButton(container) {
    const doc = container?.ownerDocument ?? document;
    const mode = bookmarkMode();
    const raindrop = mode === "raindrop" ? raindropAddon() : null;
    const icon = mode === "bookmarks" ? BOOKMARK_ICON : raindrop ? RAINDROP_CLOUD : "";
    const existing = container?.querySelector?.(`.${GLANCE_BOOKMARK}`) ?? null;
    if (!container?.querySelector || !icon) {
      // Disabled, or Raindrop asked for and not installed: nothing to show.
      existing?.remove?.();
      return null;
    }
    // A second pass, a rebuilt strip or a switch of mode must never leave two
    // buttons or two glyphs behind: that is two clouds side by side.
    for (const extra of Array.from(container.querySelectorAll?.(`.${GLANCE_BOOKMARK}`) ?? [])) {
      if (extra !== existing) {
        extra.remove?.();
        trace("glance bookmark: removed a second save button");
      }
    }
    let button = existing;
    if (!button) {
      button = doc.createXULElement("toolbarbutton");
      button.className = `no-squircles ${GLANCE_BOOKMARK} toolbarbutton-1`;
      button.setAttribute("data-act", "glancebookmark");
      const copy = container.querySelector(`.${GLANCE_COPY}`);
      container.insertBefore(button, copy ?? null);
    }
    const label =
      mode === "bookmarks" ? "Bookmark this page" : `Save to ${raindrop?.name ?? "Raindrop"}`;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    if (button.style?.setProperty) {
      // Important for the same reason the copy icon is: a skin styles these
      // toolbarbuttons with !important of its own.
      if (mode === "raindrop") {
        // The glyph is a child of the button, not its background: Zen paints a
        // chip behind these buttons and colours them with `color`, so a masked
        // background on the button itself drowns in that chip. A child masked
        // with the cloud and filled with currentColor is the same ink the icons
        // beside it use, and hover only repaints the chip.
        button.style.setProperty("list-style-image", "none", "important");
        for (const stale of Array.from(
          button.querySelectorAll?.(`#${GLANCE_BOOKMARK_GLYPH}`) ?? []
        ).slice(1)) {
          stale.remove?.();
        }
        if (!button.querySelector?.(`#${GLANCE_BOOKMARK_GLYPH}`)) {
          const glyph = doc.createElementNS
            ? doc.createElementNS("http://www.w3.org/1999/xhtml", "span")
            : doc.createElement("span");
          glyph.id = GLANCE_BOOKMARK_GLYPH;
          glyph.style?.setProperty?.("display", "block", "important");
          glyph.style?.setProperty?.("width", "16px", "important");
          glyph.style?.setProperty?.("height", "16px", "important");
          glyph.style?.setProperty?.("margin", "auto", "important");
          glyph.style?.setProperty?.("background-color", "currentColor", "important");
          glyph.style?.setProperty?.("mask-image", `url("${icon}")`, "important");
          glyph.style?.setProperty?.("mask-repeat", "no-repeat", "important");
          glyph.style?.setProperty?.("mask-position", "center", "important");
          glyph.style?.setProperty?.("mask-size", "contain", "important");
          button.appendChild(glyph);
        }
      } else {
        button.querySelector?.(`#${GLANCE_BOOKMARK_GLYPH}`)?.remove?.();
        button.style.setProperty("list-style-image", `url("${icon}")`, "important");
        button.style.setProperty("-moz-context-properties", "fill, fill-opacity", "important");
        button.style.setProperty("fill", "currentColor", "important");
      }
    }
    return button;
  }

  /** Redraw the strip in place, because the template is shared by every Glance. */
  function refreshGlanceBookmarkButtons() {
    try {
      const container = document
        .getElementById("zen-glance-sidebar-template")
        ?.content?.querySelector(".zen-glance-sidebar-container");
      if (container) {
        addGlanceBookmarkButton(container);
      }
    } catch (e) {
      trace(`glance bookmark: no strip ${e?.message ?? e}`);
    }
  }

  /**
   * The browser's bookmark dialog reserves a slot at the left of its title and
   * paints the hollow bookmark into it: the dialog declares `neediconheader`, and
   * `_getIconUrl()` answers `bookmark-hollow.svg` for a new bookmark. Nothing of
   * ours put it there, but it reads as a stray icon from the address bar, so it
   * is cleared for the dialog this button opens.
   *
   * The slot can be drawn in an element that the dialog's own layout, a skin or
   * a theme decides on, so the element itself is hidden rather than the variable
   * it happens to read, and every window is looked in: the dialog may be a sub
   * dialog of this window or a window of its own.
   */
  function bookmarkDialogDocuments() {
    const docs = [];
    const add = candidate => {
      try {
        const win =
          candidate?.contentWindow ??
          candidate?.frameContentWindow ??
          (candidate?.document ? candidate : candidate?.docShell?.domWindow);
        const doc = win?.document;
        if (!doc) {
          return;
        }
        const id = String(doc.documentElement?.id ?? "");
        const href = String(doc.location?.href ?? "");
        if (id === "bookmarkproperties" || href.includes("bookmarkProperties")) {
          docs.push(doc);
        }
      } catch (e) {
        /* a window that cannot be read has no dialog in it */
      }
    };
    try {
      const box = window.gDialogBox;
      add(box?.dialog?.frameContentWindow);
      add(box?._frame?.contentWindow);
      add(box?.dialog?.querySelector?.("browser"));
    } catch (e) {
      /* no sub dialog */
    }
    for (const kind of ["getXULWindowEnumerator", "getEnumerator"]) {
      try {
        const list = Services.wm?.[kind]?.(kind === "getEnumerator" ? "navigator:browser" : null);
        while (list?.hasMoreElements?.()) {
          add(list.getNext());
        }
      } catch (e) {
        /* the window list is not readable on this build */
      }
    }
    return docs;
  }

  const DIALOG_FIELDS_ROW = "zen-glance-plus-dialog-row";

  /**
   * Location and Spaces on one line. The dialog's own sheet is
   * `#editBookmarkPanelContent { display: grid; grid-template-columns: auto }`,
   * so every field container is a row of its own and no width can fix that. The
   * two containers are put inside one flex row instead, each taking half.
   */
  function putLocationAndSpacesOnOneRow(doc) {
    try {
      if (doc.getElementById?.(DIALOG_FIELDS_ROW)) {
        return true;
      }
      const menu = doc.getElementById?.("editBMPanel_folderMenuList") ?? null;
      const location = menu?.closest?.(".zenEditBMPanel_fieldContainer");
      const spaces = doc
        .getElementById?.("editBMPanel_workspaceDropdown")
        ?.closest?.(".zenEditBMPanel_fieldContainer");
      const parent = location?.parentElement ?? null;
      if (!location || !spaces || !parent || spaces.parentElement !== parent) {
        return false;
      }
      const row = doc.createElementNS
        ? doc.createElementNS("http://www.w3.org/1999/xhtml", "div")
        : doc.createElement("div");
      row.id = DIALOG_FIELDS_ROW;
      row.style?.setProperty?.("display", "flex", "important");
      row.style?.setProperty?.("align-items", "center", "important");
      // No gap: the two labels and their controls have to fit one line, and every
      // pixel between them is a pixel the Spaces dropdown cannot use.
      row.style?.setProperty?.("gap", "0", "important");
      row.style?.setProperty?.("flex-wrap", "nowrap", "important");
      // The folder chip takes the place of the word Location: it says where the
      // bookmark will go, which is what the word only announced. The menu keeps
      // the word as its accessible name before it goes.
      for (const child of Array.from(location.children ?? [])) {
        if (String(child.tagName ?? "").toLowerCase() !== "label") {
          continue;
        }
        const name = String(child.textContent ?? "").trim();
        if (name) {
          menu?.setAttribute?.("aria-label", name);
        }
        child.style?.setProperty?.("display", "none", "important");
        trace(`glance bookmark: the folder chip stands in for the "${name}" label`);
      }
      // The folder menu asks for every pixel of width and keeps its text at the
      // left of that box, so the rest of it reads as an empty stretch in the
      // middle of the line. It hugs its own content instead, and Spaces takes
      // whatever is left over.
      location.style?.setProperty?.("flex", "0 1 auto", "important");
      spaces.style?.setProperty?.("flex", "1 1 40%", "important");
      for (const cell of [location, spaces]) {
        cell.style?.setProperty?.("min-width", "0", "important");
        cell.style?.setProperty?.("flex-wrap", "nowrap", "important");
        cell.style?.setProperty?.("align-items", "center", "important");
        cell.style?.setProperty?.("gap", "8px", "important");
        // The label keeps its own width; the control takes what is left, which is
        // what stops the pair inside a cell from wrapping onto two lines.
        for (const child of Array.from(cell.children ?? [])) {
          const isLabel = String(child.tagName ?? "").toLowerCase() === "label";
          child.style?.setProperty?.("flex", isLabel ? "0 0 auto" : "0 1 auto", "important");
          child.style?.setProperty?.("min-width", "0", "important");
        }
      }
      // The Location cell stretches, but the menu inside it keeps its own width,
      // so the rest of the cell stays empty — which is the wide gap that made
      // Spaces look pinned to the right edge. The menu fills its half instead.
      const menuRow = menu?.parentElement ?? null;
      menuRow?.style?.setProperty?.("display", "flex", "important");
      menuRow?.style?.setProperty?.("flex", "0 1 auto", "important");
      menuRow?.style?.setProperty?.("min-width", "0", "important");
      if (menu?.style?.setProperty) {
        // `flex="1"` on the menulist and `width: -moz-available` in the sheet are
        // both overridden here: it is as wide as its own contents.
        menu.style.setProperty("flex", "0 1 auto", "important");
        menu.style.setProperty("width", "auto", "important");
        menu.style.setProperty("min-width", "0", "important");
        menu.style.setProperty("max-width", "none", "important");
        // So the chip starts exactly where the word it replaces started: the
        // menulist's own inline padding goes, and with it the 16px this dialog
        // keeps on that menu's right in its own sheet.
        menu.style.setProperty("padding-inline-start", "0", "important");
        menu.style.setProperty("margin-inline-start", "0", "important");
        menu.style.setProperty("margin-inline-end", "0", "important");
      }
      for (const child of Array.from(menuRow?.children ?? [])) {
        if (child !== menu) {
          child.style?.setProperty?.("flex", "0 0 auto", "important");
        }
      }
      // The Spaces trigger asks for the full cell width on its own, which is why
      // the pair overflowed; it takes a share of the cell now and shortens the
      // name it shows rather than the box it sits in.
      const dropdown =
        doc.getElementById?.("editBMPanel_workspaceDropdown") ??
        spaces.querySelector?.(".workspace-dropdown");
      dropdown?.style?.setProperty?.("width", "auto", "important");
      dropdown?.style?.setProperty?.("flex", "1 1 0", "important");
      dropdown?.style?.setProperty?.("min-width", "0", "important");
      const trigger = doc.getElementById?.("editBMPanel_workspaceSummary");
      trigger?.style?.setProperty?.("min-width", "0", "important");
      trigger?.style?.setProperty?.("overflow", "hidden", "important");
      trigger?.style?.setProperty?.("text-overflow", "ellipsis", "important");
      trigger?.style?.setProperty?.("white-space", "nowrap", "important");
      // And the 16px it keeps on its right is not needed on a line with no room
      // to spare.
      trigger?.style?.setProperty?.("margin-inline-end", "0", "important");
      doc
        .getElementById?.("editBMPanel_workspacesSelectorExpander")
        ?.style?.setProperty?.("flex", "0 0 auto", "important");
      parent.insertBefore(row, location);
      row.appendChild(location);
      row.appendChild(spaces);
      trace(
        `glance bookmark: fields ${spanOf(row)}: Location ${spanOf(location)} (menu ${spanOf(menu)}) Spaces ${spanOf(spaces)}`
      );
      return true;
    } catch (e) {
      trace(`glance bookmark: the two fields did not become one row (${e?.name ?? e})`);
      return false;
    }
  }

  /** Hide the icon, whatever element the dialog draws it in. */
  function clearBookmarkDialogIcon(doc) {
    let touched = false;
    let icon = null;
    try {
      doc.documentElement?.style?.setProperty("--icon-url", "none", "important");
      touched = true;
    } catch (e) {
      /* no such variable to clear */
    }
    try {
      icon = doc.querySelector?.(".titleIcon") ?? null;
      if (icon?.style?.setProperty) {
        icon.style.setProperty("display", "none", "important");
        touched = true;
      }
    } catch (e) {
      /* an icon drawn some other way is described by the fingerprint below */
    }
    let container = null;
    try {
      container = doc.getElementById?.("titleContainer") ?? null;
      container?.setAttribute?.("noicon", "true");
    } catch (e) {
      /* the container is a nice-to-have */
    }
    // Settled when the icon is gone, or when there is no icon element to hide in
    // a dialog that has already drawn its header.
    return Boolean(icon?.style?.setProperty || (container && !icon));
  }

  /** The windows that are open, so a missed dialog can be found next time. */
  function openWindowFingerprint() {
    const seen = [];
    try {
      const list = Services.wm?.getEnumerator?.(null);
      while (list?.hasMoreElements?.() && seen.length < 6) {
        try {
          const win = list.getNext();
          const doc = win?.document;
          seen.push(`${String(doc?.location?.href ?? "?").slice(-32)}#${doc?.documentElement?.id ?? "?"}`);
        } catch (e) {
          seen.push("?");
        }
      }
    } catch (e) {
      return "unreadable";
    }
    return seen.join(" ") || "none";
  }

  /** What the dialog's header holds, so a wrong guess can be read next time. */
  function dialogHeaderFingerprint(doc) {
    try {
      const header =
        doc.getElementById?.("titleContainer") ??
        doc.querySelector?.("dialog") ??
        doc.documentElement;
      const parts = Array.from(header?.children ?? [])
        .slice(0, 8)
        .map(el => `${el.tagName?.toLowerCase() ?? "?"}.${String(el.className ?? "").trim() || "-"}`);
      const icon = doc.querySelector?.(".titleIcon");
      return `root=${doc.documentElement?.id ?? "?"} icon=${icon ? "yes" : "no"} header=${parts.join(",")}`;
    } catch (e) {
      return "an unreadable dialog";
    }
  }

  function hideBookmarkDialogIcon() {
    let tries = 0;
    let reported = false;
    const look = () => {
      tries += 1;
      const docs = bookmarkDialogDocuments();
      let hidden = 0;
      let rowed = 0;
      for (const doc of docs) {
        // Both of these are written on every pass, because the dialog fills them
        // in during its own init, which runs after the window appears.
        try {
          doc.documentElement?.style?.setProperty("--icon-url", "none", "important");
        } catch (e) {
          /* nothing to clear */
        }
        try {
          doc.getElementById?.("titleContainer")?.setAttribute?.("noicon", "true");
        } catch (e) {
          /* no container to mark */
        }
        try {
          const icon = doc.querySelector?.(".titleIcon");
          if (icon?.style?.setProperty) {
            icon.style.setProperty("display", "none", "important");
            hidden += 1;
          }
        } catch (e) {
          /* described by the fingerprint */
        }
        try {
          if (putLocationAndSpacesOnOneRow(doc)) {
            rowed += 1;
          }
        } catch (e) {
          /* the row is reported by its own trace line */
        }
        if (!reported) {
          reported = true;
          trace(`glance bookmark: dialog header ${dialogHeaderFingerprint(doc)}`);
        }
      }
      // Done only once both jobs are settled: the header slot is added after the
      // window opens, and the two field rows are only there once the dialog has
      // built its content, so an early pass can find nothing.
      if (hidden && rowed) {
        trace(`glance bookmark: dialog prepared in ${rowed} document(s)`);
        return true;
      }
      if (hidden && !rowed && tries > 8) {
        trace(`glance bookmark: the icon is gone, the two fields were not found (${docs.length} document(s))`);
        return false;
      }
      if (tries < 60) {
        const later = window.setTimeout ?? setTimeout;
        later(look, 80);
        return false;
      }
      trace(
        `glance bookmark: no icon element to clear in ${docs.length} dialog document(s); windows ${openWindowFingerprint()}`
      );
      return false;
    };
    return look();
  }

  /**
   * Bookmarks the page the Glance is showing. Zen's own star reads the selected
   * browser, and a peeking Glance leaves another tab selected, so the dialog is
   * opened for this address instead of for whatever is selected.
   */
  function bookmarkGlancePage(browser) {
    const hook = window.PlacesCommandHook;
    const spec = String(browser?.currentURI?.spec ?? browser?.userTypedValue ?? "");
    if (!spec || !hook?.bookmarkLink) {
      trace("glance bookmark: no bookmark service to ask");
      return false;
    }
    const title = String(browser?.contentTitle ?? "") || spec;
    try {
      Promise.resolve(hook.bookmarkLink(spec, title)).catch(e =>
        trace(`glance bookmark: ${e?.message ?? e}`)
      );
      // The dialog opens on a later turn, so this watches for it.
      hideBookmarkDialogIcon();
    } catch (e) {
      trace(`glance bookmark: ${e?.message ?? e}`);
      return false;
    }
    return true;
  }

  /**
   * Raindrop's add dialog, opened the way Raindrop opens it. Its own code builds
   * `/index.html#/add?link=<address>` and puts that in a 420 by 600 popup window
   * centred on the window it came from — that is what its address-bar cloud and
   * its save-page shortcut do. Pressing its toolbar button instead shows the
   * extension's panel, which is a different thing.
   */
  function openRaindropDialog(browser) {
    const addon = raindropAddon();
    if (!addon) {
      trace("glance bookmark: Raindrop is not there to open");
      return false;
    }
    const spec = String(browser?.currentURI?.spec ?? browser?.userTypedValue ?? "");
    if (!spec || !addon.base) {
      trace("glance bookmark: no page or no Raindrop to save it with");
      return false;
    }
    // A mod's script runs in a sandbox, so the `window` it can see is not an
    // nsIDOMWindow: passing it to the window watcher, or calling open on it,
    // fails with NS_ERROR_ILLEGAL_VALUE however right the rest of the call is.
    // The page's own document knows the window that drew it.
    const parent = chromeWindowOf(browser) ?? chromeWindowOf(gBrowser?.selectedBrowser);
    if (!parent) {
      trace("glance bookmark: no chrome window to open Raindrop's dialog from");
    } else {
      trace(`glance bookmark: opening Raindrop's popup over ${whereOf(parent)}`);
    }
    const width = 420;
    const height = 600;
    const screenX = Number(parent?.screenX ?? 0);
    const screenY = Number(parent?.screenY ?? 0);
    const outerWidth = Number(parent?.outerWidth ?? width);
    const outerHeight = Number(parent?.outerHeight ?? height);
    const left = Math.round(screenX + (outerWidth - width) / 2);
    const top = Math.round(screenY + (outerHeight - height) / 2);
    const url = `${addon.base}/index.html#/add?link=${encodeURIComponent(spec)}`;
    // Raindrop opens this itself with windows.create({type: "popup"}), which is
    // a browser popup window: no toolbar, no tab strip, 420 by 600.
    const features =
      `popup,width=${width},height=${height},left=${left},top=${top},` +
      "resizable=yes,scrollbars=yes";
    const opened = [];

    // The extension makes this with windows.create({type: "popup"}): a window of
    // its own, with no toolbar and no tab strip. openDialog is the only way in
    // that passes strings alone — handing a window to a native call is what
    // failed with NS_ERROR_ILLEGAL_VALUE, twice, from both `window` and the
    // document's own view.
    const dialogFeatures =
      `centerscreen,dialog=no,chrome=no,resizable,width=${width},height=${height}`;
    for (const host of [parent, window]) {
      try {
        const made = host?.openDialog?.(url, "raindrop-add", dialogFeatures, null);
        if (made) {
          made.focus?.();
          trace(`glance bookmark: Raindrop's dialog window: ${whereOf(made)}`);
          return true;
        }
        opened.push("a dialog window was not made");
      } catch (e) {
        opened.push(`a dialog window failed (${e?.name ?? e})`);
      }
    }

    try {
      const watcher = Services.ww?.openWindow?.(parent, url, "raindrop-add", features, null);
      if (watcher) {
        watcher.focus?.();
        trace(`glance bookmark: Raindrop's dialog, window watcher: ${whereOf(watcher)}`);
        return true;
      }
      opened.push("the window watcher returned nothing");
    } catch (e) {
      opened.push(`the window watcher failed (${e?.name ?? e})`);
    }

    try {
      const plain = parent?.open?.(url, "raindrop-add", features);
      if (plain) {
        trace(`glance bookmark: Raindrop's dialog, window.open: ${whereOf(plain)}`);
        return true;
      }
      opened.push("window.open returned nothing");
    } catch (e) {
      opened.push(`window.open failed (${e?.name ?? e})`);
    }

    // A tab always works, and the page is the same page.
    try {
      const tab = gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground: false,
      });
      if (tab) {
        trace(`glance bookmark: Raindrop's dialog in a tab, after ${opened.join("; ")}`);
        return true;
      }
    } catch (e) {
      opened.push(`a tab failed (${e?.name ?? e})`);
    }

    trace(`glance bookmark: could not open Raindrop: ${opened.join("; ")}`);
    return false;
  }

  /**
   * The real chrome window behind an element. A mod's script runs in a sandbox,
   * so the `window` it can see is not an nsIDOMWindow: passing it to the window
   * watcher, or calling open on it, fails with NS_ERROR_ILLEGAL_VALUE no matter
   * how right the rest of the call is. The element's own document knows the
   * window that drew it.
   */
  function chromeWindowOf(element) {
    try {
      const win = element?.ownerDocument?.defaultView;
      if (win) {
        return win;
      }
    } catch (e) {
      /* fall through to the window list */
    }
    try {
      return Services.wm.getMostRecentWindow("navigator:browser") ?? null;
    } catch (e) {
      return null;
    }
  }

  /** How far an element reaches across its line, for the log. */
  function spanOf(element) {
    try {
      const rect = element?.getBoundingClientRect?.();
      if (!rect) {
        return "?";
      }
      return `${Math.round(rect.left)}-${Math.round(rect.right)}`;
    } catch (e) {
      return "?";
    }
  }

  /** What a window ended up loading, for the log. */
  function whereOf(opened) {
    try {
      return String(
        opened?.gBrowser?.currentURI?.spec ??
          opened?.location?.href ??
          opened?.document?.location?.href ??
          "a window"
      ).slice(0, 120);
    } catch (e) {
      return "a window";
    }
  }

  function onGlanceBookmarkClick(event) {
    const button = event.target?.closest?.(`.${GLANCE_BOOKMARK}`);
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (bookmarkMode() === "raindrop") {
      openRaindropDialog(glanceBrowserOf(button));
      return;
    }
    bookmarkGlancePage(glanceBrowserOf(button));
  }

  function installGlanceBookmarkButton() {
    refreshGlanceBookmarkButtons();
    findRaindrop();
  }

  function onBookmarkPrefChange() {
    refreshGlanceBookmarkButtons();
    findRaindrop();
  }

  function watchBookmarkPref() {
    try {
      Services.prefs.addObserver(BOOKMARK_PREF, onBookmarkPrefChange);
      return true;
    } catch (e) {
      trace(`glance bookmark: no preference to watch ${e?.message ?? e}`);
      return false;
    }
  }

  function unwatchBookmarkPref() {
    try {
      Services.prefs.removeObserver(BOOKMARK_PREF, onBookmarkPrefChange);
    } catch (e) {
      /* stopping twice is not a problem */
    }
  }

  function installGlanceCopyButton() {
    try {
      const container = document
        .getElementById("zen-glance-sidebar-template")
        ?.content?.querySelector(".zen-glance-sidebar-container");
      return addGlanceCopyButton(container);
    } catch (e) {
      trace(`glance copy: no template ${e?.message ?? e}`);
      return null;
    }
  }

  /** The page the glance is showing, which is not always the selected tile. */
  function glanceBrowserOf(button) {
    const host = button?.closest?.(".browserSidebarContainer");
    const browser = host?.querySelector?.("browser");
    if (browser) {
      return browser;
    }
    return gBrowser.selectedBrowser ?? null;
  }

  /**
   * The address bar's own copy, for the page the glance is showing. Zen's
   * action is the same one its keyboard shortcut uses, so it is preferred; it
   * reads the selected browser, so it is only used when that is this page.
   */
  function copyGlanceUrl(browser) {
    const actions = window.gZenCommonActions;
    if (actions?.copyCurrentURLToClipboard && gBrowser.selectedBrowser === browser) {
      actions.copyCurrentURLToClipboard();
      return true;
    }

    const spec = String(browser?.currentURI?.spec ?? browser?.userTypedValue ?? "");
    if (!spec) {
      return false;
    }
    let uri = null;
    try {
      uri = Services.io.newURI(spec);
    } catch (e) {
      return false;
    }
    let copyURI = uri;
    try {
      const stripper = Cc["@mozilla.org/url-query-string-stripper;1"].getService(
        Ci.nsIURLQueryStringStripper
      );
      copyURI = stripper.stripForCopyOrShare(uri) ?? uri;
    } catch (e) {
      /* an older build without the stripper copies the address as it is */
    }
    let readable = copyURI;
    try {
      readable = gURLBar.makeURIReadable(copyURI) ?? copyURI;
    } catch (e) {
      /* readable form is a nicety, the URI is the answer */
    }
    let text = readable.displaySpec;
    try {
      if (
        Services.prefs.getBoolPref("browser.urlbar.decodeURLsOnCopy", false) &&
        !readable.schemeIs("data")
      ) {
        text = decodeURI(text);
      }
    } catch (e) {
      /* the address as it stands */
    }
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(text);
    } catch (e) {
      trace(`glance copy: no clipboard ${e?.message ?? e}`);
      return false;
    }
    try {
      gZenUIManager.showToast?.("zen-copy-current-url-confirmation", { timeout: 3000 });
    } catch (e) {
      /* the copy happened, the toast is a courtesy */
    }
    return true;
  }

  function onGlanceCopyClick(event) {
    const button = event.target?.closest?.(`.${GLANCE_COPY}`);
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    copyGlanceUrl(glanceBrowserOf(button));
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
    if (blockedByDomain(parent, url) || sourceRowBlocks(parent, url)) {
      return null;
    }
    // A row for this site answers on its own, whatever the global switch says.
    const rule = domainRuleFor(url);
    if (rule) {
      if (!rule.links || !linkMatchesRule(rule, url)) {
        return null;
      }
      return { url, parent, kind: "normal", site: rule.host, via: "redirect" };
    }
    if (!setting("redirect") || sourceKind(parent) !== "normal") {
      return null;
    }
    return { url, parent, kind: "normal", via: "redirect" };
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
    const next = [...current, { host, tabs: true, links: false, domain: false, paths: [] }];
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
    row.appendChild(makeBox("links", rule.links, `Links on ${rule.host}`));
    row.appendChild(makeBox("tabs", rule.tabs, `New tabs on ${rule.host}`));
    row.appendChild(makeBox("domain", rule.domain, `Same domain only on ${rule.host}`));
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
    const addButton = el(doc, "span", "zgp-addbutton zgp-glyph");
    addButton.setAttribute("role", "button");
    addButton.setAttribute("tabindex", "0");
    addButton.setAttribute("data-act", "addpath");
    addButton.setAttribute("title", "Add pattern");
    addButton.setAttribute("aria-label", `Add a link pattern for ${rule.host}`);
    addButton.textContent = "+";
    add.appendChild(input);
    add.appendChild(addButton);
    paths.appendChild(add);

    const chips = el(doc, "div", "zgp-chips");
    rule.paths.forEach((pattern, position) => {
      const chip = el(doc, "span", "zgp-chip");
      chip.setAttribute("data-index", String(position));
      const text = el(doc, "span", "zgp-chip-text");
      text.textContent = pattern;
      const kill = el(doc, "span", "zgp-chip-remove");
      kill.setAttribute("role", "button");
      kill.setAttribute("tabindex", "0");
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
    const addButton = el(doc, "span", "zgp-addbutton");
    addButton.setAttribute("role", "button");
    addButton.setAttribute("tabindex", "0");
    addButton.setAttribute("data-act", "add");
    addButton.setAttribute("aria-label", "Add site");
    addButton.textContent = "Add";
    add.appendChild(input);
    add.appendChild(addButton);
    root.appendChild(add);

    const head = el(doc, "div", "zgp-head");
    for (const title of ["Site", "Link", "New tabs", "Domain", ""]) {
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
  const watchedTableDocs = new WeakSet();
  const prefsAttempts = new WeakMap();
  const prefsTimers = new Map();

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
    if (
      action === "toggle" ||
      action === "remove" ||
      action === "addpath" ||
      action === "add" ||
      action === "removepath"
    ) {
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
      watchTableDocument(win, doc);
      if (typeof table.addEventListener !== "function") {
        return true;
      }
      table.addEventListener("click", event => onTableClick(win, event));
      table.addEventListener("change", event => onTableChange(win, event));
      table.addEventListener("keydown", event => onTableKeydown(win, event));
      loadTableStyles(win);
      return true;
    }
    const attempts = (prefsAttempts.get(win) ?? 0) + 1;
    prefsAttempts.set(win, attempts);
    if (attempts === 1 || attempts % 8 === 0) {
      const docs = settingsDocuments(win);
      const where = docs.map(documentFingerprint).join(" ;; ");
      trace(`table: no place for it in ${docs.length} documents, attempt ${attempts} :: ${where}`);
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
  /**
   * Sine builds a mod's settings inside its Configure dialog and rebuilds that
   * content whenever the dialog is opened again, which throws the table away
   * with it. Watch the document the table landed in, whatever document that is,
   * so the next rebuild puts it back.
   */
  /** One compact line about a document, so a failed placement can be read. */
  function documentFingerprint(doc) {
    const bits = [];
    try {
      bits.push(String(doc.location?.href ?? "?").slice(-40));
    } catch (e) {
      bits.push("no-href");
    }
    try {
      const dialog = doc.querySelector?.(
        "#sineItemPreferenceDialogContent, .sineItemPreferenceDialogContent"
      );
      bits.push(dialog ? "dialog" : "no-dialog");
    } catch (e) {
      bits.push("dialog?");
    }
    try {
      const labels = Array.from(doc.querySelectorAll?.(".separator-label") ?? []);
      bits.push(`labels=${labels.length}`);
    } catch (e) {
      bits.push("labels?");
    }
    try {
      const ids = Array.from(doc.querySelectorAll?.("[id^='zen-glance-plus']") ?? []).map(
        el => el.id
      );
      bits.push(ids.length ? `ids=${ids.slice(0, 3).join("|")}` : "ids=none");
    } catch (e) {
      bits.push("ids?");
    }
    try {
      bits.push(String(doc.body?.textContent ?? "").includes("Sites") ? "sites-text" : "no-sites-text");
    } catch (e) {
      bits.push("text?");
    }
    return bits.join(" ");
  }

  function watchTableDocument(win, doc) {
    if (!doc?.documentElement || watchedTableDocs.has(doc)) {
      return;
    }
    watchedTableDocs.add(doc);
    const Observer = win?.MutationObserver ?? window.MutationObserver;
    if (typeof Observer !== "function") {
      return;
    }
    let queued = false;
    try {
      new Observer(() => {
        if (queued) {
          return;
        }
        queued = true;
        win.setTimeout(() => {
          queued = false;
          if (!doc.getElementById?.(UI_TABLE)) {
            trace("table: gone from the settings page, putting it back");
            injectTable(win);
          }
        }, 150);
      }).observe(doc.documentElement, { childList: true, subtree: true });
    } catch (e) {
      trace(`table: cannot watch that document ${e?.message ?? e}`);
    }
  }

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
    // A restored settings tab draws its sections during startup, before this
    // code is reached, and then nothing mutates again. Ask on a timer as well,
    // until the table lands or the budget runs out.
    if (typeof win.setInterval === "function" && !prefsTimers.has(win)) {
      const id = win.setInterval(() => {
        const attempts = prefsAttempts.get(win) ?? 0;
        if (injectTable(win) || attempts >= 60) {
          win.clearInterval?.(id);
          prefsTimers.delete(win);
        }
      }, 250);
      prefsTimers.set(win, { win, id });
    }
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
      // A link followed from inside a Glance loads in that Glance. Letting the
      // tab through would either start a second Glance or leave the overlay
      // behind the tab the click created, and both break Zen's bookkeeping.
      const opener = (() => {
        try {
          return parentFor(params);
        } catch (e) {
          return null;
        }
      })();
      if (!plan && isGlanceTab(opener)) {
        const target = glanceableUrl(
          typeof uriString === "string" ? uriString : uriString?.spec
        );
        if (target && wouldGlanceFromBase(uriString) && loadInOpenGlance(target)) {
          trace(`addTab in open glance ${target.slice(0, 120)}`);
          return theGlanceTab() ?? opener;
        }
        // Anything else was asked for as a tab, so it becomes one.
        trace(`addTab beside open glance ${String(uriString).slice(0, 120)}`);
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
    installGlanceCopyButton();
    // The save button sits to the left of copy, so it goes in after it.
    installGlanceBookmarkButton();
    watchBookmarkPref();
    window.addEventListener("click", onGlanceCopyClick, true);
    window.addEventListener("click", onGlanceBookmarkClick, true);
    // A restored settings tab can be reached through a content window that the
    // real page later replaces, and that new window is not the one that was
    // hooked. Look again for a while after start, then let it be.
    if (typeof setInterval === "function") {
      let scans = 0;
      state.prefsScan = setInterval(() => {
        scans += 1;
        scanPreferencesTabs();
        if (scans >= 40) {
          clearInterval(state.prefsScan);
          state.prefsScan = null;
        }
      }, 500);
    }
    window.addEventListener(
      "unload",
      () => {
        stop();
      },
      { once: true }
    );
    offerNewPresets();
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
    window.removeEventListener("click", onGlanceCopyClick, true);
    window.removeEventListener("click", onGlanceBookmarkClick, true);
    unwatchBookmarkPref();
    gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen, true);
    gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect, true);
    if (state.prefsScan) {
      clearInterval(state.prefsScan);
      state.prefsScan = null;
    }
    for (const entry of prefsTimers.values()) {
      try {
        entry.win.clearInterval?.(entry.id);
      } catch (e) {
        /* the window is gone, and its timers went with it */
      }
    }
    prefsTimers.clear();
  }

  const api = {
    LOG,
    start,
    stop,
    status,
    sourceKind,
    planFor,
    planFrom,
    redirectPlan,
    setting,
    state,
    PREF,
    DEFAULTS,
    // Sites
    normaliseDomain,
    registrableDomain,
    blockedByDomain,
    sourceRowBlocks,
    offerNewPresets,
    readSeeded,
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
    hookPreferences,
    addGlanceCopyButton,
    installGlanceCopyButton,
    COPY_ICON,
    copyGlanceUrl,
    glanceBrowserOf,
    theGlanceTab,
    glanceBaseTab,
    openGlanceBrowser,
    loadInOpenGlance,
    wouldGlanceFromBase,
    onGlanceCopyClick,
    GLANCE_COPY,
    onGlanceBookmarkClick,
    GLANCE_BOOKMARK,
    BOOKMARK_ICON,
    BOOKMARK_PREF,
    bookmarkMode,
    addGlanceBookmarkButton,
    refreshGlanceBookmarkButtons,
    bookmarkGlancePage,
    hideBookmarkDialogIcon,
    openRaindropDialog,
    RAINDROP_CLOUD,
    raindropBase,
    findRaindrop,
    installGlanceBookmarkButton,
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

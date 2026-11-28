// CloudSave: copies each game's save into a "saves/" folder of a GitHub repo
// using the GitHub "contents" API. The phone's own storage stays the main copy;
// this only ever ADDS a backup, and only restores when a game has no local save.
//
// Files created in the repo (standard raw .sav, usable in other emulators):
//   saves/<game>.sav        battery save (raw bytes)
//   saves/<game>.rtc.json   clock data (Gold / Crystal only)
var CloudSave = (function () {
  var CFG_KEY = "gb_sync_cfg";
  var cfg = null;
  var queue = [];
  // Worker mode: when sync-config.js sets CLOUD_WORKER_URL, saves go through your
  // Cloudflare Worker (it holds the GitHub token), so the phone needs no setup.
  var W = (typeof CLOUD_WORKER_URL === "string" ? CLOUD_WORKER_URL : "").replace(/\s+/g, "").replace(/\/+$/, "");
  function workerMode() { return !!W; }

  function wreq(method, path, body, cb) {     // cb(err, status, json)
    var x = new XMLHttpRequest(), finished = false;
    function done(e, s, j) { if (!finished) { finished = true; cb(e, s, j); } }
    try {
      x.open(method, W + path, true);
      if (body) x.setRequestHeader("Content-Type", "application/json");
      x.timeout = 20000;
      x.onload = function () {
        var j = null;
        try { j = JSON.parse(x.responseText); } catch (e) {}
        done(null, x.status, j);
      };
      x.onerror = function () { done("network error"); };
      x.ontimeout = function () { done("timeout"); };
      x.send(body ? JSON.stringify(body) : null);
    } catch (e) { done(String(e.message || e)); }
  }
  function werr(status, json) {
    return "server " + status + ((json && json.error) ? " " + json.error : "");
  }
  var busy = false;

  function load() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY));
      if (c && c.repo && c.token) {
        c.branch = c.branch || "main";
        return c;
      }
    } catch (e) {}
    return null;
  }
  cfg = load();

  function setConfig(c) {
    localStorage.setItem(CFG_KEY, JSON.stringify({
      repo: String(c.repo || "").replace(/^\s+|\s+$/g, ""),
      branch: String(c.branch || "main").replace(/^\s+|\s+$/g, ""),
      token: String(c.token || "").replace(/^\s+|\s+$/g, "")
    }));
    cfg = load();
  }
  function clearConfig() {
    try { localStorage.removeItem(CFG_KEY); } catch (e) {}
    cfg = null;
  }
  function getConfig() { return W ? { repo: "cloud", branch: "", token: "" } : cfg; }
  function configured() { return !!W || !!cfg; }

  // One-time setup from the address:  jio.html#sync=owner/repo@branch:TOKEN
  // The token is stored on the phone and then removed from the address bar.
  function setupFromHash() {
    try {
      var m = /^#sync=([^@:\/]+\/[^@:\/]+)(?:@([^:]+))?:(.+)$/.exec(window.location.hash);
      if (!m) return false;
      setConfig({ repo: m[1], branch: m[2] || "main", token: m[3] });
      if (window.history && history.replaceState) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } else {
        window.location.hash = "";
      }
      return true;
    } catch (e) { return false; }
  }

  function api(method, path, body, cb) {
    var url = "https://api.github.com/repos/" + cfg.repo + "/contents/" + path;
    if (method === "GET") {
      url += "?ref=" + encodeURIComponent(cfg.branch) + "&_=" + (new Date().getTime());
    }
    var x = new XMLHttpRequest();
    var finished = false;
    function done(err, status, json) {
      if (finished) return;
      finished = true;
      cb(err, status, json);
    }
    try {
      x.open(method, url, true);
      x.setRequestHeader("Authorization", "token " + cfg.token);
      x.setRequestHeader("Accept", "application/vnd.github+json");
      if (body) x.setRequestHeader("Content-Type", "application/json");
      x.timeout = 20000;
      x.onload = function () {
        var j = null;
        try { j = JSON.parse(x.responseText); } catch (e) {}
        done(null, x.status, j);
      };
      x.onerror = function () { done("network error"); };
      x.ontimeout = function () { done("timeout"); };
      x.send(body ? JSON.stringify(body) : null);
    } catch (e) {
      done(String(e.message || e));
    }
  }

  function describe(status, json) {
    var msg = (json && json.message) ? json.message : "";
    if (status === 401) return "bad token (401)";
    if (status === 403) return "no permission (403) " + msg;
    if (status === 404) return "repo/branch not found (404)";
    return "HTTP " + status + " " + msg;
  }

  // ---- put one file (creates it, or updates it if it exists) ----
  function putFile(path, b64, message, cb, retried) {
    api("GET", path, null, function (err, status, json) {
      if (err) return cb(err);
      var sha = null;
      if (status === 200 && json && json.sha) sha = json.sha;
      else if (status !== 404) return cb(describe(status, json));
      var body = { message: message, content: b64, branch: cfg.branch };
      if (sha) body.sha = sha;
      api("PUT", path, body, function (err2, st2, j2) {
        if (err2) return cb(err2);
        if (st2 === 200 || st2 === 201) return cb(null);
        if ((st2 === 409 || st2 === 422) && !retried) {
          return putFile(path, b64, message, cb, true);   // file changed meanwhile, try once more
        }
        cb(describe(st2, j2));
      });
    });
  }

  function getFile(path, cb) {   // cb(err, base64 or null when the file does not exist)
    api("GET", path, null, function (err, status, json) {
      if (err) return cb(err);
      if (status === 404) return cb(null, null);
      if (status !== 200 || !json) return cb(describe(status, json));
      if (typeof json.content === "string") {
        return cb(null, json.content.replace(/\s+/g, ""));
      }
      cb("file too large");
    });
  }

  // ---- tiny job queue so two uploads never race each other ----
  function enqueue(job) {
    queue.push(job);
    if (!busy) next();
  }
  function next() {
    if (!queue.length) { busy = false; return; }
    busy = true;
    var job = queue.shift();
    job(function () { next(); });
  }

  function push(slug, savB64, rtcText, cb) {
    if (W) {
      enqueue(function (release) {
        wreq("PUT", "/save/" + slug, { sav: savB64, rtc: rtcText || null }, function (err, st, j) {
          release();
          if (cb) cb(err || (st === 200 ? null : werr(st, j)));
        });
      });
      return;
    }
    if (!cfg) { if (cb) cb("not set up"); return; }
    enqueue(function (release) {
      var stamp = (new Date()).toISOString();
      putFile("saves/" + slug + ".sav", savB64, "Save: " + slug + " (" + stamp + ")", function (err) {
        if (err) { release(); if (cb) cb(err); return; }
        if (!rtcText) { release(); if (cb) cb(null); return; }
        putFile("saves/" + slug + ".rtc.json", btoa(rtcText), "Clock: " + slug + " (" + stamp + ")", function (err2) {
          release();
          if (cb) cb(err2 || null);
        });
      });
    });
  }

  // cb(err, { sav: base64, rtc: text or null } or null when nothing is stored)
  function pull(slug, cb) {
    if (W) {
      enqueue(function (release) {
        wreq("GET", "/save/" + slug, null, function (err, st, j) {
          release();
          if (err) return cb(err, null);
          if (st !== 200 || !j) return cb(werr(st, j), null);
          cb(null, j.sav ? { sav: j.sav, rtc: j.rtc || null } : null);
        });
      });
      return;
    }
    if (!cfg) { cb("not set up"); return; }
    enqueue(function (release) {
      getFile("saves/" + slug + ".sav", function (err, sav) {
        if (err || !sav) { release(); cb(err, null); return; }
        getFile("saves/" + slug + ".rtc.json", function (err2, rtc) {
          release();
          var rtcText = null;
          try { if (rtc) rtcText = atob(rtc); } catch (e) {}
          cb(null, { sav: sav, rtc: rtcText });
        });
      });
    });
  }

  // Checks the repo, branch and token (read access only).
  function test(cb) {
    if (W) { wreq("GET", "/ping", null, function (err, st, j) { cb(err || (st === 200 ? null : werr(st, j))); }); return; }
    if (!cfg) { cb("not set up"); return; }
    var x = new XMLHttpRequest();
    var finished = false;
    function done(e) { if (!finished) { finished = true; cb(e); } }
    try {
      x.open("GET", "https://api.github.com/repos/" + cfg.repo, true);
      x.setRequestHeader("Authorization", "token " + cfg.token);
      x.timeout = 15000;
      x.onload = function () {
        var j = null;
        try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status !== 200) return done(describe(x.status, j));
        if (j && j.permissions && j.permissions.push === false) return done("token can read but not write");
        done(null);
      };
      x.onerror = function () { done("network error"); };
      x.ontimeout = function () { done("timeout"); };
      x.send(null);
    } catch (e) { done(String(e.message || e)); }
  }

  return {
    workerMode: workerMode, configured: configured, getConfig: getConfig, setConfig: setConfig, clearConfig: clearConfig,
    setupFromHash: setupFromHash, push: push, pull: pull, test: test
  };
})();

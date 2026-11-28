    // ------------------------------------------------------------------
    // GAME LIST  -  to add a game: copy the ROM next to this file and add
    // one line here. The save slot is created automatically from the file
    // name (e.g. "crystal.gbc" -> "gb_sram_crystal_gbc").
    // "saveKey" is only for a game that already has an old save.
    // ------------------------------------------------------------------
    var GAMES = [
      { title: "Pokemon Red", file: "rom.gb", saveKey: "pkmn_red_sram" },
      { title: "Pokemon Crystal", file: "crystal.gbc" },
      { title: "Pokemon Gold", file: "gold.gbc" },
      { title: "Zelda: Link's Awakening", file: "zelda.gbc" },
      { title: "Pokemon TCG", file: "tcg.gbc" }
    ];

    var wrapEl = document.getElementById("wrap");
    var menuEl = document.getElementById("menu");
    var listEl = document.getElementById("game-list");
    var canvas = document.getElementById("gb");
    var bar = document.getElementById("bar");
    var settingsEl = document.getElementById("settings");
    var cloudLine = document.getElementById("cloud-line");

    var gb = null;
    var activeGame = null;
    var SAVE_KEY = "";
    var RTC_KEY = "";
    var saveReady = true;      // becomes false only if an existing save could not be read
    var inMenu = true;
    var inSettings = false;
    var soundOn = true;        // remembered in "gb_sound"; sound stays ON unless you turn it off with key 5
    var selectedIdx = 0;
    var romExists = {};        // file -> true/false, filled in by checkRoms()
    var defaultBar = "2/4/6/8: Move | 1: A | 3: B\n0: Start | 9: Select | 7: Full\n*: Save | 5: Sound | #: Menu";

    // Always use textContent so a file name can never be run as HTML.
    function setBar(text) { bar.textContent = text; }
    function flashBar(text, ms) {
      setBar(text);
      setTimeout(function () { setBar(defaultBar); }, ms || 1500);
    }

    function getSaveKey(game) {
      if (game.saveKey) return game.saveKey;
      return "gb_sram_" + game.file.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    }

    function hasRealSave(game) {
      try {
        var s = localStorage.getItem(getSaveKey(game));
        if (!s) return false;
        var arr = JSON.parse(s);
        for (var i = 0; i < arr.length; i++) { if (arr[i] !== 0) return true; }
      } catch (e) {}
      return false;
    }

    function getQueryRom() {
      try {
        var q = window.location.search.replace(/^\?/, "").split("&");
        for (var i = 0; i < q.length; i++) {
          var pair = q[i].split("=");
          if (pair[0] === "rom" && pair[1]) return decodeURIComponent(pair[1]);
        }
      } catch (e) {}
      return "";
    }

    // ---------------- CLOUD SAVE HELPERS ----------------
    // Name used for the files in the repo, e.g. "Pokemon Red" -> saves/pokemon-red.sav
    function getSlug(game) {
      return game.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
    }
    function bytesToB64(arr) {
      var s = "", CH = 8192;
      for (var i = 0; i < arr.length; i += CH) {
        s += String.fromCharCode.apply(null, Array.prototype.slice.call(arr, i, i + CH));
      }
      return btoa(s);
    }
    function b64ToArray(b64) {
      var bin = atob(b64), out = new Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
      return out;
    }
    function quickHash(str) {
      var h = 5381;
      for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
      return str.length + ":" + h;
    }
    function hashKey(game) { return "gb_sync_h_" + getSlug(game); }

    // Upload this game's LOCAL save to the repo (only if it changed since the last upload).
    function pushGame(game, cb) {
      try {
        if (!CloudSave.configured()) { if (cb) cb("off"); return; }
        if (!hasRealSave(game)) { if (cb) cb("none"); return; }
        var key = getSaveKey(game);
        var b64 = bytesToB64(JSON.parse(localStorage.getItem(key)));
        var h = quickHash(b64);
        if (localStorage.getItem(hashKey(game)) === h) { if (cb) cb(null, "same"); return; }
        var rtc = localStorage.getItem(key + "_rtc");
        CloudSave.push(getSlug(game), b64, rtc, function (err) {
          if (!err) { try { localStorage.setItem(hashKey(game), h); } catch (e) {} }
          if (cb) cb(err, "sent");
        });
      } catch (e) { if (cb) cb(String(e.message || e)); }
    }

    // Restore from the repo ONLY when this game has no local save. A save on the phone is never overwritten.
    function pullGame(game, cb) {
      try {
        if (!CloudSave.configured() || hasRealSave(game)) { cb(null, false); return; }
        CloudSave.pull(getSlug(game), function (err, res) {
          if (err || !res) { cb(err, false); return; }
          try {
            var arr = b64ToArray(res.sav), any = false;
            for (var i = 0; i < arr.length; i++) { if (arr[i] !== 0) { any = true; break; } }
            if (!any) { cb(null, false); return; }
            var key = getSaveKey(game);
            localStorage.setItem(key, JSON.stringify(arr));
            if (res.rtc) localStorage.setItem(key + "_rtc", res.rtc);
            localStorage.setItem(hashKey(game), quickHash(res.sav));
            cb(null, true);
          } catch (e) { cb(String(e.message || e), false); }
        });
      } catch (e) { cb(String(e.message || e), false); }
    }

    // Upload every game that has a local save the repo has not seen yet.
    function syncAll() {
      if (!CloudSave.configured()) return;
      for (var i = 0; i < GAMES.length; i++) { pushGame(GAMES[i], null); }
    }

    function updateCloudLine() {
      var c = CloudSave.getConfig();
      if (CloudSave.workerMode()) { cloudLine.textContent = ""; return; }
      cloudLine.textContent = c ? ("Cloud saves: ON (" + c.repo + ")") : "Cloud saves: OFF";
    }

    // ---------------- SETTINGS SCREEN ----------------
    var setFields = ["set-repo", "set-branch", "set-token", "set-save", "set-clear", "set-back"];
    function setStatus(t) { document.getElementById("set-status").textContent = t; }
    function openSettings() {
      var c = CloudSave.getConfig() || {};
      document.getElementById("set-repo").value = c.repo || "";
      document.getElementById("set-branch").value = c.branch || "main";
      document.getElementById("set-token").value = c.token || "";
      setStatus(CloudSave.configured() ? "Currently ON" : "Currently OFF");
      menuEl.style.display = "none";
      settingsEl.style.display = "block";
      inSettings = true;
      document.getElementById("set-repo").focus();
    }
    function closeSettings() {
      inSettings = false;
      settingsEl.style.display = "none";
      menuEl.style.display = "block";
      updateCloudLine();
      renderMenu();
      lockFocus();
    }
    function moveSettingsFocus(delta) {
      var cur = setFields.indexOf(document.activeElement && document.activeElement.id);
      var n = (cur < 0 ? 0 : (cur + delta + setFields.length) % setFields.length);
      document.getElementById(setFields[n]).focus();
    }
    function settingsAction(id) {
      if (id === "set-back") { closeSettings(); }
      else if (id === "set-clear") {
        CloudSave.clearConfig();
        setStatus("Cloud saves OFF.\nSaves stay on this phone.");
      } else if (id === "set-save") {
        CloudSave.setConfig({
          repo: document.getElementById("set-repo").value,
          branch: document.getElementById("set-branch").value,
          token: document.getElementById("set-token").value
        });
        if (!CloudSave.configured()) { setStatus("Fill in repo and token"); return; }
        setStatus("Testing...");
        CloudSave.test(function (err) {
          if (err) { setStatus("FAILED: " + err + "\n(settings kept)"); return; }
          setStatus("OK! Uploading saves...");
          syncAll();
          setTimeout(function () { setStatus("OK. Cloud saves ON."); }, 1500);
        });
      }
    }
    function handleSettingsKey(e, isDown) {
      if (!isDown) return;
      var k = e.key, id = document.activeElement && document.activeElement.id;
      var isBtn = (id === "set-save" || id === "set-clear" || id === "set-back");
      if (k === "ArrowDown" || e.keyCode === 40) { e.preventDefault(); moveSettingsFocus(1); }
      else if (k === "ArrowUp" || e.keyCode === 38) { e.preventDefault(); moveSettingsFocus(-1); }
      else if (k === "Enter" || e.keyCode === 13) {
        e.preventDefault();
        if (isBtn) settingsAction(id); else moveSettingsFocus(1);
      } else if (k === "Escape" || k === "SoftRight" || e.keyCode === 27) {
        e.preventDefault(); closeSettings();
      }
      // every other key (digits, letters, backspace) is left alone so you can type
    }

    // ---------------- MENU ----------------
    function renderMenu() {
      listEl.innerHTML = "";
      for (var i = 0; i < GAMES.length; i++) {
        (function (idx) {
          var g = GAMES[idx];
          var missing = (romExists[g.file] === false);
          var tag = missing ? "NO ROM" : (hasRealSave(g) ? "SAVED" : g.file);
          var row = document.createElement("div");
          row.className = "game-item" + (idx === selectedIdx ? " active" : "") + (missing ? " missing" : "");
          var t1 = document.createElement("span");
          t1.textContent = g.title;
          var t2 = document.createElement("span");
          t2.className = "tag";
          t2.textContent = tag;
          row.appendChild(t1);
          row.appendChild(t2);
          row.onclick = function () { selectedIdx = idx; launchGame(GAMES[idx]); };
          listEl.appendChild(row);
          if (idx === selectedIdx && row.scrollIntoView) {
            try { row.scrollIntoView({ block: "nearest" }); } catch (e) {}
          }
        })(i);
      }
      // last row: cloud save settings (hidden when the Worker handles everything)
      if (CloudSave.workerMode()) return;
      var srow = document.createElement("div");
      srow.className = "game-item" + (selectedIdx === GAMES.length ? " active" : "");
      var s1 = document.createElement("span");
      s1.textContent = "Cloud save settings";
      var s2 = document.createElement("span");
      s2.className = "tag";
      s2.textContent = CloudSave.configured() ? "ON" : "OFF";
      srow.appendChild(s1);
      srow.appendChild(s2);
      srow.onclick = function () { selectedIdx = GAMES.length; openSettings(); };
      listEl.appendChild(srow);
      if (selectedIdx === GAMES.length && srow.scrollIntoView) {
        try { srow.scrollIntoView({ block: "nearest" }); } catch (e) {}
      }
    }

    // Ask the server which ROM files actually exist (greys out missing ones).
    function checkRoms() {
      GAMES.forEach(function (g) {
        try {
          var x = new XMLHttpRequest();
          x.open("HEAD", g.file, true);
          x.onload = function () {
            romExists[g.file] = (x.status !== 404);   // only a clear 404 counts as missing
            if (inMenu) renderMenu();
          };
          x.onerror = function () {};
          x.send(null);
        } catch (e) {}
      });
    }

    function lockFocus() {
      try { window.focus(); canvas.focus(); } catch (e) {}
    }

    // ---------------- SAVE / LOAD ----------------
    function saveGame(silent) {
      try {
        if (!gb || !SAVE_KEY) return;
        if (!saveReady) {
          if (!silent) flashBar("NOT SAVED: old save could not be read", 2500);
          return;                                  // never overwrite a save we failed to load
        }
        if (!gb.cBATT) {
          if (!silent) flashBar("This game has no battery save", 2000);
          return;
        }
        var data = (gb.MBCRam && gb.MBCRam.length) ? Array.prototype.slice.call(gb.MBCRam) : null;
        if (!data || !data.length) return;

        // Do not write an all-zero (empty) save over nothing.
        var hasData = false;
        for (var i = 0; i < data.length; i++) { if (data[i] !== 0) { hasData = true; break; } }
        if (!hasData && !localStorage.getItem(SAVE_KEY)) {
          if (!silent) flashBar("Nothing to save yet - save in the game first", 2500);
          return;
        }

        localStorage.setItem(SAVE_KEY, JSON.stringify(data));

        // Games with a clock (Gold / Crystal) also need the clock saved.
        if (gb.cTIMER && typeof gb.saveRTCState === "function") {
          localStorage.setItem(RTC_KEY, JSON.stringify(gb.saveRTCState()));
        }
        if (!silent) {
          flashBar("SAVED (" + SAVE_KEY + ")", 1500);
          if (CloudSave.configured()) {
            pushGame(activeGame, function (err, how) {
              if (err && err !== "off" && err !== "none") flashBar("CLOUD ERR: " + err, 3000);
              else if (how === "sent") flashBar("Saved + sent to GitHub", 1800);
            });
          }
        }
      } catch (e) {
        if (!silent) flashBar("SAVE ERR: " + e.message, 2500);
      }
    }

    // Hooks the core calls itself while starting, so the save is in place
    // BEFORE the game runs its first instruction.
    function attachSaveHooks(core) {
      saveReady = true;
      core.openMBC = function () {
        try {
          var s = localStorage.getItem(SAVE_KEY);
          if (!s) return [];
          var arr = JSON.parse(s);
          if (!Array.isArray(arr)) throw new Error("bad save format");
          return arr;
        } catch (e) {
          saveReady = false;
          setBar("LOAD ERR: " + e.message);
          return [];
        }
      };
      // Only provide RTC data when a valid one exists (empty data would corrupt the clock).
      try {
        var r = localStorage.getItem(RTC_KEY);
        if (r) {
          var rtc = JSON.parse(r);
          if (Array.isArray(rtc) && rtc.length >= 13) {
            core.openRTC = function () { return rtc; };
          }
        }
      } catch (e) {}
    }

    function tickFrame() {
      if (!gb) return;
      gb.stopEmulator &= 1;
      gb.iterations = 0;
      gb.run();
    }

    // Size everything from the REAL window size (in pixels) instead of CSS "100%",
    // which KaiOS reports wrongly while entering/leaving fullscreen.
    function fitScreen() {
      var W = window.innerWidth || document.documentElement.clientWidth || 240;
      var H = window.innerHeight || document.documentElement.clientHeight || 320;
      wrapEl.style.width = W + "px";
      wrapEl.style.height = H + "px";
      if (inMenu) return;
      var barH = bar.offsetHeight + 6;                    // text under the picture
      var scale = Math.min(W / 160, (H - barH) / 144);    // keep the 160:144 shape
      if (!(scale > 0.5)) scale = Math.min(W / 160, H / 144);
      canvas.style.width = Math.floor(160 * scale) + "px";
      canvas.style.height = Math.floor(144 * scale) + "px";
    }
    // KaiOS reports the new size late, so measure again a few times.
    function fitSoon() {
      fitScreen();
      var waits = [100, 300, 800, 1700];
      for (var i = 0; i < waits.length; i++) setTimeout(fitScreen, waits[i]);
    }

    function toggleFullscreen() {
      var el = document.documentElement;
      if (!document.fullscreenElement && !document.mozFullScreenElement) {
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.mozRequestFullScreen) el.mozRequestFullScreen();
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      }
      fitSoon();
      // Shows the window size the phone reports (handy if the picture is still off).
      setTimeout(function () { flashBar("Screen: " + window.innerWidth + "x" + window.innerHeight, 1500); }, 900);
    }

    function bootEmulator(romBinary) {
      try {
        try { soundOn = (localStorage.getItem("gb_sound") !== "0"); } catch (e) {}
        settings[0] = soundOn;
        gb = new GameBoyCore(canvas, romBinary);
        attachSaveHooks(gb);
        gb.start();
        if (saveReady) setBar(defaultBar);
        lockFocus();
        setTimeout(function () {
          tickFrame();
          setInterval(tickFrame, 33);
          setInterval(function () { saveGame(true); }, 30000);
          // send to GitHub every 5 minutes, only if the save actually changed
          setInterval(function () { if (activeGame) pushGame(activeGame, null); }, 300000);
        }, 50);
      } catch (err) {
        gb = null;
        setBar("BOOT ERR: " + err.message + "\n#: Menu");
      }
    }

    function launchGame(game) {
      if (romExists[game.file] === false) {
        // stay in the menu and just tell the user
        var t = listEl.children[selectedIdx];
        if (t && t.lastChild) t.lastChild.textContent = "NO ROM!";
        return;
      }
      inMenu = false;
      activeGame = game;
      SAVE_KEY = getSaveKey(game);
      RTC_KEY = SAVE_KEY + "_rtc";
      document.title = game.title;
      menuEl.style.display = "none";
      canvas.style.display = "block";
      bar.style.display = "block";
      setBar("Loading " + game.file + "...");
      fitSoon();

      var xhr = new XMLHttpRequest();
      xhr.open("GET", game.file, true);
      var binary = true;
      try { xhr.responseType = "arraybuffer"; }
      catch (e) { binary = false; xhr.overrideMimeType("text/plain; charset=x-user-defined"); }
      xhr.onload = function () {
        var bin = "";
        if (xhr.status === 200 || xhr.status === 0) {
          if (binary && xhr.response && xhr.response.byteLength > 0x150) {
            // fast path: convert in big chunks instead of one byte at a time
            var u8 = new Uint8Array(xhr.response), CH = 16384, parts = [];
            for (var i = 0; i < u8.length; i += CH) {
              parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CH)));
            }
            bin = parts.join("");
          } else if (!binary && xhr.responseText && xhr.responseText.length > 0x150) {
            var raw = xhr.responseText, parts2 = [];
            for (var j = 0; j < raw.length; j++) parts2.push(String.fromCharCode(raw.charCodeAt(j) & 0xff));
            bin = parts2.join("");
          }
        }
        if (bin.length > 0x150) {
          var started = false;
          var go = function () {
            if (started) return;
            started = true;
            setBar("Starting " + game.title + "...");
            setTimeout(function () { bootEmulator(bin); }, 50);
          };
          // No save on the phone but one in the repo? Restore it before the game starts.
          if (CloudSave.configured() && !hasRealSave(game)) {
            setBar("Checking GitHub for a save...");
            setTimeout(go, 8000);                       // never wait longer than 8 s
            pullGame(game, function (err, restored) {
              if (restored) setBar("Save restored from GitHub");
              go();
            });
          } else {
            go();
          }
        } else {
          setBar("MISSING FILE: " + game.file + " (HTTP " + xhr.status + ")\n#: Menu");
        }
      };
      xhr.onerror = function () { setBar("ROM NETWORK ERROR\n#: Menu"); };
      xhr.send(null);
    }

    // Save, then reload the page: this cleanly stops the old game.
    function goToMenu() {
      var left = false;
      function leave() {
        if (left) return;
        left = true;
        window.location.href = window.location.pathname;
      }
      if (gb) {
        saveGame(true);
        if (CloudSave.configured() && activeGame) {
          setBar("Sending save to GitHub...");
          setTimeout(leave, 6000);                      // give up waiting after 6 s; it retries next start
          pushGame(activeGame, function () { setTimeout(leave, 100); });
          return;
        }
      }
      setTimeout(leave, 300);
    }

    // ---------------- KEYS ----------------
    var keyMap = {
      "6": 0, "ArrowRight": 0,
      "4": 1, "ArrowLeft": 1,
      "2": 2, "ArrowUp": 2,
      "8": 3, "ArrowDown": 3,
      "1": 4, "Enter": 4,
      "3": 5,
      "9": 6,
      "0": 7
    };

    var keyCodeMap = {
      39: 0, 54: 0, 102: 0,
      37: 1, 52: 1, 100: 1,
      38: 2, 50: 2, 104: 2,
      40: 3, 56: 3, 98: 3,
      49: 4, 13: 4, 97: 4, 35: 4,
      51: 5, 99: 5, 34: 5,
      57: 6, 105: 6,
      48: 7, 96: 7
    };

    function resolveBtn(e) {
      if (e.key && keyMap.hasOwnProperty(e.key)) return keyMap[e.key];
      if (keyCodeMap.hasOwnProperty(e.keyCode)) return keyCodeMap[e.keyCode];
      return -1;
    }

    function menuCount() { return GAMES.length + (CloudSave.workerMode() ? 0 : 1); }

    function handleMenuKey(e) {
      var btn = resolveBtn(e);
      if (btn === 2) {
        e.preventDefault();
        selectedIdx = (selectedIdx - 1 + menuCount()) % menuCount();
        renderMenu();
      } else if (btn === 3) {
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % menuCount();
        renderMenu();
      } else if (btn === 4) {
        e.preventDefault();
        if (selectedIdx === GAMES.length) openSettings(); else launchGame(GAMES[selectedIdx]);
      }
    }

    function toggleSound() {
      soundOn = !soundOn;
      settings[0] = soundOn;
      try { localStorage.setItem("gb_sound", soundOn ? "1" : "0"); } catch (e) {}
      if (gb) {
        if (soundOn) {
          if (gb.audioHandle) gb.changeVolume(); else gb.initSound();
        } else if (gb.audioHandle) {
          gb.audioHandle.changeVolume(0);
        }
      }
      flashBar("Sound " + (soundOn ? "ON" : "OFF"), 1200);
    }

    function handleKey(e, isDown) {
      if (inSettings) { handleSettingsKey(e, isDown); return; }
      if (inMenu) {
        if (isDown) handleMenuKey(e);
        return;
      }
      // "#" (or M) = back to menu. Works even if the ROM failed to load.
      // (keyCode 35 is NOT used here: it is the numpad "1" / A button.)
      if (e.key === "#" || e.key === "m" || e.key === "M" || e.keyCode === 163) {
        e.preventDefault();
        if (isDown) goToMenu();
        return;
      }
      if (!gb) return;
      if (e.key === "*" || e.keyCode === 42 || e.keyCode === 106) {
        e.preventDefault();
        if (isDown) saveGame(false);
        return;
      }
      if (e.key === "7" || e.keyCode === 55 || e.keyCode === 103) {
        e.preventDefault();
        if (isDown) toggleFullscreen();
        return;
      }
      if (e.key === "5" || e.keyCode === 53 || e.keyCode === 101) {
        e.preventDefault();
        if (isDown) toggleSound();
        return;
      }
      var btn = resolveBtn(e);
      if (btn !== -1) {
        e.preventDefault();
        gb.JoyPadEvent(btn, isDown);
      }
    }

    window.addEventListener("keydown", function (e) { handleKey(e, true); }, false);
    window.addEventListener("keyup", function (e) { handleKey(e, false); }, false);
    canvas.addEventListener("click", lockFocus, false);
    window.addEventListener("resize", fitSoon, false);
    window.addEventListener("orientationchange", fitSoon, false);
    document.addEventListener("fullscreenchange", fitSoon, false);
    document.addEventListener("mozfullscreenchange", fitSoon, false);

    // Save when the app is hidden or closed, not just every 30 seconds.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && gb) saveGame(true);
    }, false);
    window.addEventListener("pagehide", function () { if (gb) saveGame(true); }, false);

    window.onload = function () {
      lockFocus();
      fitScreen();
      CloudSave.setupFromHash();     // one-time setup via  jio.html#sync=owner/repo@main:TOKEN
      updateCloudLine();
      var qRom = getQueryRom();
      if (qRom) {
        var found = null;
        for (var i = 0; i < GAMES.length; i++) {
          if (GAMES[i].file === qRom) { found = GAMES[i]; break; }
        }
        launchGame(found || { title: qRom, file: qRom });
      } else {
        renderMenu();
        checkRoms();
        setTimeout(syncAll, 1500);   // back up any local save the repo has not seen yet
      }
    };
  
(function () {
  "use strict";
  var el = document.querySelector('script[data-base]');
  var B = el.dataset.base || "";
  var CSRF = el.dataset.csrf;

  function $(id) { return document.getElementById(id); }

  function flash(msg, bad) {
    var f = $("flash");
    if (!f) return;
    f.textContent = msg;
    f.className = "flash " + (bad ? "err" : "ok");
    f.hidden = false;
  }

  function post(path, data) {
    var body = new URLSearchParams();
    body.set("csrf_token", CSRF);
    Object.keys(data || {}).forEach(function (k) { body.set(k, data[k]); });
    return fetch(B + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": CSRF,
        "Accept": "application/json"
      },
      body: body.toString(),
      credentials: "same-origin"
    }).then(function (r) { return r.json().then(function (j) { return j; }); });
  }

  function get(path) {
    return fetch(B + path, {
      headers: { "Accept": "application/json" },
      credentials: "same-origin"
    }).then(function (r) {
      if (r.status === 401) { window.location.href = B + "/login"; return {}; }
      return r.json();
    });
  }

  function fmtUptime(s) {
    if (!s && s !== 0) return "-";
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + (s % 60) + "s";
    return s + "s";
  }

  function refresh() {
    get("/api/status").then(function (s) {
      var pill = $("status-pill");
      pill.textContent = s.streaming ? "live" : (s.core ? "idle" : "core down");
      pill.className = "pill " + (s.streaming ? "live" : (s.core ? "" : "err"));
      $("s-core").textContent = s.core ? "reachable" : "unreachable";
      $("s-state").textContent = (s.process && s.process.status) || "stopped";
      $("s-uptime").textContent = fmtUptime(s.process && s.process.uptime_seconds);
      $("s-reconn").textContent = (s.process && s.process.reconnect_count != null)
        ? s.process.reconnect_count : "-";
      $("s-egress").textContent = (s.egress && s.egress.primary) || "-";
      if (s.destination) {
        $("d-server").placeholder = s.destination.server ||
          "rtmps://a.rtmps.youtube.com/live2";
        $("d-key-suffix").textContent = s.destination.configured
          ? "Stored key suffix: " + s.destination.key_suffix : "";
        if (s.destination.configured) {
          $("d-server").value = s.destination.server;
        }
      }
      if (s.ingest) $("i-url").value = s.ingest.url;
      if (s.egress) $("e-route").value = s.egress.primary;
      $("btn-start").disabled = !s.destination || !s.destination.configured;
    });
  }

  $("btn-start").addEventListener("click", function () {
    $("btn-start").disabled = true;
    post("/api/start", { reencode: $("reencode").checked ? "1" : "0" })
      .then(function (r) { flash(r.ok ? "Restream started" : (r.error || "failed"), !r.ok); refresh(); })
      .catch(function () { flash("Network error", true); });
  });

  $("btn-stop").addEventListener("click", function () {
    post("/api/stop").then(function (r) {
      flash(r.ok ? "Restream stopped" : (r.error || "failed"), !r.ok); refresh();
    });
  });

  $("form-dest").addEventListener("submit", function (ev) {
    ev.preventDefault();
    post("/api/destination", {
      server: $("d-server").value.trim(), key: $("d-key").value.trim()
    }).then(function (r) {
      flash(r.ok ? "Destination saved" : (r.error || "failed"), !r.ok);
      if (r.ok) $("d-key").value = "";
      refresh();
    });
  });

  $("btn-clear").addEventListener("click", function () {
    post("/api/destination", { clear: "1" }).then(function (r) {
      flash(r.ok ? "Destination cleared" : "failed", !r.ok); refresh();
    });
  });

  $("btn-copy").addEventListener("click", function () {
    var i = $("i-url");
    i.removeAttribute("readonly"); i.select();
    var done = function () { i.setAttribute("readonly", "readonly"); };
    if (navigator.clipboard) { navigator.clipboard.writeText(i.value).then(done, done); }
    else { try { document.execCommand("copy"); } catch (e) {} done(); }
    flash("Publish URL copied", false);
  });

  $("btn-show").addEventListener("click", function () {
    get("/api/ingest").then(function (r) {
      var k = $("i-key");
      if (r && r.key) {
        k.textContent = "Ingest key: " + r.key;
        k.hidden = false;
        flash("Ingest key shown", false);
      } else {
        flash("Could not retrieve the ingest key", true);
      }
    }).catch(function () { flash("Network error", true); });
  });

  $("btn-rot").addEventListener("click", function () {
    if (!window.confirm("Regenerate the ingest key? The current URL stops working immediately.")) return;
    post("/api/ingest/rotate").then(function (r) {
      flash("Ingest key regenerated", false);
      var k = $("i-key"); k.hidden = true; k.textContent = "";
      refresh();
    });
  });

  $("btn-route").addEventListener("click", function () {
    post("/api/egress/select", { route: $("e-route").value }).then(function (r) {
      flash(r.ok ? "Route applied: " + r.primary : (r.error || "failed"), !r.ok);
      refresh();
    });
  });

  $("btn-test").addEventListener("click", function () {
    var b = $("btn-test"), p = $("e-report");
    b.disabled = true; b.textContent = "Testing..."; p.hidden = false;
    p.textContent = "running route checks, this takes a minute...";
    post("/api/egress/test").then(function (r) {
      p.textContent = (r.report || []).join("\n") || "no output";
      flash(r.ok ? "Route test finished" : "Route test reported failures", !r.ok);
    }).catch(function () { p.textContent = "Network error"; })
      .then(function () { b.disabled = false; b.textContent = "Test all routes"; });
  });

  refresh();
  setInterval(refresh, 5000);
})();

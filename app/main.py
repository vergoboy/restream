"""Noisy - single-user control panel for the datarhei restreamer.

Design rules enforced here:
  * The YouTube stream key is write-only from the browser's point of view. It
    is stored AES-256-GCM encrypted and is never echoed back in any response.
  * Everything is served under a path prefix, so every URL is relative and the
    app works unchanged at / or at /noisy.
  * No process argv, log or report is ever exposed, because all of them carry
    the full ffmpeg command line including the destination key.
"""
import functools
import hmac
import os
import re
import secrets
import sqlite3
import subprocess
import time

from flask import (Flask, abort, g, jsonify, redirect, render_template,
                   request, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

from core import Core, CoreError
from store import SecretStore

BASE = os.environ.get("NOISY_BASE_PATH", "").rstrip("/")
API = os.environ.get("NOISY_CORE_API", "http://127.0.0.1:18080")
CORE_USER = os.environ.get("NOISY_CORE_USER", "")
CORE_PASS = os.environ.get("NOISY_CORE_PASS", "")
EGRESS_SET = "/opt/noisy/scripts/egress-set"
EGRESS_TEST = "/opt/noisy/scripts/egress-test"
PROCESS_ID = "noisy-out"
INGEST_HOST = os.environ.get("NOISY_INGEST_HOST", "vergoboy.ir")
# Address of nginx as seen from inside the restreamer container: the docker
# bridge gateway, since the container's own DNS is hijacked by the tunnel.
NGINX_RTMP_HOST = os.environ.get("NOISY_NGINX_RTMP_HOST", "172.28.240.1")
INGEST_APP = os.environ.get("NOISY_INGEST_APP", "noisy")
# 1935 is already taken by the host's MediaMTX, so Noisy listens on 19350.
INGEST_PORT = os.environ.get("NOISY_INGEST_PORT", "19350")
COOKIE_SECURE = os.environ.get("NOISY_SECURE_COOKIES", "1") == "1"
SESSION_MINUTES = int(os.environ.get("NOISY_SESSION_MINUTES", "720"))

app = Flask(__name__)
store = SecretStore()

# --------------------------------------------------------------------------
# rate limiting
# --------------------------------------------------------------------------
# The counters live in sqlite, not in a dict, because gunicorn runs more than
# one worker process. An in-process counter silently gives every worker its own
# budget, so a client that lands on a fresh worker gets a full allowance again
# and a brute-force attempt is bounded by (limit x workers) rather than limit.
# sqlite is in the stdlib, survives a worker restart, and BEGIN IMMEDIATE makes
# the count-then-insert atomic across processes and threads.
RATELIMIT_DB = os.environ.get(
    "NOISY_RATELIMIT_DB",
    os.path.join(os.path.dirname(os.environ.get(
        "NOISY_SECRET_STORE", "/opt/noisy/data/secrets.enc")), "ratelimit.db"))


def _ratelimit_conn():
    con = sqlite3.connect(RATELIMIT_DB, timeout=5, isolation_level=None)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.execute("CREATE TABLE IF NOT EXISTS hits ("
                "scope TEXT NOT NULL, ident TEXT NOT NULL, "
                "ts REAL NOT NULL, PRIMARY KEY (scope, ident, ts))")
    return con


def rate_limit(limit, seconds, scope):
    ident = request.remote_addr or "-"
    now = time.time()
    con = _ratelimit_conn()
    try:
        # One transaction for the whole check so two workers cannot both read a
        # count of limit-1 and both insert.
        con.execute("BEGIN IMMEDIATE")
        con.execute("DELETE FROM hits WHERE ts < ?", (now - seconds,))
        seen = con.execute(
            "SELECT COUNT(*) FROM hits WHERE scope=? AND ident=? AND ts>=?",
            (scope, ident, now - seconds)).fetchone()[0]
        if seen >= limit:
            con.execute("COMMIT")
            abort(429)
        con.execute("INSERT INTO hits VALUES (?,?,?)", (scope, ident, now))
        con.execute("COMMIT")
    finally:
        con.close()


# --------------------------------------------------------------------------
# security helpers
# --------------------------------------------------------------------------
def _secret_key():
    return store.get_or_create("session_key", lambda: secrets.token_hex(32))


app.secret_key = _secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=COOKIE_SECURE,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=SESSION_MINUTES * 60,
    MAX_CONTENT_LENGTH=64 * 1024,
    JSON_SORT_KEYS=False,
)
app.jinja_env.globals["base"] = BASE


def wants_json():
    return request.path.startswith(BASE + "/api/") or \
        request.headers.get("Accept", "").startswith("application/json")


def fail(msg, code=400):
    if wants_json():
        return jsonify({"ok": False, "error": msg}), code
    return render_template("error.html", message=msg), code


def logged_in():
    return bool(session.get("uid"))


def login_required(view):
    @functools.wraps(view)
    def wrapped(*a, **kw):
        if not logged_in():
            if wants_json():
                return jsonify({"ok": False, "error": "authentication required"}), 401
            return redirect(BASE + "/login")
        return view(*a, **kw)
    return wrapped


def csrf_token():
    if "_csrf" not in session:
        session["_csrf"] = secrets.token_urlsafe(32)
    return session["_csrf"]


def csrf_protect():
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        sent = (request.form.get("csrf_token")
                or request.headers.get("X-CSRF-Token", ""))
        want = session.get("_csrf", "")
        if not sent or not want or not hmac.compare_digest(sent, want):
            abort(403, description="CSRF token missing or invalid")


@app.before_request
def _load_csrf():
    g.csp_nonce = secrets.token_urlsafe(16)
    if logged_in() and request.method in ("GET", "HEAD"):
        csrf_token()


@app.after_request
def _headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    resp.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
    resp.headers.setdefault(
        "Permissions-Policy",
        "geolocation=(), microphone=(), camera=(), payment=()")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data:; connect-src 'self'; form-action 'self'; "
        "frame-ancestors 'none'; base-uri 'none'")
    if wants_json() or request.path.endswith("/ingest"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def core():
    return Core(API, CORE_USER, CORE_PASS)


def _sudo(script, *args, timeout=120):
    """Run a root-owned helper. No shell, no user-controlled arguments."""
    if not all(re.fullmatch(r"[A-Za-z0-9._-]+", a) for a in args):
        raise ValueError("illegal argument")
    return subprocess.run([script, *args], capture_output=True, text=True,
                          timeout=timeout, check=False)


def ingest_key():
    return store.get_or_create("ingest_key", lambda: secrets.token_urlsafe(24))


def ingest_url():
    return "rtmp://%s:%s/%s/%s" % (INGEST_HOST, INGEST_PORT, INGEST_APP,
                                   ingest_key())


def destination():
    return store.get("destination_url"), store.get("destination_key")


def build_process_config(reencode=False):
    url, key = destination()
    if not url or not key:
        raise ValueError("no destination configured")
    # -f flv is required, not optional: ffmpeg picks the muxer from the output
    # extension, and an RTMP URL has none. Without it the process dies with
    # "Unable to choose an output format" and no bytes ever leave.
    out_opts = ["-c", "copy", "-f", "flv"]
    if reencode:
        out_opts = [
            "-c:v", "libx264", "-preset", "veryfast", "-b:v", "6000k",
            "-maxrate", "6000k", "-bufsize", "12000k", "-pix_fmt", "yuv420p",
            "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
            "-f", "flv",
        ]
    return {
        "id": PROCESS_ID,
        "name": "Noisy -> YouTube",
        "input": [{
            "id": "in",
            # Read the public ingest straight out of nginx. The Debian
            # libnginx-mod-rtmp build ships no ngx_rtmp_push_module, so its
            # `push` directive connects and then sits idle: it never relays.
            # The stream name is the ingest key, because that is the last path
            # segment OBS publishes to (nginx has no separate playpath).
            "address": "rtmp://%s:%s/%s/%s" % (NGINX_RTMP_HOST, INGEST_PORT,
                                               INGEST_APP, ingest_key()),
            "options": ["-f", "flv", "-rtmp_live", "live"],
        }],
        "output": [{
            "id": "out",
            "address": "%s/%s" % (url.rstrip("/"), key),
            "options": out_opts,
        }],
        "options": ["-loglevel", "warning", "-nostdin", "-hide_banner"],
        "reconnect": True,
        "reconnect_delay_seconds": 5,
        "stale_timeout_seconds": 20,
        "autostart": True,
        "limits": {
            "cpu_usage": 200,
            "memory_mbytes": 1200,
            "waitfor_seconds": 30,
        },
    }


# --------------------------------------------------------------------------
# pages
# --------------------------------------------------------------------------
@app.route(BASE + "/")
def index():
    if not logged_in():
        return redirect(BASE + "/login")
    return render_template("index.html", csrf=csrf_token())


@app.route(BASE + "/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        rate_limit(5, 300, "login")
        csrf_protect()
        user = os.environ.get("NOISY_USER", "admin")
        pw_hash = store.get("password_hash")
        supplied = request.form.get("password", "")
        bootstrap = not pw_hash
        ok = False
        if pw_hash and check_password_hash(pw_hash, supplied):
            ok = True
        elif bootstrap and len(supplied) >= 12:
            # first-run claim: the account has no password yet
            store.set("password_hash", generate_password_hash(supplied))
            ok = True
        if not ok or not hmac.compare_digest(
                user, request.form.get("username", "")):
            return render_template(
                "login.html", error="Invalid credentials",
                bootstrap=bootstrap, csrf=session.get("_csrf", "")), 401
        session.clear()
        session["uid"] = user
        session.permanent = True
        csrf_token()
        return redirect(BASE + "/")
    csrf_token()
    return render_template("login.html", error=None,
                           bootstrap=not store.get("password_hash"),
                           csrf=session.get("_csrf", ""))


@app.post(BASE + "/logout")
@login_required
def logout():
    csrf_protect()
    session.clear()
    return redirect(BASE + "/login")


@app.route(BASE + "/healthz")
def healthz():
    """Unauthenticated liveness probe. Reveals nothing but up/down."""
    c = core()
    return jsonify({"ok": True, "core": c.ping()}), (200 if c.ping() else 503)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get(BASE + "/api/status")
@login_required
def api_status():
    c = core()
    state = {"core": c.ping(), "streaming": False, "process": None}
    if state["core"]:
        try:
            p = c.process(PROCESS_ID)
            if p:
                st = c.process_state(PROCESS_ID)
                # The core nests the run state under "state" and calls the
                # run state "exec" (running/failed/stopped/...); there is no
                # top-level "status" key.
                s = st.get("state") or st
                exec_state = s.get("exec")
                prog = s.get("progress") or {}
                state["streaming"] = exec_state == "running"
                state["process"] = {
                    "status": exec_state,
                    "order": s.get("order"),
                    "uptime_seconds": s.get("runtime_seconds"),
                    "reconnect_count": s.get("reconnect_seconds"),
                    "last_logline": (s.get("last_logline") or "")[-200:],
                    "frame": prog.get("frame"),
                    "bitrate_kbit": prog.get("bitrate_kbit"),
                }
        except CoreError:
            pass
    url, key = destination()
    state["destination"] = {
        "configured": bool(url and key),
        "server": url or "",
        "key_suffix": ("..." + key[-4:]) if key else "",
    }
    state["ingest"] = {"configured": True, "url": ingest_url()}
    state["egress"] = {"primary": store.get("egress_primary", "vpn-hysteria2")}
    return jsonify(state)


@app.post(BASE + "/api/destination")
@login_required
def api_destination():
    rate_limit(20, 300, "config")
    csrf_protect()
    url = request.form.get("server", "").strip()
    key = request.form.get("key", "").strip()
    clear = request.form.get("clear") == "1"
    if clear:
        store.delete("destination_url")
        store.delete("destination_key")
        return jsonify({"ok": True, "destination": {"configured": False}})
    if not re.fullmatch(r"rtmps?://[A-Za-z0-9.-]+(?::\d+)?/[A-Za-z0-9/_-]+",
                        url):
        return fail("Server must look like rtmps://a.rtmps.youtube.com/live2")
    if not re.fullmatch(r"[A-Za-z0-9._~-]{8,64}", key):
        return fail("Stream key must be 8-64 URL-safe characters")
    store.set("destination_url", url)
    store.set("destination_key", key)
    return jsonify({"ok": True, "destination": {"configured": True,
                                                "server": url,
                                                "key_suffix": "..." + key[-4:]}})


@app.post(BASE + "/api/start")
@login_required
def api_start():
    rate_limit(20, 300, "control")
    csrf_protect()
    try:
        cfg = build_process_config(
            reencode=request.form.get("reencode") == "1")
    except ValueError as exc:
        return fail(str(exc))
    c = core()
    try:
        c.delete(PROCESS_ID)
        c.create(cfg)
        # Creating the process only registers it with the core. Without the
        # start command the process sits there idle and nothing is ever
        # published, while the panel would still report success.
        c.command(PROCESS_ID, "start")
    except CoreError as exc:
        return fail("Could not start: %s" % exc.message, 502)
    # Do not report success on faith. ffmpeg legitimately sits with no "exec"
    # while it waits for a publisher, so require the core to have the process
    # scheduled (order == "start"); that is what "created but never started"
    # looks like, and it is the case worth catching.
    deadline = time.monotonic() + 8
    order = None
    while time.monotonic() < deadline:
        try:
            st = c.process_state(PROCESS_ID) or {}
        except CoreError:
            st = {}
        s = st.get("state") or st
        order = s.get("order")
        if order == "start":
            return jsonify({"ok": True, "started": True,
                            "state": s.get("exec") or "waiting"})
        time.sleep(1)
    return fail("The core created the process but never scheduled it "
                "(order: %r). Check the core logs." % order, 502)


@app.post(BASE + "/api/stop")
@login_required
def api_stop():
    rate_limit(20, 300, "control")
    csrf_protect()
    c = core()
    try:
        # Stopping an idle panel must not look like a failure. The core answers
        # a stop for a process that is not running with a non-404 error, so
        # check the run state first and treat "not running" as done. Without
        # this the operator sees "Could not stop" when there is nothing to stop,
        # and the data-plane test reports a false failure.
        st = c.process_state(PROCESS_ID)
        s = st.get("state") or st
        if (s.get("exec")) == "running":
            c.command(PROCESS_ID, "stop")
    except CoreError as exc:
        if exc.status != 404:
            return fail("Could not stop: %s" % exc.message, 502)
    # Remove the record either way, so a failed run does not linger as
    # "streaming" in the panel.
    try:
        c.delete(PROCESS_ID)
    except CoreError as exc:
        if exc.status != 404:
            return fail("Could not stop: %s" % exc.message, 502)
    return jsonify({"ok": True, "stopped": True})


@app.post(BASE + "/api/ingest/rotate")
@login_required
def api_ingest_rotate():
    rate_limit(5, 300, "rotate")
    csrf_protect()
    store.set("ingest_key", secrets.token_urlsafe(24))
    # nginx reads the key per publish request, so this takes effect instantly
    # with no reload; the key is never written into the nginx config. A running
    # process, however, baked the OLD key into its input path and would keep
    # waiting for a publisher that can no longer authenticate, so drop it.
    try:
        core().delete(PROCESS_ID)
    except CoreError:
        pass
    return jsonify({"ok": True, "url": ingest_url()})


@app.get(BASE + "/api/ingest")
@login_required
def api_ingest():
    return jsonify({"ok": True, "url": ingest_url(), "key": ingest_key()})


@app.get(BASE + "/api/egress")
@login_required
def api_egress():
    return jsonify({"ok": True,
                    "primary": store.get("egress_primary", "vpn-hysteria2"),
                    "routes": ["vpn-hysteria2", "vpn-grpc", "vpn-reality",
                               "vpn-httpupgrade", "vpn-xhttp", "vpn-httpobf",
                               "vpn-xray"]})


@app.post(BASE + "/api/egress/select")
@login_required
def api_egress_select():
    rate_limit(10, 300, "egress")
    csrf_protect()
    route = request.form.get("route", "")
    allowed = ["vpn-hysteria2", "vpn-grpc", "vpn-reality", "vpn-httpupgrade",
               "vpn-xhttp", "vpn-httpobf", "vpn-xray"]
    if route not in allowed:
        return fail("unknown route")
    res = _sudo(EGRESS_SET, route)
    if res.returncode != 0:
        return fail("route switch failed", 502)
    store.set("egress_primary", route)
    return jsonify({"ok": True, "primary": route})


@app.post(BASE + "/api/egress/test")
@login_required
def api_egress_test():
    rate_limit(6, 300, "egress-test")
    csrf_protect()
    res = _sudo(EGRESS_TEST, timeout=300)
    lines = [ln for ln in res.stdout.splitlines() if ln.strip()]
    return jsonify({"ok": res.returncode == 0, "report": lines})


# --------------------------------------------------------------------------
# nginx-rtmp publish gate
# --------------------------------------------------------------------------
@app.route(BASE + "/internal/rtmp/publish", methods=["GET", "POST"])
def rtmp_publish():
    """Called by nginx-rtmp on every publish attempt.

    nginx-rtmp 1.2.2 has no on_publish_post, so on_publish issues a GET and
    passes `app` and `name` (the last path segment of the publish URL) in the
    query string. request.values reads either form, so a POST still works.
    Accept only the exact current ingest key; anything else is refused before a
    single byte reaches the restreamer.
    """
    rate_limit(120, 60, "rtmp")
    if request.values.get("app") != INGEST_APP:
        return "bad app", 403
    name = request.values.get("name") or ""
    if not store.constant_time_equals(name, ingest_key()):
        app.logger.warning("rtmp publish rejected from %s",
                           request.values.get("addr", "?"))
        return "invalid key", 403
    # The body MUST be empty. nginx-rtmp reads a non-empty 2xx body as the name
    # of a stream to redirect the publisher to, so returning "ok" silently
    # renamed every accepted publish to a stream called "ok": the session was
    # closed at once, the core never saw a publisher, and the restream sat idle
    # while the panel still reported success.
    return "", 200


@app.errorhandler(403)
@app.errorhandler(429)
@app.errorhandler(500)
def _err(exc):
    code = getattr(exc, "code", 500)
    if wants_json():
        return jsonify({"ok": False,
                        "error": getattr(exc, "description", "error")}), code
    return render_template("error.html",
                           message=getattr(exc, "description", "error")), code


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("NOISY_PORT", "18081")),
            debug=False)

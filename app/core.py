"""Client for the datarhei/core HTTP API.

Core authenticates with JWT, not HTTP basic auth: POST /api/login returns an
access token (short lived) plus a refresh token, and every /api/v3 call must
carry `Authorization: Bearer <access_token>`. This client logs in lazily,
refreshes on 401, and never logs a body.

The FFmpeg process configuration contains the YouTube stream key inside the
output address, so request/response bodies for the process endpoints are
deliberately not logged, and `command` / `report` / log fields are redacted
before they can reach any caller.
"""
import json
import threading
import time
import urllib.error
import urllib.request

HOST = "http://127.0.0.1:18080"
V3 = HOST + "/api/v3"
# Fields that can echo the full ffmpeg argv (and therefore the stream key).
POISONED = ("command", "report", "log", "logs", "stdout", "stderr")


class CoreError(RuntimeError):
    def __init__(self, status, message):
        super().__init__("core API %s: %s" % (status, message))
        self.status = status
        self.message = message


def _scrub(obj):
    if isinstance(obj, dict):
        return {k: ("<redacted>" if k in POISONED else _scrub(v))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return obj


class Core:
    def __init__(self, host=HOST, user=None, password=None, timeout=10):
        self.host = host
        self.timeout = timeout
        self._user = user
        self._pass = password
        self._token = None
        self._refresh = None
        self._expiry = 0.0
        self._lock = threading.Lock()

    # --- transport ------------------------------------------------------
    def _raw(self, method, url, body=None, token=None, retries=3):
        data = json.dumps(body).encode() if body is not None else None
        last = None
        for attempt in range(retries):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Accept", "application/json")
            if token:
                req.add_header("Authorization", "Bearer " + token)
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                try:
                    parsed = json.loads(raw)
                except ValueError:
                    parsed = {"message": raw[:200].decode("utf-8", "replace")}
                # 401/403 are surfaced to the caller for a refresh, not retried.
                if exc.code in (401, 403):
                    raise CoreError(exc.code, parsed.get("message", "unauthorized"))
                raise CoreError(exc.code, parsed.get("message", "error"))
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                last = exc
                time.sleep(0.4 * (attempt + 1))
        raise CoreError("unreachable", str(last))

    # --- auth -----------------------------------------------------------
    def _login(self):
        if not self._user:
            raise CoreError("no-credentials", "core credentials are not configured")
        res = self._raw("POST", self.host + "/api/login",
                        {"username": self._user, "password": self._pass},
                        retries=2)
        self._token = res.get("access_token")
        self._refresh = res.get("refresh_token")
        if not self._token:
            raise CoreError("login-failed", "core returned no access token")
        # Renew a little before the advertised lifetime to avoid racing expiry.
        self._expiry = time.monotonic() + max(30, int(res.get("exi", 300)) - 30)
        return self._token

    def _token_for(self):
        if self._token and time.monotonic() < self._expiry:
            return self._token
        with self._lock:
            if self._token and time.monotonic() < self._expiry:
                return self._token
            if self._refresh:
                try:
                    res = self._raw("GET", self.host + "/api/login/refresh",
                                    token=self._refresh, retries=1)
                    if res.get("access_token"):
                        self._token = res["access_token"]
                        self._expiry = time.monotonic() + max(
                            30, int(res.get("exi", 300)) - 30)
                        return self._token
                except CoreError:
                    pass  # fall through to a fresh login
            return self._login()

    def call(self, method, path, body=None):
        token = self._token_for()
        try:
            return _scrub(self._raw(method, V3 + path, body, token=token))
        except CoreError as exc:
            if exc.status == 401:
                with self._lock:
                    self._token, self._expiry = None, 0.0
                token = self._token_for()
                return _scrub(self._raw(method, V3 + path, body, token=token))
            raise

    # --- api ------------------------------------------------------------
    def ping(self):
        """Liveness plus a real authenticated round trip.

        Core exposes no /ping endpoint; listing processes is the cheapest call
        that proves both the listener and the JWT are working.
        """
        try:
            self.call("GET", "/process")
            return True
        except CoreError:
            return False

    def process(self, pid):
        return self.call("GET", "/process/%s" % pid)

    def process_state(self, pid):
        return self.call("GET", "/process/%s/state" % pid)

    def command(self, pid, action):
        # The core expects {"command": ...} here; {"action": ...} is rejected
        # with "Invalid JSON".
        return self.call("PUT", "/process/%s/command" % pid, {"command": action})

    def create(self, config):
        return self.call("POST", "/process", config)

    def delete(self, pid):
        try:
            self.call("DELETE", "/process/%s" % pid)
        except CoreError as exc:
            if exc.status != 404:
                raise

    def list_processes(self):
        return self.call("GET", "/process")


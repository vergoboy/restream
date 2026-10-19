"""Encrypted-at-rest secret storage for Noisy.

The YouTube stream key and the RTMP ingest key never touch disk in plaintext.
They live inside an AES-256-GCM blob whose key is a separate 0600 file, so a
leaked data directory does not expose a live credential.

Concurrency: the panel runs several gunicorn workers, so every operation takes
an exclusive flock and re-reads the blob from disk. Nothing is cached in
process memory, which makes a lost update impossible - two workers can never
each start from a stale snapshot and overwrite each other's writes.
"""
import fcntl
import hmac
import json
import os
import secrets
import stat

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY_PATH = os.environ.get("NOISY_MASTER_KEY", "/opt/noisy/secrets/master.key")
DATA_PATH = os.environ.get("NOISY_SECRET_STORE", "/opt/noisy/data/secrets.enc")
LOCK_PATH = DATA_PATH + ".lock"
NONCE_LEN = 12


def _write_private(path, data):
    # A per-process temp name: two concurrent writers must never share a file
    # they are both truncating and renaming.
    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), secrets.token_hex(6))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def _read_or_create_key(path):
    if not os.path.exists(path):
        _write_private(path, secrets.token_bytes(32))
    with open(path, "rb") as fh:
        key = fh.read()
    if len(key) != 32:
        raise RuntimeError("master key at %s is not 32 bytes" % path)
    return key


class SecretStore:
    def __init__(self, key_path=KEY_PATH, data_path=DATA_PATH):
        self._aead = AESGCM(_read_or_create_key(key_path))
        self._path = data_path
        self._lock_path = data_path + ".lock"

    class _Lock:
        def __init__(self, path):
            self._path = path
            self._fd = None

        def __enter__(self):
            # Flags and mode are separate arguments. Note S_IWUSR (0o200) is
            # numerically identical to O_EXCL, so the mode must never be
            # folded into the flags or every open after the first fails.
            self._fd = os.open(self._path,
                               os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC,
                               stat.S_IRUSR | stat.S_IWUSR)
            fcntl.flock(self._fd, fcntl.LOCK_EX)
            return self

        def __exit__(self, *exc):
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                os.close(self._fd)
                self._fd = None
            return False

    def _read_locked(self):
        if not os.path.exists(self._path):
            return {}
        with open(self._path, "rb") as fh:
            blob = fh.read()
        if len(blob) <= NONCE_LEN:
            raise RuntimeError("secret store is truncated")
        # decrypt(nonce, ciphertext, associated_data) - the order matters and
        # the arguments are not interchangeable.
        return json.loads(self._aead.decrypt(blob[:NONCE_LEN], blob[NONCE_LEN:], None))

    def _write_locked(self, data):
        nonce = secrets.token_bytes(NONCE_LEN)
        ct = self._aead.encrypt(nonce, json.dumps(data).encode(), None)
        _write_private(self._path, nonce + ct)

    def get(self, name, default=None):
        with self._Lock(self._lock_path):
            return self._read_locked().get(name, default)

    def set(self, name, value):
        with self._Lock(self._lock_path):
            data = self._read_locked()
            data[name] = value
            self._write_locked(data)

    def delete(self, name):
        with self._Lock(self._lock_path):
            data = self._read_locked()
            if data.pop(name, None) is not None:
                self._write_locked(data)

    def has(self, name):
        return self.get(name) is not None

    def get_or_create(self, name, factory):
        """Atomically return the stored value, creating it exactly once.

        Several gunicorn workers boot at the same instant. A plain get/set
        pair would let each one mint a different session key and invalidate
        the others' cookies at random.
        """
        with self._Lock(self._lock_path):
            data = self._read_locked()
            if name not in data:
                data[name] = factory()
                self._write_locked(data)
            return data[name]

    @staticmethod
    def constant_time_equals(a, b):
        if not isinstance(a, str) or not isinstance(b, str):
            return False
        return hmac.compare_digest(a, b)

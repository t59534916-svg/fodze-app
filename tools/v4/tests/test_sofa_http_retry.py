"""Tests for tools/sofascore/_http_retry.py — the shared transient-retry
policy for the Sofascore scrapers.

Pure logic + a fake session (no network, no data, no real sleeps), so this
runs in the CI subset (`pytest -m "not requires_data"`). The retry-path tests
monkeypatch ``time.sleep`` — tenacity's nap.sleep delegates to it at call
time, so this neutralizes the exponential backoff without touching internals.

The single most important invariant under test: **HTTP 429 is NOT retried.**
In this codebase a 429 is a Cloudflare IP-block that drives Webshare
proxy-pool rotation (fetch_match_extras.BlockedError), so hammering the same
blocked IP within seconds is wrong. Only 502/503/504 + network blips retry.
"""
import sys
import time
from pathlib import Path

import pytest

# _http_retry lives in tools/sofascore (a non-package dir). Put it on the path.
_SOFA = Path(__file__).resolve().parents[2] / "sofascore"
sys.path.insert(0, str(_SOFA))

import _http_retry as R  # noqa: E402


# ─── fakes ──────────────────────────────────────────────────────────

class FakeResp:
    def __init__(self, status):
        self.status_code = status


class ConstSession:
    """session.get always yields the same status (or raises the same exc)."""

    def __init__(self, status_or_exc):
        self._v = status_or_exc
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        if isinstance(self._v, BaseException):
            raise self._v
        return FakeResp(self._v)


class SeqSession:
    """session.get walks a list of outcomes (int status or Exception)."""

    def __init__(self, outcomes):
        self._outcomes = list(outcomes)
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        o = self._outcomes.pop(0)
        if isinstance(o, BaseException):
            raise o
        return FakeResp(o)


@pytest.fixture
def no_sleep(monkeypatch):
    """Neutralize tenacity's backoff (nap.sleep → time.sleep at call time)."""
    monkeypatch.setattr(time, "sleep", lambda *a, **k: None)


# ─── RETRYABLE_STATUS ───────────────────────────────────────────────

def test_retryable_status_set():
    assert R.RETRYABLE_STATUS == frozenset({502, 503, 504})
    # The architectural invariant: 429 (and 403) are NOT in the retry set.
    assert 429 not in R.RETRYABLE_STATUS
    assert 403 not in R.RETRYABLE_STATUS
    # 500/501 are deliberately excluded (real server bug, not transient).
    assert 500 not in R.RETRYABLE_STATUS
    assert 501 not in R.RETRYABLE_STATUS


# ─── is_retryable_exc ───────────────────────────────────────────────

def test_is_retryable_transient_http():
    assert R.is_retryable_exc(R.TransientHTTPError(503, "x")) is True


def test_is_retryable_network_types():
    assert R.is_retryable_exc(ConnectionError("reset")) is True
    assert R.is_retryable_exc(TimeoutError("slow")) is True


def test_is_retryable_network_message_match():
    # curl_cffi raises RequestsError (not a ConnectionError subclass) — matched
    # by message token.
    assert R.is_retryable_exc(RuntimeError("Connection reset by peer")) is True
    assert R.is_retryable_exc(RuntimeError("Recv failure: timed out")) is True
    assert R.is_retryable_exc(Exception("SSL handshake failed")) is True


def test_blocked_and_hung_never_retried():
    # Defined locally with the exact class names — proves the guard is a
    # decoupled NAME check (no import of fetch_match_extras), so a CF block
    # or watchdog kill can never be retried.
    class BlockedError(RuntimeError):
        pass

    class HungError(RuntimeError):
        pass

    assert R.is_retryable_exc(BlockedError("HTTP 429")) is False
    assert R.is_retryable_exc(HungError("watchdog")) is False


def test_non_transient_not_retried():
    assert R.is_retryable_exc(ValueError("bad json")) is False
    assert R.is_retryable_exc(KeyError("missing")) is False


# ─── get_with_retry: success / non-retryable status ─────────────────

def test_get_200_no_retry():
    s = ConstSession(200)
    r = R.get_with_retry(s, "http://x")
    assert r.status_code == 200
    assert s.calls == 1


def test_get_404_returned_as_is_no_retry():
    s = ConstSession(404)
    r = R.get_with_retry(s, "http://x")
    assert r.status_code == 404
    assert s.calls == 1


def test_get_403_not_retried():
    # 403 = CF block → returned as-is for the caller to classify (rotation),
    # NOT retried here.
    s = ConstSession(403)
    r = R.get_with_retry(s, "http://x")
    assert r.status_code == 403
    assert s.calls == 1


def test_get_429_not_retried():
    # THE key invariant: 429 must not be hammered on the same IP.
    s = ConstSession(429)
    r = R.get_with_retry(s, "http://x")
    assert r.status_code == 429
    assert s.calls == 1


# ─── get_with_retry: retry paths (sleep neutralized) ────────────────

def test_get_503_then_200_retries(no_sleep):
    s = SeqSession([503, 503, 200])
    r = R.get_with_retry(s, "http://x", attempts=4)
    assert r.status_code == 200
    assert s.calls == 3


def test_get_network_then_200_retries(no_sleep):
    s = SeqSession([ConnectionError("reset"), 200])
    r = R.get_with_retry(s, "http://x", attempts=4)
    assert r.status_code == 200
    assert s.calls == 2


def test_get_503_exhausts_then_raises(no_sleep):
    s = ConstSession(503)
    with pytest.raises(R.TransientHTTPError):
        R.get_with_retry(s, "http://x", attempts=3)
    assert s.calls == 3  # 1 initial + 2 retries


# ─── run_with_retry: generic fn ─────────────────────────────────────

def test_run_with_retry_retries_then_succeeds(no_sleep):
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("ECONNRESET")
        return "ok"

    assert R.run_with_retry(fn, attempts=5) == "ok"
    assert calls["n"] == 3


def test_run_with_retry_does_not_retry_non_transient(no_sleep):
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise ValueError("permanent")

    with pytest.raises(ValueError):
        R.run_with_retry(fn, attempts=5)
    assert calls["n"] == 1  # not retried

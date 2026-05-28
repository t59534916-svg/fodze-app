#!/usr/bin/env python3
"""Shared transient-retry policy for the Sofascore scrapers (tenacity-based).

Tuned to this codebase's Cloudflare reality:

  RETRY  →  HTTP 502 / 503 / 504  +  transient transport errors
            (connection reset, timeout, SSL hiccup, DNS blip). A same-IP
            retry helps here — the upstream or the link was briefly unhealthy.

  NEVER  →  HTTP 403 / 429. Those are Cloudflare IP-reputation blocks. The
            correct response is Webshare proxy-pool ROTATION (handled by the
            caller via fetch_match_extras.BlockedError), NOT hammering the
            same blocked IP — CF will not unhealthy-clear within seconds.

This mirrors the JS-side policy in scripts/_lib/fetch-retry.mjs, which
likewise EXCLUDES 429 from retry because key-rotation handles quota there.

tenacity (>=8) is already in tools/venv; it is pinned in
tools/sofascore/requirements.txt so a fresh venv reproduces it.
"""
from __future__ import annotations

import sys

import tenacity

# 5xx codes worth a same-IP retry. 500/501 are excluded — usually a real
# server bug or unimplemented route, not transient. 429 is excluded — see
# the module docstring (it is a CF block → drives proxy rotation, not retry).
RETRYABLE_STATUS: frozenset = frozenset({502, 503, 504})

# Substrings that mark a transport-layer hiccup in curl_cffi / urllib / ssl
# exception messages. curl_cffi raises curl_cffi.requests.errors.RequestsError
# (NOT a stdlib ConnectionError subclass), so message-matching is required in
# addition to isinstance checks.
_NET_TOKENS = (
    "timed out", "timeout", "connection reset", "reset by peer",
    "connection refused", "connection aborted", "temporarily unavailable",
    "recv failure", "send failure", "transfer closed", "could not resolve",
    "failed to connect", "eof occurred", "ssl", "broken pipe",
    "name resolution", "connection error", "remote end closed",
)


class TransientHTTPError(RuntimeError):
    """A 5xx worth retrying on the same IP (NOT a Cloudflare block)."""

    def __init__(self, status: int, url: str):
        self.status = status
        self.url = url
        super().__init__(f"HTTP {status} (transient) for {url}")


def is_retryable_exc(exc: BaseException) -> bool:
    """True for transient HTTP/network errors; False for CF-blocks + watchdog.

    Decoupled name-check for BlockedError / HungError: those live in
    fetch_match_extras (importing them here would be circular) and must
    NEVER be retried — BlockedError drives proxy rotation, HungError is a
    deliberate single-request skip.
    """
    if exc.__class__.__name__ in ("BlockedError", "HungError"):
        return False
    if isinstance(exc, TransientHTTPError):
        return True
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return True
    msg = str(exc).lower()
    return any(tok in msg for tok in _NET_TOKENS)


def _before_sleep(retry_state) -> None:
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    sleep_for = getattr(retry_state.next_action, "sleep", 0.0) or 0.0
    name = type(exc).__name__ if exc else "?"
    print(
        f"  ⟳ transient retry {retry_state.attempt_number} "
        f"({name}) — sleeping {sleep_for:.1f}s",
        file=sys.stderr,
    )


def make_retrying(*, attempts: int = 4, label: str = "sofa-get"):
    """Build a tenacity.Retrying for transient HTTP/network failures.

    attempts=4 → 1 initial try + 3 retries (solidly inside the 3-5 range).
    Full-jitter exponential backoff capped at 16s (2,4,8 → +random[0,2]).
    reraise=True so the LAST underlying exception surfaces on exhaustion and
    the caller's own except-clause can degrade to skip (return None) — that
    preserves the scrapers' pre-existing "skip-on-failure" contract.
    """
    return tenacity.Retrying(
        retry=tenacity.retry_if_exception(is_retryable_exc),
        stop=tenacity.stop_after_attempt(attempts),
        wait=tenacity.wait_exponential(multiplier=2, min=2, max=16)
        + tenacity.wait_random(0, 2),
        before_sleep=_before_sleep,
        reraise=True,
    )


def run_with_retry(fn, *args, attempts: int = 4, label: str = "sofa-get", **kwargs):
    """Call fn(*args, **kwargs) under the transient-retry policy."""
    return make_retrying(attempts=attempts, label=label)(fn, *args, **kwargs)


def get_with_retry(session, url, *, attempts: int = 4, label=None, **kwargs):
    """session.get(url, **kwargs) with transient-retry. Returns the Response.

    A 5xx in RETRYABLE_STATUS is raised as TransientHTTPError so tenacity
    retries it; after exhaustion the error surfaces (caller degrades).
    Network errors propagate the same way. 403/429/404/200 are returned as a
    normal Response — the caller classifies them (403/429 → rotation, etc.).
    """
    lbl = label or (url[:80] if isinstance(url, str) else "get")

    def _attempt():
        r = session.get(url, **kwargs)
        if getattr(r, "status_code", None) in RETRYABLE_STATUS:
            raise TransientHTTPError(r.status_code, lbl)
        return r

    return run_with_retry(_attempt, attempts=attempts, label=lbl)

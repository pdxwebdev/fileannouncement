"""Tests for Sia download recovery and stream error handling.

These live with the plugin instead of the host app's test suite. Run them from
this directory with:

    python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

_PACKAGE_DIR = Path(__file__).resolve().parent.parent
_PLUGINS_DIR = _PACKAGE_DIR.parent
_HOST_ROOT = _PLUGINS_DIR.parent
for _path in (str(_HOST_ROOT), str(_PLUGINS_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from fileannouncement.backends import (  # noqa: E402
    SiaStorageBackend,
    StorageBackendError,
)

try:
    from fileannouncement.handlers import PublicStreamHandler  # noqa: E402
except Exception:  # pragma: no cover - the host app is not importable
    PublicStreamHandler = None


class _FakeSiaObject:
    def __init__(self, size):
        self._size = size

    def size(self):
        return self._size


class _FakeDownloadHandle:
    def __init__(self, items=None):
        self._items = list(items or [])
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        item = self._items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    async def close(self):
        self.closed = True


class TestSiaDownloadRecovery(unittest.IsolatedAsyncioTestCase):
    async def test_panicking_download_retries_with_fresh_sdk(self):
        backend = SiaStorageBackend("ab" * 32)
        obj = _FakeSiaObject(6)
        panic = RuntimeError(
            'join error: task 12172 panicked with message "index out of '
            'bounds: the len is 29 but the index is 29"'
        )
        first = _FakeDownloadHandle([panic])
        second = _FakeDownloadHandle([b"abc", b"def"])
        handles = [first, second]
        starts = []

        async def start(*_args, **_kwargs):
            starts.append(1)
            return obj, handles[len(starts) - 1]

        with patch.object(backend, "_start_download", side_effect=start), patch.object(
            backend, "_invalidate"
        ) as invalidate:
            total, chunks = await backend.open_download("f" * 64)
            got = b""
            async for chunk in chunks:
                got += chunk

        self.assertEqual(total, 6)
        self.assertEqual(got, b"abcdef")
        self.assertEqual(len(starts), 2)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)
        invalidate.assert_called_once_with("f" * 64, "")

    async def test_panic_after_bytes_are_sent_is_not_retried(self):
        backend = SiaStorageBackend("ab" * 32)
        obj = _FakeSiaObject(6)
        panic = RuntimeError(
            'join error: task 1 panicked with message "index out of bounds"'
        )
        handle = _FakeDownloadHandle([b"abc", panic])
        starts = []

        async def start(*_args, **_kwargs):
            starts.append(1)
            return obj, handle

        with patch.object(backend, "_start_download", side_effect=start), patch.object(
            backend, "_invalidate"
        ) as invalidate:
            _total, chunks = await backend.open_download("f" * 64)
            received = []
            with self.assertRaises(StorageBackendError):
                async for chunk in chunks:
                    received.append(chunk)

        self.assertEqual(received, [b"abc"])
        self.assertEqual(len(starts), 1)
        invalidate.assert_not_called()

    async def test_non_panic_errors_are_not_retried(self):
        backend = SiaStorageBackend("ab" * 32)
        obj = _FakeSiaObject(6)
        handle = _FakeDownloadHandle([RuntimeError("not enough shards: 2/10")])
        starts = []

        async def start(*_args, **_kwargs):
            starts.append(1)
            return obj, handle

        with patch.object(backend, "_start_download", side_effect=start):
            _total, chunks = await backend.open_download("f" * 64)
            with self.assertRaises(StorageBackendError):
                async for _chunk in chunks:
                    pass

        self.assertEqual(len(starts), 1)


class TestStreamWriteSpan(unittest.IsolatedAsyncioTestCase):
    def _handler(self):
        handler = PublicStreamHandler.__new__(PublicStreamHandler)
        handler._finished = False
        handler.write = MagicMock()
        handler.flush = AsyncMock()
        handler.set_status = MagicMock()
        handler.finish = MagicMock()
        return handler

    async def test_failure_before_first_chunk_returns_502(self):
        if PublicStreamHandler is None:
            self.skipTest("host app is not importable")
        handler = self._handler()

        async def read_chunk(_remaining):
            raise StorageBackendError("download panic")

        await handler._write_span(read_chunk, 0, 9)

        handler.write.assert_not_called()
        handler.set_status.assert_called_once_with(502)
        handler.finish.assert_called_once_with("storage temporarily unavailable")

    async def test_failure_after_first_chunk_does_not_rewrite_response(self):
        if PublicStreamHandler is None:
            self.skipTest("host app is not importable")
        handler = self._handler()
        calls = {"n": 0}

        async def read_chunk(_remaining):
            calls["n"] += 1
            if calls["n"] == 1:
                return b"abcd"
            raise RuntimeError("download panicked")

        await handler._write_span(read_chunk, 0, 9)

        handler.write.assert_called_once_with(b"abcd")
        handler.set_status.assert_not_called()
        handler.finish.assert_not_called()

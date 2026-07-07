from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class JsonFileCache:
    def __init__(
        self, directory: str | Path = ".cache/stock_screener", ttl_seconds: int = 86400
    ) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.ttl_seconds = ttl_seconds

    def _path(self, key: str) -> Path:
        return self.directory / f"{key.replace('/', '_')}.json"

    def get(self, key: str) -> dict[str, Any] | None:
        path = self._path(key)
        if not path.exists() or time.time() - path.stat().st_mtime > self.ttl_seconds:
            return None
        return json.loads(path.read_text())

    def set(self, key: str, value: dict[str, Any]) -> None:
        self._path(key).write_text(json.dumps(value, default=str))

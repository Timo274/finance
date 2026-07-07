from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class ScreenerConfig:
    tickers: list[str]
    filters: dict[str, float]
    weights: dict[str, float]
    output: dict[str, str]
    runtime: dict[str, Any]

    @classmethod
    def from_yaml(cls, path: str | Path) -> ScreenerConfig:
        data = yaml.safe_load(Path(path).read_text())
        return cls(
            tickers=list(dict.fromkeys(data.get("tickers", []))),
            filters=data.get("filters", {}),
            weights=data.get("weights", {}),
            output=data.get("output", {}),
            runtime=data.get("runtime", {}),
        )

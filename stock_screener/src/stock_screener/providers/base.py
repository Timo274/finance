from __future__ import annotations

from abc import ABC, abstractmethod

from stock_screener.models import CompanyMetrics


class MarketDataProvider(ABC):
    @abstractmethod
    async def fetch_one(self, ticker: str) -> CompanyMetrics: ...
    @abstractmethod
    async def fetch_many(self, tickers: list[str]) -> list[CompanyMetrics]: ...

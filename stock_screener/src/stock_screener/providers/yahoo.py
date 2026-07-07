from __future__ import annotations

import asyncio
import logging
import math
from typing import Any

import pandas as pd
import yfinance as yf
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from stock_screener.models import CompanyMetrics
from stock_screener.providers.base import MarketDataProvider
from stock_screener.utils.cache import JsonFileCache

log = logging.getLogger(__name__)


def safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        value = float(value)
        return None if math.isnan(value) or math.isinf(value) else value
    except Exception:
        return None


def fcf_growth(cashflow: pd.DataFrame) -> float | None:
    if "Free Cash Flow" not in cashflow.index:
        return None
    vals = [safe_float(v) for v in cashflow.loc["Free Cash Flow"].dropna().tolist()]
    vals = [v for v in vals if v is not None]
    if len(vals) < 2 or vals[1] == 0:
        return None
    return vals[0] / vals[1] - 1


class YahooFinanceProvider(MarketDataProvider):
    def __init__(self, concurrency: int = 8, cache: JsonFileCache | None = None) -> None:
        self.semaphore = asyncio.Semaphore(concurrency)
        self.cache = cache or JsonFileCache()

    async def fetch_many(self, tickers: list[str]) -> list[CompanyMetrics]:
        return await asyncio.gather(*(self.fetch_one(t) for t in tickers))

    async def fetch_one(self, ticker: str) -> CompanyMetrics:
        async with self.semaphore:
            cached = self.cache.get(ticker)
            if cached:
                return CompanyMetrics(**cached)
            try:
                metrics = await asyncio.to_thread(self._fetch_sync, ticker)
                self.cache.set(ticker, metrics.as_dict())
                return metrics
            except Exception as exc:
                log.exception("Failed to fetch %s", ticker)
                return CompanyMetrics(ticker=ticker, company=ticker, error=str(exc))

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        retry=retry_if_exception_type(Exception),
    )
    def _fetch_sync(self, ticker: str) -> CompanyMetrics:
        asset = yf.Ticker(ticker)
        info = asset.info or {}
        ev = safe_float(info.get("enterpriseValue"))
        ebitda = safe_float(info.get("ebitda"))
        total_debt = safe_float(info.get("totalDebt"))
        equity = None
        try:
            bs = asset.balance_sheet
            for row in ["Stockholders Equity", "Common Stock Equity"]:
                if row in bs.index:
                    equity = safe_float(bs.loc[row].dropna().iloc[0])
                    break
        except Exception:
            equity = None
        try:
            fcfg = fcf_growth(asset.cashflow)
        except Exception:
            fcfg = None
        return CompanyMetrics(
            ticker=ticker,
            company=info.get("shortName") or info.get("longName") or ticker,
            sector=info.get("sector"),
            industry=info.get("industry"),
            market_cap=safe_float(info.get("marketCap")),
            pe_ratio=safe_float(info.get("trailingPE")),
            ev_ebitda=ev / ebitda if ev and ebitda and ebitda > 0 else None,
            roe=safe_float(info.get("returnOnEquity")),
            revenue_growth=safe_float(info.get("revenueGrowth")),
            fcf_growth=fcfg,
            debt_to_equity=(
                total_debt / equity if total_debt is not None and equity and equity > 0 else None
            ),
            gross_margin=safe_float(info.get("grossMargins")),
            current_price=safe_float(info.get("currentPrice")),
            recommendation=info.get("recommendationKey"),
        )

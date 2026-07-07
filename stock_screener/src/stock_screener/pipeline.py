from __future__ import annotations

import pandas as pd

from stock_screener.config import ScreenerConfig
from stock_screener.providers.base import MarketDataProvider
from stock_screener.screening.filters import passes_filters
from stock_screener.screening.scoring import score


class ScreenerPipeline:
    def __init__(self, provider: MarketDataProvider, config: ScreenerConfig) -> None:
        self.provider = provider
        self.config = config

    async def run(self) -> pd.DataFrame:
        metrics = await self.provider.fetch_many(self.config.tickers)
        df = pd.DataFrame([m.as_dict() for m in metrics])
        df["passed_screen"] = df.apply(lambda row: passes_filters(row, self.config.filters), axis=1)
        return score(df, self.config.weights)

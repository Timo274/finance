import asyncio

from stock_screener.config import ScreenerConfig
from stock_screener.models import CompanyMetrics
from stock_screener.pipeline import ScreenerPipeline


class FakeProvider:
    async def fetch_many(self, tickers):
        return [
            CompanyMetrics(
                ticker="A",
                market_cap=100,
                pe_ratio=10,
                ev_ebitda=8,
                roe=0.2,
                revenue_growth=0.1,
                fcf_growth=0.1,
                debt_to_equity=0.3,
                gross_margin=0.5,
            )
        ]


def test_pipeline_runs():
    cfg = ScreenerConfig(["A"], {"market_cap_min": 50}, {"roe": 1}, {}, {})
    df = asyncio.run(ScreenerPipeline(FakeProvider(), cfg).run())
    assert bool(df.iloc[0]["passed_screen"]) is True

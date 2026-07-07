from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from rich.console import Console

from stock_screener.config import ScreenerConfig
from stock_screener.exporters.charts import export_charts
from stock_screener.exporters.excel import export_excel
from stock_screener.pipeline import ScreenerPipeline
from stock_screener.providers.yahoo import YahooFinanceProvider
from stock_screener.utils.cache import JsonFileCache
from stock_screener.utils.logging import configure_logging

console = Console()


async def run(config_path: Path, verbose: bool = False) -> None:
    configure_logging(verbose)
    cfg = ScreenerConfig.from_yaml(config_path)
    cache = JsonFileCache(ttl_seconds=int(cfg.runtime.get("cache_ttl_seconds", 86400)))
    provider = YahooFinanceProvider(concurrency=int(cfg.runtime.get("concurrency", 8)), cache=cache)
    df = await ScreenerPipeline(provider, cfg).run()
    base = config_path.parent.parent
    excel = base / cfg.output.get("excel_file", "sample_outputs/stock_screen_results.xlsx")
    charts = base / cfg.output.get("chart_file", "sample_outputs/stock_screen_charts.html")
    export_excel(df, excel)
    export_charts(df, charts)
    console.print(
        df[
            [
                "rank",
                "ticker",
                "passed_screen",
                "weighted_score",
                "pe_ratio",
                "ev_ebitda",
                "roe",
                "revenue_growth",
            ]
        ].head(15)
    )
    console.print(f"\n[green]Wrote[/green] {excel}\n[green]Wrote[/green] {charts}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the investment stock screener")
    parser.add_argument("--config", default="config/default_config.yaml")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    asyncio.run(run(Path(args.config).resolve(), args.verbose))


if __name__ == "__main__":
    main()

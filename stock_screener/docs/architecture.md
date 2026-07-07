# Architecture

```mermaid
flowchart LR
  CLI[CLI / argparse] --> Config[ScreenerConfig]
  Config --> Pipeline[ScreenerPipeline]
  Pipeline --> Provider[MarketDataProvider]
  Provider --> Cache[JsonFileCache]
  Provider --> Yahoo[Yahoo Finance]
  Pipeline --> Filters[Filter Engine]
  Pipeline --> Scoring[Weighted Scoring]
  Scoring --> Excel[Excel Exporter]
  Scoring --> Charts[Plotly Charts]
```

## Design patterns

- **Provider interface** isolates data sources from screening logic.
- **Pipeline orchestration** keeps CLI thin and testable.
- **Functional filter/scoring modules** are deterministic and unit-testable.
- **Cache + retry layer** improves reliability for public APIs.
- **Exporters** separate presentation from analytics.

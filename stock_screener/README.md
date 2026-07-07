# Python Stock Screening Application

A Python-based stock screening application for investment analysts. It pulls public-company market and financial data from financial APIs, filters companies using customizable criteria, exports Excel results, generates interactive charts, and ranks stocks using weighted scoring.

> **Disclaimer:** This tool is for research workflow automation and education only. It is not investment advice.

## Features

- Fetches company fundamentals with `yfinance`
- Screens stocks by:
  - P/E ratio
  - EV/EBITDA
  - ROE
  - Revenue growth
  - Free cash flow growth
  - Debt-to-equity
  - Gross margin
  - Market capitalization
- Supports fully customizable YAML filters and scoring weights
- Exports results to Excel with formatted tabs:
  - `Screen Results`
  - `Passed Screen`
  - `Top 10`
- Generates interactive Plotly HTML charts:
  - Weighted score ranking
  - Growth vs. valuation scatter plot
  - Top-results table
- Produces analyst-friendly ranking and pass/fail flags

## Project Architecture

```text
stock_screener/
├── pyproject.toml
├── README.md
├── config/
│   └── default_config.yaml
├── sample_outputs/
│   ├── stock_screen_results.xlsx
│   └── stock_screen_charts.html
└── src/
    └── stock_screener/
        ├── __init__.py
        └── cli.py
```

## Installation

```bash
cd stock_screener
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\\Scripts\\activate
pip install -e .
```

Or run directly with `uv`:

```bash
uv run --with yfinance --with pandas --with numpy --with openpyxl --with plotly --with pyyaml python src/stock_screener/cli.py --config config/default_config.yaml
```

## Usage

```bash
stock-screener --config config/default_config.yaml
```

The tool creates:

- `sample_outputs/stock_screen_results.xlsx`
- `sample_outputs/stock_screen_charts.html`

## Configuration

Edit `config/default_config.yaml` to change ticker universe, thresholds, output files, or scoring weights.

```yaml
tickers:
  - AAPL
  - MSFT
  - NVDA

filters:
  market_cap_min: 50000000000
  pe_max: 80
  ev_ebitda_max: 60
  roe_min: 0.05
  revenue_growth_min: 0.00
  fcf_growth_min: -0.50
  debt_to_equity_max: 3.00
  gross_margin_min: 0.20

weights:
  pe_ratio: 0.15
  ev_ebitda: 0.15
  roe: 0.15
  revenue_growth: 0.15
  fcf_growth: 0.10
  debt_to_equity: 0.10
  gross_margin: 0.10
  market_cap: 0.10
```

## How Scoring Works

Each metric is normalized between 0 and 1, then multiplied by its assigned weight:

- **Lower is better:** P/E, EV/EBITDA, debt-to-equity
- **Higher is better:** ROE, revenue growth, FCF growth, gross margin, market cap

Final score:

```text
Weighted Score = SUM(Normalized Metric Score × Metric Weight) × 100
```

The highest score receives Rank 1.

## How Investment Analysts Could Use This Tool

Analysts can use the screener as a first-pass idea generation and monitoring tool:

1. **Universe definition:** Build a sector, geography, or market-cap-specific ticker list.
2. **Quality filter:** Use ROE, gross margin, FCF growth, and debt-to-equity to find durable businesses.
3. **Valuation discipline:** Apply P/E and EV/EBITDA ceilings to avoid obviously expensive names.
4. **Growth overlay:** Rank companies by revenue growth and FCF growth to identify compounding opportunities.
5. **Shortlist creation:** Export the top-ranked companies to Excel for deeper DCF, trading comps, and thesis work.
6. **Committee materials:** Use the interactive charts in stock pitch decks and investment committee screens.

## Extensions

Potential next improvements:

- Add sector-relative scoring instead of cross-sector scoring
- Integrate FactSet / Bloomberg / Capital IQ APIs for institutional data quality
- Add analyst estimate revisions and price momentum
- Add backtesting of screen rules
- Add Streamlit or Dash front end
- Schedule weekly refreshes and email results automatically

## Data Notes

The default implementation uses public Yahoo Finance data via `yfinance`. Public API fields can be missing or stale; validate all outputs against company filings or a professional market-data platform before investment use.

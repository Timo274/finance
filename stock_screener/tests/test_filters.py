import pandas as pd

from stock_screener.screening.filters import passes_filters


def test_passes_filters_true():
    row = pd.Series(
        dict(
            market_cap=100,
            pe_ratio=20,
            ev_ebitda=10,
            roe=0.2,
            revenue_growth=0.1,
            fcf_growth=0.05,
            debt_to_equity=0.5,
            gross_margin=0.6,
        )
    )
    assert passes_filters(
        row,
        dict(
            market_cap_min=50,
            pe_max=30,
            ev_ebitda_max=15,
            roe_min=0.1,
            revenue_growth_min=0,
            fcf_growth_min=0,
            debt_to_equity_max=1,
            gross_margin_min=0.4,
        ),
    )


def test_passes_filters_false_on_missing():
    assert not passes_filters(pd.Series(dict(market_cap=None)), dict(market_cap_min=1))

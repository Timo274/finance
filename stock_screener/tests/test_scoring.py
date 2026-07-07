import pandas as pd

from stock_screener.screening.scoring import score


def test_score_ranks_higher_quality_first():
    df = pd.DataFrame(
        [
            dict(ticker="A", passed_screen=True, pe_ratio=10, roe=0.3),
            dict(ticker="B", passed_screen=True, pe_ratio=40, roe=0.05),
        ]
    )
    out = score(df, {"pe_ratio": 0.5, "roe": 0.5})
    assert out.iloc[0]["ticker"] == "A"
    assert out.iloc[0]["rank"] == 1

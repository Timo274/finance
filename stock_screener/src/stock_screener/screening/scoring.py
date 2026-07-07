from __future__ import annotations

import pandas as pd

LOWER_IS_BETTER = {"pe_ratio", "ev_ebitda", "debt_to_equity"}
HIGHER_IS_BETTER = {"roe", "revenue_growth", "fcf_growth", "gross_margin", "market_cap"}


def normalize(series: pd.Series, higher_is_better: bool) -> pd.Series:
    s = pd.to_numeric(series, errors="coerce")
    filled = s.fillna(s.median() if s.notna().any() else 0)
    low, high = filled.min(), filled.max()
    if high == low:
        return pd.Series([0.5] * len(s), index=s.index)
    score = (filled - low) / (high - low)
    return score if higher_is_better else 1 - score


def score(df: pd.DataFrame, weights: dict[str, float]) -> pd.DataFrame:
    out = df.copy()
    total = sum(weights.values()) or 1
    components = []
    for metric, weight in weights.items():
        if metric not in out.columns:
            continue
        name = f"score_{metric}"
        components.append(name)
        out[name] = normalize(out[metric], metric in HIGHER_IS_BETTER) * (weight / total)
    out["weighted_score"] = out[components].sum(axis=1) * 100 if components else 0
    out["rank"] = out["weighted_score"].rank(method="dense", ascending=False).astype(int)
    return out.sort_values(["passed_screen", "weighted_score"], ascending=[False, False])

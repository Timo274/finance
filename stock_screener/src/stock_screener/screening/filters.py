from __future__ import annotations

import pandas as pd


def passes_filters(row: pd.Series, filters: dict[str, float]) -> bool:
    rules = [
        ("market_cap", ">=", filters.get("market_cap_min")),
        ("pe_ratio", "<=", filters.get("pe_max")),
        ("ev_ebitda", "<=", filters.get("ev_ebitda_max")),
        ("roe", ">=", filters.get("roe_min")),
        ("revenue_growth", ">=", filters.get("revenue_growth_min")),
        ("fcf_growth", ">=", filters.get("fcf_growth_min")),
        ("debt_to_equity", "<=", filters.get("debt_to_equity_max")),
        ("gross_margin", ">=", filters.get("gross_margin_min")),
    ]
    for column, op, threshold in rules:
        if threshold is None:
            continue
        value = row.get(column)
        if value is None or pd.isna(value):
            return False
        if op == ">=" and value < threshold:
            return False
        if op == "<=" and value > threshold:
            return False
    return True

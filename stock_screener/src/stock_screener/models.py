from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CompanyMetrics:
    ticker: str
    company: str | None = None
    sector: str | None = None
    industry: str | None = None
    market_cap: float | None = None
    pe_ratio: float | None = None
    ev_ebitda: float | None = None
    roe: float | None = None
    revenue_growth: float | None = None
    fcf_growth: float | None = None
    debt_to_equity: float | None = None
    gross_margin: float | None = None
    current_price: float | None = None
    recommendation: str | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, object]:
        return self.__dict__.copy()

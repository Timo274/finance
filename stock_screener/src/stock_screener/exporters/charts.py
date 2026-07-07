from __future__ import annotations

from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go


def export_charts(df: pd.DataFrame, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    top = df.sort_values("weighted_score", ascending=False).head(15)
    fig1 = px.bar(
        top,
        x="weighted_score",
        y="ticker",
        orientation="h",
        color="passed_screen",
        template="plotly_white",
        title="Top Ranked Stocks by Weighted Score",
    )
    fig1.update_layout(yaxis={"categoryorder": "total ascending"})
    fig2 = px.scatter(
        df,
        x="ev_ebitda",
        y="revenue_growth",
        size="market_cap",
        color="weighted_score",
        hover_name="ticker",
        template="plotly_white",
        title="Growth vs Valuation",
    )
    fig3 = go.Figure(
        data=[
            go.Table(
                header=dict(
                    values=["Rank", "Ticker", "Score", "Passed"],
                    fill_color="#0B1F33",
                    font=dict(color="white"),
                ),
                cells=dict(
                    values=[
                        df["rank"],
                        df["ticker"],
                        df["weighted_score"].round(1),
                        df["passed_screen"],
                    ]
                ),
            )
        ]
    )
    html = (
        "<html><body>"
        + fig1.to_html(full_html=False, include_plotlyjs="cdn")
        + fig2.to_html(full_html=False, include_plotlyjs=False)
        + fig3.to_html(full_html=False, include_plotlyjs=False)
        + "</body></html>"
    )
    path.write_text(html, encoding="utf-8")

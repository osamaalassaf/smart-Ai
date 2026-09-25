# Changes

Six files changed. Everything else in the project is untouched.

```
ml_explainer.py            two bug fixes
app.py                     removed fabricated code, wired the real modules
static/js/app.js           added the missing handlers, fixed navigation
templates/operations.html  cleaned the markup
static/css/app.css         styles for the LIME panel
requirements.txt           rebuilt from actual imports
```

---

## 1 · The LIME error, fixed at its source

`ml_explainer.py:287`

```python
for condition, weight in exp.as_list(num_features=num_features):
```

`num_features` belongs to `explain_instance()`, which had already been given it
four lines above. Passing it again to `as_list()` sends it somewhere it cannot
go:

```python
Explanation.as_list(self, label=1, **kwargs)
    -> self.domain_mapper.map_exp_ids(local_exp, **kwargs)

TableDomainMapper.map_exp_ids(self, exp)      # accepts no keyword arguments
```

Hence the exact message you saw. The fix is to drop the argument:

```python
for condition, weight in exp.as_list():
```

This is not a version problem, and retrying without the argument as a
"fallback" would have been treating the symptom.

### A second bug was hiding behind the first

With line 287 fixed, the next line to run failed:

```
TypeError: float() argument must be a string or a real number, not 'dict'
```

`exp.intercept` is keyed by label — `{0: 158.22}` in regression mode, not a
float. The existing guard checked for list, tuple and ndarray but not dict, so
it fell through to `float(dict)`. `exp.local_pred` is a one-element array and
`exp.score` is a float in regression but a dict in classification.

Added a `_scalar()` helper that flattens all four shapes, and routed the three
attributes through it. This also means the module will not break if the model
ever moves to classification mode.

Both fixes verified against the real model and dataset:

```
2016-01-08 18:00 · B001 · 1.5s
predicted 58.15 kW · actual 58.30 · R² 0.175
  -80.677 kW  53.47 < energy_lag_1 <= 78.70
   -9.238 kW  hour > 17.00
   +7.449 kW  energy_lag_168 <= 53.47
```

---

## 2 · Removing the fabricated endpoint

The `app.py` in this upload was the copy I gave you last round, so it carried a
`/api/ml/explain` that never called LIME. It returned the same five hardcoded
weights for every building, every hour and every model:

```python
{"name": "Recent consumption trend", "weight": 0.35},
{"name": "Temperature difference",   "weight": 0.25},
```

That was mine and it was wrong to write. For an explainability feature it is
worse than a broken button: the numbers look like evidence and are not.

It is gone. `/api/ml/explain` now calls `ml_explainer.explain_prediction()` —
the module you already had, which does the real work. When an explanation
cannot be produced the endpoint returns the reason:

| Condition | Response |
|---|---|
| LIME or the model file missing | 503 with what to install |
| No model row for that hour | 404 `No model input row for B001 at …` |
| Unknown building | 400 `Use B001, B002, B003 or CAMPUS` |
| Missing timestamp or building | 400 |

`GET /api/ml/explain/status` reports availability up front, via your
`is_available()`.

---

## 3 · The PDF report

`/api/report/pdf` now renders `report_service.build_report()` — the same
structure your Markdown export uses, so the two cannot drift apart. The
snapshot is read server-side from `service.snapshot()` rather than from the
request body, so the PDF cannot disagree with what the agent actually decided.

Five sections:

1. **What went wrong** — event type, building, hour, severity, the problem
   facts
2. **What the agent checked** — readings at the event hour, plus the
   per-building breakdown
3. **How the action was chosen** — every candidate with its simulated
   reduction, optimiser score and verdict; then the selected action, why it won,
   and the human decisions
4. **Why the model forecast what it did** — the LIME table
5. **What happened after execution** — expected vs achieved reduction,
   performance percentage, outcome

Sections 4 and 5 state plainly when there is nothing to show rather than
printing blanks.

One bug found while testing this: a campus-wide explanation nests one result per
building under `buildings`, so reading `contributions` at the top level came
back empty and section 4 wrongly claimed no explanation existed — while the
disclaimer at the bottom said LIME had been used. Both shapes are handled now.

Verified end to end on a real run:

```
PEAK_DEMAND_RISK · CAMPUS · 2017-12-11 16:00 · CRITICAL
4 pages
§3  Combined HVAC, EV and battery action · 70.3 kW · score 62.28 · Recommended
§4  Administration R² 0.011 · Labs R² 0.788 · Classrooms R² 0.009
§5  expected 70.3 kW · achieved 66.1 kW · 94% · SUCCESS
```

---

## 4 · The buttons that did nothing

`operations.html` had the two buttons. `static/js/app.js` had no handlers for
them and no listeners — clicking did nothing at all, which is what you saw.

Added `loadExplanation()`, `renderExplanation()`, `downloadReport()` and
`setExplainButtons()`, and wired them in `initPage()` under `operations`.

Both buttons start disabled and enable once there is something to act on:
Explain needs an active event, Download needs a completed run. That replaces the
previous behaviour of letting you click and then getting an error toast.

The LIME panel shows the forecast, the actual reading, the residual, the
surrogate baseline and the local fit R², then one bar per feature — red raises
the forecast, green lowers it. Campus explanations render one block per
building.

**R² is shown deliberately.** In the run above, Labs fits at 0.788 while
Administration fits at 0.011. Those two explanations do not deserve equal
trust, and hiding the number would make the weaker one look authoritative.

---

## 5 · Analyze → Operations

`runAgent()` now navigates to Operations when Analyze is pressed from another
page, and stays put when you are already there.

It reads the target from the nav link rather than hardcoding `/operations`. That
matters more than it sounds: the Digital Twin route is `/digital-twin`, not
`/digital_twin`, so a hardcoded path is a real risk in this project.

---

## 6 · requirements.txt

The version in the upload was also mine and had errors: `lime==0.2.0` does not
exist on PyPI (the release is `0.2.0.1`), and `shap`, `SQLAlchemy` and
`colorlog` were listed but never imported.

Rebuilt from the project's actual imports.

**One thing worth knowing:** `models/energy_forecast_model.pkl` was pickled with
**scikit-learn 1.9.0**. Loading it under 1.8 raises `InconsistentVersionWarning`
and the predictions are not guaranteed to match. Install 1.9 or newer, or
retrain with `run_pipeline.py` on whatever version you have. The old
`scikit-learn==1.3.0` pin would have hit this.

---

## Verified

```
pages          /overview /energy /operations /digital-twin
               /verification /knowledge /activity        200
APIs           health buildings dashboard energy events
               agent/status agent/history verification
               ml/explain/status                          200
full cycle     run → explain → approve → verify → PDF     200
failure paths  no run · bad building · missing fields
               · hour outside the dataset      correct codes
syntax         app.py · ml_explainer.py · app.js          clean
```

## Install

```bash
pip install -r requirements.txt
python app.py
```

`lime` and `reportlab` are the new dependencies. Without them the app still
starts and the two buttons return 503 naming what is missing.

---

## 7 · Plain-language summary above the LIME bars

`ml_explainer.summarize_explanation()` turns one explanation into a short
paragraph. Wired into three places:

- `POST /api/ml/explain` returns it as `summary`
- the Operations panel renders it above the bars
- section 4 of the PDF prints it above the table

It is optional throughout. Without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` the
field is `null`, no paragraph appears, and the bars, the table and the report
are unchanged. Any network failure is swallowed the same way — the LIME table is
the real output and never depends on the paragraph.

`GET /api/ml/explain/status` now also reports `summary_available` and, when it
is false, why.

The language model never sees or produces a number. It is given the factors in
rank order with a direction each — "the load in the previous hour pushed the
forecast higher" — so it cannot quote a contribution value. When the local fit
R² is below 0.3 the prompt says so and asks for tentative wording, which matters
here: on one campus event the three buildings fitted at 0.788, 0.011 and 0.009.

Results are cached per building and hour, so pressing the button twice or
printing a report after using it costs nothing.

### A pre-existing bug this surfaced

Building the prompt produced "the load in the previous hour" twice, with
opposite directions. The cause was in `_explain_building`:

```python
for feature in features:
    if feature in condition:      # "energy_lag_1" is inside "energy_lag_168"
```

First match wins, so contributions from `energy_lag_168` were attributed to
`energy_lag_1`, and `hour_cos` and `hour_sin` to `hour`. This affected the
`feature` and `value` fields in the dashboard and the report too, not just the
summary. Fixed by matching the longest name first.

Features that legitimately share one phrase — `hour`, `hour_sin`, `hour_cos` are
all "the hour of day" — are now merged by summing their weights, so the
paragraph gets one net direction instead of three contradictory lines.

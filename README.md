# Launch Radar

A token launch radar for make.fun's token-radar-01 bounty: pre-token protocols ranked by
expected launch value, with the working shown.

Suggested entry title: "Launch Radar: comps-calibrated size curve x launch odds from the peers'
record, every term tested held-out (LOO x3.01), costed farm verdicts, all 758 protocols accounted"

## The model

- **Size curve, comps-calibrated.** Fitted by least squares on the snapshot's launch-like traded
  comps (market-cap / TVL inside 0.005 to 10; exchange tokens excluded): log(market cap) =
  intercept + slope x log(TVL) + a per-category offset shrunk toward zero by its comp count.
- **Tested held-out.** Leave-one-out over the fitted comps: median error x3.01, against x4.45 for
  the global median multiple and x4.20 for a flat 0.25 x TVL on the same comps. Each row's honest
  range is its expected value divided and multiplied by that factor.
- **Token odds from the peers' record.** The share of protocols already holding a token rises
  with age in the snapshot's own cross-section; a protocol still tokenless at its age lists with
  odds (A - S(age)) / (1 - S(age)): the longer it has run with no token, the lower its odds.
- **Farm verdicts, costed then netted.** Each plan prices its chain's gas and its capital's
  opportunity cost, and nets them against the expected airdrop (a stated 5% community allocation
  of expected launch value over competing wallets scaled by TVL): FARM, THIN or SKIP.
- **Full accounting.** All 758 protocols in the snapshot are ranked, set aside as live, or
  excluded with a reason, on the dashboard's integrity strip; the page recomputes every row from
  the shipped fit and reports how many agree.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22.18+, standard library only. The program is deterministic: two runs write the same bytes.

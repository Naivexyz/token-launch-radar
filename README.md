# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Naivexyz/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Naivexyz/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's [token-radar-01 bounty](https://make.fun/bounty/token-radar-01): pre-token protocols ranked by expected launch value, with the working shown. Entry title: "Launch Radar v2: every value term kept or dropped on two blind tests (leave-one-out x3.01, walk-forward x2.62), token odds from the peers' record, integrity strip, costed farm verdicts".

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

## The model

- **Size curve, comps-calibrated.** Fitted by least squares on the snapshot's launch-like traded
  comps (market-cap / TVL inside 0.005 to 10; exchange tokens excluded): log(market cap) =
  intercept + slope x log(TVL) + a per-category offset shrunk toward zero by its comp count.
- **Tested held-out twice.** Leave-one-out over the fitted comps: median error x3.01, against
  x4.45 for the global median multiple and x4.20 for a flat 0.25 x TVL on the same comps.
  Walk-forward in time: fitted on the earlier half of the dated comps (split 2024-02-28), the
  later half prices at a median error of x2.62. Each row's range is the interquartile band of
  the leave-one-out residuals (x0.33 to x2.79).
- **Every term ablated.** Each term was removed alone and both blind tests re-run; the table
  ships on the dashboard. Two candidates failed and are out: a growth tilt on 7-day TVL change
  (best grid weight still worsened leave-one-out) and a monotone smoothing of the token-share
  curve (worse split-half Brier than the raw shares, 0.2241 against 0.2237).
- **Token odds from the peers' record.** The share of protocols already holding a token in each
  age band of the snapshot's own cross-section, used raw; a protocol still tokenless at its age
  lists with odds (A - S(age)) / (1 - S(age)): the longer it has run with no token, the lower
  its odds.
- **Farm verdicts, costed then netted.** Each plan prices its chain's gas and its capital's
  opportunity cost, and nets them against the expected airdrop (a stated 5% community allocation
  of expected launch value over competing wallets scaled by TVL): FARM, THIN or SKIP.
- **Full accounting.** All 758 protocols in the snapshot are ranked, set aside as live, or
  excluded with a reason, on the dashboard's integrity strip; the page recomputes every row from
  the shipped fit and reports how many agree.

Node 22.18+, standard library only. The program is deterministic: two runs write the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

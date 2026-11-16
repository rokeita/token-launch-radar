# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/rokeita/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/rokeita/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: 178 pre-token protocols ranked by implied launch value, from a sealed DefiLlama snapshot of 758 protocols. The watchlist (40 protocols at or above $50M TVL) is covered in full, and the early radar adds every launchable protocol below that floor — wrapped, staked, bridged and exchange products are left out, because their token already trades. Each row carries an implied value from one model (TVL, seven-day growth, age with no token, and chain breadth) and a seven-step farm plan with costs and times. The dashboard is a static page with search, filters, sorting, a per-protocol detail drawer, and a live-token view kept apart from the ranking.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=f419cs6j&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

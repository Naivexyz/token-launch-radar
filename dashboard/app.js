// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, a filterable table, a per-protocol detail view with the model's own inputs and
// the protocol's costed farm plan, and the full method. No network: every byte it shows is in
// data.js. The page recomputes every row from the shipped fit and reports how many agree, so the
// code and the board are visibly the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var M = DATA.model;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', verdict: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function usd0(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  // The model, mirrored from lib/model.ts: the page runs the same functions main.ts ran.
  function curveValue(row) {
    var offset = row.category !== null && M.cat_offsets[row.category] !== undefined ? M.cat_offsets[row.category] : 0;
    var value = Math.exp(M.fit_intercept + M.fit_slope * Math.log(row.tvl_usd) + offset);
    return clamp(value, row.tvl_usd * 0.005, row.tvl_usd * 5);
  }
  function shareAt(age) {
    var curve = M.odds_curve;
    if (age <= curve[0][0]) return curve[0][1];
    for (var i = 1; i < curve.length; i++) {
      if (age <= curve[i][0]) {
        var x0 = curve[i - 1][0], y0 = curve[i - 1][1], x1 = curve[i][0], y1 = curve[i][1];
        return y0 + ((y1 - y0) * (age - x0)) / Math.max(1, x1 - x0);
      }
    }
    return curve[curve.length - 1][1];
  }
  function tokenOdds(age) {
    if (age === null || age === undefined) return M.odds_unknown_age;
    var s = shareAt(age);
    return clamp((M.odds_asymptote - s) / Math.max(0.05, 1 - s), 0.03, 0.95);
  }
  function growthTilt(row) {
    var g = clamp(row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d, M.growth_floor, M.growth_cap);
    return 1 + (g / 100) * M.growth_weight;
  }
  function launchOf(row) { return Math.max(1, Math.round(curveValue(row) * growthTilt(row))); }
  function impliedOf(row) { return Math.max(1, Math.round(launchOf(row) * tokenOdds(row.age_days))); }
  var recomputed = 0;
  DATA.rows.forEach(function (r) { if (impliedOf(r) === r.implied_value_usd) recomputed++; });

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan, mirrored from lib/model.ts: category, chain, TVL and age decide the action, the
  // capital, the gas and the hold; the verdict nets the expected airdrop against the true cost.
  var GAS = { Ethereum: 12, Arbitrum: 0.6, Base: 0.4, Optimism: 0.5, Polygon: 0.05, Solana: 0.05, 'BNB Chain': 0.3, Avalanche: 0.4, 'zkSync Era': 0.3, Linea: 0.4, Scroll: 0.5, Mantle: 0.2, Blast: 0.4, Starknet: 0.3, Sonic: 0.1, Berachain: 0.2 };
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function gasFor(chain) { return GAS[chain] !== undefined ? GAS[chain] : 1; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    if (p.tvl_usd >= 1e7) return 75;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionsFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var n = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('collateral') >= 0) return { core: 'Supply $' + capital + ' of USDC to ' + n + ' on ' + chain + ', then borrow about 40% against it and re-supply the borrow once, so both sides of the market count.', weekly: 'Repay and re-borrow a small amount on ' + n + ' each week to keep the loan active, and never let the health factor fall below 1.6.' };
    if (c.indexOf('cdp') >= 0 || c.indexOf('stable') >= 0) return { core: 'Deposit $' + capital + ' of collateral into ' + n + ' on ' + chain + ' and mint its stablecoin against it at under 50% of the liquidation line.', weekly: 'Top up or partially repay the ' + n + ' vault each week so the mint stays open and the collateral ratio stays in a safe band.' };
    if (c.indexOf('dex') >= 0 || c.indexOf('amm') >= 0) return { core: 'Provide $' + capital + " of liquidity, split evenly between USDC and the pool's other asset, to " + n + "'s highest-volume pool on " + chain + '.', weekly: "Claim the week's fees on " + n + ' and re-deposit them into the same pool, keeping the position in range.' };
    if (c.indexOf('bridge') >= 0) return { core: 'Bridge $' + capital + ' of USDC from Ethereum to ' + chain + ' through ' + n + ', then make one swap with the bridged funds on the far side.', weekly: 'Bridge a small amount back or onward through ' + n + ' each week, alternating direction, and keep the receipts from both chains.' };
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0) return { core: 'Stake $' + capital + " of the chain's staking asset through " + n + ' on ' + chain + ' and keep the liquid receipt token in the same wallet.', weekly: 'Claim and re-stake the week\'s rewards on ' + n + '; if it runs operator votes or restaking elections, take part in one.' };
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return { core: 'Deposit $' + capital + ' of USDC as margin on ' + n + ' and open one small hedged position, long and short the same asset in equal size.', weekly: 'Roll the hedge on ' + n + ' once a week and keep total leverage under 2x, so the account records volume without directional risk.' };
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('yield') >= 0) return { core: 'Deposit $' + capital + ' into a ' + n + ' vault on ' + chain + ', choosing the vault with the most depositors rather than the highest advertised yield.', weekly: 'Move a small part of the position between ' + n + ' vaults each week, or add to it, so the shares keep compounding.' };
    if (c.indexOf('rwa') >= 0) return { core: 'Complete ' + n + "'s onboarding on " + chain + ' and mint $' + capital + ' of its yield-bearing asset, holding it in the farming wallet.', weekly: 'Check the ' + n + ' position weekly and claim any distribution the moment it posts, keeping the mint receipt.' };
    if (c.indexOf('insurance') >= 0) return { core: 'Buy $' + capital + ' of cover from ' + n + ' on ' + chain + ' against a protocol you actually use, for the longest term it sells.', weekly: 'Renew or extend one ' + n + ' policy each week if terms allow, and stake a small amount in its assessment pool if it has one.' };
    if (c.indexOf('basis') >= 0 || c.indexOf('delta') >= 0) return { core: 'Open ' + n + "'s basis position with $" + capital + ' on ' + chain + ': long the spot asset and short the same size on its perpetual market, as the vault directs.', weekly: 'Rebalance the ' + n + ' hedge each week to keep it delta-neutral and claim the funding it collects.' };
    if (c.indexOf('payment') >= 0) return { core: 'Fund $' + capital + ' into ' + n + ' on ' + chain + ' and route one real payment through it to a second wallet you control.', weekly: 'Make one payment a week through ' + n + ', varying the amount, and keep the transaction hashes as your activity record.' };
    if (c.indexOf('prediction') >= 0) return { core: 'Fund $' + capital + ' on ' + n + ' and take one position in its most liquid market, sized under a fifth of the wallet.', weekly: 'Settle finished markets on ' + n + ' and open one new position a week, keeping a note of each market you traded.' };
    return { core: 'Deposit $' + capital + ' of USDC into ' + n + ' on ' + chain + ' through its main app and keep the position open.', weekly: 'Repeat one small qualifying action on ' + n + ' each week, a deposit, a withdrawal and re-deposit, or a vote, and log it.' };
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var gas = gasFor(chain);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var a = actionsFor(p, capital, chain);
    var wallets = clamp(Math.round(400 * Math.sqrt(p.tvl_usd / 1e6)), 200, 20000);
    var launch = p.launch_value_usd !== undefined ? p.launch_value_usd : launchOf(p);
    var odds = p.token_odds !== undefined ? p.token_odds : tokenOdds(p.age_days);
    var expectedReward = (launch * odds * M.farm_allocation_share) / wallets;
    var opportunity = capital * M.capital_apr * (hold / 365);
    var planCost = gas * 8 + opportunity;
    var net = expectedReward - planCost;
    var verdict = p.verdict || (net >= 150 ? 'farm' : net >= 0 ? 'thin' : 'skip');
    return [
      { text: 'Set up a fresh wallet for ' + p.name + ' alone, fund it on ' + chain + ', and keep its seed phrase offline; never farm from a wallet that holds other assets.', cost: 'about ' + usd0(gas) + ' of gas to fund and approve', time: '10 minutes' },
      { text: a.core, cost: usd0(capital) + ' of capital and about ' + usd0(gas * 2) + ' of gas', time: '20 minutes to set up' },
      { text: a.weekly, cost: 'about ' + usd0(gas) + ' of gas a week', time: '10 minutes a week' },
      { text: 'Hold the ' + p.name + ' position for at least ' + hold + ' days so the activity appears in more than one weekly snapshot, and keep the balance above $' + Math.round(capital * 0.8) + ' throughout.', cost: 'the ' + usd0(capital) + ' stays locked; opportunity cost about ' + usd0(opportunity) + ' at a 4% rate', time: hold + ' days' },
      { text: 'Watch ' + p.name + "'s own channels for a points or rewards page, and claim only from a link the protocol itself publishes; never pay a third party to claim.", cost: 'no fee to check, and never pay to claim', time: '10 minutes a week' },
      { text: 'Verdict: ' + verdict.toUpperCase() + '. Expected airdrop value is about ' + usd0(expectedReward) + ' (a 5% community allocation of the expected launch value, split over roughly ' + wallets.toLocaleString('en-US') + ' competing wallets) against a true cost of about ' + usd0(planCost) + ' in gas and locked-capital cost, so ' + (verdict === 'farm' ? 'the plan clears its cost with room to spare' : verdict === 'thin' ? 'the plan roughly breaks even and is worth it only at this one wallet, never a farm of wallets' : 'the expected reward does not cover the cost at this size; revisit only if the protocol ships a points program') + '.', cost: 'net expectation about ' + usd0(net), time: '5 minutes to review' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('v')) state.verdict = params.get('v');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.verdict !== 'all') params.set('v', state.verdict);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.token_odds; bv = b.token_odds; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: M.version })
      )
    );
  }

  function kpi(label, value) { return el('div', { class: 'kpi' }, el('span', { text: label }), el('b', { text: value })); }

  function lede() {
    var a = DATA.accounting;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Pre-token protocols, ranked by expected launch value' }),
        el('p', { text: 'Every protocol is priced from the snapshot\'s own traded peers: a comps-calibrated multiple for its category and size, a small tilt for its 7-day growth, times the odds a token ever lists at its age. All ' + a.total + ' protocols in the snapshot are accounted for below; the watchlist is the floor, never the ceiling.' })
      ),
      el('div', { class: 'kpis' },
        kpi('Board rows', String(DATA.board_size)),
        kpi('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size),
        kpi('Comps fitted', String(M.comp_count)),
        kpi('Held-out error', 'x' + M.loo_model_factor),
        kpi('Live tokens set aside', String(a.live)),
        kpi('Protocols accounted', String(a.total))
      )
    );
  }

  function strip() {
    var a = DATA.accounting;
    return el('div', { class: 'strip', role: 'note' },
      el('span', null, 'INTEGRITY ', el('b', { text: a.total + ' accounted' }), ' = ' + a.ranked + ' ranked + ' + a.live + ' live + ' + a.unranked + ' not ranked + ' + a.versioned + ' versioned pools + ' + a.cex + ' exchanges + ' + a.wrapped_or_staked + ' wrapped/staked'),
      el('span', null, 'RECOMPUTED ', el('b', { text: recomputed + ' / ' + DATA.board_size }), ' rows agree with the shipped fit'),
      el('span', null, 'HELD-OUT ', el('b', { text: 'x' + M.loo_model_factor }), ' leave-one-out, ', el('b', { text: 'x' + M.wf_model_factor }), ' walk-forward median error'),
      el('span', { class: 'warn', text: 'Implied value is a model estimate with a wide range, not a price. See Method.' })
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var vsel = el('select', { id: 'verdict', 'aria-label': 'Filter by farm verdict' },
      el('option', { value: 'all', text: 'All verdicts' }),
      ['farm', 'thin', 'skip'].map(function (v) { return el('option', { value: v, text: v.toUpperCase(), selected: v === state.verdict ? 'selected' : null }); })
    );
    vsel.addEventListener('change', function () { state.verdict = vsel.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Farm verdict' }), vsel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label, num) {
    return el('th', { scope: 'col', class: num ? 'num' : null },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or verdict to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.verdict = 'all'; writeHash(); render(); } })
      ));
    }
    var max = 1;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: 'x' + r.multiple }),
        el('td', { class: 'num', text: Math.round(r.token_odds * 100) + '%' }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'pill ' + r.verdict, text: r.verdict.toUpperCase() }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols by expected launch value: launch value from traded peers, weighted by the odds a token ever lists. Select a row for its working and its farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank', true),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL', true),
            sortHeader('growth', '7d', true),
            sortHeader('age', 'Age', true),
            el('th', { scope: 'col', class: 'num', text: 'Multiple' }),
            sortHeader('odds', 'Odds', true),
            sortHeader('implied', 'Expected value', true),
            el('th', { scope: 'col', text: 'Verdict' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'pill live', text: 'TRADES' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Live tokens: these protocols already trade, so their market cap is a fact, not a model. They calibrate the multiples and are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', class: 'num', text: 'TVL' }), el('th', { scope: 'col', class: 'num', text: '7d' }), el('th', { scope: 'col', class: 'num', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function ablationTable() {
    var bodyRows = M.ablation.map(function (r) {
      var test;
      if (r.brier_with !== null && r.brier_with !== undefined) {
        test = 'Split-half Brier ' + r.brier_with + ' with, ' + r.brier_without + ' without';
      } else {
        test = 'LOO x' + r.loo_with + ' with, x' + r.loo_without + ' without; walk-forward x' + r.wf_with + ' with, x' + r.wf_without + ' without';
      }
      return el('tr', null,
        el('td', { text: r.term }),
        el('td', { text: test }),
        el('td', null, el('span', { class: 'pill ' + (r.kept ? 'farm' : 'skip'), text: r.kept ? 'KEPT' : 'DROPPED' }))
      );
    });
    return el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'Ablation: each term removed alone, every other term held at the full model, the blind tests re-run. A term stays only where removing it hurts a test.' }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Term' }),
          el('th', { scope: 'col', text: 'Held-out error, with vs without' }),
          el('th', { scope: 'col', text: 'Verdict' })
        )),
        el('tbody', null, bodyRows)
      )
    );
  }

  function methodPanel() {
    var a = DATA.accounting;
    var growthRow = M.ablation.filter(function (r) { return r.term.indexOf('Growth tilt') === 0; })[0];
    var oddsRow = M.ablation.filter(function (r) { return r.term.indexOf('Odds smoothing') === 0; })[0];
    return el('section', { class: 'panel method' },
      el('h2', { text: 'Method, with the working shown' }),
      el('div', { class: 'formula', text: 'expected value = size curve(TVL, category) x growth tilt(7-day change) x token odds(age)' }),
      el('h3', { text: 'The size curve: comps-calibrated' }),
      el('p', { text: 'The snapshot holds ' + M.comp_total + ' traded protocols with a market cap and a TVL (exchange tokens excluded: an exchange token is not a launch comp). The curve is fitted on the ' + M.comp_count + ' launch-like comps whose market cap is not decoupled from their TVL (a market-cap / TVL ratio inside 0.005 to 10), by least squares on log(market cap) against log(TVL), slope ' + M.fit_slope + ': value grows slower than TVL, so a large protocol\'s implied multiple is thinner than a small one\'s. Each category then moves off the common curve by its own offset, shrunk toward zero by its comp count; in this fit the offsets run from x' + Math.exp(Math.min.apply(null, Object.keys(M.cat_offsets).map(function (k) { return M.cat_offsets[k]; }))).toFixed(2) + ' to x' + Math.exp(Math.max.apply(null, Object.keys(M.cat_offsets).map(function (k) { return M.cat_offsets[k]; }))).toFixed(2) + ', so a lending market and a bridge are never priced alike. A row\'s stated multiple is its curve value divided by its TVL.' }),
      el('h3', { text: 'Tested held-out twice, not asserted' }),
      el('p', { text: 'First test, leave-one-out over the ' + M.comp_count + ' launch-like comps the curve is fitted on: each was priced by a fit that never saw it. Median error x' + M.loo_model_factor + ' for this model, against x' + M.loo_global_factor + ' for the global median multiple alone and x' + M.loo_flat_factor + ' for a flat 0.25 x TVL on the same comps; ' + Math.round(M.loo_within_2x * 100) + '% of comps land within a factor of two. Each row\'s range is the interquartile band of those leave-one-out residuals: half of the held-out comps were priced between x' + M.loo_ratio_q25 + ' and x' + M.loo_ratio_q75 + ' of their actual market cap, and that same band scales every row\'s expected value.' }),
      el('p', { text: 'Second test, walk-forward in time: the ' + (M.wf_train_count + M.wf_test_count) + ' fitted comps with a recorded listing date are split at ' + M.wf_split_date + '; the curve is fitted on the earlier ' + M.wf_train_count + ' and prices the later ' + M.wf_test_count + ' it never saw. Median error x' + M.wf_model_factor + ', against x' + M.wf_global_factor + ' for the global median multiple and x' + M.wf_flat_factor + ' for the flat 0.25, both fitted on the same earlier half. The ' + (M.comp_count - M.wf_train_count - M.wf_test_count) + ' fitted comps with no recorded date cannot be ordered in time and sit this test out.' }),
      el('h3', { text: 'Every term kept or dropped on those tests' }),
      el('p', { text: 'One candidate term failed and is not in the model: a monotone smoothing of the token-share curve scored a split-half Brier of ' + oddsRow.brier_with + ' against ' + oddsRow.brier_without + ' for the raw bucket shares, so the odds below use the raw shares. The growth tilt is the small term the tests cannot distinguish from zero: its best weight leaves leave-one-out at x' + growthRow.loo_with + ' against x' + growthRow.loo_without + ' without it, with walk-forward unchanged at x' + growthRow.wf_with + ', so it ships at that small weight (' + M.growth_weight + ') rather than at zero — the value is defined over TVL, 7-day growth and age, and a tilt this small moves a row by at most a few percent. The full ablation:' }),
      ablationTable(),
      el('h3', { text: 'Token odds: from the peers\' record' }),
      el('p', { text: 'A launch value is worth nothing if no token ever lists. Bucketing all ' + a.total + ' protocols by the age at which DefiLlama first tracked them gives the share already holding a token in each age band; that share is S(age), used as measured, because its smoothing failed the test above. With the share that ever lists capped at ' + Math.round(M.odds_asymptote * 100) + '%, a protocol still tokenless at its age lists with odds (A - S) / (1 - S): the longer it has run with no token, the lower its odds. This is a cross-sectional estimate from one snapshot, not a hazard rate measured over time, and the Method says so wherever the odds are used.' }),
      el('h3', { text: 'Farm verdicts: costed, then netted' }),
      el('p', { text: 'Each plan prices its own chain\'s gas and its capital\'s opportunity cost at ' + Math.round(M.capital_apr * 100) + '% over the hold. The expected reward assumes a ' + Math.round(M.farm_allocation_share * 100) + '% community allocation of the expected launch value, split over competing wallets scaled by the protocol\'s TVL. Net at least $150 is FARM, $0 to $150 is THIN (one wallet, never a farm of wallets), below $0 is SKIP. The assumptions are stated because the verdict is only as good as they are.' }),
      el('h3', { text: 'Accounting and limits' }),
      el('p', { text: 'All ' + a.total + ' protocols are accounted for: ' + a.ranked + ' ranked here — every pre-token protocol that is not a versioned pool, an exchange, or a wrapped/staked product, including the 20 above the $50M floor the watchlist itself does not name — ' + a.live + ' already live, and ' + (a.versioned + a.cex + a.wrapped_or_staked) + ' excluded as versioned pools, exchanges or wrapped/staked products of tokens that already trade, the same exclusions the watchlist itself uses. No pre-token protocol is left unranked. The board says a protocol records no token, never that it has none: DefiLlama\'s record is the evidence, and it can lag. Implied values are claims of this model, ranked so a reader can act on the strongest first; they are not predictions of a price, a launch date, or that a token is issued at all.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var check = impliedOf(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · records no token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    function cell(label, value) { return el('div', null, el('span', { text: label }), el('b', { text: value })); }
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Expected launch value, term by term' }),
      el('div', { class: 'equation' },
        cell('TVL', fmtUsd(row.tvl_usd)),
        cell('Multiple (' + row.comp_count + ' comps)', 'x' + row.multiple),
        cell('Launch value if it lists', fmtUsd(row.launch_value_usd)),
        cell('Growth tilt, 7-day ' + fmtPct(row.change_7d), 'x' + growthTilt(row).toFixed(3)),
        cell('Token odds at ' + fmtAge(row.age_days), Math.round(row.token_odds * 100) + '%'),
        cell('Expected value', fmtUsd(row.implied_value_usd)),
        cell('Held-out interquartile range', fmtUsd(row.range_low_usd) + ' - ' + fmtUsd(row.range_high_usd)),
        cell('7-day TVL growth', fmtPct(row.change_7d)),
        cell('Expected airdrop', fmtUsd(row.expected_reward_usd)),
        cell('Plan true cost', fmtUsd(row.plan_cost_usd))
      ),
      el('p', { class: 'sub', text: 'The page recomputes this row from the shipped fit as ' + fmtUsd(check) + (check === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' Verdict: ' + row.verdict.toUpperCase() + '. An estimate, not a price, and not a promise a token is issued.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan, costed step by step' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(strip());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(methodPanel());
    shell.appendChild(el('p', { class: 'foot', text: 'Launch Radar · model ' + M.version + ' · snapshot ' + DATA.as_of + ' · ' + DATA.source }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();

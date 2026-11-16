// Token Radar dashboard, model radar-2.
//
// Reads window.RADAR (written beside this page by main.ts as data.js) and
// renders the ranked board, a filterable table, a per-protocol detail view
// with the model's own inputs and the protocol's farm plan, a chain
// breakdown, the week's biggest movers, and a CSV export of whatever the
// board is showing. No network: every byte it shows is in data.js, and the
// page makes no request of its own.

(() => {
  'use strict';

  const R = window.RADAR;
  if (!R) return;

  const root = document.getElementById('board');
  const onWatchlist = new Set(R.watchlist || []);
  const state = {
    q: '', category: 'all', chain: 'all', watchOnly: false,
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null,
  };

  // ---------- small formatting helpers ----------

  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function money(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
    const a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return moneyFmt.format(n);
  }

  function pct(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function chainList(row, n) {
    const chains = row.chains || [];
    if (!chains.length) return 'an unnamed chain';
    return esc(chains.slice(0, n || 2).join(', '));
  }

  // ---------- the model, recomputed on the page ----------

  // The page scores a row from the snapshot figures and checks the number
  // board.json carries, so the page's code and the board's data are visibly
  // the same arithmetic. Same factors, same order, same rounding.
  function impliedOf(row, model) {
    const raw = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    const growth = Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    const maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const extra = Math.max(0, Math.min((row.chains || []).length - 1, model.breadth_max_chains));
    const breadth = 1 + extra * model.breadth_per_chain;
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * breadth));
  }

  // ---------- the farm plan, derived on the page ----------

  // The plan is the same derivation main.ts writes to board.json: a rule
  // table over the protocol's category, chains, TVL and age. No name is
  // special-cased, and the first rule whose words appear in the category
  // wins. The wording is the plan's, so the drawer and the board agree.
  const FIRST_ACTIONS = [
    { words: ['lend', 'cdp', 'collateral'], line: (name, c, ch) => `Supply $${c} of USDC to ${name} on ${ch} and keep the position open.` },
    { words: ['dex', 'yield', 'leveraged farm'], line: (name, c, ch) => `Provide $${c} of liquidity to ${name}'s main pool on ${ch} and keep the position open.` },
    { words: ['bridge'], line: (name, c, ch) => `Bridge $${c} of USDC to ${ch} through ${name} and use the bridged funds in its app.` },
    { words: ['staking', 'restak'], line: (name, c) => `Stake $${c} of the chain's staking asset through ${name} and keep the receipt.` },
    { words: ['perpetual', 'derivative'], line: (name, c) => `Deposit $${c} of USDC as margin on ${name} and open one small hedge.` },
    { words: ['prediction'], line: (name, c) => `Fund $${c} and place one market position on ${name}.` },
    { words: ['curator', 'allocator'], line: (name, c, ch) => `Deposit $${c} into a ${name} vault on ${ch} and keep the shares.` },
    { words: ['stable'], line: (name, c, ch) => `Mint or deposit $${c} of the stable asset through ${name} on ${ch}.` },
    { words: ['rwa'], line: (name, c, ch) => `Mint $${c} of the protocol's yield asset on ${ch} and hold it.` },
    { words: ['insurance'], line: (name, c, ch) => `Buy $${c} of cover from ${name} on ${ch} and keep the policy.` },
  ];

  const SECOND_ACTIONS = [
    { words: ['dex', 'yield'], line: (name, c, ch, small) => `Swap $${small} between two assets in ${name}'s pool on ${ch} so the wallet shows trading as well as liquidity.` },
    { words: ['lend', 'cdp'], line: (name, c, ch, small) => `Borrow $${small} against the deposit on ${name} and repay it the same week, so the wallet shows borrowing as well as supplying.` },
    { words: ['perpetual', 'derivative'], line: (name) => `Close the hedge on ${name} and open a fresh one the next week, so the wallet shows repeated use.` },
    { words: ['prediction'], line: (name) => `Settle the first position on ${name} and place a second one on a different market.` },
    { words: ['bridge'], line: (name) => `Bridge a smaller amount back through ${name} so the wallet shows both directions.` },
  ];

  function pickAction(rules, category, name, capital, chain, small) {
    const c = (category || '').toLowerCase();
    for (const rule of rules) {
      if (rule.words.some((w) => c.includes(w))) return rule.line(name, capital, chain, small);
    }
    return null;
  }

  function stakeFor(row) {
    if (row.tvl_usd >= 5e9) return 250;
    if (row.tvl_usd >= 1e9) return 150;
    if (row.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  function farmSteps(row) {
    const chain = (row.chains && row.chains[0]) || 'its main chain';
    const capital = stakeFor(row);
    const hold = holdFor(row.age_days);
    const small = Math.max(10, Math.round(capital / 5));
    const first = pickAction(FIRST_ACTIONS, row.category, row.name, capital, chain, small)
      || `Deposit $${capital} of USDC into ${row.name} on ${chain} and keep the position open.`;
    let second = pickAction(SECOND_ACTIONS, row.category, row.name, capital, chain, small);
    if (!second && row.chains && row.chains.length > 1) {
      second = `Repeat the same position on ${row.name} on ${row.chains[1]} so the wallet shows more than one chain.`;
    }
    if (!second) second = `Use a second feature of ${row.name} on ${chain}, such as its rewards page or a vote, so the wallet shows more than one action.`;
    const raw = [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: first, cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
      { text: second, cost: `about $${small} of capital and $2 of gas`, time: '10 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
      { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
    ];
    return raw.map((step) => {
      let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
      if (s.length > 600) s = s.slice(0, 596) + '...';
      if (s.length < 20) s += ' Hold the position and check the protocol\'s own page.';
      return s;
    });
  }

  // ---------- state in the address bar ----------

  function readHash() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watch') === '1') state.watchOnly = true;
  }

  function writeHash() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchOnly) params.set('watch', '1');
    if (state.selected) params.set('p', state.selected);
    const next = params.toString();
    const url = next ? '#' + next : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }

  // ---------- filtering, sorting, export ----------

  function visibleRows() {
    const q = state.q.trim().toLowerCase();
    return R.rows.filter((r) => {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.watchOnly && !onWatchlist.has(r.slug)) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function sortRows(list) {
    const key = state.sort;
    return list.slice().sort((a, b) => {
      let av; let bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    const list = sortRows(visibleRows());
    const head = ['rank', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'age_days', 'implied_value_usd'];
    const lines = [head.join(',')];
    for (const r of list) {
      lines.push([
        r.rank, csvCell(r.name), csvCell(r.category || ''), csvCell((r.chains || []).join('; ')),
        r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.implied_value_usd,
      ].join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'token-radar-board.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- derived panels ----------

  function chainBreakdown() {
    const totals = {};
    for (const r of R.rows) {
      for (const chain of r.chains || []) {
        if (!totals[chain]) totals[chain] = { count: 0, value: 0 };
        totals[chain].count += 1;
        totals[chain].value += r.implied_value_usd;
      }
    }
    const top = Object.keys(totals)
      .map((chain) => ({ chain, count: totals[chain].count, value: totals[chain].value }))
      .sort((a, b) => b.count - a.count || b.value - a.value)
      .slice(0, 6);
    if (!top.length) return '';
    const max = top[0].count;
    const rows = top.map((t) => `
      <div class="chainrow">
        <span class="chainname">${esc(t.chain)}</span>
        <span class="chainbar" aria-hidden="true"><i style="width:${Math.max(4, Math.round((t.count / max) * 100))}%"></i></span>
        <span class="chainnum">${t.count} rows · ${money(t.value)}</span>
      </div>`).join('');
    return `
      <section class="panel chains">
        <h2>Where the board lives</h2>
        <p class="sub">Chains by how many ranked protocols run on them, and the implied value those rows carry together.</p>
        ${rows}
      </section>`;
  }

  function movers() {
    const top = R.rows
      .filter((r) => r.change_7d !== null && r.change_7d !== undefined)
      .slice()
      .sort((a, b) => b.change_7d - a.change_7d)
      .slice(0, 5);
    if (!top.length) return '';
    const cards = top.map((r) => `
      <button class="mover" type="button" data-open="${esc(r.slug)}">
        <b>${esc(r.name)}</b>
        <span class="moverpct pos">${pct(r.change_7d)} in 7d</span>
        <span class="sub">Implied ${money(r.implied_value_usd)}</span>
      </button>`).join('');
    return `
      <section class="movers">
        <h2>Fastest growers this week</h2>
        <div class="moverrow">${cards}</div>
      </section>`;
  }

  // ---------- page sections ----------

  function masthead() {
    return `
      <header class="mast">
        <div class="brand"><span class="mark"></span><span class="brandname">Token Radar</span></div>
        <div class="mastmeta">
          <span>Snapshot ${esc(R.as_of)}</span>
          <span>DefiLlama protocol index</span>
          <span>${esc(R.model_version)} model</span>
        </div>
      </header>`;
  }

  function hero() {
    const top = R.rows.slice(0, 3);
    const cards = top.map((r) => `
      <button class="spotcard" type="button" data-open="${esc(r.slug)}">
        <span class="rank">RANK ${r.rank}</span>
        <b>${esc(r.name)}</b>
        <span class="sub">${esc(r.category || 'Other')} · TVL ${money(r.tvl_usd)} · 7d ${pct(r.change_7d)}</span>
        <span class="spotnum">${money(r.implied_value_usd)}</span>
      </button>`).join('');
    return `
      <section class="hero">
        <h1>${R.watchlist_size} watchlist protocols, ranked by implied value</h1>
        <p>The watchlist is the floor: every protocol with at least $${Math.round(R.floor_usd / 1e6)}M of TVL and no token on record. The early radar adds every launchable protocol below that floor — ${R.early_size} of them — and leaves out wrapped, staked and bridged products whose token already trades. Implied value is a model, not a promise.</p>
        <div class="spot">${cards}</div>
        <div class="stats">
          <div class="stat"><b>${R.watchlist_size} / ${R.watchlist_size}</b><span>Watchlist covered</span></div>
          <div class="stat"><b>${R.board_size}</b><span>Pre-token rows scored</span></div>
          <div class="stat"><b>${R.early_size}</b><span>Early rows below the floor</span></div>
          <div class="stat"><b>${R.live_size}</b><span>Live-token protocols set aside</span></div>
        </div>
      </section>`;
  }

  function toolbar() {
    const categories = [...new Set(R.rows.map((r) => r.category || 'Other'))].sort();
    const chains = [...new Set(R.rows.flatMap((r) => r.chains || []))].sort();
    const catOpts = ['<option value="all">All categories</option>'].concat(
      categories.map((c) => `<option value="${esc(c)}"${c === state.category ? ' selected' : ''}>${esc(c)}</option>`),
    ).join('');
    const chainOpts = ['<option value="all">All chains</option>'].concat(
      chains.map((c) => `<option value="${esc(c)}"${c === state.chain ? ' selected' : ''}>${esc(c)}</option>`),
    ).join('');
    const shown = state.tab === 'pre-token' ? visibleRows().length + ' rows shown' : R.live.length + ' live-token protocols';
    return `
      <div class="toolbar">
        <div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="Search name, category or chain" value="${esc(state.q)}" aria-label="Search the board"></div>
        <div class="field"><label for="category">Category</label><select id="category" aria-label="Filter by category">${catOpts}</select></div>
        <div class="field"><label for="chain">Chain</label><select id="chain" aria-label="Filter by chain">${chainOpts}</select></div>
        <label class="check" for="watch"><input type="checkbox" id="watch"${state.watchOnly ? ' checked' : ''}> Watchlist only</label>
        <div class="field"><span class="sub">Token status</span>
          <div class="tabs">
            <button type="button" data-tab="pre-token" aria-pressed="${state.tab === 'pre-token'}">Pre-token</button>
            <button type="button" data-tab="live" aria-pressed="${state.tab === 'live'}">Live token</button>
          </div>
        </div>
        <button class="csvbtn" type="button" id="csv">Export CSV</button>
        <span class="count">${shown}</span>
      </div>`;
  }

  function sortHead(key, label) {
    const arrow = state.sort === key ? `<span aria-hidden="true">${state.dir < 0 ? ' v' : ' ^'}</span>` : '';
    return `<th scope="col"><button type="button" data-sort="${key}">${label}${arrow}</button></th>`;
  }

  function boardTable() {
    const list = sortRows(visibleRows());
    if (!list.length) {
      return `
        <div class="panel"><div class="empty">
          <h2>No protocol matches that filter</h2>
          <p>Clear the search or pick another category to see the board again.</p>
          <button class="btn primary" type="button" id="clear">Clear filters</button>
        </div></div>`;
    }
    const max = Math.max(...list.map((r) => r.implied_value_usd), 1);
    const rows = list.map((r) => {
      const growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      const growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const width = Math.max(3, Math.round((r.implied_value_usd / max) * 100));
      return `
        <tr data-open="${esc(r.slug)}" data-selected="${state.selected === r.slug}" tabindex="0">
          <td class="num">${r.rank}</td>
          <td><div class="pname"><b>${esc(r.name)}</b><span class="sub">${esc(r.category || 'Other')} on ${chainList(r)}${onWatchlist.has(r.slug) ? ' · watchlist' : ''}</span></div></td>
          <td class="num">${money(r.tvl_usd)}</td>
          <td class="num ${growthClass}">${growth}</td>
          <td class="num">${ageLabel(r.age_days)}</td>
          <td><div class="implied"><div class="bar" aria-hidden="true"><i style="width:${width}%"></i></div><span class="num">${money(r.implied_value_usd)}</span></div></td>
          <td><span class="status">no token</span></td>
        </tr>`;
    }).join('');
    return `
      <div class="panel"><div class="tablewrap"><table>
        <caption class="sub">Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.</caption>
        <thead><tr>
          ${sortHead('implied', 'Rank')}${sortHead('name', 'Protocol')}${sortHead('tvl', 'TVL')}
          ${sortHead('growth', '7d')}${sortHead('age', 'Age')}${sortHead('implied', 'Implied value')}
          <th scope="col">Token</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>`;
  }

  function liveTable() {
    const rows = R.live.map((r) => `
      <tr>
        <td class="num">live</td>
        <td><div class="pname"><b>${esc(r.name)}</b><span class="sub">${esc(r.category || 'Other')} on ${chainList(r)}</span></div></td>
        <td class="num">${money(r.tvl_usd)}</td>
        <td class="num ${r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'}">${pct(r.change_7d)}</td>
        <td class="num">${money(r.mcap_usd)}</td>
        <td><span class="status">already trades</span></td>
      </tr>`).join('');
    return `
      <div class="panel"><div class="tablewrap"><table>
        <caption class="sub">Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.</caption>
        <thead><tr><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col">TVL</th><th scope="col">7d</th><th scope="col">Market cap</th><th scope="col">Token</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>`;
  }

  function modelPanel() {
    const m = R.model;
    return `
      <section class="panel modelbox">
        <h2>How implied value is computed</h2>
        <p class="sub">Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.</p>
        <div class="formula">implied = round( tvl_usd x ${m.base_multiple} x (1 + clamp(change_7d, ${m.growth_floor}, ${m.growth_cap}) / 100 x ${m.growth_weight}) x (${m.maturity_floor} + min(age_days, ${m.maturity_days}) / ${m.maturity_days} x ${m.maturity_range}) x (1 + 0.05 x min(chains - 1, 4)) )</div>
        <p class="sub">TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ${m.unknown_age_days} days. Breadth counts the chains the protocol runs on, up to four extra. The early radar is every launchable protocol below the watchlist floor, and the live-token protocols are set aside with their market caps shown.</p>
      </section>`;
  }

  // ---------- detail view ----------

  const dialog = document.createElement('dialog');
  dialog.className = 'drawer';
  dialog.id = 'detail';
  dialog.setAttribute('aria-labelledby', 'detail-title');
  dialog.addEventListener('close', () => { state.selected = null; writeHash(); });

  function openDetail(slug) {
    const row = R.rows.find((r) => r.slug === slug);
    if (!row) return;
    state.selected = slug;
    writeHash();
    const recomputed = impliedOf(row, R.model);
    const agrees = recomputed === row.implied_value_usd;
    const steps = farmSteps(row);
    const stepItems = steps.map((s) => {
      const at = s.indexOf(' Cost: ');
      const action = at >= 0 ? s.slice(0, at) : s;
      const tail = at >= 0 ? s.slice(at + 1) : '';
      return `<li><b>${esc(action)}</b><span class="cost">${esc(tail)}</span></li>`;
    }).join('');
    const eq = (label, value) => `<div><span>${label}</span><b class="num">${value}</b></div>`;
    dialog.innerHTML = `
      <div class="drawerhead">
        <div>
          <span class="brandname">Rank ${row.rank} of ${R.board_size}</span>
          <h2 id="detail-title">${esc(row.name)}</h2>
          <p class="sub">${esc(row.category || 'Other')} on ${esc((row.chains || []).join(', ') || 'an unnamed chain')}${onWatchlist.has(row.slug) ? ' · on the watchlist' : ' · early radar'}</p>
        </div>
        <button class="closebtn" type="button" aria-label="Close details">Close</button>
      </div>
      <section class="drawersection">
        <h3>Implied value</h3>
        <div class="equation">
          ${eq('TVL', money(row.tvl_usd))}
          ${eq('Seven-day growth', pct(row.change_7d))}
          ${eq('Age with no token', ageLabel(row.age_days))}
          ${eq('Chains', String((row.chains || []).length))}
          ${eq('Growth multiplier', String(row.growth_multiplier))}
          ${eq('Maturity multiplier', String(row.maturity_multiplier))}
          ${eq('Breadth multiplier', String(row.breadth_multiplier))}
          ${eq('Implied value', money(row.implied_value_usd))}
        </div>
        <p class="sub">Model ${esc(R.model_version)}: the same function scores every protocol. The page recomputes this row as ${money(recomputed)}${agrees ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.'} This is an estimate, not a price, and "no token" means the snapshot records none.</p>
      </section>
      <section class="drawersection">
        <h3>Farm plan</h3>
        <ol class="steps">${stepItems}</ol>
      </section>
      <p class="note">Airdrops are never guaranteed. Never pay to claim, never share a seed phrase, and never farm with money you cannot afford to lose.</p>`;
    dialog.querySelector('.closebtn').addEventListener('click', () => dialog.close());
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  // ---------- render and wiring ----------

  function render() {
    root.innerHTML = `
      <div class="page">
        ${masthead()}
        ${hero()}
        ${movers()}
        ${toolbar()}
        ${state.tab === 'pre-token' ? boardTable() : liveTable()}
        ${state.tab === 'pre-token' ? chainBreakdown() + modelPanel() : ''}
      </div>`;
    root.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) root.appendChild(dialog);
    wire();
    if (state.selected) openDetail(state.selected);
  }

  function wire() {
    const q = root.querySelector('#q');
    if (q) q.addEventListener('input', () => { state.q = q.value; writeHash(); render(); });
    const cat = root.querySelector('#category');
    if (cat) cat.addEventListener('change', () => { state.category = cat.value; writeHash(); render(); });
    const ch = root.querySelector('#chain');
    if (ch) ch.addEventListener('change', () => { state.chain = ch.value; writeHash(); render(); });
    const watch = root.querySelector('#watch');
    if (watch) watch.addEventListener('change', () => { state.watchOnly = watch.checked; writeHash(); render(); });
    const csv = root.querySelector('#csv');
    if (csv) csv.addEventListener('click', exportCsv);
    const clear = root.querySelector('#clear');
    if (clear) clear.addEventListener('click', () => {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchOnly = false; writeHash(); render();
    });
    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => { state.tab = btn.getAttribute('data-tab'); render(); });
    });
    root.querySelectorAll('[data-sort]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        render();
      });
    });
    root.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => openDetail(el.getAttribute('data-open')));
      if (el.tagName === 'TR') {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(el.getAttribute('data-open')); }
        });
      }
    });
  }

  readHash();
  render();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();

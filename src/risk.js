'use strict';
// Risk score 0-100 (higher = worse), with the reason behind every point. It is an estimate, not a verdict.

exports.score = function (snap, chain) {
  let s = 0;
  const why = [];
  function add(points, text) { s += points; why.push({ points: points, text: text }); }

  const liq = snap.liquidity;
  if (liq < 10000) add(30, 'Very low liquidity ($' + Math.round(liq).toLocaleString('en-US') + '): exiting a position moves the price');
  else if (liq < 50000) add(18, 'Low liquidity ($' + Math.round(liq).toLocaleString('en-US') + ')');
  else if (liq < 250000) add(8, 'Moderate liquidity ($' + Math.round(liq).toLocaleString('en-US') + ')');

  const ageH = snap.createdAt ? (Date.now() - snap.createdAt) / 3600000 : null;
  if (ageH !== null && ageH < 24) add(15, 'Pair created less than 24h ago');
  else if (ageH !== null && ageH < 24 * 7) add(7, 'Pair created less than 7 days ago');

  if (snap.marketCap > 0 && liq / snap.marketCap < 0.03) add(10, 'Liquidity is below 3% of market cap');
  if (Math.abs(snap.change.h24) > 100) add(10, '24h move above 100%');
  if (snap.volume.h24 > 0 && liq > 0 && snap.volume.h24 / liq > 20) add(6, '24h volume above 20x liquidity (abnormal activity)');

  if (chain && chain.ok) {
    if (chain.mintAuthority) add(20, 'Mint authority is active: the creator can mint more tokens');
    if (chain.freezeAuthority) add(10, 'Freeze authority is active: accounts can be frozen');
    if (chain.top10Pct !== null) {
      if (chain.top10Pct > 60) add(15, 'Top 10 accounts hold ' + chain.top10Pct.toFixed(0) + '% (includes liquidity pools)');
      else if (chain.top10Pct > 35) add(8, 'Top 10 accounts hold ' + chain.top10Pct.toFixed(0) + '%');
    }
  }
  s = Math.min(100, s);
  return { score: s, label: s >= 60 ? 'high' : s >= 30 ? 'moderate' : 'low', reasons: why };
};

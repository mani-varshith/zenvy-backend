const express = require('express');
const { getById, getAll, db } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const safeUser = (u) => { if (!u) return null; const { password, ...rest } = u; return rest; };

// GET /api/stats/gamification — leaderboard + badges for current user's groups
router.get('/gamification', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

  // Get all groups user is in
  const memberships = await getAll('groupMembers', 'user_id', userId);
  const groupIds = memberships.map(m => m.group_id);

  if (groupIds.length === 0) {
    return res.json({ leaderboard: [], badges: [], monthlyStats: null, myRank: null });
  }

  // Collect all expenses across user's groups
  const allSnap = await db.collection('expenses').get();
  const allExpenses = allSnap.docs.map(d => d.data());
  const groupExpenses = allExpenses.filter(e => groupIds.includes(e.group_id));

  // Collect all members across user's groups
  const allMemberIds = new Set();
  for (const gid of groupIds) {
    const mems = await getAll('groupMembers', 'group_id', gid);
    mems.forEach(m => allMemberIds.add(m.user_id));
  }

  // ── Monthly Top Spender ──
  const thisMonthExpenses = groupExpenses.filter(e => e.date >= startOfMonth.split('T')[0] || (e.created_at && e.created_at >= startOfMonth));
  const spendMap = {};
  for (const e of thisMonthExpenses) {
    if (!e.paid_by) continue;
    spendMap[e.paid_by] = (spendMap[e.paid_by] || 0) + (e.amount || 0);
  }

  // ── All-time leaderboard ──
  const allTimeMap = {};
  for (const e of groupExpenses) {
    if (!e.paid_by) continue;
    allTimeMap[e.paid_by] = (allTimeMap[e.paid_by] || 0) + (e.amount || 0);
  }

  // ── Fastest payer (settlements in last 30 days) ──
  const settSnap = await db.collection('settlements').get();
  const allSettlements = settSnap.docs.map(d => d.data());
  const thirtyDaysAgo = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  const recentSettlements = allSettlements.filter(s =>
    (s.from_user === userId || groupIds.includes(s.group_id)) && s.created_at >= thirtyDaysAgo
  );
  const payerMap = {};
  for (const s of recentSettlements) {
    payerMap[s.from_user] = (payerMap[s.from_user] || 0) + 1;
  }

  // ── Build enriched leaderboard ──
  const leaderboardRaw = Object.entries(allTimeMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const leaderboard = await Promise.all(leaderboardRaw.map(async ([uid, total], idx) => {
    const user = await getById('users', uid);
    const monthlySpend = spendMap[uid] || 0;
    const settlements = payerMap[uid] || 0;
    return {
      rank: idx + 1,
      user: safeUser(user),
      totalPaid: Math.round(total * 100) / 100,
      monthlyPaid: Math.round(monthlySpend * 100) / 100,
      settlementsCount: settlements,
      isMe: uid === userId,
    };
  }));

  // ── My position in leaderboard ──
  const myRankData = leaderboard.find(e => e.isMe);
  const myRank = myRankData?.rank || leaderboard.length + 1;

  // ── Monthly stats ──
  const myMonthlySpend = spendMap[userId] || 0;
  const lastMonthExpenses = groupExpenses.filter(e => {
    const d = e.date || (e.created_at || '').split('T')[0];
    return d >= startOfLastMonth.split('T')[0] && d < startOfMonth.split('T')[0];
  });
  const lastMonthSpend = lastMonthExpenses
    .filter(e => e.paid_by === userId)
    .reduce((s, e) => s + (e.amount || 0), 0);

  // ── Badges ──
  const badges = [];
  const myAllTime = allTimeMap[userId] || 0;
  const myMonthRank = Object.entries(spendMap).sort((a, b) => b[1] - a[1]).findIndex(([uid]) => uid === userId);

  if (myMonthRank === 0 && myMonthlySpend > 0) badges.push({ id: 'top_spender', title: 'Top Spender', subtitle: 'Highest payer this month', icon: '🏆', color: 'amber' });
  if ((payerMap[userId] || 0) >= 3) badges.push({ id: 'fastest_payer', title: 'Fastest Payer', subtitle: 'Settled 3+ times this month', icon: '⚡', color: 'blue' });
  if (myAllTime >= 10000) badges.push({ id: 'big_spender', title: 'Big Spender', subtitle: 'Paid over ₹10,000 total', icon: '💎', color: 'purple' });
  if (myAllTime >= 1000) badges.push({ id: 'contributor', title: 'Contributor', subtitle: 'Paid over ₹1,000 total', icon: '⭐', color: 'yellow' });
  if (groupIds.length >= 3) badges.push({ id: 'explorer', title: 'Explorer', subtitle: 'Member of 3+ trips', icon: '✈️', color: 'green' });
  if ((payerMap[userId] || 0) >= 1) badges.push({ id: 'honest_payer', title: 'Honest Payer', subtitle: 'Made a settlement this month', icon: '🤝', color: 'teal' });

  const monthlySpendTrend = myMonthlySpend > 0 && lastMonthSpend > 0
    ? ((myMonthlySpend - lastMonthSpend) / lastMonthSpend * 100).toFixed(0)
    : null;

  res.json({
    leaderboard,
    badges,
    myRank,
    monthlyStats: {
      mySpend: Math.round(myMonthlySpend * 100) / 100,
      lastMonthSpend: Math.round(lastMonthSpend * 100) / 100,
      trend: monthlySpendTrend,
      totalGroupExpenses: Math.round(thisMonthExpenses.reduce((s, e) => s + (e.amount || 0), 0) * 100) / 100,
    },
  });
});

module.exports = router;

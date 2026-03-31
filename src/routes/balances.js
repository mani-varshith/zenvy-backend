const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getById, getAll, setDoc, updateDoc } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const safeUser = (u) => { if (!u) return null; const { password, ...rest } = u; return rest; };

const calculateBalances = async (userId) => {
  const owedToMe = {};
  const iOwe = {};

  // Expenses I paid — others owe me
  const expensesIPaid = await getAll('expenses', 'paid_by', userId);
  for (const e of expensesIPaid) {
    const splits = await getAll('expenseSplits', 'expense_id', e.id);
    for (const s of splits) {
      if (s.user_id !== userId && !s.is_paid) {
        owedToMe[s.user_id] = (owedToMe[s.user_id] || 0) + s.amount;
      }
    }
  }

  // My splits — I owe someone else
  const mySplits = await getAll('expenseSplits', 'user_id', userId);
  for (const s of mySplits) {
    if (s.is_paid) continue;
    const e = await getById('expenses', s.expense_id);
    if (e && e.paid_by !== userId) {
      iOwe[e.paid_by] = (iOwe[e.paid_by] || 0) + s.amount;
    }
  }

  // Apply confirmed settlements only
  const settlementsISent = await getAll('settlements', 'from_user', userId);
  for (const s of settlementsISent) {
    if (s.status && s.status !== 'confirmed') continue;
    iOwe[s.to_user] = Math.max(0, (iOwe[s.to_user] || 0) - s.amount);
  }

  const settlementsIReceived = await getAll('settlements', 'to_user', userId);
  for (const s of settlementsIReceived) {
    if (s.status && s.status !== 'confirmed') continue;
    owedToMe[s.from_user] = Math.max(0, (owedToMe[s.from_user] || 0) - s.amount);
  }

  let totalOwedToMe = 0, totalIOwe = 0;
  const details = [];
  const allUserIds = new Set([...Object.keys(owedToMe), ...Object.keys(iOwe)]);

  for (const uid of allUserIds) {
    const owed = owedToMe[uid] || 0;
    const owe = iOwe[uid] || 0;
    const net = owed - owe;
    if (Math.abs(net) < 0.01) continue;
    const user = await getById('users', uid);
    if (!user) continue;
    if (net > 0) {
      totalOwedToMe += net;
      details.push({ user: safeUser(user), amount: Math.round(net * 100) / 100, type: 'owed_to_me' });
    } else {
      totalIOwe += Math.abs(net);
      details.push({ user: safeUser(user), amount: Math.round(Math.abs(net) * 100) / 100, type: 'i_owe' });
    }
  }

  return {
    totalOwedToMe: Math.round(totalOwedToMe * 100) / 100,
    totalIOwe: Math.round(totalIOwe * 100) / 100,
    netBalance: Math.round((totalOwedToMe - totalIOwe) * 100) / 100,
    details,
  };
};

router.get('/', authMiddleware, async (req, res) => {
  res.json(await calculateBalances(req.user.id));
});

router.get('/group/:groupId', authMiddleware, async (req, res) => {
  const { groupId } = req.params;
  const memberships = await getAll('groupMembers', 'group_id', groupId);
  const memberIds = memberships.map(m => m.user_id);

  const balanceMap = {};
  memberIds.forEach(uid => { balanceMap[uid] = {}; });

  const expenses = await getAll('expenses', 'group_id', groupId);
  for (const e of expenses) {
    const splits = await getAll('expenseSplits', 'expense_id', e.id);
    for (const s of splits) {
      if (s.user_id === e.paid_by || s.is_paid) continue;
      if (!balanceMap[e.paid_by]) continue;
      balanceMap[e.paid_by][s.user_id] = (balanceMap[e.paid_by][s.user_id] || 0) + s.amount;
    }
  }

  const settlements = await getAll('settlements', 'group_id', groupId);
  for (const s of settlements) {
    if (s.status && s.status !== 'confirmed') continue;
    if (balanceMap[s.from_user]) {
      balanceMap[s.from_user][s.to_user] = (balanceMap[s.from_user][s.to_user] || 0) - s.amount;
    }
  }

  const result = await Promise.all(memberIds.map(async (uid) => {
    const user = await getById('users', uid);
    let owes = 0, owed = 0;
    Object.entries(balanceMap[uid] || {}).forEach(([, v]) => {
      if (v > 0) owed += v;
      else owes += Math.abs(v);
    });
    Object.keys(balanceMap).forEach(oid => {
      const v = balanceMap[oid]?.[uid] || 0;
      if (v > 0) owes += v;
    });
    return {
      user: safeUser(user),
      owes: Math.round(owes * 100) / 100,
      owed: Math.round(owed * 100) / 100,
      net: Math.round((owed - owes) * 100) / 100,
    };
  }));

  res.json(result);
});

router.post('/settle', authMiddleware, async (req, res) => {
  const { toUserId, amount, method, groupId, note } = req.body;
  if (!toUserId || !amount) return res.status(400).json({ error: 'toUserId and amount required' });

  const id = uuidv4();
  const now = new Date().toISOString();

  await setDoc('settlements', {
    id, from_user: req.user.id, to_user: toUserId,
    amount: parseFloat(amount), method: method || 'cash',
    group_id: groupId || null, note: note || null,
    status: 'pending',  // requires recipient confirmation
    created_at: now,
  });

  const fromUser = await getById('users', req.user.id);
  const amtFmt = `₹${parseFloat(amount).toFixed(2)}`;

  // Notify recipient to confirm
  await setDoc('notifications', {
    id: uuidv4(), user_id: toUserId, type: 'payment_pending',
    title: '💰 Payment Confirmation Needed',
    message: `${fromUser?.name || 'Someone'} says they paid you ${amtFmt}. Did you receive it?`,
    is_read: 0, settlement_id: id, group_id: groupId || null,
    data: JSON.stringify({ settlementId: id, groupId }),
    created_at: now,
  });

  await setDoc('activityFeed', {
    id: uuidv4(), user_id: req.user.id, group_id: groupId || null,
    type: 'settlement', description: `Sent ${amtFmt} to ${fromUser?.name || ''}`,
    amount: parseFloat(amount), created_at: now,
  });

  res.status(201).json({ id, status: 'pending', message: 'Settlement pending confirmation' });
});

// PUT /api/balances/settlements/:id/confirm
router.put('/settlements/:id/confirm', authMiddleware, async (req, res) => {
  const settlement = await getById('settlements', req.params.id);
  if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
  if (settlement.to_user !== req.user.id) return res.status(403).json({ error: 'Only the recipient can confirm' });

  await updateDoc('settlements', req.params.id, { status: 'confirmed' });

  const toUser = await getById('users', req.user.id);
  const fromUser = await getById('users', settlement.from_user);
  const amtFmt = `₹${settlement.amount.toFixed(2)}`;

  // Notify the payer that payment was confirmed
  await setDoc('notifications', {
    id: uuidv4(), user_id: settlement.from_user, type: 'payment_confirmed',
    title: '🎉 Payment Confirmed!',
    message: `${toUser?.name || 'Someone'} confirmed receiving your ${amtFmt} payment. You're all settled!`,
    is_read: 0, group_id: settlement.group_id || null,
    data: JSON.stringify({ settlementId: req.params.id }),
    created_at: new Date().toISOString(),
  });

  await setDoc('activityFeed', {
    id: uuidv4(), user_id: req.user.id, group_id: settlement.group_id || null,
    type: 'settlement_confirmed', description: `Confirmed ${amtFmt} from ${fromUser?.name || ''}`,
    amount: settlement.amount, created_at: new Date().toISOString(),
  });

  res.json({ message: 'Settlement confirmed' });
});

// PUT /api/balances/settlements/:id/reject
router.put('/settlements/:id/reject', authMiddleware, async (req, res) => {
  const settlement = await getById('settlements', req.params.id);
  if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
  if (settlement.to_user !== req.user.id) return res.status(403).json({ error: 'Only the recipient can reject' });

  await updateDoc('settlements', req.params.id, { status: 'rejected' });

  const toUser = await getById('users', req.user.id);
  const amtFmt = `₹${settlement.amount.toFixed(2)}`;

  await setDoc('notifications', {
    id: uuidv4(), user_id: settlement.from_user, type: 'payment_rejected',
    title: '❌ Payment Not Confirmed',
    message: `${toUser?.name || 'Someone'} didn't receive your ${amtFmt} payment. Please check and retry.`,
    is_read: 0, group_id: settlement.group_id || null,
    data: JSON.stringify({ settlementId: req.params.id }),
    created_at: new Date().toISOString(),
  });

  res.json({ message: 'Settlement rejected' });
});

router.get('/history', authMiddleware, async (req, res) => {
  const sent = await getAll('settlements', 'from_user', req.user.id);
  const received = await getAll('settlements', 'to_user', req.user.id);
  const all = [...sent, ...received].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const enriched = await Promise.all(all.slice(0, 50).map(async (s) => {
    const fromUser = await getById('users', s.from_user);
    const toUser = await getById('users', s.to_user);
    return {
      ...s,
      from_name: fromUser?.name, from_avatar: fromUser?.avatar,
      to_name: toUser?.name, to_avatar: toUser?.avatar,
    };
  }));

  res.json(enriched);
});

module.exports = router;

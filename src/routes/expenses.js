const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getById, getAll, getAllWhere2, setDoc, updateDoc, deleteDoc, deleteWhere } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const safeUser = (u) => { if (!u) return null; const { password, ...rest } = u; return rest; };

const getExpenseWithSplits = async (expenseId) => {
  const expense = await getById('expenses', expenseId);
  if (!expense) return null;
  const splits = await getAll('expenseSplits', 'expense_id', expenseId);
  const paidBy = await getById('users', expense.paid_by);
  const enrichedSplits = await Promise.all(splits.map(async (s) => {
    const user = await getById('users', s.user_id);
    return user ? { ...s, name: user.name, email: user.email, avatar: user.avatar } : s;
  }));
  return { ...expense, splits: enrichedSplits, paidBy: safeUser(paidBy) };
};

// GET /api/expenses
router.get('/', authMiddleware, async (req, res) => {
  const { groupId, category, search } = req.query;

  let allExpenses;
  if (groupId) {
    allExpenses = await getAll('expenses', 'group_id', groupId);
  } else {
    // Get all expenses (we'll filter by user involvement below)
    const { db } = require('../database/db');
    const snap = await db.collection('expenses').get();
    allExpenses = snap.docs.map(d => d.data());
  }

  if (category) allExpenses = allExpenses.filter(e => e.category === category);

  // Filter to expenses where user paid or is in splits
  const mySplits = await getAll('expenseSplits', 'user_id', req.user.id);
  const splitExpenseIds = new Set(mySplits.map(s => s.expense_id));

  const visible = allExpenses.filter(e =>
    e.paid_by === req.user.id || splitExpenseIds.has(e.id) || e.created_by === req.user.id
  );

  const filtered = search
    ? visible.filter(e => e.description?.toLowerCase().includes(search.toLowerCase()))
    : visible;

  const enriched = await Promise.all(
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 100).map(e => getExpenseWithSplits(e.id))
  );

  res.json(enriched.filter(Boolean));
});

// POST /api/expenses
router.post('/', authMiddleware, async (req, res) => {
  const {
    groupId, description, amount, currency, category, paidBy,
    splitType, splits, date, receiptImage, receipt,
    originalAmount, originalCurrency,
  } = req.body;

  if (!description || !amount || !paidBy)
    return res.status(400).json({ error: 'Description, amount and paidBy are required' });

  const id = uuidv4();
  const expenseDate = date || new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  await setDoc('expenses', {
    id, group_id: groupId || null, description,
    amount: parseFloat(amount), currency: currency || 'USD',
    category: category || 'general', paid_by: paidBy,
    split_type: splitType || 'equal',
    receipt_image: receiptImage || receipt || null,
    original_amount: originalAmount ? parseFloat(originalAmount) : null,
    original_currency: originalCurrency || null,
    date: expenseDate, created_by: req.user.id, created_at: now,
  });

  if (splits && splits.length > 0) {
    for (const s of splits) {
      await setDoc('expenseSplits', {
        id: uuidv4(), expense_id: id, user_id: s.userId,
        amount: parseFloat(s.amount), percentage: s.percentage || null,
        shares: s.shares || null,
        is_paid: s.is_paid ? 1 : 0,
      });
    }
  } else if (groupId) {
    const members = await getAll('groupMembers', 'group_id', groupId);
    const splitAmount = parseFloat(amount) / members.length;
    for (const m of members) {
      await setDoc('expenseSplits', {
        id: uuidv4(), expense_id: id, user_id: m.user_id,
        amount: Math.round(splitAmount * 100) / 100, is_paid: 0,
      });
    }
  } else {
    await setDoc('expenseSplits', {
      id: uuidv4(), expense_id: id, user_id: req.user.id,
      amount: parseFloat(amount), is_paid: 1,
    });
  }

  await setDoc('activityFeed', {
    id: uuidv4(), user_id: req.user.id, group_id: groupId || null,
    type: 'expense_added', description: `Added $${amount} for "${description}"`,
    amount: parseFloat(amount), created_at: now,
  });

  if (groupId) {
    const members = await getAll('groupMembers', 'group_id', groupId);
    const creator = await getById('users', req.user.id);
    for (const m of members) {
      if (m.user_id === req.user.id) continue;
      await setDoc('notifications', {
        id: uuidv4(), user_id: m.user_id, type: 'new_expense',
        title: 'New Expense Added',
        message: `${creator?.name || 'Someone'} added ${currency || ''}${amount} for "${description}"`,
        is_read: 0, group_id: groupId, expense_id: id,
        data: JSON.stringify({ expenseId: id, groupId }),
        created_at: now,
      });
    }
  }

  res.status(201).json(await getExpenseWithSplits(id));
});

// GET /api/expenses/:id
router.get('/:id', authMiddleware, async (req, res) => {
  const expense = await getExpenseWithSplits(req.params.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  res.json(expense);
});

// PUT /api/expenses/:id
router.put('/:id', authMiddleware, async (req, res) => {
  const expense = await getById('expenses', req.params.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (expense.created_by !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  const { description, amount, currency, category, date } = req.body;
  const update = {};
  if (description) update.description = description;
  if (amount) update.amount = parseFloat(amount);
  if (currency) update.currency = currency;
  if (category) update.category = category;
  if (date) update.date = date;

  await updateDoc('expenses', req.params.id, update);
  res.json(await getExpenseWithSplits(req.params.id));
});

// DELETE /api/expenses/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  const expense = await getById('expenses', req.params.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (expense.created_by !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  await deleteDoc('expenses', req.params.id);
  await deleteWhere('expenseSplits', 'expense_id', req.params.id);
  res.json({ message: 'Expense deleted' });
});

module.exports = router;

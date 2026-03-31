const express = require('express');
const { db, getById } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/search', authMiddleware, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);

  // Fetch all users and filter in-memory (supports regex and OR across fields)
  const snap = await db.collection('users').get();
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const users = snap.docs
    .map(d => d.data())
    .filter(u => u.id !== req.user.id && (re.test(u.name) || re.test(u.email)))
    .slice(0, 10)
    .map(({ password, ...u }) => u);

  res.json(users);
});

router.get('/:id', authMiddleware, async (req, res) => {
  const user = await getById('users', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safeUser } = user;
  res.json(safeUser);
});

module.exports = router;

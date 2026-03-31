const express = require('express');
const { db, getById, getAll, updateDoc, updateWhere } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  const notifications = await getAll('notifications', 'user_id', req.user.id);
  res.json(
    notifications
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 50)
  );
});

router.put('/read-all', authMiddleware, async (req, res) => {
  await updateWhere('notifications', 'user_id', req.user.id, { is_read: 1 });
  res.json({ message: 'All marked as read' });
});

router.put('/:id/read', authMiddleware, async (req, res) => {
  await updateDoc('notifications', req.params.id, { is_read: 1 });
  res.json({ message: 'Marked as read' });
});

router.get('/activity', authMiddleware, async (req, res) => {
  const { groupId } = req.query;

  let items;
  if (groupId) {
    // Get activity for a specific group (all members' activity in that group)
    items = await getAll('activityFeed', 'group_id', groupId);
  } else {
    items = await getAll('activityFeed', 'user_id', req.user.id);
  }

  const enriched = await Promise.all(
    items
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100)
      .map(async (item) => {
        const user = item.user_id ? await getById('users', item.user_id) : null;
        return { ...item, name: user?.name, avatar: user?.avatar };
      })
  );

  res.json(enriched);
});

module.exports = router;

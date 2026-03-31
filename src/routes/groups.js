const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getById, getOne, getOneWhere2, getAll, setDoc, updateDoc, deleteDoc, deleteWhere, deleteWhere2 } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const safeUser = (u) => { if (!u) return null; const { password, ...rest } = u; return rest; };

const getGroupWithMembers = async (groupId) => {
  const group = await getById('groups', groupId);
  if (!group) return null;
  const memberships = await getAll('groupMembers', 'group_id', groupId);
  const members = await Promise.all(
    memberships.map(async (m) => {
      const user = await getById('users', m.user_id);
      return user ? { ...safeUser(user), role: m.role, joined_at: m.joined_at } : null;
    })
  );
  return { ...group, members: members.filter(Boolean) };
};

// GET /api/groups — list groups the current user belongs to
router.get('/', authMiddleware, async (req, res) => {
  const memberships = await getAll('groupMembers', 'user_id', req.user.id);
  const groups = await Promise.all(
    memberships.map(async (m) => {
      const group = await getById('groups', m.group_id);
      if (!group) return null;
      const allMembers = await getAll('groupMembers', 'group_id', group.id);
      const memberUsers = await Promise.all(allMembers.map(async (am) => {
        const u = await getById('users', am.user_id);
        return u ? { ...safeUser(u), role: am.role } : null;
      }));
      const expenses = await getAll('expenses', 'group_id', group.id);
      const totalAmount = expenses.reduce((s, e) => s + (e.amount || 0), 0);
      return { ...group, members: memberUsers.filter(Boolean), expenseCount: expenses.length, totalAmount };
    })
  );
  res.json(groups.filter(Boolean).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

// POST /api/groups — create a new group
router.post('/', authMiddleware, async (req, res) => {
  const { name, icon, currency, memberIds, coverImage } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name is required' });

  const id = uuidv4();
  const now = new Date().toISOString();
  await setDoc('groups', {
    id, name, icon: icon || '✈️', currency: currency || 'USD',
    image: coverImage || null, created_by: req.user.id, created_at: now,
  });
  await setDoc('groupMembers', { id: uuidv4(), group_id: id, user_id: req.user.id, role: 'owner', joined_at: now });

  if (Array.isArray(memberIds)) {
    for (const uid of memberIds) {
      if (uid !== req.user.id) {
        const existing = await getOneWhere2('groupMembers', 'group_id', id, 'user_id', uid);
        if (!existing) {
          await setDoc('groupMembers', { id: uuidv4(), group_id: id, user_id: uid, role: 'member', joined_at: now });
        }
      }
    }
  }

  await setDoc('activityFeed', {
    id: uuidv4(), user_id: req.user.id, group_id: id,
    type: 'group_created', description: `Created group "${name}"`, created_at: now,
  });

  res.status(201).json(await getGroupWithMembers(id));
});

// GET /api/groups/:id
router.get('/:id', authMiddleware, async (req, res) => {
  const member = await getOneWhere2('groupMembers', 'group_id', req.params.id, 'user_id', req.user.id);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });
  const group = await getGroupWithMembers(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

// PUT /api/groups/:id
router.put('/:id', authMiddleware, async (req, res) => {
  const membership = await getOneWhere2('groupMembers', 'group_id', req.params.id, 'user_id', req.user.id);
  if (!membership || membership.role !== 'owner') return res.status(403).json({ error: 'Only owner can edit group' });

  const { name, icon, currency, coverImage, image } = req.body;
  const update = {};
  if (name) update.name = name;
  if (icon) update.icon = icon;
  if (currency) update.currency = currency;
  if (coverImage !== undefined) update.image = coverImage;
  else if (image !== undefined) update.image = image;

  await updateDoc('groups', req.params.id, update);
  res.json(await getGroupWithMembers(req.params.id));
});

// DELETE /api/groups/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  const membership = await getOneWhere2('groupMembers', 'group_id', req.params.id, 'user_id', req.user.id);
  if (!membership || membership.role !== 'owner') return res.status(403).json({ error: 'Only owner can delete group' });

  await deleteDoc('groups', req.params.id);
  await deleteWhere('groupMembers', 'group_id', req.params.id);
  res.json({ message: 'Group deleted' });
});

// POST /api/groups/:id/members — add a member
router.post('/:id/members', authMiddleware, async (req, res) => {
  const { userId } = req.body;
  const membership = await getOneWhere2('groupMembers', 'group_id', req.params.id, 'user_id', req.user.id);
  if (!membership) return res.status(403).json({ error: 'Not a member of this group' });

  const user = await getById('users', userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const existing = await getOneWhere2('groupMembers', 'group_id', req.params.id, 'user_id', userId);
  if (!existing) {
    await setDoc('groupMembers', {
      id: uuidv4(), group_id: req.params.id, user_id: userId,
      role: 'member', joined_at: new Date().toISOString(),
    });
    const adder = await getById('users', req.user.id);
    const group = await getById('groups', req.params.id);
    await setDoc('notifications', {
      id: uuidv4(), user_id: userId, type: 'member_added',
      title: 'Added to a Trip',
      message: `${adder?.name || 'Someone'} added you to "${group?.name || 'a trip'}"`,
      is_read: 0, group_id: req.params.id,
      created_at: new Date().toISOString(),
    });
  }
  res.json(await getGroupWithMembers(req.params.id));
});

// DELETE /api/groups/:id/members/:userId — remove a member
router.delete('/:id/members/:userId', authMiddleware, async (req, res) => {
  const membership = await getOneWhere2('groupMembers', 'group_id', req.params.id, 'user_id', req.user.id);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  if (req.params.userId !== req.user.id && membership.role !== 'owner')
    return res.status(403).json({ error: 'Not authorized' });

  await deleteWhere2('groupMembers', 'group_id', req.params.id, 'user_id', req.params.userId);
  res.json({ message: 'Member removed' });
});

module.exports = router;

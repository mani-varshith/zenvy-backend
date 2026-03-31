const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getById, getOne, getOneWhere2, getAll, setDoc, updateDoc, updateWhere, deleteWhere } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const INVITE_TTL_HOURS = 72;

const safeUser = (u) => { if (!u) return null; const { password, ...rest } = u; return rest; };

const getGroupWithMembers = async (groupId) => {
  const group = await getById('groups', groupId);
  if (!group) return null;
  const memberships = await getAll('groupMembers', 'group_id', groupId);
  const members = await Promise.all(
    memberships.map(async (m) => {
      const user = await getById('users', m.user_id);
      return user ? { ...safeUser(user), role: m.role } : null;
    })
  );
  return { ...group, members: members.filter(Boolean) };
};

// POST /api/invites/generate
router.post('/generate', authMiddleware, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  const membership = await getOneWhere2('groupMembers', 'group_id', groupId, 'user_id', req.user.id);
  if (!membership) return res.status(403).json({ error: 'Not a member of this group' });

  const group = await getById('groups', groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  // Reuse non-expired active invite
  const now = new Date();
  const existing = await getOneWhere2('invites', 'group_id', groupId, 'is_active', true);
  if (existing && new Date(existing.expires_at) > now) {
    return res.json({ token: existing.token, expires_at: existing.expires_at });
  }

  // Deactivate old invites
  await updateWhere('invites', 'group_id', groupId, { is_active: false });

  // Create new invite
  const token = crypto.randomBytes(16).toString('hex');
  const expires_at = new Date(Date.now() + INVITE_TTL_HOURS * 3600000).toISOString();

  await setDoc('invites', {
    id: uuidv4(), token, group_id: groupId, created_by: req.user.id,
    is_active: true, expires_at, created_at: now.toISOString(),
  });

  res.json({ token, expires_at });
});

// GET /api/invites/:token — public preview
router.get('/:token', async (req, res) => {
  const invite = await getOne('invites', 'token', req.params.token);
  if (!invite || !invite.is_active)
    return res.status(404).json({ error: 'Invite link is invalid or has expired' });

  if (new Date(invite.expires_at) < new Date())
    return res.status(410).json({ error: 'This invite link has expired' });

  const group = await getById('groups', invite.group_id);
  if (!group) return res.status(404).json({ error: 'Group no longer exists' });

  const memberships = await getAll('groupMembers', 'group_id', group.id);
  const creator = await getById('users', invite.created_by);
  const members = await Promise.all(
    memberships.map(async (m) => {
      const u = await getById('users', m.user_id);
      return u ? { id: u.id, name: u.name, avatar: u.avatar } : null;
    })
  );

  const expenses = await getAll('expenses', 'group_id', group.id);
  const totalAmount = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  res.json({
    group: { ...group, members: members.filter(Boolean), totalAmount },
    invite: {
      token: invite.token,
      expires_at: invite.expires_at,
      created_by: creator ? { id: creator.id, name: creator.name, avatar: creator.avatar } : null,
    },
  });
});

// POST /api/invites/:token/join
router.post('/:token/join', authMiddleware, async (req, res) => {
  const invite = await getOne('invites', 'token', req.params.token);
  if (!invite || !invite.is_active)
    return res.status(404).json({ error: 'Invite link is invalid or has expired' });

  if (new Date(invite.expires_at) < new Date())
    return res.status(410).json({ error: 'This invite link has expired' });

  const group = await getById('groups', invite.group_id);
  if (!group) return res.status(404).json({ error: 'Group no longer exists' });

  const existing = await getOneWhere2('groupMembers', 'group_id', group.id, 'user_id', req.user.id);
  if (existing) {
    return res.json({ message: 'Already a member', group: await getGroupWithMembers(group.id), alreadyMember: true });
  }

  const now = new Date().toISOString();
  await setDoc('groupMembers', { id: uuidv4(), group_id: group.id, user_id: req.user.id, role: 'member', joined_at: now });

  const joiningUser = await getById('users', req.user.id);
  await setDoc('activityFeed', {
    id: uuidv4(), user_id: req.user.id, group_id: group.id,
    type: 'member_added', description: `${joiningUser?.name || 'Someone'} joined the group`,
    created_at: now,
  });

  const allMembers = await getAll('groupMembers', 'group_id', group.id);
  for (const m of allMembers) {
    if (m.user_id === req.user.id) continue;
    await setDoc('notifications', {
      id: uuidv4(), user_id: m.user_id, type: 'member_added',
      title: 'New Member Joined',
      message: `${joiningUser?.name || 'Someone'} joined "${group.name}" via invite link`,
      is_read: 0, group_id: group.id,
      data: JSON.stringify({ groupId: group.id }), created_at: now,
    });
  }

  res.json({ message: 'Successfully joined!', group: await getGroupWithMembers(group.id) });
});

// DELETE /api/invites/:groupId/revoke
router.delete('/:groupId/revoke', authMiddleware, async (req, res) => {
  const membership = await getOneWhere2('groupMembers', 'group_id', req.params.groupId, 'user_id', req.user.id);
  if (!membership || membership.role !== 'owner')
    return res.status(403).json({ error: 'Only owner can revoke invites' });

  await updateWhere('invites', 'group_id', req.params.groupId, { is_active: false });
  res.json({ message: 'Invite links revoked' });
});

module.exports = router;

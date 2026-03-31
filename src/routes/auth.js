const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getById, getOne, setDoc, updateDoc } = require('../database/db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });

    const existing = await getOne('users', 'email', email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=4361EE&color=fff&size=128&bold=true`;

    const user = { id, name, email, password: hashed, avatar, currency: 'USD', created_at: new Date().toISOString() };
    await setDoc('users', user);

    const token = jwt.sign({ id, name, email }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = user;
    res.status(201).json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = await getOne('users', 'email', email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth — verifies via Google's userinfo API
router.post('/google', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'Google access token required' });

    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!googleRes.ok) return res.status(401).json({ error: 'Invalid Google access token' });

    const { sub: googleId, email, name, picture } = await googleRes.json();
    if (!email) return res.status(400).json({ error: 'Email not provided by Google' });

    let user = await getOne('users', 'email', email);
    if (!user) {
      const id = uuidv4();
      user = {
        id, name: name || email.split('@')[0], email, password: null,
        avatar: picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(name || email)}&background=4361EE&color=fff&size=128&bold=true`,
        currency: 'USD', google_id: googleId, created_at: new Date().toISOString(),
      };
      await setDoc('users', user);
    } else if (!user.google_id) {
      await updateDoc('users', user.id, { google_id: googleId, avatar: picture || user.avatar });
      user = await getById('users', user.id);
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const { password, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  const user = await getById('users', req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safeUser } = user;
  res.json(safeUser);
});

router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, avatar, currency, upi_id, bank_details } = req.body;
    const update = {};
    if (name) update.name = name;
    if (avatar) update.avatar = avatar;
    if (currency) update.currency = currency;
    if (upi_id !== undefined) update.upi_id = upi_id;
    if (bank_details !== undefined) update.bank_details = bank_details;

    await updateDoc('users', req.user.id, update);
    const user = await getById('users', req.user.id);
    const { password, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

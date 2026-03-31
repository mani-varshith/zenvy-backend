const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getOne, setDoc } = require('./database/db');

async function seed() {
  console.log('🌱 Seeding Firestore demo data...');

  // Demo user
  const email = 'demo@splitwise.app';
  const existing = await getOne('users', 'email', email);
  if (!existing) {
    const password = await bcrypt.hash('demo123', 10);
    const id = uuidv4();
    await setDoc('users', {
      id, name: 'Demo User', email, password,
      avatar: 'https://ui-avatars.com/api/?name=Demo+User&background=4361EE&color=fff&size=128&bold=true',
      currency: 'USD', upi_id: 'demo@upi', created_at: new Date().toISOString(),
    });
    console.log('✅ Demo user created: demo@splitwise.app / demo123');
  } else {
    console.log('ℹ️  Demo user already exists');
  }

  // Second demo user for testing splits
  const email2 = 'alice@splitwise.app';
  const existing2 = await getOne('users', 'email', email2);
  if (!existing2) {
    const password2 = await bcrypt.hash('alice123', 10);
    const id2 = uuidv4();
    await setDoc('users', {
      id: id2, name: 'Alice Johnson', email: email2, password: password2,
      avatar: 'https://ui-avatars.com/api/?name=Alice+Johnson&background=F72585&color=fff&size=128&bold=true',
      currency: 'USD', upi_id: 'alice@upi', created_at: new Date().toISOString(),
    });
    console.log('✅ Alice user created: alice@splitwise.app / alice123');
  } else {
    console.log('ℹ️  Alice user already exists');
  }

  console.log('🎉 Seeding complete!');
  process.exit(0);
}

seed().catch(err => { console.error('Seed error:', err); process.exit(1); });

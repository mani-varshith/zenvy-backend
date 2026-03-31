const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK (only once)
if (!admin.apps.length) {
  const serviceAccount = require(path.join(__dirname, '../../serviceAccount.json'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get a doc by its custom `id` field (used as the Firestore document ID) */
const getById = async (col, id) => {
  if (!id) return null;
  const doc = await db.collection(col).doc(String(id)).get();
  return doc.exists ? doc.data() : null;
};

/** Get the first document where ONE field equals a value */
const getOne = async (col, field, value) => {
  const snap = await db.collection(col).where(field, '==', value).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
};

/** Get the first document where TWO fields equal their values */
const getOneWhere2 = async (col, f1, v1, f2, v2) => {
  const snap = await db.collection(col).where(f1, '==', v1).where(f2, '==', v2).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
};

/** Get ALL documents in a collection (optional single equality filter) */
const getAll = async (col, field, value) => {
  const ref = db.collection(col);
  const snap = field !== undefined
    ? await ref.where(field, '==', value).get()
    : await ref.get();
  return snap.docs.map(d => d.data());
};

/** Get all documents matching TWO equality conditions */
const getAllWhere2 = async (col, f1, v1, f2, v2) => {
  const snap = await db.collection(col).where(f1, '==', v1).where(f2, '==', v2).get();
  return snap.docs.map(d => d.data());
};

/** Create / overwrite a document (uses data.id as doc ID) */
const setDoc = async (col, data) => {
  await db.collection(col).doc(String(data.id)).set(data);
  return data;
};

/** Update specific fields of a document */
const updateDoc = async (col, id, fields) => {
  await db.collection(col).doc(String(id)).update(fields);
};

/** Delete a single document by id */
const deleteDoc = async (col, id) => {
  await db.collection(col).doc(String(id)).delete();
};

/** Delete all documents where field == value */
const deleteWhere = async (col, field, value) => {
  const snap = await db.collection(col).where(field, '==', value).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
};

/** Delete all documents where TWO fields match */
const deleteWhere2 = async (col, f1, v1, f2, v2) => {
  const snap = await db.collection(col).where(f1, '==', v1).where(f2, '==', v2).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
};

/** Update field values for ALL docs matching a condition */
const updateWhere = async (col, field, value, fields) => {
  const snap = await db.collection(col).where(field, '==', value).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.update(d.ref, fields));
  await batch.commit();
};

module.exports = {
  db,
  getById,
  getOne,
  getOneWhere2,
  getAll,
  getAllWhere2,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteWhere,
  deleteWhere2,
  updateWhere,
};

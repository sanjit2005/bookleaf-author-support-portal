import mongoose from 'mongoose';
export async function connectDatabase(uri = process.env.MONGODB_URI) {
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri) || uri.includes('<')) throw new Error('A valid MONGODB_URI is required');
  try { return await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error('MongoDB connection failed; check URI and network access'); }
}
export async function disconnectDatabase() { await mongoose.disconnect(); }

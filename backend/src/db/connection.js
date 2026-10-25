import mongoose from 'mongoose';
import { databaseFailure } from '../config/startup-diagnostics.js';
export async function connectDatabase(uri = process.env.MONGODB_URI) {
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri) || uri.includes('<')) throw new Error('A valid MONGODB_URI is required');
  try { return await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 }); }
  catch(error) { throw databaseFailure(error); }
}
export async function disconnectDatabase() { await mongoose.disconnect(); }

import mongoose from 'mongoose';

export let dbReady = false;

/** Atlas URIs (mongodb+srv) negotiate TLS themselves. */
export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  dbReady = mongoose.connection.readyState === 1;
}

export function requireDb() {
  if (!dbReady) {
    const error = new Error('Database is not configured. Set MONGODB_URI.') as Error & { status?: number };
    error.status = 503;
    throw error;
  }
}

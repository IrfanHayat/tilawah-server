import { randomUUID } from 'crypto';
import mongoose, { Schema } from 'mongoose';

const userSchema = new Schema(
  {
    _id: { type: String, default: randomUUID },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String },
    googleSub: { type: String, unique: true, sparse: true },
    premium: { type: Boolean, default: false },
    settings: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

const bookmarkSchema = new Schema({
  _id: { type: String, default: randomUUID },
  userId: { type: String, required: true, index: true },
  surah: { type: Number, required: true },
  ayah: { type: Number, required: true },
  note: { type: String },
  createdLabel: { type: String },
});
bookmarkSchema.index({ userId: 1, surah: 1, ayah: 1 }, { unique: true });

const goalSchema = new Schema({
  _id: { type: String, default: randomUUID },
  userId: { type: String, required: true, index: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  detail: { type: String, required: true },
  progress: { type: Number, default: 0 },
  surahId: { type: Number, required: true },
  frequency: { type: String, required: true },
  reminder: { type: String, required: true },
});

const sessionSchema = new Schema({
  _id: { type: String, default: randomUUID },
  userId: { type: String, required: true, index: true },
  day: { type: String, required: true },
  minutes: { type: Number, default: 1 },
  surahId: { type: Number },
  kind: { type: String, required: true },
});

const mistakeSchema = new Schema(
  {
    _id: { type: String, default: randomUUID },
    userId: { type: String, required: true, index: true },
    surah: { type: Number, required: true },
    ayah: { type: Number, required: true },
    kind: { type: String, required: true },
    said: { type: String, default: '' },
    correct: { type: String, required: true },
    note: { type: String, default: '' },
    count: { type: Number, default: 1 },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const testSchema = new Schema(
  {
    _id: { type: String, default: randomUUID },
    userId: { type: String, required: true, index: true },
    rangeLabel: { type: String, required: true },
    minutes: { type: Number, default: 1 },
    accuracy: { type: Number, default: 0 },
    correctCount: { type: Number, default: 0 },
    mistakeCount: { type: Number, default: 0 },
    review: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

export const User = mongoose.model('User', userSchema);
export const Bookmark = mongoose.model('Bookmark', bookmarkSchema);
export const Goal = mongoose.model('Goal', goalSchema);
export const PracticeSession = mongoose.model('PracticeSession', sessionSchema);
export const Mistake = mongoose.model('Mistake', mistakeSchema);
export const TestRun = mongoose.model('TestRun', testSchema);

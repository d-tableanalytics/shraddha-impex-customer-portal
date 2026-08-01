import mongoose from 'mongoose';

// Named, atomically-incrementing sequences used to generate collision-free
// human-readable IDs (order numbers, reservation IDs). Replaces the previous
// Math.random() scheme, which could collide (and hard-fail on the unique
// reservationId index).
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // sequence name, e.g. 'order-2026'
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', counterSchema);

// Atomically increment and return the next value for a named sequence.
// findByIdAndUpdate with upsert is a single atomic op, so it is safe under
// concurrency. Pass a session to enlist it in an active transaction.
export const nextSequence = async (name, session = null) => {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, ...(session ? { session } : {}) }
  );
  return doc.seq;
};

/**
 * Reserve a contiguous BLOCK of `count` values in one atomic increment, and
 * return them.
 *
 * Calling nextSequence() in a loop costs one round trip per value, which turns
 * a 500-line stock posting into 500 sequential writes. A single $inc of the
 * whole block is one operation and is equally safe under concurrency: the
 * increment is atomic, so two callers can never be handed overlapping ranges.
 *
 * Returns the allocated values in ascending order. A count of zero allocates
 * nothing and returns an empty array, so callers do not need to special-case it.
 */
export const nextSequenceBlock = async (name, count, session = null) => {
  if (!Number.isInteger(count) || count <= 0) return [];

  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: count } },
    { new: true, upsert: true, ...(session ? { session } : {}) }
  );

  // `doc.seq` is the value AFTER the increment, so the block runs from
  // (seq - count + 1) up to seq inclusive.
  const first = doc.seq - count + 1;
  return Array.from({ length: count }, (_, i) => first + i);
};

export default Counter;

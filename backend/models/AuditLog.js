import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  method: String,
  endpoint: String,
  ipAddress: String,
  userAgent: String,
  // Free-text detail. Callers have always passed this (logEvent in the orders and
  // reservations controllers), but it was absent from the schema, so Mongoose
  // silently discarded it on every write.
  remarks: String,
  // Structured before/after detail for booking edits, so the trail can answer
  // "what changed" without parsing the remarks string:
  //   { orderId, changes: [{ type, skuCode, fromQty, toQty, ... }] }
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

auditLogSchema.index({ user: 1, createdAt: -1 });
auditLogSchema.index({ action: 1 });
// The retention sweep (AD-16) queries `createdAt < cutoff` with an `action`
// exclusion. Without this the sweep would collection-scan what is expected to
// become the largest collection in the system - roughly a million rows a year.
auditLogSchema.index({ createdAt: 1, action: 1 });

export default mongoose.model('AuditLog', auditLogSchema);

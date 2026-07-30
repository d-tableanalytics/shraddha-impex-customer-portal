import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  // Plaintext password used to match the auth sheet requirements.
  // TODO: replace with bcrypt.hash / bcrypt.compare once ready.
  password: { type: String, required: true },
  company: { type: String, default: null },
  user: { type: String, default: null }, // Maps to 'USER' column
  avatar: { type: String, default: null }, // Data URL or image link for the profile photo
  preferences: {
    emailNotifications: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: false },
  },
  // 'Sales' reviews confirmed bookings, may edit them until the PO is raised,
  // and raises the PO itself. Permissions live in middlewares/rbac.js.
  role: { type: String, enum: ['Admin', 'Sales', 'Customer'], default: 'Customer' },
  // Customer categorisation — drives which bulk-import template applies.
  customerCategory: { type: String, enum: ['MSIL', 'Non-MSIL'], default: 'Non-MSIL' },
  brandAccess: {
    koken: { type: Boolean, default: false },
    bix: { type: Boolean, default: false },
    imada: { type: Boolean, default: false }
  },
  moq: { type: String, default: null }, // String type to support 'SKIP'
  showMsilCode: { type: Boolean, default: false }, // Maps to 'Show MSIL Code'
  bookingCcEmails: { type: [String], default: [] }, // Maps to 'Booking CC Emails'
  status: { type: String, enum: ['Active', 'Inactive', 'Suspended'], default: 'Active' },
  lastLogin: { type: Date }
}, { timestamps: true });

export default mongoose.model('User', userSchema);

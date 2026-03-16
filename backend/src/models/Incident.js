import mongoose from 'mongoose';

const incidentSchema = new mongoose.Schema({
  incidentId:   { type: String, required: true, unique: true, index: true },
  type:         { type: String, required: true },
  subtype:      { type: String },
  zone:         { type: String, required: true },
  priority:     { type: Number, min: 1, max: 10, required: true },
  description:  { type: String, required: true },
  status: {
    type: String,
    enum: ['queued', 'active', 'resolved', 'quarantined'],
    default: 'active',
  },
  unitsDispatched: [String],
  resolvedAt:   { type: Date },
  metadata:     { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
  collection: 'incidents',
});

incidentSchema.index({ status: 1, createdAt: -1 });
incidentSchema.index({ zone: 1, status: 1 });

export const Incident = mongoose.model('Incident', incidentSchema);
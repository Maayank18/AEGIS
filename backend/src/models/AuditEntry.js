import mongoose from 'mongoose';

const toolCallSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  arguments: { type: mongoose.Schema.Types.Mixed },
  result:    { type: mongoose.Schema.Types.Mixed },
  executedAt: { type: Date, default: Date.now },
}, { _id: false });

const auditEntrySchema = new mongoose.Schema({
  incidentId: {
    type: String,
    required: true,
    index: true,
  },
  agentType: {
    type: String,
    enum: ['coordinator', 'police', 'fire', 'ems', 'traffic', 'comms', 'firewall'],
    required: true,
  },
  eventType:  { type: String },
  zone:       { type: String },
  priority:   { type: Number },
  reasoning:  { type: String, required: true },  // full chain-of-thought
  toolCalls:  [toolCallSchema],
  decision:   { type: String },
  threatScore: { type: Number, min: 0, max: 10 }, // firewall entries only
  wasBlocked: { type: Boolean, default: false },   // firewall entries only
  replanTrigger: { type: Boolean, default: false },
  metadata:   { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true, // adds createdAt, updatedAt
  collection: 'audit_entries',
});

// Index for fast timeline queries
auditEntrySchema.index({ createdAt: -1 });
auditEntrySchema.index({ agentType: 1, createdAt: -1 });

export const AuditEntry = mongoose.model('AuditEntry', auditEntrySchema);
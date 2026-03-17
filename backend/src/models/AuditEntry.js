/*
 * Why changed: add a safe persistence helper that never forces callers to depend on MongoDB availability.
 * Security rationale: firewall and decision events can be broadcast immediately while persistence retries happen in the background.
 */
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const toolCallSchema = new mongoose.Schema({
  name: { type: String, required: true },
  arguments: { type: mongoose.Schema.Types.Mixed },
  result: { type: mongoose.Schema.Types.Mixed },
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
  eventType: { type: String },
  zone: { type: String },
  priority: { type: Number },
  reasoning: { type: String, required: true },
  toolCalls: [toolCallSchema],
  decision: { type: String },
  threatScore: { type: Number, min: 0, max: 10 },
  wasBlocked: { type: Boolean, default: false },
  replanTrigger: { type: Boolean, default: false },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
  collection: 'audit_entries',
});

auditEntrySchema.index({ createdAt: -1 });
auditEntrySchema.index({ agentType: 1, createdAt: -1 });

auditEntrySchema.statics.safeCreate = async function safeCreate(doc, options = {}) {
  const { retries = 1, retryDelayMs = 1500 } = options;

  try {
    const entry = await this.create(doc);
    return { persisted: true, entry };
  } catch (err) {
    logger.error('Audit persist failed:', err.message);

    if (retries > 0) {
      const timer = setTimeout(() => {
        this.safeCreate(doc, { retries: retries - 1, retryDelayMs }).catch(() => {});
      }, retryDelayMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    return {
      persisted: false,
      error: err.message,
      retryScheduled: retries > 0,
    };
  }
};

export const AuditEntry = mongoose.model('AuditEntry', auditEntrySchema);

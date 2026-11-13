import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const { ObjectId, Mixed } = Schema.Types;

export const POSITIONS = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'];
export const PLAYER_STATUSES = ['available', 'sold', 'unsold', 'retained', 'withheld'];

const PlayerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    position: { type: String, enum: POSITIONS, required: true },
    tier: { type: String, default: '' },
    year: { type: String, default: '' },
    basePrice: { type: Number, default: null }, // overrides the tier base price
    order: { type: Number, default: 0 }, // order within its position block
    status: { type: String, enum: PLAYER_STATUSES, default: 'available', index: true },
    teamId: { type: ObjectId, ref: 'Team', default: null, index: true },
    price: { type: Number, default: null },
    soldAt: { type: Date, default: null },
    lotSeq: { type: Number, default: null },
    // Photos
    photoSource: { type: String, default: '' }, // e.g. Google Drive link from the sheet
    photoKey: { type: String, default: '' },
    thumbKey: { type: String, default: '' },
    photoSyncedFrom: { type: String, default: '' },
    photoError: { type: String, default: '' },
    // Sheet sync + extras
    sheetKey: { type: String, index: true, sparse: true },
    attributes: { type: Map, of: Number, default: {} }, // optional ratings for player cards
    extra: { type: Map, of: String, default: {} }, // any additional sheet columns
  },
  { timestamps: true },
);

const TeamSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    shortName: { type: String, default: '', trim: true },
    color: { type: String, default: '#e11d48' },
    logoKey: { type: String, default: '' },
    captainName: { type: String, default: '' },
    captainPhotoKey: { type: String, default: '' },
    budget: { type: Number, default: null }, // null = use the global team budget
    frozen: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    captainPasswordEnc: { type: String, default: '' },
    tokenVersion: { type: Number, default: 0 },
    // Private captain planning (never sent to other teams)
    plan: {
      formation: { type: String, default: '4-4-2' },
      lineup: { type: Mixed, default: {} }, // slotId -> playerId
      watchlist: { type: [{ playerId: String, maxPrice: Number, note: String }], default: [] },
    },
  },
  { timestamps: true },
);

const SettingsSchema = new Schema(
  {
    _id: { type: String, default: 'main' },
    auction: { type: Mixed, default: {} },
    captainView: { type: Mixed, default: {} },
    studio: { type: Mixed, default: {} },
    portal: { type: Mixed, default: {} },
    integrations: {
      googleEnc: { type: String, default: '' },
      r2Enc: { type: String, default: '' },
      sheetUrl: { type: String, default: '' },
      sheetTab: { type: String, default: '' },
    },
    portalCodeEnc: { type: String, default: '' },
    adminPasswordHash: { type: String, default: '' },
    adminTokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);

const BidSchema = new Schema({
  lotSeq: { type: Number, index: true },
  round: Number,
  playerId: { type: ObjectId, ref: 'Player' },
  teamId: { type: ObjectId, ref: 'Team' },
  amount: Number,
  source: String, // captain | admin | manual
  at: { type: Date, default: Date.now },
});

const AuditLogSchema = new Schema({
  type: { type: String, index: true },
  actor: String,
  data: Mixed,
  at: { type: Date, default: Date.now, index: true },
});

const AuctionStateSchema = new Schema(
  { _id: { type: String, default: 'main' }, state: Mixed },
  { timestamps: true, minimize: false },
);

/** Image storage used when R2 is not configured yet. */
const MediaSchema = new Schema({
  _id: String, // storage key
  contentType: String,
  data: Buffer,
  size: Number,
  createdAt: { type: Date, default: Date.now },
});

export const Player = model('Player', PlayerSchema);
export const Team = model('Team', TeamSchema);
export const Settings = model('Settings', SettingsSchema);
export const Bid = model('Bid', BidSchema);
export const AuditLog = model('AuditLog', AuditLogSchema);
export const AuctionState = model('AuctionState', AuctionStateSchema);
export const Media = model('Media', MediaSchema);

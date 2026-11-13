/**
 * The only settings that must live in the environment: everything else
 * (Google, R2, auction rules, passwords) is configured from the admin panel
 * and stored encrypted in MongoDB.
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}. See .env.example`);
    process.exit(1);
  }
  return value;
}

const masterKey = required('MASTER_KEY');
if (masterKey.length < 32) {
  console.error('MASTER_KEY must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: required('MONGODB_URI'),
  masterKey,
  /** Used only until an admin password has been saved from the panel. */
  bootstrapAdminPassword: process.env.ADMIN_PASSWORD || '',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
  isProd: process.env.NODE_ENV === 'production',
};

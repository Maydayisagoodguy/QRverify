'use strict';

module.exports = {
  port:              parseInt(process.env.PORT || '3000', 10),
  nodeEnv:           process.env.NODE_ENV || 'development',
  verifyBaseUrl:     process.env.VERIFY_BASE_URL || 'http://localhost:3000',
  hmacSecret:        process.env.HMAC_SECRET,
  supabaseUrl:       process.env.SUPABASE_URL,
  supabaseServiceKey:process.env.SUPABASE_SERVICE_KEY,
  upstashRedisUrl:   process.env.UPSTASH_REDIS_REST_URL,
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  resendApiKey:      process.env.RESEND_API_KEY,
  alertEmail:        process.env.ALERT_EMAIL,
  adminApiKey:       process.env.ADMIN_API_KEY,
};

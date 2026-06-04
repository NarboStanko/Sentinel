export interface RateLimits {
  SUBMIT_PER_HOUR: number;
  IP_PER_MINUTE: number;
  SUSPICIOUS_THRESHOLD: number;
  LOCKOUT_LIMIT_PER_HOUR: number;
  LOCKOUT_DURATION_MS: number;
}

export function getLimits(): RateLimits {
  const isProd = process.env['NODE_ENV'] === 'production';
  return {
    SUBMIT_PER_HOUR:        isProd ? 20  : 200,
    IP_PER_MINUTE:          isProd ? 60  : 600,
    SUSPICIOUS_THRESHOLD:   100,
    LOCKOUT_LIMIT_PER_HOUR: 1,
    LOCKOUT_DURATION_MS:    24 * 60 * 60 * 1000,
  };
}

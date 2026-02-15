/**
 * Moltbook Identity Verification Middleware
 * 
 * Verifies agent identity via Moltbook API.
 * Caches results for 1 hour.
 * Rate limited: 100 verifications/minute.
 */

const MOLTBOOK_VERIFY_URL = 'https://moltbook.com/api/v1/agents/verify-identity';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100;

// ─── In-memory cache ─────────────────────────────────────────────────────────
const verificationCache = new Map();
let rateLimitCounter = { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW };

/**
 * Clean expired cache entries periodically
 */
function cleanCache() {
    const now = Date.now();
    for (const [key, entry] of verificationCache) {
        if (now - entry.cachedAt > CACHE_TTL) {
            verificationCache.delete(key);
        }
    }
}
setInterval(cleanCache, 5 * 60 * 1000); // Clean every 5 min

/**
 * Check rate limit for Moltbook API calls
 */
function checkRateLimit() {
    const now = Date.now();
    if (now > rateLimitCounter.resetAt) {
        rateLimitCounter = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    }
    if (rateLimitCounter.count >= RATE_LIMIT_MAX) {
        return false;
    }
    rateLimitCounter.count++;
    return true;
}

/**
 * Verify a Moltbook identity token
 * @param {string} token - The Moltbook identity token
 * @returns {Promise<object|null>} Agent info or null if invalid
 */
async function verifyMoltbookToken(token) {
    // Check cache first
    const cached = verificationCache.get(token);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
        return cached.data;
    }

    // Rate limit check
    if (!checkRateLimit()) {
        console.warn('[Moltbook] Rate limit exceeded for verification requests');
        // Return cached data even if stale, rather than failing
        if (cached) return cached.data;
        return null;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(MOLTBOOK_VERIFY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ token }),
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.warn(`[Moltbook] Verification failed: HTTP ${response.status}`);
            return null;
        }

        const data = await response.json();

        if (!data.verified || !data.agent) {
            console.warn('[Moltbook] Token not verified or no agent data');
            return null;
        }

        // Cache the result
        const agentInfo = {
            id: data.agent.id,
            name: data.agent.name,
            karma: data.agent.karma || 0,
            stats: data.agent.stats || {},
            avatar: data.agent.avatar || null,
            platform: 'moltbook',
        };

        verificationCache.set(token, {
            data: agentInfo,
            cachedAt: Date.now()
        });

        console.log(`[Moltbook] Verified agent: ${agentInfo.name} (karma: ${agentInfo.karma})`);
        return agentInfo;
    } catch (err) {
        console.error('[Moltbook] Verification error:', err.message);
        // Return stale cache if available
        if (cached) return cached.data;
        return null;
    }
}

/**
 * Express middleware: extracts X-Moltbook-Identity header,
 * verifies the token, and populates req.bot with agent info.
 * 
 * Non-blocking: if header is absent, continues without req.bot.
 * If header is present but invalid, returns 401.
 */
function moltbookAuth(req, res, next) {
    const token = req.headers['x-moltbook-identity'];

    if (!token) {
        // No Moltbook token — proceed normally (optional auth)
        return next();
    }

    verifyMoltbookToken(token)
        .then(agentInfo => {
            if (!agentInfo) {
                return res.status(401).json({
                    error: 'Invalid Moltbook identity token',
                    hint: 'Get a valid token from https://moltbook.com/auth.md?app=MonadColosseum'
                });
            }
            req.bot = agentInfo;
            next();
        })
        .catch(err => {
            console.error('[Moltbook] Middleware error:', err.message);
            return res.status(500).json({ error: 'Moltbook verification service error' });
        });
}

/**
 * Get Moltbook karma tier info
 * @param {number} karma 
 * @returns {{ tier: string, freeEntry: boolean, rewardMultiplier: number }}
 */
function getKarmaTier(karma) {
    if (karma >= 500) {
        return { tier: 'elite', freeEntry: true, rewardMultiplier: 0.75 };
    }
    if (karma >= 100) {
        return { tier: 'trusted', freeEntry: true, rewardMultiplier: 0.50 };
    }
    return { tier: 'newcomer', freeEntry: false, rewardMultiplier: 0.50 };
}

module.exports = {
    moltbookAuth,
    verifyMoltbookToken,
    getKarmaTier,
    verificationCache, // exposed for testing
};

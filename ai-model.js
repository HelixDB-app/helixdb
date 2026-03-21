/**
 * Enhanced Cloudflare Worker for AI Gateway with Conversation Support
 * Features:
 * - Multi-message conversation support
 * - Optimized LRU cache with content-based hashing
 * - Conversation state management
 * - High-performance request handling
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Content-Type': 'application/json',
  };
  
  const CONFIG = {
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    defaultTemperature: 0.7,
    defaultMaxTokens: 512,
    logLevel: 'info',
    cache: {
      enabled: true,
      maxItems: 200,
      ttl: 3600, // 1 hour
      conversationTtl: 7200, // 2 hours for conversations
    },
    performance: {
      enableCompression: true,
      cacheMaintenanceInterval: 0.02, // 2% chance per request
    }
  };
  
  // ============================================================================
  // UTILITIES
  // ============================================================================
  
  /**
   * Simple hash function for creating cache keys
   * Uses FNV-1a algorithm for better distribution
   */
  class SimpleHash {
    static fnv1a(str) {
      let hash = 2166136261;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
      return (hash >>> 0).toString(36);
    }
  
    static generate(data) {
      return this.fnv1a(JSON.stringify(data));
    }
  }
  
  /**
   * Logger with level-based filtering
   */
  const logger = {
    debug: (...args) => CONFIG.logLevel === 'debug' && console.debug('[DEBUG]', ...args),
    info: (...args) => ['debug', 'info'].includes(CONFIG.logLevel) && console.info('[INFO]', ...args),
    warn: (...args) => ['debug', 'info', 'warn'].includes(CONFIG.logLevel) && console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
  };
  
  // ============================================================================
  // CACHE IMPLEMENTATION
  // ============================================================================
  
  /**
   * High-performance LRU Cache with TTL support
   * Optimized for Cloudflare Workers environment
   */
  class ConversationCache {
    constructor() {
      if (!globalThis._aiCache) {
        globalThis._aiCache = {
          items: new Map(),
          accessOrder: [],
          created: Date.now(),
          stats: { hits: 0, misses: 0, evictions: 0 }
        };
      }
      this.cache = globalThis._aiCache;
    }
  
    /**
     * Generate optimized cache key from conversation state
     */
    generateKey(params) {
      // Use provided conversation ID if available
      if (params.conversationId && params.messages) {
        const lastMessage = params.messages[params.messages.length - 1];
        return `conv:${params.conversationId}:${SimpleHash.generate(lastMessage)}`;
      }
  
      // Fallback to complete message hash
      const keyData = {
        model: params.model,
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.max_tokens
      };
      
      return `msg:${SimpleHash.generate(keyData)}`;
    }
  
    /**
     * Retrieve item from cache
     */
    get(key) {
      const item = this.cache.items.get(key);
      
      if (!item) {
        this.cache.stats.misses++;
        return null;
      }
      
      // Check expiration
      if (Date.now() > item.expiry) {
        this.cache.items.delete(key);
        this.cache.stats.misses++;
        return null;
      }
      
      // Update LRU tracking
      this._updateAccessOrder(key);
      this.cache.stats.hits++;
      
      return item.value;
    }
  
    /**
     * Store item in cache
     */
    set(key, value, ttl = CONFIG.cache.ttl) {
      // Enforce size limit using LRU eviction
      if (this.cache.items.size >= CONFIG.cache.maxItems) {
        this._evictLRU();
      }
      
      const expiry = Date.now() + (ttl * 1000);
      
      this.cache.items.set(key, {
        value,
        expiry,
        createdAt: Date.now()
      });
      
      this._updateAccessOrder(key);
    }
  
    /**
     * Update access order for LRU tracking
     */
    _updateAccessOrder(key) {
      // Remove key from current position
      const idx = this.cache.accessOrder.indexOf(key);
      if (idx > -1) {
        this.cache.accessOrder.splice(idx, 1);
      }
      
      // Add to end (most recently used)
      this.cache.accessOrder.push(key);
    }
  
    /**
     * Evict least recently used item
     */
    _evictLRU() {
      if (this.cache.accessOrder.length === 0) return;
      
      const lruKey = this.cache.accessOrder.shift();
      this.cache.items.delete(lruKey);
      this.cache.stats.evictions++;
      
      logger.debug(`Evicted LRU item: ${lruKey}`);
    }
  
    /**
     * Purge expired items
     */
    purgeExpired() {
      const now = Date.now();
      let purged = 0;
      
      for (const [key, item] of this.cache.items.entries()) {
        if (now > item.expiry) {
          this.cache.items.delete(key);
          
          // Remove from access order
          const idx = this.cache.accessOrder.indexOf(key);
          if (idx > -1) {
            this.cache.accessOrder.splice(idx, 1);
          }
          
          purged++;
        }
      }
      
      return purged;
    }
  
    /**
     * Get cache statistics
     */
    getStats() {
      const now = Date.now();
      let validItems = 0;
      
      for (const item of this.cache.items.values()) {
        if (now <= item.expiry) validItems++;
      }
      
      return {
        totalItems: this.cache.items.size,
        validItems,
        cacheAge: Math.round((now - this.cache.created) / 1000),
        hitRate: this.cache.stats.hits + this.cache.stats.misses > 0
          ? (this.cache.stats.hits / (this.cache.stats.hits + this.cache.stats.misses) * 100).toFixed(2) + '%'
          : '0%',
        ...this.cache.stats
      };
    }
  
    /**
     * Clear all cache
     */
    clear() {
      this.cache.items.clear();
      this.cache.accessOrder = [];
      this.cache.stats = { hits: 0, misses: 0, evictions: 0 };
    }
  }
  
  // ============================================================================
  // REQUEST VALIDATION
  // ============================================================================
  
  /**
   * Validate and normalize conversation request
   */
  class RequestValidator {
    static validate(data) {
      const errors = [];
  
      // Validate messages array
      if (!Array.isArray(data.messages) || data.messages.length === 0) {
        errors.push('messages must be a non-empty array');
      } else {
        // Validate each message
        data.messages.forEach((msg, idx) => {
          if (!msg.role || !['system', 'user', 'assistant'].includes(msg.role)) {
            errors.push(`Message ${idx}: invalid or missing role`);
          }
          if (!msg.content || typeof msg.content !== 'string') {
            errors.push(`Message ${idx}: invalid or missing content`);
          }
        });
      }
  
      if (errors.length > 0) {
        throw new Error(errors.join('; '));
      }
  
      // Return normalized parameters
      return {
        conversationId: data.conversationId || null,
        messages: data.messages.map(m => ({
          role: m.role,
          content: m.content.trim()
        })),
        model: data.model || CONFIG.defaultModel,
        temperature: this._parseFloat(data.temperature, CONFIG.defaultTemperature, 0, 2),
        max_tokens: this._parseInt(data.max_tokens, CONFIG.defaultMaxTokens, 1, 4096),
        stream: Boolean(data.stream),
        skipCache: Boolean(data.skipCache)
      };
    }
  
    static _parseFloat(value, defaultValue, min, max) {
      const parsed = parseFloat(value ?? defaultValue);
      return Math.max(min, Math.min(max, isNaN(parsed) ? defaultValue : parsed));
    }
  
    static _parseInt(value, defaultValue, min, max) {
      const parsed = parseInt(value ?? defaultValue, 10);
      return Math.max(min, Math.min(max, isNaN(parsed) ? defaultValue : parsed));
    }
  }
  
  // ============================================================================
  // RESPONSE HELPERS
  // ============================================================================
  
  function createResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS_HEADERS, ...headers },
    });
  }
  
  function errorResponse(message, status = 500, details = null) {
    logger.error(`Error ${status}: ${message}`, details);
    
    return createResponse({
      error: message,
      status,
      timestamp: new Date().toISOString(),
      ...(CONFIG.logLevel === 'debug' && details ? { details: details.message } : {})
    }, status);
  }
  
  // ============================================================================
  // MAIN WORKER
  // ============================================================================
  
  const cache = new ConversationCache();
  
  export default {
    async fetch(request, env, ctx) {
      const startTime = performance.now();
  
      // Periodic cache maintenance
      if (Math.random() < CONFIG.performance.cacheMaintenanceInterval) {
        const purged = cache.purgeExpired();
        if (purged > 0) {
          logger.info(`Cache maintenance: purged ${purged} expired items`);
        }
      }
  
      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
  
      // Cache stats endpoint
      if (request.url.endsWith('/cache-stats') && request.method === 'GET') {
        return createResponse({
          enabled: CONFIG.cache.enabled,
          stats: cache.getStats(),
          config: {
            maxItems: CONFIG.cache.maxItems,
            ttl: CONFIG.cache.ttl,
            conversationTtl: CONFIG.cache.conversationTtl
          }
        });
      }
  
      // Health check endpoint
      if (request.url.endsWith('/health') && request.method === 'GET') {
        return createResponse({ 
          status: 'healthy',
          timestamp: new Date().toISOString(),
          cache: CONFIG.cache.enabled ? 'enabled' : 'disabled'
        });
      }
  
      // Validate method
      if (request.method !== 'POST') {
        return errorResponse('Method not allowed. Use POST.', 405);
      }
  
      try {
        // Parse request body
        let requestData;
        try {
          requestData = await request.json();
        } catch (e) {
          return errorResponse('Invalid JSON in request body', 400, e);
        }
  
        // Validate and normalize
        let params;
        try {
          params = RequestValidator.validate(requestData);
        } catch (e) {
          return errorResponse(e.message, 400, e);
        }
  
        logger.debug('Request params:', params);
  
        // Check cache
        let cacheKey = null;
        if (CONFIG.cache.enabled && !params.stream && !params.skipCache) {
          cacheKey = cache.generateKey(params);
          const cached = cache.get(cacheKey);
          
          if (cached) {
            logger.info(`Cache HIT: ${cacheKey}`);
            const responseTime = Math.round(performance.now() - startTime);
            
            return createResponse({
              ...cached,
              metadata: {
                ...cached.metadata,
                cached: true,
                cacheKey,
                response_time_ms: responseTime
              }
            });
          }
          
          logger.debug(`Cache MISS: ${cacheKey}`);
        }
  
        // Prepare AI request
        const aiPayload = {
          messages: params.messages,
          temperature: params.temperature,
          max_tokens: params.max_tokens,
          stream: params.stream
        };
  
        logger.info(`Calling AI model: ${params.model}`);
  
        // Handle streaming
        if (params.stream) {
          const stream = await env.AI.run(params.model, aiPayload);
          return new Response(stream, { headers: CORS_HEADERS });
        }
  
        // Regular request
        const aiStartTime = performance.now();
        const aiResponse = await env.AI.run(params.model, aiPayload);
        const aiEndTime = performance.now();
        const aiDuration = Math.round(aiEndTime - aiStartTime);
  
        // Format response
        const response = {
          ...(typeof aiResponse === 'string' ? { response: aiResponse } : aiResponse),
          conversationId: params.conversationId,
          metadata: {
            model: params.model,
            processing_time_ms: aiDuration,
            total_time_ms: Math.round(performance.now() - startTime),
            timestamp: new Date().toISOString(),
            cached: false,
            message_count: params.messages.length
          }
        };
  
        // Cache the response
        if (CONFIG.cache.enabled && !params.skipCache && cacheKey) {
          const ttl = params.conversationId ? CONFIG.cache.conversationTtl : CONFIG.cache.ttl;
          cache.set(cacheKey, response, ttl);
          logger.debug(`Cached response: ${cacheKey}`);
          response.metadata.cacheKey = cacheKey;
        }
  
        logger.info(`Request completed in ${response.metadata.total_time_ms}ms`);
        return createResponse(response);
  
      } catch (error) {
        logger.error('Request failed:', error);
  
        if (error.message?.includes('AI') || error.message?.includes('binding')) {
          return errorResponse(
            'AI service unavailable. Ensure Cloudflare AI is bound to this Worker.',
            503,
            error
          );
        }
  
        return errorResponse('Internal server error', 500, error);
      }
    }
  };
const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'preference-template-service';

const express = require('express');
const cors = require('cors');
const { logger, expressLoggerMiddleware } = require('@notifyflow/logger');
const { getRedisClient, KEYS } = require('@notifyflow/redis');
const { getDbPool } = require('./db');
const { validateUpdatePreferences, validateCreateTemplate, validateRegisterUser, validateCreateEventType } = require('@notifyflow/schemas');

const app = express();
const PORT = process.env.PREFERENCE_PORT || 3003;

app.use(cors());
app.use(express.json());

// Inject central AsyncLocalStorage request tracing middleware
app.use(expressLoggerMiddleware);

/**
 * GET /health
 * Service-level diagnostic check.
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    service: 'preference-template-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// ==============================================================================
// USER PREFERENCES ROUTES
// ==============================================================================

/**
 * POST /v1/users
 * Registers a new user under B2B tenant boundaries.
 * Returns the generated cryptographic userId.
 */
app.post('/v1/users', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database connection is offline.'
    });
  }

  const validationResult = validateRegisterUser(req.body);
  if (!validationResult.success) {
    const error = validationResult.error.errors[0];
    return res.status(400).json({
      error: "ValidationError",
      field: error.path.join('.'),
      message: error.message
    });
  }

  const { externalUserId, email, phone } = validationResult.data;

  try {
    // Generate a unique user ID prefixed with 'user-'
    const userId = `user-${crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID()}`;
    const extId = externalUserId || userId;

    await dbPool.query(
      `INSERT INTO users (id, tenant_id, external_user_id, email, phone)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, tenantId, extId, email || null, phone || null]
    );

    // Initialize default opt-in preferences for all channels for this user
    const channels = ['email', 'sms', 'push'];
    for (const channel of channels) {
      await dbPool.query(
        `INSERT INTO user_preferences (user_id, channel, opted_in, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, channel) DO NOTHING`,
        [userId, channel, true]
      );
    }

    logger.info('Successfully registered user via POST /v1/users', { userId, tenantId, externalUserId: extId });

    return res.status(201).json({
      status: 'SUCCESS',
      message: 'User registered successfully under tenant.',
      userId,
      externalUserId: extId,
      email: email || null,
      phone: phone || null
    });
  } catch (error) {
    logger.error('Error registering new user', {
      tenantId,
      error: error.message
    });

    if (error.code === '23505') {
      return res.status(409).json({
        error: 'ConflictError',
        message: 'A user with this externalUserId already exists for this tenant.'
      });
    }

    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to register user.'
    });
  }
});

/**
 * POST /v1/event-types
 * Registers a new event type under the current B2B tenant scope, along with optional templates in a transaction.
 */
app.post('/v1/event-types', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database connection is offline.'
    });
  }

  const validationResult = validateCreateEventType(req.body);
  if (!validationResult.success) {
    const error = validationResult.error.errors[0];
    return res.status(400).json({
      error: "ValidationError",
      field: error.path.join('.'),
      message: error.message
    });
  }

  const { eventType, description, templates } = validationResult.data;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Upsert event_types record
    const etQuery = `
      INSERT INTO event_types (tenant_id, event_type, description)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, event_type) 
      DO UPDATE SET description = EXCLUDED.description
      RETURNING id, tenant_id as "tenantId", event_type as "eventType", description, created_at as "createdAt"
    `;
    const etResult = await client.query(etQuery, [tenantId, eventType, description || null]);
    const createdRecord = etResult.rows[0];

    // 2. Clear and sync template records if templates are explicitly supplied
    if (templates !== undefined) {
      await client.query(
        'DELETE FROM notification_templates WHERE tenant_id = $1 AND event_type = $2',
        [tenantId, eventType]
      );

      for (const [channel, tpl] of Object.entries(templates)) {
        if (tpl && tpl.body) {
          const subject = channel === 'email' ? (tpl.subject || '') : null;
          await client.query(
            `INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
             VALUES ($1, $2, $3, $4, $5)`,
            [tenantId, eventType, channel, subject, tpl.body]
          );
        }
      }
    }

    await client.query('COMMIT');
    logger.info('Registered event type and templates successfully', { tenantId, eventType });

    return res.status(201).json({
      status: 'SUCCESS',
      message: 'Event type and templates registered successfully.',
      eventType: {
        ...createdRecord,
        templates: templates || {}
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error registering event type and templates', {
      tenantId,
      eventType,
      error: error.message
    });

    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to register event type.'
    });
  } finally {
    client.release();
  }
});

/**
 * GET /v1/event-types
 * Returns all event types registered by the current B2B tenant with template details.
 */
app.get('/v1/event-types', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database connection is offline.'
    });
  }

  try {
    const query = `
      SELECT 
        et.id,
        et.tenant_id as "tenantId",
        et.event_type as "eventType",
        et.description,
        et.created_at as "createdAt",
        COALESCE(
          jsonb_object_agg(
            nt.channel, 
            jsonb_build_object(
              'subject', nt.subject_template, 
              'body', nt.body_template
            )
          ) FILTER (WHERE nt.channel IS NOT NULL), 
          '{}'::jsonb
        ) as "templates"
      FROM event_types et
      LEFT JOIN notification_templates nt ON et.tenant_id = nt.tenant_id AND et.event_type = nt.event_type
      WHERE et.tenant_id = $1
      GROUP BY et.id, et.tenant_id, et.event_type, et.description, et.created_at
      ORDER BY et.event_type ASC
    `;
    const result = await dbPool.query(query, [tenantId]);

    return res.status(200).json({
      status: 'SUCCESS',
      eventTypes: result.rows
    });
  } catch (error) {
    logger.error('Error fetching event types', {
      tenantId,
      error: error.message
    });

    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to retrieve event types.'
    });
  }
});

/**
 * DELETE /v1/event-types/:eventType
 * Deletes a registered event type and all its associated templates for this B2B tenant.
 */
app.delete('/v1/event-types/:eventType', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  const { eventType } = req.params;

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database connection is offline.'
    });
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete associated templates
    await client.query(
      'DELETE FROM notification_templates WHERE tenant_id = $1 AND event_type = $2',
      [tenantId, eventType]
    );

    // 2. Delete event type
    const result = await client.query(
      'DELETE FROM event_types WHERE tenant_id = $1 AND event_type = $2 RETURNING id',
      [tenantId, eventType]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'NotFoundError',
        message: `Event type '${eventType}' not found.`
      });
    }

    await client.query('COMMIT');
    logger.info('Deleted event type and associated templates successfully', { tenantId, eventType });

    return res.status(200).json({
      status: 'SUCCESS',
      message: `Event type '${eventType}' and all its associated templates have been deleted.`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error deleting event type', { tenantId, eventType, error: error.message });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to delete event type.'
    });
  } finally {
    client.release();
  }
});

/**
 * GET /v1/preferences/:userId
 * Retrieves custom opt-in/opt-out channel states for a user.
 * Employs a robust Redis Cache-Aside strategy defaulting to fully opted-in.
 */
app.get('/v1/preferences/:userId', async (req, res) => {
  const { userId } = req.params;
  
  if (!redisClient || !dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database/Cache connections are offline. Please try again shortly.'
    });
  }

  const redisKey = KEYS.preference(userId);

  try {
    // 1. Attempt cache lookup first
    const cachedPrefs = await redisClient.get(redisKey);
    if (cachedPrefs) {
      logger.info('User preferences cache HIT', { userId });
      return res.status(200).json(JSON.parse(cachedPrefs));
    }

    logger.info('User preferences cache MISS. Fetching from PostgreSQL...', { userId });

    // 2. Query user metadata from Postgres
    const userQuery = `
      SELECT email, phone, push_token 
      FROM users 
      WHERE id = $1
    `;
    const userResult = await dbPool.query(userQuery, [userId]);
    const userRow = userResult.rows[0] || {};

    // 3. Query preferences from Postgres
    const query = `
      SELECT channel, opted_in 
      FROM user_preferences 
      WHERE user_id = $1
    `;
    const result = await dbPool.query(query, [userId]);

    // 4. Defaults mapping (opted-in by default for email, sms, and push)
    const defaultPreferences = {
      email: true,
      sms: true,
      push: true
    };

    // Merge database configurations over defaults
    result.rows.forEach(row => {
      if (row.channel in defaultPreferences) {
        defaultPreferences[row.channel] = row.opted_in;
      }
    });

    const responsePayload = {
      userId,
      email: userRow.email || null,
      phone: userRow.phone || null,
      hasPushToken: !!userRow.push_token,
      preferences: Object.keys(defaultPreferences).map(channel => ({
        channel,
        optedIn: defaultPreferences[channel]
      }))
    };

    // 5. Cache in Redis with 5-minute TTL (300 seconds)
    await redisClient.set(redisKey, JSON.stringify(responsePayload), 'EX', 300);
    logger.debug('User preferences cached successfully', { userId, ttlSeconds: 300 });

    return res.status(200).json(responsePayload);

  } catch (error) {
    logger.error('Error fetching user preferences', {
      userId,
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to retrieve user preferences.'
    });
  }
});

/**
 * POST /v1/preferences/:userId
 * Updates channel states for a user. Invalidate Redis key on mutation.
 */
app.post('/v1/preferences/:userId', async (req, res) => {
  const { userId } = req.params;
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!redisClient || !dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database/Cache connections are offline. Please try again shortly.'
    });
  }

  // 1. Zod validation check
  const validation = validateUpdatePreferences(req.body);
  if (!validation.success) {
    logger.warn('Failed validation for preferences update request', { errors: validation.error.errors });
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid preferences format',
      details: validation.error.errors
    });
  }

  const { preferences } = validation.data;
  const redisKey = KEYS.preference(userId);

  try {
    // 2. Perform lazy-initialization: ensure user exists under tenant
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, external_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [userId, tenantId, userId]
    );

    // 3. Batch insert/upsert configurations
    for (const pref of preferences) {
      await dbPool.query(
        `INSERT INTO user_preferences (user_id, channel, opted_in, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, channel)
         DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_at = NOW()`,
        [userId, pref.channel, pref.optedIn]
      );
    }

    // 4. Strong Cache Consistency: Evict cache key immediately on database commit
    await redisClient.del(redisKey);
    logger.info('User preferences database updated & cache evicted successfully', { userId });

    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Preferences updated successfully.',
      userId,
      preferences
    });

  } catch (error) {
    logger.error('Error updating user preferences', {
      userId,
      tenantId,
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to persist user preferences.'
    });
  }
});

/**
 * POST /v1/preferences/:userId/push-token
 * Registers a real browser Web Push token/subscription inside PostgreSQL.
 */
app.post('/v1/preferences/:userId/push-token', async (req, res) => {
  const { userId } = req.params;
  const { pushToken } = req.body;
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool || !redisClient) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database/Cache connections are offline.'
    });
  }

  try {
    const tokenStr = typeof pushToken === 'string' ? pushToken : JSON.stringify(pushToken);
    
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, external_user_id, push_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) 
       DO UPDATE SET push_token = EXCLUDED.push_token`,
      [userId, tenantId, userId, tokenStr]
    );

    // Evict Redis Cache
    const redisKey = KEYS.preference(userId);
    await redisClient.del(redisKey);

    logger.info('Successfully registered browser push subscription in PostgreSQL & evicted cache', { userId });
    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Browser push subscription registered successfully.',
      userId
    });
  } catch (error) {
    logger.error('Error saving user push token', {
      userId,
      tenantId,
      error: error.message
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to save push subscription.'
    });
  }
});

/**
 * POST /v1/preferences/:userId/email
 * Registers an email address inside PostgreSQL for the user.
 */
app.post('/v1/preferences/:userId/email', async (req, res) => {
  const { userId } = req.params;
  const { email } = req.body;
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool || !redisClient) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database/Cache connections are offline.'
    });
  }

  try {
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, external_user_id, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) 
       DO UPDATE SET email = EXCLUDED.email`,
      [userId, tenantId, userId, email]
    );

    // Ensure they are opted-in for email preferences as well
    await dbPool.query(
      `INSERT INTO user_preferences (user_id, channel, opted_in, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, channel)
       DO UPDATE SET opted_in = true, updated_at = NOW()`,
      [userId, 'email', true]
    );

    // Evict Redis Cache
    const redisKey = KEYS.preference(userId);
    await redisClient.del(redisKey);

    logger.info('Successfully registered user email in PostgreSQL & evicted cache', { userId, email });
    return res.status(200).json({
      status: 'SUCCESS',
      message: 'User email registered and opted-in successfully.',
      userId,
      email
    });
  } catch (error) {
    logger.error('Error saving user email', {
      userId,
      tenantId,
      error: error.message
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to save email.'
    });
  }
});

/**
 * POST /v1/preferences/:userId/phone
 * Registers a phone number inside PostgreSQL for the user.
 */
app.post('/v1/preferences/:userId/phone', async (req, res) => {
  const { userId } = req.params;
  const { phone } = req.body;
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool || !redisClient) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database/Cache connections are offline.'
    });
  }

  try {
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, external_user_id, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) 
       DO UPDATE SET phone = EXCLUDED.phone`,
      [userId, tenantId, userId, phone]
    );

    // Ensure they are opted-in for SMS preferences as well
    await dbPool.query(
      `INSERT INTO user_preferences (user_id, channel, opted_in, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, channel)
       DO UPDATE SET opted_in = true, updated_at = NOW()`,
      [userId, 'sms', true]
    );

    // Evict Redis Cache
    const redisKey = KEYS.preference(userId);
    await redisClient.del(redisKey);

    logger.info('Successfully registered user phone number in PostgreSQL & evicted cache', { userId, phone });
    return res.status(200).json({
      status: 'SUCCESS',
      message: 'User phone number registered and opted-in successfully.',
      userId,
      phone
    });
  } catch (error) {
    logger.error('Error saving user phone', {
      userId,
      tenantId,
      error: error.message
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to save phone number.'
    });
  }
});

// ==============================================================================
// TEMPLATES MANAGEMENT ROUTES
// ==============================================================================

/**
 * POST /v1/templates
 * Creates or updates a message template under B2B tenant boundaries.
 * Invalidates specific event-channel templates cache.
 */
app.post('/v1/templates', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!redisClient || !dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database/Cache connections are offline. Please try again shortly.'
    });
  }

  const validation = validateCreateTemplate(req.body);
  if (!validation.success) {
    logger.warn('Failed validation for template registration', { errors: validation.error.errors });
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid template payload structure',
      details: validation.error.errors
    });
  }

  const { eventType, channel, subjectTemplate, bodyTemplate } = validation.data;
  const redisKey = KEYS.template(tenantId, eventType, channel);

  try {
    // Upsert into relational templates mapping
    const query = `
      INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (tenant_id, event_type, channel)
      DO UPDATE SET 
        subject_template = EXCLUDED.subject_template,
        body_template = EXCLUDED.body_template,
        created_at = NOW()
      RETURNING id
    `;
    const result = await dbPool.query(query, [
      tenantId,
      eventType,
      channel,
      subjectTemplate || null,
      bodyTemplate
    ]);

    // Force strong cache eviction
    await redisClient.del(redisKey);
    logger.info('Notification template registered and cache evicted', { 
      templateId: result.rows[0].id, 
      tenantId, 
      eventType, 
      channel 
    });

    return res.status(201).json({
      status: 'SUCCESS',
      message: 'Template successfully created/updated.',
      templateId: result.rows[0].id,
      tenantId,
      eventType,
      channel
    });

  } catch (error) {
    logger.error('Error persisting notification template', {
      tenantId,
      eventType,
      channel,
      error: error.message
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to record notification template.'
    });
  }
});

/**
 * GET /v1/templates/:eventType
 * Returns a dictionary of all channel templates configured for this eventType.
 * (Primarily used for portal inspection or bulk operations).
 */
app.get('/v1/templates/:eventType', async (req, res) => {
  const { eventType } = req.params;
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database connection is offline.'
    });
  }

  try {
    const query = `
      SELECT id, channel, subject_template, body_template, created_at
      FROM notification_templates
      WHERE tenant_id = $1 AND event_type = $2
    `;
    const result = await dbPool.query(query, [tenantId, eventType]);

    if (result.rows.length === 0) {
      logger.warn('No templates found for event type', { tenantId, eventType });
      return res.status(404).json({
        error: 'NotFoundError',
        message: `No templates are registered for event type '${eventType}' under this tenant.`
      });
    }

    const templates = {};
    result.rows.forEach(row => {
      templates[row.channel] = {
        templateId: row.id,
        subjectTemplate: row.subject_template,
        bodyTemplate: row.body_template,
        createdAt: row.created_at
      };
    });

    return res.status(200).json({
      tenantId,
      eventType,
      templates
    });

  } catch (error) {
    logger.error('Error fetching event templates', {
      tenantId,
      eventType,
      error: error.message
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to fetch templates.'
    });
  }
});

/**
 * GET /v1/templates/:eventType/:channel
 * Returns a single targeted channel template. Used directly by workers.
 * Employs a robust Redis Cache-Aside strategy.
 */
app.get('/v1/templates/:eventType/:channel', async (req, res) => {
  const { eventType, channel } = req.params;
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing B2B Tenant Identity header x-tenant-id'
    });
  }

  if (!redisClient || !dbPool) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Database/Cache connections are offline.'
    });
  }

  const redisKey = KEYS.template(tenantId, eventType, channel);

  try {
    // 1. Read Cache
    const cachedTemplate = await redisClient.get(redisKey);
    if (cachedTemplate) {
      logger.info('Notification template cache HIT', { tenantId, eventType, channel });
      return res.status(200).json(JSON.parse(cachedTemplate));
    }

    logger.info('Notification template cache MISS. Querying PostgreSQL...', { tenantId, eventType, channel });

    // 2. Query database
    const query = `
      SELECT id, subject_template, body_template, created_at
      FROM notification_templates
      WHERE tenant_id = $1 AND event_type = $2 AND channel = $3
    `;
    const result = await dbPool.query(query, [tenantId, eventType, channel]);

    if (result.rows.length === 0) {
      logger.warn('Target template not registered', { tenantId, eventType, channel });
      return res.status(404).json({
        error: 'NotFoundError',
        message: `Template for channel '${channel}' and event type '${eventType}' does not exist.`
      });
    }

    const row = result.rows[0];
    const templatePayload = {
      templateId: row.id,
      tenantId,
      eventType,
      channel,
      subjectTemplate: row.subject_template,
      bodyTemplate: row.body_template,
      createdAt: row.created_at
    };

    // 3. Cache inside Redis with 5-minute TTL
    await redisClient.set(redisKey, JSON.stringify(templatePayload), 'EX', 300);
    logger.debug('Notification template cached successfully', { tenantId, eventType, channel });

    return res.status(200).json(templatePayload);

  } catch (error) {
    logger.error('Error fetching specific template', {
      tenantId,
      eventType,
      channel,
      error: error.message
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to retrieve target template.'
    });
  }
});

// ==============================================================================
// SERVER BOOTSTRAP & SHUTDOWN LIFECYCLES
// ==============================================================================

let server = null;
let redisClient = null;
let dbPool = null;

async function bootstrap() {
  try {
    logger.info('Starting Preference & Template Service boot sequence...');

    // 1. Establish connection to Redis
    redisClient = getRedisClient();
    await redisClient.ping();
    logger.info('Redis connection verified successfully.');

    // 2. Establish connection to PostgreSQL
    dbPool = getDbPool();
    const dbTimeResult = await dbPool.query('SELECT NOW()');
    logger.info('PostgreSQL connection verified successfully.', {
      dbServerTime: dbTimeResult.rows[0].now
    });

    // 3. Bind port and start Express listener
    server = app.listen(PORT, () => {
      logger.info('Preference & Template Service fully booted and listening', {
        port: PORT,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development'
      });
    });

  } catch (error) {
    logger.error('Critical boot sequence failure for Preference & Template Service. Terminating.', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

const shutdown = async (signal) => {
  logger.info(`Received ${signal}. Launching Preference & Template Service graceful shutdown...`);

  if (server) {
    logger.info('Closing HTTP server socket...');
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server socket closed.');
  }

  if (redisClient) {
    logger.info('Closing Redis connection socket...');
    try {
      await redisClient.quit();
      logger.info('Redis connection socket disconnected cleanly.');
    } catch (err) {
      logger.error('Error disconnecting Redis client during shutdown', { error: err.message });
    }
  }

  if (dbPool) {
    logger.info('Closing PostgreSQL connection pool...');
    try {
      await dbPool.end();
      logger.info('PostgreSQL connection pool closed cleanly.');
    } catch (err) {
      logger.error('Error closing PostgreSQL database pool during shutdown', { error: err.message });
    }
  }

  logger.info('Graceful shutdown completed. Process exiting.');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap();

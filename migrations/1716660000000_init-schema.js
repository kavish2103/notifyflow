/**
 * baseline migration schema for NotifyFlow.
 * Sets up relational configurations and high-throughput transactional logging.
 */

exports.up = (pgm) => {
  // 1. Tenants Table
  pgm.sql(`
    CREATE TABLE tenants (
      id VARCHAR(50) PRIMARY KEY, -- Enforces 'tenant-<uuid-v4>' format
      name VARCHAR(255) NOT NULL,
      api_key_hash VARCHAR(255) NOT NULL UNIQUE,
      rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Users Table
  pgm.sql(`
    CREATE TABLE users (
      id VARCHAR(50) PRIMARY KEY, -- Enforces 'user-<id>' or 'user-<uuid>' format
      tenant_id VARCHAR(50) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      external_user_id VARCHAR(255) NOT NULL, -- The B2B client's internal system ID
      email VARCHAR(255),
      phone VARCHAR(50),
      push_token TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, external_user_id) -- A user must be unique per tenant scope
    );
  `);

  // 3. User Preferences Table
  pgm.sql(`
    CREATE TABLE user_preferences (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel VARCHAR(50) NOT NULL, -- 'email', 'sms', 'push'
      opted_in BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, channel) -- Ensure only one preference preference entry per user-channel
    );
  `);

  // 4. Notification Templates Table
  pgm.sql(`
    CREATE TABLE notification_templates (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(50) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      event_type VARCHAR(100) NOT NULL, -- e.g., 'payment.failed'
      channel VARCHAR(50) NOT NULL, -- 'email', 'sms', 'push'
      subject_template VARCHAR(255), -- Optional subject (only relevant for email)
      body_template TEXT NOT NULL, -- Handlebars formatted body
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, event_type, channel) -- Guarantee only one rendering template per type/channel/tenant
    );
  `);

  // 5. Delivery Logs Table
  // High-throughput transactional data: Loosely coupled without hard FKs to optimize write latency
  pgm.sql(`
    CREATE TABLE delivery_logs (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(50) NOT NULL,
      tenant_id VARCHAR(50) NOT NULL,
      user_id VARCHAR(50) NOT NULL,
      channel VARCHAR(50) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL, -- 'delivered', 'failed', 'skipped'
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Indexes on Delivery Logs for analytics and fast portal search lookups
  pgm.sql(`
    CREATE INDEX idx_delivery_logs_event_id ON delivery_logs(event_id);
    CREATE INDEX idx_delivery_logs_user_id ON delivery_logs(user_id);
    CREATE INDEX idx_delivery_logs_tenant_created ON delivery_logs(tenant_id, created_at DESC);
  `);

  // 6. Dead Letter Events Table
  // Holds permanently failed notifications that require human inspection or manual replay
  pgm.sql(`
    CREATE TABLE dead_letter_events (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(50) NOT NULL UNIQUE,
      tenant_id VARCHAR(50) NOT NULL,
      channel VARCHAR(50) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL, -- Retain full event payload to support message re-driving
      failure_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_attempted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

exports.down = (pgm) => {
  // Tear down all tables and indexes in safe order
  pgm.sql('DROP TABLE IF EXISTS dead_letter_events;');
  pgm.sql('DROP TABLE IF EXISTS delivery_logs;');
  pgm.sql('DROP TABLE IF EXISTS notification_templates;');
  pgm.sql('DROP TABLE IF EXISTS user_preferences;');
  pgm.sql('DROP TABLE IF EXISTS users;');
  pgm.sql('DROP TABLE IF EXISTS tenants;');
};

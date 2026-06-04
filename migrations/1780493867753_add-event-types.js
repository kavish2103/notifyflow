/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE event_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id VARCHAR(50) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      event_type VARCHAR(100) NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, event_type)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS event_types;
  `);
};

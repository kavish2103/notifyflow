require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: DATABASE_URL is not defined in .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function seedProd() {
  try {
    console.log('Seeding production/Render PostgreSQL database with demo B2B data...');

    // 1. Fixed plain text API Key for demo
    const plaintextApiKey = 'demo-api-key-notifyflow-2024';
    const apiKeyHash = crypto.createHash('sha256').update(plaintextApiKey).digest('hex');

    const tenantId = 'tenant-a1b2c3d4-e5f6-4890-abcd-ef1234567890';
    const tenantName = 'NotifyFlow Demo';
    const rateLimit = 120; // 120 requests/min

    // Upsert B2B Tenant
    await pool.query(
      `INSERT INTO tenants (id, name, api_key_hash, rate_limit_per_minute) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (api_key_hash) DO UPDATE SET name = $2, rate_limit_per_minute = $4`,
      [tenantId, tenantName, apiKeyHash, rateLimit]
    );
    console.log('Tenant upserted successfully.');

    // 2. Demo User
    const userId = 'user-cust-demo-001';
    const externalUserId = 'demo-user-001';
    const email = 'kvsinghal2103@gmail.com';
    const phone = '+917790000000'; // Default fallback phone

    await pool.query(
      `INSERT INTO users (id, tenant_id, external_user_id, email, phone, push_token)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (tenant_id, external_user_id) DO UPDATE SET email = $4, phone = $5`,
      [userId, tenantId, externalUserId, email, phone]
    );
    console.log('Demo user upserted successfully.');

    // 3. User Preferences (opt-in for all 3 channels)
    const channels = ['email', 'sms', 'push'];
    for (const channel of channels) {
      await pool.query(
        `INSERT INTO user_preferences (user_id, channel, opted_in)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, channel) DO UPDATE SET opted_in = TRUE`,
        [userId, channel]
      );
    }
    console.log('User preferences upserted successfully (opted-in for all channels).');

    // 4. Register Event Types and Templates in Catalog
    const eventTypes = [
      {
        type: 'payment.failed',
        desc: 'Triggered when a subscription or transactional invoice payment fails.',
        templates: {
          email: {
            subject: 'Urgent: Payment Failed for Invoice',
            body: 'Hi {{name}}, payment of {{amount}} {{currency}} for your account has failed. Please update your billing details.'
          },
          sms: {
            body: 'Hi {{name}}, payment of {{amount}} {{currency}} failed. Please check your email details.'
          },
          push: {
            body: 'Invoice payment failed. Click to update your billing details.'
          }
        }
      },
      {
        type: 'payment.success',
        desc: 'Triggered when a subscription or transactional invoice payment completes successfully.',
        templates: {
          email: {
            subject: 'Receipt: Payment Successful',
            body: 'Hi {{name}}, payment of {{amount}} {{currency}} was successful! Thank you for your business.'
          },
          sms: {
            body: 'Hi {{name}}, payment of {{amount}} {{currency}} was successful. Thank you!'
          },
          push: {
            body: 'Payment successful! Thank you for using NotifyFlow.'
          }
        }
      },
      {
        type: 'user.registered',
        desc: 'Triggered when a new user completes signup onboarding.',
        templates: {
          email: {
            subject: 'Welcome to NotifyFlow!',
            body: 'Hi {{name}}, welcome to NotifyFlow! We are excited to help you automate notifications.'
          },
          sms: {
            body: 'Welcome to NotifyFlow, {{name}}! Your account setup is complete.'
          },
          push: {
            body: 'Welcome to NotifyFlow! Let\'s construct your first channel template.'
          }
        }
      },
      {
        type: 'order.shipped',
        desc: 'Triggered when a fulfillment order leaves the distribution center.',
        templates: {
          email: {
            subject: 'Order Shipped!',
            body: 'Hi {{name}}, order {{orderId}} is on its way! Track delivery details at {{trackingUrl}}.'
          },
          sms: {
            body: 'Hi {{name}}, order {{orderId}} shipped! Track it at {{trackingUrl}}.'
          },
          push: {
            body: 'Your package is on its way! Order {{orderId}} has been shipped.'
          }
        }
      }
    ];

    for (const et of eventTypes) {
      // Upsert Event Type Catalog entry
      await pool.query(
        `INSERT INTO event_types (tenant_id, event_type, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, event_type) DO UPDATE SET description = $3`,
        [tenantId, et.type, et.desc]
      );

      // Upsert Notification Templates for each channel
      for (const [channel, tpl] of Object.entries(et.templates)) {
        await pool.query(
          `INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, event_type, channel) DO UPDATE SET subject_template = $4, body_template = $5`,
          [tenantId, et.type, channel, tpl.subject || null, tpl.body]
        );
      }
    }
    console.log('Event types and templates catalog populated successfully.');

    console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('=== PRODUCTION DEMO SEED COMPLETED SUCCESSFULLY ===');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log(`Demo API Key:  \x1b[36m${plaintextApiKey}\x1b[0m`);
    console.log(`Demo Tenant ID: ${tenantId}`);
    console.log(`Demo User ID:   ${userId} (externalUserId: ${externalUserId})`);
    console.log('Use the API key to connect to the live dashboard at vercel!\n');

    await pool.end();
  } catch (error) {
    console.error('\x1b[31mProduction seeding failed:\x1b[0m', error.message);
    await pool.end();
    process.exit(1);
  }
}

seedProd();

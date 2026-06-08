module.exports = {
  apps: [
    {
      name: 'api-gateway',
      script: 'services/api-gateway/index.js',
      error_file: './logs/api-gateway-error.log',
      out_file: './logs/api-gateway-out.log',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        GATEWAY_PORT: 3000,
        INGESTION_SERVICE_URL: 'http://localhost:3001',
        PREFERENCE_SERVICE_URL: 'http://localhost:3003',
        ANALYTICS_SERVICE_URL: 'http://localhost:3004',
        ...process.env
      }
    },
    {
      name: 'event-ingestion',
      script: 'services/event-ingestion/index.js',
      error_file: './logs/event-ingestion-error.log',
      out_file: './logs/event-ingestion-out.log',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        INGESTION_PORT: 3001,
        ...process.env
      }
    },
    {
      name: 'preference-template',
      script: 'services/preference-template/index.js',
      error_file: './logs/preference-template-error.log',
      out_file: './logs/preference-template-out.log',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PREFERENCE_PORT: 3003,
        ...process.env
      }
    },
    {
      name: 'analytics-consumer',
      script: 'services/analytics-consumer/index.js',
      error_file: './logs/analytics-consumer-error.log',
      out_file: './logs/analytics-consumer-out.log',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        ANALYTICS_PORT: 3004,
        ...process.env
      }
    }
  ]
};

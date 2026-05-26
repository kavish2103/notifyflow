const { spawn } = require('child_process');
const path = require('path');

// Load environment variables from the .env file at the root
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('\x1b[31mError: DATABASE_URL is not defined in your .env file.\x1b[0m');
  process.exit(1);
}

// Determine if we are doing a migration (up) or a rollback (down)
// Defaults to 'up' unless the user passes 'down'
const direction = process.argv[2] === 'down' ? 'down' : 'up';

console.log(`\x1b[36mInitializing PostgreSQL migrations in direction: [${direction.toUpperCase()}]...\x1b[0m`);

// Spawn node-pg-migrate as a cross-platform command
// Windows requires shell: true to execute .cmd/.bat files like 'npx'
const migrateProcess = spawn('npx', ['node-pg-migrate', direction], {
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl
  },
  shell: true,
  stdio: 'inherit' // Automatically forwards stdout and stderr directly to the terminal
});

migrateProcess.on('close', (code) => {
  if (code === 0) {
    console.log(`\x1b[32mPostgreSQL migrations [${direction.toUpperCase()}] completed successfully!\x1b[0m`);
  } else {
    console.error(`\x1b[31mPostgreSQL migrations failed with exit code: ${code}\x1b[0m`);
  }
  process.exit(code);
});

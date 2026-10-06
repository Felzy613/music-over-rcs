import { existsSync } from 'node:fs';

// Import this first in an entry point. Unlike Node's --env-file-if-exists it stays quiet when .env is missing.
// Variables already set in the environment win over the file.
if (existsSync('.env')) process.loadEnvFile('.env');

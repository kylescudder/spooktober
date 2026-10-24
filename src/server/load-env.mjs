import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

// Runtime configuration wins; private .env files are never bundled.
if (existsSync('.env')) loadEnvFile('.env')

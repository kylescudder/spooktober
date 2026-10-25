import pg from 'pg'
import { databaseConfig } from './database.ts'

// Runtime role budget: app 4 + health 1 + deployment 1, out of 8 connections.
// Deployment CLI commands are sequential and need only one connection.
export function createDeploymentDatabase(url: string | undefined) {
  const pool = new pg.Pool({ ...databaseConfig(url), max: 1 })
  pool.on('error', () => console.error('Deployment database connection lost.'))
  return pool
}

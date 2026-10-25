import { createDatabase } from './database.ts'

// Runtime role budget: app 4 + health 1 + deployment 1, out of 8 connections.
// Deployment CLI commands are sequential and need only one connection.
export function createDeploymentDatabase(url: string | undefined) {
  return createDatabase(url, 1)
}

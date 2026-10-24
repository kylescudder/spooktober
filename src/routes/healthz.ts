import { createFileRoute } from '@tanstack/react-router'
import { healthResponse } from '../server/health'

export const Route = createFileRoute('/healthz')({
  server: { handlers: { GET: () => healthResponse() } }
})

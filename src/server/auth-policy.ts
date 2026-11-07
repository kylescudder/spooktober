// Better Auth access: a verified email that is still in AUTH_ALLOWED_EMAILS.
// Removing an address revokes access on the next request, even with a session.
export function isVerifiedAllowedUser(
  user: { email: string; emailVerified: boolean } | null | undefined,
  allowedEmails: readonly string[]
) {
  return (
    !!user?.emailVerified &&
    allowedEmails.includes(user.email.trim().toLowerCase())
  )
}

export function isAllowedEmail(
  email: string,
  allowedEmails: readonly string[]
) {
  return allowedEmails.includes(email.trim().toLowerCase())
}

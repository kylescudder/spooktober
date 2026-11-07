const nameField = (name: 'givenName' | 'familyName', label: string) => ({
  name,
  type: 'string' as const,
  label,
  defaultValue: '',
  validateDebounceMs: 0,
  validate: (value: unknown) => {
    if (typeof value === 'string' && value.length > 100)
      throw new Error('Use up to 100 characters.')
  }
})

// Optional first/last names plus the read-only verified email. The server's
// update-user guard accepts the name fields only.
export const profileFields = [
  nameField('givenName', 'First name'),
  nameField('familyName', 'Last name'),
  {
    name: 'email',
    type: 'string' as const,
    label: 'Verified email',
    readOnly: true,
    copyable: true
  }
]

// No profile photos: Spooktober has no private storage for them, and the
// server refuses image changes.
export const profileAvatar = { enabled: false }

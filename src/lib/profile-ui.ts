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

const photoTypes = ['image/jpeg', 'image/png', 'image/webp']

// Square-crop and shrink in the browser first, so phone photos upload quickly.
// The server still validates and re-encodes whatever arrives.
export async function prepareAvatar(file: File) {
  if (!photoTypes.includes(file.type))
    throw new Error('Choose a JPEG, PNG or WebP photo.')
  if (file.size > 10 * 1024 * 1024)
    throw new Error('Choose a photo smaller than 10 MB.')
  const image = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Your browser could not prepare this photo.')
    const side = Math.min(image.width, image.height)
    context.drawImage(
      image,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      0,
      0,
      512,
      512
    )
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error('This photo could not be prepared.')),
        'image/jpeg',
        0.85
      )
    )
  } finally {
    image.close()
  }
}

async function avatarRequest(init: RequestInit) {
  const response = await fetch('/api/profile/avatar', init)
  const body = (await response.json().catch(() => ({}))) as {
    image?: string | null
    error?: string
  }
  if (!response.ok)
    throw new Error(body.error ?? 'Unable to update your profile photo.')
  return body
}

// The photo is stored privately in Spooktober's own database. The UI then
// confirms the returned server-owned URL through update-user.
export const profileAvatar = {
  enabled: true,
  size: 512,
  extension: 'jpg' as const,
  resize: async (file: File) =>
    new File([await prepareAvatar(file)], 'avatar.jpg', { type: 'image/jpeg' }),
  upload: async (file: File) => {
    const { image } = await avatarRequest({
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: file
    })
    if (!image) throw new Error('The photo could not be uploaded.')
    return image
  },
  delete: async () => {
    await avatarRequest({ method: 'DELETE' })
  }
}

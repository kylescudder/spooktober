import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

// A disposable WebAuthn authenticator for protocol-level integration tests.
// Keys exist only in test memory; no test credential reaches production.
export function virtualAuthenticator(origin: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32)
  const id = credentialId.toString('base64url')
  const coseKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))]
    ])
  )
  function authenticatorData(
    flags: number,
    counter: number,
    hostname = new URL(origin).hostname
  ) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(counter)
    return Buffer.concat([
      createHash('sha256').update(hostname).digest(),
      Buffer.from([flags]),
      count
    ])
  }
  return {
    id,
    registration(challenge: string) {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(credentialId.length)
      const authData = Buffer.concat([
        authenticatorData(0x45, 0),
        Buffer.alloc(16),
        length,
        credentialId,
        Buffer.from(coseKey)
      ])
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge,
          origin,
          crossOrigin: false
        })
      )
      const attestationObject = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, never>>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, never>()],
          ['authData', new Uint8Array(authData)]
        ])
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          attestationObject:
            Buffer.from(attestationObject).toString('base64url'),
          transports: ['internal']
        },
        clientExtensionResults: { credProps: { rk: true } }
      }
    },
    assertion(
      challenge: string,
      userId: string,
      options: {
        origin?: string
        hostname?: string
        verified?: boolean
        counter?: number
      } = {}
    ) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge,
          origin: options.origin ?? origin,
          crossOrigin: false
        })
      )
      const authData = authenticatorData(
        options.verified === false ? 0x01 : 0x05,
        options.counter ?? 1,
        options.hostname
      )
      const signature = sign(
        'sha256',
        Buffer.concat([
          authData,
          createHash('sha256').update(clientDataJSON).digest()
        ]),
        privateKey
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle: Buffer.from(userId).toString('base64url')
        },
        clientExtensionResults: {}
      }
    }
  }
}

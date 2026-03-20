import type { Request as ExpressReq } from 'express'

const STUDIO_PORT = process.env.STUDIO_PORT ?? '18488'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

/** Log a successful payment with a link to Surfpool Studio. */
export function logPayment(path: string, response: Response) {
  const receipt = response.headers.get('Payment-Receipt')
  if (!receipt) return

  try {
    const json = JSON.parse(
      Buffer.from(receipt, 'base64url').toString(),
    ) as { reference?: string }
    if (json.reference) {
      const url = `http://localhost:${STUDIO_PORT}/?t=${json.reference}`
      console.log(`  ${green('✓')} ${path}  ${dim('tx:')} ${cyan(url)}`)
    }
  } catch {
    // Receipt format may vary — ignore parse errors.
  }
}

/** Convert an Express request to a Web API Request for mppx. */
export function toWebRequest(req: ExpressReq): globalThis.Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value[0] : value)
  }
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  const init: RequestInit = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = JSON.stringify(req.body)
  }
  return new globalThis.Request(url, init)
}

import type { Endpoint } from './types.js'

export const ENDPOINTS: Endpoint[] = [
  {
    method: 'GET',
    path: '/api/v1/stocks/quote/:symbol',
    description: 'Real-time stock quote',
    cost: '0.01 USDC',
    params: [{ name: 'symbol', default: 'AAPL' }],
  },
  {
    method: 'GET',
    path: '/api/v1/stocks/search',
    description: 'Search stocks by name',
    cost: '0.01 USDC',
    params: [{ name: 'q', default: 'Apple' }],
  },
  {
    method: 'GET',
    path: '/api/v1/stocks/history/:symbol',
    description: 'Historical price data',
    cost: '0.05 USDC',
    params: [
      { name: 'symbol', default: 'AAPL' },
      { name: 'range', default: '1mo' },
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/weather/:city',
    description: 'City weather data',
    cost: '0.01 USDC',
    params: [{ name: 'city', default: 'san-francisco' }],
  },
  {
    method: 'GET',
    path: '/api/v1/marketplace/buy/:productId',
    description: 'Marketplace purchase (splits)',
    cost: '~2.14 USDC',
    params: [
      { name: 'productId', default: 'sol-hoodie' },
      { name: 'referrer', default: '' },
    ],
  },
]

/** Build a URL from an endpoint and parameter values. */
export function buildUrl(endpoint: Endpoint, paramValues: Record<string, string>): string {
  let url = endpoint.path
  const queryParams: string[] = []

  for (const param of endpoint.params ?? []) {
    const value = paramValues[param.name] || param.default
    if (url.includes(`:${param.name}`)) {
      url = url.replace(`:${param.name}`, encodeURIComponent(value))
    } else {
      queryParams.push(`${param.name}=${encodeURIComponent(value)}`)
    }
  }

  if (queryParams.length) url += `?${queryParams.join('&')}`
  return url
}

/** Generate a code snippet for a given endpoint. */
export function buildSnippet(endpoint: Endpoint, paramValues: Record<string, string>): string {
  const url = buildUrl(endpoint, paramValues)
  return `import { Mppx, solana } from '@solana/mpp/client'

const method = solana.charge({
  signer,   // TransactionSigner from @solana/kit
  rpcUrl: 'https://api.devnet.solana.com',
})

const mppx = Mppx.create({ methods: [method] })

const response = await mppx.fetch('${url}')
const data = await response.json()
console.log(data)`
}

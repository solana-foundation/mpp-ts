import { useCallback, useEffect, useRef, useState } from 'react'
import WalletSetup from './components/WalletSetup.js'
import WalletModal from './components/WalletModal.js'
import CodeBlock from './components/CodeBlock.js'
import { useWindowWidth } from './hooks.js'
import { SWIG_ENDPOINTS, buildSwigSnippet, buildSwigUrl } from './swigEndpoints.js'
import {
  getSwigSnapshot,
  initializeSwigWallet,
  payAndFetchSwigSession,
  resetSwigDemoState,
  type SwigStep,
} from './swigWallet.js'
import {
  getBalances,
  loadSecretKey,
  requestAirdrop,
  type Balances,
} from './wallet.js'
import type { Kind, LogLine } from './types.js'

export default function SwigPlayground() {
  const width = useWindowWidth()
  const compact = width < 980

  const [ready, setReady] = useState(!!loadSecretKey())
  const [showWallet, setShowWallet] = useState(false)
  const [balances, setBalances] = useState<Balances | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [logs, setLogs] = useState<LogLine[]>([])
  const [running, setRunning] = useState(false)
  const [initializing, setInitializing] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [airdropping, setAirdropping] = useState(false)
  const [requestCount, setRequestCount] = useState(0)
  const [snapshot, setSnapshot] = useState(getSwigSnapshot())

  const logRef = useRef<HTMLDivElement>(null)
  const logId = useRef(0)

  const endpoint = SWIG_ENDPOINTS[selectedIdx]

  const refresh = useCallback(async () => {
    try {
      setBalances(await getBalances())
    } catch {
      setBalances(null)
    }
    setSnapshot(getSwigSnapshot())
  }, [])

  useEffect(() => {
    if (ready) {
      refresh()
    }
  }, [ready, refresh])

  const addLog = useCallback((text: string, kind: Kind) => {
    setLogs((prev: LogLine[]) => [...prev, { id: logId.current++, text, kind }])
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 10)
  }, [])

  const consumeStep = useCallback(
    (step: SwigStep) => {
      switch (step.type) {
        case 'request':
          addLog(`GET ${step.url}`, 'req')
          return
        case 'setup':
          addLog(step.message, 'dim')
          return
        case 'challenge':
          addLog(
            `402 Session challenge (${step.network}) for ${shortAddress(step.recipient)}`,
            '402',
          )
          return
        case 'opening':
          addLog(`Opening channel ${step.channelId}`, 'info')
          return
        case 'opened':
          addLog(`Opened channel ${step.channelId}`, 'ok')
          return
        case 'updating':
          addLog(
            `Updating ${step.channelId} -> cumulative ${step.cumulativeAmount}`,
            'info',
          )
          return
        case 'updated':
          addLog(
            `Updated ${step.channelId} -> cumulative ${step.cumulativeAmount}`,
            'ok',
          )
          return
        case 'closing':
          addLog(`Closing channel ${step.channelId}`, 'info')
          return
        case 'closed':
          addLog(`Closed channel ${step.channelId}`, 'ok')
          return
        case 'success': {
          addLog(`${step.status} OK`, 'ok')
          if (step.receipt) {
            addLog(`Payment-Receipt: ${step.receipt.slice(0, 80)}...`, 'dim')
          }
          addLog(JSON.stringify(step.data, null, 2).slice(0, 600), 'dim')
          return
        }
        case 'error':
          addLog(`Error: ${step.message}`, 'error')
          return
      }
    },
    [addLog],
  )

  const runSessionCall = useCallback(
    async (options?: { context?: Record<string, unknown> }) => {
      const url = buildSwigUrl(endpoint, paramValues)
      setRunning(true)

      for await (const step of payAndFetchSwigSession(url, options)) {
        consumeStep(step)
      }

      setRunning(false)
      setRequestCount((n: number) => n + 1)
      await refresh()
    },
    [consumeStep, endpoint, paramValues, refresh],
  )

  const handleInitialize = useCallback(async () => {
    setInitializing(true)
    try {
      const next = await initializeSwigWallet()
      setSnapshot(next)
      addLog(
        `Swig wallet initialized at ${shortAddress(next.swigAddress ?? null)}`,
        'ok',
      )
    } catch (err: any) {
      addLog(`Swig init failed: ${err?.message ?? String(err)}`, 'error')
    } finally {
      setInitializing(false)
    }
  }, [addLog])

  if (!ready) {
    return (
      <WalletSetup
        onReady={() => {
          setReady(true)
          refresh()
        }}
      />
    )
  }

  const kindColor: Record<Kind, string> = {
    req: '#9945FF',
    '402': '#FFD700',
    ok: '#14F195',
    error: '#f88',
    info: '#4FC3F7',
    dim: '#666',
  }

  return (
    <div style={{ ...s.layout, ...(compact ? s.layoutCompact : {}) }}>
      <aside style={{ ...s.sidebar, ...(compact ? s.sidebarCompact : {}) }}>
        <div style={s.sidebarHeader}>
          <div>
            <div style={s.title}>Swig Session Demo</div>
            <div style={s.sub}>On-chain role enforced API access</div>
          </div>
          <button style={s.walletBtn} onClick={() => setShowWallet(true)}>
            wallet
          </button>
        </div>

        {SWIG_ENDPOINTS.map((entry, index) => (
          <button
            key={entry.path}
            style={{
              ...s.endpointBtn,
              background: index === selectedIdx ? '#1A1A2A' : 'transparent',
              borderColor: index === selectedIdx ? '#9945FF' : '#222',
            }}
            onClick={() => {
              setSelectedIdx(index)
              setParamValues({})
            }}
          >
            <span style={s.endpointMethod}>{entry.method}</span>
            <span style={s.endpointDesc}>{entry.description}</span>
          </button>
        ))}

        <div style={s.sidebarBottom}>
          <div style={s.infoCard}>
            <div style={s.label}>Swig account</div>
            <div style={s.monoLine}>{shortAddress(snapshot.swigAddress)}</div>
            <div style={s.labelSecondary}>Swig vault</div>
            <div style={s.monoLine}>{shortAddress(snapshot.swigWalletAddress)}</div>
            <div style={s.labelSecondary}>Delegated signer</div>
            <div style={s.monoLine}>{shortAddress(snapshot.delegatedSessionSigner)}</div>
            <div style={s.labelSecondary}>Delegated role id</div>
            <div style={s.monoLine}>{snapshot.delegatedSessionRoleId ?? '--'}</div>
            <div style={s.labelSecondary}>Spend limit</div>
            <div style={s.valueAccent}>{snapshot.spendLimitBaseUnits} base units (USDC)</div>
            <div style={s.labelSecondary}>Channel program</div>
            <div style={s.monoLine}>{shortAddress(snapshot.channelProgram)}</div>
            {snapshot.lastChannelId && (
              <>
                <div style={s.labelSecondary}>Last channel</div>
                <div style={s.monoLine}>{shortAddress(snapshot.lastChannelId)}</div>
              </>
            )}
          </div>

          <div style={{ ...s.infoCard, marginTop: 10 }}>
            <div style={s.label}>Client balances</div>
            <div style={s.valueAccent}>
              {balances ? balances.sol.toFixed(4) : '--'} SOL
            </div>
            <div style={s.valueMuted}>{balances ? balances.usdc.toFixed(2) : '--'} USDC</div>
            <button
              style={s.secondaryBtn}
              disabled={airdropping}
              onClick={async () => {
                setAirdropping(true)
                try {
                  await requestAirdrop()
                  addLog('Faucet funded wallet with 100 SOL + 100 USDC', 'ok')
                } catch (err: any) {
                  addLog(`Faucet failed: ${err?.message ?? String(err)}`, 'error')
                } finally {
                  setAirdropping(false)
                  await refresh()
                }
              }}
            >
              {airdropping ? 'Funding...' : 'Fund wallet'}
            </button>
          </div>

          <div style={s.meta}>{requestCount} request{requestCount !== 1 ? 's' : ''}</div>
        </div>
      </aside>

      <main style={s.main}>
        <div style={s.requestPanel}>
          <div style={s.requestHeader}>
            <span style={s.endpointMethod}>{endpoint.method}</span>
            <span style={s.endpointPath}>{endpoint.path}</span>
            <span style={s.endpointCost}>{endpoint.cost}</span>
          </div>

          <div style={s.params}>
            {(endpoint.params ?? []).map((param) => (
              <div key={param.name} style={s.paramRow}>
                <label style={s.paramLabel}>{param.name}</label>
                <input
                  style={s.input}
                  value={paramValues[param.name] ?? param.default}
                  onChange={(event) => {
                    setParamValues((prev) => ({
                      ...prev,
                      [param.name]: event.target.value,
                    }))
                  }}
                />
              </div>
            ))}
          </div>

          <div style={s.actions}>
            <button
              style={s.primaryBtn}
              disabled={running || initializing}
              onClick={handleInitialize}
            >
              {initializing ? 'Initializing...' : 'Initialize Swig'}
            </button>
            <button
              style={s.primaryBtn}
              disabled={running || initializing}
              onClick={async () => {
                await runSessionCall()
              }}
            >
              {running ? 'Running...' : 'Send Session Request'}
            </button>
            <button
              style={s.secondaryBtn}
              disabled={running || initializing}
              onClick={async () => {
                await runSessionCall({ context: { action: 'close' } })
              }}
            >
              Close Session
            </button>
            <button
              style={s.secondaryBtn}
              disabled={running || initializing}
              onClick={() => {
                resetSwigDemoState()
                setSnapshot(getSwigSnapshot())
                addLog('Cleared local Swig session state', 'dim')
              }}
            >
              Reset Swig State
            </button>
            <button
              style={s.codeBtn}
              onClick={() => setShowCode((prev) => !prev)}
            >
              {'</>'}
            </button>
          </div>

          {showCode && (
            <div style={s.codePane}>
              <CodeBlock code={buildSwigSnippet(endpoint, paramValues)} />
            </div>
          )}
        </div>

        <div ref={logRef} style={s.terminal}>
          {logs.length === 0 && (
            <div style={s.emptyLog}>
              Initialize Swig and send a request to observe open and update events.
            </div>
          )}
          {logs.map((line) => (
            <div
              key={line.id}
              style={{
                padding: '2px 16px',
                fontSize: 12,
                color: kindColor[line.kind],
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {line.text}
            </div>
          ))}
        </div>
      </main>

      {showWallet && (
        <WalletModal
          onClose={() => setShowWallet(false)}
          onReset={() => {
            resetSwigDemoState()
            setReady(false)
          }}
        />
      )}
    </div>
  )
}

function shortAddress(value: string | null): string {
  if (!value) {
    return '(not set)'
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

const s: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    minHeight: '100vh',
    background: '#0A0A0A',
  },
  layoutCompact: {
    flexDirection: 'column',
  },
  sidebar: {
    width: 320,
    borderRight: '1px solid #222',
    display: 'flex',
    flexDirection: 'column',
    background: '#0D0D0D',
  },
  sidebarCompact: {
    width: '100%',
    borderRight: 'none',
    borderBottom: '1px solid #222',
  },
  sidebarHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: 16,
    borderBottom: '1px solid #222',
  },
  title: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
  },
  sub: {
    color: '#777',
    fontSize: 11,
    marginTop: 4,
  },
  walletBtn: {
    padding: '4px 10px',
    background: '#14F19522',
    border: '1px solid #14F19544',
    borderRadius: 6,
    color: '#14F195',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    cursor: 'pointer',
  },
  endpointBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    border: '1px solid #222',
    borderWidth: '0 0 1px',
    fontFamily: 'JetBrains Mono, monospace',
    cursor: 'pointer',
    color: '#ddd',
    textAlign: 'left',
  },
  endpointMethod: {
    color: '#14F195',
    fontSize: 10,
    letterSpacing: 0.5,
  },
  endpointDesc: {
    color: '#bbb',
    fontSize: 12,
  },
  sidebarBottom: {
    marginTop: 'auto',
    padding: 12,
    borderTop: '1px solid #222',
  },
  infoCard: {
    padding: 10,
    border: '1px solid #1D1D1D',
    borderRadius: 8,
    background: '#0B0B0B',
  },
  label: {
    color: '#666',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  labelSecondary: {
    color: '#555',
    fontSize: 9,
    marginTop: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  monoLine: {
    color: '#9dc4ff',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    marginTop: 3,
  },
  valueAccent: {
    color: '#14F195',
    fontSize: 12,
    fontWeight: 600,
    marginTop: 3,
  },
  valueMuted: {
    color: '#888',
    fontSize: 12,
    marginTop: 3,
  },
  meta: {
    color: '#555',
    fontSize: 10,
    marginTop: 10,
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  requestPanel: {
    borderBottom: '1px solid #222',
    background: '#0D0D0D',
  },
  requestHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid #1d1d1d',
  },
  endpointPath: {
    color: '#ddd',
    fontSize: 12,
    fontFamily: 'JetBrains Mono, monospace',
  },
  endpointCost: {
    color: '#777',
    fontSize: 11,
    marginLeft: 'auto',
  },
  params: {
    padding: '12px 16px 6px',
  },
  paramRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  paramLabel: {
    color: '#888',
    minWidth: 70,
    fontSize: 12,
    textTransform: 'lowercase',
  },
  input: {
    flex: 1,
    height: 32,
    padding: '0 10px',
    borderRadius: 6,
    border: '1px solid #2a2a2a',
    background: '#111',
    color: '#ddd',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 12,
    outline: 'none',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    padding: '0 16px 12px',
  },
  primaryBtn: {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #9945FF55',
    background: '#9945FF22',
    color: '#eee',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    cursor: 'pointer',
  },
  secondaryBtn: {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #2c2c2c',
    background: '#151515',
    color: '#bbb',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    cursor: 'pointer',
  },
  codeBtn: {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #2c2c2c',
    background: '#111',
    color: '#aaa',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 12,
    cursor: 'pointer',
  },
  codePane: {
    borderTop: '1px solid #1d1d1d',
    background: '#0A0A0A',
    maxHeight: 260,
    overflow: 'auto',
  },
  terminal: {
    flex: 1,
    background: '#060606',
    overflow: 'auto',
    fontFamily: 'JetBrains Mono, monospace',
    padding: '8px 0',
  },
  emptyLog: {
    color: '#444',
    padding: 16,
    fontSize: 12,
  },
}

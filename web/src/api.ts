export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message)
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options
  })
  let json: any
  try {
    json = await res.json()
  } catch {
    throw new ApiError('BAD_RESPONSE', `响应不是合法 JSON (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const e = json?.error ?? {}
    throw new ApiError(e.code ?? 'UNKNOWN', e.message ?? '请求失败', e.details)
  }
  return json as T
}

export const api = {
  config: () => request<import('./types').ServerConfig>('/api/config'),
  createBatch: (body: unknown) =>
    request<{ batch: import('./types').BatchDTO; reused: boolean }>('/api/batches', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  getBatch: (id: string) => request<{ batch: import('./types').BatchDTO }>(`/api/batches/${id}`),
  listBatches: () => request<{ items: import('./types').BatchDTO[] }>('/api/batches'),
  preflight: (id: string, account: string, network: string) =>
    request<{ preflight: import('./types').Preflight }>(`/api/batches/${id}/preflight`, {
      method: 'POST',
      body: JSON.stringify({ account, network })
    }),
  approve: (id: string, account: string, network: string) =>
    request<{ tx: import('./types').TxDTO }>(`/api/batches/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ account, network })
    }),
  transfer: (id: string, account: string, network: string) =>
    request<{ tx: import('./types').TxDTO }>(`/api/batches/${id}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ account, network })
    }),
  recheck: (id: string, type: 'APPROVE' | 'TRANSFER') =>
    request<{ tx: import('./types').TxDTO; batch: import('./types').BatchDTO; reason?: string }>(
      `/api/batches/${id}/recheck`,
      { method: 'POST', body: JSON.stringify({ type }) }
    )
}

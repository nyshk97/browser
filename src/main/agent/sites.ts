import { session } from 'electron'
import { log, logError } from '../log.js'
import { AGENT_PARTITION } from '../paths.js'

/**
 * エージェント用プロファイル（`persist:nemo-agent`）に**ログインが溜まっているサイト**の一覧と消去（計画 Phase 7）。
 *
 * 専用プロファイルでも、引き継ぎでログインしたサイトは永続で残る（Google にログインすれば Gmail にも届く）。
 * 「専用だから安全」を言い過ぎないために、何が残っているかを見せて、サイト単位で消せるようにする。
 *
 * **消去に `clearStorageData({ origin })` は使わない**。その host の host-only cookie しか消えず、
 * `.google.com` のようなドメイン cookie が残ってログインが続いた（実測）。`session.clearData({ origins })` は
 * 登録可能ドメインの単位で消え、`cookies.remove` を cookie ごとにかけるのも効いた（どちらも実測）ので両方かける。
 */

/** 2 階層目がこれで、TLD が 2 文字なら 3 ラベルでひとまとめにする（co.jp / com.au など）。PSL の代わりの近似。 */
const SECOND_LEVEL = new Set([
  'co',
  'ne',
  'or',
  'ac',
  'go',
  'ed',
  'gr',
  'lg',
  'ad',
  'com',
  'net',
  'org',
  'gov',
  'edu'
])

/** cookie のドメイン → まとめる単位（登録可能ドメインの近似）。IP とラベル 1 つの host はそのまま。 */
export function siteKey(domain: string): string {
  const host = domain.replace(/^\./, '').toLowerCase()
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[') || !host.includes('.')) return host
  const labels = host.split('.')
  const tld = labels[labels.length - 1]
  const second = labels[labels.length - 2]
  const count = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2
  return labels.slice(-count).join('.')
}

export interface AgentSite {
  site: string
  cookies: number
}

export async function listAgentSites(): Promise<AgentSite[]> {
  const cookies = await session.fromPartition(AGENT_PARTITION).cookies.get({})
  const counts = new Map<string, number>()
  for (const cookie of cookies) {
    if (!cookie.domain) continue
    const key = siteKey(cookie.domain)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([site, count]) => ({ site, cookies: count }))
    .sort((a, b) => a.site.localeCompare(b.site))
}

export async function clearAgentSite(site: string): Promise<void> {
  const agentSession = session.fromPartition(AGENT_PARTITION)
  const cookies = (await agentSession.cookies.get({})).filter(
    (cookie) => cookie.domain && siteKey(cookie.domain) === site
  )
  const hosts = new Set<string>([site])
  for (const cookie of cookies) {
    const host = (cookie.domain ?? '').replace(/^\./, '')
    if (host) hosts.add(host)
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
    try {
      await agentSession.cookies.remove(url, cookie.name)
    } catch (error) {
      logError('agent.site_cookie_remove_failed', error, {})
    }
  }
  const origins = [...hosts].flatMap((host) => [`https://${host}`, `http://${host}`])
  try {
    await agentSession.clearData({
      origins,
      dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cache', 'fileSystems']
    })
  } catch (error) {
    logError('agent.site_clear_failed', error, {})
  }
  log('agent.site_cleared', { n: cookies.length })
}

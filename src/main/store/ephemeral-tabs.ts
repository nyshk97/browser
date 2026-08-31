import { randomUUID } from 'node:crypto'
import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { log } from '../log.js'
import {
  EPHEMERAL_TABS_VERSION,
  normalizeCustomTitle,
  normalizeDefinitionFaviconUrl,
  normalizeEphemeralTabs,
  normalizeStoredUrl
} from '../../shared/settings-schema.js'
import type { EphemeralTabDef } from '../../shared/types.js'

/**
 * 一時タブ（野良タブ）の**共有定義**（全ウィンドウ共有・永続化）。
 *
 * `pins.ts` と同じ二層構造の 3 つ目: ここにあるのは定義だけで、
 * 開いているタブ実体（ウィンドウごとの WebContents）は registry 側が持つ。
 * ピン留めとの違いは 2 つ:
 * - **URL は実体のナビゲーションに追随する**（「登録 URL に戻る」規則は無い）
 * - **同じ URL の定義を複数許す**（タブは URL の実体なので重複排除しない）
 *
 * 並び順は配列順（追加順・新規は末尾）で、並べ替え API は持たない。
 */

interface EphemeralTabsData {
  tabs: EphemeralTabDef[]
}

let store: JsonStore<EphemeralTabsData> | null = null
const listeners = new Set<() => void>()

/**
 * 書き戻し（ナビゲーション・タイトル・favicon）はページを 1 枚読み込むたびに
 * 数回飛んでくるので、通知はデバウンスで合流させる。
 * ピン定義（ユーザー操作でしか変わらない）と違い、素通しだと全ウィンドウへ
 * `SharedState` 丸ごとが読み込みのたびに数回飛ぶ。
 * 追加・削除（構造の変化）は即時に通知し、保留中の合流も一緒に流す。
 */
const NOTIFY_DEBOUNCE_MS = 150
let notifyTimer: NodeJS.Timeout | null = null

function notifyNow(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  for (const listener of listeners) listener()
}

function notifyCoalesced(): void {
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const listener of listeners) listener()
  }, NOTIFY_DEBOUNCE_MS)
  notifyTimer.unref?.()
}

export function initEphemeralTabs(): void {
  store = new JsonStore<EphemeralTabsData>(
    userDataPath('ephemeral-tabs.json'),
    EPHEMERAL_TABS_VERSION,
    normalizeEphemeralTabs
  )
}

function data(): EphemeralTabsData {
  return store?.get() ?? { tabs: [] }
}

export function onEphemeralTabsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getEphemeralTabs(): EphemeralTabDef[] {
  return data().tabs
}

export function findEphemeralTab(id: string): EphemeralTabDef | null {
  return data().tabs.find((tab) => tab.id === id) ?? null
}

/**
 * 定義を作る（末尾へ追加）。http / https でない URL は**作らない**（null を返す）。
 * `about:blank` や拡張ページはウィンドウローカルのタブのままにする。
 */
export function addEphemeralTab(input: {
  url: string
  title?: string
  customTitle?: string | null
  faviconUrl?: string | null
  lastActiveAt?: number
}): EphemeralTabDef | null {
  // ストア未初期化なら作らない（id だけ返すと、どこにも保存されない定義を指す
  // `ephemeralId` = サイドバーに出ないのに閉じられないタブができる）
  if (!store) return null
  const url = normalizeStoredUrl(input.url)
  if (!url) return null
  const def: EphemeralTabDef = {
    id: randomUUID(),
    url,
    title: input.title?.trim().slice(0, 300) || url,
    customTitle: normalizeCustomTitle(input.customTitle),
    faviconUrl: normalizeDefinitionFaviconUrl(input.faviconUrl),
    lastActiveAt:
      typeof input.lastActiveAt === 'number' && Number.isFinite(input.lastActiveAt) && input.lastActiveAt > 0
        ? Math.min(input.lastActiveAt, Date.now())
        : Date.now()
  }
  store?.set({ tabs: [...data().tabs, def] })
  notifyNow()
  log('ephemeral.added', { id: def.id })
  return def
}

/** 定義を消す（実体の close は registry の `removeEphemeralEverywhere` が担う）。 */
export function removeEphemeralTab(id: string): boolean {
  const current = data().tabs
  const next = current.filter((tab) => tab.id !== id)
  if (next.length === current.length) return false
  store?.set({ tabs: next })
  notifyNow()
  return true
}

/**
 * 実体からの書き戻し（ナビゲーション / タイトル / favicon / 名前変更）。
 * **値が変わったときだけ**書いて通知する（`page-title-updated` はタブを開くたびに何度も飛ぶ）。
 * 複数ウィンドウの実体は最後に触った側が勝つ（乖離は許容する。決定表参照）。
 */
export function updateEphemeralFromTab(
  id: string,
  patch: { url?: string; title?: string; customTitle?: string | null; faviconUrl?: string }
): void {
  const current = data().tabs
  const index = current.findIndex((tab) => tab.id === id)
  const before = current[index]
  if (!before) return

  const next: EphemeralTabDef = { ...before }
  if (patch.url !== undefined) {
    const url = normalizeStoredUrl(patch.url)
    if (url) next.url = url
  }
  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, 300)
    if (title) next.title = title
  }
  if (patch.customTitle !== undefined) next.customTitle = normalizeCustomTitle(patch.customTitle)
  if (patch.faviconUrl !== undefined) {
    const faviconUrl = normalizeDefinitionFaviconUrl(patch.faviconUrl)
    if (faviconUrl) next.faviconUrl = faviconUrl
  }

  if (
    next.url === before.url &&
    next.title === before.title &&
    next.customTitle === before.customTitle &&
    next.faviconUrl === before.faviconUrl
  ) {
    return
  }
  const tabs = [...current]
  tabs[index] = next
  store?.set({ tabs })
  notifyCoalesced()
}

/**
 * `lastActiveAt` を進める（セッション保存のタイミングで registry が実体の値を写す）。
 * UI はこの値を描画に使わないので**通知しない**（サイドバー全体の再描画を選択のたびに起こさない）。
 * 永続化は `JsonStore` のデバウンスに任せる。
 */
export function bumpEphemeralActivity(id: string, lastActiveAt: number): void {
  const current = data().tabs
  const index = current.findIndex((tab) => tab.id === id)
  const before = current[index]
  if (!before || !Number.isFinite(lastActiveAt) || lastActiveAt <= before.lastActiveAt) return
  const tabs = [...current]
  tabs[index] = { ...before, lastActiveAt: Math.min(lastActiveAt, Date.now()) }
  store?.set({ tabs })
}

/** 移行など、確実に書き切りたいときに呼ぶ。 */
export function flushEphemeralTabs(): void {
  store?.saveNow()
}

export function closeEphemeralTabs(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  store?.close()
  store = null
}

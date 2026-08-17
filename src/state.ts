import { createHash } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SolConsultInput, SolIssueState } from './types.ts'

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][\w./\\-]+/giu, '<path>')
    .replace(/\b0x[\da-f]+\b/giu, '<hex>')
    .replace(/\b\d+\b/gu, '<n>')
    .replace(/[^\p{L}\p{N}_<>]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
}

function evidenceAnchors(evidence: readonly string[]): string[] {
  const anchors = evidence.flatMap((item) => {
    const paths = item.match(/(?:[\w.-]+[\\/])+[\w.-]+/gu) ?? []
    const tests = item.match(/(?:test|spec|error|exception|failed|failure)[:\s][^\n]{0,100}/giu) ?? []
    return [...paths, ...tests].map(normalize)
  })
  return [...new Set(anchors)].sort().slice(0, 12)
}

/** Stable, deterministic blocker identity; attempts and wording of the question are intentionally excluded. */
export function issueFingerprint(input: SolConsultInput): string {
  const material = JSON.stringify({
    goal: normalize(input.goal),
    problem: normalize(input.problem),
    anchors: evidenceAnchors(input.evidence),
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 24)
}

function localStart(session: Session): number {
  return session.header.seedLength ?? 0
}

/** Fold plugin-owned durable events. Process-local maps are never authoritative. */
export function restoreIssueStates(session: Session): Map<string, SolIssueState> {
  const states = new Map<string, SolIssueState>()
  const start = localStart(session)
  for (const event of session.events) {
    if (event.seq < start) continue
    if (event.type !== 'reasoning-router/consult-medium' && event.type !== 'reasoning-router/consult-high') continue
    states.set(event.data.fingerprint, { ...event.data.state })
  }
  return states
}

export function hasInitialConsultRecord(session: Session): boolean {
  const start = localStart(session)
  return session.events.some(event => event.seq >= start && event.type === 'reasoning-router/initial-consult')
}

export function hasExhaustedRecord(session: Session, fingerprint: string): boolean {
  const start = localStart(session)
  return session.events.some(event => event.seq >= start
    && event.type === 'reasoning-router/escalation-exhausted'
    && event.data.fingerprint === fingerprint)
}

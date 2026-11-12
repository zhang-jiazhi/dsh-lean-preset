import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const STATUS_TOOL = 'mcp__rea__binary_session'
const MIN_STATUS_CHARS = 6000
const MAX_SUMMARY_CHARS = 8000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const array = value => Array.isArray(value) ? value : []
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))

function statusRecord(result) {
  const candidates = [result.value?.structuredContent, result.value]
  // The canonical value retains the complete MCP text even if spill-policy
  // shortened result.content. Never read a path suggested by upstream text.
  for (const block of array(result.value?.content ?? result.content)) {
    if (block?.type !== 'text') continue
    try { candidates.push(JSON.parse(block.text)) } catch { /* Not a complete JSON record. */ }
  }
  const records = candidates.filter(object).map(record => ({
    record, status: object(record.result) ? record.result : record,
  })).filter(item => typeof item.status.open === 'boolean')
  if (records.length === 0 || records.some(item => !isDeepStrictEqual(item.status, records[0].status))) return undefined
  return records[0]
}

function capabilitySummary(capabilities) {
  if (!Array.isArray(capabilities)) return undefined
  return capabilities.map(item => ({
    provider: pick(item.provider, ['id', 'name', 'version']),
    groups: array(item.groups).length,
    available_groups: array(item.groups).filter(group => group?.available === true).length,
    unavailable_groups: array(item.groups).filter(group => group?.available === false).length,
    details_in_full_result: true,
  }))
}

function toolAvailabilitySummary(availability) {
  if (!object(availability)) return undefined
  const groups = Array.isArray(availability.groups) ? availability.groups : []
  const reasons = new Map()
  let available = 0
  let unavailable = 0
  for (const group of groups) {
    const count = Array.isArray(group.names) ? group.names.length : 0
    if (group.available === true) available += count
    else if (group.available === false) unavailable += count
    if (group.available === false) {
      const key = JSON.stringify([group.reason ?? null, group.remediation ?? null])
      const reason = reasons.get(key) ?? { reason: group.reason ?? null, remediation: group.remediation ?? null, tools: 0 }
      reason.tools += count
      reasons.set(key, reason)
    }
  }
  return {
    client_requirements: availability.client_requirements,
    available_tools: available, unavailable_tools: unavailable,
    unavailable_reasons: [...reasons.values()], details_in_full_result: true,
  }
}

function summarize(status) {
  const summary = pick(status, ['open', 'cleanup_pending', 'path', 'format', 'kind', 'sha256', 'architecture', 'entry_point', 'client_features', 'server_identity'])
  summary.capabilities = capabilitySummary(status.capabilities)
  if (status.analysis_provider_binding !== undefined) summary.analysis_provider_binding = status.analysis_provider_binding === null
    ? null : pick(status.analysis_provider_binding, ['provider', 'selection_source'])
  if (Array.isArray(status.analysis_provider_candidates)) summary.analysis_provider_candidates = status.analysis_provider_candidates.map(candidate => ({
    provider: pick(candidate.provider, ['id', 'name', 'version']), selected: candidate.selected,
    availability: pick(candidate.availability, ['status', 'code', 'reason']),
    target_support: pick(candidate.target_support, ['status', 'code', 'reason']),
    details_in_full_result: true,
  }))
  if (status.analysis_run !== undefined) summary.analysis_run = status.analysis_run === null ? null : {
    ...pick(status.analysis_run, ['run_id']), details_in_full_result: true,
  }
  if (status.analysis_activity !== undefined) summary.analysis_activity = {
    ...pick(status.analysis_activity, ['status']), details_in_full_result: true,
  }
  if (status.provider_operation_health !== undefined) summary.provider_operation_health = status.provider_operation_health === null
    ? null : { details_in_full_result: true }
  summary.tool_availability = toolAvailabilitySummary(status.tool_availability)
  return summary
}

/** Only a successful, complete REA status record is summarized; analysis evidence is untouched. */
export async function projectReaStatus(ctx, exec, toolName, result, fullOutput = false) {
  if (toolName !== STATUS_TOOL || fullOutput || result?.isError === true || !object(result)) return result
  if ([...array(result.content), ...array(result.value?.content)].some(block => block?.type !== 'text')) return result
  // Do not expand an already compact Host preview merely because value is large.
  if (array(result.content).reduce((size, block) => size + (block.text?.length ?? 0), 0) <= MAX_SUMMARY_CHARS) return result
  const found = statusRecord(result)
  if (!found || JSON.stringify(found.record).length < MIN_STATUS_CHARS) return result
  let summary
  try { summary = summarize(found.status) } catch { return result }
  const base = { view: 'REA status summary; not complete evidence', status: summary }
  if (JSON.stringify(base).length > MAX_SUMMARY_CHARS - 1000) return result
  const store = typeof ctx.get === 'function' ? ctx.get('spillStore') : undefined
  const sessionId = exec?.agent?.session?.id
  if (typeof store?.saveText !== 'function' || typeof sessionId !== 'string') return result
  try {
    // Reuse the Host's private/session-scoped storage and existing retention.
    // parsed_result permits paging; original_value preserves the exact MCP data.
    const full = JSON.stringify({
      tool_name: toolName, parsed_result: found.record,
      original_value: result.value ?? null, original_content: result.content ?? [],
    }, null, 2)
    const ref = await store.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName, callId: exec.callId ?? 'gateway-rea-status', label: 'complete REA status' },
      suggestedName: 'rea-status.json', content: full,
    })
    if (typeof ref?.locator !== 'string' || typeof ref.retrievalHint !== 'string' || !Number.isFinite(ref.bytes)) throw new Error('invalid spill reference')
    const text = JSON.stringify({
      ...base,
      full_result: { locator: ref.locator, bytes: ref.bytes, sha256: createHash('sha256').update(full).digest('hex'), retrieval_hint: ref.retrievalHint },
      note: 'Provider/group details are in the complete result. Read that reference before relying on an omitted detail. full_output=true bypasses the LEAN summary; Host spill limits still apply.',
    })
    if (text.length > MAX_SUMMARY_CHARS) return result
    return { ...result, content: [{ type: 'text', text }] }
  } catch (error) {
    return { ...result, content: [...(result.content ?? []), {
      type: 'text', text: `REA status summary unavailable: ${String(error?.message ?? error)}. Original output retained.`,
    }] }
  }
}

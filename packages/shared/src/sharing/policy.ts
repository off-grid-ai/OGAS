// The ambient-sharing decision engine. Pure logic, zero I/O: given a captured
// item, the user's policy, and which destinations are reachable right now, it
// returns exactly what should happen for each destination. The orchestrator
// (per-app) turns those decisions into transport calls or user prompts.
//
// Design rules encoded here (from the sharing spec + the competitor research):
//  - The user is in control: nothing is shared unless a rule says so. The
//    absence of a matching rule means 'off'.
//  - A device-specific rule always wins over the '*' default (most-specific-wins).
//  - 'ask' and 'auto' only act when the destination is reachable; when offline
//    the OfflineBehavior decides between 'queue' and 'skip'. 'off' short-circuits
//    to 'skip' regardless of reachability (never queue what the user disabled).

import type {
  CaptureEvent,
  DestinationState,
  ShareAction,
  ShareDecision,
  ShareMode,
  SharePolicy,
  ShareRule,
} from './types';

/** Wildcard destination id: a rule that applies to every device by default. */
export const ANY_DESTINATION = '*';

/**
 * Resolve the effective mode for a (source, destination) pair. A rule matching
 * the exact destinationId wins; otherwise the '*' rule for the source applies;
 * otherwise the source is 'off' (nothing shared unless the user opted in).
 */
export function resolveMode(
  policy: SharePolicy,
  source: CaptureEvent['source'],
  destinationId: string
): ShareMode {
  const forSource = policy.rules.filter((r) => r.source === source);
  const specific = forSource.find((r) => r.destinationId === destinationId);
  if (specific) return specific.mode;
  const wildcard = forSource.find((r) => r.destinationId === ANY_DESTINATION);
  return wildcard ? wildcard.mode : 'off';
}

/** Map an effective mode + reachability + offline policy to a concrete action. */
function actionFor(
  mode: ShareMode,
  connected: boolean,
  offlineBehavior: SharePolicy['offlineBehavior']
): { action: ShareAction; reason: string } {
  if (mode === 'off') {
    return { action: 'skip', reason: 'source disabled for this destination' };
  }
  if (!connected) {
    return offlineBehavior === 'queue'
      ? { action: 'queue', reason: `destination offline; queued (${mode})` }
      : { action: 'skip', reason: 'destination offline; skip per policy' };
  }
  return mode === 'auto'
    ? { action: 'send', reason: 'auto share to reachable destination' }
    : { action: 'prompt', reason: 'ask before sharing to reachable destination' };
}

/**
 * Decide what to do with one captured item across all candidate destinations.
 * Returns one ShareDecision per destination (including 'skip' ones, so the
 * caller has a complete, auditable picture). Order mirrors `destinations`.
 */
export function decideShares(
  event: CaptureEvent,
  policy: SharePolicy,
  destinations: DestinationState[]
): ShareDecision[] {
  return destinations.map((dest) => {
    const mode = resolveMode(policy, event.source, dest.deviceId);
    const { action, reason } = actionFor(mode, dest.connected, policy.offlineBehavior);
    return { destinationId: dest.deviceId, action, reason };
  });
}

/** True if any destination would receive (now or queued) - cheap gate for callers. */
export function willShareAnywhere(decisions: ShareDecision[]): boolean {
  return decisions.some((d) => d.action !== 'skip');
}

/** A policy with every source 'off' for all devices - the safe default state. */
export function emptyPolicy(offlineBehavior: SharePolicy['offlineBehavior'] = 'skip'): SharePolicy {
  return { rules: [], offlineBehavior };
}

/**
 * Upsert a single rule (source x destination) into a policy, returning a new
 * policy (never mutates). Setting a rule to 'off' keeps it explicit rather than
 * removing it, so a device-specific 'off' can still override a '*' 'auto'.
 */
export function setRule(policy: SharePolicy, rule: ShareRule): SharePolicy {
  const rest = policy.rules.filter(
    (r) => !(r.source === rule.source && r.destinationId === rule.destinationId)
  );
  return { ...policy, rules: [...rest, rule] };
}

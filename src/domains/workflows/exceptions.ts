/** OpenRig workflow-exception-router: class override -> workflow default -> human fallback.
 * Human permission gates and authentication cannot be redirected to an agent.
 */
export type ExceptionClass = 'unmapped_failed' | 'stuck_overdue' | 'human_gate_trip';
export interface ExceptionRouting { default?: 'orchestrator' | 'human_only'; orchestrator_role?: string; classes?: Partial<Record<Exclude<ExceptionClass,'human_gate_trip'>, 'orchestrator' | 'human_only'>> }
export function exceptionTarget(routing: ExceptionRouting | undefined, kind: ExceptionClass, blockedOn?: string | null, hostDefault?: 'orchestrator' | 'human_only'): string | undefined {
  if (kind === 'human_gate_trip' || blockedOn?.startsWith('human:') || blockedOn?.startsWith('auth:')) return;
  const mode = routing?.classes?.[kind] ?? routing?.default ?? hostDefault ?? 'orchestrator';
  return mode === 'orchestrator' ? routing?.orchestrator_role : undefined;
}

import { records, save, read } from "./storage.js";
import { checkGeometry, checkTransition } from "./parity.js";
export function validate() {
  const traces = records("live-traces.jsonl"),
    coverage: Record<string, any> = {},
    errors: string[] = [];
  const failure = read<any>("parity-failure.json", null);
  if (failure?.before && failure?.action && failure?.after)
    traces.push(failure);
  for (const t of traces) {
    const key = String(t.before.mode);
    coverage[key] ??= { geometry: 0, transitions: 0, types: {} };
    const geom = checkGeometry(t.before);
    errors.push(...geom);
    if (!geom.length) coverage[key].geometry++;
    const tr = checkTransition(t.before, t.action, t.after);
    errors.push(...tr.errors);
    if (tr.checked && !tr.errors.length) {
      coverage[key].transitions++;
      coverage[key].types[t.action.type] =
        (coverage[key].types[t.action.type] || 0) + 1;
    }
  }
  const result = {
    passed: traces.length > 0 && !errors.length,
    fullParity: false,
    coverage,
    errors,
    reason:
      "Partial observation checks only. Test-game access is administrator-only; repetition/chasing and all hidden-state transitions remain uncertified.",
    time: new Date().toISOString(),
  };
  save("parity-gate.json", result);
  return result;
}

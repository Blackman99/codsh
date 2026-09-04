/**
 * Warm the packed profile once in the parent, so forked e2e workers share it
 * instead of each paying the install.
 */
import { ensureTemplateHome } from './harness.ts'

export default function setup(): void {
  ensureTemplateHome()
}

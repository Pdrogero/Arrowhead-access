// src/phiFilter.ts
// A lightweight, pattern-based check for the clearest signs of PHI
// (Protected Health Information) accidentally typed into free-text fields.
// This is NOT a substitute for judgment or a guarantee of full compliance —
// it can only catch structured, unambiguous signals (a Social Security
// number, or an explicitly labeled patient identifier). It cannot detect
// PHI described in plain language (e.g. "the patient with the knee
// injury"), which has no reliable pattern to match against.

const PHI_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'a Social Security number', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: 'a patient name label', pattern: /\bpatient(?:'s)?\s*name\s*:/i },
  { label: 'a date of birth label', pattern: /\b(date of birth|d\.?o\.?b\.?)\s*:/i },
  { label: 'a medical record number label', pattern: /\b(medical record (number|#)|mrn)\s*:/i },
  { label: 'a diagnosis label', pattern: /\bdiagnos(is|es)\s*:/i },
  { label: 'a Social Security number label', pattern: /\bsocial security( number)?\s*:/i },
];

export function findPhiSignal(text: string): string | null {
  for (const { label, pattern } of PHI_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

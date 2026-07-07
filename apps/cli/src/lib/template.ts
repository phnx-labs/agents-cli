/**
 * Template resolution utilities.
 * Ported from agents/halo/cli/pkg/template.
 *
 * Supports {{artifact.*}} and {{preflight.*}} placeholder patterns used in
 * artifact action input mappings.
 */

/**
 * Resolve template placeholders with artifact and preflight data.
 * Replaces {{artifact.*}} and {{preflight.*}} patterns.
 *
 * @param tmpl - Template string with placeholders
 * @param artifact - Map of artifact key-value pairs
 * @param preflight - Map of preflight data (can contain strings or string arrays)
 * @returns Resolved template string
 */
export function resolveTemplate(
  tmpl: string,
  artifact: Record<string, string>,
  preflight: Record<string, string | string[] | unknown>
): string {
  let result = tmpl;

  // Replace {{artifact.*}}
  result = result.replace(/\{\{artifact\.(\w+)\}\}/g, (_, key) => {
    return artifact[key] ?? '';
  });

  // Replace {{preflight.*}}
  result = result.replace(/\{\{preflight\.(\w+)\}\}/g, (_, key) => {
    const val = preflight[key];
    if (val === undefined || val === null) {
      return '';
    }
    if (typeof val === 'string') {
      return val;
    }
    if (Array.isArray(val)) {
      return val.join(',');
    }
    return '';
  });

  return result;
}

/**
 * Extract all template variables from a template string.
 * @param tmpl - Template string
 * @returns Object with artifact and preflight variable names
 */
export function extractTemplateVariables(tmpl: string): {
  artifact: string[];
  preflight: string[];
} {
  const artifact: string[] = [];
  const preflight: string[] = [];

  const re = /\{\{(\w+)\.(\w+)\}\}/g;
  let match;

  while ((match = re.exec(tmpl)) !== null) {
    const [, prefix, key] = match;
    if (prefix === 'artifact' && !artifact.includes(key)) {
      artifact.push(key);
    } else if (prefix === 'preflight' && !preflight.includes(key)) {
      preflight.push(key);
    }
  }

  return { artifact, preflight };
}

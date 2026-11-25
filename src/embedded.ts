/**
 * Stratégie principale : les pages personnage de D&D Beyond embarquent le
 * personnage complet en JSON dans un script inline, généralement sous la
 * forme `characters["<id>"] = { ... }`. On extrait ce bloc en équilibrant
 * les accolades, puis on le parse en JSON (avec nettoyage des virgules
 * traînantes si besoin).
 */

const ASSIGN_RE = /characters\[\s*['"]([\d]+)['"]\s*\]\s*=\s*(?=\{)/g;

/** Équilibre les accolades en tenant compte des chaînes et échappements. */
function extractBalancedObject(text: string, startOfObject: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startOfObject; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startOfObject, i + 1);
    }
  }
  return null;
}

function tryParseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    // Nettoi les virgules traînantes fréquemment générées par les templates.
    const cleaned = raw.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(cleaned);
    } catch {
      return undefined;
    }
  }
}

export interface EmbeddedCharacter {
  characterId: string;
  data: unknown;
}

/**
 * Cherche dans tout le HTML (scripts inline) les affectations
 * `characters["<id>"] = {...}` et retourne chacune parsée.
 */
export function findEmbeddedCharacters(html: string): EmbeddedCharacter[] {
  const results: EmbeddedCharacter[] = [];
  const re = new RegExp(ASSIGN_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const objectStart = match.index + match[0].length;
    const raw = extractBalancedObject(html, objectStart);
    if (!raw) continue;
    const data = tryParseJson(raw);
    if (data !== undefined) {
      results.push({ characterId: match[1], data });
      re.lastIndex = match.index + match[0].length + raw.length;
    }
  }
  return results;
}

import { JSDOM } from "jsdom";

/**
 * Extraction par ancres textuelles : on transforme le DOM en flux de jetons
 * de texte (ordre document), puis on cherche des libellés humains connus
 * ("Strength", "Saving Throw", "Initiative"...) et on lit les valeurs
 * relatives voisines. Aucune dépendance aux classes CSS (dynamiques
 * chez D&D Beyond). Les aria-label (icônes de maîtrise, signes +/-) font
 * partie du flux.
 */

export interface Token {
  text: string;
  /** "text" = contenu visible, "aria" = aria-label d'un élément (icône...) */
  kind: "text" | "aria";
  position: number;
}

const PROFICIENCY_ARIA_RE = /\b(proficient|expertise)\b/i;

/**
 * Icônes de maîtrise sans aria-label : DDB les code dans les classes du
 * design system ddbc-* (bibliothèque stable, à la différence des classes
 * d'application obfusquées). On les traduit en jetons aria normaux.
 */
const PROFICIENCY_CLASS_MAP: [RegExp, string][] = [
  [/ddbc-twice-proficiency/, "Expertise"],
  [/ddbc-proficiency-none/, "Not Proficient"],
  [/ddbc-proficiency-half/, "Half Proficient"],
  [/ddbc-proficiency-full/, "Proficient"],
];

function proficiencyFromClass(className: string): string | null {
  for (const [re, label] of PROFICIENCY_CLASS_MAP) {
    if (re.test(className)) return label;
  }
  return null;
}

export function tokenize(html: string): Token[] {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  const tokens: Token[] = [];

  function push(text: string, kind: Token["kind"], position: number): void {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) tokens.push({ text: clean, kind, position });
  }

  function walk(node: Node): void {
    if (node.nodeType === 3) {
      push(node.nodeValue ?? "", "text", tokens.length);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "path") return;
    // Les icônes et boutons signalent l'état via aria-label (proficiency,
    // signe +/-) ou, à défaut, via les classes ddbc-proficiency-* de leur <svg>.
    const aria = el.getAttribute("aria-label");
    const classLabel = proficiencyFromClass(el.getAttribute("class") ?? "");
    if (aria && (PROFICIENCY_ARIA_RE.test(aria) || /^(plus|minus)$/i.test(aria))) {
      push(aria, "aria", tokens.length);
    } else if (classLabel) {
      push(classLabel, "aria", tokens.length);
    }
    if (tag === "svg") return;
    for (const child of Array.from(el.childNodes)) walk(child);
  }

  for (const child of Array.from(body.childNodes)) walk(child);
  return tokens;
}

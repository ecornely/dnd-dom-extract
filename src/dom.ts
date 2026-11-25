import { JSDOM } from "jsdom";
import type {
  AbilityKey,
  Character,
  CharacterClass,
  Defense,
  ProficiencyType,
  Skill,
} from "./schema.js";
import { ABILITY_KEYS, ABILITY_LABELS } from "./schema.js";
import { tokenize, type Token } from "./tokens.js";
import { toNumber } from "./util.js";

/**
 * Extraction minimale par ancres textuelles, calibrée sur le haut de fiche
 * D&D Beyond (samples/oros-dom.html). Volontairement restreint aux zones
 * couvertes par des exemples réels : on étendra au fur et à mesure.
 */

const NUMBER_RE = /^\d+([.,]\d+)?$/;
const SIGNED_RE = /^[+-]?\d+$/;

/** Texte du flux = les jetons visibles (pas les aria). */
function isText(token: Token): boolean {
  return token.kind === "text";
}

function findAnchor(tokens: Token[], re: RegExp, from = 0): number {
  for (let i = Math.max(0, from); i < tokens.length; i++) {
    if (isText(tokens[i]) && re.test(tokens[i].text)) return i;
  }
  return -1;
}

/** Lit la valeur signée qui suit l'ancre : "+","1" → 1 ; "--" → null. */
function signedNumberAt(tokens: Token[], i: number): { value: number | null; end: number } {
  let sign = 1;
  let j = i;
  let sawSign = false;
  while (j < tokens.length) {
    const t = tokens[j];
    if (isText(t) && t.text === "+") {
      sawSign = true;
      j++;
      continue;
    }
    if (t.kind === "aria" && /^plus$/i.test(t.text)) {
      sawSign = true;
      j++;
      continue;
    }
    if (isText(t) && t.text === "-") {
      sawSign = true;
      sign = -1;
      j++;
      continue;
    }
    if (t.kind === "aria" && /^minus$/i.test(t.text)) {
      sawSign = true;
      sign = -1;
      j++;
      continue;
    }
    // Signe porté directement par un jeton texte ("+3", "-1")
    if (isText(t) && SIGNED_RE.test(t.text)) {
      if (sawSign && !/^\d/.test(t.text)) break;
      const num = Number(t.text);
      return { value: Number.isFinite(num) ? sign * num : null, end: j + 1 };
    }
    break;
  }
  return { value: null, end: j };
}

function numberAt(tokens: Token[], i: number): { value: number | null; end: number } {
  if (i < tokens.length) {
    const t = tokens[i];
    if (isText(t) && NUMBER_RE.test(t.text)) {
      return { value: Number(t.text.replace(",", ".")), end: i + 1 };
    }
    // Jeton signé simple ("+1", "-1") accepté aussi (initiative, bonus)
    if (isText(t) && SIGNED_RE.test(t.text)) {
      return { value: Number(t.text), end: i + 1 };
    }
  }
  return { value: null, end: i };
}

function mapAbilities(tokens: Token[]): Record<AbilityKey, { score: number; modifier: number }> {
  const result = {} as Record<AbilityKey, { score: number; modifier: number }>;
  for (const key of ABILITY_KEYS) result[key] = { score: 0, modifier: 0 };

  // Zone abilities : l'ancrage "Strength" est suivi de l'abréviation "str",
  // puis du modificateur signé et du score (relatif, pas de classes CSS).
  let searchFrom = 0;
  for (const key of ABILITY_KEYS) {
    const anchor = findAnchor(tokens, new RegExp(`^${ABILITY_LABELS[key]}$`), searchFrom);
    if (anchor === -1) continue;
    // Validation : l'abréviation suit l'ancre (des aria peuvent s'intercaler)
    let probe = -1;
    for (let w = anchor + 1; w < Math.min(anchor + 5, tokens.length); w++) {
      const tk = tokens[w];
      if (tk.kind === "text" && tk.text.toLowerCase() === key.toLowerCase()) {
        probe = w + 1;
        break;
      }
    }
    if (probe === -1) continue;
    // Modificateur : signe puis nombre
    const mod = signedNumberAt(tokens, probe);
    const score = numberAt(tokens, mod.end);
    if (mod.value !== null) result[key].modifier = mod.value;
    if (score.value !== null) result[key].score = score.value;
    searchFrom = score.end;
  }
  return result;
}

function mapSavingThrows(tokens: Token[]): Record<AbilityKey, { value: number; proficient: boolean }> | null {
  const first = findAnchor(tokens, /^[A-Z][a-z]+ Saving Throw$/);
  if (first === -1) return null;

  const result = {} as Record<AbilityKey, { value: number; proficient: boolean }>;
  for (const key of ABILITY_KEYS) result[key] = { value: 0, proficient: false };

  // Les jetons "Proficient"/"Not Proficient" (aria) encadrent chaque ligne.
  for (let i = first; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isText(t)) continue;
    const key = ABILITY_KEYS.find((k) => t.text === `${ABILITY_LABELS[k]} Saving Throw`);
    if (!key) continue;
    // La valeur suit l'abréviation ("Strength Saving Throw", aria?, "str", "+","1").
    // On scanne l'abréviation dans une fenêtre courte : des jetons aria
    // (proficiency...) s'intercalent, avant ou après le libellé.
    let probe = i + 1;
    let prof = false;
    for (let back = Math.max(0, i - 3); back < i; back++) {
      const tk = tokens[back];
      if (tk.kind === "aria") {
        if (/^proficient$/i.test(tk.text) || /^expertise$/i.test(tk.text)) prof = true;
        if (/^not proficient$/i.test(tk.text)) prof = false;
      }
    }
    for (let w = 0; w < 4 && probe < tokens.length; w++, probe++) {
      const tk = tokens[probe];
      if (tk.kind === "text" && tk.text.toLowerCase() === key.toLowerCase()) {
        probe++; // on repart après l'abréviation
        break;
      }
      if (tk.kind === "text" && SIGNED_RE.test(tk.text)) break; // valeur déjà là
      if (tk.kind === "aria") {
        if (/^proficient$/i.test(tk.text) || /^expertise$/i.test(tk.text)) prof = true;
        if (/^not proficient$/i.test(tk.text)) prof = false;
      }
    }
    const value = signedNumberAt(tokens, probe).value;
    if (value !== null) result[key] = { value, proficient: prof };
  }
  return result;
}

function mapSkills(tokens: Token[]): Skill[] {
  const skills: Skill[] = [];
  // Flux d'une ligne : [aria Proficient?] "WIS" "Medicine" "+" "3"
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isText(t)) continue;
    const ability = ABILITY_KEYS.find((k) => k === t.text.toUpperCase() && k.length === t.text.length);
    if (!ability) continue;
    const next = tokens[i + 1];
    if (!next || !isText(next) || !/^[A-Za-z][A-Za-z' ]+$/.test(next.text)) continue;
    const modifier = signedNumberAt(tokens, i + 2).value;
    if (modifier === null) continue;
    // Maîtrise : dernier token aria avant l'abréviation
    // (aria-label "Half Proficient" = demi-maîtrise, ex. Jack of All Trades)
    let proficiency: ProficiencyType = "none";
    for (let p = i - 1; p >= 0 && i - p < 6; p--) {
      const a = tokens[p];
      if (a.kind === "text") break;
      if (/^expertise$/i.test(a.text)) proficiency = "expertise";
      else if (/^half( proficient)?$/i.test(a.text)) proficiency = "half";
      else if (/^proficient$/i.test(a.text)) proficiency = "proficient";
      else if (/^not proficient$/i.test(a.text)) proficiency = "none";
      if (proficiency !== "none") break;
    }
    skills.push({ name: next.text, ability, value: modifier, proficiency });
  }
  return skills;
}

function mapCombat(tokens: Token[]): Partial<Character> {
  const out: Partial<Character> = {};
  // AC : "Armor Class" → "Armor" → 13 → "Class"
  const acAnchor = findAnchor(tokens, /^Armor Class$/);
  if (acAnchor !== -1) {
    const armorLabel = findAnchor(tokens, /^Armor$/, acAnchor + 1);
    if (armorLabel !== -1) {
      const ac = numberAt(tokens, armorLabel + 1).value;
      if (ac !== null) out.armorClass = ac;
    }
  }
  // Initiative : dernier "Initiative" suivi d'un nombre signé ("+ 1" ou "+1")
  let lastInit = -1;
  let probe = 0;
  while ((lastInit = findAnchor(tokens, /^Initiative$/, probe)) !== -1) {
    let j = lastInit + 1;
    while (j < tokens.length && isText(tokens[j]) && tokens[j].text === "Initiative") j++;
    const value = signedNumberAt(tokens, j).value;
    if (value !== null) {
      out.initiative = value;
      probe = j;
    } else {
      probe = lastInit + 1;
    }
  }
  // Vitesse : ancre du type de déplacement, valeur + unité qui suivent
  const speedAnchor = findAnchor(tokens, /^(Walking|Flying|Swimming|Climbing|Burrowing)$/);
  if (speedAnchor !== -1) {
    const value = numberAt(tokens, speedAnchor + 1).value;
    const unit = tokens[speedAnchor + 2];
    if (value !== null) {
      out.speed = `${value}${unit && isText(unit) ? " " + unit.text : ""}`;
    }
  }
  return out;
}

function mapHitPoints(tokens: Token[]): Character["hp"] {
  const hp: Character["hp"] = { current: null, max: null, temp: null };
  const anchor = findAnchor(tokens, /^Current$/);
  if (anchor === -1) return hp;
  // "Current" 19 "/" "Max" 19 "Temp" --
  let j = anchor + 1;
  const cur = numberAt(tokens, j);
  hp.current = cur.value;
  j = cur.end;
  // "/" puis "Max" (possible tooltip "Max hit points") puis la valeur
  while (j < tokens.length && isText(tokens[j]) && tokens[j].text !== "Max") j++;
  if (j < tokens.length) {
    let max = { value: null as number | null, end: j + 1 };
    for (let w = j + 1; w < Math.min(j + 4, tokens.length); w++) {
      const tk = tokens[w];
      if (!isText(tk)) continue;
      if (NUMBER_RE.test(tk.text)) {
        max = { value: Number(tk.text), end: w + 1 };
        break;
      }
      if (tk.text === "Temp") break;
    }
    hp.max = max.value;
    j = max.end;
    while (j < tokens.length && isText(tokens[j]) && tokens[j].text !== "Temp") j++;
    if (j < tokens.length) {
      const t = tokens[j + 1];
      hp.temp = t && isText(t) && NUMBER_RE.test(t.text) ? Number(t.text) : null;
    }
  }
  return hp;
}

function mapProficiencyBonus(tokens: Token[]): number | null {
  const anchor = findAnchor(tokens, /^Proficiency$/);
  if (anchor === -1) return null;
  // "Proficiency" "Bonus" "+" "2"
  let j = anchor + 1;
  while (j < tokens.length && isText(tokens[j]) && tokens[j].text === "Bonus") j++;
  return signedNumberAt(tokens, j).value;
}

function mapSenses(tokens: Token[]): { passivePerception: number | null } {
  // Valeurs AVANT les libellés dans ce flux : 13 "Passive Perception" 12
  const anchor = findAnchor(tokens, /^Passive Perception$/);
  if (anchor === -1) return { passivePerception: null };
  const value = numberAt(tokens, anchor - 1);
  // Le jeton précédent peut être le libellé de section "Senses" → alors valeur absente
  const prev = tokens[anchor - 1];
  if (prev && isText(prev) && NUMBER_RE.test(prev.text.replace("+", ""))) {
    return { passivePerception: Number(prev.text) || null };
  }
  return { passivePerception: null };
}

const PROFICIENCY_GROUP_LABELS = ["Armor", "Weapons", "Tools", "Languages"] as const;
type ProficiencyGroupLabel = (typeof PROFICIENCY_GROUP_LABELS)[number];

/**
 * Maîtrises par catégorie, en relatif : on ancre le libellé exact du groupe
 * ("Armor", "Weapons"...), on remonte au conteneur parent et on collecte les
 * items frères du libellé. Les items sont séparés par les tooltips
 * (attribut data-original-title = source de la maîtrise) si présents,
 * sinon par le texte brut. Si la structure n'est pas reconnue, la catégorie
 * reste vide plutôt que mal peuplée.
 */
function mapDefensesFromDom(html: string): Character["defenses"] {
  const empty: Character["defenses"] = { resistances: [], immunities: [], vulnerabilities: [] };
  const doc = new JSDOM(html).window.document;

  // Résumé "Defenses" : le libellé ancre la section ; chaque groupe porte un
  // tooltip (data-original-title) "Resistance" / "Immunity" / "Vulnerability"
  // et ses items sont des spans tooltipés dont le texte est le type de dégâts
  // (le tooltip de l'item = la source, ex. "Tiefling" — on ne l'utilise pas).
  const labelEl = Array.from(doc.querySelectorAll("*")).find(
    (el) => el.children.length === 0 && (el.textContent ?? "").trim() === "Defenses",
  );
  if (!labelEl) return empty;
  const container = labelEl.parentElement;
  if (!container) return empty;

  const bucketFor = (category: string): Defense[] | null => {
    const lower = category.toLowerCase();
    if (lower.includes("resist")) return empty.resistances;
    if (lower.includes("immun")) return empty.immunities;
    if (lower.includes("vulner")) return empty.vulnerabilities;
    return null;
  };

  for (const categoryEl of Array.from(container.querySelectorAll<HTMLElement>("[data-original-title]"))) {
    const bucket = bucketFor(categoryEl.getAttribute("data-original-title") ?? "");
    if (!bucket) continue;
    // Le groupe : le plus proche ancêtre div commun (preview + items)
    const group =
      categoryEl.parentElement?.parentElement?.parentElement ?? categoryEl.closest("div");
    if (!group) continue;
    for (const item of Array.from(group.querySelectorAll<HTMLElement>("[data-original-title]"))) {
      if (item === categoryEl) continue;
      const value = (item.textContent ?? "").trim();
      if (value && !bucket.some((d) => d.value === value)) {
        bucket.push({
          type: (categoryEl.getAttribute("data-original-title") ?? "").toLowerCase(),
          value,
        });
      }
    }
  }
  return empty;
}

function mapProficiencies(html: string): Character["proficiencies"] {
  const result: Character["proficiencies"] = { armor: [], weapons: [], tools: [], languages: [] };
  const doc = new JSDOM(html).window.document;

  for (const label of PROFICIENCY_GROUP_LABELS) {
    const bucket = result[label.toLowerCase() as keyof Character["proficiencies"]];
    const labelEl = Array.from(doc.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && (el.textContent ?? "").trim() === label,
    );
    if (!labelEl) continue;
    const container = labelEl.parentElement;
    if (!container) continue;
    // Sécurité : le conteneur ne doit pas contenir d'autre label de groupe
    const containerText = container.textContent ?? "";
    if (PROFICIENCY_GROUP_LABELS.some((l) => l !== label && containerText.includes(l))) continue;

    const tooltipItems = Array.from(
      container.querySelectorAll<HTMLElement>("[data-original-title]"),
    ).filter((el) => !el.querySelector("[data-original-title]"));

    const items = tooltipItems.length
      ? tooltipItems.map((el) => (el.textContent ?? "").replace(/,\s*$/, "").trim())
      : (bucket.length ? [] : (() => {
          // Fallback : texte du conteneur, libellé retiré
          return containerText.replace(label, "").trim() ? [containerText.replace(label, "").trim()] : [];
        })());

    for (const item of items) {
      const clean = item.replace(/,\s*$/, "").trim();
      if (clean && !bucket.includes(clean)) bucket.push(clean);
    }
  }
  return result;
}

function mapIdentity(tokens: Token[]): Partial<Character> {
  const out: Partial<Character> = {};
  // Ancrage "Level 2" ; race et classes sont les jetons immédiatement avant.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isText(t)) continue;
    const m = t.text.match(/^Level (\d+)$/);
    if (!m) continue;
    out.level = Number(m[1]);
    const classesToken = tokens[i - 1];
    if (classesToken && isText(classesToken)) {
      const classes: CharacterClass[] = [];
      for (const part of classesToken.text.split(/,\s*/)) {
        const cm = part.match(/^(.+?)\s+(\d+)$/);
        if (cm) classes.push({ name: cm[1].trim(), level: Number(cm[2]), subclass: null });
      }
      if (classes.length) {
        out.classes = classes;
        const raceToken = tokens[i - 2];
        if (raceToken && isText(raceToken) && !NUMBER_RE.test(raceToken.text)) {
          out.race = raceToken.text;
        }
      }
    }
    break;
  }
  return out;
}

export function extractFromDom(html: string, sourceRef: string, extractedAt: string): Character {
  const tokens = tokenize(html);

  const abilities = mapAbilities(tokens);
  const savingThrows = mapSavingThrows(tokens);
  const combat = mapCombat(tokens);
  const identity = mapIdentity(tokens);

  const name = (() => {
    const dom = new JSDOM(html).window.document;
    return dom.querySelector("h1")?.textContent?.trim() || null;
  })();

  return {
    meta: { source: "dom", sourceRef, extractedAt, characterId: null, units: { distance: "ft.", weight: "lb." } },
    name,
    level: identity.level ?? null,
    xp: null,
    race: identity.race ?? null,
    size: null,
    background: null,
    alignment: null,
    classes: identity.classes ?? [],
    spellcasting: [],
    abilities,
    savingThrows:
      savingThrows ??
      (() => {
        const def = {} as Record<AbilityKey, { value: number; proficient: boolean }>;
        for (const key of ABILITY_KEYS) def[key] = { value: abilities[key].modifier, proficient: false };
        return def;
      })(),
    skills: mapSkills(tokens),
    proficiencyBonus: mapProficiencyBonus(tokens),
    armorClass: combat.armorClass ?? null,
    initiative: combat.initiative ?? null,
    speed: combat.speed ?? null,
    passivePerception: mapSenses(tokens).passivePerception,
    carryingCapacity: null,
    pushDragLift: null,
    hp: mapHitPoints(tokens),
    hitDice: null,
    deathSaves: null,
    coins: null,
    attacks: [],
    defenses: mapDefensesFromDom(html),
    proficiencies: mapProficiencies(html),
    features: [],
    equipment: [],
    spells: [],
    spellSlots: [],
    personality: null,
    appearance: null,
    backstory: null,
    allies: null,
  };
}

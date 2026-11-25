import type { AbilityKey } from "./schema.js";

/**
 * Accède à un chemin "a.b.0.c" dans un objet arbitraire sans lever d'exception.
 * Retourne undefined au premier maillon manquant.
 */
export function path<T = unknown>(obj: unknown, expr: string): T | undefined {
  let cur: unknown = obj;
  for (const part of expr.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur === undefined ? undefined : (cur as T);
}

/**
 * Retourne la première valeur définie parmi plusieurs chemins candidats.
 * Les structures D&D Beyond variant selon les versions de la fiche,
 * on teste plusieurs emplacements.
 */
export function firstPath<T = unknown>(obj: unknown, exprs: string[]): T | undefined {
  for (const expr of exprs) {
    const value = path<T>(obj, expr);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[+\-%]/g, "").trim());
    if (!Number.isNaN(parsed) && value.trim() !== "") return parsed;
  }
  return null;
}

export function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") return String(value);
  return null;
}

/** Liste des 6 caractéristiques indexées 0..5 dans les données DDB. */
export function abilityFromId(id: number): AbilityKey | null {
  switch (id) {
    case 1: return "STR";
    case 2: return "DEX";
    case 3: return "CON";
    case 4: return "INT";
    case 5: return "WIS";
    case 6: return "CHA";
    default: return null;
  }
}

/** Table des emplacements de sorts d'un incantateur complet (index = niveau-1).
 *  Le JSON DDB ne stocke pas les slots (spellSlots.available vaut toujours 0) :
 *  on les dérive du niveau effectif, comme la page. */
const FULL_CASTER_SLOTS: number[][] = [
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 1, 1],
  [4, 3, 3, 3, 1, 1],
  [4, 3, 3, 3, 1, 1, 1],
  [4, 3, 3, 3, 1, 1, 1],
  [4, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/** Paladins/Rangers (D&D 2014) : moitié, tableau dédié intercalé. */
const HALF_CASTER_SLOTS: number[][] = [
  [],
  [2],
  [3],
  [3],
  [4, 2],
  [4, 2],
  [4, 3],
  [4, 3],
  [4, 3, 2],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2],
];

/** Sorcier occulte (pacte magique) : slots séparés, additionnés par niveau. */
const WARLOCK_SLOTS: number[][] = [
  [1],
  [2],
  [],
  [0, 2],
  [0, 0, 2],
  [],
  [0, 0, 2],
  [],
  [0, 0, 0, 0, 2],
  [],
  [0, 0, 0, 0, 3],
  [],
  [],
  [],
  [],
  [],
  [0, 0, 0, 0, 4],
];

const FULL_CASTERS = ["bard", "cleric", "druid", "sorcerer", "wizard"];
const HALF_CASTERS = ["paladin", "ranger", "artificer"];
const THIRD_CASTERS = ["rogue", "fighter"];

/** Liste inconnue ou non-tableau → []. */
export function looseArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Emplacements de sorts par niveau (index 0 = niveau 1). Le JSON DDB ne
 * stocke pas les slots : on applique la règle multiclasses — chaque classe
 * incantatrice contribue floor(niveau × fraction) au niveau effectif, lu
 * dans la table des incantateurs complets ; un paladin/ranger/artificier
 * seul suit sa propre progression (moitié, tableau dédié intercalé) ;
 * le sorcier (pacte magique) apporte ses propres slots, additionnés.
 */
export function computeSpellSlots(data: unknown): number[] {
  const classes = looseArray(path(data, "classes"));
  let casterLevel = 0;
  const pactSlots: number[] = [];
  for (const klass of classes) {
    const name = toText(path(klass, "definition.name") ?? path(klass, "name"))?.toLowerCase();
    const level = toNumber(path(klass, "level")) ?? 0;
    if (!name || level < 1) continue;
    if (name === "warlock") {
      for (const [i, count] of (WARLOCK_SLOTS[level - 1] ?? []).entries()) {
        pactSlots[i] = (pactSlots[i] ?? 0) + count;
      }
      continue;
    }
    const fraction = FULL_CASTERS.includes(name)
      ? 1
      : HALF_CASTERS.includes(name)
        ? 0.5
        : THIRD_CASTERS.includes(name) && /eldritch knight|arcane trickster/i.test(String(path(klass, "subclassDefinition.name")))
          ? 1 / 3
          : 0;
    casterLevel += Math.floor(level * fraction);
  }
  // Un paladin/ranger/artificier seul suit sa propre progression (table
  // intercalée), pas la table des incantateurs complets.
  const soloName = classes.length === 1
    ? toText(path(classes[0], "definition.name") ?? path(classes[0], "name"))?.toLowerCase()
    : undefined;
  const soloLevel = toNumber(path(classes[0], "level"));
  const slots =
    classes.length === 1 && soloName && soloLevel !== null && HALF_CASTERS.includes(soloName)
      ? soloName === "artificer"
        ? [...(FULL_CASTER_SLOTS[Math.ceil(soloLevel / 2) - 1] ?? [])]
        : [...(HALF_CASTER_SLOTS[soloLevel - 1] ?? [])]
      : [...(FULL_CASTER_SLOTS[casterLevel - 1] ?? [])];
  for (const [i, count] of pactSlots.entries()) {
    slots[i] = (slots[i] ?? 0) + count;
  }
  return slots;
}

/** Bonus de maîtrise : table D&D — niveau 1 → +2, 5 → +3, 9 → +4... */
export function proficiencyBonusFromLevel(level: number | null): number | null {
  if (level === null || level < 1) return null;
  return Math.floor((level - 1) / 4) + 2;
}

/**
 * Durée d'un sort formatée depuis l'objet duration de DDB
 * (durationType + durationInterval + durationUnit) :
 * « Instantané », « 1 Minute », « 10 Minutes », « Conc. 1 Minute »...
 */
export function formatSpellDuration(dur: unknown): string | null {
  const d = (dur ?? null) as { durationType?: unknown; durationInterval?: unknown; durationUnit?: unknown } | null;
  if (!d) return null;
  const type = toText(d.durationType);
  const interval = toNumber(d.durationInterval);
  const unit = toText(d.durationUnit);
  let duration: string | null;
  if (type === "Instantaneous") duration = "Instantané";
  else if (interval !== null && unit) duration = `${interval} ${unit}${interval > 1 ? "s" : ""}`;
  else duration = type;
  return duration && type === "Concentration" ? `Conc. ${duration}` : duration;
}

/** Portée du sort : « Ranged » + valeur → « 120 ft. », sinon l'origine. */
export function formatSpellRange(origin: string | null, rangeValue: number | null): string | null {
  if (origin === "Ranged" && rangeValue !== null) return `${rangeValue} ft.`;
  return origin;
}

/** Le sort inflige-t-il des dégâts ? Tag DDB « Damage » des définitions. */
export function spellIsDamaging(definition: unknown): boolean {
  return looseArray(path(definition ?? {}, "tags"))
    .some((tag) => toText(tag) === "Damage");
}

/**
 * Modificateurs de caractéristiques calculés depuis le JSON brut :
 * stats[] (score de base) + overrideStats (si non null) + bonus raciaux
 * et autres modifiers type "bonus" subType "<ability>-score".
 */
/** Scores de caractéristiques effectifs : base (stats + override) + bonus
 *  raciaux et autres « <ability>-score ». abilityModifiers part de ces valeurs. */
export function abilityScoreValues(data: unknown): Record<AbilityKey, number> {
  const scores: Record<string, number> = {};
  for (const stat of looseArray(path(data, "stats"))) {
    const id = toNumber(path(stat, "id"));
    const value = toNumber(path(stat, "value"));
    if (id !== null && value !== null) scores[id] = value;
  }
  for (const stat of looseArray(path(data, "overrideStats"))) {
    const id = toNumber(path(stat, "id"));
    const value = toNumber(path(stat, "value"));
    if (id !== null && value !== null) scores[id] = value;
  }
  const result = {} as Record<AbilityKey, number>;
  const fullName: Record<AbilityKey, string> = {
    STR: "strength",
    DEX: "dexterity",
    CON: "constitution",
    INT: "intelligence",
    WIS: "wisdom",
    CHA: "charisma",
  };
  for (const key of ["STR", "DEX", "CON", "INT", "WIS", "CHA"] as AbilityKey[]) {
    const id = { STR: 1, DEX: 2, CON: 3, INT: 4, WIS: 5, CHA: 6 }[key];
    const base = scores[id] ?? 10;
    let bonus = 0;
    for (const group of Object.values(path(data, "modifiers") ?? {})) {
      for (const m of looseArray(group)) {
        if (path(m, "type") !== "bonus") continue;
        // subType = nom complet : "charisma-score", pas "cha-score"
        if (path(m, "subType") !== `${fullName[key]}-score`) continue;
        bonus += toNumber(path(m, "value")) ?? 0;
      }
    }
    result[key] = base + bonus;
  }
  return result;
}

export function abilityModifiers(data: unknown): Record<AbilityKey, number> {
  const scores = abilityScoreValues(data);
  const result = {} as Record<AbilityKey, number>;
  for (const key of Object.keys(scores) as AbilityKey[]) {
    result[key] = Math.floor((scores[key] - 10) / 2);
  }
  return result;
}

/**
 * Lancement de sorts : une entrée par classe avec une stat d'incantation
 * (definition.spellCastingAbilityId). DDB ne fournit ni attack ni saveDc
 * tout faits dans le JSON — la page les recalcule — mais les formules sont
 * livresques : attack = mod + PB, saveDc = 8 + mod + PB.
 */
export function computeSpellcasting(data: unknown): {
  className: string | null;
  ability: AbilityKey | null;
  modifier: number;
  attack: number;
  saveDc: number;
}[] {
  const modifiers = abilityModifiers(data);
  const totalLevel = looseArray(path(data, "classes")).reduce<number>((sum, klass) => sum + (toNumber(path(klass, "level")) ?? 0), 0);
  const proficiencyBonus = proficiencyBonusFromLevel(totalLevel > 0 ? totalLevel : null);
  if (proficiencyBonus === null) return [];
  const entries: { className: string | null; ability: AbilityKey | null; modifier: number; attack: number; saveDc: number }[] = [];
  for (const klass of looseArray(path(data, "classes"))) {
    const abilityId = toNumber(path(klass, "definition.spellCastingAbilityId") ?? path(klass, "spellCastingAbilityId"));
    const ability = abilityId !== null ? abilityFromId(abilityId) : null;
    if (!ability) continue;
    const modifier = modifiers[ability];
    entries.push({
      className: toText(path(klass, "definition.name")) ?? toText(path(klass, "name")),
      ability,
      modifier,
      attack: proficiencyBonus + modifier,
      saveDc: 8 + proficiencyBonus + modifier,
    });
  }
  return entries;
}

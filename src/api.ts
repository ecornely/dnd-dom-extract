import type {
  AbilityKey,
  Attack,
  Character,
  CharacterActions,
  CharacterClass,
  Feature,
  Spell,
} from "./schema.js";
import { ABILITY_KEYS } from "./schema.js";
import { abilityModifiers, abilityScoreValues, computeSpellcasting, computeSpellSlots, formatSpellDuration, formatSpellRange, spellIsDamaging, path, proficiencyBonusFromLevel, toNumber, toText } from "./util.js";
import { EMPTY_RULES, featureAllowed, type ExtractRules } from "./rules.js";

/**
 * Mapping de l'export API Tampermonkey (responses[] capturées de
 * character-service.dndbeyond.com). Le payload `character/v5/character/<id>`
 * contient les données brutes : identité, apparence, notes, inventaire,
 * sorts... Les valeurs CALCULÉES (scores affichés, saves, skills, CA...) ne
 * sont pas fiables ici (la page les recalcule avec les modifiers) : on laisse
 * ces champs au DOM.
 */

export interface ApiExport {
  exportedAt?: string;
  pageUrl?: string;
  count?: number;
  /** body.outerHTML de la fiche, obligatoire dans le dump Tampermonkey v5. */
  domHtml: string;
  responses?: {
    capturedAt?: string;
    url?: string;
    transport?: string;
    status?: number;
    payload?: { data?: unknown };
  }[];
}

/** Format attendu du dump Tampermonkey (documenté dans le README). */
export const API_DUMP_FORMAT =
  '{ exportedAt, pageUrl, count, responses: [{ capturedAt, url, transport, status, payload }], domHtml }';

/**
 * Parse et valide l'unique format d'export : le JSON produit par le
 * userscript v5 (Ctrl+Shift+C presse-papier / Ctrl+Alt+C téléchargement).
 * Rejette tout autre entrée, notamment les anciens exports séparés v4.
 */
export function parseApiExport(raw: string, sourceRef = "export.json"): ApiExport {
  let parsed: ApiExport | null = null;
  try {
    parsed = JSON.parse(raw) as ApiExport;
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.responses) || typeof parsed.domHtml !== "string") {
    throw new Error(
      `"${sourceRef}" n'est pas un export Tampermonkey v5 attendu (${API_DUMP_FORMAT}). ` +
        "Utilise Ctrl+Shift+C (presse-papier) ou Ctrl+Alt+C (téléchargement) " +
        "du userscript sur la fiche D&D Beyond.",
    );
  }
  return parsed;
}

/** Payload de type character/v5/character/<id> : le plus volumineux. */
export function findCharacterApiResponse(
  apiExport: ApiExport,
): { data: Record<string, unknown>; capturedAt: string | null; url: string | null } | null {
  const candidates = (apiExport.responses ?? []).filter(
    (r) =>
      typeof r.url === "string" &&
      /character\/v5\/character\/\d+/.test(r.url) &&
      r.payload?.data &&
      typeof r.payload.data === "object",
  );
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) =>
    JSON.stringify(b.payload?.data).length > JSON.stringify(a.payload?.data).length ? b : a,
  );
  return {
    data: best.payload!.data as Record<string, unknown>,
    capturedAt: best.capturedAt ?? null,
    url: best.url ?? null,
  };
}

function looseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function stripHtml(htmlish: unknown): string | null {
  const text = toText(htmlish);
  if (!text) return null;
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function mapClasses(data: Record<string, unknown>): CharacterClass[] {
  const classes = looseArray(data.classes);
  return classes
    .map((entry): CharacterClass | null => {
      const definition = (entry as { definition?: unknown }).definition ?? entry;
      const name = toText((definition as { name?: unknown }).name);
      if (!name) return null;
      return {
        name,
        level: toNumber((entry as { level?: unknown }).level),
        subclass: toText(
          ((entry as { subclassDefinition?: { name?: unknown } }).subclassDefinition as { name?: unknown } | undefined)?.name,
        ),
      };
    })
    .filter((c): c is CharacterClass => c !== null);
}

/**
 * Défenses (résistances / immunités / vulnérabilités) : pas de bloc dédié
 * dans les captures — chaque défense est un modifyer de type
 * "resistance"/"immunity"/"vulnerability" réparti dans les groupes
 * mods {race, class, background, feat, item, condition}, avec
 * friendlySubtypeName = type de dégât ("Fire", "Psychic Damage"...).
 */
function mapDefenses(data: Record<string, unknown>): Character["defenses"] {
  const result: Character["defenses"] = { resistances: [], immunities: [], vulnerabilities: [] };
  const KINDS: [string, Character["defenses"]["resistances"]][] = [
    ["resistance", result.resistances],
    ["immunity", result.immunities],
    ["vulnerability", result.vulnerabilities],
  ];
  const modifiers = (data.modifiers ?? null) as Record<string, unknown> | null;
  if (!modifiers) return result;
  for (const group of Object.values(modifiers)) {
    for (const entry of looseArray(group)) {
      const m = entry as {
        type?: unknown;
        isGranted?: unknown;
        friendlySubtypeName?: unknown;
        subType?: unknown;
      };
      if (m.isGranted === false) continue;
      const kind = KINDS.find(([k]) => k === m.type);
      if (!kind) continue;
      const value =
        toText(m.friendlySubtypeName) ??
        toText(m.subType)?.replace(/-damage$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ??
        null;
      if (value && !kind[1].some((d) => d.value === value)) {
        kind[1].push({ type: kind[0], value });
      }
    }
  }
  return result;
}

/** Entity type ids des groupes de maîtrises dans les modifiers DDB :
 *  armures (simples/boucliers), armes (groupes simples + armes individuelles),
 *  outils et kit. Confirmé sur les exports damaia/oros/esther/elowen. */
const PROFICIENCY_ENTITY_TYPE_IDS: Record<string, number[]> = {
  weapons: [660121713, 1782728300],
  armor: [174869515],
  tools: [2103445194],
};

/**
 * Maîtrises (armes / armures / outils) : chaque maîtrise est un modifier
 * `type: "proficiency"` réparti dans les groupes mods {race, class, ...},
 * catégorisé par entityTypeId. Seules les maîtrises réellement acquises
 * (`isGranted !== false`) comptent : les candidats de choix sont écartés.
 */
export function mapProficienciesFromModifiers(data: Record<string, unknown>): {
  weapons: string[];
  armor: string[];
  tools: string[];
} {
  const result: Record<string, string[]> = { weapons: [], armor: [], tools: [] };
  const modifiers = (data.modifiers ?? null) as Record<string, unknown> | null;
  if (!modifiers) return { weapons: [], armor: [], tools: [] };
  for (const group of Object.values(modifiers)) {
    for (const entry of looseArray(group)) {
      const m = entry as {
        type?: unknown;
        isGranted?: unknown;
        entityTypeId?: unknown;
        friendlySubtypeName?: unknown;
        subType?: unknown;
      };
      if (m.type !== "proficiency" || m.isGranted === false) continue;
      const entityTypeId = toNumber(m.entityTypeId) ?? -1;
      const value =
        toText(m.friendlySubtypeName) ??
        toText(m.subType)?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ??
        null;
      for (const [category, entityIds] of Object.entries(PROFICIENCY_ENTITY_TYPE_IDS)) {
        if (!entityIds.includes(entityTypeId) || !value) continue;
        if (!result[category].includes(value)) {
          result[category].push(value);
        }
      }
    }
  }
  return result as { weapons: string[]; armor: string[]; tools: string[] };
}

/** Groupes de maîtrise de la catégorie d'arme (definition.categoryId). */
const WEAPON_CATEGORY_GROUPS: Record<number, string> = {
  1: "simple-weapons",
  2: "martial-weapons",
};

function signedBonus(n: number | null): string | null {
  return n === null ? null : n >= 0 ? `+${n}` : String(n);
}

/**
 * Armes maîtrisées, indexées pour le calcul du bonus d'attaque :
 * groupes (simple-weapons / martial-weapons par entityId=1) et armes
 * individuelles où entityId = definition.baseItemId de l'arme.
 */
function weaponMasteries(data: Record<string, unknown>): { groups: Set<string>; weapons: Set<number> } {
  const groups = new Set<string>();
  const weapons = new Set<number>();
  const modifiers = (data.modifiers ?? null) as Record<string, unknown> | null;
  if (!modifiers) return { groups, weapons };
  for (const group of Object.values(modifiers)) {
    for (const entry of looseArray(group)) {
      const m = entry as {
        type?: unknown;
        isGranted?: unknown;
        entityTypeId?: unknown;
        entityId?: unknown;
        subType?: unknown;
      };
      if (m.type !== "proficiency" || m.isGranted === false) continue;
      const entityTypeId = toNumber(m.entityTypeId);
      if (entityTypeId !== 660121713 && entityTypeId !== 1782728300) continue;
      const subType = toText(m.subType);
      const entityId = toNumber(m.entityId);
      if (subType === "simple-weapons" || subType === "martial-weapons") {
        groups.add(subType);
      } else if (entityId !== null) {
        weapons.add(entityId);
      }
    }
  }
  return { groups, weapons };
}

/**
 * Attaques d'armes équipées pour la table d'Attaques. Le DDB JSON embarque la
 * définition complète de l'arme (dés, type, propriétés, portée) mais pas le
 * bonus d'attaque, calculé par la page ; on suit les mêmes règles :
 * Finesse → max(FOR, DEX), arme à distance → DEX, + PB si la maîtrise couvre
 * la catégorie ou l'arme précise. Bonus de dégâts = même modificateur
 * (armes magiques non gérées).
 */
export function mapAttacks(data: Record<string, unknown>): Attack[] {
  const mods = abilityModifiers(data);
  const totalLevel = looseArray(data.classes).reduce<number>(
    (sum, klass) => sum + (toNumber((klass as { level?: unknown }).level) ?? 0),
    0,
  );
  const pb = proficiencyBonusFromLevel(totalLevel > 0 ? totalLevel : null);
  const mastery = weaponMasteries(data);
  const result: Attack[] = [];
  for (const item of looseArray(data.inventory)) {
    const entry = item as { definition?: Record<string, unknown>; equipped?: unknown };
    const def = entry.definition ?? {};
    if (toText(def.filterType) !== "Weapon" || entry.equipped === false) continue;
    const name = toText(def.name);
    if (!name) continue;
    const properties = looseArray(def.properties)
      .map((p) => toText((p as { name?: unknown }).name))
      .filter((p): p is string => p !== null);
    const finesse = properties.includes("Finesse");
    const ranged = toNumber(def.attackType) === 2;
    const ability = finesse ? (mods.DEX >= mods.STR ? "DEX" : "STR") : ranged ? "DEX" : "STR";
    const abilityMod = mods[ability];
    const categoryId = toNumber(def.categoryId) ?? -1;
    const baseItemId = toNumber(def.baseItemId) ?? -1;
    const proficient =
      pb !== null &&
      (mastery.groups.has(WEAPON_CATEGORY_GROUPS[categoryId] ?? "") || mastery.weapons.has(baseItemId));
    const bonus = signedBonus(abilityMod + (proficient ? pb ?? 0 : 0));
    const dice = toText((def.damage as { diceString?: unknown } | undefined)?.diceString);
    const damageType = toText(def.damageType);
    const damage = dice !== null || damageType !== null
      ? `${dice ?? ""}${dice !== null && abilityMod !== 0 ? signedBonus(abilityMod) : ""}${damageType ? (dice !== null ? " " : "") + damageType : ""}`.trim() || null
      : null;
    const range = toNumber(def.range);
    const longRange = toNumber(def.longRange);
    const rangeText =
      range !== null ? (range > 5 && longRange !== null ? `${range}/${longRange} ft.` : `${range} ft.`) : null;
    const propertiesText = [rangeText, ...properties].filter(Boolean).join(", ") || null;
    result.push({ name, bonus, damage, properties: propertiesText });
  }
  return result;
}

/**
 * Dés de vie cumulés par classe : DDB ne stocke jamais "2d8" mais
 * classes[].level × classes[].definition.hitDice (ex. multiclassé :
 * "3d8 + 1d6"). C'est une métadonnée de classe, pas un calcul de la page.
 */
function mapHitDice(data: Record<string, unknown>): string | null {
  return (
    looseArray(data.classes)
      .map((entry): string | null => {
        const def = (entry as { definition?: { hitDice?: unknown } }).definition ?? entry;
        const level = toNumber((entry as { level?: unknown }).level);
        const die = toNumber((def as { hitDice?: unknown }).hitDice);
        return level !== null && die !== null && level > 0 ? `${level}d${die}` : null;
      })
      .filter((s): s is string => s !== null)
      .join(" + ") || null
  );
}

/**
 * Tab Actions de D&D Beyond : data.actions (groupes race/class/background/
 * feat/item/condition) + data.customActions (entrées maison du joueur).
 * Noms seuls, répartis par coût d'activation — les attaques d'armes sont
 * déjà dans Character.attacks et les sorts (action bonus, réaction) dans
 * Character.spells avec leur castingTime.
 */
export function mapActions(data: Record<string, unknown>): CharacterActions {
  const buckets: Record<keyof CharacterActions, Set<string>> = {
    action: new Set<string>(),
    bonusAction: new Set<string>(),
    reaction: new Set<string>(),
    other: new Set<string>(),
  };
  const push = (entry: unknown): void => {
    const a = entry as { name?: unknown; activation?: { activationType?: unknown } } | null;
    const name = toText(a?.name);
    if (!name) return;
    const type = toNumber(a?.activation?.activationType);
    const key: keyof CharacterActions = type === 1 ? "action" : type === 2 ? "bonusAction" : type === 3 ? "reaction" : "other";
    buckets[key].add(name);
  };
  // data.actions = un objet { race, class, background, item, feat, ... }
  const actions = (data.actions ?? null) as Record<string, unknown> | null;
  if (actions) {
    for (const list of Object.values(actions)) {
      for (const entry of looseArray(list)) push(entry);
    }
  }
  for (const entry of looseArray(data.customActions)) push(entry);
  const sorted = (set: Set<string>): string[] =>
    Array.from(set).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return {
    action: sorted(buckets.action),
    bonusAction: sorted(buckets.bonusAction),
    reaction: sorted(buckets.reaction),
    other: sorted(buckets.other),
  };
}

function mapSpells(data: Record<string, unknown>): Spell[] {
  const spells: Spell[] = [];
  const seen = new Set<string>();
  const pushSpell = (s: Record<string, unknown>) => {
    const def = (s.definition ?? {}) as Record<string, unknown>;
    const name = toText(def.name);
    if (!name) return;
    const level = toNumber(def.level);
    const key = `${name.toLowerCase()}/${level ?? "?"}`;
    if (seen.has(key)) return;
    seen.add(key);
    const activation = def.activation as { activationTime?: unknown; activationType?: unknown } | undefined;
    const activationType = ACTIVATION_TYPES[toNumber(activation?.activationType) ?? 0] ?? null;
    const time = toNumber(activation?.activationTime);
    const castingTime = activationType === "Action" && time === 1 ? "1 Action" : activationType;
    const rangeDef = def.range as { origin?: unknown; rangeValue?: unknown } | undefined;
    const origin = toText(rangeDef?.origin);
    const rangeValue = toNumber(rangeDef?.rangeValue);
    const range = formatSpellRange(origin, rangeValue);
    const duration = formatSpellDuration(def.duration);
    const damaging = spellIsDamaging(def);
    const prepared =
      typeof s.prepared === "boolean"
        ? s.prepared
        : toNumber(s.alwaysPrepared) !== null
          ? true
          : null;
    spells.push({ name, level, school: toText(def.school), castingTime, range, duration, damaging, prepared });
  };
  // Sorts de classe (préparés/connus du personnage, avec l'info "prepared")
  for (const classEntry of looseArray(data.classSpells)) {
    for (const spell of looseArray((classEntry as { spells?: unknown }).spells)) {
      pushSpell(spell as Record<string, unknown>);
    }
  }
  // Sorts issus des traits, dons, objets (Fire Bolt d'un Tiefling, don
  // Magic Initiate...) : regroupés par source dans data.spells.{race,feat,...}.
  for (const list of Object.values((data.spells ?? {}) as Record<string, unknown>)) {
    for (const spell of looseArray(list)) {
      pushSpell(spell as Record<string, unknown>);
    }
  }
  return spells;
}

const ACTIVATION_TYPES: Record<number, string> = {
  1: "Action",
  2: "Bonus Action",
  3: "Reaction",
  4: "1 Turn",
  5: "1 Minute",
  6: "10 Minutes",
  7: "1 Hour",
};

function mapInventory(data: Record<string, unknown>): Character["equipment"] {
  const inventory = looseArray(data.inventory);
  return inventory
    .map((entry): Character["equipment"][number] | null => {
      const e = entry as { definition?: Record<string, unknown>; quantity?: unknown };
      const def = e.definition ?? {};
      const name = toText(def.name);
      if (!name) return null;
      return {
        name,
        quantity: toNumber(e.quantity),
        weight: toNumber(def.weight),
      };
    })
    .filter((e): e is Character["equipment"][number] => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

function mapFeatures(
  data: Record<string, unknown>,
  rules: ExtractRules = EMPTY_RULES,
  sourcesById: Map<number, { name: string | null; description: string | null }> = new Map(),
): Feature[] {
  const feats = looseArray(data.feats);
  return feats
    .map((entry): Feature | null => {
      const def = ((entry as { definition?: unknown }).definition ?? {}) as Record<string, unknown>;
      const name = toText(def.name);
      if (!name) return null;
      // Contenu de campagne injecté non affiché par la feuille (rules.json).
      if (!featureAllowed(def, rules, sourcesById)) return null;
      return { name, section: "FEATS", description: stripHtml(def.shortDescription ?? def.description) };
    })
    .filter((f): f is Feature => f !== null);
}

/** DDB alignmentId ; ordre à confirmer au fil des exports. */
const ALIGNMENTS: Record<number, string> = {
  1: "Lawful Good",
  2: "Neutral Good",
  3: "Chaotic Good",
  4: "Lawful Neutral",
  5: "Neutral",
  6: "Chaotic Neutral",
  7: "Lawful Evil",
  8: "Neutral Evil",
  9: "Chaotic Evil",
};

/** Mapping creatureSizes de la réponse rule-data de character-service. */
const CREATURE_SIZES: Record<number, string> = {
  2: "Tiny",
  3: "Small",
  4: "Medium",
  5: "Large",
  6: "Huge",
  7: "Gargantuan",
  10: "Medium or Small",
};

/** Taille de créature : race.sizeId interprété via CREATURE_SIZES. */
export function mapSize(data: Record<string, unknown>): string | null {
  const race = (data.race ?? null) as Record<string, unknown> | null;
  const sizeId = toNumber(race?.sizeId);
  return sizeId !== null ? CREATURE_SIZES[sizeId] ?? null : null;
}

/** Personnalité : data.traits.{personalityTraits,ideals,bonds,flaws} sont
 *  des textes libres ; un éventuel multi-ligne devient une entrée par ligne. */
function mapPersonality(data: Record<string, unknown>): Character["personality"] {
  const traits = (data.traits ?? null) as Record<string, unknown> | null;
  if (!traits) return null;
  const splitLines = (key: string): string[] =>
    (toText(traits[key]) ?? "")
      .split(/\s*\n\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  const result = {
    traits: splitLines("personalityTraits"),
    ideals: splitLines("ideals"),
    bonds: splitLines("bonds"),
    flaws: splitLines("flaws"),
    appearance: splitLines("appearance"),
  };
  return (
    result.traits.length || result.ideals.length || result.bonds.length || result.flaws.length || result.appearance.length
  ) ? result : null;
}

export function mapApiToCharacter(
  data: Record<string, unknown>,
  characterId: string | null,
  sourceRef: string,
  extractedAt: string,
  rules: ExtractRules = EMPTY_RULES,
  sourcesById: Map<number, { name: string | null; description: string | null }> = new Map(),
): Character {
  const notes = (data.notes ?? {}) as Record<string, unknown>;
  const background = (data.background ?? {}) as Record<string, unknown>;
  const bgDefinition = (background.definition ?? null) as Record<string, unknown> | null;
  const bgCustom = (background.customBackground ?? null) as Record<string, unknown> | null;
  const bgName =
    toText(bgDefinition?.name) ?? toText(bgCustom?.name) ?? toText(bgCustom?.featuresBackground && (bgCustom.featuresBackground as Record<string, unknown>).name);

  const deathSavesRaw = (data.deathSaves ?? null) as Record<string, unknown> | null;
  const currencies = (data.currencies ?? null) as Record<string, unknown> | null;

  const race = (data.race ?? null) as Record<string, unknown> | null;
  const hpMax =
    toNumber(data.baseHitPoints) !== null
      ? (toNumber(data.baseHitPoints) ?? 0) + (toNumber(data.bonusHitPoints) ?? 0) - (toNumber(data.removedHitPoints) ?? 0)
      : null;

  const classes = mapClasses(data);
  const level = classes.reduce((sum, c) => sum + (c.level ?? 0), 0);
  // Port de charge : FOR × 15 lb (pousser/traîner/soulever = double) ;
  // DDB l'affiche dans le DOM des capacités, mais le JSON ne le contient pas.
  const strScore = abilityScoreValues(data).STR;

  return {
    meta: { source: "api", sourceRef, extractedAt, characterId, units: { distance: "ft.", weight: "lb." } },
    name: toText(data.name),
    level: level || null,
    xp: toNumber(data.currentXp),
    race: toText(race?.fullName),
    size: mapSize(data),
    background: bgName,
    alignment: toNumber(data.alignmentId) !== null ? ALIGNMENTS[toNumber(data.alignmentId) ?? 0] ?? null : null,
    classes,
    spellcasting: computeSpellcasting(data),
    abilities: {
      STR: { score: 0, modifier: 0 },
      DEX: { score: 0, modifier: 0 },
      CON: { score: 0, modifier: 0 },
      INT: { score: 0, modifier: 0 },
      WIS: { score: 0, modifier: 0 },
      CHA: { score: 0, modifier: 0 },
    },
    // Sauvegardes/compétences : calculées par la page, pas fiées ici.
    savingThrows: {
      STR: { value: 0, proficient: false },
      DEX: { value: 0, proficient: false },
      CON: { value: 0, proficient: false },
      INT: { value: 0, proficient: false },
      WIS: { value: 0, proficient: false },
      CHA: { value: 0, proficient: false },
    },
    skills: [],
    proficiencyBonus: null,
    armorClass: null,
    initiative: null,
    speed: null,
    passivePerception: null,
    carryingCapacity: strScore > 0 ? strScore * 15 : null,
    pushDragLift: strScore > 0 ? strScore * 30 : null,
   hp: { current: hpMax, max: hpMax, temp: toNumber(data.temporaryHitPoints) },
    hitDice: mapHitDice(data),
    deathSaves: deathSavesRaw
      ? { successes: toNumber(deathSavesRaw["successCount"]), failures: toNumber(deathSavesRaw["failCount"]) }
      : null,
    coins: currencies
      ? {
          cp: toNumber(currencies["cp"]),
          sp: toNumber(currencies["sp"]),
          ep: toNumber(currencies["ep"]),
          gp: toNumber(currencies["gp"]),
          pp: toNumber(currencies["pp"]),
        }
      : null,
    attacks: mapAttacks(data),
    actions: mapActions(data),
    defenses: mapDefenses(data),
    proficiencies: { ...mapProficienciesFromModifiers(data), languages: [] },
    features: mapFeatures(data, rules, sourcesById),
    equipment: mapInventory(data),
    spells: mapSpells(data),
    spellSlots: computeSpellSlots(data),
    personality: mapPersonality(data),
    appearance: {
      age: toText(data.age),
      eyes: toText(data.eyes),
      height: toText(data.height),
      hair: toText(data.hair),
      skin: toText(data.skin),
      weight: toText(data.weight),
    },
    backstory: stripHtml(notes.backstory),
    allies: stripHtml(notes.allies),
  };
}

/** Choisi la source : export API Tampermonkey > HTML. */
export function characterIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/character\/v5\/character\/(\d+)/);
  return match ? match[1] : null;
}

export type { AbilityKey };

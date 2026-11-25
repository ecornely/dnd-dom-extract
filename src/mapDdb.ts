import type {
  Ability,
  AbilityKey,
  Character,
  CharacterClass,
  Defense,
  EquipmentItem,
  Feature,
  ProficiencyType,
  Skill,
  Spell,
} from "./schema.js";
import { mapActions, mapAttacks, mapProficienciesFromModifiers, mapSize } from "./api.js";
import { ABILITY_KEYS, ABILITY_LABELS } from "./schema.js";
import { abilityFromId, computeSpellcasting, computeSpellSlots, firstPath, formatSpellDuration, looseArray, path, spellIsDamaging, toNumber, toText } from "./util.js";

/**
 * Mappe le JSON embarqué d'une page D&D Beyond vers le schéma Character.
 * La structure exacte du blob DDB variant selon la version de la fiche,
 * chaque champ est lu via plusieurs chemins candidats, de façon défensive :
 * une donnée absente reste `undefined`, jamais 0 par erreur.
 */

function mapAbilities(data: unknown): Record<AbilityKey, Ability> {
  const result = {} as Record<AbilityKey, Ability>;
  const list = firstPath<unknown[]>(data, ["data.abilities", "abilities", "data.abilityData.abilities"]);
  const byKey = {} as Record<string, { score: number; modifier: number }>;

  if (Array.isArray(list)) {
    for (const entry of list) {
      const id = toNumber(path(entry, "id") ?? path(entry, "abilityId"));
      const name = toText(path(entry, "name"));
      const key =
        (id !== null ? abilityFromId(id) : null) ??
        (name ? ABILITY_KEYS.find((k) => ABILITY_LABELS[k] === name || k === name.toUpperCase()) ?? null : null);
      if (key) {
        byKey[key] = {
          score: toNumber(path(entry, "score")) ?? 0,
          modifier: toNumber(path(entry, "modifier")) ?? 0,
        };
      }
    }
  }

  for (const key of ABILITY_KEYS) {
    result[key] = byKey[key] ?? { score: toNumber(path(data, `data.${key.toLowerCase()}`)) ?? 0, modifier: 0 };
  }
  return result;
}

function mapSavingThrows(data: unknown, abilities: Record<AbilityKey, Ability>): Record<AbilityKey, { value: number; proficient: boolean }> {
  const list = firstPath<unknown[]>(data, ["data.abilities", "abilities", "data.abilityData.abilities"]) ?? [];
  const byKey: Partial<Record<AbilityKey, { value: number; proficient: boolean }>> = {};
  if (Array.isArray(list)) {
    for (const entry of list) {
      const id = toNumber(path(entry, "id") ?? path(entry, "abilityId"));
      const key = id !== null ? abilityFromId(id) : null;
      if (!key) continue;
      const save = toNumber(path(entry, "save") ?? path(entry, "saveModifier"));
      const prof = path(entry, "proficient") ?? path(entry, "saveProficiency") ?? path(entry, "hasProficiency");
      if (save !== null) {
        byKey[key] = { value: save, proficient: prof === true || prof === 1 };
      }
    }
  }
  const result = {} as Record<AbilityKey, { value: number; proficient: boolean }>;
  for (const key of ABILITY_KEYS) {
    result[key] = byKey[key] ?? {
      value: abilities[key].modifier,
      proficient: false,
    };
  }
  return result;
}

function mapClasses(data: unknown): CharacterClass[] {
  const list = firstPath<unknown[]>(data, ["data.classes", "classes", "data.classData.classes"]);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry): CharacterClass | null => {
      const name = toText(path(entry, "definition.name") ?? path(entry, "name") ?? path(entry, "dndClass"));
      if (!name) return null;
      return {
        name,
        level: toNumber(path(entry, "level")),
        subclass: toText(path(entry, "subclassDefinition.name") ?? path(entry, "subclass")),
      };
    })
    .filter((c): c is CharacterClass => c !== null);
}

function proficiencyType(entry: unknown): ProficiencyType {
  const raw = path(entry, "proficiencyLevel") ?? path(entry, "proficiency") ?? path(entry, "proficient");
  switch (raw) {
    case 2:
    case "expertise":
    case "EXPERTISE":
      return "expertise";
    case 0.5:
    case "half":
    case "HALF":
      return "half";
    case true:
    case 1:
    case "proficient":
    case "PROFICIENT":
      return "proficient";
    default:
      return "none";
  }
}

function mapSkills(data: unknown): Skill[] {
  const list = firstPath<unknown[]>(data, ["data.skills", "skills", "data.skillData.skills"]);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry): Skill | null => {
      const name =
        toText(path(entry, "definition.name")) ??
        toText(path(entry, "name")) ??
        toText(path(entry, "label"));
      if (!name) return null;
      const abilityId = toNumber(path(entry, "definition.abilityId") ?? path(entry, "abilityId"));
      const abilityName = toText(path(entry, "definition.ability") ?? path(entry, "ability"));
      const ability: AbilityKey | null =
        abilityId !== null
          ? abilityFromId(abilityId)
          : abilityName
            ? (ABILITY_KEYS.find((k) => k === abilityName.toUpperCase()) ?? null)
            : null;
      const value = toNumber(path(entry, "value") ?? path(entry, "modifier"));
      return {
        name,
        ability,
        value,
        proficiency: proficiencyType(entry),
      };
    })
    .filter((s): s is Skill => s !== null);
}

function mapDefenses(data: unknown, kind: string): Defense[] {
  const list = firstPath<unknown[]>(data, [
    `data.customDefenses.${kind}`,
    `data.defenses.${kind}`,
    `${kind}`,
  ]);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry): Defense | null => {
      const value = toText(path(entry, "name") ?? path(entry, "value") ?? (typeof entry === "string" ? entry : null));
      if (!value) return null;
      return { type: toText(path(entry, "type")) ?? kind, value };
    })
    .filter((d): d is Defense => d !== null);
}

function stringList(data: unknown, exprs: string[], nameExprs: string[] = ["name", "definition.name"]): string[] {
  const list = firstPath<unknown[]>(data, exprs);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === "string") return entry;
      for (const expr of nameExprs) {
        const value = toText(path(entry, expr));
        if (value) return value;
      }
      return null;
    })
    .filter((v): v is string => v !== null);
}

function mapFeatures(data: unknown): Feature[] {
  // Accepte soit l'objet complet contenant les features, soit la liste déjà extraite.
  const list: unknown[] | undefined = Array.isArray(data)
    ? data
    : firstPath<unknown[]>(data, ["data.features", "features", "data.traits", "data.characterTraits"]);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry): Feature | null => {
      const name = toText(path(entry, "definition.name") ?? path(entry, "name") ?? path(entry, "title"));
      if (!name) return null;
      return {
        name,
        section: toText(path(entry, "displayOrder") !== undefined ? path(entry, "category") : null) ?? null,
        description: firstPath(entry, ["description", "definition.shortDescription", "definition.description"])
          ? String(firstPath(entry, ["description", "definition.shortDescription", "definition.description"])).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null
          : null,
      };
    })
    .filter((f): f is Feature => f !== null);
}

function mapEquipment(data: unknown): EquipmentItem[] {
  const list = firstPath<unknown[]>(data, ["data.inventory", "inventory", "data.equipment"]);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry): EquipmentItem | null => {
      const name = toText(path(entry, "definition.name") ?? path(entry, "name"));
      if (!name) return null;
      return {
        name,
        quantity: toNumber(path(entry, "quantity")),
        weight: toNumber(path(entry, "definition.weight")),
      };
    })
    .filter((e): e is EquipmentItem => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

function mapSpells(data: unknown): Spell[] {
  const levels = firstPath<unknown[]>(data, ["data.spellData.spells", "data.spells", "spells"]);
  const spells: Spell[] = [];
  if (Array.isArray(levels)) {
    for (const level of levels) {
      const levelNumber = toNumber(path(level, "level.knownLevel") ?? path(level, "level.known"));
      for (const spell of path<unknown[]>(level, "spells") ?? []) {
        const name = toText(path(spell, "definition.name") ?? path(spell, "name"));
        if (!name) continue;
        const defSpell = path(spell, "definition") ?? spell;
        spells.push({
          name,
          level: levelNumber ?? toNumber(path(spell, "level")),
          school: toText(path(spell, "definition.school") ?? path(spell, "school")),
          castingTime: toText(path(spell, "definition.time") ?? path(spell, "castingTime")),
          range: toText(path(spell, "definition.range") ?? path(spell, "range")),
          duration: formatSpellDuration(path(spell, "definition.duration") ?? path(spell, "duration")),
          damaging: spellIsDamaging(defSpell),
          prepared: typeof path(spell, "prepared") === "boolean" ? (path(spell, "prepared") as boolean) : null,
        });
      }
    }
  }
  return spells;
}

function listText(data: unknown, exprs: string[]): string[] {
  const list = firstPath<unknown[]>(data, exprs);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => toText(typeof entry === "string" ? entry : path(entry, "value") ?? path(entry, "text") ?? path(entry, "name")))
    .filter((v): v is string => v !== null);
}

function mapPersonality(data: unknown): Character["personality"] | null {
  const traits = listText(data, ["data.traits.traits", "data.personality.traits", "traits.traits"]);
  const ideals = listText(data, ["data.traits.ideals", "ideals.ideals"]);
  const bonds = listText(data, ["data.traits.bonds", "bonds.bonds"]);
  const flaws = listText(data, ["data.traits.flaws", "flaws.flaws"]);
  const appearance = listText(data, ["data.traits.appearance", "traits.appearance"]);
  if (!traits.length && !ideals.length && !bonds.length && !flaws.length && !appearance.length) return null;
  return { traits, ideals, bonds, flaws, appearance };
}

function mapAppearance(data: unknown): Character["appearance"] | null {
  const appearance: NonNullable<Character["appearance"]> = {
    age: toText(firstPath(data, ["data.appearance.age", "appearance.age"])),
    eyes: toText(firstPath(data, ["data.appearance.eyes", "appearance.eyes"])),
    height: toText(firstPath(data, ["data.appearance.height", "appearance.height"])),
    hair: toText(firstPath(data, ["data.appearance.hair", "appearance.hair"])),
    skin: toText(firstPath(data, ["data.appearance.skin", "appearance.skin"])),
    weight: toText(firstPath(data, ["data.appearance.weight", "appearance.weight"])),
  };
  if (Object.values(appearance).every((v) => v === null)) return null;
  return appearance;
}

export function mapEmbeddedToCharacter(
  data: unknown,
  characterId: string,
  sourceRef: string,
  extractedAt: string,
): Character {
  const abilities = mapAbilities(data);

  const hitDiceTotal = toNumber(firstPath(data, ["data.hitPointInfo.hitDiceTotal", "hitPointInfo.hitDiceTotal"]));
  const hitDiceCount = toNumber(firstPath(data, ["data.hitPointInfo.hitDiceCount", "hitPointInfo.hitDiceCount"]));
  // Captures partielles (Tampermonkey) sans hitPointInfo : DDB n'y stocke pas
  // "2d8" mais classes[].level × classes[].definition.hitDice par classe.
  const classes = firstPath<unknown[]>(data, ["data.classes", "classes"]) ?? [];
  const hitDiceFromClasses = classes
    .map((klass) => {
      const level = toNumber(path(klass, "level") ?? path(klass, "definition.level"));
      const die = toNumber(path(klass, "definition.hitDice") ?? path(klass, "hitDice"));
      return level !== null && die !== null && level > 0 ? `${level}d${die}` : null;
    })
    .filter((s): s is string => s !== null)
    .join(" + ");
  const hitDice =
    hitDiceCount !== null && toNumber(firstPath(data, ["data.hitPointInfo.hitDice", "hitPointInfo.hitDice"])) !== null
      ? `${hitDiceCount}d${toNumber(firstPath(data, ["data.hitPointInfo.hitDice", "hitPointInfo.hitDice"]))}`
      : hitDiceTotal !== null
        ? String(hitDiceTotal)
        : hitDiceFromClasses !== ""
          ? hitDiceFromClasses
          : null;

  // Maîtrises d'armes/outils depuis les modifiers (groupes + armes
  // individuelles), même extraction que la passerelle API.
  const modifierProficiencies = mapProficienciesFromModifiers(data as Record<string, unknown>);

  return {
    meta: {
      source: "embedded-json",
      sourceRef,
      extractedAt,
      characterId,
      units: { distance: "ft.", weight: "lb." },
    },
    name: firstPath<string>(data, ["name", "data.name"]) ?? null,
    level: toNumber(firstPath(data, ["data.level", "level", "data.levels"])),
    xp: toNumber(firstPath(data, ["data.xp", "xp"])),
    race: firstPath<string>(data, ["data.race.fullName", "data.race.name", "race.fullName"]) ?? null,
    size: mapSize(data as Record<string, unknown>),
    background: firstPath<string>(data, ["data.background.definition.name", "background.definition.name"]) ?? null,
    alignment: firstPath<string>(data, ["data.alignmentName", "data.alignment", "alignmentName"]) ?? null,
    classes: mapClasses(data),
    spellcasting: computeSpellcasting(data),
    abilities,
    savingThrows: mapSavingThrows(data, abilities),
    skills: mapSkills(data),
    proficiencyBonus: toNumber(firstPath(data, ["data.proficiencyBonus", "proficiencyBonus", "data.modifiers.proficiencyBonus"])),
    armorClass: toNumber(firstPath(data, ["data.armorClass", "armorClass", "data.defense.armorClass"])),
    initiative: toNumber(firstPath(data, ["data.initiative", "initiative"])),
    speed: firstPath(data, ["data.race.weightSpeeds.normal.walk", "data.speed", "speed"]) !== undefined
      ? String(firstPath(data, ["data.race.weightSpeeds.normal.walk", "data.speed", "speed"]))
      : null,
    passivePerception: toNumber(firstPath(data, ["data.passivePerception", "passivePerception"])),
    carryingCapacity: abilities.STR.score > 0 ? abilities.STR.score * 15 : null,
    pushDragLift: abilities.STR.score > 0 ? abilities.STR.score * 30 : null,
    hp: {
      current: toNumber(firstPath(data, ["data.hitPointInfo.current", "hitPointInfo.current", "data.currentHitPoints"])),
      max: toNumber(firstPath(data, ["data.hitPointInfo.maximum", "hitPointInfo.maximum", "data.maximumHitPoints"])),
      temp: toNumber(firstPath(data, ["data.hitPointInfo.temporary", "hitPointInfo.temporary", "data.temporaryHitPoints"])),
    },
    hitDice,
    deathSaves: (() => {
      const successes = firstPath<number>(data, ["data.deathSaveInfo.successCount", "deathSaveInfo.successCount"]);
      const failures = firstPath<number>(data, ["data.deathSaveInfo.failCount", "deathSaveInfo.failCount"]);
      if (successes === undefined && failures === undefined) return null;
      return {
        successes: toNumber(successes),
        failures: toNumber(failures),
      };
    })(),
    coins: (() => {
      const coins = firstPath(data, ["data.currencies", "currencies"]);
      if (coins === undefined) return null;
      return {
        cp: toNumber(path(coins, "cp")),
        sp: toNumber(path(coins, "sp")),
        ep: toNumber(path(coins, "ep")),
        gp: toNumber(path(coins, "gp")),
        pp: toNumber(path(coins, "pp")),
      };
    })(),
    // Le blob embarqué peut être imbriqué (characters["<id>"] → {data}) —
    // mapAttacks lit inventaire, stats, modifiers au niveau du personnage.
    attacks: mapAttacks((path(data, "data") ?? data) as Record<string, unknown>),
    actions: mapActions((path(data, "data") ?? data) as Record<string, unknown>),
    defenses: {
      resistances: mapDefenses(data, "resistances"),
      immunities: mapDefenses(data, "immunities"),
      vulnerabilities: mapDefenses(data, "vulnerabilities"),
    },
    proficiencies: {
      armor: stringList(data, ["data.customProficiencies", "proficiencies"], ["name"]),
      weapons: modifierProficiencies.weapons,
      tools: modifierProficiencies.tools,
      languages: stringList(data, ["data.race.languages", "languages"], ["name", "value"]),
    },
    features: mapFeatures(data),
    equipment: mapEquipment(data),
    spells: mapSpells(data),
    spellSlots: computeSpellSlots(path(data, "data") ?? data),
    personality: mapPersonality(data),
    appearance: mapAppearance(data),
    backstory: toText(firstPath(data, ["data.notes.backstory", "notes.backstory", "data.backstory"])),
    allies: toText(firstPath(data, ["data.notes.alliesAndOrganizations", "notes.alliesAndOrganizations"])),
  };
}

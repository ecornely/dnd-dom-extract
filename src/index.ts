import type { Character } from "./schema.js";
import { ABILITY_KEYS } from "./schema.js";
import {
  characterIdFromUrl,
  findCharacterApiResponse,
  mapApiToCharacter,
  parseApiExport,
  type ApiExport,
} from "./api.js";
import { findEmbeddedCharacters } from "./embedded.js";
import { extractFromDom } from "./dom.js";
import { mapEmbeddedToCharacter } from "./mapDdb.js";

export * from "./schema.js";
export * from "./embedded.js";
export * from "./tokens.js";
export * from "./dom.js";
export * from "./mapDdb.js";
export * from "./api.js";

/**
 * Extraction multi-sources, chacune pour ce qu'elle sait faire :
 * - API (export Tampermonkey JSON) : identité, apparence, notes, inventaire, sorts
 * - DOM (page enregistrée) : valeurs calculées (scores, saves, skills, CA, HP...)
 * - HTML page complète : JSON embarqué characters["<id>"]
 *
 * Les sources ne se contredisent pas : le champ rempli par une source n'est
 * jamais écrasé par une autre, sauf pour les valeurs calculées où le DOM prime.
 */
export function extractCharacterFromSources(sources: string[], refs: string[]): Character {
  if (sources.length === 0) throw new Error("Aucune source fournie.");
  if (sources.length !== refs.length) throw new Error("sources et refs doivent avoir la même longueur.");

  const extractedAt = new Date().toISOString();
  let character: Character | null = null;
  let domHtml: { html: string; ref: string } | null = null;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const ref = refs[i];
    const characterPart = parseSingleSource(source, ref, extractedAt);
    if (characterPart.type === "dom") {
      if (characterPart.html) domHtml = { html: characterPart.html, ref };
      continue;
    }
    character = mergeCharacters(character, characterPart.character);
  }

  if (domHtml) {
    const domCharacter = extractFromDom(domHtml.html, domHtml.ref, extractedAt);
    character = mergeCharacters(character, domCharacter);
  }

  if (!character) {
    throw new Error(
      `Aucun personnage détecté dans [${refs.join(", ")}] : ni export API ` +
        "(json avec responses), ni page D&D Beyond, ni fiche avec ancres connues.",
    );
  }
  return character;
}

type SingleSourceResult =
  | { type: "character"; character: Character }
  | { type: "dom"; html: string };

function parseSingleSource(source: string, ref: string, extractedAt: string): SingleSourceResult {
  const trimmed = source.trim();

  // Export API Tampermonkey : JSON avec responses[]
  if (trimmed.startsWith("{")) {
    const apiExport: ApiExport | null = parseApiExport(trimmed);
    if (apiExport) {
      const response = findCharacterApiResponse(apiExport);
      if (response) {
        const characterId = characterIdFromUrl(response.url);
        return {
          type: "character",
          character: mapApiToCharacter(response.data, characterId, ref, extractedAt),
        };
      }
    }
  }

  // Page HTML
  if (/<\s*(html|body|div|main|h1)/i.test(trimmed)) {
    // JSON embarqué (page complète) prioritaire sur le DOM visible
    const embedded = findEmbeddedCharacters(trimmed);
    if (embedded.length > 0) {
      const best = embedded.reduce((a, b) =>
        JSON.stringify(b.data).length > JSON.stringify(a.data).length ? b : a,
      );
      return {
        type: "character",
        character: mapEmbeddedToCharacter(best.data, best.characterId, ref, extractedAt),
      };
    }
    const hasAnchors = /Saving Throw|Passive Perception|Armor Class|Proficiency|dndbeyond/i.test(trimmed);
    if (!hasAnchors) {
      throw new Error(
        `Aucun personnage détecté dans "${ref}". Ce fichier ne semble pas être ` +
          "une page personnage D&D Beyond enregistrée.",
      );
    }
    return { type: "dom", html: trimmed };
  }

  throw new Error(`Source "${ref}" non reconnue : ni export API JSON, ni page HTML.`);
}

/**
 * Fusionne deux vues du même personnage. Priorité au champ déjà rempli,
 * sauf si la nouvelle valeur n'est pas nulle et l'ancienne vide. Un cas
 * spécial : les scores d'caractéristiques calculés (DOM) priment sur les 0.
 */
export function mergeCharacters(base: Character | null, incoming: Character): Character {
  if (!base) return incoming;

  // Le DOM est la source de vérité pour les valeurs calculées
  const baseIsDom = base.meta.source === "dom";
  const incomingIsDom = incoming.meta.source === "dom";

  const primary = baseIsDom || !incomingIsDom ? base : incoming;
  const secondary = primary === base ? incoming : base;

  for (const key of ABILITY_KEYS) {
    if (!primary.abilities[key].score && secondary.abilities[key].score) {
      primary.abilities[key] = secondary.abilities[key];
    }
  }
  if (!primary.savingThrows[ABILITY_KEYS[0]] || primary.savingThrows[ABILITY_KEYS[0]].value === 0) {
    const secondaryHasSaves = ABILITY_KEYS.some((k) => secondary.savingThrows[k].value !== 0);
    if (secondaryHasSaves) primary.savingThrows = secondary.savingThrows;
  }
  if (primary.skills.length === 0) primary.skills = secondary.skills;
  if (!primary.proficiencyBonus) primary.proficiencyBonus = secondary.proficiencyBonus;
  if (!primary.armorClass) primary.armorClass = secondary.armorClass;
  if (!primary.initiative) primary.initiative = secondary.initiative;
  if (!primary.speed) primary.speed = secondary.speed;
  if (!primary.passivePerception) primary.passivePerception = secondary.passivePerception;
  if (!primary.carryingCapacity) primary.carryingCapacity = secondary.carryingCapacity;
  if (!primary.pushDragLift) primary.pushDragLift = secondary.pushDragLift;
  if (!primary.hp.current && !primary.hp.max) primary.hp = secondary.hp;
  if (!primary.hitDice) primary.hitDice = secondary.hitDice;
  if (primary.deathSaves === null) primary.deathSaves = secondary.deathSaves;
  if (primary.coins === null) primary.coins = secondary.coins;
  if (primary.attacks.length === 0) primary.attacks = secondary.attacks;
  if (primary.defenses.resistances.length === 0) primary.defenses = secondary.defenses;
  if (Object.values(primary.proficiencies).every((v) => v.length === 0)) {
    primary.proficiencies = secondary.proficiencies;
  }
  if (primary.features.length === 0) primary.features = secondary.features;
  if (primary.equipment.length === 0) primary.equipment = secondary.equipment;
  if (primary.spells.length === 0) primary.spells = secondary.spells;
  if (primary.spellSlots.length === 0) primary.spellSlots = secondary.spellSlots;
  if (primary.personality === null) primary.personality = secondary.personality;
  if (primary.appearance === null || Object.values(primary.appearance).every((v) => v === null)) {
    primary.appearance = secondary.appearance ?? primary.appearance;
  }
  if (!primary.backstory) primary.backstory = secondary.backstory;
  if (!primary.allies) primary.allies = secondary.allies;

  primary.name ??= secondary.name;
  primary.level ??= secondary.level;
  primary.xp ??= secondary.xp;
  primary.race ??= secondary.race;
  primary.size ??= secondary.size;
  primary.background ??= secondary.background;
  primary.alignment ??= secondary.alignment;
  primary.classes = primary.classes.length ? primary.classes : secondary.classes;
  if (!primary.spellcasting?.length) primary.spellcasting = secondary.spellcasting;
  return primary;
}

/** Un seul fichier en entrée : passe par extractCharacterFromSources. */
export function extractCharacter(source: string, sourceRef: string): Character {
  return extractCharacterFromSources([source], [sourceRef]);
}

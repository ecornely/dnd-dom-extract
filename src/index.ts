import type { Character } from "./schema.js";
import { ABILITY_KEYS } from "./schema.js";
import {
  characterIdFromUrl,
  findCharacterApiResponse,
  mapApiToCharacter,
  parseApiExport,
  type ApiExport,
} from "./api.js";
import { extractFromDom, mapActionsFromDom } from "./dom.js";
import { EMPTY_RULES, sourcesFromDump, type ExtractRules } from "./rules.js";

export * from "./schema.js";
export * from "./tokens.js";
export * from "./dom.js";
export * from "./api.js";
export * from "./rules.js";

// Canaux historiques conservés comme bibliothèque (non câblés dans
// extractCharacter) : JSON embarqué des pages complètes Ctrl+S.
export * from "./embedded.js";
export * from "./mapDdb.js";

/**
 * Extraction depuis l'unique format d'export : le JSON du userscript
 * Tampermonkey v5 (Ctrl+Shift+C / Ctrl+Alt+C), composé de :
 * - responses[] : réponses interceptées de character-service.dndbeyond.com
 *   → données brutes (identité, apparence, notes, inventaire, sorts)
 * - domHtml : body.outerHTML de la fiche au moment de l'export
 *   → valeurs calculées (scores, saves, skills, CA, HP, vitesse...)
 *
 * Fusion sans écrasement : le champ rempli par une source n'est jamais
 * écrasé par l'autre, sauf pour les valeurs calculées où le DOM prime.
 */
/**
 * Options d'extraction : `rules` passe des règles de filtrage (rules.json)
 * pour écarter le contenu de campagne non affiché par la feuille.
 */
export interface ExtractOptions {
  rules?: ExtractRules;
}

export function extractCharacter(source: string, sourceRef: string, options: ExtractOptions = {}): Character {
  const extractedAt = new Date().toISOString();
  const dump: ApiExport = parseApiExport(source, sourceRef);
  const rules = options.rules ?? EMPTY_RULES;

  let character: Character | null = null;
  const response = findCharacterApiResponse(dump);
  if (response) {
    character = mapApiToCharacter(response.data, characterIdFromUrl(response.url), sourceRef, extractedAt, rules, sourcesFromDump(dump));
  }

  if (dump.domHtml) {
    const domCharacter = extractFromDom(dump.domHtml, sourceRef, extractedAt);
    character = mergeCharacters(character, domCharacter);
    // Les actions viennent du tab Actions de la feuille (groupage et
    // entitlement justes), jamais du JSON classique (activationType décalé et
    // contenu de livres non possédés) — le mapping JSON reste un repli.
    const domActions = mapActionsFromDom(dump.domHtml);
    if (Object.values(domActions).some((v) => v.length > 0)) {
      character.actions = domActions;
    }
  }

  if (!character) {
    throw new Error(
      `Aucun personnage détecté dans "${sourceRef}" : le dump ne contient ni réponse ` +
        "character-service exploitable (responses[]), ni fiche D&D Beyond dans domHtml.",
    );
  }
  return character;
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
  if (Object.values(primary.actions).every((v) => v.length === 0)) primary.actions = secondary.actions;
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
